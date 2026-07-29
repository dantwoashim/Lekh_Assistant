#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Ajv2020 from "ajv/dist/2020.js";
import {
  neuralRuntimeContractMetadata,
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const artifactRoot = resolve(
  root,
  args.get("artifact-root") ??
    "models/macos/LekhNeuralTransliterator.production"
);
const manifestPath = resolve(
  root,
  args.get("manifest") ??
    join(artifactRoot, "LekhNeuralTransliterator.manifest.json")
);
const vocabPath = resolve(
  root,
  args.get("vocab") ??
    join(artifactRoot, "LekhNeuralTransliterator.vocab.json")
);
const datasetDir = resolve(
  root,
  args.get("dataset-dir") ?? "data/generated/neural-open-vocab"
);
const reportPath = resolve(
  root,
  args.get("report") ?? (
    production
      ? "reports/neural-transliteration-readiness-production-report.json"
      : "reports/neural-transliteration-readiness-report.json"
  )
);
const schemaPath = join(
  root,
  "data",
  "neural",
  "schema",
  "lekh-neural-manifest.schema.json"
);
const canonicalTrainingSource = "ai4bharat-aksharantar-nepali";
const blockedMirrorSources = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];
const failures = [];
const warnings = [];

for (const split of ["manifest.json", "train.jsonl", "dev.jsonl", "test.jsonl"]) {
  const path = join(datasetDir, split);
  if (!existsSync(path)) {
    failures.push(`Dataset artifact is missing: ${relative(root, path)}.`);
  }
}

let descriptor = null;
let manifest = null;
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`Manifest is invalid JSON: ${error.message}`);
  }
}
if (existsSync(manifestPath) && existsSync(vocabPath)) {
  try {
    descriptor = resolveNeuralArtifactDescriptor({
      repoRoot: root,
      manifestPath,
      vocabPath
    });
  } catch (error) {
    failures.push(`Runtime artifact inventory is invalid: ${error.message}`);
  }
} else {
  const message =
    "No complete manifest/vocabulary pair exists in the selected neural artifact root.";
  if (production) failures.push(message);
  else warnings.push(message);
}

manifest = descriptor?.manifest ?? manifest;
if (manifest) {
  validateTrainingSources(manifest);
  if (descriptor) validateCommonManifest(manifest);
  if (production && descriptor) validateProductionManifest(manifest);
  else if (descriptor && manifest.productionEligible !== true) {
    warnings.push(
      "The selected runtime artifact remains an unpromoted candidate; " +
      "placeholder quality/performance values are not release evidence."
    );
  }
}

const status = failures.length === 0
  ? descriptor ? "passed" : "passed-no-model-dev"
  : "failed";
finish(status, failures.length === 0 ? 0 : 1);

function validateCommonManifest(manifestValue) {
  if (manifestValue.runtime !== "CoreML") {
    failures.push("Model manifest runtime must be CoreML.");
  }
  if (manifestValue.localOnly !== true) {
    failures.push("Model manifest must declare localOnly=true.");
  }
  if (manifestValue.neuralTailOnly !== true) {
    failures.push("Model manifest must declare neuralTailOnly=true.");
  }
  if (manifestValue.openVocabulary !== true) {
    failures.push("Neural transliteration must remain open-vocabulary.");
  }
  if (manifestValue.tokenization !== "unicode-scalar-character" ||
      manifestValue.outputSequenceValidation !==
        "devanagari-word-sequence-v1") {
    failures.push("Runtime must use the bounded Unicode-scalar Devanagari contract.");
  }
  const params = Number(manifestValue.parameterCount);
  if (!Number.isSafeInteger(params) ||
      params < 1_000_000 ||
      params > 5_000_000) {
    failures.push("Model parameterCount must be between 1M and 5M.");
  }
  if (manifestValue.languageModelRescorer?.enabled !== false ||
      manifestValue.languageModelRescorer?.source !== "none" ||
      Number(manifestValue.languageModelRescorer?.weight) !== 0 ||
      Number(manifestValue.contextWindowWords) !== 0) {
    failures.push("Runtime must not claim an unimplemented context rescorer.");
  }
  const runtimeContract = neuralRuntimeContractMetadata(
    descriptor.runtimeModelContract
  );
  const expectedMaxSteps =
    manifestValue.beamSearch?.maxOutputGraphemes +
    runtimeContract.decoderStepDelta;
  if (manifestValue.decoder !== runtimeContract.decoder ||
      manifestValue.beamSearch?.maxSteps !== expectedMaxSteps) {
    failures.push(
      runtimeContract.decoderStepDelta === 0
        ? "CTC prefix beam search must consume every fixed output time step."
        : "Beam search must expose every bounded scalar decoder step."
    );
  }
}

function validateTrainingSources(manifestValue) {
  const trainingSources = new Set(
    (manifestValue.trainingSources ?? []).map(String)
  );
  if (!trainingSources.has(canonicalTrainingSource)) {
    failures.push(
      `trainingSources must include ${canonicalTrainingSource}.`
    );
  }
  for (const blocked of blockedMirrorSources) {
    if (trainingSources.has(blocked)) {
      failures.push(`Model manifest counts blocked lineage mirror ${blocked} as training evidence.`);
    }
  }
}

function validateProductionManifest(manifestValue) {
  if (manifestValue.productionEligible !== true) {
    failures.push("Production manifest must declare productionEligible=true.");
  }
  let validator;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  } catch (error) {
    failures.push(`Production schema cannot be compiled: ${error.message}`);
    return;
  }
  if (!validator(manifestValue)) {
    failures.push(
      `Production manifest violates its closed schema: ` +
      `${JSON.stringify(validator.errors)}`
    );
  }
  if (!descriptor || descriptor.totalCompiledBytes !== manifestValue.modelBytes) {
    failures.push("Verified runtime artifacts do not match manifest.modelBytes.");
  }
  if (descriptor && descriptor.totalCompiledBytes > 16 * 1024 * 1024) {
    failures.push("Compiled runtime artifact set exceeds the 16 MB limit.");
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : "1";
    values.set(key, value);
    if (value !== "1") index += 1;
  }
  return values;
}

function finish(statusValue, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-transliteration-readiness.mjs",
    suite: "neural-transliteration-readiness",
    durationMs: Math.round(performance.now() - startedAt),
    status: statusValue,
    production,
    artifactRoot: relative(root, artifactRoot),
    artifactSetSha256: descriptor?.artifactSetSha256 ?? null,
    manifest: existsSync(manifestPath) ? relative(root, manifestPath) : null,
    manifestSha256: descriptor?.manifestSha256 ?? null,
    vocabulary: existsSync(vocabPath) ? relative(root, vocabPath) : null,
    vocabularySha256: descriptor?.vocabSha256 ?? null,
    artifacts: descriptor?.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.sourceRelativePath,
      bundleName: artifact.bundleName,
      bytes: artifact.compiledBytes,
      sha256: artifact.compiledSha256
    })) ?? [],
    datasetDir: relative(root, datasetDir),
    failures,
    warnings,
    policy: {
      deterministicFastPathFirst: true,
      neuralTailOnly: true,
      noNetworkInference: true,
      noTextTelemetry: true,
      canonicalTrainingSource,
      blockedMirrorSources
    }
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const summary = {
    status: statusValue,
    report: relative(root, reportPath),
    failures,
    warnings
  };
  (exitCode === 0 ? console.log : console.error)(
    JSON.stringify(summary, null, 2)
  );
  process.exit(exitCode);
}
