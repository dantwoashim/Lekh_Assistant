#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
  evaluateNeuralPredictions,
  validateNeuralEvaluationSafety,
  validateNeuralPredictionRows
} from "./lib/neural-evaluation.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const optionalPredictionsPath = args.get("predictions-if-present");
const predictionsPath = args.get("predictions") ?? (
  optionalPredictionsPath && existsSync(join(process.cwd(), optionalPredictionsPath))
    ? optionalPredictionsPath
    : undefined
);
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-open-vocab-evaluation-production.json" : "neural-open-vocab-evaluation.json");
const goldManifestPath = join(root, "data", "neural", "gold", "manifest.v2.json");
const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
const failures = [];
const warnings = [];

const goldManifest = readJsonIfExists(goldManifestPath, "gold manifest");
const datasetManifest = readJsonIfExists(datasetManifestPath, "open-vocab dataset manifest");
let goldRows = [];
if (goldManifest) {
  goldRows = loadGoldRows(goldManifest);
}

let predictionRows = [];
if (predictionsPath) {
  predictionRows = loadPredictionRows(predictionsPath);
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
const metrics = evaluateNeuralPredictions(goldRows, predictionValidation, "test");
const metricsBySplit = predictionValidation.metricsReportable
  ? Object.fromEntries(
      ["train", "dev", "test", "all"].map((split) => [
        split,
        evaluateNeuralPredictions(goldRows, predictionValidation, split)
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
  goldManifest: relative(root, goldManifestPath),
  datasetManifest: existsSync(datasetManifestPath) ? relative(root, datasetManifestPath) : null,
  predictions: predictionsPath ? relative(root, predictionsPath) : null,
  predictionRows: predictionRows.length,
  goldRows: goldRows.length,
  promotionSplit: "test",
  metrics,
  metricsBySplit,
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
  const path = join(root, pathValue);
  if (!existsSync(path)) {
    failures.push(`Missing predictions JSONL: ${pathValue}.`);
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        failures.push(`Invalid prediction JSONL ${pathValue}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        return { id: `invalid-${index}`, input: "invalid", candidates: [] };
      }
    });
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
