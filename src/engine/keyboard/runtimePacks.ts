import runtimePack from "../../data/keyboard-packs/v0.1/runtime-suggestions.json";
import predictionModel from "../../data/keyboard-packs/v0.1/prediction-model.json";
import { convertRomanized } from "../romanized";
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

interface RuntimeContext {
  context: string;
  next: string;
  confidence: number;
  quality: string;
}

interface PredictionContextRow {
  c: string;
  n: string;
  f: number;
  q: string;
}

interface PredictionPrefixRow {
  p: string;
  m: string;
  u?: string;
  t?: string;
  f: number;
  q: string;
}

interface RuntimePack {
  version: string;
  generatedAt: string;
  words: RuntimeWord[];
  phrases: RuntimePhrase[];
  nextContexts?: RuntimeContext[];
  names: RuntimeName[];
  mixedPolicy: {
    preserveAlways: string[];
    preferenceTokens: string[];
  };
}

const pack = runtimePack as RuntimePack;
const trainedPredictionModel = predictionModel as {
  version: string;
  trainedAt: string;
  checksum: string;
  contextPredictions: PredictionContextRow[];
  prefixPredictions: PredictionPrefixRow[];
};
const MAX_RUNTIME_CANDIDATES = 6;
const PREFIX_BUCKET_LENGTH = 3;

interface RuntimePackIndexes {
  words: Map<string, RuntimeWord[]>;
  phrases: Map<string, RuntimePhrase[]>;
  names: Map<string, RuntimeName[]>;
  contexts: Map<string, RuntimeContext[]>;
  trainedContexts: Map<string, PredictionContextRow[]>;
  trainedPrefixes: Map<string, PredictionPrefixRow[]>;
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
    ...trainedPredictionCandidates(normalized, context, rangeEnd),
    ...runtimeContextPredictionCandidates(normalized, context, rangeEnd),
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
      names: buildPrefixIndex(pack.names),
      contexts: buildContextIndex(pack.nextContexts ?? []),
      trainedContexts: buildTrainedContextIndex(trainedPredictionModel.contextPredictions),
      trainedPrefixes: buildTrainedPrefixIndex(trainedPredictionModel.prefixPredictions)
    };
  }
  return indexes;
}

function trainedPredictionCandidates(normalizedInput: string, context?: TypingContext, rangeEnd = normalizedInput.length): Candidate[] {
  return [
    ...trainedContextCandidates(normalizedInput, context, rangeEnd),
    ...trainedPrefixCandidates(normalizedInput, context, rangeEnd),
  ].slice(0, MAX_RUNTIME_CANDIDATES);
}

function trainedContextCandidates(normalizedInput: string, context?: TypingContext, rangeEnd = normalizedInput.length): Candidate[] {
  if (!context || normalizedInput.length < 2) return [];
  const tokens = normalizedInput.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const nextPrefix = tokens[tokens.length - 1] ?? "";
  if (nextPrefix.length < 1) return [];
  const activeContextTokens = tokens.slice(0, -1);
  const leftTokens = [
    ...normalizeRoman(context.leftTextWindow ?? "").split(" ").filter(Boolean),
    ...activeContextTokens
  ].slice(-8);
  if (leftTokens.length === 0) return [];

  const matches: Array<{ row: PredictionContextRow; contextLength: number }> = [];
  const trainedContexts = runtimePackIndexes().trainedContexts;
  for (const suffix of contextSuffixes(leftTokens)) {
    const bucket = trainedContexts.get(suffix) ?? [];
    for (const row of bucket) {
      if (!row.n.startsWith(nextPrefix)) continue;
      if (row.n === nextPrefix) continue;
      matches.push({ row, contextLength: suffix.split(" ").length });
      if (matches.length >= MAX_RUNTIME_CANDIDATES * 2) break;
    }
    if (matches.length >= MAX_RUNTIME_CANDIDATES * 2) break;
  }

  return matches
    .sort((a, b) => b.contextLength - a.contextLength || trainedConfidence(b.row) - trainedConfidence(a.row) || a.row.n.localeCompare(b.row.n))
    .slice(0, MAX_RUNTIME_CANDIDATES)
    .map(({ row, contextLength }, index): Candidate => {
      const romanized = [...activeContextTokens, row.n].join(" ");
      const unicode = predictionUnicode(romanized);
      return {
        id: `trained-context-${index}-${romanized}`,
        text: unicode,
        label: context.showRomanizedLabels ? romanized : undefined,
        type: romanized.includes(" ") ? "phrase" : "completion",
        confidence: Math.min(0.9, trainedConfidence(row) + contextLength * 0.02 + nextPrefix.length * 0.006),
        reason: [`trained prediction model ${trainedPredictionModel.version}`, `quality:${row.q}`, `${contextLength}-gram aggregate context`],
        replaceRange: [0, rangeEnd],
      };
    });
}

function trainedPrefixCandidates(normalizedInput: string, context?: TypingContext, rangeEnd = normalizedInput.length): Candidate[] {
  if (normalizedInput.length < 2) return [];
  const bucket = runtimePackIndexes().trainedPrefixes.get(normalizedInput) ?? [];
  return bucket
    .filter((row) => row.m !== normalizedInput && row.m.startsWith(normalizedInput))
    .slice(0, MAX_RUNTIME_CANDIDATES)
    .map((row, index): Candidate => {
      const text = row.u || predictionUnicode(row.m);
      return {
        id: `trained-prefix-${index}-${row.m}`,
        text,
        label: context?.showRomanizedLabels ? row.m : undefined,
        type: row.t === "phrase" ? "phrase" : "completion",
        confidence: Math.min(row.q === "gold" || row.q === "silver" ? 0.86 : 0.74, trainedConfidence(row)),
        reason: [`trained prefix model ${trainedPredictionModel.version}`, `quality:${row.q}`],
        replaceRange: [0, rangeEnd],
      };
    });
}

function trainedConfidence(row: PredictionContextRow | PredictionPrefixRow): number {
  const qualityCap = row.q === "gold" ? 0.96 : row.q === "silver" ? 0.9 : row.q === "bronze" ? 0.82 : 0.68;
  return Math.max(0.52, Math.min(qualityCap, row.f));
}

function runtimeContextPredictionCandidates(normalizedInput: string, context?: TypingContext, rangeEnd = normalizedInput.length): Candidate[] {
  if (!context || !normalizedInput || normalizedInput.length < 2) return [];
  const tokens = normalizedInput.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const nextPrefix = tokens[tokens.length - 1] ?? "";
  if (nextPrefix.length < 1) return [];

  const activeContextTokens = tokens.slice(0, -1);
  const leftTokens = [
    ...normalizeRoman(context.leftTextWindow ?? "").split(" ").filter(Boolean),
    ...activeContextTokens
  ].slice(-8);
  if (leftTokens.length === 0) return [];

  const packIndexes = runtimePackIndexes();
  const matches: Array<{ row: RuntimeContext; contextLength: number }> = [];
  for (const suffix of contextSuffixes(leftTokens)) {
    const bucket = packIndexes.contexts.get(suffix) ?? [];
    for (const row of bucket) {
      if (!row.next.startsWith(nextPrefix)) continue;
      if (row.next === nextPrefix) continue;
      matches.push({ row, contextLength: suffix.split(" ").length });
      if (matches.length >= MAX_RUNTIME_CANDIDATES * 3) break;
    }
    if (matches.length >= MAX_RUNTIME_CANDIDATES * 3) break;
  }

  return matches
    .sort((a, b) =>
      b.contextLength - a.contextLength ||
      b.row.confidence - a.row.confidence ||
      a.row.next.localeCompare(b.row.next)
    )
    .slice(0, MAX_RUNTIME_CANDIDATES)
    .map(({ row, contextLength }, index): Candidate => {
      const romanized = [...activeContextTokens, row.next].join(" ");
      const unicode = predictionUnicode(romanized);
      const confidence = Math.min(runtimeContextConfidenceCap(row.quality), Math.max(0.68, row.confidence + 0.1 + contextLength * 0.025 + nextPrefix.length * 0.008));
      return {
        id: `runtime-context-${index}-${romanized}`,
        text: unicode,
        label: context.showRomanizedLabels ? romanized : undefined,
        type: romanized.includes(" ") ? "phrase" : "completion",
        confidence,
        reason: [`next-context pack ${pack.version}`, `quality:${row.quality}`, `${contextLength}-gram context`],
        replaceRange: [0, rangeEnd],
      };
    });
}

function predictionUnicode(romanized: string): string {
  return convertRomanized(normalizePredictionRomanized(romanized), {
    mode: "romanized-mixed",
    digitPolicy: "context-dependent"
  }).normalizedOutput;
}

function normalizePredictionRomanized(romanized: string): string {
  const tokenMap: Record<string, string> = {
    xa: "chha",
    xaina: "chhaina",
    xan: "chhan",
    xu: "chhu",
    xau: "chhau",
    xas: "chhas",
    hunxa: "huncha",
    parxa: "parcha",
    garxa: "garcha",
    garxu: "garchu",
    garyeu: "garyau",
    vayo: "bhayo",
    voli: "bholi",
    paxi: "pachi",
  };
  return romanized
    .split(" ")
    .map((token) => tokenMap[token] ?? token)
    .join(" ");
}

function runtimeContextConfidenceCap(quality: string): number {
  if (quality === "gold") return 0.94;
  if (quality === "silver") return 0.82;
  if (quality === "bronze") return 0.76;
  return 0.68;
}

function buildContextIndex(rows: RuntimeContext[]): Map<string, RuntimeContext[]> {
  const index = new Map<string, RuntimeContext[]>();
  for (const row of rows) {
    const key = normalizeRoman(row.context);
    if (!key || !row.next) continue;
    index.set(key, [...(index.get(key) ?? []), { ...row, context: key, next: normalizeRoman(row.next) }]);
  }
  return index;
}

function buildTrainedContextIndex(rows: PredictionContextRow[]): Map<string, PredictionContextRow[]> {
  const index = new Map<string, PredictionContextRow[]>();
  for (const row of rows) {
    const key = normalizeRoman(row.c);
    if (!key || !row.n) continue;
    index.set(key, [...(index.get(key) ?? []), { ...row, c: key, n: normalizeRoman(row.n) }]);
  }
  for (const [key, bucket] of index.entries()) {
    index.set(key, bucket.sort((a, b) => trainedConfidence(b) - trainedConfidence(a) || a.n.localeCompare(b.n)).slice(0, MAX_RUNTIME_CANDIDATES * 16));
  }
  return index;
}

function buildTrainedPrefixIndex(rows: PredictionPrefixRow[]): Map<string, PredictionPrefixRow[]> {
  const index = new Map<string, PredictionPrefixRow[]>();
  for (const row of rows) {
    const key = normalizeRoman(row.p);
    if (!key || !row.m) continue;
    index.set(key, [...(index.get(key) ?? []), { ...row, p: key, m: normalizeRoman(row.m) }]);
  }
  for (const [key, bucket] of index.entries()) {
    index.set(key, bucket.sort((a, b) => trainedConfidence(b) - trainedConfidence(a) || a.m.localeCompare(b.m)).slice(0, MAX_RUNTIME_CANDIDATES * 3));
  }
  return index;
}

function contextSuffixes(tokens: string[]): string[] {
  const suffixes: string[] = [];
  for (let length = Math.min(4, tokens.length); length >= 1; length -= 1) {
    suffixes.push(tokens.slice(-length).join(" "));
  }
  return suffixes;
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
