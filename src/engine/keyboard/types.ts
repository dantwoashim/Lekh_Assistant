import type { CorrectionMemoryEntry } from "../memory/types";

export type SessionId = string;

export type KeyboardMode =
  | "romanized"
  | "traditional"
  | "romanized-romanized"
  | "romanized-traditional"
  | "traditional-traditional"
  | "traditional-romanized"
  | "unicode-proofread"
  | "dictionary-lookup"
  | "diagnostic";

export type SuggestionSurface =
  | "romanized-to-unicode"
  | "romanized-to-romanized"
  | "romanized-to-unicode-with-labels"
  | "traditional-to-unicode"
  | "traditional-to-romanized-helper"
  | "traditional-to-traditional-proofread";

export type KeyboardHostAction =
  | "passThrough"
  | "compose"
  | "commit"
  | "cancel"
  | "errorFallback";

export interface KeyboardKeyEvent {
  /**
   * Logical key value, such as "a", "Backspace", "Enter", " ".
   */
  key: string;

  /**
   * Physical key code, such as "KeyA", "Space", "Backspace".
   */
  code: string;

  modifiers: {
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };

  isRepeat?: boolean;

  /**
   * Monotonic timestamp in milliseconds if available.
   */
  timestamp: number;

  /**
   * Optional platform-specific metadata used by native bridges.
   */
  platform?: "web" | "windows-tsf" | "macos-imk" | "test";

  nativeCode?: number | string;
}

export interface TypingContext {
  appId?: string;
  appName?: string;
  fieldType?: "normal" | "password" | "search" | "code" | "unknown";
  leftTextWindow: string;
  rightTextWindow?: string;
  locale?: "ne" | "ne-NP" | "en" | string;
  activeDomains: string[];
  preserveEnglish: boolean;
  secureInput: boolean;
  mode: KeyboardMode;
  layoutId?: string;
  enabledSurfaces: SuggestionSurface[];
  showRomanizedLabels?: boolean;
  enableNextWordPrediction?: boolean;
}

export interface Candidate {
  id: string;
  text: string;
  label?: string;
  type:
    | "word"
    | "phrase"
    | "completion"
    | "correction"
    | "dictionary"
    | "personal"
    | "protected"
    | "romanized-helper";
  confidence: number;
  reason: string[];
  shortcut?: string;

  /**
   * Range in active composition buffer that this candidate replaces.
   * Offset unit: UTF-16 code units at native boundary.
   */
  replaceRange?: [number, number];
}

export interface InlineCompletion {
  /**
   * Text inserted if the inline completion is accepted.
   * This is a whole completion token/phrase, not necessarily only a suffix.
   */
  text: string;

  /**
   * Text rendered as the grey inline preview.
   */
  displayText: string;

  /**
   * Context suffix that produced the prediction.
   */
  contextText: string;

  candidate: Candidate;
  confidence: number;
  source: "active-candidate" | "ngram-lm";
  acceptKeys: Array<"Tab" | "Enter">;
}

export interface ProofHint {
  range: [number, number];
  original: string;
  suggestion: string;
  type:
    | "spelling"
    | "postposition"
    | "normalization"
    | "matra"
    | "halanta"
    | "compound"
    | "name-variant"
    | "agreement"
    | "honorific";
  confidence: number;
  action: "auto-suggest" | "hint-only" | "ask";
  explanation: string;
}

export interface DictionaryResult {
  query: string;
  word: string;
  romanized?: string[];
  variants?: string[];
  domains?: string[];
  source?: string;
  meaning?: string;
  confidence: number;
}

export interface CandidateUpdate {
  sessionId: SessionId;
  mode: KeyboardMode;
  surface: SuggestionSurface;

  /**
   * Native host decision for this update.
   * passThrough means the host application should receive the original key.
   * compose means update marked/composition text and candidate UI.
   * commit means committedText/consumedRange carry text to insert.
   * cancel means clear the active OS composition.
   * errorFallback means preserve host input and do not block the app.
   */
  action: KeyboardHostAction;

  /**
   * Raw active composition buffer.
   * In Romanized mode this is usually the Latin buffer, e.g. "swas".
   * In Traditional mode this may be the current Unicode word buffer.
   */
  compositionText: string;

  /**
   * Unicode preview intended for OS marked/composition display.
   * Example: compositionText = "swas", displayText = "स्वास्थ्य".
   */
  displayText: string;

  caret: number;
  candidates: Candidate[];
  primary?: Candidate;
  inlineCompletion?: InlineCompletion;
  proofHints: ProofHint[];
  committedText?: string;
  consumedRange?: [number, number];
  shouldShowCandidateUI: boolean;
  confidence: number;
  warnings: string[];
  latencyMs?: number;
  schemaVersion: 1;
}

export interface CommitResult {
  sessionId: SessionId;
  action: KeyboardHostAction;
  committedText: string;

  /**
   * Monotonic session-local epoch for this commit. Native clients must echo
   * this value when explicitly confirming correction learning.
   */
  commitEpoch: number;

  /**
   * Range inside active composition buffer consumed by this commit.
   * Offset unit: UTF-16 code units at the native boundary.
   */
  consumedRange?: [number, number];

  /**
   * Range inside already-committed surrounding context that should be replaced.
   * Used for proofread corrections. Offset unit: UTF-16 code units at native boundary.
   * If both consumedRange and replacementRange are present:
   *   1. replace committed context range first
   *   2. then clear/consume composition range
   */
  replacementRange?: [number, number];

  followupCandidates?: Candidate[];
  memoryRecorded: boolean;
  schemaVersion: 1;
}

export interface WarmResult {
  ready: boolean;
  partial: boolean;
  loadedModules: string[];
  unavailableModules: string[];
  warmTimeMs: number;
  warnings: string[];
}

export interface WarmOptions {
  timeoutMs?: number;
}

export type CandidateLearningMode = "immediate" | "deferred" | "disabled";

export interface CommitCandidateOptions {
  /**
   * immediate is the explicit in-process/browser path. Native IPC must use
   * deferred so memory changes only after the host confirms a successful
   * commit with memory.learn.
   */
  learning?: CandidateLearningMode;
}

/**
 * Opaque, process-local learning transaction prepared after a native host has
 * confirmed that its candidate edit succeeded. Callers may persist `entry`,
 * but only the engine instance that created this object can commit it.
 */
export interface PreparedCorrectionLearning {
  readonly sessionId: SessionId;
  readonly commitEpoch: number;
  readonly entry: CorrectionMemoryEntry;
}

export interface KeyboardEngine {
  beginSession(context: TypingContext): SessionId;

  /**
   * Browser/web-lab path.
   * Receives full active composition string from composition/input events.
   */
  updateComposition(sessionId: SessionId, input: string, cursor: number): CandidateUpdate;

  /**
   * Native IME path.
   * Required for Windows TSF and macOS InputMethodKit bridges,
   * which receive key events rather than full composition strings.
   */
  processKeyStroke(sessionId: SessionId, key: KeyboardKeyEvent): CandidateUpdate;

  commitCandidate(
    sessionId: SessionId,
    candidateId: string,
    options?: CommitCandidateOptions
  ): CommitResult;
  commitRaw(sessionId: SessionId): CommitResult;
  cancelComposition(sessionId: SessionId): void;
  endSession(sessionId: SessionId): void;

  getSuggestions(context: TypingContext): Candidate[];
  getProofHints(textWindow: string, context?: TypingContext): ProofHint[];
  lookupDictionary(query: string, context?: TypingContext): DictionaryResult[];

  learnCorrection(entry: unknown): void;
  preloadCorrectionMemory(entries: readonly unknown[]): number;
  prepareCommittedCorrectionLearning(
    sessionId: SessionId,
    commitEpoch: number
  ): PreparedCorrectionLearning | undefined;
  commitPreparedCorrectionLearning(prepared: PreparedCorrectionLearning): boolean;
  learnCommittedCorrection(sessionId: SessionId, commitEpoch: number): boolean;

  setContext(sessionId: SessionId, patch: Partial<TypingContext>): void;
  setMode(sessionId: SessionId, mode: KeyboardMode): void;
  setLayout(sessionId: SessionId, layoutId: string): void;

  warm(options?: WarmOptions): Promise<WarmResult>;
  shutdown(): Promise<void>;
}

export interface KeyboardSession {
  sessionId: SessionId;
  context: TypingContext;
  mode: KeyboardMode;
  layoutId?: string;
  compositionText: string;
  caret: number;
  candidates: Candidate[];
  proofHints: ProofHint[];
  lastUpdateTime: number;
  lastCommittedText: string;
  commitEpoch: number;
  warnings: string[];
  committedHistory: string[];
}
