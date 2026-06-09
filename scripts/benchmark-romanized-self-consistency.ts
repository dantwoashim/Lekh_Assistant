import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeNepaliText } from "../src/core/normalize/normalizeNepaliText";
import { convertRomanized } from "../src/engine";
import { assertNonEmptySuite } from "./lib/cli";

interface RomanizedSelfCase {
  id?: string;
  input: string;
  expected?: string;
  expected_top1?: string;
  acceptable_candidates?: string[];
  category?: string;
  type?: string;
}

const root = process.cwd();
const reportPath = join(root, "bench/reports/romanized-self-consistency-report.json");

export function runRomanizedSelfConsistencyBenchmark() {
  const start = Date.now();
  const cases = loadCases();
  assertNonEmptySuite("romanized self-consistency", cases.length);
  const failures = [];
  let normalizedStable = 0;
  let outputInTopCandidates = 0;
  let hardCapHonored = 0;
  let protectedPreserved = 0;
  let protectedTotal = 0;

  for (const item of cases) {
    const mode = modeForCase(item);
    const result = convertRomanized(item.input, { mode, benchmark: true });
    const output = result.normalizedOutput;
    const normalizedAgain = normalizeNepaliText(output);
    if (output === normalizedAgain) normalizedStable += 1;
    const topCandidates = result.alternatives.slice(0, 5).map((candidate) => candidate.normalizedText);
    if (topCandidates.includes(output) || result.alternatives.length === 0) outputInTopCandidates += 1;
    if (result.alternatives.length <= 12 && result.tokens.every((token) => token.alternatives.length <= 12)) hardCapHonored += 1;

    const expectedProtected = expectedProtectedSubstrings(item.input);
    if (expectedProtected.length > 0) {
      protectedTotal += 1;
      if (expectedProtected.every((part) => output.includes(part))) protectedPreserved += 1;
    }

    const expected = normalizeNepaliText(item.expected_top1 ?? item.expected ?? "");
    const acceptable = [expected, ...(item.acceptable_candidates ?? []).map((candidate) => normalizeNepaliText(candidate))].filter(Boolean);
    const expectedInTop5 = acceptable.length === 0 || topCandidates.some((candidate) => acceptable.includes(candidate)) || acceptable.includes(output);

    if (output !== normalizedAgain || !expectedInTop5 || result.alternatives.length > 12) {
      failures.push({
        id: item.id ?? item.input,
        input: item.input,
        expected,
        output,
        topCandidates,
        category: item.category ?? "unknown",
        type: item.type ?? "unknown",
        mode,
        normalizedStable: output === normalizedAgain,
        expectedInTop5,
        candidateCount: result.alternatives.length
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    command: process.env.LEKH_BENCHMARK_SMOKE === "1" ? "npm run benchmark:romanized:self:smoke" : "npm run benchmark:romanized:self",
    suite: "romanized-self-consistency",
    mode: process.env.LEKH_BENCHMARK_SMOKE === "1" ? "smoke" : "full",
    durationMs: Date.now() - start,
    fixtureCount: cases.length,
    normalizedStabilityRate: normalizedStable / cases.length,
    outputInTopCandidatesRate: outputInTopCandidates / cases.length,
    hardCandidateCapRate: hardCapHonored / cases.length,
    protectedPreservationRate: protectedTotal === 0 ? 1 : protectedPreserved / protectedTotal,
    failureCount: failures.length,
    failures: failures.slice(0, 100)
  };
}

function loadCases(): RomanizedSelfCase[] {
  const generated = JSON.parse(readFileSync(join(root, "src/data/fixtures/romanized-fixtures.json"), "utf8")) as RomanizedSelfCase[];
  const manual = JSON.parse(readFileSync(join(root, "benchmarks/romanized/manual-high-value.json"), "utf8")) as RomanizedSelfCase[];
  const hostile = JSON.parse(readFileSync(join(root, "benchmarks/romanized/hostile-manual-v1.json"), "utf8")) as RomanizedSelfCase[];
  const adminMixed = JSON.parse(readFileSync(join(root, "benchmarks/romanized/admin-mixed/admin-mixed-regression.json"), "utf8")) as RomanizedSelfCase[];
  if (process.env.LEKH_BENCHMARK_SMOKE === "1") {
    return [
      ...generated.slice(0, 40).map((item) => ({ ...item, type: "generated-sample" })),
      ...manual.slice(0, 30).map((item) => ({ ...item, type: item.type ?? "manual" })),
      ...hostile.slice(0, 40).map((item) => ({ ...item, type: item.type ?? "hostile" })),
      ...adminMixed.slice(0, 30).map((item) => ({ ...item, type: item.type ?? "regression" }))
    ];
  }
  return [
    ...generated.slice(0, 600).map((item) => ({ ...item, type: "generated-sample" })),
    ...manual.map((item) => ({ ...item, type: item.type ?? "manual" })),
    ...hostile.map((item) => ({ ...item, type: item.type ?? "hostile" })),
    ...adminMixed.map((item) => ({ ...item, type: item.type ?? "regression" }))
  ];
}

function expectedProtectedSubstrings(input: string): string[] {
  return input.match(/\b(?:PDF|NID|PAN|VAT|DOB|URL|ID|X-ray|ward-\d+|Form No\.?|\d{7,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g) ?? [];
}

function modeForCase(item: RomanizedSelfCase): "romanized-strict" | "romanized-mixed" {
  if (expectedProtectedSubstrings(item.input).length > 0) return "romanized-mixed";
  if (/mixed|protected/i.test(`${item.category ?? ""} ${item.type ?? ""}`)) return "romanized-mixed";
  if (/\b(?:online form|record system|final output|correct output|X-ray report)\b/i.test(item.input)) return "romanized-mixed";
  return "romanized-strict";
}

if (process.env.LEKH_SCRIPT === "benchmark-romanized-self") {
  const report = runRomanizedSelfConsistencyBenchmark();
  mkdirSync(join(root, "bench/reports"), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ...report,
    failures: report.failures.slice(0, 20),
    truncatedFailureCount: Math.max(0, report.failures.length - 20),
    fullReportPath: "bench/reports/romanized-self-consistency-report.json"
  }, null, 2));
}
