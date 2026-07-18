import {
  EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID,
  experimentalPassiveSpaceCandidate,
  validateExperimentalPassiveCommitPolicy
} from "./passiveCommit";
import { createKeyboardEngine } from "./index";
import type {
  Candidate,
  CandidateUpdate,
  CommitCandidateOptions,
  CommitResult,
  DictionaryResult,
  KeyboardEngine,
  KeyboardKeyEvent,
  KeyboardMode,
  PreparedCorrectionLearning,
  ProofHint,
  SessionId,
  TypingContext,
  WarmOptions,
  WarmResult
} from "./types";

/**
 * Policy-test adapter kept outside the production engine dependency graph.
 * The normal factory never imports this module or the experimental policy.
 */
class ExperimentalPassiveCommitEngine implements KeyboardEngine {
  private readonly delegate = createKeyboardEngine();
  private readonly contexts = new Map<SessionId, TypingContext>();
  private readonly compositions = new Map<SessionId, { text: string; caret: number }>();

  beginSession(context: TypingContext): SessionId {
    const sessionId = this.delegate.beginSession(context);
    this.contexts.set(sessionId, cloneContext(context));
    this.compositions.set(sessionId, { text: "", caret: 0 });
    return sessionId;
  }

  updateComposition(sessionId: SessionId, input: string, cursor: number): CandidateUpdate {
    return this.remember(this.delegate.updateComposition(sessionId, input, cursor));
  }

  processKeyStroke(sessionId: SessionId, key: KeyboardKeyEvent): CandidateUpdate {
    const state = this.compositions.get(sessionId);
    const context = this.contexts.get(sessionId);
    if (key.key !== " " || !state || !context || state.text.length === 0) {
      return this.remember(this.delegate.processKeyStroke(sessionId, key));
    }

    const current = this.delegate.updateComposition(sessionId, state.text, state.caret);
    const candidate = experimentalPassiveSpaceCandidate(
      state.text,
      current,
      context,
      EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID
    );
    if (!candidate) return this.remember(this.delegate.processKeyStroke(sessionId, key));

    const committed = this.delegate.commitRaw(sessionId);
    this.compositions.set(sessionId, { text: "", caret: 0 });
    return {
      sessionId,
      mode: current.mode,
      surface: current.surface,
      action: "commit",
      compositionText: "",
      displayText: "",
      caret: 0,
      candidates: [],
      proofHints: [],
      committedText: `${candidate.text} `,
      ...(committed.consumedRange ? { consumedRange: committed.consumedRange } : {}),
      shouldShowCandidateUI: false,
      confidence: 0,
      warnings: current.warnings.slice(),
      schemaVersion: 1
    };
  }

  commitCandidate(
    sessionId: SessionId,
    candidateId: string,
    options?: CommitCandidateOptions
  ): CommitResult {
    const result = this.delegate.commitCandidate(sessionId, candidateId, options);
    if (result.action === "commit") this.compositions.set(sessionId, { text: "", caret: 0 });
    return result;
  }

  commitRaw(sessionId: SessionId): CommitResult {
    const result = this.delegate.commitRaw(sessionId);
    if (result.action === "commit") this.compositions.set(sessionId, { text: "", caret: 0 });
    return result;
  }

  cancelComposition(sessionId: SessionId): void {
    this.delegate.cancelComposition(sessionId);
    this.compositions.set(sessionId, { text: "", caret: 0 });
  }

  endSession(sessionId: SessionId): void {
    this.delegate.endSession(sessionId);
    this.contexts.delete(sessionId);
    this.compositions.delete(sessionId);
  }

  getSuggestions(context: TypingContext): Candidate[] { return this.delegate.getSuggestions(context); }
  getProofHints(textWindow: string, context?: TypingContext): ProofHint[] {
    return this.delegate.getProofHints(textWindow, context);
  }
  lookupDictionary(query: string, context?: TypingContext): DictionaryResult[] {
    return this.delegate.lookupDictionary(query, context);
  }
  learnCorrection(entry: unknown): void { this.delegate.learnCorrection(entry); }
  preloadCorrectionMemory(entries: readonly unknown[]): number {
    return this.delegate.preloadCorrectionMemory(entries);
  }
  prepareCommittedCorrectionLearning(
    sessionId: SessionId,
    commitEpoch: number
  ): PreparedCorrectionLearning | undefined {
    return this.delegate.prepareCommittedCorrectionLearning(sessionId, commitEpoch);
  }
  commitPreparedCorrectionLearning(prepared: PreparedCorrectionLearning): boolean {
    return this.delegate.commitPreparedCorrectionLearning(prepared);
  }
  learnCommittedCorrection(sessionId: SessionId, commitEpoch: number): boolean {
    return this.delegate.learnCommittedCorrection(sessionId, commitEpoch);
  }

  setContext(sessionId: SessionId, patch: Partial<TypingContext>): void {
    this.delegate.setContext(sessionId, patch);
    const previous = this.contexts.get(sessionId);
    if (previous) this.contexts.set(sessionId, cloneContext({ ...previous, ...patch }));
  }

  setMode(sessionId: SessionId, mode: KeyboardMode): void {
    this.delegate.setMode(sessionId, mode);
    const context = this.contexts.get(sessionId);
    if (context) this.contexts.set(sessionId, { ...context, mode });
    this.compositions.set(sessionId, { text: "", caret: 0 });
  }

  setLayout(sessionId: SessionId, layoutId: string): void {
    this.delegate.setLayout(sessionId, layoutId);
    const context = this.contexts.get(sessionId);
    if (context) this.contexts.set(sessionId, { ...context, layoutId });
  }

  warm(options?: WarmOptions): Promise<WarmResult> { return this.delegate.warm(options); }

  async shutdown(): Promise<void> {
    this.contexts.clear();
    this.compositions.clear();
    await this.delegate.shutdown();
  }

  private remember(update: CandidateUpdate): CandidateUpdate {
    this.compositions.set(update.sessionId, { text: update.compositionText, caret: update.caret });
    return update;
  }
}

export function createExperimentalKeyboardEngineForPolicyTests(): KeyboardEngine {
  if (import.meta.env.MODE !== "test") {
    throw new Error("Experimental passive commit is available only in the policy test build.");
  }
  const policyErrors = validateExperimentalPassiveCommitPolicy();
  if (policyErrors.length > 0) {
    throw new Error(`Experimental passive-commit policy failed closed: ${policyErrors.join(" ")}`);
  }
  return new ExperimentalPassiveCommitEngine();
}

function cloneContext(context: TypingContext): TypingContext {
  return {
    ...context,
    activeDomains: context.activeDomains.slice(),
    enabledSurfaces: context.enabledSurfaces.slice()
  };
}
