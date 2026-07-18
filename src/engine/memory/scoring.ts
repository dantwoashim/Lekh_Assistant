import { normalizeCorrectionInput } from "../../core/transliteration/localCorrectionMemory";
import type { Candidate } from "../types";
import {
  MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
  MIN_CORRECTION_MEMORY_DECAY_WEIGHT
} from "./types";
import type { CorrectionMemoryEntry, MemoryScoringContext } from "./types";

export function correctionMemoryCandidates(entries: CorrectionMemoryEntry[], context: MemoryScoringContext): Candidate[] {
  const normalizedInput = normalizeCorrectionInput(context.input);
  if (!normalizedInput || context.protectedOriginals?.some((original) => normalizeCorrectionInput(original) === normalizedInput)) return [];

  return entries
    .filter((entry) => entry.normalizedInput === normalizedInput)
    .map((entry) => ({ entry, score: scoreCorrection(entry, context) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.entry.frequency - a.entry.frequency)
    .slice(0, 5)
    .map(({ entry, score }): Candidate => ({
      text: entry.chosenOutput,
      normalizedText: entry.normalizedOutput,
      source: "memory",
      confidence: Math.min(0.98, Math.max(0.2, score / 2000)),
      score: {
        phraseBoost: 0,
        aliasBoost: 0,
        phoneticScore: 0,
        dictionaryScore: 0,
        hunspellScore: 0,
        frequencyScore: Math.min(100, entry.frequency * 6),
        domainScore: context.domain && context.domain === entry.context.domain ? 80 : 0,
        contextScore: contextSimilarity(entry, context) * 120,
        namePlaceScore: 0,
        loanwordScore: 0,
        userMemoryBoost: score,
        englishCorruptionPenalty: 0,
        protectedSpanPenalty: 0,
        unknownTokenPenalty: 0,
        malformedOutputPenalty: 0,
        badMatraPenalty: 0,
        mixedScriptPenalty: 0,
        rareWordPenalty: 0,
        total: score
      },
      evidence: [{ source: "user-local", detail: "Local correction memory exact input match", weight: score }],
      warnings: []
    }));
}

export function scoreCorrection(entry: CorrectionMemoryEntry, context: MemoryScoringContext): number {
  const normalizedInput = normalizeCorrectionInput(context.input);
  if (entry.normalizedInput !== normalizedInput) return 0;
  const contextScore = contextSimilarity(entry, context);
  const repeatedBoost = Math.min(120, entry.frequency * 12);
  const pinBoost = entry.pinned ? 180 : 0;
  const decay = Math.max(
    MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
    Math.min(MAX_CORRECTION_MEMORY_DECAY_WEIGHT, entry.decayWeight ?? 1)
  );
  return Math.round((1450 + repeatedBoost + pinBoost + contextScore * 120) * decay);
}

function contextSimilarity(entry: CorrectionMemoryEntry, context: MemoryScoringContext): number {
  return context.domain && context.domain === entry.context.domain ? 1 : 0;
}
