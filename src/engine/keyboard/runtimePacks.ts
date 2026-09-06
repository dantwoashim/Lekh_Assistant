import runtimePack from "../../data/keyboard-packs/v0.1/runtime-suggestions.release.json";
import { isSecureContext } from "./modes";
import { romanizedCanonicalKey, romanizedToleranceKeys, romanizedToleranceMatch } from "./romanizationTolerance";
import type { Candidate, TypingContext } from "./types";

interface RuntimeWord {
  romanized: string;
  unicode: string;
  confidence: number;
  quality: string;
  candidateRank?: number;
  candidateGroupSize?: number;
}

interface RuntimePhrase {
  romanized: string;
  unicode: string;
  domain?: string;
  confidence: number;
  quality: string;
  candidateRank?: number;
  candidateGroupSize?: number;
}

interface RuntimeName {
  romanized: string;
  unicode: string;
  subtype?: string;
  confidence: number;
  quality: string;
  candidateRank?: number;
  candidateGroupSize?: number;
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
  if (context ? isSecureContext(context) : false) return [];
  const normalized = normalizeRoman(input);
  if (normalized.length < 2) return [];
  const packIndexes = runtimePackIndexes();
  const rows = [
    ...matchingRows(packIndexes.phrases, normalized, 4, MAX_RUNTIME_CANDIDATES)
      .slice(0, MAX_RUNTIME_CANDIDATES)
      .map((match, index): Candidate => runtimeCandidate(match.row, "phrase", index, rangeEnd, match, "runtime pack", context)),
    ...matchingRows(packIndexes.words, normalized, 3, MAX_RUNTIME_CANDIDATES)
      .slice(0, MAX_RUNTIME_CANDIDATES)
      .map((match, index): Candidate => runtimeCandidate(match.row, "word", index, rangeEnd, match, "runtime pack", context)),
    ...matchingRows(packIndexes.names, normalized, 3, 3)
      .slice(0, 3)
      .map((match, index): Candidate => runtimeCandidate(match.row, "word", index, rangeEnd, match, "name index", context)),
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
  match: RuntimeMatch<RuntimeWord | RuntimePhrase | RuntimeName>,
  source = "runtime pack",
  context?: TypingContext
): Candidate {
  const confidence = row.confidence - match.penalty;
  const candidateRankReason = row.candidateGroupSize && row.candidateGroupSize > 1
    ? [`rank:${row.candidateRank ?? "?"}/${row.candidateGroupSize}`]
    : [];
  return {
    id: `runtime-${type}-${index}-${row.unicode}`,
    text: row.unicode,
    label: context?.showRomanizedLabels ? row.romanized : undefined,
    type,
    confidence: Math.max(0.55, Math.min(0.97, confidence)),
    reason: [`${source} ${pack.version}`, `quality:${row.quality}`, match.reason, ...candidateRankReason],
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

interface RuntimeMatch<T> {
  row: T;
  penalty: number;
  reason: string;
}

function buildPrefixIndex<T extends { romanized: string }>(rows: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    for (const key of bucketKeysForRow(row.romanized)) {
      index.set(key, [...(index.get(key) ?? []), row]);
    }
    for (const key of romanizedToleranceKeys(row.romanized)) {
      for (const bucket of bucketKeysForRow(key)) {
        index.set(bucket, [...(index.get(bucket) ?? []), row]);
      }
    }
  }
  return index;
}

function matchingRows<T extends { romanized: string }>(
  index: Map<string, T[]>,
  normalized: string,
  prefixMinLength: number,
  limit: number
): Array<RuntimeMatch<T>> {
  const buckets = new Set<string>([bucketKey(normalized)]);
  for (const key of romanizedToleranceKeys(normalized)) buckets.add(bucketKey(key));
  const seen = new Set<string>();
  const matches: Array<RuntimeMatch<T>> = [];
  for (const bucketName of buckets) {
    const bucket = index.get(bucketName) ?? [];
    for (const row of bucket) {
      const identity = `${row.romanized}\0${"unicode" in row ? String(row.unicode) : ""}`;
      if (seen.has(identity)) continue;
      const exact = row.romanized === normalized;
      const prefix = normalized.length >= prefixMinLength && row.romanized.startsWith(normalized);
      const tolerance = romanizedToleranceMatch(normalized, row.romanized);
      if (!exact && !prefix && !tolerance) continue;
      seen.add(identity);
      matches.push({
        row,
        penalty: exact ? 0 : prefix ? 0.22 : Math.max(0.08, 0.28 * (1 - (tolerance?.similarity ?? 0))),
        reason: exact ? "exact romanized match" : prefix ? "romanized prefix match" : tolerance?.reason ?? "romanization tolerance"
      });
      if (matches.length >= limit * 3) break;
    }
    if (matches.length >= limit * 3) break;
  }
  return matches.sort((left, right) =>
    left.penalty - right.penalty ||
    ("confidence" in right.row ? Number(right.row.confidence) : 0) - ("confidence" in left.row ? Number(left.row.confidence) : 0) ||
    romanizedCanonicalKey(left.row.romanized).localeCompare(romanizedCanonicalKey(right.row.romanized), "en")
  );
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
