import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeNepaliText } from "../src/core/normalize/normalizeNepaliText";
import { isDirectCli } from "./lib/cli";

interface FixtureCase {
  id?: string;
  input?: string;
  expected?: string;
  expected_top1?: string;
  type?: string;
  category?: string;
  source?: string;
}

interface SuiteReport {
  suiteId: string;
  path: string;
  classification: string;
  fixtureCount: number;
  exactInputOverlap: string[];
  exactExpectedOutputOverlap: string[];
  phraseSourceOverlap: string[];
  aliasSourceOverlap: string[];
  generatedFromSameSourceWarning: boolean;
  quarantined: boolean;
  contaminated: boolean;
  publicScorecardEligible: boolean;
}

const root = process.cwd();
const reportPath = join(root, "bench/reports/benchmark-disjointness-report.json");

export function runBenchmarkDisjointnessCheck() {
  const start = Date.now();
  const phraseInputs = readPhraseInputs();
  const aliasInputs = readAliasInputs();
  const seedOutputs = readSeedOutputs();
  const suites = benchmarkSuites().map((suite) => analyzeSuite(suite, phraseInputs, aliasInputs, seedOutputs));
  const hardFailures = suites.filter((suite) => suite.classification === "held-out" && suite.contaminated);
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run check:benchmark-disjointness",
    suite: "benchmark-disjointness",
    mode: "full",
    durationMs: Date.now() - start,
    fixtureCount: suites.reduce((sum, suite) => sum + suite.fixtureCount, 0),
    publicProofEligibleFixtureCount: suites
      .filter((suite) => suite.publicScorecardEligible)
      .reduce((sum, suite) => sum + suite.fixtureCount, 0),
    rule: "Exact held-out input overlap with phrase/alias sources fails. Quarantined regression suites stay visible but are excluded from public-proof scorecards. Expected-output overlap is reported as warning because Nepali words can legitimately recur.",
    suiteCount: suites.length,
    contaminatedSuites: suites.filter((suite) => suite.contaminated).map((suite) => suite.suiteId),
    quarantinedSuites: suites.filter((suite) => suite.quarantined).map((suite) => suite.suiteId),
    publicScorecardEligibleSuites: suites.filter((suite) => suite.publicScorecardEligible).map((suite) => suite.suiteId),
    hardFailureSuites: hardFailures.map((suite) => suite.suiteId),
    suites
  };

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (hardFailures.length > 0) {
    throw new Error(`Held-out benchmark contamination detected: ${hardFailures.map((suite) => suite.suiteId).join(", ")}`);
  }

  return report;
}

function analyzeSuite(
  suite: { suiteId: string; path: string; classification: string },
  phraseInputs: Set<string>,
  aliasInputs: Set<string>,
  seedOutputs: Set<string>
): SuiteReport {
  const cases = readCases(suite.path);
  const inputOverlaps = new Set<string>();
  const expectedOverlaps = new Set<string>();
  const phraseOverlaps = new Set<string>();
  const aliasOverlaps = new Set<string>();
  let generatedFromSameSourceWarning = false;

  for (const item of cases) {
    const itemClassification = item.type ?? suite.classification;
    const isRegressionCase = /regression|generated|self-consistency/.test(itemClassification);
    const input = normalizeRomanized(item.input ?? "");
    const expected = normalizeNepaliText(item.expected_top1 ?? item.expected ?? "");
    if (input && phraseInputs.has(input)) {
      if (!isRegressionCase) inputOverlaps.add(input);
      phraseOverlaps.add(input);
    }
    if (input && aliasInputs.has(input)) {
      if (!isRegressionCase) inputOverlaps.add(input);
      aliasOverlaps.add(input);
    }
    if (expected && seedOutputs.has(expected)) expectedOverlaps.add(expected);
    if (/generated|roundtrip|dictionary-ne/i.test(item.source ?? "")) generatedFromSameSourceWarning = true;
  }

  const quarantined = /quarantined|contaminated/.test(suite.classification);
  const contaminated = suite.classification === "held-out" && inputOverlaps.size > 0;
  return {
    suiteId: suite.suiteId,
    path: suite.path,
    classification: suite.classification,
    fixtureCount: cases.length,
    exactInputOverlap: [...inputOverlaps].slice(0, 50),
    exactExpectedOutputOverlap: [...expectedOverlaps].slice(0, 50),
    phraseSourceOverlap: [...phraseOverlaps].slice(0, 50),
    aliasSourceOverlap: [...aliasOverlaps].slice(0, 50),
    generatedFromSameSourceWarning,
    quarantined,
    contaminated,
    publicScorecardEligible: suite.classification !== "generated" && !quarantined && !contaminated
  };
}

function benchmarkSuites() {
  return [
    { suiteId: "romanized-generated", path: "src/data/fixtures/romanized-fixtures.json", classification: "generated" },
    { suiteId: "romanized-manual", path: "benchmarks/romanized/manual-high-value.json", classification: "regression" },
    { suiteId: "romanized-held-out", path: "benchmarks/romanized/held-out.json", classification: "regression-quarantined" },
    { suiteId: "romanized-hostile", path: "benchmarks/romanized/hostile-manual-v1.json", classification: "hostile" },
    { suiteId: "romanized-hard-hostile-heldout", path: "bench/fixtures/romanized/hostile-heldout/hard-long-prose.jsonl", classification: "held-out" },
    { suiteId: "romanized-mixed-office-root-cause", path: "bench/fixtures/romanized/hostile-heldout/mixed-office-root-cause.jsonl", classification: "hostile" },
    { suiteId: "romanized-admin-mixed", path: "benchmarks/romanized/admin-mixed/admin-mixed-regression.json", classification: "regression" },
    { suiteId: "romanized-competitor", path: "benchmarks/romanized/competitor/romanized_competitor_probe_v1.json", classification: "competitor-probe" },
    { suiteId: "preeti-generated", path: "src/data/fixtures/preeti-fixtures.json", classification: "generated" },
    { suiteId: "preeti-held-out", path: "benchmarks/preeti/held-out-paragraphs.json", classification: "held-out" },
    { suiteId: "preeti-manual-hard", path: "benchmarks/preeti/manual-hard.json", classification: "regression" },
    { suiteId: "preeti-mixed-unicode-legacy-repair", path: "bench/fixtures/preeti/mixed-unicode-legacy-islands.jsonl", classification: "hostile" },
    { suiteId: "mixed-span-mutations", path: "bench/fixtures/mixed-span-mutations/generated.jsonl", classification: "generated" },
    { suiteId: "preeti-competitor", path: "benchmarks/preeti/competitor/preeti_competitor_probe_v1.json", classification: "competitor-probe" }
  ].filter((suite) => existsSync(join(root, suite.path)));
}

function readCases(relativePath: string): FixtureCase[] {
  const path = join(root, relativePath);
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  if (relativePath.endsWith(".jsonl")) return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as FixtureCase);
  return JSON.parse(raw) as FixtureCase[];
}

function readPhraseInputs(): Set<string> {
  const values = new Set<string>();
  readTsvColumn("src/data/phrases/romanized-phrases.tsv", 0, values);
  for (const path of ["data/phrases/common.jsonl", "data/phrases/admin.jsonl", "data/phrases/legal.jsonl", "data/phrases/education.jsonl", "data/phrases/health.jsonl"]) {
    readJsonlFields(path, ["romanized", "aliases"], values);
  }
  return values;
}

function readAliasInputs(): Set<string> {
  const values = new Set<string>();
  readTsvColumn("src/data/aliases/romanized-aliases.tsv", 1, values);
  readTsvColumn("src/data/wordlists/ne-seed.tsv", 1, values);
  readTsvColumn("data/lexicon/generated/hunspell-runtime-cap.tsv", 1, values);
  readTsvColumn("data/lexicon/generated/hunspell-ranked-nepali.tsv", 1, values);
  return values;
}

function readSeedOutputs(): Set<string> {
  const values = new Set<string>();
  readTsvColumn("src/data/wordlists/ne-seed.tsv", 0, values, normalizeNepaliText);
  readTsvColumn("src/data/aliases/romanized-aliases.tsv", 0, values, normalizeNepaliText);
  return values;
}

function readTsvColumn(relativePath: string, index: number, values: Set<string>, normalize = normalizeRomanized): void {
  const path = join(root, relativePath);
  if (!existsSync(path)) return;
  const [, ...rows] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  for (const row of rows) {
    const value = normalize(row.split("\t")[index] ?? "");
    if (value) values.add(value);
  }
}

function readJsonlFields(relativePath: string, fields: string[], values: Set<string>): void {
  const path = join(root, relativePath);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line) as Record<string, unknown>;
    for (const field of fields) {
      const value = row[field];
      if (typeof value === "string") values.add(normalizeRomanized(value));
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === "string") values.add(normalizeRomanized(item));
      }
    }
  }
}

function normalizeRomanized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

if (isDirectCli(import.meta.url)) {
  const report = runBenchmarkDisjointnessCheck();
  console.log(JSON.stringify(report, null, 2));
}
