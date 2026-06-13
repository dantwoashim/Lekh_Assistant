import { normalizeCorrectionInput } from "../../core/transliteration/localCorrectionMemory";
import type { CorrectionMemoryEntry } from "../memory";
import type { Candidate, KeyboardSession } from "./types";

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
        entry.context.leftWindow === session.context.leftTextWindow ? "same left context" : "different context"
      ],
      replaceRange: [0, input.length]
    }));
}

export function recordKeyboardMemorySelection(
  entries: CorrectionMemoryEntry[],
  session: KeyboardSession,
  candidate: Candidate
): CorrectionMemoryEntry[] {
  const normalizedInput = normalizeCorrectionInput(session.compositionText);
  const normalizedOutput = normalizeCorrectionInput(candidate.text);
  if (!normalizedInput || !normalizedOutput || candidate.type === "protected") return entries;

  const existing = entries.find((entry) =>
    entry.normalizedInput === normalizedInput &&
    entry.normalizedOutput === normalizedOutput &&
    entry.context.leftWindow === session.context.leftTextWindow
  );
  const now = new Date().toISOString();
  const rejectedAlternatives = session.candidates
    .filter((item) => item.id !== candidate.id)
    .map((item) => item.text)
    .slice(0, 8);

  if (existing) {
    return entries.map((entry) =>
      entry === existing
        ? {
          ...entry,
          rejectedAlternatives: Array.from(new Set([...entry.rejectedAlternatives, ...rejectedAlternatives])).slice(0, 12),
          frequency: entry.frequency + 1,
          timestamps: { ...entry.timestamps, lastUsed: now },
          decayWeight: Math.min(1.8, effectiveDecayWeight(entry) + 0.08)
        }
        : entry
    );
  }

  const created: CorrectionMemoryEntry = {
    id: `kbd-memory-${Date.now().toString(36)}-${entries.length.toString(36)}`,
    inputRomanized: /[A-Za-z]/.test(session.compositionText) ? session.compositionText : undefined,
    chosenOutput: candidate.text,
    normalizedInput,
    normalizedOutput,
    rejectedAlternatives,
    context: {
      leftWindow: session.context.leftTextWindow,
      rightWindow: session.context.rightTextWindow ?? "",
      domain: session.context.activeDomains[0]
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

  return [...entries, created].slice(-500);
}

export function importKeyboardMemoryEntry(entries: CorrectionMemoryEntry[], raw: unknown): CorrectionMemoryEntry[] {
  if (!raw || typeof raw !== "object") return entries;
  const value = raw as Partial<CorrectionMemoryEntry>;
  if (!value.chosenOutput || (!value.inputRomanized && !value.normalizedInput)) return entries;
  const now = new Date().toISOString();
  const normalizedInput = value.normalizedInput ?? normalizeCorrectionInput(value.inputRomanized ?? "");
  const normalizedOutput = value.normalizedOutput ?? normalizeCorrectionInput(value.chosenOutput);
  if (!normalizedInput || !normalizedOutput) return entries;
  return [
    ...entries,
    {
      id: value.id ?? `kbd-import-${Date.now().toString(36)}-${entries.length.toString(36)}`,
      inputRomanized: value.inputRomanized,
      inputPreeti: value.inputPreeti,
      chosenOutput: value.chosenOutput,
      normalizedInput,
      normalizedOutput,
      rejectedAlternatives: value.rejectedAlternatives ?? [],
      context: value.context ?? { leftWindow: "", rightWindow: "" },
      source: value.source ?? "import",
      frequency: value.frequency ?? 1,
      confidenceAtSelection: value.confidenceAtSelection ?? 0.8,
      timestamps: value.timestamps ?? { firstSeen: now, lastUsed: now },
      pinned: value.pinned,
      blocked: value.blocked,
      decayWeight: value.decayWeight ?? 1
    }
  ].slice(-500);
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
  const contextBoost = entry.context.leftWindow === session.context.leftTextWindow ? 160 : 0;
  const domainBoost = entry.context.domain && session.context.activeDomains.includes(entry.context.domain) ? 90 : 0;
  const pinBoost = entry.pinned ? 220 : 0;
  const sourceBoost = entry.source === "import" ? 35 : 0;
  const confidenceBoost = Math.max(0, Math.min(1, entry.confidenceAtSelection)) * 120;
  const repeatedBoost = Math.log1p(Math.max(0, entry.frequency)) * 160;
  return Math.round((repeatedBoost + contextBoost + domainBoost + pinBoost + sourceBoost + confidenceBoost) * recencyWeight(entry) * effectiveDecayWeight(entry));
}

function effectiveDecayWeight(entry: CorrectionMemoryEntry): number {
  return Math.max(0.2, Math.min(2, entry.decayWeight ?? 1));
}

function recencyWeight(entry: CorrectionMemoryEntry): number {
  const lastUsed = Date.parse(entry.timestamps.lastUsed);
  if (!Number.isFinite(lastUsed)) return 0.6;
  const ageDays = Math.max(0, (Date.now() - lastUsed) / (24 * 60 * 60 * 1000));
  const halfLifeDays = entry.pinned ? 365 : 45;
  return Math.max(0.25, Math.pow(0.5, ageDays / halfLifeDays));
}
