#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { performance } from "node:perf_hooks";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const sourceId = "syubraj-roman2nepali-transliteration";
const baseUrl = "https://huggingface.co/datasets/syubraj/roman2nepali-transliteration/resolve/refs%2Fconvert%2Fparquet";
const expectedFiles = [
  {
    split: "train",
    path: "default/train/0000.parquet",
    expectedBytes: 86_091_691,
    expectedSha256: null
  },
  {
    split: "validation",
    path: "default/validation/0000.parquet",
    expectedBytes: 94_132,
    expectedSha256: null
  }
];

const force = args.has("force");
const maxRows = args.has("max-rows") ? Number(args.get("max-rows")) : null;
const privateDir = args.get("private-dir") ?? join(root, "data", "private", "neural", sourceId);
const outDir = args.get("out-dir") ?? privateDir;
const reportPath = args.get("report") ?? join(root, "reports", "neural-syubraj-import-report.json");
const failures = [];
const warnings = [];

mkdirSync(outDir, { recursive: true });
mkdirSync(join(privateDir, "parquet"), { recursive: true });

const downloadedFiles = [];
for (const file of expectedFiles) {
  const url = `${baseUrl}/${file.path}`;
  const destination = join(privateDir, "parquet", file.path.replaceAll("/", "__"));
  if (!existsSync(destination) || force) {
    await download(url, destination);
  }
  const bytes = readFileSync(destination);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (file.expectedBytes && bytes.length !== file.expectedBytes) {
    failures.push(`Downloaded byte count mismatch for ${file.path}: expected ${file.expectedBytes}, got ${bytes.length}.`);
  }
  if (file.expectedSha256 && sha256 !== file.expectedSha256) {
    failures.push(`Downloaded SHA-256 mismatch for ${file.path}: expected ${file.expectedSha256}, got ${sha256}.`);
  }
  downloadedFiles.push({
    ...file,
    localPath: destination,
    bytes: bytes.length,
    sha256
  });
}

const outTsvPath = join(outDir, "syubraj-roman2nepali-transliteration.tsv");
const writer = createWriteStream(outTsvPath, { encoding: "utf8" });
writer.write("romanized\tdevanagari\tsource\tupstreamSplit\tupstreamId\n");

const seenPairs = new Set();
const counts = {
  rawRows: 0,
  importedRows: 0,
  duplicatePairs: 0,
  rejectedRows: 0
};
const rejected = {};
const schemaByFile = [];

for (const file of downloadedFiles) {
  const asyncFile = await asyncBufferFromFile(file.localPath);
  const metadata = await parquetMetadataAsync(asyncFile);
  const schema = parquetSchema(metadata);
  schemaByFile.push({
    split: file.split,
    rows: Number(metadata.num_rows),
    columns: schema.children.map((child) => child.element.name)
  });
  const rows = await parquetReadObjects({
    file: asyncFile,
    compressors,
    columns: ["id", "translation"]
  });
  for (const row of rows) {
    counts.rawRows += 1;
    if (maxRows !== null && counts.importedRows >= maxRows) break;
    const romanized = normalizeRomanized(row.translation?.roman ?? row["english word"]);
    const devanagari = normalizeDevanagari(row.translation?.nepali ?? row["native word"]);
    const upstreamId = String(row.id ?? row.unique_identifier ?? "").trim();
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
    writer.write(`${escapeTsv(romanized)}\t${escapeTsv(devanagari)}\t${sourceId}\t${file.split}\t${escapeTsv(upstreamId)}\n`);
    counts.importedRows += 1;
  }
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
    repository: "https://huggingface.co/datasets/syubraj/roman2nepali-transliteration",
    sourceDataset: "https://huggingface.co/datasets/Saugatkafley/Nepali-Roman-Transliteration",
    convertedParquetBranch: "refs/convert/parquet",
    license: "MIT as listed on the Hugging Face dataset card",
    rowCountListedByHuggingFace: 2_400_218,
    rawDataCommitted: false
  },
  files: downloadedFiles.map((file) => ({
    split: file.split,
    upstreamPath: file.path,
    localPath: relative(root, file.localPath),
    bytes: file.bytes,
    sha256: file.sha256
  })),
  output: {
    tsv: relative(root, outTsvPath),
    sha256: fileSha256(outTsvPath)
  },
  schemaByFile,
  counts,
  rejected,
  maxRows,
  policy: {
    normalizeInput: "lowercase trim NFC collapse whitespace",
    normalizeOutput: "trim NFC collapse whitespace",
    activeTokenOnly: true,
    rejectWhitespaceOutputs: true,
    rejectLatinOutputs: true,
    rawUpstreamDataCommitted: false
  },
  failures,
  warnings
};

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(importManifest, null, 2)}\n`);
finish(failures.length === 0 ? "passed-syubraj-import" : "failed-syubraj-import", failures.length === 0 ? 0 : 1, importManifest);

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
    value.length <= 48;
}

function isValidDevanagariToken(value) {
  return Boolean(value) &&
    !/\s/u.test(value) &&
    !/[A-Za-z]/u.test(value) &&
    /[\u0900-\u097F]/u.test(value) &&
    value.length <= 64;
}

function escapeTsv(value) {
  return String(value).replace(/\t/gu, " ").replace(/\r?\n/gu, " ");
}

function reject(reason) {
  counts.rejectedRows += 1;
  rejected[reason] = (rejected[reason] ?? 0) + 1;
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/import-syubraj-neural-dataset.mjs",
    suite: "neural-syubraj-import",
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
    failures,
    warnings
  }, null, 2));
  process.exit(exitCode);
}
