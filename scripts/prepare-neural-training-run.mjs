#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { validateNeuralDatasetManifest } from "./lib/neural-dataset-manifest.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-training-run-readiness-production-report.json" : "neural-training-run-readiness-report.json");
const configPath = join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");
const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
const datasetReportPath = join(root, "reports", "neural-open-vocab-dataset-report.json");
const trainingReportPath = join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "training-report.json");
const checkpointPath = join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "checkpoint.pt");
const failures = [];
const warnings = [];
const modelBlockers = [];

const config = readJson(configPath, "training config");
const datasetManifest = readJson(datasetManifestPath, "dataset manifest");
const datasetReport = readJson(datasetReportPath, "dataset report");
const trainingReport = existsSync(trainingReportPath) ? readJson(trainingReportPath, "training report") : null;

if (config?.modelId !== "lekh-open-vocab-seq2seq-v1") failures.push("Training config modelId must be lekh-open-vocab-seq2seq-v1.");
const datasetValidation = datasetManifest
  ? validateNeuralDatasetManifest(datasetManifest)
  : { valid: false, issueCodes: ["neural-dataset-manifest.missing"] };
failures.push(...datasetValidation.issueCodes);
const totalRows = Number(datasetManifest?.totalRows ?? datasetReport?.totalRows);
if (!Number.isFinite(totalRows) || totalRows < 1_000_000) failures.push(`Phase 8 requires at least 1,000,000 cleaned rows before training; found ${totalRows || 0}.`);
const actualSplitEvidence = {};
for (const split of ["train", "dev", "test"]) {
  const path = datasetManifest?.splitFiles?.[split];
  const fullPath = path ? join(root, path) : null;
  if (!fullPath || !existsSync(fullPath)) {
    failures.push(`Missing generated ${split} split for training.`);
    continue;
  }
  const evidence = inspectJsonlFile(fullPath);
  actualSplitEvidence[split] = { path, ...evidence };
  if (datasetManifest?.sha256?.[split] !== evidence.sha256) failures.push(`Generated ${split} split SHA-256 does not match dataset manifest.`);
  if (datasetManifest?.counts?.[split] !== evidence.rows) failures.push(`Generated ${split} split row count does not match dataset manifest.`);
  if (datasetManifest?.bytes?.[split] !== evidence.bytes) failures.push(`Generated ${split} split byte count does not match dataset manifest.`);
}
if (datasetManifestPath && existsSync(datasetManifestPath)) {
  if (config?.training?.datasetManifest !== "data/generated/neural-open-vocab/manifest.json") {
    failures.push("Training config must point at data/generated/neural-open-vocab/manifest.json.");
  }
}
if (!trainingReport) {
  if (production) failures.push("Production Phase 8 requires data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/training-report.json.");
  else warnings.push("No training run report exists yet; Phase 8 readiness is complete but model training has not been executed.");
}
if (!existsSync(checkpointPath)) {
  if (production) failures.push("Production Phase 8 requires trained checkpoint.pt.");
  else warnings.push("No checkpoint.pt exists yet; no production model can be exported.");
}
if (trainingReport) {
  if (trainingReport.modelId !== "lekh-open-vocab-seq2seq-v1") failures.push("Training report modelId must be lekh-open-vocab-seq2seq-v1.");
  if (trainingReport.trainingComplete !== true && production) failures.push("Production Phase 8 requires trainingComplete=true.");
  const splitCompatibility = Object.fromEntries(["train", "dev", "test"].map((split) => [
    split,
    trainingReport?.inputDatasetSplitSha256?.[split] === datasetManifest?.sha256?.[split]
  ]));
  if (Object.values(splitCompatibility).some((value) => !value)) {
    blockModel("Training report split identities do not match the current locked dataset; retraining is required.");
  }
  if (!trainingReport.inputDatasetContentSha256 ||
      trainingReport.inputDatasetContentSha256 !== datasetManifest?.datasetContentSha256) {
    blockModel("Training report is not bound to the current stable dataset content identity.");
  }
  if (!trainingReport.checkpointSha256 || !/^[a-f0-9]{64}$/u.test(trainingReport.checkpointSha256)) {
    blockModel("Training report does not bind the checkpoint SHA-256.");
  } else if (existsSync(checkpointPath) && trainingReport.checkpointSha256 !== sha256File(checkpointPath)) {
    blockModel("Training report checkpoint SHA-256 does not match checkpoint.pt.");
  }
  if (!trainingReport.trainingSampleIdSha256 || !trainingReport.devSampleIdSha256) {
    blockModel("Training report does not bind the exact sampled train/dev row identities.");
  }
  if (Number(trainingReport.trainingSourceCounts?.["lekh-required-production-case"] ?? 0) > 0 ||
      Number(trainingReport.devSourceCounts?.["lekh-required-production-case"] ?? 0) > 0) {
    blockModel("Historical checkpoint consumed frozen required test cases in train/dev; retraining is required.");
  }
}

const status = failures.length === 0
  ? trainingReport
    ? modelBlockers.length > 0 ? "passed-phase8-training-run-stale-retrain-required" : "passed-phase8-training-run-complete"
    : "passed-phase8-training-readiness"
  : production ? "failed-production-phase8-training-run" : "failed-phase8-training-run";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 8,
  production,
  config: relative(root, configPath),
  datasetManifest: relative(root, datasetManifestPath),
  datasetReport: relative(root, datasetReportPath),
  trainingReport: existsSync(trainingReportPath) ? relative(root, trainingReportPath) : null,
  checkpoint: existsSync(checkpointPath) ? relative(root, checkpointPath) : null,
  totalRows,
  datasetContentSha256: datasetManifest?.datasetContentSha256 ?? null,
  actualSplitEvidence,
  retrainRequired: modelBlockers.length > 0,
  modelBlockers,
  proposedCommand: ".tmp/neural-training-venv/bin/python scripts/train-open-vocab-seq2seq-transliterator.py --config data/neural/training/open-vocab-seq2seq-v1.config.json",
  failures,
  warnings
});

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

function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function sha256File(path) {
  return inspectFile(path, false).sha256;
}

function inspectJsonlFile(path) {
  return inspectFile(path, true);
}

function inspectFile(path, countRows) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let rows = 0;
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (countRows) {
          for (const byte of chunk) if (byte === 0x0a) rows += 1;
        }
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), bytes: statSync(path).size, rows: countRows ? rows : undefined };
}

function blockModel(message) {
  modelBlockers.push(message);
  if (production) failures.push(message);
  else warnings.push(message);
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/prepare-neural-training-run.mjs",
    suite: "neural-training-run-readiness",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
