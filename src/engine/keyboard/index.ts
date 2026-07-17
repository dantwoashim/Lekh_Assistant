import { CandidateCache } from "./cache";
import { buildCandidateUpdate } from "./candidates";
import { applyKeyToComposition } from "./composition";
import { commitCandidateResult, commitRawResult, emptyCommitResult } from "./commit";
import { nextWordCandidates } from "./followups";
import { getKeyboardProofHints } from "./proofHints";
import { lookupKeyboardDictionary } from "./dictionary";
import { importKeyboardMemoryEntry, recordKeyboardMemorySelection } from "./memory";
import { isSecureContext } from "./modes";
import { KeyboardSessionManager } from "./session";
import { getKeyboardSuggestions } from "./suggest";
import { warmKeyboard } from "./warm";
import type {
  Candidate,
  CandidateUpdate,
  CommitResult,
  KeyboardEngine,
  KeyboardKeyEvent,
  KeyboardMode,
  SessionId,
  TypingContext,
  WarmOptions,
  WarmResult
} from "./types";
import type { CorrectionMemoryEntry } from "../memory";

interface RefreshCacheEntry {
  key: string;
  update: CandidateUpdate;
}

export class LocalKeyboardEngine implements KeyboardEngine {
  private readonly sessions = new KeyboardSessionManager();
  private readonly cache = new CandidateCache();
  private readonly refreshCache = new Map<SessionId, RefreshCacheEntry>();
  private memoryEntries: CorrectionMemoryEntry[] = [];
  private memoryVersion = 0;

  beginSession(context: TypingContext): SessionId {
    return this.sessions.beginSession(context);
  }

  updateComposition(sessionId: SessionId, input: string, cursor: number): CandidateUpdate {
    if (!this.sessions.has(sessionId)) return unknownSessionUpdate(sessionId, input, cursor);
    this.sessions.updateComposition(sessionId, input, cursor);
    return this.refresh(sessionId);
  }

  processKeyStroke(sessionId: SessionId, key: KeyboardKeyEvent): CandidateUpdate {
    if (!this.sessions.has(sessionId)) return unknownSessionUpdate(sessionId, "", 0);
    const session = this.sessions.get(sessionId);
    if (isSecureContext(session.context)) {
      return withAction(this.refresh(sessionId), "passThrough", "Secure/uncertain field: native key passed through without composition.");
    }
    if (isCandidateShortcutKey(key) && session.compositionText.length > 0) {
      const update = this.refresh(sessionId);
      const candidate = update.candidates.find((item) => item.shortcut === key.key);
      if (candidate) {
        const commitResult = this.commitCandidate(sessionId, candidate.id);
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
    if (mutation.command === "commit-primary") {
      const update = this.refresh(sessionId);
      let commitResult: CommitResult;
      if (update.primary && update.primary.confidence >= 0.86) {
        commitResult = this.commitCandidate(sessionId, update.primary.id);
      } else if (key.key === "Enter") {
        commitResult = this.commitRaw(sessionId);
      } else {
        commitResult = this.commitRaw(sessionId);
      }
      const committedText = key.key === " " && commitResult.committedText
        ? `${commitResult.committedText} `
        : commitResult.committedText;
      return withCommit(this.refresh(sessionId), commitResult, committedText);
    }
    if (mutation.command === "commit-raw") {
      const commitResult = this.commitRaw(sessionId);
      const suffix = key.key === " " ? " " : key.key === "Enter" ? "\n" : "";
      return withCommit(
        this.refresh(sessionId),
        commitResult,
        commitResult.committedText ? `${commitResult.committedText}${suffix}` : suffix
      );
    }
    this.sessions.updateComposition(sessionId, mutation.text, mutation.caret);
    const update = this.refresh(sessionId);
    if (mutation.warning) {
      return withAction(update, "compose", mutation.warning);
    }
    if (mutation.command === "expand-candidates") {
      return { ...update, action: "compose", shouldShowCandidateUI: true };
    }
    return update;
  }

  commitCandidate(sessionId: SessionId, candidateId: string): CommitResult {
    if (!this.sessions.has(sessionId)) return emptyCommitResult(sessionId);
    const session = this.sessions.get(sessionId);
    const candidate = this.cache.find(sessionId, candidateId) ?? session.candidates.find((item) => item.id === candidateId);
    if (!candidate) return emptyCommitResult(sessionId);
    if (candidate.type === "romanized-helper") {
      this.sessions.updateComposition(sessionId, candidate.text, candidate.text.length);
      this.cache.set(sessionId, this.refresh(sessionId).candidates);
      return {
        sessionId,
        action: "compose",
        committedText: "",
        commitEpoch: session.commitEpoch,
        consumedRange: candidate.replaceRange ?? [0, session.compositionText.length],
        followupCandidates: [],
        memoryRecorded: false,
        schemaVersion: 1
      };
    }
    const result = commitCandidateResult(session, candidate);
    if (result.memoryRecorded) {
      const nextEntries = recordKeyboardMemorySelection(this.memoryEntries, session, candidate);
      result.memoryRecorded = nextEntries !== this.memoryEntries;
      if (result.memoryRecorded) {
        this.memoryEntries = nextEntries;
        this.memoryVersion += 1;
      }
    }
    result.followupCandidates = nextWordCandidates(result.committedText, session);
    result.commitEpoch = this.sessions.recordCommit(
      sessionId,
      result.committedText,
      result.memoryRecorded && candidate.type !== "protected"
    );
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
    return result;
  }

  commitRaw(sessionId: SessionId): CommitResult {
    if (!this.sessions.has(sessionId)) return emptyCommitResult(sessionId);
    const session = this.sessions.get(sessionId);
    const result = commitRawResult(session);
    result.followupCandidates = nextWordCandidates(result.committedText, session);
    result.commitEpoch = this.sessions.recordCommit(sessionId, result.committedText);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
    return result;
  }

  cancelComposition(sessionId: SessionId): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.cancelComposition(sessionId);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  endSession(sessionId: SessionId): void {
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
    this.memoryEntries = importKeyboardMemoryEntry(this.memoryEntries, entry);
    this.memoryVersion += 1;
    this.refreshCache.clear();
  }

  learnCommittedCorrection(sessionId: SessionId, commitEpoch: number): boolean {
    return this.sessions.consumeCorrectionLearningGrant(sessionId, commitEpoch) !== undefined;
  }

  setContext(sessionId: SessionId, patch: Partial<TypingContext>): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.updateContext(sessionId, patch);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  setMode(sessionId: SessionId, mode: KeyboardMode): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.setMode(sessionId, mode);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  setLayout(sessionId: SessionId, layoutId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.setLayout(sessionId, layoutId);
    this.cache.clear(sessionId);
    this.refreshCache.delete(sessionId);
  }

  warm(options?: WarmOptions): Promise<WarmResult> {
    return warmKeyboard(options);
  }

  async shutdown(): Promise<void> {
    this.sessions.shutdown();
    this.cache.clearAll();
    this.refreshCache.clear();
    this.memoryEntries = [];
    this.memoryVersion = 0;
  }

  private refresh(sessionId: SessionId): CandidateUpdate {
    const session = this.sessions.get(sessionId);
    const cacheKey = this.refreshCacheKey(session);
    const cached = this.refreshCache.get(sessionId);
    if (cached?.key === cacheKey) return cloneCandidateUpdate(cached.update);

    const textWindow = `${session.context.leftTextWindow}${session.compositionText}`;
    const proofHints = getKeyboardProofHints(textWindow, session.context);
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
      enableNextWordPrediction: context.enableNextWordPrediction ?? false,
      warnings: session.warnings
    });
  }
}

function isCandidateShortcutKey(key: KeyboardKeyEvent): boolean {
  if (key.modifiers?.ctrl || key.modifiers?.alt || key.modifiers?.meta) return false;
  return /^[1-9]$/.test(typeof key.key === "string" ? key.key : "");
}

function unknownSessionUpdate(sessionId: SessionId, input: string, cursor: number): CandidateUpdate {
  return {
    sessionId,
    mode: "diagnostic",
    surface: "romanized-to-unicode",
    action: "errorFallback",
    compositionText: input,
    displayText: input,
    caret: Math.max(0, Math.min(input.length, Math.trunc(cursor))),
    candidates: [],
    proofHints: [],
    shouldShowCandidateUI: false,
    confidence: 0,
    warnings: [`Unknown keyboard session: ${sessionId}; preserving input.`],
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
  return {
    ...update,
    action: result.action === "commit" ? "commit" : result.action,
    committedText,
    consumedRange: result.consumedRange,
    shouldShowCandidateUI: false
  };
}

export function createKeyboardEngine(): KeyboardEngine {
  return new LocalKeyboardEngine();
}

function cloneCandidateUpdate(update: CandidateUpdate): CandidateUpdate {
  return {
    ...update,
    candidates: update.candidates.map((candidate) => ({ ...candidate, reason: candidate.reason.slice() })),
    primary: update.primary ? { ...update.primary, reason: update.primary.reason.slice() } : undefined,
    inlineCompletion: update.inlineCompletion
      ? {
        ...update.inlineCompletion,
        candidate: {
          ...update.inlineCompletion.candidate,
          reason: update.inlineCompletion.candidate.reason.slice()
        }
      }
      : undefined,
    proofHints: update.proofHints.map((hint) => ({ ...hint, range: [hint.range[0], hint.range[1]] })),
    warnings: update.warnings.slice(),
    consumedRange: update.consumedRange ? [update.consumedRange[0], update.consumedRange[1]] : undefined
  };
}

export * from "./types";
export * from "./modes";
export * from "./ranges";
export * from "./warm";
export * from "./storage";
