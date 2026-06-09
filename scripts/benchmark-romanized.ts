import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSpellHintsWithHunspell } from "../src/core/dictionary/spellHints";
import { suggestWords } from "../src/core/dictionary/suggestWords";
import { normalizeNepaliText } from "../src/core/normalize/normalizeNepaliText";
import { transliterateRomanized, type TransliterateOptions } from "../src/core/transliteration/transliterateRomanized";
import { classifyRomanizedFailure, summarizeFailures, type BenchmarkFailure, type FailureSeverity, type FailureSummary } from "./lib/benchmarkTaxonomy";
import { assertNonEmptySuite, isDirectCli } from "./lib/cli";

interface RomanizedCase {
  category: string;
  input: string;
  expected: string;
  expectedOutput?: string;
  expected_top1?: string;
  expectedCandidates?: string[];
  acceptable_candidates?: string[];
  type?: string;
  source?: string;
  id?: string;
  severity?: FailureSeverity;
  mode?: string;
  expectedAction?: "auto" | "candidates" | "warn" | "preserve" | "refuse";
}

interface BucketStats {
  fixtureCount: number;
  top1: number;
  top3: number;
  top5: number;
  mrr: number;
}

export interface RomanizedBenchmarkReport {
  generatedAt: string;
  command: string;
  suite: string;
  mode: "smoke" | "full";
  durationMs: number;
  fixtureCount: number;
  byType: Record<string, BucketStats>;
  top1: number;
  top3: number;
  top5: number;
  meanReciprocalRank: number;
  phraseAccuracy: number;
  nameAccuracy: number;
  mixedEnglishCorruptionRate: number;
  oovRecoveryRate: number;
  suggestionHitAt5: number;
  hardHostile?: BucketStats;
  topFailureCategories: FailureSummary[];
  remainingFailures: BenchmarkFailure[];
}

const root = process.cwd();
const reportPath = join(root, "bench/reports/romanized-report.json");
const caseTimeoutMs = Number(process.env.LEKH_BENCHMARK_CASE_TIMEOUT_MS ?? 5000);
const progressEvery = Number(process.env.LEKH_BENCHMARK_PROGRESS_EVERY ?? (process.env.LEKH_BENCHMARK_SMOKE === "1" ? 0 : 1000));

export async function runRomanizedBenchmark(): Promise<RomanizedBenchmarkReport> {
  const start = Date.now();
  const cases = loadRomanizedCases();
  assertNonEmptySuite("romanized", cases.length);
  const failures: RomanizedBenchmarkReport["remainingFailures"] = [];
  const buckets = new Map<string, { total: number; top1: number; top3: number; top5: number; rr: number }>();
  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let rr = 0;
  let phraseTotal = 0;
  let phraseHit = 0;
  let nameTotal = 0;
  let nameHit = 0;
  let mixedTotal = 0;
  let mixedCorrupt = 0;
  let oovTotal = 0;
  let oovRecovered = 0;
  let suggestionChecks = 0;
  let suggestionHits = 0;

  for (const [caseIndex, item] of cases.entries()) {
    if (progressEvery > 0 && caseIndex > 0 && caseIndex % progressEvery === 0) {
      process.stderr.write(`[romanized] processed ${caseIndex}/${cases.length} fixtures\n`);
    }
    const caseStart = Date.now();
    const result = transliterateRomanized(item.input, "common-nepali", optionsForCase(item));
    const caseDurationMs = Date.now() - caseStart;
    if (caseDurationMs > caseTimeoutMs) {
      throw new Error(`Romanized fixture exceeded ${caseTimeoutMs}ms: ${item.id ?? item.input} took ${caseDurationMs}ms`);
    }
    const expected = normalizeNepaliText(item.expected_top1 ?? item.expectedOutput ?? item.expected);
    const acceptable = [
      expected,
      ...(item.acceptable_candidates ?? item.expectedCandidates ?? []).map((candidate) => normalizeNepaliText(candidate))
    ];
    const actual = result.normalizedOutput;
    const rank = result.candidates.findIndex((candidate) => acceptable.includes(candidate.normalizedText)) + 1;
    const type = item.type ?? "generated";
    const bucket = buckets.get(type) ?? { total: 0, top1: 0, top3: 0, top5: 0, rr: 0 };

    bucket.total += 1;
    if (actual === expected) {
      top1 += 1;
      bucket.top1 += 1;
    } else {
      failures.push(classifyRomanizedFailure(
        { ...item, id: item.id ?? item.input, type },
        expected,
        actual,
        rank,
        result.candidates.slice(0, 5).map((candidate) => candidate.normalizedText)
      ));
    }
    if (rank > 0 && rank <= 3) {
      top3 += 1;
      bucket.top3 += 1;
    }
    if (rank > 0 && rank <= 5) {
      top5 += 1;
      bucket.top5 += 1;
    }
    if (rank > 0) {
      rr += 1 / rank;
      bucket.rr += 1 / rank;
    }

    if (/phrase|postposition|government|office|legal|education/.test(item.category)) {
      phraseTotal += 1;
      if (actual === expected) phraseHit += 1;
    }
    if (/name|names/.test(item.category)) {
      nameTotal += 1;
      if (actual === expected) nameHit += 1;
    }
    if (isMixedEnglishCase(item)) {
      mixedTotal += 1;
      if (!preservesEnglishTokens(item.input, actual)) mixedCorrupt += 1;
    }
    if (item.type === "manual" && result.trace.some((trace) => trace.rule === "preserve-unknown")) {
      oovTotal += 1;
      if (rank > 0 && rank <= 5) oovRecovered += 1;
    }
    if (/^[A-Za-z]+$/.test(item.input)) {
      suggestionChecks += 1;
      if (suggestWords(item.input, 5).some((suggestion) => suggestion.normalizedWord === expected)) suggestionHits += 1;
    }

    buckets.set(type, bucket);
  }

  await getSpellHintsWithHunspell("नेपाल सरकार झझझझ");

  return {
    generatedAt: new Date().toISOString(),
    command: process.env.LEKH_BENCHMARK_SMOKE === "1" ? "npm run benchmark:romanized:smoke" : "npm run benchmark:romanized",
    suite: "romanized",
    mode: process.env.LEKH_BENCHMARK_SMOKE === "1" ? "smoke" : "full",
    durationMs: Date.now() - start,
    fixtureCount: cases.length,
    byType: Object.fromEntries(
      Array.from(buckets.entries()).map(([type, bucket]) => [
        type,
        {
          fixtureCount: bucket.total,
          top1: bucket.top1 / bucket.total,
          top3: bucket.top3 / bucket.total,
          top5: bucket.top5 / bucket.total,
          mrr: bucket.rr / bucket.total
        }
      ])
    ),
    top1: top1 / cases.length,
    top3: top3 / cases.length,
    top5: top5 / cases.length,
    meanReciprocalRank: rr / cases.length,
    phraseAccuracy: phraseTotal === 0 ? 1 : phraseHit / phraseTotal,
    nameAccuracy: nameTotal === 0 ? 1 : nameHit / nameTotal,
    mixedEnglishCorruptionRate: mixedTotal === 0 ? 0 : mixedCorrupt / mixedTotal,
    oovRecoveryRate: oovTotal === 0 ? 1 : oovRecovered / oovTotal,
    suggestionHitAt5: suggestionChecks === 0 ? 1 : suggestionHits / suggestionChecks,
    hardHostile: bucketStats(buckets.get("hostile-heldout")),
    topFailureCategories: summarizeFailures(failures),
    remainingFailures: failures
  };
}

function loadRomanizedCases(): RomanizedCase[] {
  const generated = JSON.parse(readFileSync(join(root, "src/data/fixtures/romanized-fixtures.json"), "utf8")) as RomanizedCase[];
  const manual = JSON.parse(readFileSync(join(root, "benchmarks/romanized/manual-high-value.json"), "utf8")) as RomanizedCase[];
  const heldOut = JSON.parse(readFileSync(join(root, "benchmarks/romanized/held-out.json"), "utf8")) as RomanizedCase[];
  const hostile = readOptionalCases(join(root, "benchmarks/romanized/hostile-manual-v1.json"));
  const hardHostile = readOptionalJsonlCases(join(root, "bench/fixtures/romanized/hostile-heldout/hard-long-prose.jsonl"));
  const adminMixedRegression = readOptionalCases(join(root, "benchmarks/romanized/admin-mixed/admin-mixed-regression.json"));
  const competitorPath = join(root, "benchmarks/romanized/competitor/romanized_competitor_probe_v1.json");
  const competitor = readOptionalCases(competitorPath).length > 0
    ? readOptionalCases(competitorPath)
    : JSON.parse(readFileSync(join(root, "benchmarks/romanized/competitor-probes.json"), "utf8")) as RomanizedCase[];
  const userSubmitted = JSON.parse(readFileSync(join(root, "benchmarks/romanized/user-submitted.json"), "utf8")) as RomanizedCase[];
  const cases = [
    ...generated.map((item) => ({ ...item, type: "generated" })),
    ...manual,
    ...heldOut,
    ...hostile,
    ...hardHostile,
    ...adminMixedRegression,
    ...competitor,
    ...userSubmitted
  ];
  if (process.env.LEKH_BENCHMARK_SMOKE === "1") {
    return [
      ...generated.slice(0, 400).map((item) => ({ ...item, type: "generated" })),
      ...manual.slice(0, 120),
      ...heldOut.slice(0, 40),
      ...hostile.slice(0, 120),
      ...hardHostile,
      ...adminMixedRegression.slice(0, 80),
      ...competitor.slice(0, 40),
      ...userSubmitted.slice(0, 40)
    ];
  }
  return cases;
}

function optionsForCase(item: RomanizedCase): TransliterateOptions {
  if (item.mode === "romanized-prose") {
    return { digitPolicy: "convert-devanagari" };
  }
  if (item.mode === "romanized-government" || item.mode === "romanized-legal" || item.mode === "romanized-education") {
    return { digitPolicy: "convert-devanagari" };
  }
  return {};
}

function bucketStats(bucket: { total: number; top1: number; top3: number; top5: number; rr: number } | undefined): BucketStats | undefined {
  if (!bucket || bucket.total === 0) return undefined;
  return {
    fixtureCount: bucket.total,
    top1: bucket.top1 / bucket.total,
    top3: bucket.top3 / bucket.total,
    top5: bucket.top5 / bucket.total,
    mrr: bucket.rr / bucket.total
  };
}

function preservesEnglishTokens(input: string, output: string): boolean {
  const tokens = input.match(/\b(?:[A-Z]{2,}|X-ray|x-ray|PDF|NID|URL|Excel|Word|file|form|field|desk|result|mismatch|report|office|system|data|copy|link|upload|row|draft|final|slow|branch|campus|card|meeting|update|check|table|voucher|bank|address|old|online|payment|budget|screenshot|clear|browser|cache|school|parent|match|ward|library|barcode|class|group|case|entry|urgent|submit|verify|name|SMS)\b/g) ?? [];
  return tokens.every((token) => output.includes(token));
}

function isMixedEnglishCase(item: RomanizedCase): boolean {
  if (/mixed/i.test(item.category)) return true;
  if (/[A-Z]{2,}|X-ray|x-ray|https?:\/\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(item.input)) return true;
  const wordCount = (item.input.match(/[A-Za-z]+/g) ?? []).length;
  return wordCount > 1 && /\b(?:file|form|field|desk|result|mismatch|report|office|system|data|copy|link|upload|row|draft|final|slow|branch|campus|card|meeting|update|check|table|voucher|bank|address|old|online|payment|budget|screenshot|clear|browser|cache|school|parent|match|ward|library|barcode|class|group|case|entry|urgent|submit|verify|name|SMS)\b/i.test(item.input);
}

function readOptionalCases(path: string): RomanizedCase[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RomanizedCase[];
  } catch {
    return [];
  }
}

function readOptionalJsonlCases(path: string): RomanizedCase[] {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RomanizedCase);
  } catch {
    return [];
  }
}

if (isDirectCli(import.meta.url)) {
  const report = await runRomanizedBenchmark();
  console.log(JSON.stringify(report, null, 2));
  mkdirSync(join(root, "bench/reports"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    join(root, "reports/romanized-failures.jsonl"),
    report.remainingFailures.map((failure) => JSON.stringify(failure)).join("\n") + (report.remainingFailures.length > 0 ? "\n" : "")
  );
  if (process.argv.includes("--write")) {
    writeFileSync(join(root, "reports/romanized-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}
