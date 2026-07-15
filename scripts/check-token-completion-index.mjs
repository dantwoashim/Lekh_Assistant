#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildCompletionArtifact,
  manifestFor,
  readJson,
  serializeJson,
  sha256,
  validateArtifactShape
} from "./token-completion-lib.mjs";

const ROOT = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const seedsPath = join(ROOT, "data/completion/v1/token-completion-seeds.json");
const registryPath = join(ROOT, "data/completion/v1/source-registry.json");
const evaluationPath = join(ROOT, "data/completion/v1/eval-regression.json");
const artifactPath = join(ROOT, "data/completion/runtime/v1/lekh-token-completions.v1.json");
const manifestPath = join(ROOT, "data/completion/runtime/v1/lekh-token-completions.v1.manifest.json");
const reportPath = join(
  ROOT,
  production
    ? "reports/token-completion-production-quality-report.json"
    : "reports/token-completion-quality-report.json"
);
const failures = [];

for (const path of [seedsPath, registryPath, evaluationPath, artifactPath, manifestPath]) {
  if (!existsSync(path)) failures.push(`Missing token-completion artifact: ${relative(ROOT, path)}.`);
}

let expected = null;
let artifact = null;
let manifest = null;
if (failures.length === 0) {
  const seeds = readJson(seedsPath);
  const registry = readJson(registryPath);
  const evaluation = readJson(evaluationPath);
  expected = buildCompletionArtifact({ seeds, registry, evaluation });
  failures.push(...expected.failures);
  artifact = readJson(artifactPath);
  manifest = readJson(manifestPath);
  failures.push(...validateArtifactShape(artifact));
  const expectedArtifactBytes = serializeJson(expected.artifact);
  const actualArtifactBytes = readFileSync(artifactPath, "utf8");
  if (actualArtifactBytes !== expectedArtifactBytes) failures.push("Runtime completion artifact is stale or nondeterministic.");
  const expectedManifest = manifestFor({
    artifactBytes: expectedArtifactBytes,
    seedsPath,
    registryPath,
    evaluationPath,
    provenancePaths: {
      seedSet: relative(ROOT, seedsPath),
      sourceRegistry: relative(ROOT, registryPath),
      regressionEvaluation: relative(ROOT, evaluationPath)
    },
    seedCount: seeds.rows.length,
    evaluation: expected.evaluation
  });
  if (serializeJson(manifest) !== serializeJson(expectedManifest)) failures.push("Runtime completion manifest is stale or nondeterministic.");
  if (manifest.artifact?.sha256 !== sha256(actualArtifactBytes)) failures.push("Completion manifest artifact SHA-256 mismatch.");
  if (manifest.artifact?.bytes !== Buffer.byteLength(actualArtifactBytes)) failures.push("Completion manifest artifact byte count mismatch.");
  if (manifest.quality?.explicitSuggestionRuntimeEligible !== true) failures.push("Explicit completion runtime eligibility gate did not pass.");
  if (manifest.quality?.regressionPositiveTop1Accuracy !== 1) failures.push("Repository positive completion regression must be exact.");
  if (manifest.quality?.regressionNegativeSuppressionRate !== 1) failures.push("Repository negative completion suppression must be exact.");
  if (production) {
    if (manifest.quality?.productionQualityClaimEligible !== true) failures.push("Production completion quality gate is blocked: no human-rated promotion evidence.");
    if (Number(manifest.quality?.humanRatedHoldoutRows ?? 0) < 500) failures.push("Production completion gate requires at least 500 frozen native-speaker-rated holdout rows.");
  }
}

const lookup = new Map((artifact?.entries ?? []).map((entry) => [entry.prefix, entry.candidates]));
const lookupSamples = [];
for (let iteration = 0; iteration < 20000; iteration += 1) {
  const started = process.hrtime.bigint();
  lookup.get(iteration % 2 === 0 ? "lekh" : "missing-prefix");
  lookupSamples.push(Number(process.hrtime.bigint() - started));
}
lookupSamples.sort((a, b) => a - b);
const lookupP99Nanoseconds = lookupSamples[Math.floor((lookupSamples.length - 1) * 0.99)] ?? null;

const report = {
  generatedAt: new Date().toISOString(),
  command: production
    ? "node scripts/check-token-completion-index.mjs --production"
    : "node scripts/check-token-completion-index.mjs",
  suite: "token-completion-quality",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed" : production ? "failed-production-gates" : "failed",
  production,
  artifact: relative(ROOT, artifactPath),
  manifest: relative(ROOT, manifestPath),
  entries: artifact?.entries?.length ?? 0,
  candidates: artifact?.entries?.reduce((sum, entry) => sum + entry.candidates.length, 0) ?? 0,
  runtimePolicy: artifact?.runtimePolicy ?? null,
  quality: manifest?.quality ?? null,
  performance: {
    implementation: "prebuilt-prefix-hash-map-no-runtime-scan",
    samples: lookupSamples.length,
    javascriptReferenceLookupP99Nanoseconds: lookupP99Nanoseconds,
    nativeReleaseGate: "LekhInputMethodBehaviorProbe deterministic full-engine p99 < 5 ms"
  },
  failures
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console[failures.length === 0 ? "log" : "error"](JSON.stringify(report, null, 2));
if (failures.length > 0) process.exit(1);
