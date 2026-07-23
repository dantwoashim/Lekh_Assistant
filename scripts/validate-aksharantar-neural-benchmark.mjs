#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const manifestPath = resolve(root, args.get("manifest") ?? "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json");
const reportPath = resolve(root, args.get("report") ?? "reports/neural-aksharantar-benchmark-validation-report.json");
const failures = [];
const ids = new Set();
const inputs = new Set();
const suiteReports = [];
let totalRows = 0;

const manifest = readJson(manifestPath, "benchmark manifest");
if (manifest) validateManifest(manifest);

const status = failures.length === 0
  ? "passed-aksharantar-nepali-benchmark-validation"
  : "failed-aksharantar-nepali-benchmark-validation";
finish(status, failures.length === 0 ? 0 : 1);

function validateManifest(value) {
  if (value.schemaVersion !== 2) failures.push("Benchmark manifest schemaVersion must be 2.");
  if (value.releaseId !== "aksharantar-nepali-official-test-v1") failures.push("Benchmark releaseId is not the locked v1 release.");
  if (value.status !== "official-public-benchmark-locked") failures.push("Benchmark status must remain locked.");
  if (value.trainingUse !== "forbidden-evaluation-only") failures.push("Benchmark must remain forbidden for training.");
  if (value.uniqueInputPolicy !== "trim-lowercase-NFC-collapse-whitespace") failures.push("Benchmark normalized-input policy changed.");
  if (value.duplicateInputPolicy !== "collapse-to-one-metric-unit-with-acceptable-output-set") failures.push("Benchmark duplicate-input policy changed.");
  if (value.upstream?.sourceId !== "ai4bharat-aksharantar-nepali") failures.push("Benchmark upstream source identity is wrong.");
  if (value.upstream?.license !== "CC-BY as declared for manually collected Aksharantar benchmark data") failures.push("Benchmark upstream licensing statement is missing or changed.");
  if (!/^[a-f0-9]{64}$/u.test(String(value.upstream?.upstreamArchiveSha256 ?? ""))) failures.push("Benchmark is not bound to an upstream archive SHA-256.");
  if (!Array.isArray(value.suites) || value.suites.length !== 3) {
    failures.push("Benchmark must contain exactly three official Nepali test buckets.");
    return;
  }
  const suiteIds = new Set(value.suites.map((suite) => suite.id));
  for (const expected of ["aksharantar-native-frequent", "aksharantar-indian-names", "aksharantar-foreign-names"]) {
    if (!suiteIds.has(expected)) failures.push(`Benchmark suite is missing: ${expected}`);
  }
  for (const suite of value.suites) validateSuite(suite);
  if (value.corpusSha256 !== corpusSha256(value.suites)) failures.push("Benchmark aggregate corpus SHA-256 is stale.");
  if (totalRows < 4_000) failures.push(`Benchmark must contain at least 4,000 unique test inputs; found ${totalRows}.`);
  const counts = Object.fromEntries(suiteReports.map((suite) => [suite.id, suite.rows]));
  if ((counts["aksharantar-native-frequent"] ?? 0) < 2_000) failures.push("Native-frequent benchmark bucket is incomplete.");
  if ((counts["aksharantar-indian-names"] ?? 0) < 1_100) failures.push("Indian-name benchmark bucket is incomplete.");
  if ((counts["aksharantar-foreign-names"] ?? 0) < 800) failures.push("Foreign-name benchmark bucket is incomplete.");
}

function validateSuite(suite) {
  const path = resolve(root, suite.path ?? "");
  const before = failures.length;
  if (!suite.path || !existsSync(path)) {
    failures.push(`Benchmark suite is missing: ${suite.path}`);
    return;
  }
  if (relative(root, path) !== suite.path || relative(root, path).startsWith("..")) {
    failures.push(`Benchmark suite path is not canonical and repository-relative: ${suite.path}`);
  }
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u).filter(Boolean);
  if (sha256(text) !== suite.sha256) failures.push(`${suite.path} SHA-256 does not match the manifest.`);
  if (lines.length !== suite.rows) failures.push(`${suite.path} row count does not match the manifest.`);
  for (const [index, line] of lines.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      failures.push(`${suite.path}:${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    validateRow(row, suite, index + 1);
  }
  totalRows += lines.length;
  suiteReports.push({
    id: suite.id,
    path: suite.path,
    rows: lines.length,
    category: suite.category,
    benchmarkBucket: suite.benchmarkBucket,
    status: failures.length === before ? "passed" : "failed"
  });
}

function validateRow(row, suite, lineNumber) {
  const location = `${suite.path}:${lineNumber}`;
  const required = ["schemaVersion", "id", "input", "expectedAction", "expected", "acceptable", "forbiddenOutputs", "previousContext", "category", "source", "reviewTier", "reviewer", "license", "split", "notes"];
  for (const field of required) if (!(field in (row ?? {}))) failures.push(`${location} is missing ${field}.`);
  if (row?.schemaVersion !== 1) failures.push(`${location} schemaVersion must be 1.`);
  if (!/^gold_aksharantar_[a-z_]+_[0-9]{6}$/u.test(String(row?.id ?? ""))) failures.push(`${location} has an invalid stable row id.`);
  if (ids.has(row?.id)) failures.push(`${location} duplicates row id ${row?.id}.`);
  ids.add(row?.id);
  const input = normalizeInput(row?.input);
  if (!input || input !== row.input || !/^[a-z0-9.'/-]+$/u.test(input) || /\s/u.test(input)) failures.push(`${location} has an invalid normalized Roman input.`);
  if (inputs.has(input)) failures.push(`${location} duplicates normalized benchmark input ${input}.`);
  inputs.add(input);
  if (row?.expectedAction !== "produce-candidate") failures.push(`${location} must be a produce-candidate row.`);
  if (row?.split !== "test") failures.push(`${location} must remain in the test split.`);
  if (row?.category !== suite.category) failures.push(`${location} category does not match suite category.`);
  if (row?.source !== "ai4bharat-aksharantar-nepali-test") failures.push(`${location} has the wrong source identity.`);
  if (row?.reviewTier !== "official-public-benchmark") failures.push(`${location} overstates or changes its review tier.`);
  if (row?.reviewer !== "AI4Bharat Aksharantar test release") failures.push(`${location} has the wrong reviewer attribution.`);
  if (row?.license !== "CC-BY") failures.push(`${location} has the wrong benchmark license.`);
  if (!Array.isArray(row?.previousContext) || row.previousContext.length !== 0) failures.push(`${location} must not inject context into the context-free benchmark.`);
  if (!Array.isArray(row?.forbiddenOutputs) || row.forbiddenOutputs.length !== 0) failures.push(`${location} must not invent forbidden outputs absent from upstream.`);
  const expected = Array.isArray(row?.expected) ? row.expected : [];
  const acceptable = Array.isArray(row?.acceptable) ? row.acceptable : [];
  if (expected.length === 0 || acceptable.length === 0) failures.push(`${location} has no official native output.`);
  if (new Set(acceptable).size !== acceptable.length) failures.push(`${location} repeats acceptable outputs.`);
  for (const target of acceptable) {
    if (!target || target !== String(target).normalize("NFC") || /\s/u.test(target) || /[A-Za-z]/u.test(target) || !/[\u0900-\u097F]/u.test(target)) {
      failures.push(`${location} has an invalid native output.`);
    }
  }
  for (const target of expected) if (!acceptable.includes(target)) failures.push(`${location} expected output is not acceptable: ${target}`);
  if (typeof row?.notes !== "string" || !row.notes.includes("Official Aksharantar Nepali test row")) failures.push(`${location} is missing honest provenance notes.`);
}

function normalizeInput(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC").replace(/\s+/gu, " ");
}

function corpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    hash.update(String(suite.id));
    hash.update("\0");
    hash.update(String(suite.path));
    hash.update("\0");
    hash.update(String(suite.sha256));
    hash.update("\0");
    hash.update(String(suite.rows));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label}: ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1]?.startsWith("--") ? "1" : argv[index + 1] ?? "1";
    parsed.set(key, value);
    if (value !== "1") index += 1;
  }
  return parsed;
}

function finish(status, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/validate-aksharantar-neural-benchmark.mjs",
    suite: "neural-aksharantar-nepali-benchmark-validation",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    manifest: relative(root, manifestPath),
    corpusSha256: manifest?.corpusSha256 ?? null,
    totalRows,
    uniqueInputs: inputs.size,
    suites: suiteReports,
    failures
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  (exitCode === 0 ? console.log : console.error)(JSON.stringify({ status, report: relative(root, reportPath), totalRows, failures }, null, 2));
  process.exit(exitCode);
}
