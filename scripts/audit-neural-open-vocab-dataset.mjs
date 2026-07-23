#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import {
  createEvaluationIdentityIndex,
  NeuralDatasetQualityAccumulator
} from "./lib/neural-dataset-quality-audit.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const defaults = Object.freeze({
  datasetManifest: "data/generated/neural-open-vocab/manifest.json",
  goldManifest: "data/neural/gold/manifest.v2.json",
  benchmarkManifest: "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
  report: "data/neural/audits/open-vocab-data-quality-v1.json"
});

export async function auditNeuralOpenVocabularyDataset(options = {}) {
  const paths = {
    datasetManifest: resolveRepoRegularFile(options.datasetManifest ?? defaults.datasetManifest, "dataset manifest"),
    goldManifest: resolveRepoRegularFile(options.goldManifest ?? defaults.goldManifest, "gold manifest"),
    benchmarkManifest: resolveRepoRegularFile(options.benchmarkManifest ?? defaults.benchmarkManifest, "benchmark manifest"),
    report: resolveRepoOutputFile(options.report ?? defaults.report)
  };
  const datasetManifest = readJson(paths.datasetManifest);
  const evaluation = {
    "gold-foundation": await readEvaluationRelease(paths.goldManifest),
    "aksharantar-official-benchmark": await readEvaluationRelease(paths.benchmarkManifest)
  };
  const accumulator = new NeuralDatasetQualityAccumulator({
    evaluationIndexes: Object.entries(evaluation).map(([name, release]) =>
      createEvaluationIdentityIndex(name, release.rows))
  });
  const splitArtifacts = {};
  for (const split of ["train", "dev", "test"]) {
    const declaredPath = datasetManifest.splitFiles?.[split];
    if (typeof declaredPath !== "string" || !declaredPath) {
      throw new Error(`Dataset manifest is missing splitFiles.${split}.`);
    }
    splitArtifacts[split] = await streamDatasetSplit({
      accumulator,
      split,
      path: resolveRepoRegularFile(declaredPath, `${split} dataset split`),
      expected: {
        bytes: datasetManifest.bytes?.[split],
        rows: datasetManifest.counts?.[split],
        sha256: datasetManifest.sha256?.[split]
      }
    });
  }
  const manifestBytes = readFileSync(paths.datasetManifest);
  const report = accumulator.finalize({
    dataset: {
      id: datasetManifest.datasetId ?? null,
      manifestPath: relativePath(paths.datasetManifest),
      manifestSha256: sha256(manifestBytes),
      declaredContentSha256: datasetManifest.datasetContentSha256 ?? null,
      declaredRows: datasetManifest.totalRows ?? null,
      declaredCounts: datasetManifest.counts ?? null
    },
    artifacts: {
      splits: splitArtifacts,
      evaluationReferences: Object.fromEntries(Object.entries(evaluation).map(([name, release]) => [name, {
        manifestPath: relativePath(release.manifestPath),
        manifestSha256: release.manifestSha256,
        releaseId: release.manifest.releaseId ?? null,
        rows: release.rows.length,
        suites: release.artifacts
      }]))
    }
  });
  mkdirSync(dirname(paths.report), { recursive: true });
  requireRepoContainment(realpathSync(dirname(paths.report)), "audit report directory");
  if (existsSync(paths.report)) {
    const metadata = lstatSync(paths.report);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Refusing non-regular or symbolic-link audit report: ${relativePath(paths.report)}`);
    }
  }
  writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath: paths.report };
}

async function streamDatasetSplit({ accumulator, split, path, expected }) {
  const artifact = await streamJsonLines(path, (row, line, error) => {
    const location = `${relativePath(path)}:${line}`;
    if (error) accumulator.addInvalidJson(split, location, error.message);
    else accumulator.add(row, split, location);
  });
  const expectedValues = {
    bytes: Number(expected.bytes),
    rows: Number(expected.rows),
    sha256: String(expected.sha256 ?? "")
  };
  return {
    path: relativePath(path),
    expected: expectedValues,
    observed: artifact,
    integrityMatches:
      artifact.bytes === expectedValues.bytes &&
      artifact.rows === expectedValues.rows &&
      artifact.sha256 === expectedValues.sha256 &&
      artifact.invalidJsonRows === 0
  };
}

async function readEvaluationRelease(manifestPath) {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const rows = [];
  const artifacts = [];
  for (const suite of manifest.suites ?? []) {
    if (typeof suite.path !== "string" || !suite.path) {
      throw new Error(`Evaluation manifest ${relativePath(manifestPath)} has a suite without a path.`);
    }
    const path = resolveRepoRegularFile(suite.path, `evaluation suite ${suite.id ?? "<unknown>"}`);
    const artifact = await streamJsonLines(path, (row, _line, error) => {
      if (error) throw new Error(`Invalid JSON in ${relativePath(path)}: ${error.message}`);
      rows.push(row);
    });
    const expected = {
      rows: Number(suite.rows),
      sha256: String(suite.sha256 ?? "")
    };
    artifacts.push({
      id: suite.id ?? null,
      path: relativePath(path),
      expected,
      observed: artifact,
      integrityMatches:
        artifact.rows === expected.rows &&
        artifact.sha256 === expected.sha256 &&
        artifact.invalidJsonRows === 0
    });
  }
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    rows,
    artifacts
  };
}

async function streamJsonLines(path, visit) {
  const digest = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let bytes = 0;
  let rows = 0;
  let invalidJsonRows = 0;
  let line = 0;

  const consume = (text, final = false) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const current = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      processLine(current);
    }
    if (final && buffered.length > 0) {
      processLine(buffered.replace(/\r$/u, ""));
      buffered = "";
    }
  };
  const processLine = (value) => {
    line += 1;
    if (!value.trim()) return;
    rows += 1;
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      invalidJsonRows += 1;
      visit(null, line, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    visit(parsed, line, null);
  };

  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength;
    digest.update(chunk);
    consume(decoder.write(chunk));
  }
  consume(decoder.end(), true);
  return { bytes, rows, sha256: digest.digest("hex"), invalidJsonRows };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function resolveRepoRegularFile(candidate, label = "input") {
  const lexicalPath = resolve(root, String(candidate));
  requireRepoContainment(lexicalPath, label);
  const metadata = lstatSync(lexicalPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Refusing non-regular or symbolic-link ${label}: ${relativePath(lexicalPath)}`);
  }
  const canonicalPath = realpathSync(lexicalPath);
  requireRepoContainment(canonicalPath, label);
  return canonicalPath;
}

function resolveRepoOutputFile(candidate) {
  const lexicalPath = resolve(root, String(candidate));
  requireRepoContainment(lexicalPath, "audit report");
  if (existsSync(lexicalPath)) {
    const metadata = lstatSync(lexicalPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Refusing non-regular or symbolic-link audit report: ${relativePath(lexicalPath)}`);
    }
  }
  return lexicalPath;
}

function requireRepoContainment(path, label) {
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`Refusing ${label} outside repository root: ${path}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativePath(path) {
  const prefix = `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    const key = {
      "--dataset-manifest": "datasetManifest",
      "--gold-manifest": "goldManifest",
      "--benchmark-manifest": "benchmarkManifest",
      "--report": "report"
    }[option];
    if (!key) throw new Error(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${option}.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/audit-neural-open-vocab-dataset.mjs [options]",
    "",
    `  --dataset-manifest <path>   default: ${defaults.datasetManifest}`,
    `  --gold-manifest <path>      default: ${defaults.goldManifest}`,
    `  --benchmark-manifest <path> default: ${defaults.benchmarkManifest}`,
    `  --report <path>             default: ${defaults.report}`
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const { report, reportPath } = await auditNeuralOpenVocabularyDataset(options);
      console.log(JSON.stringify({
        status: report.status,
        rowsAudited: report.rowsAudited,
        findings: report.findings.map(({ severity, code, message }) => ({ severity, code, message })),
        report: relativePath(reportPath)
      }, null, 2));
      if (report.status === "failed-data-quality-audit") process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
