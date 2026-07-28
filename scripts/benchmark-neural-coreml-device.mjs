#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import { validateNeuralDeviceMeasurements } from "./lib/neural-device-measurements.mjs";
import {
  validateNeuralRuntimePlacementEvidence
} from "./lib/neural-runtime-placement-evidence.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const optionalMeasurementsPath = args.get("measurements-if-present");
const measurementsPath = args.get("measurements") ?? (
  optionalMeasurementsPath && existsSync(join(process.cwd(), optionalMeasurementsPath))
    ? optionalMeasurementsPath
    : undefined
);
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-coreml-device-benchmark-production.json" : "neural-coreml-device-benchmark.json");
const artifactRoot = resolve(
  root,
  args.get("artifact-root") ??
    "models/macos/LekhNeuralTransliterator.production"
);
const manifestPath = join(artifactRoot, "LekhNeuralTransliterator.manifest.json");
const vocabPath = join(artifactRoot, "LekhNeuralTransliterator.vocab.json");
const failures = [];
const warnings = [];
let descriptor = null;
if (existsSync(manifestPath) && existsSync(vocabPath)) {
  try {
    descriptor = resolveNeuralArtifactDescriptor({
      repoRoot: root,
      manifestPath,
      vocabPath
    });
  } catch (error) {
    failures.push(`Invalid runtime artifact inventory: ${error.message}`);
  }
}
const manifest = descriptor?.manifest ?? null;

let measurements = [];
let measurementReport = null;
if (measurementsPath) {
  measurementReport = loadMeasurements(measurementsPath);
  measurements = measurementReport.devices;
} else if (production) {
  failures.push("Production Phase 5 requires --measurements JSON from real packaged Core ML device runs.");
} else {
  warnings.push("No device measurements supplied; benchmark harness is complete but no production latency evidence exists.");
}

const p99Values = measurements.map((row) => Number(row.p99Ms)).filter(Number.isFinite);
const p50Values = measurements.map((row) => Number(row.p50Ms)).filter(Number.isFinite);
const p95Values = measurements.map((row) => Number(row.p95Ms)).filter(Number.isFinite);
const summary = {
  p50Ms: p50Values.length ? round(Math.max(...p50Values)) : null,
  p95Ms: p95Values.length ? round(Math.max(...p95Values)) : null,
  p99Ms: p99Values.length ? round(Math.max(...p99Values)) : null,
  targetP99Ms: 50,
  measuredOnDevice: measurements.length > 0,
  devices: measurements
};

const deviceValidation = measurements.length > 0 && descriptor
  ? validateNeuralDeviceMeasurements(measurements, {
      artifactDescriptor: descriptor,
      production
    })
  : null;
if (deviceValidation) {
  failures.push(...deviceValidation.issueCodes);
  warnings.push(...deviceValidation.warnings);
}
const runtimePlacementValidation = descriptor &&
  measurementReport?.computePlacement?.runtimePlacement
  ? validateNeuralRuntimePlacementEvidence(
      measurementReport.computePlacement.runtimePlacement,
      { artifactDescriptor: descriptor }
    )
  : null;
if (runtimePlacementValidation && !runtimePlacementValidation.valid) {
  failures.push(...runtimePlacementValidation.issueCodes);
}

if (production) {
  if (!descriptor) failures.push("Production benchmark requires a complete verified runtime artifact set.");
  if (measurementReport?.status !== "passed-production" ||
      measurementReport?.proofMode !== "production") {
    failures.push("Production benchmark requires a fresh passed-production full-service report.");
  }
  if (descriptor && (
    measurementReport?.artifactIdentity?.manifestSha256 !== descriptor.manifestSha256 ||
    measurementReport?.artifactIdentity?.vocabSha256 !== descriptor.vocabSha256 ||
    measurementReport?.artifactIdentity?.artifactSetSha256 !== descriptor.artifactSetSha256
  )) {
    failures.push("Production benchmark report is stale for the current runtime artifact set.");
  }
  if (!runtimePlacementValidation?.neuralEngineClaimAllowed) {
    failures.push(
      "Production benchmark requires observed Neural Engine execution from " +
      "a correlated Core ML Instruments trace."
    );
  }
  if (summary.p99Ms === null || summary.p99Ms >= 50) failures.push(`Production full-candidate p99 must be <50 ms; got ${summary.p99Ms}.`);
}

const status = failures.length === 0
  ? measurements.length
    ? production ? "passed-production-phase5-coreml-benchmark" : "passed-phase5-coreml-benchmark-with-measurements"
    : "passed-phase5-coreml-benchmark-harness-no-model"
  : production ? "failed-production-phase5-coreml-benchmark" : "failed-phase5-coreml-benchmark";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 5,
  production,
  artifactRoot: relative(root, artifactRoot),
  artifactSetSha256: descriptor?.artifactSetSha256 ?? null,
  models: descriptor?.artifacts.map((artifact) => ({
    role: artifact.role,
    path: artifact.sourceRelativePath,
    bytes: artifact.compiledBytes,
    sha256: artifact.compiledSha256
  })) ?? [],
  manifest: relative(root, manifestPath),
  measurements: measurementsPath ? relative(root, measurementsPath) : null,
  performance: summary,
  computePlacement: deviceValidation ? {
    architectures: deviceValidation.architectures,
    neuralEngineCompatibilityIndicated:
      deviceValidation.neuralEngineCompatibilityIndicated,
    neuralEngineRuntimeObserved:
      runtimePlacementValidation?.neuralEngineClaimAllowed === true,
    neuralEngineClaimAllowed:
      runtimePlacementValidation?.neuralEngineClaimAllowed === true,
    runtimePlacementEvidenceSha256:
      measurementReport?.computePlacement
        ?.runtimePlacementEvidenceSha256 ?? null,
    intelFallbackProven: deviceValidation.intelFallbackProven
  } : null,
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
  const path = resolve(root, pathValue);
  if (!existsSync(path)) {
    failures.push(`Missing measurements JSON: ${pathValue}.`);
    return { devices: [] };
  }
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...json,
      devices: Array.isArray(json.devices)
        ? json.devices
        : Array.isArray(json.measurements)
          ? json.measurements
          : []
    };
  } catch (error) {
    failures.push(`Invalid measurements JSON at ${pathValue}: ${error instanceof Error ? error.message : String(error)}`);
    return { devices: [] };
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
