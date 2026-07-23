#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-sota-worldclass-production-report.json" : "neural-sota-worldclass-report.json");
const failures = [];
const warnings = [];

const reportFiles = {
  phase0Contract: "reports/neural-production-contract-report.json",
  phase1Gold: production ? "reports/neural-gold-eval-production-report.json" : "reports/neural-gold-eval-report.json",
  phase2Dataset: production ? "reports/neural-open-vocab-dataset-production-report.json" : "reports/neural-open-vocab-dataset-report.json",
  phase3Distillation: production ? "reports/neural-distillation-plan-production-report.json" : "reports/neural-distillation-plan-report.json",
  phase4TrainingContract: production ? "reports/neural-training-contract-production-report.json" : "reports/neural-training-contract-report.json",
  phase5Evaluation: production ? "reports/neural-open-vocab-evaluation-production.json" : "reports/neural-open-vocab-evaluation.json",
  phase5Benchmark: production ? "reports/neural-coreml-device-benchmark-production.json" : "reports/neural-coreml-device-benchmark.json",
  phase6NativeIntegration: production ? "reports/neural-native-integration-production-report.json" : "reports/neural-native-integration-report.json",
  phase7ReviewIntake: production ? "reports/neural-review-intake-production-report.json" : "reports/neural-review-intake-report.json",
  phase8TrainingRun: production ? "reports/neural-training-run-readiness-production-report.json" : "reports/neural-training-run-readiness-report.json",
  phase9Promotion: production ? "reports/neural-production-promotion-production-report.json" : "reports/neural-production-promotion-report.json",
  modelSelection: production ? "reports/neural-model-selection-production-report.json" : "reports/neural-model-selection-report.json",
  readiness: production ? "reports/neural-transliteration-readiness-production-report.json" : "reports/neural-transliteration-readiness-report.json"
};
const modelDir = "models/macos/LekhNeuralTransliterator.mlmodelc";
const manifestPath = "models/macos/LekhNeuralTransliterator.manifest.json";
const rejectedManifest = "models/rejected/closed-vocabulary-baseline/LekhNeuralTransliterator.rejected.manifest.json";
const oldNeuralSwift = "native/macos-imk/skeleton/LekhNeuralTransliterator.swift";
const engineSource = "native/macos-imk/skeleton/LekhEngineCore.swift";
const packageScript = "scripts/package-macos-imk-dev.mjs";
const level5Report = "docs/LEKH_LEVEL5_FORENSIC_TRANSFORMATION_REPORT.md";

const reports = Object.fromEntries(
  Object.entries(reportFiles).map(([key, path]) => [key, readJsonReport(path, production)])
);

const modelExists = existsSync(join(root, modelDir));
const manifest = existsSync(join(root, manifestPath)) ? readJsonReport(manifestPath, production) : null;
const datasetRows = Number(reports.phase2Dataset?.totalRows);
const canonicalTrainingSource = "ai4bharat-aksharantar-nepali";
const blockedMirrorSources = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];
const aksharantarRows = Number(reports.phase2Dataset?.sourceCounts?.[canonicalTrainingSource] ?? 0);
const blockedMirrorRows = Object.fromEntries(blockedMirrorSources.map((sourceId) => [
  sourceId,
  Number(reports.phase2Dataset?.sourceCounts?.[sourceId] ?? 0)
]));

requireDevStatus("phase0Contract", /^passed$/u);
requireDevStatus("phase1Gold", /^passed-/u);
requireDevStatus("phase2Dataset", /^passed-/u);
requireDevStatus("phase3Distillation", /^passed-/u);
requireDevStatus("phase4TrainingContract", /^passed-/u);
requireDevStatus("phase5Evaluation", /^passed-/u);
requireDevStatus("phase5Benchmark", /^passed-/u);
requireDevStatus("phase6NativeIntegration", /^passed-/u);
requireDevStatus("phase7ReviewIntake", /^passed-/u);
requireDevStatus("phase8TrainingRun", /^passed-phase8-/u);
requireDevStatus("phase9Promotion", /^passed-/u);
requireDevStatus("modelSelection", /^passed$/u);
requireDevStatus("readiness", /^passed$/u);

if (!Number.isFinite(datasetRows) || datasetRows < 1_000_000) {
  failures.push(`Phase 10 requires >=1,000,000 generated open-vocab rows; found ${datasetRows || 0}.`);
}
if (!Number.isFinite(aksharantarRows) || aksharantarRows < 1_000_000) {
  failures.push(`Phase 10 requires >=1,000,000 canonical ${canonicalTrainingSource} rows in the generated dataset; found ${aksharantarRows || 0}.`);
}
for (const [sourceId, rows] of Object.entries(blockedMirrorRows)) {
  if (!Number.isFinite(rows) || rows !== 0) {
    failures.push(`Phase 10 requires blocked lineage mirror ${sourceId} to contribute 0 rows; found ${Number.isFinite(rows) ? rows : "invalid"}.`);
  }
}
if (!existsSync(join(root, rejectedManifest))) failures.push("Rejected closed-vocabulary manifest must remain quarantined under models/rejected.");
if (existsSync(join(root, oldNeuralSwift))) failures.push("Old synchronous/closed-vocab LekhNeuralTransliterator.swift must remain deleted.");
const engine = readText(engineSource);
const packager = readText(packageScript);
const reportText = readText(level5Report);
if (!engine.includes("LekhNeuralCandidateService.shared.status")) {
  failures.push("Native engine must report the actual async Core ML neural tail status.");
}
if (!packager.includes("LEKH_PACKAGE_NEURAL_MODEL") || !packager.includes("neuralPackagingRequested")) {
  failures.push("Dev packager must keep neural model packaging behind an explicit opt-in gate.");
}
if (!reportText.includes("Until every checkbox has evidence, Lekh is not Level 5")) {
  failures.push("Level 5 report must retain evidence-before-production language.");
}

if (!manifest) {
  if (production) failures.push("Production Phase 10 requires models/macos/LekhNeuralTransliterator.manifest.json.");
  else warnings.push("No production neural manifest exists; Phase 10 cannot verify a working production model.");
} else {
  if (manifest.selectedArtifact !== "lekh-open-vocab-seq2seq-v1") failures.push("Production neural manifest must select lekh-open-vocab-seq2seq-v1.");
  if (manifest.productionEligible !== true) {
    if (production) failures.push("Production neural manifest must declare productionEligible=true.");
    else warnings.push("Candidate neural manifest exists but is not productionEligible=true.");
  }
  if (manifest.openVocabulary !== true) failures.push("Production neural manifest must declare openVocabulary=true.");
  if (manifest.neuralTailOnly !== true) failures.push("Production neural manifest must declare neuralTailOnly=true.");
  const manifestTrainingSources = new Set((manifest.trainingSources ?? []).map(String));
  if (!manifestTrainingSources.has(canonicalTrainingSource)) {
    failures.push(`Production neural manifest must include canonical training source ${canonicalTrainingSource}.`);
  }
  for (const mirrorSource of blockedMirrorSources) {
    if (manifestTrainingSources.has(mirrorSource)) {
      failures.push(`Production neural manifest must not count blocked lineage mirror ${mirrorSource} as training evidence.`);
    }
  }
}
if (!modelExists) {
  if (production) failures.push("Production Phase 10 requires compiled Core ML model.");
  else warnings.push("No compiled production Core ML model exists; native runtime correctly remains deterministic-only.");
}

if (production) {
  requireProductionStatus("phase7ReviewIntake", /^passed-production-/u);
  requireProductionStatus("phase8TrainingRun", /^passed-production-|^passed-phase8-training-run-complete$/u);
  requireProductionStatus("phase9Promotion", /^passed-production-/u);
  requireProductionStatus("phase5Evaluation", /^passed-production-/u);
  requireProductionStatus("phase5Benchmark", /^passed-production-/u);
  requireProductionStatus("phase6NativeIntegration", /^passed-production-/u);
  if (reports.phase5Evaluation?.metrics?.tailTop1Accuracy < 0.88) failures.push("Production Phase 10 requires tailTop1Accuracy >= 0.88.");
  if (reports.phase5Evaluation?.metrics?.tailTop3Accuracy < 0.96) failures.push("Production Phase 10 requires tailTop3Accuracy >= 0.96.");
  if (reports.phase5Benchmark?.performance?.p99Ms > 3 || reports.phase5Benchmark?.performance?.p99Ms == null) failures.push("Production Phase 10 requires measured Core ML p99 <= 3 ms.");
  if (reports.phase5Benchmark?.performance?.measuredOnDevice !== true) failures.push("Production Phase 10 requires real on-device benchmark evidence.");
}

const status = failures.length === 0
  ? production ? "passed-production-phase10-sota-worldclass" : "passed-phase10-sota-worldclass-guard"
  : production ? "failed-production-phase10-sota-worldclass" : "failed-phase10-sota-worldclass";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 10,
  production,
  model: modelDir,
  manifest: manifestPath,
  modelExists,
  manifestExists: Boolean(manifest),
  datasetRows,
  aksharantarRows,
  sourceLineagePolicy: {
    canonicalTrainingSource,
    blockedMirrorRows
  },
  reportFiles,
  reportStatuses: Object.fromEntries(Object.entries(reports).map(([key, report]) => [key, report?.status ?? null])),
  verdict: production && failures.length === 0
    ? "production-neural-model-verified"
    : "production-neural-model-not-verified-no-artifact-or-production-evidence",
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

function readJsonReport(path, required) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    if (required) failures.push(`Missing required report: ${path}.`);
    else warnings.push(`Missing dev report: ${path}. Run npm run check:neural-transliteration.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (error) {
    failures.push(`Invalid JSON report ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readText(path) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    failures.push(`Missing source file: ${path}.`);
    return "";
  }
  return readFileSync(fullPath, "utf8");
}

function requireDevStatus(key, pattern) {
  const status = reports[key]?.status;
  if (!status || !pattern.test(status)) failures.push(`Phase 10 requires ${key} report to pass; got ${status ?? "missing"}.`);
}

function requireProductionStatus(key, pattern) {
  const status = reports[key]?.status;
  if (!status || !pattern.test(status)) failures.push(`Production Phase 10 requires ${key} production report to pass; got ${status ?? "missing"}.`);
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-sota-worldclass.mjs",
    suite: "neural-sota-worldclass",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), verdict: report.verdict, failures, warnings }, null, 2));
  process.exit(exitCode);
}
