#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-production-promotion-production-report.json" : "neural-production-promotion-report.json");
const failures = [];
const warnings = [];

const requiredReports = {
  dataset: production ? "reports/neural-open-vocab-dataset-production-report.json" : "reports/neural-open-vocab-dataset-report.json",
  trainingRun: production ? "reports/neural-training-run-readiness-production-report.json" : "reports/neural-training-run-readiness-report.json",
  evaluation: production ? "reports/neural-open-vocab-evaluation-production.json" : "reports/neural-open-vocab-evaluation.json",
  benchmark: production ? "reports/neural-coreml-device-benchmark-production.json" : "reports/neural-coreml-device-benchmark.json",
  nativeIntegration: production ? "reports/neural-native-integration-production-report.json" : "reports/neural-native-integration-report.json",
  runtimeConformance: production
    ? "reports/neural-runtime-manifest-conformance-production-report.json"
    : "reports/neural-runtime-manifest-conformance-report.json",
  modelSelection: production ? "reports/neural-model-selection-production-report.json" : "reports/neural-model-selection-report.json",
  readiness: production ? "reports/neural-transliteration-readiness-production-report.json" : "reports/neural-transliteration-readiness-report.json"
};
const modelDir = "models/macos/LekhNeuralTransliterator.mlmodelc";
const manifestPath = "models/macos/LekhNeuralTransliterator.manifest.json";

const loadedReports = {};
for (const [name, path] of Object.entries(requiredReports)) {
  loadedReports[name] = readReport(path, production);
}

const manifest = existsSync(join(root, manifestPath)) ? readReport(manifestPath, production) : null;
const modelExists = existsSync(join(root, modelDir));

if (!modelExists) {
  if (production) failures.push("Production Phase 9 requires compiled Core ML model.");
  else warnings.push("Compiled production Core ML model is absent; promotion guard is active.");
}
if (!manifest) {
  if (production) failures.push("Production Phase 9 requires production manifest.");
  else warnings.push("Production neural manifest is absent; promotion guard is active.");
} else {
  if (manifest.selectedArtifact !== "lekh-open-vocab-seq2seq-v1") failures.push("Promotion manifest must select lekh-open-vocab-seq2seq-v1.");
  if (manifest.productionEligible !== true) {
    if (production) failures.push("Promotion manifest must declare productionEligible=true.");
    else warnings.push("Candidate manifest exists but is not productionEligible=true; production promotion remains blocked.");
  }
}

const datasetRows = Number(loadedReports.dataset?.totalRows);
if (!Number.isFinite(datasetRows) || datasetRows < 1_000_000) failures.push(`Promotion requires >=1,000,000 cleaned rows; found ${datasetRows || 0}.`);
if (production) {
  requireReportStatus("trainingRun", /^passed-production-|^passed-phase8-training-run-complete$/u);
  requireReportStatus("evaluation", /^passed-production-/u);
  requireReportStatus("benchmark", /^passed-production-/u);
  requireReportStatus("nativeIntegration", /^passed-production-/u);
  requireReportStatus("runtimeConformance", /^passed-production-runtime-conformance$/u);
  requireReportStatus("modelSelection", /^passed$/u);
  requireReportStatus("readiness", /^passed$/u);
}

const status = failures.length === 0
  ? production ? "passed-production-phase9-promotion" : "passed-phase9-promotion-guard"
  : production ? "failed-production-phase9-promotion" : "failed-phase9-promotion";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 9,
  production,
  model: modelDir,
  manifest: manifestPath,
  modelExists,
  manifestExists: Boolean(manifest),
  requiredReports,
  reportStatuses: Object.fromEntries(Object.entries(loadedReports).map(([name, report]) => [name, report?.status ?? null])),
  datasetRows,
  failures,
  warnings
});

function requireReportStatus(name, pattern) {
  const status = loadedReports[name]?.status;
  if (!status || !pattern.test(status)) failures.push(`Production Phase 9 requires ${name} report to pass production status; got ${status ?? "missing"}.`);
}

function readReport(path, required) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    if (required) failures.push(`Missing required Phase 9 report: ${path}.`);
    else warnings.push(`Optional promotion report missing in dev: ${path}.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (error) {
    failures.push(`Invalid JSON report ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
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

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-production-promotion.mjs",
    suite: "neural-production-promotion",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
