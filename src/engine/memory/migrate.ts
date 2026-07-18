import type { LocalCorrection } from "../../core/transliteration/localCorrectionMemory";
import { isWellFormedUtf16 } from "../util/utf16";
import {
  canonicalIsoTimestamp,
  normalizeCorrectionMemoryImportEntries,
  normalizeCorrectionMemoryImportEntry
} from "./importNormalization";
import { emptyMemorySnapshot, privacyProjectMemorySnapshot } from "./storage";
import type { CorrectionMemoryEntry, CorrectionMemorySnapshot } from "./types";

export const LEGACY_ROMANIZED_MEMORY_KEY = "lekh-keyboard:romanized-corrections:v1";

export function migrateLegacyCorrections(
  legacy: LocalCorrection[],
  now = new Date().toISOString()
): CorrectionMemorySnapshot {
  const canonicalNow = canonicalIsoTimestamp(now, "migration timestamp");
  if (!Array.isArray(legacy) || legacy.some((entry) => !isLegacyCorrection(entry))) {
    throw new Error("Legacy correction memory contains a malformed entry.");
  }
  const entries = mergeLegacyDuplicateEntries(
    legacy.map((entry) => legacyToEntry(entry, canonicalNow))
  );
  return {
    ...emptyMemorySnapshot(),
    migratedFrom: legacy.length > 0 ? [LEGACY_ROMANIZED_MEMORY_KEY] : [],
    migrationCompletedAt: canonicalNow,
    entries
  };
}

export function importCorrectionMemory(raw: string, now = new Date().toISOString()): CorrectionMemorySnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (!isSnapshot(parsed)) {
    throw new Error("Correction memory import must be schemaVersion 2.");
  }
  const canonicalNow = canonicalIsoTimestamp(now, "import timestamp");
  return {
    schemaVersion: 2,
    ...(parsed.migratedFrom === undefined ? {} : {
      migratedFrom: normalizeMigrationSources(parsed.migratedFrom)
    }),
    ...(parsed.migrationCompletedAt === undefined ? {} : {
      migrationCompletedAt: canonicalIsoTimestamp(parsed.migrationCompletedAt, "migrationCompletedAt")
    }),
    entries: normalizeCorrectionMemoryImportEntries(parsed.entries, {
      defaultTimestamp: canonicalNow,
      requireTimestamps: true,
      scoringPolicy: "clamp",
      minimumFrequency: 1
    })
  };
}

export function exportCorrectionMemory(snapshot: CorrectionMemorySnapshot): string {
  return `${JSON.stringify(privacyProjectMemorySnapshot(snapshot), null, 2)}\n`;
}

function legacyToEntry(entry: LocalCorrection, now: string): CorrectionMemoryEntry {
  return normalizeCorrectionMemoryImportEntry({
    inputRomanized: entry.input,
    normalizedInput: entry.normalizedInput,
    chosenOutput: entry.output,
    normalizedOutput: entry.normalizedOutput,
    rejectedAlternatives: [],
    context: { leftWindow: "", rightWindow: "" },
    source: "user-accept",
    frequency: entry.count,
    confidenceAtSelection: 0.8,
    timestamps: {
      firstSeen: entry.updatedAt || now,
      lastUsed: entry.updatedAt || now
    }
  }, {
    defaultTimestamp: now,
    requireTimestamps: true,
    requireKnownSource: true,
    scoringPolicy: "clamp",
    minimumFrequency: 1
  });
}

function mergeLegacyDuplicateEntries(entries: CorrectionMemoryEntry[]): CorrectionMemoryEntry[] {
  const merged = new Map<string, CorrectionMemoryEntry>();
  for (const entry of entries) {
    const previous = merged.get(entry.id);
    if (!previous) {
      merged.set(entry.id, entry);
      continue;
    }
    if (
      previous.normalizedInput !== entry.normalizedInput ||
      previous.normalizedOutput !== entry.normalizedOutput ||
      (previous.context.domain ?? "") !== (entry.context.domain ?? "")
    ) {
      throw new Error("Legacy correction memory produced a canonical ID collision.");
    }
    merged.set(entry.id, {
      ...previous,
      frequency: Math.min(Number.MAX_SAFE_INTEGER, previous.frequency + entry.frequency),
      timestamps: {
        firstSeen: previous.timestamps.firstSeen < entry.timestamps.firstSeen
          ? previous.timestamps.firstSeen
          : entry.timestamps.firstSeen,
        lastUsed: previous.timestamps.lastUsed > entry.timestamps.lastUsed
          ? previous.timestamps.lastUsed
          : entry.timestamps.lastUsed
      },
      pinned: previous.pinned || entry.pinned
    });
  }
  return [...merged.values()].sort((left, right) => (
    right.frequency - left.frequency || right.timestamps.lastUsed.localeCompare(left.timestamps.lastUsed)
  ));
}

function normalizeMigrationSources(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => (
    typeof item !== "string" || item.length === 0 || item.length > 256 || !isWellFormedUtf16(item)
  ))) {
    throw new Error("Correction memory migratedFrom must be a bounded UTF-16 string array.");
  }
  return [...new Set(value.map((item) => item.normalize("NFC")))];
}

function isLegacyCorrection(value: Partial<LocalCorrection>): value is LocalCorrection {
  return Boolean(
    value &&
      typeof value.input === "string" &&
      typeof value.output === "string" &&
      typeof value.normalizedInput === "string" &&
      typeof value.normalizedOutput === "string" &&
      typeof value.count === "number" &&
      Number.isSafeInteger(value.count) &&
      value.count >= 0 &&
      typeof value.updatedAt === "string"
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
