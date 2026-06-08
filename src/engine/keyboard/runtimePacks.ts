import runtimePack from "../../data/keyboard-packs/v0.1/runtime-suggestions.json";
import type { Candidate, TypingContext } from "./types";

interface RuntimeWord {
  romanized: string;
  unicode: string;
  confidence: number;
  quality: string;
}

interface RuntimePhrase {
  romanized: string;
  unicode: string;
  domain?: string;
  confidence: number;
  quality: string;
}

interface RuntimeName {
  romanized: string;
  unicode: string;
  subtype?: string;
  confidence: number;
  quality: string;
}

interface RuntimePack {
  version: string;
  generatedAt: string;
  words: RuntimeWord[];
  phrases: RuntimePhrase[];
  names: RuntimeName[];
  mixedPolicy: {
    preserveAlways: string[];
    preferenceTokens: string[];
  };
}

const pack = runtimePack as RuntimePack;
const MAX_RUNTIME_CANDIDATES = 6;

export function runtimePackVersion(): string {
  return pack.version;
}

export function runtimePackCandidates(input: string, context?: TypingContext, rangeEnd = input.length): Candidate[] {
  if (context?.secureInput || context?.fieldType === "password" || context?.fieldType === "code") return [];
  const normalized = normalizeRoman(input);
  if (normalized.length < 2) return [];
  const rows = [
    ...pack.phrases
      .filter((row) => row.romanized === normalized || (normalized.length >= 4 && row.romanized.startsWith(normalized)))
      .slice(0, MAX_RUNTIME_CANDIDATES)
      .map((row, index): Candidate => runtimeCandidate(row, "phrase", index, rangeEnd, context, "runtime pack", row.romanized === normalized)),
    ...pack.words
      .filter((row) => row.romanized === normalized || (normalized.length >= 3 && row.romanized.startsWith(normalized)))
      .slice(0, MAX_RUNTIME_CANDIDATES)
      .map((row, index): Candidate => runtimeCandidate(row, "word", index, rangeEnd, context, "runtime pack", row.romanized === normalized)),
    ...pack.names
      .filter((row) => row.romanized === normalized || (normalized.length >= 3 && row.romanized.startsWith(normalized)))
      .slice(0, 3)
      .map((row, index): Candidate => runtimeCandidate(row, "word", index, rangeEnd, context, "name index", row.romanized === normalized)),
  ];
  return rows.slice(0, MAX_RUNTIME_CANDIDATES);
}

export function runtimePackSuggestions(context: TypingContext): Candidate[] {
  const token = currentToken(context.leftTextWindow);
  return runtimePackCandidates(token, context, token.length);
}

export function runtimeMixedPolicy() {
  return {
    preserveAlways: pack.mixedPolicy.preserveAlways.slice(),
    preferenceTokens: pack.mixedPolicy.preferenceTokens.slice(),
  };
}

function runtimeCandidate(
  row: RuntimeWord | RuntimePhrase | RuntimeName,
  type: Candidate["type"],
  index: number,
  rangeEnd: number,
  context?: TypingContext,
  source = "runtime pack",
  exact = true
): Candidate {
  const confidence = exact ? row.confidence : row.confidence - 0.22;
  return {
    id: `runtime-${type}-${index}-${row.unicode}`,
    text: row.unicode,
    label: context?.showRomanizedLabels ? row.romanized : undefined,
    type,
    confidence: Math.max(0.55, Math.min(0.97, confidence)),
    reason: [`${source} ${pack.version}`, `quality:${row.quality}`],
    replaceRange: [0, rangeEnd],
  };
}

function currentToken(input: string): string {
  return input.trim().split(/\s+/).at(-1) ?? "";
}

function normalizeRoman(input: string): string {
  return input.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
