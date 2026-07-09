#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

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

const config = readJson(configPath, "training config");
const datasetManifest = readJson(datasetManifestPath, "dataset manifest");
const datasetReport = readJson(datasetReportPath, "dataset report");
const trainingReport = existsSync(trainingReportPath) ? readJson(trainingReportPath, "training report") : null;

if (config?.modelId !== "lekh-open-vocab-seq2seq-v1") failures.push("Training config modelId must be lekh-open-vocab-seq2seq-v1.");
if (datasetManifest?.datasetId !== "lekh-open-vocab-cleaned-v1") failures.push("Dataset manifest datasetId must be lekh-open-vocab-cleaned-v1.");
const totalRows = Number(datasetManifest?.totalRows ?? datasetReport?.totalRows);
if (!Number.isFinite(totalRows) || totalRows < 1_000_000) failures.push(`Phase 8 requires at least 1,000,000 cleaned rows before training; found ${totalRows || 0}.`);
for (const split of ["train", "dev", "test"]) {
  const path = datasetManifest?.splitFiles?.[split];
  if (!path || !existsSync(join(root, path))) failures.push(`Missing generated ${split} split for training.`);
}
if (datasetManifestPath && existsSync(datasetManifestPath)) {
  const actualDatasetManifestSha = sha256File(datasetManifestPath);
  if (config?.training?.datasetManifest !== "data/generated/neural-open-vocab/manifest.json") {
    failures.push("Training config must point at data/generated/neural-open-vocab/manifest.json.");
  }
  const currentSplitSha = JSON.stringify(datasetManifest?.sha256 ?? {});
  const trainingSplitSha = JSON.stringify(trainingReport?.inputDatasetSplitSha256 ?? {});
  if (trainingReport?.inputDatasetSplitSha256 && trainingSplitSha !== currentSplitSha) {
    failures.push("Training report dataset split SHA values do not match current generated dataset splits.");
  } else if (!trainingReport?.inputDatasetSplitSha256 && trainingReport?.inputDatasetManifestSha256 && trainingReport.inputDatasetManifestSha256 !== actualDatasetManifestSha) {
    const message = "Training report full manifest SHA changed; treating as timestamp-only drift because split SHA values match or are absent.";
    if (production && !trainingReport?.inputDatasetSplitSha256) failures.push(message);
    else warnings.push(message);
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
}

const status = failures.length === 0
  ? trainingReport ? "passed-phase8-training-run-complete" : "passed-phase8-training-readiness"
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
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
