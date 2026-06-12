#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const modelDir = args.get("model") ?? join(ROOT, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const manifestPath = args.get("manifest") ?? join(ROOT, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const datasetDir = args.get("dataset-dir") ?? join(ROOT, "data", "generated", "neural-transliteration");
const reportPath = args.get("report") ?? join(ROOT, "reports", "neural-transliteration-readiness-report.json");
const failures = [];
const warnings = [];

if (!existsSync(datasetDir)) {
  failures.push("Neural transliteration dataset is missing. Run npm run neural:dataset.");
} else {
  for (const split of ["train.tsv", "dev.tsv", "test.tsv"]) {
    const path = join(datasetDir, split);
    if (!existsSync(path)) failures.push(`Dataset split missing: ${relative(ROOT, path)}`);
  }
}

const modelExists = existsSync(modelDir);
const manifestExists = existsSync(manifestPath);
let manifest = null;

if (!modelExists) {
  const message = "Core ML model is missing: models/macos/LekhNeuralTransliterator.mlmodelc";
  if (production) failures.push(message);
  else warnings.push(message);
}

if (!manifestExists) {
  const message = "Core ML model manifest is missing: models/macos/LekhNeuralTransliterator.manifest.json";
  if (production) failures.push(message);
  else warnings.push(message);
} else {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const params = Number(manifest.parameterCount);
  if (!Number.isFinite(params) || params < 1_000_000 || params > 5_000_000) {
    failures.push("Model parameterCount must be between 1M and 5M.");
  }
  if (manifest.runtime !== "CoreML") failures.push("Model manifest runtime must be CoreML.");
  if (manifest.selectedArtifact !== "lekh-small-coreml-student-v1") {
    failures.push("Model manifest selectedArtifact must be lekh-small-coreml-student-v1.");
  }
  if (manifest.localOnly !== true) failures.push("Model manifest must declare localOnly=true.");
  const trainingSources = new Set((manifest.trainingSources ?? []).map(String));
  for (const requiredSource of ["syubraj-roman2nepali-transliteration"]) {
    if (!trainingSources.has(requiredSource)) {
      failures.push(`Model manifest trainingSources must include ${requiredSource}.`);
    }
  }
  if (manifest.neuralTailOnly !== true) failures.push("Model manifest must declare neuralTailOnly=true.");
  if (Number(manifest.metrics?.tailTop1Accuracy) < 0.82) failures.push("tailTop1Accuracy must be >= 0.82.");
  if (Number(manifest.metrics?.chatConventionTop1Accuracy) < 0.90) failures.push("chatConventionTop1Accuracy must be >= 0.90.");
  if (Number(manifest.performance?.p99Ms) > 3) failures.push("Core ML p99 latency must be <= 3ms.");
  for (const [input, expected] of Object.entries({
    vato: "बाटो",
    bato: "बाटो",
    baato: "बाटो",
    chha: "छ",
    cha: "छ",
    xa: "छ",
    xaina: "छैन"
  })) {
    if (manifest.requiredCases?.[input] !== expected) {
      failures.push(`Model manifest missing required case ${input} -> ${expected}.`);
    }
  }
}

let modelBytes = 0;
if (modelExists) {
  modelBytes = directoryBytes(modelDir);
  if (modelBytes > 16 * 1024 * 1024) failures.push("Compiled Core ML model must stay under 16 MB.");
}

const report = {
  status: failures.length === 0 ? (modelExists ? "passed" : "passed-no-model-dev") : "failed",
  production,
  model: relative(ROOT, modelDir),
  manifest: relative(ROOT, manifestPath),
  datasetDir: relative(ROOT, datasetDir),
  modelExists,
  manifestExists,
  modelBytes,
  manifest,
  failures,
  warnings,
  policy: {
    deterministicFastPathFirst: true,
    neuralTailOnly: true,
    noNetworkInference: true,
    noTextTelemetry: true
  }
};

finish(report.status, report, failures.length === 0 ? 0 : 1);

function directoryBytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + directoryBytes(join(path, entry)), 0);
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-transliteration-readiness.mjs",
    suite: "neural-transliteration-readiness",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
