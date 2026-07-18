import { normalizeCorrectionInput } from "../../core/transliteration/localCorrectionMemory";
import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import {
  MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
  MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
  privacySafeCorrectionMemoryDomain
} from "../memory/types";
import {
  canonicalCorrectionMemoryId,
  normalizeCorrectionMemoryImportEntries,
  normalizeCorrectionMemoryImportEntry
} from "../memory/importNormalization";
import type { CorrectionMemoryEntry } from "../memory";
import { installBoundedCorrectionMemoryEntry } from "./storage";
import type { Candidate, KeyboardSession } from "./types";

const MAXIMUM_REJECTED_ALTERNATIVES = 32;
const MAXIMUM_INPUT_LENGTH = 1024;
const MAXIMUM_OUTPUT_LENGTH = 2048;

export function keyboardMemoryCandidates(input: string, entries: CorrectionMemoryEntry[], session: KeyboardSession): Candidate[] {
  const normalized = normalizeCorrectionInput(input);
  if (!normalized) return [];

  return entries
    .filter((entry) => entry.normalizedInput === normalized && !entry.blocked)
    .sort((a, b) => memoryScore(b, session) - memoryScore(a, session))
    .slice(0, 4)
    .map((entry, index): Candidate => ({
      id: `memory-${index}-${entry.id}`,
      text: entry.chosenOutput,
      label: entry.inputRomanized,
      type: "personal",
      confidence: Math.min(0.99, 0.82 + Math.min(0.16, memoryScore(entry, session) / 2200)),
      reason: [
        "Local correction memory exact input match",
        `frequency ${entry.frequency}`,
        `recency ${recencyWeight(entry).toFixed(2)}`,
        `decay ${effectiveDecayWeight(entry).toFixed(2)}`,
        entry.context.domain && session.context.activeDomains.includes(entry.context.domain)
          ? "same privacy-safe domain"
          : "domain-neutral"
      ],
      replaceRange: [0, input.length]
    }));
}

export function recordKeyboardMemorySelection(
  entries: CorrectionMemoryEntry[],
  session: KeyboardSession,
  candidate: Candidate
): CorrectionMemoryEntry[] {
  const selection = buildKeyboardMemorySelection(session, candidate);
  return selection ? applyKeyboardMemorySelection(entries, selection) : entries;
}

/**
 * Creates the exact entry that an explicit selection may learn. Surrounding
 * host text is deliberately projected out before the entry can become pending
 * or enter memory; only a bounded, non-reconstructable domain label survives.
 */
export function buildKeyboardMemorySelection(
  session: KeyboardSession,
  candidate: Candidate
): CorrectionMemoryEntry | undefined {
  const normalizedInput = normalizeCorrectionInput(session.compositionText);
  const normalizedOutput = normalizeNepaliText(candidate.text);
  if (
    !normalizedInput ||
    !normalizedOutput ||
    candidate.type === "protected" ||
    session.compositionText.length > MAXIMUM_INPUT_LENGTH ||
    candidate.text.length > MAXIMUM_OUTPUT_LENGTH
  ) return undefined;

  const now = new Date().toISOString();
  const rejectedAlternatives = session.candidates
    .filter((item) => item.id !== candidate.id)
    .map((item) => item.text)
    .filter((item) => item.length > 0 && item.length <= MAXIMUM_OUTPUT_LENGTH)
    .slice(0, 8);
  const domain = privacySafeCorrectionMemoryDomain(session.context.activeDomains[0]);
  return {
    id: canonicalCorrectionMemoryId(normalizedInput, normalizedOutput, domain),
    inputRomanized: /[A-Za-z]/.test(session.compositionText) ? session.compositionText : undefined,
    chosenOutput: candidate.text,
    normalizedInput,
    normalizedOutput,
    rejectedAlternatives,
    context: {
      leftWindow: "",
      rightWindow: "",
      ...(domain ? { domain } : {})
    },
    source: "user-accept",
    frequency: 1,
    confidenceAtSelection: candidate.confidence,
    timestamps: {
      firstSeen: now,
      lastUsed: now
    },
    decayWeight: 1
  };
}

/** Applies a previously privacy-projected selection atomically. */
export function applyKeyboardMemorySelection(
  entries: CorrectionMemoryEntry[],
  selection: CorrectionMemoryEntry
): CorrectionMemoryEntry[] {
  const existing = entries.find((entry) =>
    entry.normalizedInput === selection.normalizedInput &&
    entry.normalizedOutput === selection.normalizedOutput &&
    (entry.context.domain ?? "") === (selection.context.domain ?? "")
  );
  if (!existing) return installBoundedCorrectionMemoryEntry(entries, selection) ?? entries;

  return entries.map((entry) => entry === existing
    ? {
      ...entry,
      inputRomanized: selection.inputRomanized ?? entry.inputRomanized,
      inputPreeti: selection.inputPreeti ?? entry.inputPreeti,
      rejectedAlternatives: Array.from(new Set([
        ...entry.rejectedAlternatives,
        ...selection.rejectedAlternatives
      ])).slice(0, MAXIMUM_REJECTED_ALTERNATIVES),
      context: selection.context,
      frequency: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, entry.frequency) + 1),
      confidenceAtSelection: selection.confidenceAtSelection,
      timestamps: { ...entry.timestamps, lastUsed: selection.timestamps.lastUsed },
      decayWeight: Math.min(
        MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
        effectiveDecayWeight(entry) + 0.08
      )
    }
    : entry);
}

export function importKeyboardMemoryEntry(entries: CorrectionMemoryEntry[], raw: unknown): CorrectionMemoryEntry[] {
  try {
    const imported = normalizeCorrectionMemoryImportEntry(raw, {
      defaultTimestamp: new Date().toISOString(),
      scoringPolicy: "clamp",
      minimumFrequency: 0
    });
    const semanticIndex = entries.findIndex((entry) => sameMemorySemantics(entry, imported));
    const idCollision = entries.find((entry) => entry.id === imported.id && !sameMemorySemantics(entry, imported));
    if (idCollision) return entries;
    if (semanticIndex < 0) return installBoundedCorrectionMemoryEntry(entries, imported) ?? entries;

    const existing = entries[semanticIndex]!;
    const [merged] = normalizeCorrectionMemoryImportEntries([existing, imported], {
      requireTimestamps: true,
      scoringPolicy: "clamp",
      minimumFrequency: 0
    });
    if (!merged) return entries;
    const next = entries.slice();
    next[semanticIndex] = merged;
    return next;
  } catch {
    return entries;
  }
}

export function keyboardBlockedCandidateTexts(input: string, entries: CorrectionMemoryEntry[]): Set<string> {
  const normalized = normalizeCorrectionInput(input);
  if (!normalized) return new Set();
  return new Set(
    entries
      .filter((entry) => entry.normalizedInput === normalized && entry.blocked)
      .map((entry) => entry.chosenOutput)
  );
}

function memoryScore(entry: CorrectionMemoryEntry, session: KeyboardSession): number {
  const exactSelectionBoost = 160;
  const domainBoost = entry.context.domain && session.context.activeDomains.includes(entry.context.domain) ? 90 : 0;
  const pinBoost = entry.pinned ? 220 : 0;
  const sourceBoost = entry.source === "import" ? 35 : 0;
  const confidenceBoost = Math.max(0, Math.min(1, entry.confidenceAtSelection)) * 120;
  const repeatedBoost = Math.log1p(Math.max(0, entry.frequency)) * 160;
  return Math.round((
    exactSelectionBoost + repeatedBoost + domainBoost + pinBoost + sourceBoost + confidenceBoost
  ) * recencyWeight(entry) * effectiveDecayWeight(entry));
}

function effectiveDecayWeight(entry: CorrectionMemoryEntry): number {
  return Math.max(
    MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
    Math.min(MAX_CORRECTION_MEMORY_DECAY_WEIGHT, entry.decayWeight ?? 1)
  );
}

function recencyWeight(entry: CorrectionMemoryEntry): number {
  const lastUsed = Date.parse(entry.timestamps.lastUsed);
  if (!Number.isFinite(lastUsed)) return 0.6;
  const ageDays = Math.max(0, (Date.now() - lastUsed) / (24 * 60 * 60 * 1000));
  const halfLifeDays = entry.pinned ? 365 : 45;
  return Math.max(0.25, Math.pow(0.5, ageDays / halfLifeDays));
}

function sameMemorySemantics(left: CorrectionMemoryEntry, right: CorrectionMemoryEntry): boolean {
  return left.normalizedInput === right.normalizedInput &&
    left.normalizedOutput === right.normalizedOutput &&
    (left.context.domain ?? "") === (right.context.domain ?? "");
}
