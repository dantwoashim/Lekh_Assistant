import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import { normalizeCorrectionInput, type LocalCorrection } from "../../core/transliteration/localCorrectionMemory";
import { sha256Hex } from "../util/sha256";
import { emptyMemorySnapshot, privacyProjectMemorySnapshot } from "./storage";
import {
  MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
  MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
  privacySafeCorrectionMemoryDomain
} from "./types";
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
  return `${JSON.stringify(privacyProjectMemorySnapshot(snapshot), null, 2)}\n`;
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
  const domain = privacySafeCorrectionMemoryDomain(entry.context?.domain);
  const normalizedInput = normalizeCorrectionInput(
    entry.inputRomanized ?? entry.inputPreeti ?? entry.normalizedInput
  );
  const normalizedOutput = normalizeNepaliText(entry.chosenOutput);
  const decayWeight = typeof entry.decayWeight === "number" && Number.isFinite(entry.decayWeight)
    ? Math.max(
      MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
      Math.min(MAX_CORRECTION_MEMORY_DECAY_WEIGHT, entry.decayWeight)
    )
    : 1;
  return {
    id: entry.id || stableId(normalizedInput, normalizedOutput, domain),
    ...(typeof entry.inputRomanized === "string" ? { inputRomanized: entry.inputRomanized } : {}),
    ...(typeof entry.inputPreeti === "string" ? { inputPreeti: entry.inputPreeti } : {}),
    chosenOutput: entry.chosenOutput,
    normalizedInput,
    normalizedOutput,
    rejectedAlternatives: Array.isArray(entry.rejectedAlternatives)
      ? Array.from(new Set(entry.rejectedAlternatives.filter((value): value is string => (
        typeof value === "string" && value.length > 0 && value.length <= 2048
      )))).slice(0, 32)
      : [],
    context: {
      leftWindow: "",
      rightWindow: "",
      ...(domain ? { domain } : {})
    },
    source: isCorrectionMemorySource(entry.source) ? entry.source : "import",
    frequency: Number.isFinite(entry.frequency) ? Math.max(1, Math.trunc(entry.frequency)) : 1,
    confidenceAtSelection: Number.isFinite(entry.confidenceAtSelection)
      ? Math.max(0, Math.min(1, entry.confidenceAtSelection))
      : 0.5,
    timestamps: {
      firstSeen: entry.timestamps?.firstSeen ?? now,
      lastUsed: entry.timestamps?.lastUsed ?? now
    },
    ...(typeof entry.pinned === "boolean" ? { pinned: entry.pinned } : {}),
    ...(typeof entry.blocked === "boolean" ? { blocked: entry.blocked } : {}),
    decayWeight
  };
}

function mergeDuplicateEntries(entries: CorrectionMemoryEntry[]): CorrectionMemoryEntry[] {
  const merged = new Map<string, CorrectionMemoryEntry>();
  for (const entry of entries) {
    const key = `${entry.normalizedInput}\u0000${entry.normalizedOutput}\u0000${entry.context.domain ?? ""}`;
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

function stableId(input: string, output: string, domain?: string): string {
  return `memory-${sha256Hex(JSON.stringify([input, output, domain ?? ""])).slice(0, 40)}`;
}

function isCorrectionMemorySource(value: unknown): value is CorrectionMemoryEntry["source"] {
  return value === "user-accept" || value === "user-edit" || value === "user-add-dictionary" ||
    value === "proofread-accept" || value === "import";
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
