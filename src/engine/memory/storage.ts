import {
  MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
  MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
  privacySafeCorrectionMemoryDomain
} from "./types";
import type { CorrectionMemoryEntry, CorrectionMemorySnapshot, CorrectionMemoryStore } from "./types";

export const CORRECTION_MEMORY_SCHEMA_VERSION = 2;

export function emptyMemorySnapshot(): CorrectionMemorySnapshot {
  return {
    schemaVersion: CORRECTION_MEMORY_SCHEMA_VERSION,
    entries: []
  };
}

export class InMemoryCorrectionMemoryStore implements CorrectionMemoryStore {
  private snapshot: CorrectionMemorySnapshot;

  constructor(initial: CorrectionMemorySnapshot = emptyMemorySnapshot()) {
    this.snapshot = privacyProjectMemorySnapshot(initial);
  }

  async load(): Promise<CorrectionMemorySnapshot> {
    return structuredCloneSafe(this.snapshot);
  }

  async save(snapshot: CorrectionMemorySnapshot): Promise<void> {
    this.snapshot = privacyProjectMemorySnapshot(snapshot);
  }

  async reset(): Promise<void> {
    this.snapshot = emptyMemorySnapshot();
  }
}

export function privacyProjectMemorySnapshot(snapshot: CorrectionMemorySnapshot): CorrectionMemorySnapshot {
  return structuredCloneSafe({
    schemaVersion: 2,
    ...(Array.isArray(snapshot.migratedFrom) ? { migratedFrom: snapshot.migratedFrom.slice() } : {}),
    ...(typeof snapshot.migrationCompletedAt === "string"
      ? { migrationCompletedAt: snapshot.migrationCompletedAt }
      : {}),
    entries: snapshot.entries.map(privacyProjectMemoryEntry)
  });
}

function privacyProjectMemoryEntry(entry: CorrectionMemoryEntry): CorrectionMemoryEntry {
  const domain = privacySafeCorrectionMemoryDomain(entry.context?.domain);
  const decayWeight = typeof entry.decayWeight === "number" && Number.isFinite(entry.decayWeight)
    ? Math.max(
      MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
      Math.min(MAX_CORRECTION_MEMORY_DECAY_WEIGHT, entry.decayWeight)
    )
    : 1;
  return {
    id: entry.id,
    ...(typeof entry.inputRomanized === "string" ? { inputRomanized: entry.inputRomanized } : {}),
    ...(typeof entry.inputPreeti === "string" ? { inputPreeti: entry.inputPreeti } : {}),
    normalizedInput: entry.normalizedInput,
    chosenOutput: entry.chosenOutput,
    normalizedOutput: entry.normalizedOutput,
    rejectedAlternatives: Array.isArray(entry.rejectedAlternatives) ? entry.rejectedAlternatives.slice(0, 32) : [],
    context: { leftWindow: "", rightWindow: "", ...(domain ? { domain } : {}) },
    source: entry.source,
    frequency: entry.frequency,
    confidenceAtSelection: entry.confidenceAtSelection,
    timestamps: {
      firstSeen: entry.timestamps.firstSeen,
      lastUsed: entry.timestamps.lastUsed
    },
    ...(typeof entry.pinned === "boolean" ? { pinned: entry.pinned } : {}),
    ...(typeof entry.blocked === "boolean" ? { blocked: entry.blocked } : {}),
    decayWeight
  };
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
