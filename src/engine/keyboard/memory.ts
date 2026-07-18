import { normalizeCorrectionInput } from "../../core/transliteration/localCorrectionMemory";
import {
  MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
  MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
  privacySafeCorrectionMemoryDomain
} from "../memory/types";
import type { CorrectionMemoryEntry, CorrectionMemorySource } from "../memory";
import { sha256Hex } from "../util/sha256";
import type { Candidate, KeyboardSession } from "./types";

const MAXIMUM_MEMORY_ENTRIES = 500;
const MAXIMUM_REJECTED_ALTERNATIVES = 32;
const MAXIMUM_INPUT_LENGTH = 1024;
const MAXIMUM_OUTPUT_LENGTH = 2048;
const MAXIMUM_ID_LENGTH = 256;
const MAXIMUM_TIMESTAMP_LENGTH = 64;
const ALLOWED_MEMORY_SOURCES = new Set<CorrectionMemorySource>([
  "user-accept",
  "user-edit",
  "user-add-dictionary",
  "proofread-accept",
  "import"
]);

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
  const normalizedOutput = normalizeCorrectionInput(candidate.text);
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
    id: semanticMemoryEntryId(normalizedInput, normalizedOutput, domain),
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
  if (!existing) return [...entries, selection].slice(-MAXIMUM_MEMORY_ENTRIES);

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
  if (!raw || typeof raw !== "object") return entries;
  const value = raw as Partial<CorrectionMemoryEntry>;
  const chosenOutput = boundedString(value.chosenOutput, MAXIMUM_OUTPUT_LENGTH);
  const inputRomanized = boundedString(value.inputRomanized, MAXIMUM_INPUT_LENGTH);
  const inputPreeti = boundedString(value.inputPreeti, MAXIMUM_INPUT_LENGTH);
  const suppliedNormalizedInput = boundedString(value.normalizedInput, MAXIMUM_INPUT_LENGTH);
  if (!chosenOutput || (!inputRomanized && !suppliedNormalizedInput)) return entries;
  const now = new Date().toISOString();
  const normalizedInput = normalizeCorrectionInput(suppliedNormalizedInput ?? inputRomanized ?? "");
  const normalizedOutput = normalizeCorrectionInput(
    boundedString(value.normalizedOutput, MAXIMUM_OUTPUT_LENGTH) ?? chosenOutput
  );
  if (!normalizedInput || !normalizedOutput) return entries;
  const context = value.context && typeof value.context === "object" ? value.context : undefined;
  const domain = privacySafeCorrectionMemoryDomain(context?.domain);
  const timestamps = value.timestamps && typeof value.timestamps === "object" ? value.timestamps : undefined;
  const frequency = Number.isSafeInteger(value.frequency) && (value.frequency ?? -1) >= 0
    ? value.frequency as number
    : 1;
  const confidence = typeof value.confidenceAtSelection === "number" &&
    Number.isFinite(value.confidenceAtSelection) &&
    value.confidenceAtSelection >= 0 &&
    value.confidenceAtSelection <= 1
    ? value.confidenceAtSelection
    : 0.8;
  const decayWeight = typeof value.decayWeight === "number" && Number.isFinite(value.decayWeight)
    ? Math.max(
      MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
      Math.min(MAX_CORRECTION_MEMORY_DECAY_WEIGHT, value.decayWeight)
    )
    : 1;
  const source = value.source && ALLOWED_MEMORY_SOURCES.has(value.source) ? value.source : "import";
  const rejectedAlternatives = Array.isArray(value.rejectedAlternatives)
    ? Array.from(new Set(value.rejectedAlternatives.filter((item): item is string => (
      typeof item === "string" && item.length > 0 && item.length <= MAXIMUM_OUTPUT_LENGTH
    )))).slice(0, MAXIMUM_REJECTED_ALTERNATIVES)
    : [];
  return [
    ...entries,
    {
      id: boundedString(value.id, MAXIMUM_ID_LENGTH) ?? `kbd-import-${Date.now().toString(36)}-${entries.length.toString(36)}`,
      ...(inputRomanized ? { inputRomanized } : {}),
      ...(inputPreeti ? { inputPreeti } : {}),
      chosenOutput,
      normalizedInput,
      normalizedOutput,
      rejectedAlternatives,
      context: { leftWindow: "", rightWindow: "", ...(domain ? { domain } : {}) },
      source,
      frequency,
      confidenceAtSelection: confidence,
      timestamps: {
        firstSeen: boundedString(timestamps?.firstSeen, MAXIMUM_TIMESTAMP_LENGTH) ?? now,
        lastUsed: boundedString(timestamps?.lastUsed, MAXIMUM_TIMESTAMP_LENGTH) ?? now
      },
      ...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}),
      ...(typeof value.blocked === "boolean" ? { blocked: value.blocked } : {}),
      decayWeight
    }
  ].slice(-MAXIMUM_MEMORY_ENTRIES);
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

function boundedString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : undefined;
}

function semanticMemoryEntryId(
  normalizedInput: string,
  normalizedOutput: string,
  domain: string | undefined
): string {
  const digest = sha256Hex(JSON.stringify([normalizedInput, normalizedOutput, domain ?? ""]));
  return `kbd-memory-${digest.slice(0, 40)}`;
}
