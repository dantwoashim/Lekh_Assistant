#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const measurementsPath = args.get("measurements");
const reportPath = args.get("report") ?? join(root, "reports", "neural-coreml-device-benchmark.json");
const modelDir = join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const manifestPath = join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const failures = [];
const warnings = [];

let measurements = [];
if (measurementsPath) {
  measurements = loadMeasurements(measurementsPath);
} else if (production) {
  failures.push("Production Phase 5 requires --measurements JSON from real packaged Core ML device runs.");
} else {
  warnings.push("No device measurements supplied; benchmark harness is complete but no production latency evidence exists.");
}

const architectures = new Set(measurements.map((row) => row.architecture));
const p99Values = measurements.map((row) => Number(row.p99Ms)).filter(Number.isFinite);
const p50Values = measurements.map((row) => Number(row.p50Ms)).filter(Number.isFinite);
const p95Values = measurements.map((row) => Number(row.p95Ms)).filter(Number.isFinite);
const summary = {
  p50Ms: p50Values.length ? round(Math.max(...p50Values)) : null,
  p95Ms: p95Values.length ? round(Math.max(...p95Values)) : null,
  p99Ms: p99Values.length ? round(Math.max(...p99Values)) : null,
  targetP99Ms: 3,
  measuredOnDevice: measurements.length > 0,
  devices: measurements
};

if (production) {
  if (!existsSync(modelDir)) failures.push("Production benchmark requires models/macos/LekhNeuralTransliterator.mlmodelc.");
  if (!existsSync(manifestPath)) failures.push("Production benchmark requires models/macos/LekhNeuralTransliterator.manifest.json.");
  for (const requiredArch of ["arm64", "x86_64"]) {
    if (!architectures.has(requiredArch)) failures.push(`Production benchmark requires a ${requiredArch} device measurement.`);
  }
  if (summary.p99Ms === null || summary.p99Ms > 3) failures.push(`Production neural p99 must be <=3 ms; got ${summary.p99Ms}.`);
}

for (const row of measurements) {
  if (!["arm64", "x86_64"].includes(row.architecture)) failures.push(`Unknown benchmark architecture ${row.architecture}.`);
  if (Number(row.p99Ms) > 3) failures.push(`Device ${row.name} p99Ms exceeds 3 ms: ${row.p99Ms}.`);
  if (row.packagedApp !== true) failures.push(`Device ${row.name} must benchmark the packaged app, not a notebook or simulator.`);
  if (row.secureFieldInferenceCount !== 0) failures.push(`Device ${row.name} secureFieldInferenceCount must be 0.`);
}

const status = failures.length === 0
  ? measurements.length
    ? production ? "passed-production-phase5-coreml-benchmark" : "passed-phase5-coreml-benchmark-with-measurements"
    : "passed-phase5-coreml-benchmark-harness-no-model"
  : production ? "failed-production-phase5-coreml-benchmark" : "failed-phase5-coreml-benchmark";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 5,
  production,
  model: relative(root, modelDir),
  manifest: relative(root, manifestPath),
  measurements: measurementsPath ? relative(root, measurementsPath) : null,
  performance: summary,
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

function loadMeasurements(pathValue) {
  const path = join(root, pathValue);
  if (!existsSync(path)) {
    failures.push(`Missing measurements JSON: ${pathValue}.`);
    return [];
  }
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(json.devices) ? json.devices : Array.isArray(json.measurements) ? json.measurements : [];
  } catch (error) {
    failures.push(`Invalid measurements JSON at ${pathValue}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/benchmark-neural-coreml-device.mjs",
    suite: "neural-coreml-device-benchmark",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
