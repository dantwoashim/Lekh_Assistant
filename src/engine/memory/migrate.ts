import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import { normalizeCorrectionInput, type LocalCorrection } from "../../core/transliteration/localCorrectionMemory";
import { emptyMemorySnapshot } from "./storage";
import type { CorrectionMemoryEntry, CorrectionMemorySnapshot } from "./types";

export const LEGACY_ROMANIZED_MEMORY_KEY = "lekh-keyboard:romanized-corrections:v1";

export function migrateLegacyCorrections(legacy: LocalCorrection[], now = new Date().toISOString()): CorrectionMemorySnapshot {
  const entries = mergeDuplicateEntries(legacy.filter(isLegacyCorrection).map((entry) => legacyToEntry(entry, now)));
  return {
    ...emptyMemorySnapshot(),
    migratedFrom: legacy.length > 0 ? [LEGACY_ROMANIZED_MEMORY_KEY] : [],
    migrationCompletedAt: now,
    entries
  };
}

export function importCorrectionMemory(raw: string, now = new Date().toISOString()): CorrectionMemorySnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (!isSnapshot(parsed)) {
    throw new Error("Correction memory import must be schemaVersion 2.");
  }
  return {
    ...parsed,
    entries: mergeDuplicateEntries(parsed.entries.map((entry) => sanitizeEntry(entry, now)))
  };
}

export function exportCorrectionMemory(snapshot: CorrectionMemorySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function legacyToEntry(entry: LocalCorrection, now: string): CorrectionMemoryEntry {
  return {
    id: stableId(entry.normalizedInput, entry.normalizedOutput),
    inputRomanized: entry.input,
    normalizedInput: normalizeCorrectionInput(entry.input),
    chosenOutput: entry.output,
    normalizedOutput: normalizeNepaliText(entry.output),
    rejectedAlternatives: [],
    context: { leftWindow: "", rightWindow: "" },
    source: "user-accept",
    frequency: Math.max(1, entry.count),
    confidenceAtSelection: 0.8,
    timestamps: {
      firstSeen: entry.updatedAt || now,
      lastUsed: entry.updatedAt || now
    }
  };
}

function sanitizeEntry(entry: CorrectionMemoryEntry, now: string): CorrectionMemoryEntry {
  return {
    ...entry,
    id: entry.id || stableId(entry.normalizedInput, entry.normalizedOutput),
    normalizedInput: normalizeCorrectionInput(entry.inputRomanized ?? entry.inputPreeti ?? entry.normalizedInput),
    normalizedOutput: normalizeNepaliText(entry.chosenOutput),
    rejectedAlternatives: Array.isArray(entry.rejectedAlternatives) ? entry.rejectedAlternatives : [],
    context: {
      leftWindow: entry.context?.leftWindow ?? "",
      rightWindow: entry.context?.rightWindow ?? "",
      domain: entry.context?.domain
    },
    frequency: Number.isFinite(entry.frequency) ? Math.max(1, entry.frequency) : 1,
    confidenceAtSelection: Number.isFinite(entry.confidenceAtSelection) ? entry.confidenceAtSelection : 0.5,
    timestamps: {
      firstSeen: entry.timestamps?.firstSeen ?? now,
      lastUsed: entry.timestamps?.lastUsed ?? now
    }
  };
}

function mergeDuplicateEntries(entries: CorrectionMemoryEntry[]): CorrectionMemoryEntry[] {
  const merged = new Map<string, CorrectionMemoryEntry>();
  for (const entry of entries) {
    const key = `${entry.normalizedInput}\u0000${entry.normalizedOutput}\u0000${entry.context.leftWindow}\u0000${entry.context.rightWindow}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, entry);
      continue;
    }
    merged.set(key, {
      ...previous,
      frequency: previous.frequency + entry.frequency,
      timestamps: {
        firstSeen: previous.timestamps.firstSeen < entry.timestamps.firstSeen ? previous.timestamps.firstSeen : entry.timestamps.firstSeen,
        lastUsed: previous.timestamps.lastUsed > entry.timestamps.lastUsed ? previous.timestamps.lastUsed : entry.timestamps.lastUsed
      },
      pinned: previous.pinned || entry.pinned
    });
  }
  return [...merged.values()].sort((a, b) => b.frequency - a.frequency || b.timestamps.lastUsed.localeCompare(a.timestamps.lastUsed));
}

function stableId(input: string, output: string): string {
  const key = `${input}:${output}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return `memory-${hash.toString(36)}`;
}

function isLegacyCorrection(value: Partial<LocalCorrection>): value is LocalCorrection {
  return Boolean(
    value &&
      typeof value.input === "string" &&
      typeof value.output === "string" &&
      typeof value.normalizedInput === "string" &&
      typeof value.normalizedOutput === "string" &&
      typeof value.count === "number"
  );
}

function isSnapshot(value: unknown): value is CorrectionMemorySnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as CorrectionMemorySnapshot).schemaVersion === 2 &&
      Array.isArray((value as CorrectionMemorySnapshot).entries)
  );
}
