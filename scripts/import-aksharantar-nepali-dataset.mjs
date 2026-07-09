#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const sourceId = "ai4bharat-aksharantar-nepali";
const upstreamUrl = "https://huggingface.co/datasets/ai4bharat/Aksharantar/resolve/main/nep.zip";
const expectedBytes = 70_147_764;
const zipMembers = [
  { split: "train", member: "nep_train.json" },
  { split: "validation", member: "nep_valid.json" },
  { split: "test", member: "nep_test.json" }
];

const force = args.has("force");
const maxRows = args.has("max-rows") ? Number(args.get("max-rows")) : null;
const privateDir = args.get("private-dir") ?? join(root, "data", "private", "neural", sourceId);
const outDir = args.get("out-dir") ?? privateDir;
const zipPath = args.get("zip") ?? join(privateDir, "nep.zip");
const reportPath = args.get("report") ?? join(root, "reports", "neural-aksharantar-nepali-import-report.json");
const failures = [];
const warnings = [];

mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(zipPath), { recursive: true });

if (!existsSync(zipPath) || force) {
  await download(upstreamUrl, zipPath);
}

const zipBytes = readFileSync(zipPath);
const zipSha256 = createHash("sha256").update(zipBytes).digest("hex");
if (zipBytes.length !== expectedBytes) {
  failures.push(`Downloaded byte count mismatch for nep.zip: expected ${expectedBytes}, got ${zipBytes.length}.`);
}

const outTsvPath = join(outDir, "aksharantar-nepali.tsv");
const writer = createWriteStream(outTsvPath, { encoding: "utf8" });
writer.write("romanized\tdevanagari\tsource\tupstreamSplit\tupstreamId\tupstreamSource\tscore\n");

const seenPairs = new Set();
const counts = {
  rawRows: 0,
  importedRows: 0,
  duplicatePairs: 0,
  rejectedRows: 0,
  byUpstreamSplit: {},
  byUpstreamSource: {}
};
const rejected = {};

for (const file of zipMembers) {
  await importZipMember(file);
  if (maxRows !== null && counts.importedRows >= maxRows) break;
}

await new Promise((resolve, rejectPromise) => {
  writer.end(resolve);
  writer.on("error", rejectPromise);
});

if (counts.importedRows < 1_000_000 && maxRows === null) {
  failures.push(`Expected to import at least 1,000,000 cleaned rows from ${sourceId}; imported ${counts.importedRows}.`);
}

const importManifest = {
  schemaVersion: 1,
  sourceId,
  importedAt: new Date().toISOString(),
  upstream: {
    repository: "https://huggingface.co/datasets/ai4bharat/Aksharantar",
    datasetCard: "Aksharantar Nepali split (nep.zip)",
    paper: "https://arxiv.org/abs/2205.03018",
    license: "Mixed public Aksharantar licensing as declared by the dataset card; manually collected rows CC-BY, mined/reused rows CC0 where applicable.",
    rowCountListedByDatasetCard: {
      train: 2_397_000,
      validation: 3_000,
      test: 4_133
    },
    rawDataCommitted: false
  },
  files: [
    {
      upstreamPath: "nep.zip",
      localPath: relative(root, zipPath),
      bytes: zipBytes.length,
      sha256: zipSha256
    }
  ],
  output: {
    tsv: relative(root, outTsvPath),
    sha256: fileSha256(outTsvPath)
  },
  counts,
  rejected,
  maxRows,
  policy: {
    normalizeInput: "lowercase trim NFC collapse whitespace",
    normalizeOutput: "trim NFC collapse whitespace",
    activeTokenOnly: true,
    rejectWhitespaceInputs: true,
    rejectWhitespaceOutputs: true,
    rejectLatinOutputs: true,
    rejectNonLatinInputs: true,
    preserveUpstreamSourceAndScore: true,
    rawUpstreamDataCommitted: false
  },
  failures,
  warnings
};

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(importManifest, null, 2)}\n`);
finish(failures.length === 0 ? "passed-aksharantar-nepali-import" : "failed-aksharantar-nepali-import", failures.length === 0 ? 0 : 1, importManifest);

async function importZipMember(file) {
  const child = spawn("unzip", ["-p", zipPath, file.member], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (maxRows !== null && counts.importedRows >= maxRows) {
      child.kill("SIGTERM");
      break;
    }
    if (!line.trim()) continue;
    counts.rawRows += 1;
    bump(counts.byUpstreamSplit, file.split);
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      reject("invalid-json");
      continue;
    }
    const romanized = normalizeRomanized(row["english word"]);
    const devanagari = normalizeDevanagari(row["native word"]);
    const upstreamId = String(row.unique_identifier ?? "").trim();
    const upstreamSource = String(row.source ?? "unknown").trim() || "unknown";
    const score = row.score === null || row.score === undefined ? "" : String(row.score);

    bump(counts.byUpstreamSource, upstreamSource);

    if (!isValidRomanizedToken(romanized)) {
      reject("invalid-romanized-token");
      continue;
    }
    if (!isValidDevanagariToken(devanagari)) {
      reject("invalid-devanagari-token");
      continue;
    }
    const key = `${romanized}\u0000${devanagari}`;
    if (seenPairs.has(key)) {
      counts.duplicatePairs += 1;
      continue;
    }
    seenPairs.add(key);
    writer.write([
      escapeTsv(romanized),
      escapeTsv(devanagari),
      sourceId,
      file.split,
      escapeTsv(upstreamId),
      escapeTsv(upstreamSource),
      escapeTsv(score)
    ].join("\t") + "\n");
    counts.importedRows += 1;
  }

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0 && counts.importedRows < Number(maxRows ?? Number.POSITIVE_INFINITY)) {
    failures.push(`unzip failed for ${file.member} with exit code ${exitCode}: ${stderr.trim()}`);
  }
}

function parseArgs(argv) {
  const map = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1]?.startsWith("--") ? "1" : argv[index + 1] ?? "1";
    map.set(key, value);
    if (value !== "1") index += 1;
  }
  return map;
}

async function download(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const response = await fetch(url, {
    headers: {
      "User-Agent": "LekhKeyboardDatasetImporter/1.0"
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status} ${response.statusText}: ${url}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

function normalizeRomanized(value) {
  return String(value ?? "").trim().toLowerCase().normalize("NFC").replace(/\s+/gu, " ");
}

function normalizeDevanagari(value) {
  return String(value ?? "").trim().normalize("NFC").replace(/\s+/gu, " ");
}

function isValidRomanizedToken(value) {
  return Boolean(value) &&
    !/\s/u.test(value) &&
    /^[a-z0-9.'/-]+$/u.test(value) &&
    /[a-z]/u.test(value) &&
    value.length <= 64;
}

function isValidDevanagariToken(value) {
  return Boolean(value) &&
    !/\s/u.test(value) &&
    !/[A-Za-z]/u.test(value) &&
    /[\u0900-\u097F]/u.test(value) &&
    value.length <= 96;
}

function escapeTsv(value) {
  return String(value).replace(/\t/gu, " ").replace(/\r?\n/gu, " ");
}

function reject(reason) {
  counts.rejectedRows += 1;
  rejected[reason] = (rejected[reason] ?? 0) + 1;
}

function bump(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/import-aksharantar-nepali-dataset.mjs",
    suite: "neural-aksharantar-nepali-import",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status,
    report: relative(root, reportPath),
    importedRows: counts.importedRows,
    rejectedRows: counts.rejectedRows,
    duplicatePairs: counts.duplicatePairs,
    failures,
    warnings
  }, null, 2));
  process.exit(exitCode);
}
