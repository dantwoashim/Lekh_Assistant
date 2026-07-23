#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const sourceDir = resolve(root, args.get("source-dir") ?? "data/private/neural/ai4bharat-aksharantar-nepali");
const sourcePath = join(sourceDir, "aksharantar-nepali.tsv");
const sourceManifestPath = join(sourceDir, "manifest.json");
const outDir = resolve(root, args.get("out-dir") ?? "data/neural/benchmarks/aksharantar-nepali-test-v1");
const manifestPath = join(outDir, "manifest.json");
const reportPath = resolve(root, args.get("report") ?? "reports/neural-aksharantar-benchmark-build-report.json");
const failures = [];
const warnings = [];
const rowsByInput = new Map();
const expectedSourceId = "ai4bharat-aksharantar-nepali";

if (!existsSync(sourcePath)) failures.push(`Missing imported Aksharantar TSV: ${relative(root, sourcePath)}`);
if (!existsSync(sourceManifestPath)) failures.push(`Missing imported Aksharantar manifest: ${relative(root, sourceManifestPath)}`);

const sourceManifest = failures.length === 0 ? readJson(sourceManifestPath, "Aksharantar source manifest") : null;
if (sourceManifest) {
  if (sourceManifest.sourceId !== expectedSourceId) failures.push(`Unexpected Aksharantar sourceId: ${sourceManifest.sourceId}`);
  const observedSourceSha256 = await fileSha256(sourcePath);
  if (sourceManifest.output?.sha256 !== observedSourceSha256) {
    failures.push("Aksharantar TSV SHA-256 does not match its import manifest.");
  }
}

if (failures.length === 0) await loadOfficialTestRows();

const groupedRows = [...rowsByInput.values()].sort((left, right) => left.input.localeCompare(right));
if (groupedRows.length < 4_000) failures.push(`Expected at least 4,000 unique official Nepali test inputs; found ${groupedRows.length}.`);

const suites = [
  { id: "aksharantar-native-frequent", file: "native-frequent.jsonl", category: "romanized-token", sourceType: "native-frequent" },
  { id: "aksharantar-indian-names", file: "indian-names.jsonl", category: "name", sourceType: "indian-name" },
  { id: "aksharantar-foreign-names", file: "foreign-names.jsonl", category: "name", sourceType: "foreign-name" }
];

let manifest = null;
if (failures.length === 0) {
  mkdirSync(outDir, { recursive: true });
  const suiteEntries = [];
  for (const suite of suites) {
    const matching = groupedRows.filter((row) => benchmarkBucket(row.upstreamSources) === suite.sourceType);
    const rows = matching.map((row, index) => benchmarkRow(row, suite, index + 1));
    const path = join(outDir, suite.file);
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    suiteEntries.push({
      id: suite.id,
      path: relative(root, path),
      sha256: await fileSha256(path),
      rows: rows.length,
      category: suite.category,
      benchmarkBucket: suite.sourceType
    });
  }
  manifest = {
    schemaVersion: 2,
    suiteVersion: "v1",
    releaseId: "aksharantar-nepali-official-test-v1",
    status: "official-public-benchmark-locked",
    note: "Official Aksharantar Nepali test rows, kept outside Lekh training. Duplicate normalized Roman inputs are one metric unit with all official native outputs treated as acceptable.",
    corpusSha256: corpusSha256(suiteEntries),
    reviewTierPolicy: {
      "official-public-benchmark": "Released Aksharantar benchmark evidence; not represented as project human review."
    },
    upstream: {
      sourceId: expectedSourceId,
      repository: sourceManifest.upstream?.repository ?? null,
      paper: sourceManifest.upstream?.paper ?? "https://aclanthology.org/2023.findings-emnlp.4/",
      license: "CC-BY as declared for manually collected Aksharantar benchmark data",
      importedManifest: relative(root, sourceManifestPath),
      importedManifestSha256: await fileSha256(sourceManifestPath),
      importedTsvSha256: await fileSha256(sourcePath),
      upstreamArchiveSha256: sourceManifest.files?.[0]?.sha256 ?? null
    },
    uniqueInputPolicy: "trim-lowercase-NFC-collapse-whitespace",
    duplicateInputPolicy: "collapse-to-one-metric-unit-with-acceptable-output-set",
    trainingUse: "forbidden-evaluation-only",
    suites: suiteEntries
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

finish(failures.length === 0 ? "passed-aksharantar-nepali-benchmark-build" : "failed-aksharantar-nepali-benchmark-build", failures.length === 0 ? 0 : 1);

async function loadOfficialTestRows() {
  const lines = createInterface({ input: createReadStream(sourcePath, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = null;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1) {
      header = line.split("\t");
      for (const field of ["romanized", "devanagari", "source", "upstreamSplit", "upstreamSource"]) {
        if (!header.includes(field)) failures.push(`Aksharantar TSV header is missing ${field}.`);
      }
      continue;
    }
    if (!line || failures.length > 0) continue;
    const columns = line.split("\t");
    const field = (name) => columns[header.indexOf(name)] ?? "";
    if (field("upstreamSplit") !== "test") continue;
    if (field("source") !== expectedSourceId) {
      failures.push(`${relative(root, sourcePath)}:${lineNumber} has unexpected source ${field("source")}.`);
      continue;
    }
    const input = normalizeInput(field("romanized"));
    const target = normalizeOutput(field("devanagari"));
    const upstreamSource = field("upstreamSource").trim();
    if (!/^[a-z0-9.'/-]+$/u.test(input) || !/[a-z]/u.test(input) || /\s/u.test(input)) {
      failures.push(`${relative(root, sourcePath)}:${lineNumber} has invalid benchmark input.`);
      continue;
    }
    if (!target || /\s/u.test(target) || /[A-Za-z]/u.test(target) || !/[\u0900-\u097F]/u.test(target)) {
      failures.push(`${relative(root, sourcePath)}:${lineNumber} has invalid benchmark target.`);
      continue;
    }
    if (!["AK-Freq", "AK-NEI", "AK-NEF"].includes(upstreamSource)) {
      failures.push(`${relative(root, sourcePath)}:${lineNumber} has unexpected official test category ${upstreamSource}.`);
      continue;
    }
    const existing = rowsByInput.get(input) ?? { input, targets: new Set(), upstreamSources: new Set() };
    existing.targets.add(target);
    existing.upstreamSources.add(upstreamSource);
    rowsByInput.set(input, existing);
  }
}

function benchmarkBucket(upstreamSources) {
  if (upstreamSources.has("AK-NEF")) return "foreign-name";
  if (upstreamSources.has("AK-NEI")) return "indian-name";
  return "native-frequent";
}

function benchmarkRow(row, suite, sequence) {
  const acceptable = [...row.targets].sort();
  const upstreamSources = [...row.upstreamSources].sort();
  return {
    schemaVersion: 1,
    id: `gold_${suite.id.replaceAll("-", "_")}_${String(sequence).padStart(6, "0")}`,
    input: row.input,
    expectedAction: "produce-candidate",
    expected: acceptable,
    acceptable,
    forbiddenOutputs: [],
    previousContext: [],
    category: suite.category,
    source: "ai4bharat-aksharantar-nepali-test",
    reviewTier: "official-public-benchmark",
    reviewer: "AI4Bharat Aksharantar test release",
    license: "CC-BY",
    split: "test",
    notes: `Official Aksharantar Nepali test row; upstream categories: ${upstreamSources.join(", ")}.`
  };
}

function normalizeInput(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC").replace(/\s+/gu, " ");
}

function normalizeOutput(value) {
  return String(value ?? "").trim().normalize("NFC").replace(/\s+/gu, " ");
}

function corpusSha256(entries) {
  const hash = createHash("sha256");
  for (const suite of entries) {
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

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function readJson(path, label) {
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
    command: "node scripts/build-aksharantar-neural-benchmark.mjs",
    suite: "neural-aksharantar-nepali-benchmark-build",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    source: existsSync(sourcePath) ? {
      path: relative(root, sourcePath),
      bytes: statSync(sourcePath).size
    } : null,
    manifest: manifest ? relative(root, manifestPath) : null,
    corpusSha256: manifest?.corpusSha256 ?? null,
    uniqueRows: groupedRows.length,
    ambiguousInputs: groupedRows.filter((row) => row.targets.size > 1).length,
    bucketCounts: Object.fromEntries(suites.map((suite) => [
      suite.sourceType,
      groupedRows.filter((row) => benchmarkBucket(row.upstreamSources) === suite.sourceType).length
    ])),
    failures,
    warnings
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const summary = { status, report: relative(root, reportPath), manifest: report.manifest, uniqueRows: report.uniqueRows, failures, warnings };
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(summary, null, 2));
  process.exit(exitCode);
}
