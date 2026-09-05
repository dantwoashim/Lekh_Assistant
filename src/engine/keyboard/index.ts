import engineContract from "../../../data/engine/lekh-engine-contract.v1.json";
import { CandidateCache } from "./cache";
import { buildCandidateUpdate } from "./candidates";
import { applyKeyToComposition } from "./composition";
import { commitCandidateResult, commitRawResult, emptyCommitResult } from "./commit";
import { nextWordCandidates } from "./followups";
import { getKeyboardProofHints } from "./proofHints";
import { lookupKeyboardDictionary } from "./dictionary";
import {
  applyKeyboardMemorySelection,
  buildKeyboardMemorySelection,
  importKeyboardMemoryEntry
} from "./memory";
import { defaultTypingContext, isLearningAllowedContext, isSecureContext, surfaceForMode } from "./modes";
import { KeyboardSessionManager } from "./session";
import {
  MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES,
  installBoundedCorrectionMemoryEntry
} from "./storage";
import { getKeyboardSuggestions } from "./suggest";
import { warmKeyboard } from "./warm";
import type {
  Candidate,
  CandidateUpdate,
  CommitCandidateOptions,
  CommitResult,
  KeyboardEngine,
  KeyboardKeyEvent,
  KeyboardMode,
  PreparedCorrectionLearning,
  SessionId,
  TypingContext,
  WarmOptions,
  WarmResult
} from "./types";
import type { CorrectionMemoryEntry } from "../memory";
import { normalizeCorrectionMemoryImportEntries } from "../memory/importNormalization";
import { nowMs } from "../util/time";
import { isWellFormedUtf16 } from "../util/utf16";

interface RefreshCacheEntry {
  key: string;
  update: CandidateUpdate;
}

interface PendingLearningSelection {
  commitEpoch: number;
  entry: CorrectionMemoryEntry;
  prepared?: PreparedCorrectionLearning;
}

const MAXIMUM_COMPOSITION_UTF16 = engineContract.hotPathPolicy.maximumCompositionUtf16CodeUnits;
class LocalKeyboardEngine implements KeyboardEngine {
  private readonly sessions = new KeyboardSessionManager(
    undefined,
    undefined,
    (sessionIds) => {
      for (const sessionId of sessionIds) this.purgeSessionState(sessionId);
    }
  );
  private readonly cache = new CandidateCache();
  private readonly refreshCache = new Map<SessionId, RefreshCacheEntry>();
  private readonly pendingLearning = new Map<SessionId, PendingLearningSelection>();
  private memoryEntries: CorrectionMemoryEntry[] = [];
  private memoryVersion = 0;
  beginSession(context: TypingContext): SessionId {
    const sessionId = this.sessions.beginSession(context);
    this.prunePendingLearning();
    return sessionId;
  }

  updateComposition(sessionId: SessionId, input: string, cursor: number): CandidateUpdate {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return unknownSessionUpdate(sessionId, input, cursor);
    const session = this.sessions.get(sessionId);
    if (!isWellFormedUtf16(input) || input.length > MAXIMUM_COMPOSITION_UTF16) {
      return failOpenCandidateUpdate(
        session,
        "errorFallback",
        "Composition was malformed or exceeded the canonical UTF-16 limit; preserving the previous bounded state."
      );
    }
    this.sessions.updateComposition(sessionId, input, cursor);
    return this.refresh(sessionId);
  }

  processKeyStroke(sessionId: SessionId, key: KeyboardKeyEvent): CandidateUpdate {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return unknownSessionUpdate(sessionId, "", 0);
    const session = this.sessions.get(sessionId);
    if (session.compositionText.length > MAXIMUM_COMPOSITION_UTF16) {
      return failOpenCandidateUpdate(
        session,
        "errorFallback",
        "Composition state exceeded the canonical UTF-16 limit; preserving host input."
      );
    }
    if (isSecureContext(session.context)) {
      return withAction(this.refresh(sessionId), "passThrough", "Secure/uncertain field: native key passed through without composition.");
    }
    if (isInlineAcceptanceKey(key) && session.compositionText.length > 0) {
      const update = this.refresh(sessionId);
      const completion = update.inlineCompletion;
      if (completion?.acceptKeys.includes(key.key as "Tab" | "ArrowRight")) {
        const candidate = update.candidates.find((item) => item.text === completion.text);
        if (candidate) {
          const commitResult = this.commitCandidate(sessionId, candidate.id, { learning: "disabled" });
          return withCommit(this.refresh(sessionId), commitResult, commitResult.committedText);
        }
      }
      return withAction(update, "passThrough");
    }
    if (isCandidateShortcutKey(key) && session.compositionText.length > 0) {
      const update = this.refresh(sessionId);
      const candidate = update.candidates.find((item) => item.shortcut === key.key);
      if (candidate) {
        // processKeyStroke returns CandidateUpdate, which deliberately carries
        // no commit receipt. Until this path has an acknowledgement-capable
        // protocol, learning here would treat an attempted host edit as proof
        // that the edit succeeded. Keep shortcut commits explicitly unlearned.
        const commitResult = this.commitCandidate(sessionId, candidate.id, { learning: "disabled" });
        return withCommit(this.refresh(sessionId), commitResult, commitResult.committedText);
      }
      return withAction(update, "compose", `Candidate shortcut ${key.key} had no matching candidate.`);
    }
    const mutation = applyKeyToComposition(session.compositionText, session.caret, key);
    if (mutation.command === "pass-through") {
      return withAction(this.refresh(sessionId), "passThrough", mutation.warning);
    }
    if (mutation.command === "cancel") {
      this.cancelComposition(sessionId);
      return withAction(this.refresh(sessionId), "cancel");
    }
    if (mutation.command === "commit-raw") {
      const suffix = key.key === " " ? " " : key.key === "Enter" ? "\n" : "";
      const commitResult = this.commitRaw(sessionId);
      if (commitResult.action !== "commit") {
        return withAction(this.refresh(sessionId), commitResult.action);
      }
      return withCommit(
        this.refresh(sessionId),
        commitResult,
        `${commitResult.committedText}${suffix}`
      );
    }
    if (mutation.text.length > MAXIMUM_COMPOSITION_UTF16) {
      return failOpenCandidateUpdate(
        session,
        "passThrough",
        "Composition reached the canonical UTF-16 limit; passing the key through without growing native state."
      );
    }
    this.sessions.updateComposition(sessionId, mutation.text, mutation.caret);
    const update = this.refresh(sessionId);
    if (mutation.warning) {
      return withAction(update, "compose", mutation.warning);
    }
    return update;
  }

  commitCandidate(
    sessionId: SessionId,
    candidateId: string,
    options: CommitCandidateOptions = {}
  ): CommitResult {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return emptyCommitResult(sessionId);
    const session = this.sessions.get(sessionId);
    if (session.compositionText.length > MAXIMUM_COMPOSITION_UTF16) return emptyCommitResult(sessionId);
    const candidate = this.cache.find(sessionId, candidateId) ?? session.candidates.find((item) => item.id === candidateId);
    if (!candidate) return emptyCommitResult(sessionId);
    if (candidate.type === "romanized-helper") {
      if (candidate.text.length > MAXIMUM_COMPOSITION_UTF16) return emptyCommitResult(sessionId);
      this.sessions.updateComposition(sessionId, candidate.text, candidate.text.length);
      this.cache.set(sessionId, this.refresh(sessionId).candidates);
      return {
        sessionId,
        action: "compose",
        committedText: "",
        commitEpoch: 0,
        consumedRange: candidate.replaceRange ?? [0, session.compositionText.length],
        followupCandidates: [],
        memoryRecorded: false,
        schemaVersion: 1
      };
    }
    const result = commitCandidateResult(session, candidate);
    const selection = result.memoryRecorded
      ? buildKeyboardMemorySelection(session, candidate)
      : undefined;
    result.memoryRecorded = false;
    result.followupCandidates = nextWordCandidates(result.committedText, session);
    result.commitEpoch = this.sessions.recordCommit(sessionId, result.committedText);
    if (selection && options.learning !== "disabled") {
      if (options.learning === "deferred") {
        this.pendingLearning.set(sessionId, { commitEpoch: result.commitEpoch, entry: selection });
      } else {
        result.memoryRecorded = this.applyMemorySelection(selection);
      }
    }
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
    return result;
  }

  commitRaw(sessionId: SessionId): CommitResult {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return emptyCommitResult(sessionId);
    const session = this.sessions.get(sessionId);
    if (session.compositionText.length > MAXIMUM_COMPOSITION_UTF16) return emptyCommitResult(sessionId);
    if (!session.compositionText) return emptyCommitResult(sessionId);
    const result = commitRawResult(session);
    result.followupCandidates = nextWordCandidates(result.committedText, session);
    result.commitEpoch = this.sessions.recordCommit(sessionId, result.committedText);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
    return result;
  }

  cancelComposition(sessionId: SessionId): void {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return;
    this.sessions.cancelComposition(sessionId);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  endSession(sessionId: SessionId): void {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return;
    this.sessions.endSession(sessionId);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  getSuggestions(context: TypingContext): Candidate[] {
    return getKeyboardSuggestions(context);
  }

  getProofHints(textWindow: string, context?: TypingContext) {
    return getKeyboardProofHints(textWindow, context);
  }

  lookupDictionary(query: string, context?: TypingContext) {
    return lookupKeyboardDictionary(query, context);
  }

  learnCorrection(entry: unknown): void {
    const nextEntries = importKeyboardMemoryEntry(this.memoryEntries, entry);
    if (nextEntries !== this.memoryEntries) {
      this.memoryEntries = nextEntries;
      this.memoryVersion += 1;
      this.refreshCache.clear();
    }
  }

  preloadCorrectionMemory(entries: readonly unknown[]): number {
    if (this.sessions.snapshot().length > 0) {
      throw new Error("Correction memory can only be preloaded before keyboard sessions begin.");
    }
    if (entries.length > MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES) {
      throw new Error(
        `Correction-memory preload cannot exceed ${MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES} entries.`
      );
    }
    const normalized = normalizeCorrectionMemoryImportEntries(Array.from(entries), {
      requireTimestamps: true,
      requireKnownSource: true,
      scoringPolicy: "strict",
      minimumFrequency: 0
    });
    this.memoryEntries = normalized.map(cloneMemoryEntry);
    this.memoryVersion += 1;
    this.refreshCache.clear();
    return this.memoryEntries.length;
  }

  prepareCommittedCorrectionLearning(
    sessionId: SessionId,
    commitEpoch: number
  ): PreparedCorrectionLearning | undefined {
    const pending = this.pendingLearning.get(sessionId);
    if (!pending || pending.commitEpoch !== commitEpoch) return undefined;
    if (!this.sessions.has(sessionId)) return undefined;
    const session = this.sessions.get(sessionId);
    if (session.commitEpoch !== commitEpoch || !isLearningAllowedContext(session.context)) return undefined;
    session.lastUpdateTime = nowMs();
    if (pending.prepared) return pending.prepared;

    const nextEntries = applyKeyboardMemorySelection(this.memoryEntries, pending.entry);
    const durableEntry = nextEntries.find((entry) => entry.id === pending.entry.id);
    if (!durableEntry) return undefined;
    const prepared = freezePreparedCorrectionLearning({
      sessionId,
      commitEpoch,
      entry: cloneMemoryEntry(durableEntry)
    });
    pending.prepared = prepared;
    return prepared;
  }

  commitPreparedCorrectionLearning(prepared: PreparedCorrectionLearning): boolean {
    const pending = this.pendingLearning.get(prepared.sessionId);
    if (!pending || pending.prepared !== prepared || pending.commitEpoch !== prepared.commitEpoch) return false;
    this.pendingLearning.delete(prepared.sessionId);
    return this.installPersistedMemoryEntry(prepared.entry);
  }

  learnCommittedCorrection(sessionId: SessionId, commitEpoch: number): boolean {
    const prepared = this.prepareCommittedCorrectionLearning(sessionId, commitEpoch);
    return prepared ? this.commitPreparedCorrectionLearning(prepared) : false;
  }

  setContext(sessionId: SessionId, patch: Partial<TypingContext>): void {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return;
    this.sessions.updateContext(sessionId, patch);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  setMode(sessionId: SessionId, mode: KeyboardMode): void {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return;
    this.sessions.setMode(sessionId, mode);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  setLayout(sessionId: SessionId, layoutId: string): void {
    this.pendingLearning.delete(sessionId);
    if (!this.sessions.has(sessionId)) return;
    this.sessions.setLayout(sessionId, layoutId);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  warm(options?: WarmOptions): Promise<WarmResult> {
    return this.warmAllPipelines(options);
  }

  async shutdown(): Promise<void> {
    this.sessions.shutdown();
    this.cache.clearAll();
    this.refreshCache.clear();
    this.pendingLearning.clear();
    this.memoryEntries = [];
    this.memoryVersion = 0;
  }

  private async warmAllPipelines(options: WarmOptions = {}): Promise<WarmResult> {
    const base = await warmKeyboard(options);
    const startedAt = nowMs();
    const modules = ["candidate-pipeline", "proofread-index", "dictionary-index"];
    let warmSession: SessionId | undefined;
    try {
      warmSession = this.beginSession(defaultTypingContext("romanized"));
      this.updateComposition(warmSession, "ramro", 5);
      this.getSuggestions({ ...defaultTypingContext("romanized"), leftTextWindow: "swas" });
      this.getProofHints("सवस्थ्य", defaultTypingContext("unicode-proofread"));
      this.lookupDictionary("swasthya", defaultTypingContext("dictionary-lookup"));
    } catch {
      return {
        ready: false,
        partial: true,
        loadedModules: base.loadedModules,
        unavailableModules: Array.from(new Set([...base.unavailableModules, ...modules])),
        warmTimeMs: base.warmTimeMs + (nowMs() - startedAt),
        warnings: [...base.warnings, "One or more local keyboard pipelines could not be warmed."]
      };
    } finally {
      if (warmSession) this.endSession(warmSession);
    }

    const elapsed = base.warmTimeMs + (nowMs() - startedAt);
    const exceededRequestedBudget = typeof options.timeoutMs === "number" && elapsed > options.timeoutMs;
    return {
      ready: base.unavailableModules.length === 0,
      partial: base.unavailableModules.length > 0,
      loadedModules: Array.from(new Set([...base.loadedModules, ...modules])),
      unavailableModules: base.unavailableModules,
      warmTimeMs: elapsed,
      warnings: [
        ...base.warnings,
        ...(exceededRequestedBudget
          ? [`Warm-up completed after the requested ${options.timeoutMs}ms advisory budget.`]
          : [])
      ]
    };
  }

  private refresh(sessionId: SessionId): CandidateUpdate {
    const session = this.sessions.get(sessionId);
    if (session.compositionText.length > MAXIMUM_COMPOSITION_UTF16) {
      return failOpenCandidateUpdate(
        session,
        "errorFallback",
        "Composition state exceeded the canonical UTF-16 limit; preserving host input."
      );
    }
    const cacheKey = this.refreshCacheKey(session);
    const cached = this.refreshCache.get(sessionId);
    if (cached?.key === cacheKey) return cloneCandidateUpdate(cached.update);

    // CandidateUpdate ranges are composition-relative. Surrounding-context
    // proofing uses the explicit proofHints.get text-window request instead.
    const proofHints = getKeyboardProofHints(session.compositionText, session.context);
    this.sessions.updateProofHints(sessionId, proofHints);
    const update = buildCandidateUpdate(this.sessions.get(sessionId), { memoryEntries: this.memoryEntries });
    this.sessions.updateCandidates(sessionId, update.candidates, update.warnings);
    this.cache.set(sessionId, update.candidates);
    this.refreshCache.set(sessionId, { key: cacheKey, update: cloneCandidateUpdate(update) });
    return update;
  }

  private refreshCacheKey(session: ReturnType<KeyboardSessionManager["get"]>): string {
    const context = session.context;
    return JSON.stringify({
      memoryVersion: this.memoryVersion,
      mode: session.mode,
      layoutId: session.layoutId ?? "",
      compositionText: session.compositionText,
      caret: session.caret,
      leftTextWindow: context.leftTextWindow,
      rightTextWindow: context.rightTextWindow ?? "",
      appId: context.appId ?? "",
      appName: context.appName ?? "",
      fieldType: context.fieldType ?? "",
      locale: context.locale ?? "",
      preserveEnglish: context.preserveEnglish,
      secureInput: context.secureInput,
      activeDomains: context.activeDomains,
      enabledSurfaces: context.enabledSurfaces,
      showRomanizedLabels: context.showRomanizedLabels ?? false,
      enablePersonalization: context.enablePersonalization ?? true,
      enableNextWordPrediction: context.enableNextWordPrediction ?? false,
      warnings: session.warnings
    });
  }

  private applyMemorySelection(selection: CorrectionMemoryEntry): boolean {
    const nextEntries = applyKeyboardMemorySelection(this.memoryEntries, selection);
    if (nextEntries === this.memoryEntries) return false;
    this.memoryEntries = nextEntries;
    this.memoryVersion += 1;
    this.refreshCache.clear();
    return true;
  }

  private installPersistedMemoryEntry(entry: CorrectionMemoryEntry): boolean {
    const installed = cloneMemoryEntry(entry);
    const next = installBoundedCorrectionMemoryEntry(this.memoryEntries, installed);
    if (!next) return false;
    this.memoryEntries = next;
    this.memoryVersion += 1;
    this.refreshCache.clear();
    return true;
  }

  private prunePendingLearning(): void {
    const liveSessionIds = new Set(this.sessions.snapshot().map((session) => session.sessionId));
    for (const sessionId of this.pendingLearning.keys()) {
      if (!liveSessionIds.has(sessionId)) this.pendingLearning.delete(sessionId);
    }
  }

  private purgeSessionState(sessionId: SessionId): void {
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
    this.pendingLearning.delete(sessionId);
  }
}

function isCandidateShortcutKey(key: KeyboardKeyEvent): boolean {
  if (key.modifiers?.ctrl || key.modifiers?.alt || key.modifiers?.meta) return false;
  return /^[1-9]$/.test(typeof key.key === "string" ? key.key : "");
}

function isInlineAcceptanceKey(key: KeyboardKeyEvent): boolean {
  if (key.modifiers?.ctrl || key.modifiers?.alt || key.modifiers?.meta || key.modifiers?.shift) return false;
  return key.key === "Tab" || key.key === "ArrowRight";
}

function unknownSessionUpdate(sessionId: SessionId, input: string, cursor: number): CandidateUpdate {
  const boundedInput = input.length <= MAXIMUM_COMPOSITION_UTF16 && isWellFormedUtf16(input) ? input : "";
  return {
    sessionId,
    mode: "diagnostic",
    surface: "romanized-to-unicode",
    action: "errorFallback",
    compositionText: boundedInput,
    displayText: boundedInput,
    caret: Math.max(0, Math.min(boundedInput.length, Math.trunc(cursor))),
    candidates: [],
    proofHints: [],
    shouldShowCandidateUI: false,
    confidence: 0,
    warnings: [`Unknown keyboard session: ${sessionId}; preserving input.`],
    latencyMs: 0,
    schemaVersion: 1
  };
}

function failOpenCandidateUpdate(
  session: ReturnType<KeyboardSessionManager["get"]>,
  action: "passThrough" | "errorFallback",
  warning: string
): CandidateUpdate {
  const compositionText = session.compositionText.length <= MAXIMUM_COMPOSITION_UTF16
    ? session.compositionText
    : "";
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    surface: surfaceForMode(session.mode),
    action,
    compositionText,
    displayText: compositionText,
    caret: Math.max(0, Math.min(compositionText.length, session.caret)),
    candidates: [],
    proofHints: [],
    shouldShowCandidateUI: false,
    confidence: 0,
    warnings: Array.from(new Set([...session.warnings, warning])),
    latencyMs: 0,
    schemaVersion: 1
  };
}

function withAction(update: CandidateUpdate, action: CandidateUpdate["action"], warning?: string): CandidateUpdate {
  return {
    ...update,
    action,
    warnings: warning ? Array.from(new Set([...update.warnings, warning])) : update.warnings
  };
}

function withCommit(update: CandidateUpdate, result: CommitResult, committedText: string): CandidateUpdate {
  const terminalUpdate: CandidateUpdate = {
    ...update,
    action: result.action === "commit" ? "commit" : result.action,
    shouldShowCandidateUI: false,
    ...(result.action === "commit" ? { committedText } : {}),
    ...(result.action === "commit" && result.consumedRange
      ? { consumedRange: result.consumedRange }
      : {})
  };
  if (result.action !== "commit") {
    delete terminalUpdate.committedText;
    delete terminalUpdate.consumedRange;
  }
  return terminalUpdate;
}

export function createKeyboardEngine(): KeyboardEngine {
  return new LocalKeyboardEngine();
}

function cloneCandidateUpdate(update: CandidateUpdate): CandidateUpdate {
  const clone: CandidateUpdate = {
    ...update,
    candidates: update.candidates.map((candidate) => ({ ...candidate, reason: candidate.reason.slice() })),
    ...(update.primary ? { primary: { ...update.primary, reason: update.primary.reason.slice() } } : {}),
    ...(update.inlineCompletion
      ? { inlineCompletion: {
        ...update.inlineCompletion,
        candidate: {
          ...update.inlineCompletion.candidate,
          reason: update.inlineCompletion.candidate.reason.slice()
        }
      } }
      : {}),
    proofHints: update.proofHints.map((hint) => ({ ...hint, range: [hint.range[0], hint.range[1]] })),
    warnings: update.warnings.slice(),
    ...(update.consumedRange
      ? { consumedRange: [update.consumedRange[0], update.consumedRange[1]] as [number, number] }
      : {})
  };
  if (clone.primary === undefined) delete clone.primary;
  if (clone.inlineCompletion === undefined) delete clone.inlineCompletion;
  if (clone.committedText === undefined) delete clone.committedText;
  if (clone.consumedRange === undefined) delete clone.consumedRange;
  if (clone.latencyMs === undefined) delete clone.latencyMs;
  return clone;
}

function cloneMemoryEntry(entry: CorrectionMemoryEntry): CorrectionMemoryEntry {
  return {
    ...entry,
    rejectedAlternatives: entry.rejectedAlternatives.slice(),
    context: { ...entry.context, leftWindow: "", rightWindow: "" },
    timestamps: { ...entry.timestamps }
  };
}

function freezePreparedCorrectionLearning(
  prepared: PreparedCorrectionLearning
): PreparedCorrectionLearning {
  Object.freeze(prepared.entry.rejectedAlternatives);
  Object.freeze(prepared.entry.context);
  Object.freeze(prepared.entry.timestamps);
  Object.freeze(prepared.entry);
  return Object.freeze(prepared);
}

export * from "./types";
export * from "./modes";
export * from "./ranges";
export * from "./warm";
export * from "./storage";
