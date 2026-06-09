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
const PREFIX_BUCKET_LENGTH = 3;

interface RuntimePackIndexes {
  words: Map<string, RuntimeWord[]>;
  phrases: Map<string, RuntimePhrase[]>;
  names: Map<string, RuntimeName[]>;
}

let indexes: RuntimePackIndexes | undefined;

export function runtimePackVersion(): string {
  return pack.version;
}

export function runtimePackCandidates(input: string, context?: TypingContext, rangeEnd = input.length): Candidate[] {
  if (context?.secureInput || context?.fieldType === "password" || context?.fieldType === "code") return [];
  const normalized = normalizeRoman(input);
  if (normalized.length < 2) return [];
  const packIndexes = runtimePackIndexes();
  const rows = [
    ...matchingRows(packIndexes.phrases, normalized, 4, MAX_RUNTIME_CANDIDATES)
      .slice(0, MAX_RUNTIME_CANDIDATES)
      .map((row, index): Candidate => runtimeCandidate(row, "phrase", index, rangeEnd, context, "runtime pack", row.romanized === normalized)),
    ...matchingRows(packIndexes.words, normalized, 3, MAX_RUNTIME_CANDIDATES)
      .slice(0, MAX_RUNTIME_CANDIDATES)
      .map((row, index): Candidate => runtimeCandidate(row, "word", index, rangeEnd, context, "runtime pack", row.romanized === normalized)),
    ...matchingRows(packIndexes.names, normalized, 3, 3)
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
  const tokens = input.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? "";
}

function normalizeRoman(input: string): string {
  return input.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function runtimePackIndexes(): RuntimePackIndexes {
  if (!indexes) {
    indexes = {
      words: buildPrefixIndex(pack.words),
      phrases: buildPrefixIndex(pack.phrases),
      names: buildPrefixIndex(pack.names)
    };
  }
  return indexes;
}

function buildPrefixIndex<T extends { romanized: string }>(rows: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    for (const key of bucketKeysForRow(row.romanized)) {
      index.set(key, [...(index.get(key) ?? []), row]);
    }
  }
  return index;
}

function matchingRows<T extends { romanized: string }>(
  index: Map<string, T[]>,
  normalized: string,
  prefixMinLength: number,
  limit: number
): T[] {
  const bucket = index.get(bucketKey(normalized)) ?? [];
  const matches: T[] = [];
  for (const row of bucket) {
    if (row.romanized === normalized || (normalized.length >= prefixMinLength && row.romanized.startsWith(normalized))) {
      matches.push(row);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function bucketKey(value: string): string {
  return value.slice(0, Math.min(PREFIX_BUCKET_LENGTH, value.length));
}

function bucketKeysForRow(value: string): string[] {
  const keys = new Set<string>();
  for (let length = 1; length <= Math.min(PREFIX_BUCKET_LENGTH, value.length); length += 1) {
    keys.add(value.slice(0, length));
  }
  return Array.from(keys);
}
