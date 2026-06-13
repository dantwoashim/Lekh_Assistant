#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const production = args.has("production");
const holdoutPath = args.get("holdout") ?? join(ROOT, "data", "keyboard-corpus", "review", "v0.1", "human_rated_holdout.jsonl");
const reportPath = args.get("report") ?? join(ROOT, "data", "keyboard-corpus", "reports", "confidence-calibration-report.json");
const minRows = Number(args.get("min-rows") ?? (production ? 500 : 1));
const maxEce = Number(args.get("max-ece") ?? 0.08);

if (!existsSync(holdoutPath)) {
  finish(production ? "failed" : "passed-no-holdout-dev", {
    holdout: relative(ROOT, holdoutPath),
    rows: 0,
    failures: production ? [`Missing human-rated holdout: ${relative(ROOT, holdoutPath)}`] : [],
    warnings: production ? [] : ["No human-rated holdout yet; production calibration remains blocked."]
  }, production ? 1 : 0);
}

const rows = readJsonl(holdoutPath).map(normalizeRatedRow).filter(Boolean);
const failures = [];
const warnings = [];
if (rows.length < minRows) failures.push(`Human-rated holdout has ${rows.length} rows; requires ${minRows}.`);

const bins = Array.from({ length: 10 }, (_, index) => ({
  bin: index,
  minConfidence: index / 10,
  maxConfidence: (index + 1) / 10,
  rows: 0,
  avgConfidence: 0,
  accuracy: 0,
  eceContribution: 0
}));

for (const row of rows) {
  const bin = bins[Math.min(9, Math.max(0, Math.floor(row.confidence * 10)))];
  bin.rows += 1;
  bin.avgConfidence += row.confidence;
  bin.accuracy += row.correct ? 1 : 0;
}

let ece = 0;
for (const bin of bins) {
  if (bin.rows === 0) continue;
  bin.avgConfidence /= bin.rows;
  bin.accuracy /= bin.rows;
  bin.eceContribution = Math.abs(bin.accuracy - bin.avgConfidence) * (bin.rows / Math.max(1, rows.length));
  ece += bin.eceContribution;
}

if (ece > maxEce) failures.push(`Expected calibration error ${ece.toFixed(4)} exceeds ${maxEce}.`);
if (rows.some((row) => row.quality === "synthetic")) {
  warnings.push("Holdout contains synthetic rows; production calibration should use native-speaker human-rated rows only.");
}

finish(failures.length === 0 ? "passed" : "failed", {
  holdout: relative(ROOT, holdoutPath),
  rows: rows.length,
  minRows,
  maxEce,
  ece: Number(ece.toFixed(5)),
  bins,
  failures,
  warnings
}, failures.length === 0 ? 0 : 1);

function readJsonl(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function normalizeRatedRow(row) {
  const confidence = Number(row.confidence ?? row.candidate?.confidence ?? row.score);
  if (!Number.isFinite(confidence)) return undefined;
  const rating = row.correct ?? row.accepted ?? row.isCorrect ?? row.rating;
  const correct = typeof rating === "boolean" ? rating : Number(rating) >= 4;
  return {
    confidence: Math.max(0, Math.min(1, confidence)),
    correct,
    quality: String(row.quality ?? row.candidate?.quality ?? "")
  };
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/calibrate-runtime-confidence.mjs",
    suite: "runtime-confidence-calibration",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
