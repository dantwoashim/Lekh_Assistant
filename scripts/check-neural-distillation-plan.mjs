#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", "neural-distillation-plan-report.json");
const sourceRegistryPath = join(root, "data", "neural", "sources.v1.json");
const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
const datasetReportPath = join(root, "reports", "neural-open-vocab-dataset-report.json");
const trainingConfigPath = join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");
const teacherManifestPath = join(root, "data", "generated", "neural-teacher-models", "ai4bharat-indicxlit", "v1.0", "manifest.json");
const privateSyubrajPath = join(root, "data", "private", "neural", "syubraj-roman2nepali-transliteration", "syubraj-roman2nepali-transliteration.tsv");

const failures = [];
const warnings = [];

const sourceRegistry = readJsonIfExists(sourceRegistryPath, "source registry");
const datasetManifest = readJsonIfExists(datasetManifestPath, "open-vocab dataset manifest");
const datasetReport = readJsonIfExists(datasetReportPath, "open-vocab dataset report");
const trainingConfig = readJsonIfExists(trainingConfigPath, "training config");
const teacherManifest = readJsonIfExists(teacherManifestPath, "teacher model manifest");

if (!sourceRegistry) failures.push("Missing data/neural/sources.v1.json.");
if (!datasetManifest) failures.push("Missing data/generated/neural-open-vocab/manifest.json. Run npm run neural:open-vocab:dataset.");
if (!trainingConfig) failures.push("Missing data/neural/training/open-vocab-seq2seq-v1.config.json.");

if (sourceRegistry) {
  const sources = new Map((sourceRegistry.sources ?? []).map((source) => [source.id, source]));
  const teacher = sources.get("ai4bharat-indicxlit");
  if (!teacher) {
    failures.push("Source registry must include ai4bharat-indicxlit as teacher-only.");
  } else {
    if (teacher.status !== "teacher-only") failures.push("ai4bharat-indicxlit must be marked teacher-only.");
    if (teacher.allowedForOpenVocabTokenTraining !== false) failures.push("Teacher checkpoint must not be allowed as direct token-training source.");
    if (teacher.rawDataCommitted !== false) failures.push("Teacher checkpoint/raw files must never be committed.");
  }

  for (const required of ["syubraj-roman2nepali-transliteration", "human-reviewed-lekh-gold-v1", "lekh-chat-conventions-v1", "lekh-name-lexicon-v1"]) {
    const source = sources.get(required);
    if (!source) failures.push(`Source registry missing production required source: ${required}.`);
    const hasCleanRows = Number(datasetReport?.sourceCounts?.[required] ?? 0) > 0;
    const hasLocalImport = required === "syubraj-roman2nepali-transliteration" && existsSync(privateSyubrajPath);
    if (production && source?.status !== "available" && !hasCleanRows && !hasLocalImport) {
      failures.push(`Production Phase 3 requires ${required} to be imported and available; current status is ${source?.status ?? "missing"}.`);
    }
  }
}

if (trainingConfig) {
  if (trainingConfig.modelId !== "lekh-open-vocab-seq2seq-v1") failures.push("Training config modelId must be lekh-open-vocab-seq2seq-v1.");
  if (trainingConfig.training?.teacherPolicy !== "offline-distillation-only-never-packaged") {
    failures.push("Training config must keep the public teacher offline-only and never packaged.");
  }
  if (!trainingConfig.training?.teacherSources?.includes("ai4bharat-indicxlit")) {
    failures.push("Training config must name ai4bharat-indicxlit as an offline teacher source.");
  }
}

if (datasetManifest) {
  if (datasetManifest.datasetId !== "lekh-open-vocab-cleaned-v1") failures.push("Dataset manifest must identify lekh-open-vocab-cleaned-v1.");
  const rows = Number(datasetManifest.counts?.totalRows ?? datasetManifest.totalRows);
  if (!Number.isFinite(rows) || rows <= 0) failures.push("Dataset manifest must include a positive row count.");
  if (production && rows < 1_000_000) failures.push(`Production Phase 3 requires >=1,000,000 cleaned rows before distillation; found ${rows}.`);
}

if (teacherManifest) {
  if (teacherManifest.role !== "teacher-only-not-shipping") failures.push("Downloaded teacher manifest must declare teacher-only-not-shipping.");
  if (teacherManifest.productionPolicy?.shippingAllowed !== false) failures.push("Downloaded teacher manifest must forbid shipping.");
  if (teacherManifest.productionPolicy?.coreML !== false) failures.push("Downloaded teacher manifest must not be treated as the Core ML artifact.");
} else if (production) {
  failures.push("Production Phase 3 requires the local teacher manifest from npm run neural:teacher:download.");
} else {
  warnings.push("Teacher checkpoint is not downloaded locally; Phase 3 contract is ready, but no distillation run has been executed.");
}

const status = failures.length === 0
  ? production ? "passed-production-phase3-distillation-plan" : "passed-phase3-distillation-plan"
  : production ? "failed-production-phase3-distillation-plan" : "failed-phase3-distillation-plan";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 3,
  production,
  sourceRegistry: relative(root, sourceRegistryPath),
  datasetManifest: existsSync(datasetManifestPath) ? relative(root, datasetManifestPath) : null,
  datasetReport: existsSync(datasetReportPath) ? relative(root, datasetReportPath) : null,
  trainingConfig: existsSync(trainingConfigPath) ? relative(root, trainingConfigPath) : null,
  teacherManifest: existsSync(teacherManifestPath) ? relative(root, teacherManifestPath) : null,
  privateSyubrajImport: existsSync(privateSyubrajPath) ? relative(root, privateSyubrajPath) : null,
  teacherDownloaded: Boolean(teacherManifest),
  datasetManifestSha256: existsSync(datasetManifestPath) ? sha256File(datasetManifestPath) : null,
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

function readJsonIfExists(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label} JSON at ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
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
    command: "node scripts/check-neural-distillation-plan.mjs",
    suite: "neural-distillation-plan",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
