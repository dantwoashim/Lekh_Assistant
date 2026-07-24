#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const manifestPath = join(root, "data", "neural", "gold", "manifest.v3.json");
const rowSchemaPath = join(root, "data", "neural", "schema", "lekh-neural-gold-row-v2.schema.json");
const reportPath = join(root, "reports", production ? "neural-gold-eval-production-report.json" : "neural-gold-eval-report.json");

const failures = [];
const warnings = [];
const requiredCasesFound = new Map();
const ids = new Set();
const splitPairs = new Map();
const splitInputs = new Map();
const suiteReports = [];
let totalRows = 0;
let totalTestRows = 0;

const rowSchema = readJson(rowSchemaPath, "gold row schema");
const manifest = readJson(manifestPath, "gold manifest");

if (rowSchema) {
  assert(rowSchema.$id === "https://lekh.local/schemas/lekh-neural-gold-row-v2.schema.json", "Gold row schema $id is wrong.");
  assert(rowSchema.properties?.expectedAction?.enum?.includes("no-neural-candidate"), "Gold row schema must support no-neural-candidate rows.");
  assert(rowSchema.properties?.forbiddenOutputs, "Gold row schema must include forbiddenOutputs.");
  assert(rowSchema.properties?.previousContext?.maxItems === 0, "Token-only gold rows must forbid previous-word context.");
}

if (manifest) {
  assert(manifest.schemaVersion === 3, "Gold manifest schemaVersion must be 3.");
  assert(manifest.releaseId === "lekh-neural-gold-token-only-v3", "Gold manifest releaseId is not the locked token-only v3 release.");
  assert(manifest.rowSchema === "data/neural/schema/lekh-neural-gold-row-v2.schema.json", "Gold manifest rowSchema is not canonical.");
  assert(Array.isArray(manifest.suites) && manifest.suites.length === 7, "Gold manifest must define exactly seven Phase 1 suites.");
  for (const suite of manifest.suites ?? []) {
    validateSuite(suite, manifest.requiredCases ?? {});
  }
  const actualCorpusSha256 = corpusSha256(manifest.suites ?? []);
  if (manifest.corpusSha256 !== actualCorpusSha256) {
    failures.push(`Gold corpus digest mismatch: expected ${manifest.corpusSha256}, got ${actualCorpusSha256}.`);
  }
}

for (const [input, expected] of Object.entries(manifest?.requiredCases ?? {})) {
  const key = `${input}\u0000${expected}`;
  if (!requiredCasesFound.has(key)) {
    failures.push(`Required neural gold case is missing: ${input} -> ${expected}`);
  }
}

for (const [pair, splits] of splitPairs) {
  if (splits.size > 1) {
    failures.push(`Normalized input/output pair leaks across splits: ${pair.replace("\u0000", " -> ")} in ${Array.from(splits).sort().join(", ")}`);
  }
}
for (const [input, splits] of splitInputs) {
  if (splits.size > 1) {
    failures.push(`Normalized input leaks across splits: ${input} in ${Array.from(splits).sort().join(", ")}`);
  }
}
if (production) {
  warnings.push(
    `Production evaluation is limited to the ${totalRows}-row locked repository corpus ` +
    `(${totalTestRows} held-out assertions); no unavailable private or human-reviewed corpus is claimed.`
  );
}

const status = failures.length === 0
  ? production ? "passed-production-locked-gold-eval-contract" : "passed-phase1-foundation"
  : production ? "failed-production-gold-eval" : "failed-phase1-foundation";

finish(status, failures.length === 0 ? 0 : 1);

function validateSuite(suite, requiredCases) {
  const suiteFailuresBefore = failures.length;
  const suitePath = join(root, suite.path ?? "");
  const rows = [];
  const splitCounts = { train: 0, dev: 0, test: 0 };
  const actionCounts = { "produce-candidate": 0, "no-neural-candidate": 0 };
  const reviewTierCounts = {};

  if (!suite.path || !existsSync(suitePath)) {
    failures.push(`Gold suite file is missing: ${suite.path}`);
    suiteReports.push({ ...suite, status: "missing", rows: 0 });
    return;
  }

  const lines = readFileSync(suitePath, "utf8").split(/\r?\n/).filter(Boolean);
  const actualSha256 = sha256File(suitePath);
  if (suite.sha256 !== actualSha256) failures.push(`${suite.path} SHA-256 does not match the locked manifest.`);
  if (suite.rows !== lines.length) failures.push(`${suite.path} row count does not match the locked manifest.`);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let row = null;
    try {
      row = JSON.parse(lines[lineIndex]);
    } catch (error) {
      failures.push(`${suite.path}:${lineIndex + 1} is invalid JSON: ${error.message}`);
      continue;
    }
    rows.push(row);
    validateRow(row, suite, lineIndex + 1, requiredCases, splitCounts, actionCounts, reviewTierCounts);
  }

  totalRows += rows.length;
  totalTestRows += splitCounts.test;
  const foundationMinimum = Number(suite.foundationMinimumRows ?? 1);
  if (rows.length < foundationMinimum) {
    failures.push(`${suite.path} has ${rows.length} rows; Phase 1 foundation requires at least ${foundationMinimum}.`);
  }
  if (splitCounts.test === 0) failures.push(`${suite.path} must include at least one test split row.`);
  if (suite.category === "protected-token" || suite.category === "non-nepali-pass-through") {
    if (actionCounts["no-neural-candidate"] === 0) failures.push(`${suite.path} must include no-neural-candidate rows.`);
  } else if (actionCounts["produce-candidate"] === 0) {
    failures.push(`${suite.path} must include produce-candidate rows.`);
  }

  suiteReports.push({
    id: suite.id,
    path: suite.path,
    category: suite.category,
    rows: rows.length,
    foundationMinimumRows: foundationMinimum,
    splitCounts,
    actionCounts,
    reviewTierCounts,
    status: failures.length === suiteFailuresBefore ? "passed" : "failed"
  });
}

function validateRow(row, suite, lineNumber, requiredCases, splitCounts, actionCounts, reviewTierCounts) {
  const location = `${suite.path}:${lineNumber}`;
  const required = rowSchema?.required ?? [];
  for (const field of required) {
    if (!(field in row)) failures.push(`${location} missing required field ${field}.`);
  }

  if (row.schemaVersion !== 1) failures.push(`${location} schemaVersion must be 1.`);
  if (typeof row.id !== "string" || !/^gold_[a-z0-9_]+_[0-9]{6}$/.test(row.id)) failures.push(`${location} has invalid id.`);
  if (ids.has(row.id)) failures.push(`${location} duplicate id ${row.id}.`);
  ids.add(row.id);

  if (row.category !== suite.category) failures.push(`${location} category ${row.category} does not match suite category ${suite.category}.`);
  if (!["train", "dev", "test"].includes(row.split)) failures.push(`${location} split must be train/dev/test.`);
  else splitCounts[row.split] += 1;

  if (!["produce-candidate", "no-neural-candidate"].includes(row.expectedAction)) failures.push(`${location} invalid expectedAction.`);
  else actionCounts[row.expectedAction] += 1;

  reviewTierCounts[row.reviewTier] = (reviewTierCounts[row.reviewTier] ?? 0) + 1;

  if (typeof row.input !== "string" || row.input.length === 0 || /\s/.test(row.input)) failures.push(`${location} input must be a single active token.`);
  assertNfc(row.input, `${location} input`);
  const normalizedInput = normalizeInput(row.input);
  const inputSplits = splitInputs.get(normalizedInput) ?? new Set();
  inputSplits.add(row.split);
  splitInputs.set(normalizedInput, inputSplits);
  if (Object.keys(requiredCases).some((input) => normalizeInput(input) === normalizedInput) && row.split !== "test") {
    failures.push(`${location} required held-out case ${row.input} must remain in the test split.`);
  }
  if (!Array.isArray(row.previousContext) || row.previousContext.length !== 0) {
    failures.push(`${location} token-only previousContext must be an empty array.`);
  }
  for (const token of row.previousContext ?? []) {
    if (/\s/.test(String(token))) failures.push(`${location} previousContext token contains whitespace: ${token}`);
    assertNfc(String(token), `${location} previousContext`);
  }

  const expected = Array.isArray(row.expected) ? row.expected : [];
  const acceptable = Array.isArray(row.acceptable) ? row.acceptable : [];
  const forbidden = Array.isArray(row.forbiddenOutputs) ? row.forbiddenOutputs : [];

  if (row.expectedAction === "produce-candidate") {
    if (expected.length === 0) failures.push(`${location} produce-candidate row must include expected output.`);
    if (acceptable.length === 0) failures.push(`${location} produce-candidate row must include acceptable output.`);
    for (const output of expected) {
      if (!acceptable.includes(output)) failures.push(`${location} expected output ${output} must also be acceptable.`);
    }
    for (const output of [...expected, ...acceptable]) {
      assertNfc(String(output), `${location} output`);
      if (/\s/.test(String(output))) failures.push(`${location} token output must not contain whitespace: ${output}`);
      if (/[A-Za-z]/.test(String(output))) failures.push(`${location} token output must not contain Latin text: ${output}`);
      if (!/[\u0900-\u097F]/.test(String(output))) failures.push(`${location} token output must include Devanagari: ${output}`);
      const pairKey = `${normalizeInput(row.input)}\u0000${normalizeOutput(output)}`;
      const splits = splitPairs.get(pairKey) ?? new Set();
      splits.add(row.split);
      splitPairs.set(pairKey, splits);
    }
  } else {
    if (expected.length !== 0 || acceptable.length !== 0) failures.push(`${location} no-neural-candidate row must leave expected and acceptable empty.`);
    const pairKey = `${normalizeInput(row.input)}\u0000<NO_NEURAL_CANDIDATE>`;
    const splits = splitPairs.get(pairKey) ?? new Set();
    splits.add(row.split);
    splitPairs.set(pairKey, splits);
  }

  for (const output of forbidden) {
    assertNfc(String(output), `${location} forbidden output`);
    if (acceptable.includes(output)) failures.push(`${location} forbidden output is also acceptable: ${output}`);
    if (expected.includes(output)) failures.push(`${location} forbidden output is also expected: ${output}`);
  }

  for (const [input, expectedOutput] of Object.entries(requiredCases)) {
    if (normalizeInput(row.input) === normalizeInput(input) && acceptable.map(normalizeOutput).includes(normalizeOutput(expectedOutput))) {
      requiredCasesFound.set(`${input}\u0000${expectedOutput}`, row.id);
    }
  }
}

function normalizeInput(value) {
  return String(value).trim().toLowerCase().normalize("NFC");
}

function normalizeOutput(value) {
  return String(value).trim().normalize("NFC");
}

function assertNfc(value, label) {
  if (String(value).normalize("NFC") !== String(value)) failures.push(`${label} must be NFC-normalized.`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label}: ${relative(root, path)}: ${error.message}`);
    return null;
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function finish(status, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: production
      ? "node scripts/validate-neural-gold-eval.mjs --production"
      : "node scripts/validate-neural-gold-eval.mjs",
    suite: "neural-gold-evaluation-foundation",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    production,
    manifest: "data/neural/gold/manifest.v3.json",
    corpusSha256: manifest?.corpusSha256 ?? null,
    rowSchema: "data/neural/schema/lekh-neural-gold-row-v2.schema.json",
    totalRows,
    totalTestRows,
    suites: suiteReports,
    requiredCases: Object.fromEntries(requiredCasesFound),
    failures,
    warnings,
    productionNote: "Production mode validates only the locked corpus that exists in the repository. It makes no human-review or unavailable-corpus claim."
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const payload = { status, report: relative(root, reportPath), totalRows, failures, warnings };
  if (exitCode === 0) console.log(JSON.stringify(payload, null, 2));
  else console.error(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}
