import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertPreetiToUnicode } from "../src/core/preeti/convertPreetiToUnicode";
import { normalizeNepaliText } from "../src/core/normalize/normalizeNepaliText";
import { classifyPreetiFailure, summarizeFailures, type BenchmarkFailure, type FailureSeverity, type FailureSummary } from "./lib/benchmarkTaxonomy";
import { assertNonEmptySuite, isDirectCli } from "./lib/cli";
import { runPreetiSourceAudit } from "./audit-preeti-source-fixtures";
import { runPreetiFuzzBenchmark } from "./benchmark-preeti-fuzz";
import { runPreetiRoundtripBenchmark } from "./benchmark-preeti-roundtrip";

interface PreetiCase {
  name?: string;
  id?: string;
  type?: string;
  category: string;
  input: string;
  expected: string;
  source: string;
  severity?: FailureSeverity;
}

interface BucketStats {
  fixtureCount: number;
  exactMatchRate: number;
  characterErrorRate: number;
  wordErrorRate: number;
}

export interface PreetiBenchmarkReport {
  generatedAt: string;
  fixtureCount: number;
  byType: Record<string, BucketStats>;
  exactMatchRate: number;
  characterErrorRate: number;
  wordErrorRate: number;
  matraErrorCount: number;
  rephErrorCount: number;
  englishPreservationRate: number;
  lineBreakPreservationRate: number;
  warningQuality: {
    totalWarnings: number;
    uncertainMappingWarnings: number;
    unknownGlyphWarnings: number;
    preservedEnglishWarnings: number;
  };
  decoderSuites: {
    sourceAudit: {
      fixtureCount: number;
      includeInConversionBenchmarkCount: number;
      converterBugCount: number;
      sourceTypoOrAmbiguousCount: number;
      expectedOutputBugCount: number;
    };
    fuzz: {
      fixtureCount: number;
      legalExactRate: number;
      illegalUnsafeOrWarnRate: number;
      failureCount: number;
    };
    roundtrip: {
      fixtureCount: number;
      exactRate: number;
      failureCount: number;
    };
  };
  topFailureCategories: FailureSummary[];
  remainingFailures: BenchmarkFailure[];
}

const root = process.cwd();

export function runPreetiBenchmark(): PreetiBenchmarkReport {
  const cases = loadPreetiCases();
  assertNonEmptySuite("preeti", cases.length);
  const failures: PreetiBenchmarkReport["remainingFailures"] = [];
  const buckets = new Map<string, { total: number; exact: number; charDistance: number; chars: number; wordDistance: number; words: number }>();
  let exact = 0;
  let charDistance = 0;
  let charTotal = 0;
  let wordDistance = 0;
  let wordTotal = 0;
  let matraErrors = 0;
  let rephErrors = 0;
  let englishCases = 0;
  let englishPreserved = 0;
  let lineCases = 0;
  let linePreserved = 0;
  let totalWarnings = 0;
  let uncertainMappingWarnings = 0;
  let unknownGlyphWarnings = 0;
  let preservedEnglishWarnings = 0;

  for (const item of cases) {
    const result = convertPreetiToUnicode(item.input);
    const actual = result.normalizedOutput;
    const expected = normalizeNepaliText(item.expected);
    const type = item.type ?? inferFixtureType(item);
    const bucket = buckets.get(type) ?? { total: 0, exact: 0, charDistance: 0, chars: 0, wordDistance: 0, words: 0 };
    const chars = expected.length;
    const cDistance = levenshtein(actual, expected);
    const expectedWords = tokenize(expected);
    const wDistance = levenshteinArray(tokenize(actual), expectedWords);

    bucket.total += 1;
    bucket.charDistance += cDistance;
    bucket.chars += chars;
    bucket.wordDistance += wDistance;
    bucket.words += expectedWords.length;
    charDistance += cDistance;
    charTotal += chars;
    wordDistance += wDistance;
    wordTotal += expectedWords.length;
    totalWarnings += result.warnings.length;
    uncertainMappingWarnings += result.warnings.filter((warning) => warning.code === "UNCERTAIN_PREETI_MAPPING").length;
    unknownGlyphWarnings += result.warnings.filter((warning) => warning.code === "UNKNOWN_PREETI_CHAR").length;
    preservedEnglishWarnings += result.warnings.filter((warning) => warning.code === "PRESERVED_ENGLISH_TOKEN").length;

    if (actual === expected) {
      exact += 1;
      bucket.exact += 1;
    } else {
      if (/[िीुूेैोौ]/.test(expected + actual)) matraErrors += 1;
      if (/र्/.test(expected + actual)) rephErrors += 1;
      failures.push(classifyPreetiFailure({ ...item, id: item.id ?? item.name ?? item.input, type }, expected, actual));
    }

    const expectedEnglish = expected.match(/[A-Za-z][A-Za-z0-9.-]*/g) ?? [];
    if (expectedEnglish.length > 0) {
      englishCases += 1;
      if (expectedEnglish.every((token) => actual.includes(token))) englishPreserved += 1;
    }

    if (expected.includes("\n") || item.input.includes("\n")) {
      lineCases += 1;
      if (newlineCount(actual) === newlineCount(expected)) linePreserved += 1;
    }

    buckets.set(type, bucket);
  }

  const sourceAudit = runPreetiSourceAudit();
  const fuzz = runPreetiFuzzBenchmark();
  const roundtrip = runPreetiRoundtripBenchmark();

  return {
    generatedAt: new Date().toISOString(),
    fixtureCount: cases.length,
    byType: Object.fromEntries(
      Array.from(buckets.entries()).map(([type, bucket]) => [
        type,
        {
          fixtureCount: bucket.total,
          exactMatchRate: bucket.exact / bucket.total,
          characterErrorRate: bucket.chars === 0 ? 0 : bucket.charDistance / bucket.chars,
          wordErrorRate: bucket.words === 0 ? 0 : bucket.wordDistance / bucket.words
        }
      ])
    ),
    exactMatchRate: exact / cases.length,
    characterErrorRate: charTotal === 0 ? 0 : charDistance / charTotal,
    wordErrorRate: wordTotal === 0 ? 0 : wordDistance / wordTotal,
    matraErrorCount: matraErrors,
    rephErrorCount: rephErrors,
    englishPreservationRate: englishCases === 0 ? 1 : englishPreserved / englishCases,
    lineBreakPreservationRate: lineCases === 0 ? 1 : linePreserved / lineCases,
    warningQuality: {
      totalWarnings,
      uncertainMappingWarnings,
      unknownGlyphWarnings,
      preservedEnglishWarnings
    },
    decoderSuites: {
      sourceAudit: {
        fixtureCount: sourceAudit.fixtureCount,
        includeInConversionBenchmarkCount: sourceAudit.includeInConversionBenchmarkCount,
        converterBugCount: sourceAudit.converterBugCount,
        sourceTypoOrAmbiguousCount: sourceAudit.sourceTypoOrAmbiguousCount,
        expectedOutputBugCount: sourceAudit.expectedOutputBugCount
      },
      fuzz: {
        fixtureCount: fuzz.fixtureCount,
        legalExactRate: fuzz.legalExactRate,
        illegalUnsafeOrWarnRate: fuzz.illegalUnsafeOrWarnRate,
        failureCount: fuzz.failureCount
      },
      roundtrip: {
        fixtureCount: roundtrip.fixtureCount,
        exactRate: roundtrip.exactRate,
        failureCount: roundtrip.failureCount
      }
    },
    topFailureCategories: summarizeFailures(failures),
    remainingFailures: failures.slice(0, 20)
  };
}

function loadPreetiCases(): PreetiCase[] {
  const generated = JSON.parse(readFileSync(join(root, "src/data/fixtures/preeti-fixtures.json"), "utf8")) as PreetiCase[];
  const heldOut = JSON.parse(readFileSync(join(root, "src/data/fixtures/preeti-heldout-fixtures.json"), "utf8")) as PreetiCase[];
  const heldOutParagraphs = JSON.parse(readFileSync(join(root, "benchmarks/preeti/held-out-paragraphs.json"), "utf8")) as PreetiCase[];
  const manualHard = JSON.parse(readFileSync(join(root, "benchmarks/preeti/manual-hard.json"), "utf8")) as PreetiCase[];
  const competitorPath = join(root, "benchmarks/preeti/competitor/preeti_competitor_probe_v1.json");
  const competitor = readOptionalCases(competitorPath).length > 0
    ? readOptionalCases(competitorPath)
    : JSON.parse(readFileSync(join(root, "benchmarks/preeti/competitor-probes.json"), "utf8")) as PreetiCase[];
  const userSubmitted = JSON.parse(readFileSync(join(root, "benchmarks/preeti/user-submitted.json"), "utf8")) as PreetiCase[];
  return [
    ...generated.map((item) => ({ ...item, type: inferFixtureType(item) })),
    ...heldOut.map((item) => ({ ...item, type: "held-out" })),
    ...heldOutParagraphs,
    ...manualHard,
    ...competitor,
    ...userSubmitted
  ];
}

function inferFixtureType(item: PreetiCase) {
  if (item.source === "dictionary-ne@2.0.0-roundtrip") return "generated";
  if (item.source === "manual-audited-preeti") return "manual";
  return item.type ?? "manual";
}

function readOptionalCases(path: string): PreetiCase[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PreetiCase[];
  } catch {
    return [];
  }
}

function tokenize(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function newlineCount(value: string) {
  return (value.match(/\n/g) ?? []).length;
}

function levenshtein(a: string, b: string): number {
  return levenshteinArray(Array.from(a), Array.from(b));
}

function levenshteinArray<T>(a: T[], b: T[]): number {
  const rows = Array.from({ length: a.length + 1 }, (_, row) => [row]);
  for (let column = 1; column <= b.length; column += 1) rows[0][column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(rows[row - 1][column] + 1, rows[row][column - 1] + 1, rows[row - 1][column - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

if (isDirectCli(import.meta.url)) {
  const startedAt = Date.now();
  const report = runPreetiBenchmark();
  const reportWithMetadata = {
    ...report,
    command: "npm run benchmark:preeti",
    suite: "preeti",
    mode: "full",
    durationMs: Date.now() - startedAt
  };
  mkdirSync(join(root, "bench/reports"), { recursive: true });
  writeFileSync(join(root, "bench/reports/preeti-report.json"), `${JSON.stringify(reportWithMetadata, null, 2)}\n`);
  console.log(JSON.stringify(reportWithMetadata, null, 2));
  if (process.argv.includes("--write")) {
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(join(root, "reports/preeti-benchmark.json"), `${JSON.stringify(reportWithMetadata, null, 2)}\n`);
  }
}
