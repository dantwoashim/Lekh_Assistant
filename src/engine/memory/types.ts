export type CorrectionMemorySource =
  | "user-accept"
  | "user-edit"
  | "user-add-dictionary"
  | "proofread-accept"
  | "import";

export const MIN_CORRECTION_MEMORY_DECAY_WEIGHT = 0.2;
export const MAX_CORRECTION_MEMORY_DECAY_WEIGHT = 2;

export function privacySafeCorrectionMemoryDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(normalized) ? normalized : undefined;
}

export interface CorrectionMemoryEntry {
  id: string;
  inputRomanized?: string;
  inputPreeti?: string;
  normalizedInput: string;
  chosenOutput: string;
  normalizedOutput: string;
  rejectedAlternatives: string[];
  context: {
    leftWindow: string;
    rightWindow: string;
    domain?: string;
  };
  source: CorrectionMemorySource;
  frequency: number;
  confidenceAtSelection: number;
  timestamps: {
    firstSeen: string;
    lastUsed: string;
  };
  pinned?: boolean;
  blocked?: boolean;
  decayWeight?: number;
}

export interface CorrectionMemorySnapshot {
  schemaVersion: 2;
  migratedFrom?: string[];
  migrationCompletedAt?: string;
  entries: CorrectionMemoryEntry[];
}

export interface CorrectionMemoryStore {
  load(): Promise<CorrectionMemorySnapshot>;
  save(snapshot: CorrectionMemorySnapshot): Promise<void>;
  reset(): Promise<void>;
}

export interface MemoryScoringContext {
  input: string;
  leftWindow?: string;
  rightWindow?: string;
  domain?: string;
  protectedOriginals?: string[];
  now?: string;
}
