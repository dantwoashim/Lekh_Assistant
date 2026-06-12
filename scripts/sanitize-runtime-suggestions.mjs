#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const DEFAULT_INPUT = join(ROOT, "src", "data", "keyboard-packs", "v0.1", "runtime-suggestions.json");
const DEFAULT_OUTPUT = join(ROOT, "release", "native", "macos", "runtime-suggestions.sanitized.json");
const DEFAULT_REPORT = join(ROOT, "reports", "runtime-suggestions-sanitizer-report.json");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const inputPath = args.get("input") ?? DEFAULT_INPUT;
const outputPath = args.get("output") ?? DEFAULT_OUTPUT;
const reportPath = args.get("report") ?? DEFAULT_REPORT;
const inPlace = args.has("in-place");

const startedAt = performance.now();
const pack = JSON.parse(readFileSync(inputPath, "utf8"));
const frequencyModel = loadFrequencyModel(ROOT);
const { sanitized, report } = sanitizeRuntimeSuggestionPack(pack, { frequencyModel });
const finalOutputPath = inPlace ? inputPath : outputPath;

mkdirSync(dirname(finalOutputPath), { recursive: true });
writeFileSync(finalOutputPath, JSON.stringify(sanitized));
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      command: "node scripts/sanitize-runtime-suggestions.mjs",
      suite: "runtime-suggestions-sanitizer",
      durationMs: Math.round(performance.now() - startedAt),
      input: relative(ROOT, inputPath),
      output: relative(ROOT, finalOutputPath),
      status: "passed",
      ...report
    },
    null,
    2
  )}\n`
);

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    JSON.stringify(
      {
        status: "passed",
        output: relative(ROOT, finalOutputPath),
        report: relative(ROOT, reportPath),
        counts: report.after,
        removed: report.removed
      },
      null,
      2
    )
  );
}

export function sanitizeRuntimeSuggestionPack(inputPack, options = {}) {
  const frequencyModel = options.frequencyModel ?? loadFrequencyModel(ROOT);
  const before = countsFor(inputPack);
  const removed = {
    duplicateRows: 0,
    badMappings: 0,
    proofreadValidWord: 0,
    proofreadPingPong: 0,
    proofreadChains: 0,
    disconnectedNextContexts: 0,
    mixedPreserveDemotions: 0
  };

  const words = normalizeRows(inputPack.words ?? [], "words", removed)
    .filter((row) => !isBlockedMapping(row, removed));
  const phrases = normalizeRows(inputPack.phrases ?? [], "phrases", removed)
    .filter((row) => !isBlockedMapping(row, removed));
  const names = normalizeRows(inputPack.names ?? [], "names", removed)
    .filter((row) => !isBlockedMapping(row, removed));

  const validUnicode = new Set();
  const validRomanTokens = new Set();
  for (const row of [...words, ...phrases, ...names]) {
    if (row.unicode) validUnicode.add(row.unicode);
    for (const token of normalizeRomanized(row.romanized).split(" ")) {
      if (token) validRomanTokens.add(token);
    }
  }

  const proofread = sanitizeProofread(inputPack.proofread ?? [], validUnicode, removed);
  const mixedPolicy = sanitizeMixedPolicy(inputPack.mixedPolicy ?? {}, removed);
  for (const token of [...mixedPolicy.preferenceTokens, ...mixedPolicy.preserveAlways]) {
    for (const part of normalizeRomanized(token).split(" ")) {
      if (part) validRomanTokens.add(part);
    }
  }

  const nextContexts = sanitizeNextContexts(inputPack.nextContexts ?? [], validRomanTokens, removed);

  const rankingContext = buildRankingContext([...words, ...phrases, ...names, ...proofread], frequencyModel);
  const sanitized = {
    version: inputPack.version ?? "keyboard-pack-v0.1",
    generatedAt: inputPack.generatedAt ?? new Date().toISOString(),
    words: withRankedConfidence(words, "words", rankingContext),
    phrases: withRankedConfidence(phrases, "phrases", rankingContext),
    proofread: withRankedConfidence(proofread, "proofread", rankingContext),
    names: withRankedConfidence(names, "names", rankingContext),
    nextContexts: withRankedConfidence(nextContexts, "nextContexts", rankingContext),
    mixedPolicy
  };

  return {
    sanitized,
    report: {
      before,
      after: countsFor(sanitized),
      removed,
      confidenceDiversity: {
        words: uniqueConfidenceCount(sanitized.words),
        phrases: uniqueConfidenceCount(sanitized.phrases),
        proofread: uniqueConfidenceCount(sanitized.proofread),
        names: uniqueConfidenceCount(sanitized.names),
        nextContexts: uniqueConfidenceCount(sanitized.nextContexts)
      },
      frequencyModel: {
        sources: frequencyModel.sources,
        bigramSources: frequencyModel.bigramSources,
        rowsLoaded: frequencyModel.rowsLoaded,
        bigramRowsLoaded: frequencyModel.bigramRowsLoaded,
        uniqueWords: frequencyModel.counts.size,
        uniqueBigrams: frequencyModel.bigrams.size,
        maxFrequency: frequencyModel.maxFrequency,
        maxBigramFrequency: frequencyModel.maxBigramFrequency,
        matchedRankedRows: rankingContext.matchedRows,
        unmatchedRankedRows: rankingContext.unmatchedRows
      }
    }
  };
}

function countsFor(pack) {
  return {
    words: Array.isArray(pack.words) ? pack.words.length : 0,
    phrases: Array.isArray(pack.phrases) ? pack.phrases.length : 0,
    proofread: Array.isArray(pack.proofread) ? pack.proofread.length : 0,
    names: Array.isArray(pack.names) ? pack.names.length : 0,
    nextContexts: Array.isArray(pack.nextContexts) ? pack.nextContexts.length : 0,
    preserveAlways: Array.isArray(pack.mixedPolicy?.preserveAlways) ? pack.mixedPolicy.preserveAlways.length : 0,
    preferenceTokens: Array.isArray(pack.mixedPolicy?.preferenceTokens) ? pack.mixedPolicy.preferenceTokens.length : 0
  };
}

function normalizeRows(rows, rowType, removed) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    if (typeof row?.romanized !== "string" || typeof row?.unicode !== "string") continue;
    const normalized = { ...row, romanized: normalizeRomanized(row.romanized), unicode: row.unicode.trim() };
    const key = `${rowType}\u0000${normalized.romanized}\u0000${normalized.unicode}`;
    if (seen.has(key)) {
      removed.duplicateRows += 1;
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function isBlockedMapping(row, removed) {
  const romanized = normalizeRomanized(row.romanized);
  const unicode = row.unicode.trim();
  const blocked =
    (romanized === "patiko" && unicode === "यतिको") ||
    (romanized.includes("patiko") && unicode.includes("यतिको"));
  if (blocked) removed.badMappings += 1;
  return blocked;
}

function sanitizeProofread(rows, validUnicode, removed) {
  const candidates = [];
  const pairSet = new Set();
  const errorSet = new Set();
  for (const row of rows) {
    if (typeof row?.error !== "string" || typeof row?.correction !== "string") continue;
    const error = row.error.trim();
    const correction = row.correction.trim();
    if (!error || !correction || error === correction) continue;
    const key = `${error}\u0000${correction}`;
    if (pairSet.has(key)) {
      removed.duplicateRows += 1;
      continue;
    }
    pairSet.add(key);
    errorSet.add(error);
    candidates.push({ ...row, error, correction });
  }

  return candidates.filter((row) => {
    if (validUnicode.has(row.error)) {
      removed.proofreadValidWord += 1;
      return false;
    }
    if (pairSet.has(`${row.correction}\u0000${row.error}`)) {
      removed.proofreadPingPong += 1;
      return false;
    }
    if (errorSet.has(row.correction)) {
      removed.proofreadChains += 1;
      return false;
    }
    return true;
  });
}

function sanitizeNextContexts(rows, validRomanTokens, removed) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    if (typeof row?.context !== "string" || typeof row?.next !== "string") continue;
    const context = normalizeRomanized(row.context);
    const next = normalizeRomanized(row.next);
    if (!context || !next) continue;
    if (!validRomanTokens.has(next)) {
      removed.disconnectedNextContexts += 1;
      continue;
    }
    const key = `${context}\u0000${next}`;
    if (seen.has(key)) {
      removed.duplicateRows += 1;
      continue;
    }
    seen.add(key);
    output.push({ ...row, context, next });
  }
  return output;
}

function sanitizeMixedPolicy(policy, removed) {
  const preserve = new Set();
  const preference = new Set();
  for (const token of [...(policy.preferenceTokens ?? [])]) {
    if (typeof token === "string" && token.trim()) preference.add(token.trim());
  }
  for (const token of [...(policy.preserveAlways ?? [])]) {
    if (typeof token !== "string" || !token.trim()) continue;
    const trimmed = token.trim();
    if (shouldDemotePreserveToken(trimmed)) {
      preference.add(trimmed);
      removed.mixedPreserveDemotions += 1;
    } else {
      preserve.add(trimmed);
    }
  }
  return {
    preserveAlways: [...preserve].sort(localeSort),
    preferenceTokens: [...preference].sort(localeSort)
  };
}

function shouldDemotePreserveToken(token) {
  const lower = token.toLowerCase();
  if (/[A-Z0-9]/.test(token) && token !== lower) return false;
  return new Set([
    "app",
    "browser",
    "call",
    "class",
    "database",
    "doctor",
    "download",
    "email",
    "file",
    "form",
    "grade",
    "hospital",
    "lab",
    "login",
    "meeting",
    "message",
    "online",
    "password",
    "photo",
    "prescription",
    "print",
    "printer",
    "record",
    "report",
    "result",
    "scan",
    "server",
    "submit",
    "system",
    "transcript",
    "upload",
    "username",
    "video",
    "website",
    "xray"
  ]).has(lower);
}

function withRankedConfidence(rows, type, rankingContext) {
  return rows
    .map((row, index) => ({
      ...row,
      confidence: rankedConfidence(row, type, index, rows.length, rankingContext)
    }))
    .sort((a, b) =>
      b.confidence - a.confidence ||
      rowFrequency(b, rankingContext) - rowFrequency(a, rankingContext) ||
      normalizeRomanized(a.romanized ?? a.context ?? "").localeCompare(normalizeRomanized(b.romanized ?? b.context ?? ""), "en") ||
      (a.unicode ?? a.correction ?? a.next ?? "").localeCompare(b.unicode ?? b.correction ?? b.next ?? "", "ne")
    );
}

function rankedConfidence(row, type, index, count, rankingContext) {
  const qualityBase = {
    gold: 0.96,
    silver: 0.82,
    synthetic: 0.66,
    common: 0.72
  };
  const typeOffset = {
    phrases: 0.02,
    words: 0,
    names: -0.02,
    proofread: -0.04,
    nextContexts: -0.08
  };
  const quality = String(row.quality ?? "").toLowerCase();
  const sourceConfidence = clampNumber(row.confidence ?? qualityBase[quality] ?? 0.72, 0.35, 0.99);
  const qualitySignal = qualityBase[quality] ?? sourceConfidence;
  const denominator = Math.max(1, count - 1);
  const tinyStableDecay = (index / denominator) * 0.012;
  const frequency = rowFrequency(row, rankingContext);
  const maxLogFrequency = type === "nextContexts"
    ? (rankingContext.maxLogBigramFrequency || rankingContext.maxLogFrequency)
    : rankingContext.maxLogFrequency;
  const frequencyNorm = frequency > 0 && maxLogFrequency > 0
    ? Math.log1p(frequency) / maxLogFrequency
    : 0;
  const ambiguity = romanizedAmbiguity(row, rankingContext);
  const pDevanagari = frequency > 0
    ? 0.25 + frequencyNorm * 0.75
    : 0.45 + sourceConfidence * 0.22;
  const pRomanGivenDevanagari = Math.max(0.35, 1 / Math.sqrt(ambiguity));
  const probabilisticRank = pDevanagari * pRomanGivenDevanagari;
  const qualityAdjustment = (qualitySignal - 0.72) * 0.12;
  const sourceAdjustment = (sourceConfidence - 0.72) * 0.08;
  const confidence =
    0.36 +
    probabilisticRank * 0.5 +
    qualityAdjustment +
    sourceAdjustment +
    (typeOffset[type] ?? 0) -
    tinyStableDecay;
  return Number(clampNumber(confidence, 0.42, 0.99).toFixed(3));
}

function uniqueConfidenceCount(rows) {
  return new Set(rows.map((row) => row.confidence)).size;
}

function loadFrequencyModel(root) {
  const candidates = [
    {
      id: "lekh-generated-frequency-model",
      path: join(root, "data", "generated", "frequency", "lekh-unigram-frequency.tsv")
    },
    {
      id: "nepali-wikipedia-frequency",
      path: join(root, "data", "generated", "frequency", "nepali-wikipedia-frequency.tsv")
    },
    {
      id: "dictionary-ne-ranked-frequency",
      path: join(root, "data", "generated", "wordlists", "dictionary-ne-ranked.tsv")
    }
  ];
  const bigramCandidates = [
    {
      id: "lekh-generated-bigram-frequency-model",
      path: join(root, "data", "generated", "frequency", "lekh-bigram-frequency.tsv")
    }
  ];
  const counts = new Map();
  const bigrams = new Map();
  const sources = [];
  const bigramSources = [];
  let rowsLoaded = 0;
  let bigramRowsLoaded = 0;
  let maxFrequency = 0;
  let maxBigramFrequency = 0;

  for (const source of candidates) {
    let text;
    try {
      text = readFileSync(source.path, "utf8");
    } catch {
      sources.push({ id: source.id, path: relative(root, source.path), status: "missing", rows: 0 });
      continue;
    }
    const rows = parseFrequencyTsv(text, source.id);
    for (const row of rows) {
      const current = counts.get(row.word) ?? 0;
      const next = Math.max(current, row.frequency);
      counts.set(row.word, next);
      maxFrequency = Math.max(maxFrequency, next);
    }
    rowsLoaded += rows.length;
    sources.push({ id: source.id, path: relative(root, source.path), status: "loaded", rows: rows.length });
  }

  for (const source of bigramCandidates) {
    let text;
    try {
      text = readFileSync(source.path, "utf8");
    } catch {
      bigramSources.push({ id: source.id, path: relative(root, source.path), status: "missing", rows: 0 });
      continue;
    }
    const rows = parseFrequencyTsv(text, source.id, "bigram");
    for (const row of rows) {
      const current = bigrams.get(row.word) ?? 0;
      const next = Math.max(current, row.frequency);
      bigrams.set(row.word, next);
      maxBigramFrequency = Math.max(maxBigramFrequency, next);
    }
    bigramRowsLoaded += rows.length;
    bigramSources.push({ id: source.id, path: relative(root, source.path), status: "loaded", rows: rows.length });
  }

  return { counts, bigrams, sources, bigramSources, rowsLoaded, bigramRowsLoaded, maxFrequency, maxBigramFrequency };
}

function parseFrequencyTsv(text, sourceId, keyName = "word") {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  const wordIndex = header.indexOf(keyName);
  const frequencyIndexes = [
    header.indexOf("wikipediaFrequency"),
    header.indexOf("frequency"),
    header.indexOf("count")
  ].filter((index) => index >= 0);
  if (wordIndex < 0 || frequencyIndexes.length === 0) return [];

  const rows = [];
  for (const line of lines.slice(1)) {
    const columns = line.split("\t");
    const word = columns[wordIndex]?.trim();
    if (!word || !/[\u0900-\u097F]/.test(word)) continue;
    const frequency = Math.max(
      ...frequencyIndexes.map((index) => Number(columns[index] ?? 0)).filter((value) => Number.isFinite(value))
    );
    if (!Number.isFinite(frequency) || frequency <= 0) continue;
    rows.push({ word, frequency, sourceId });
  }
  return rows;
}

function buildRankingContext(rows, frequencyModel) {
  const romanizedToUnicode = new Map();
  const romanizedToTopUnicode = new Map();
  let matchedRows = 0;
  let unmatchedRows = 0;
  let maxLogFrequency = 0;
  let maxLogBigramFrequency = Math.log1p(frequencyModel.maxBigramFrequency ?? 0);

  for (const row of rows) {
    const romanized = normalizeRomanized(row.romanized ?? "");
    const unicode = row.unicode ?? row.correction ?? "";
    if (romanized && unicode) {
      const set = romanizedToUnicode.get(romanized) ?? new Set();
      set.add(unicode);
      romanizedToUnicode.set(romanized, set);
      const frequency = frequencyForUnicode(unicode, frequencyModel);
      const existing = romanizedToTopUnicode.get(romanized);
      if (!existing || frequency > existing.frequency) {
        romanizedToTopUnicode.set(romanized, { unicode, frequency });
      }
    }
    const frequency = frequencyForUnicode(unicode, frequencyModel);
    if (frequency > 0) matchedRows += 1;
    else unmatchedRows += 1;
    maxLogFrequency = Math.max(maxLogFrequency, Math.log1p(frequency));
  }

  return {
    frequencyModel,
    romanizedToUnicode,
    romanizedToTopUnicode,
    matchedRows,
    unmatchedRows,
    maxLogFrequency,
    maxLogBigramFrequency
  };
}

function rowFrequency(row, rankingContext) {
  if (typeof row.context === "string" && typeof row.next === "string") {
    return nextContextFrequency(row, rankingContext);
  }
  return frequencyForUnicode(row.unicode ?? row.correction ?? row.next ?? "", rankingContext.frequencyModel);
}

function nextContextFrequency(row, rankingContext) {
  const contextTokens = normalizeRomanized(row.context).split(" ").filter(Boolean);
  const previousRoman = contextTokens.at(-1);
  const nextRoman = normalizeRomanized(row.next);
  const previousUnicode = previousRoman ? rankingContext.romanizedToTopUnicode.get(previousRoman)?.unicode : undefined;
  const nextUnicode = rankingContext.romanizedToTopUnicode.get(nextRoman)?.unicode;
  if (previousUnicode && nextUnicode) {
    const bigramFrequency = rankingContext.frequencyModel.bigrams.get(`${previousUnicode} ${nextUnicode}`) ?? 0;
    if (bigramFrequency > 0) return bigramFrequency;
  }
  if (nextUnicode) return frequencyForUnicode(nextUnicode, rankingContext.frequencyModel);
  return 0;
}

function frequencyForUnicode(value, frequencyModel) {
  if (!value || !frequencyModel?.counts) return 0;
  const direct = frequencyModel.counts.get(value);
  if (direct) return direct;
  let total = 0;
  for (const token of String(value).split(/[\s।,;:!?()]+/)) {
    if (!token) continue;
    total += frequencyModel.counts.get(token) ?? 0;
  }
  return total;
}

function romanizedAmbiguity(row, rankingContext) {
  const romanized = normalizeRomanized(row.romanized ?? "");
  if (!romanized) return 1;
  return Math.max(1, rankingContext.romanizedToUnicode.get(romanized)?.size ?? 1);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRomanized(value) {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

function localeSort(a, b) {
  return a.localeCompare(b, "en");
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== thisFile) {
  // Imported by package scripts.
}
