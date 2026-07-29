#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  evaluateNeuralPredictions,
  validateNeuralEvaluationSafety,
  validateNeuralPredictionRows
} from "./lib/neural-evaluation.mjs";
import {
  isCTCFinitePathDecoderPolicy
} from "./lib/neural-ctc-finite-path-contract.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const optionalPredictionsPath = args.get("predictions-if-present");
const predictionsPath = args.get("predictions") ?? (
  optionalPredictionsPath && existsSync(resolve(root, optionalPredictionsPath))
    ? optionalPredictionsPath
    : undefined
);
const predictionsAbsolutePath = predictionsPath ? resolve(root, predictionsPath) : null;
const exportReportPath = resolve(
  root,
  args.get("export-report") ?? (
    predictionsAbsolutePath
      ? join(dirname(predictionsAbsolutePath), "export-report.json")
      : "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2/export-report.json"
  )
);
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-open-vocab-evaluation-production.json" : "neural-open-vocab-evaluation.json");
const goldManifestPath = resolve(root, args.get("gold-manifest") ?? "data/neural/gold/manifest.v3.json");
const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
const failures = [];
const warnings = [];

const goldManifest = readJsonIfExists(goldManifestPath, "gold manifest");
const datasetManifest = readJsonIfExists(datasetManifestPath, "open-vocab dataset manifest");
const exportReport = predictionsPath
  ? readJsonIfExists(exportReportPath, "candidate export report")
  : null;
let goldRows = [];
if (goldManifest) {
  goldRows = loadGoldRows(goldManifest);
}

let predictionRows = [];
if (predictionsPath) {
  predictionRows = loadPredictionRows(predictionsAbsolutePath);
} else if (production) {
  failures.push("Production Phase 5 requires --predictions JSONL from the exported Core ML model.");
} else {
  warnings.push("No model predictions supplied; evaluation harness is complete but accuracy is not production evidence.");
}

const predictionValidation = predictionsPath
  ? validateNeuralPredictionRows(predictionRows, goldRows)
  : {
      valid: true,
      exactCoverage: false,
      metricsReportable: false,
      issueCodes: [],
      predictionsById: new Map()
    };
failures.push(...predictionValidation.issueCodes);
const evidenceBinding = bindExportEvidence();
const metrics = evaluateNeuralPredictions(goldRows, predictionValidation, "test");
const metricsBySplit = predictionValidation.metricsReportable
  ? Object.fromEntries(
      ["train", "dev", "test", "all"].map((split) => [
        split,
        evaluateNeuralPredictions(goldRows, predictionValidation, split)
      ])
    )
  : null;
const metricsBySuite = predictionValidation.metricsReportable
  ? Object.fromEntries(
      [...new Set(goldRows.map((row) => row.suiteId))].sort().map((suiteId) => [
        suiteId,
        evaluateNeuralPredictions(goldRows.filter((row) => row.suiteId === suiteId), predictionValidation, "all")
      ])
    )
  : null;
if (predictionsPath && !predictionValidation.metricsReportable) {
  failures.push("neural-evaluation.aggregate-metrics-unreportable");
}
if (metrics) {
  const safetyValidation = validateNeuralEvaluationSafety(metrics);
  failures.push(...safetyValidation.issueCodes);
}

if (production && metrics) {
  requireMinimum("tailTop1Accuracy", metrics.tailTop1Accuracy, 0.88);
  requireMinimum("tailTop3Accuracy", metrics.tailTop3Accuracy, 0.96);
  requireMinimum("chatConventionTop1Accuracy", metrics.chatConventionTop1Accuracy, 0.92);
  requireMinimum("chatConventionTop3Accuracy", metrics.chatConventionTop3Accuracy, 0.98);
  requireMinimum("namesTop3Accuracy", metrics.namesTop3Accuracy, 0.90);
}

const status = failures.length === 0
  ? predictionsPath
    ? production ? "passed-production-phase5-evaluation" : "passed-phase5-evaluation-with-predictions"
    : "passed-phase5-evaluation-harness-no-model"
  : production ? "failed-production-phase5-evaluation" : "failed-phase5-evaluation";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 5,
  production,
  metricUnit: "suite-assertion",
  metricUnitDescription: "Each gold row is one suite assertion; compatible repeated input/context assertions remain separate metric observations.",
  goldManifest: relative(root, goldManifestPath),
  goldManifestSha256: evidenceBinding?.goldManifestSha256 ?? null,
  goldCorpusSha256: evidenceBinding?.goldCorpusSha256 ?? goldManifest?.corpusSha256 ?? null,
  datasetManifest: existsSync(datasetManifestPath) ? relative(root, datasetManifestPath) : null,
  datasetManifestSha256: evidenceBinding?.datasetManifestSha256 ?? null,
  datasetContentSha256: evidenceBinding?.datasetContentSha256 ?? datasetManifest?.datasetContentSha256 ?? null,
  candidateManifest: evidenceBinding?.candidateManifest ?? null,
  candidateManifestSha256: evidenceBinding?.candidateManifestSha256 ?? null,
  exportReport: exportReport ? relative(root, exportReportPath) : null,
  exportReportSha256: evidenceBinding?.exportReportSha256 ?? null,
  trainingRunId: evidenceBinding?.trainingRunId ?? null,
  exportRunId: evidenceBinding?.exportRunId ?? null,
  artifactIdentity: evidenceBinding?.artifactIdentity ?? null,
  predictions: predictionsAbsolutePath ? relative(root, predictionsAbsolutePath) : null,
  predictionsSha256: evidenceBinding?.predictionsSha256 ?? null,
  predictionRows: predictionRows.length,
  goldRows: goldRows.length,
  goldSuiteAssertionCount: goldRows.length,
  promotionSplit: "test",
  metrics,
  metricsBySplit,
  metricsBySuite,
  predictionValidation: {
    exactCoverage: predictionValidation.exactCoverage,
    metricsReportable: predictionValidation.metricsReportable,
    issueCodes: predictionValidation.issueCodes
  },
  failures,
  warnings,
  productionEligible: production && failures.length === 0
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
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label} JSON at ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function loadGoldRows(manifest) {
  const rows = [];
  for (const suite of manifest.suites ?? []) {
    const path = join(root, suite.path);
    if (!existsSync(path)) {
      failures.push(`Missing gold suite ${suite.path}.`);
      continue;
    }
    const lines = readFileSync(path, "utf8").split(/\n/u).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      try {
        rows.push({ ...JSON.parse(line), suiteId: suite.id, suitePath: suite.path });
      } catch (error) {
        failures.push(`Invalid JSONL in ${suite.path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return rows;
}

function loadPredictionRows(pathValue) {
  if (!existsSync(pathValue)) {
    failures.push(`Missing predictions JSONL: ${relative(root, pathValue)}.`);
    return [];
  }
  return readFileSync(pathValue, "utf8")
    .split(/\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        failures.push(`Invalid prediction JSONL ${relative(root, pathValue)}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        return { id: `invalid-${index}`, input: "invalid", candidates: [] };
      }
    });
}

function bindExportEvidence() {
  if (!predictionsAbsolutePath || !exportReport || !goldManifest || !datasetManifest) return null;
  const runId = /^[a-f0-9]{32}$/u;
  const digest = /^[a-f0-9]{64}$/u;
  const trainingRunId = exportReport.trainingRunId;
  const exportRunId = exportReport.exportRunId;
  if (!runId.test(String(trainingRunId ?? "")) ||
      !runId.test(String(exportRunId ?? "")) ||
      trainingRunId === exportRunId) {
    failures.push("Evaluation requires distinct valid trainingRunId/exportRunId values from the candidate export report.");
  }
  if (!String(exportReport.status ?? "").startsWith("passed-") ||
      exportReport.productionEligible !== false) {
    failures.push("Evaluation requires an immutable passed candidate export report with productionEligible=false.");
  }
  if (exportReport.runtimeModelContract === "single-transformer-ctc-v1" &&
      !isCTCFinitePathDecoderPolicy(
        exportReport.coremlExport?.finitePathDecoderPolicy
      )) {
    failures.push(
      "Transformer-CTC evaluation requires the exact finite-path decoder policy."
    );
  }

  const predictionsSha256 = sha256File(predictionsAbsolutePath);
  if (resolve(root, String(exportReport.predictions ?? "")) !== predictionsAbsolutePath ||
      exportReport.predictionsSha256 !== predictionsSha256) {
    failures.push("Evaluation predictions do not match the path and SHA-256 bound by the candidate export report.");
  }

  const goldManifestSha256 = sha256File(goldManifestPath);
  if (resolve(root, String(exportReport.goldManifest ?? "")) !== goldManifestPath ||
      exportReport.goldManifestSha256 !== goldManifestSha256 ||
      exportReport.goldCorpusSha256 !== goldManifest.corpusSha256 ||
      exportReport.goldRows !== goldRows.length) {
    failures.push("Evaluation gold corpus does not match the exact candidate export evidence.");
  }

  const datasetManifestSha256 = sha256File(datasetManifestPath);
  const snapshot = exportReport.runInputSnapshot;
  if (snapshot?.dataset?.manifestSha256 !== datasetManifestSha256 ||
      snapshot?.dataset?.contentSha256 !== datasetManifest.datasetContentSha256 ||
      resolve(root, String(snapshot?.dataset?.manifest ?? "")) !== datasetManifestPath) {
    failures.push("Evaluation dataset manifest does not match the candidate run-input snapshot.");
  }

  const candidateManifestPath = resolve(root, String(exportReport.manifest ?? ""));
  if (!existsSync(candidateManifestPath)) {
    failures.push("Candidate manifest bound by the export report is missing.");
    return {
      trainingRunId,
      exportRunId,
      predictionsSha256,
      goldManifestSha256,
      goldCorpusSha256: goldManifest.corpusSha256,
      datasetManifestSha256,
      datasetContentSha256: datasetManifest.datasetContentSha256,
      exportReportSha256: sha256File(exportReportPath),
      candidateManifest: relative(root, candidateManifestPath),
      candidateManifestSha256: null,
      artifactIdentity: null
    };
  }
  const candidateManifest = readJsonIfExists(candidateManifestPath, "candidate manifest");
  const candidateManifestSha256 = sha256File(candidateManifestPath);
  if (exportReport.manifestSha256 !== candidateManifestSha256 ||
      candidateManifest?.trainingRunId !== trainingRunId ||
      candidateManifest?.exportRunId !== exportRunId ||
      candidateManifest?.productionEligible !== false) {
    failures.push("Candidate manifest identity does not match the immutable export report.");
  }

  const artifactIdentity = {
    trainingRunId,
    exportRunId,
    manifestSha256: candidateManifestSha256,
    vocabSha256: candidateManifest?.sha256?.vocabMetadata ?? null,
    compiledModelSha256: candidateManifest?.sha256?.compiledModel ?? null,
    compiledModels: candidateManifest?.sha256?.compiledModels ?? null
  };
  for (const [name, value] of Object.entries(artifactIdentity)) {
    if (["trainingRunId", "exportRunId", "compiledModels"].includes(name)) continue;
    if (value !== null && !digest.test(String(value))) {
      failures.push(`Candidate artifact identity ${name} is not a SHA-256 digest.`);
    }
  }
  return {
    trainingRunId,
    exportRunId,
    predictionsSha256,
    goldManifestSha256,
    goldCorpusSha256: goldManifest.corpusSha256,
    datasetManifestSha256,
    datasetContentSha256: datasetManifest.datasetContentSha256,
    exportReportSha256: sha256File(exportReportPath),
    candidateManifest: relative(root, candidateManifestPath),
    candidateManifestSha256,
    artifactIdentity
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireMinimum(name, value, minimum) {
  if (!Number.isFinite(value) || value < minimum) {
    failures.push(`${name} on the frozen test split must be >=${minimum}; got ${value ?? "not measured"}.`);
  }
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/evaluate-neural-open-vocab-model.mjs",
    suite: "neural-open-vocab-evaluation",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
