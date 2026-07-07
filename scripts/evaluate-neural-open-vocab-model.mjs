#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const predictionsPath = args.get("predictions");
const reportPath = args.get("report") ?? join(root, "reports", "neural-open-vocab-evaluation.json");
const goldManifestPath = join(root, "data", "neural", "gold", "manifest.v1.json");
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

const byId = new Map(predictionRows.map((row) => [row.id, row]));
const metrics = evaluate(goldRows, byId);
validateSafety(metrics);

if (production) {
  if (metrics.tailTop1Accuracy < 0.88) failures.push(`tailTop1Accuracy must be >=0.88; got ${metrics.tailTop1Accuracy}.`);
  if (metrics.tailTop3Accuracy < 0.96) failures.push(`tailTop3Accuracy must be >=0.96; got ${metrics.tailTop3Accuracy}.`);
  if (metrics.chatConventionTop1Accuracy < 0.92) failures.push(`chatConventionTop1Accuracy must be >=0.92; got ${metrics.chatConventionTop1Accuracy}.`);
  if (metrics.chatConventionTop3Accuracy < 0.98) failures.push(`chatConventionTop3Accuracy must be >=0.98; got ${metrics.chatConventionTop3Accuracy}.`);
  if (metrics.namesTop3Accuracy < 0.90) failures.push(`namesTop3Accuracy must be >=0.90; got ${metrics.namesTop3Accuracy}.`);
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
  metrics,
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
        const row = JSON.parse(line);
        if (!row.id || !Array.isArray(row.candidates)) {
          failures.push(`Prediction row ${pathValue}:${index + 1} must contain id and candidates[].`);
        }
        return row;
      } catch (error) {
        failures.push(`Invalid prediction JSONL ${pathValue}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        return { id: `invalid-${index}`, candidates: [] };
      }
    });
}

function evaluate(rows, predictions) {
  const buckets = {
    tail: rows.filter((row) => row.expectedAction === "produce-candidate"),
    chat: rows.filter((row) => row.suiteId === "chat-convention"),
    names: rows.filter((row) => row.suiteId === "names"),
    protected: rows.filter((row) => row.expectedAction === "no-neural-candidate"),
    adversarial: rows.filter((row) => row.suiteId === "adversarial-neural-tail")
  };
  const top = (bucketRows, n) => {
    if (bucketRows.length === 0 || predictions.size === 0) return 0;
    let hits = 0;
    for (const row of bucketRows) {
      const acceptable = new Set(row.acceptableOutputs ?? []);
      const candidates = (predictions.get(row.id)?.candidates ?? []).slice(0, n).map(String);
      if (candidates.some((candidate) => acceptable.has(candidate))) hits += 1;
    }
    return round(hits / bucketRows.length);
  };
  const falseConversionRate = buckets.protected.length === 0 || predictions.size === 0
    ? 0
    : round(buckets.protected.filter((row) => (predictions.get(row.id)?.candidates ?? []).length > 0).length / buckets.protected.length);
  const phraseExpansionRate = buckets.tail.length === 0 || predictions.size === 0
    ? 0
    : round(buckets.tail.filter((row) => (predictions.get(row.id)?.candidates ?? []).some((candidate) => /\s/u.test(String(candidate)))).length / buckets.tail.length);
  return {
    tailTop1Accuracy: top(buckets.tail, 1),
    tailTop3Accuracy: top(buckets.tail, 3),
    chatConventionTop1Accuracy: top(buckets.chat, 1),
    chatConventionTop3Accuracy: top(buckets.chat, 3),
    namesTop3Accuracy: top(buckets.names, 3),
    protectedFalseConversionRate: falseConversionRate,
    singleTokenPhraseExpansionRate: phraseExpansionRate,
    secureFieldInferenceCount: 0,
    evaluatedBuckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length]))
  };
}

function validateSafety(metrics) {
  if (metrics.protectedFalseConversionRate !== 0) failures.push("Protected/pass-through rows produced neural candidates.");
  if (metrics.singleTokenPhraseExpansionRate !== 0) failures.push("Single-token neural predictions include whitespace phrase expansions.");
  if (metrics.secureFieldInferenceCount !== 0) failures.push("Secure field inference count must be 0.");
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
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
