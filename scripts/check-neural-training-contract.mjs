#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  configuredNeuralTrainingContract,
  inspectTrainingReportBinding,
  validateNeuralTrainingConfig
} from "./lib/neural-training-contract.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const canonicalPaths = {
  config: join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json"),
  trainer: join(root, "scripts", "train-open-vocab-seq2seq-transliterator.py"),
  trainingReport: join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "training-report.json"),
  checkpoint: join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "checkpoint.pt"),
  exportReport: join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "export-report.json"),
  mlpackage: join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "LekhNeuralTransliterator.mlpackage"),
  measurements: join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "coreml-device-measurements.json"),
  predictions: join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "gold-predictions.jsonl"),
  vocab: join(root, "models", "macos", "LekhNeuralTransliterator.vocab.json"),
  datasetManifest: join(root, "data", "generated", "neural-open-vocab", "manifest.json"),
  goldManifest: join(root, "data", "neural", "gold", "manifest.v2.json"),
  manifest: join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json"),
  model: join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc")
};
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-training-contract-production-report.json" : "neural-training-contract-report.json");
const configPath = args.get("config") ?? canonicalPaths.config;
const trainerPath = args.get("trainer") ?? canonicalPaths.trainer;
const trainingReportPath = args.get("training-report") ?? canonicalPaths.trainingReport;
const checkpointPath = canonicalPaths.checkpoint;
const exportReportPath = canonicalPaths.exportReport;
const mlpackagePath = canonicalPaths.mlpackage;
const measurementsPath = canonicalPaths.measurements;
const predictionsPath = canonicalPaths.predictions;
const vocabPath = canonicalPaths.vocab;
const datasetManifestPath = canonicalPaths.datasetManifest;
const goldManifestPath = canonicalPaths.goldManifest;
const manifestPath = args.get("manifest") ?? canonicalPaths.manifest;
const modelDir = args.get("model") ?? canonicalPaths.model;
const graphPath = join(modelDir, "model.espresso.net");
const failures = [];
const warnings = [];
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_TRAINER_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const MAX_PREDICTIONS_BYTES = 256 * 1024 * 1024;
const MAX_GOLD_SUITE_BYTES = 64 * 1024 * 1024;
const MAX_GOLD_CORPUS_BYTES = 256 * 1024 * 1024;
const MAX_COMPILED_MODEL_BYTES = 16_777_216;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const fileEvidenceCache = new Map();

validateProductionInputs();

const configEvidence = inspectFileIfPresent(configPath, "Training config", MAX_JSON_BYTES, true);
const trainerEvidence = inspectFileIfPresent(trainerPath, "Training implementation", MAX_TRAINER_BYTES, true);
const trainingReportEvidence = inspectFileIfPresent(trainingReportPath, "Training report", MAX_JSON_BYTES, true);
const exportReportEvidence = inspectFileIfPresent(exportReportPath, "Export report", MAX_JSON_BYTES, true);
const datasetManifestEvidence = inspectFileIfPresent(datasetManifestPath, "Dataset manifest", MAX_JSON_BYTES, true);
const goldManifestEvidence = inspectFileIfPresent(goldManifestPath, "Gold manifest", MAX_JSON_BYTES, true);
const checkpointEvidence = inspectFileIfPresent(checkpointPath, "Checkpoint", MAX_CHECKPOINT_BYTES);
const measurementsEvidence = inspectFileIfPresent(measurementsPath, "Core ML measurements", MAX_JSON_BYTES);
const predictionsEvidence = inspectFileIfPresent(predictionsPath, "Gold predictions", MAX_PREDICTIONS_BYTES);
const vocabEvidence = inspectFileIfPresent(vocabPath, "Vocabulary metadata", MAX_JSON_BYTES);
const manifestEvidence = inspectFileIfPresent(manifestPath, "Runtime manifest", MAX_JSON_BYTES, true);
const mlpackageEvidence = inspectDirectoryIfPresent(mlpackagePath, "Core ML source package", MAX_COMPILED_MODEL_BYTES);
const modelEvidence = inspectDirectoryIfPresent(modelDir, "Compiled Core ML model", MAX_COMPILED_MODEL_BYTES);
const graphEvidence = inspectFileIfPresent(graphPath, "Compiled Core ML graph", MAX_COMPILED_MODEL_BYTES, true);
const trainer = trainerEvidence?.contents.toString("utf8") ?? "";

if (!trainer) failures.push("Missing open-vocabulary training implementation.");
if (trainer.includes("lekh-required-production-case") || trainer.includes("train.extend([seed] *")) {
  failures.push("Training implementation must not inject frozen required evaluation cases into train or dev.");
}
if (trainer.includes("build_vocab(train_rows + dev_rows")) {
  failures.push("Tokenizer vocabulary must not learn from dev or test labels.");
}
if (!trainer.includes('build_vocab(train_rows, "input")') ||
    !trainer.includes('build_vocab(train_rows, "output")')) {
  failures.push("Tokenizer vocabulary must be derived from the training split only.");
}
if (!trainer.includes("Dataset input leakage between") || !trainer.includes("load_split_inputs(test_path)")) {
  failures.push("Trainer must fail closed on normalized-input overlap between train, dev, and test.");
}
if (!trainer.includes("def exclusive_run_lock(") || !trainer.includes("with exclusive_run_lock(args):")) {
  failures.push("Trainer must hold one exclusive publication lock across the complete training/export run.");
}
if (!trainer.includes("ct.models.CompiledMLModel(str(args.compiled_model))")) {
  failures.push("Trainer must run prediction evidence through the exact published compiled Core ML artifact.");
}
if (trainer.includes('row.get("expectedAction") == "no-neural-candidate"')) {
  failures.push("Raw model prediction generation must not use the expected answer to manufacture an empty candidate list.");
}
if (!/CrossEntropyLoss\([\s\S]{0,300}label_smoothing\s*=\s*args\.label_smoothing/u.test(trainer)) {
  failures.push("Trainer must apply the configured label smoothing in CrossEntropyLoss.");
}
if (!trainer.includes("args.gradient_clip_norm")) {
  failures.push("Trainer must apply the configured gradient clipping norm.");
}
if (!trainer.includes("args.early_stopping_patience") ||
    !trainer.includes("args.early_stopping_min_delta") ||
    !trainer.includes("args.restore_best_weights") ||
    !/load_state_dict\(best_state\)/u.test(trainer)) {
  failures.push("Trainer must implement dev-loss early stopping and restore the best weights.");
}
for (const marker of [
  "trainingContractSha256",
  "configuredTrainingConfig",
  "effectiveTrainingConfig",
  "effectiveTrainingConfigCanonicalJson",
  "effectiveTrainingConfigSha256",
  "trainingOverrides",
  "configuredArtifactInputs",
  "effectiveArtifactInputs",
  "effectiveArtifactInputsCanonicalJson",
  "effectiveArtifactInputsSha256",
  "artifactOverrides",
  "trainerSha256",
  "vocabMetadataSha256"
]) {
  if (!trainer.includes(marker)) failures.push(`Trainer must emit ${marker} provenance.`);
}

const config = readJsonEvidence(configEvidence, "training config");
const trainingContractSha256 = configEvidence?.sha256 ?? null;
const trainingReport = readJsonEvidence(trainingReportEvidence, "training report");
const exportReport = readJsonEvidence(exportReportEvidence, "export report");
const datasetManifest = readJsonEvidence(datasetManifestEvidence, "dataset manifest");
const goldManifest = readJsonEvidence(goldManifestEvidence, "gold manifest");
let manifest = null;
let trainingReportBinding = null;
let artifactGraphBinding = null;
if (!config) failures.push("Missing Phase 4 training/export config.");

if (config) {
  const configValidation = validateNeuralTrainingConfig(config);
  failures.push(...configValidation.failures);
  for (const warning of configValidation.warnings) readinessIssue(warning);

  trainingReportBinding = inspectTrainingReportBinding({
    report: trainingReport,
    trainingContractSha256,
    configuredContract: configuredNeuralTrainingContract(config)
  });
  for (const issue of trainingReportBinding.issues) readinessIssue(issue);
  if (trainingReportBinding.bound && trainingReport?.modelId !== config.modelId) {
    readinessIssue("Training report modelId does not match the current training config.");
  }
}

const modelExists = Boolean(modelEvidence);
const manifestExists = Boolean(manifestEvidence);
const graph = inspectCompiledGraph(graphEvidence, graphPath);
const modelBytes = modelEvidence?.bytes ?? 0;
const compiledModelSha256 = modelEvidence?.sha256 ?? null;

if (manifestExists) {
  manifest = readJsonEvidence(manifestEvidence, "production manifest");
  if (manifest) {
    requireEqual(manifest.selectedArtifact, "lekh-open-vocab-seq2seq-v1", "Production manifest selectedArtifact must be lekh-open-vocab-seq2seq-v1.");
    requireEqual(manifest.runtime, "CoreML", "Production manifest runtime must be CoreML.");
    requireEqual(manifest.localOnly, true, "Production manifest must be local-only.");
    requireEqual(manifest.neuralTailOnly, true, "Production manifest must be neural-tail-only.");
    requireEqual(manifest.openVocabulary, true, "Production manifest must be open-vocabulary.");
    if (compiledModelSha256 && manifest.sha256?.compiledModel !== compiledModelSha256) {
      failures.push("Production manifest sha256.compiledModel does not match the compiled model directory digest.");
    }
    if (config && manifest.languageModelRescorer?.enabled !== config.context?.languageModelRescorer?.enabled) {
      readinessIssue("Exported manifest context-rescorer state contradicts the current training config.");
    }
    if (config && manifest.contextWindowWords !== config.context?.previousWords) {
      readinessIssue("Exported manifest context window contradicts the current training config.");
    }
  }
} else if (production) {
  failures.push("Production Phase 4 requires models/macos/LekhNeuralTransliterator.manifest.json.");
} else {
  warnings.push("Production manifest is absent; Phase 4 export contract is complete, but no production model has been exported.");
}

if (config) {
  artifactGraphBinding = inspectArtifactGraph(config, manifest);
  for (const issue of artifactGraphBinding.issues) readinessIssue(issue);
}

if (!modelExists && production) failures.push("Production Phase 4 requires models/macos/LekhNeuralTransliterator.mlmodelc.");
if (modelExists && graph.closedVocabLinearSoftmax) {
  const message = "Existing models/macos Core ML graph appears to be a closed-vocabulary classifier, not the production seq2seq decoder.";
  if (production) failures.push(message);
  else warnings.push(message);
}

const status = failures.length === 0
  ? production ? "passed-production-phase4-training-contract" : "passed-phase4-training-contract"
  : production ? "failed-production-phase4-training-contract" : "failed-phase4-training-contract";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 4,
  production,
  config: relative(root, configPath),
  trainingContractSha256,
  trainer: relative(root, trainerPath),
  trainingReport: relative(root, trainingReportPath),
  trainingReportExists: Boolean(trainingReportEvidence),
  trainingReportBinding,
  artifactGraphBinding,
  model: relative(root, modelDir),
  manifest: relative(root, manifestPath),
  modelExists,
  manifestExists,
  modelBytes,
  compiledModelSha256,
  graph,
  manifest,
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

function readJsonEvidence(evidence, label) {
  if (!evidence) return null;
  try {
    return JSON.parse(evidence.contents.toString("utf8"));
  } catch (error) {
    failures.push(`Invalid ${label} JSON at ${relative(root, evidence.path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function inspectFileIfPresent(path, label, maxBytes, includeContents = false) {
  if (!pathIsLexicallyContained(path, label)) return null;
  if (!pathExistsWithoutFollowing(path, label)) return null;
  const key = `file\0${resolve(path)}\0${maxBytes}\0${includeContents}`;
  if (fileEvidenceCache.has(key)) return fileEvidenceCache.get(key);
  try {
    const evidence = inspectContainedRegularFile(root, path, { label, maxBytes, includeContents });
    fileEvidenceCache.set(key, evidence);
    return evidence;
  } catch (error) {
    failures.push(`Unsafe Phase 4 artifact: ${error instanceof Error ? error.message : String(error)}`);
    fileEvidenceCache.set(key, null);
    return null;
  }
}

function inspectDirectoryIfPresent(path, label, maxBytes) {
  if (!pathIsLexicallyContained(path, label)) return null;
  if (!pathExistsWithoutFollowing(path, label)) return null;
  try {
    return inspectContainedDirectoryTree(root, path, {
      label,
      maxBytes,
      maxEntries: 4_096,
      maxDepth: 64
    });
  } catch (error) {
    failures.push(`Unsafe Phase 4 artifact: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function pathIsLexicallyContained(path, label) {
  const candidate = resolve(path);
  const child = relative(resolve(root), candidate);
  if (child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))) return true;
  failures.push(`Unsafe Phase 4 artifact: ${label} path escapes the repository root: ${candidate}.`);
  return false;
}

function pathExistsWithoutFollowing(path, label) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    failures.push(`Unsafe Phase 4 artifact: ${label} cannot be inspected at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function validateProductionInputs() {
  if (!production) return;
  const allowed = new Set(["production", "report"]);
  for (const key of args.keys()) {
    if (!allowed.has(key)) {
      failures.push(`Production Phase 4 forbids the --${key} input override; only --report may be overridden.`);
    }
  }
  for (const [label, actual, expected] of [
    ["training config", configPath, canonicalPaths.config],
    ["trainer", trainerPath, canonicalPaths.trainer],
    ["training report", trainingReportPath, canonicalPaths.trainingReport],
    ["runtime manifest", manifestPath, canonicalPaths.manifest],
    ["compiled model", modelDir, canonicalPaths.model]
  ]) {
    if (resolve(actual) !== resolve(expected)) {
      failures.push(`Production Phase 4 ${label} path must resolve to ${relative(root, expected)}.`);
    }
  }
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) failures.push(`${message} Got ${JSON.stringify(actual)}.`);
}

function readinessIssue(message) {
  if (production) failures.push(message);
  else warnings.push(message);
}

function inspectArtifactGraph(config, manifestValue) {
  const issues = [];
  const expectedArtifacts = {
    trainingConfig: "data/neural/training/open-vocab-seq2seq-v1.config.json",
    datasetManifest: "data/generated/neural-open-vocab/manifest.json",
    goldManifest: "data/neural/gold/manifest.v2.json",
    outDir: "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1",
    compiledModel: "models/macos/LekhNeuralTransliterator.mlmodelc",
    manifest: "models/macos/LekhNeuralTransliterator.manifest.json",
    vocabMetadata: "models/macos/LekhNeuralTransliterator.vocab.json"
  };
  const checkpointSha256 = checkpointEvidence?.sha256 ?? null;
  const trainerSha256 = trainerEvidence?.sha256 ?? null;
  const vocabSha256 = vocabEvidence?.sha256 ?? null;
  const datasetManifestSha256 = datasetManifestEvidence?.sha256 ?? null;
  const goldManifestSha256 = goldManifestEvidence?.sha256 ?? null;
  const currentModelSha256 = modelEvidence?.sha256 ?? null;
  const currentMLPackageSha256 = mlpackageEvidence?.sha256 ?? null;
  const currentManifestSha256 = manifestEvidence?.sha256 ?? null;
  const currentTrainingReportSha256 = trainingReportEvidence?.sha256 ?? null;
  const currentMeasurementsSha256 = measurementsEvidence?.sha256 ?? null;
  const currentPredictionsSha256 = predictionsEvidence?.sha256 ?? null;
  const expectedGoldSuites = [];
  const seenGoldSuiteIds = new Set();
  let goldCorpusBytes = 0;
  let goldCorpusBudgetExceeded = false;

  if (!goldManifest) {
    issues.push("Gold manifest artifact is missing or invalid.");
  } else if (!Array.isArray(goldManifest.suites) || goldManifest.suites.length === 0) {
    issues.push("Gold manifest contains no evaluation suites.");
  } else {
    for (const suite of goldManifest.suites) {
      const validShape = isRecord(suite) && typeof suite.id === "string" && suite.id.length > 0 &&
        typeof suite.path === "string" && suite.path.length > 0 && /^[a-f0-9]{64}$/u.test(String(suite.sha256 ?? "")) &&
        Number.isSafeInteger(suite.rows) && suite.rows >= 0;
      requireGraph(validShape, "Gold manifest suite evidence has an invalid id, path, SHA-256, or row count.");
      if (!validShape) continue;
      requireGraph(!seenGoldSuiteIds.has(suite.id), `Gold manifest repeats suite id ${suite.id}.`);
      seenGoldSuiteIds.add(suite.id);
      const canonicalSuitePath = relative(root, resolve(root, suite.path)).split(sep).join("/");
      requireGraph(
        !isAbsolute(suite.path) && canonicalSuitePath === suite.path,
        `Gold suite ${suite.id} path is not canonical repository-relative evidence.`
      );
      if (goldCorpusBudgetExceeded) {
        requireGraph(false, `Gold suite ${suite.id} was not hashed after the corpus exceeded its verification limit.`);
        expectedGoldSuites.push({ id: suite.id, path: suite.path, sha256: suite.sha256, rows: suite.rows });
        continue;
      }
      const suiteEvidence = inspectFileIfPresent(resolve(root, suite.path), `Gold suite ${suite.id}`, MAX_GOLD_SUITE_BYTES, true);
      requireGraph(Boolean(suiteEvidence), `Gold suite artifact is missing or unsafe: ${suite.path}.`);
      if (suiteEvidence) {
        goldCorpusBytes += suiteEvidence.bytes;
        if (goldCorpusBytes > MAX_GOLD_CORPUS_BYTES) {
          failures.push(`Unsafe Phase 4 artifact: Gold corpus exceeds the ${MAX_GOLD_CORPUS_BYTES}-byte verification limit.`);
          goldCorpusBudgetExceeded = true;
        }
        requireGraph(suiteEvidence.sha256 === suite.sha256, `Gold suite ${suite.id} digest does not match its manifest.`);
        requireGraph(countNonemptyLines(suiteEvidence.contents) === suite.rows, `Gold suite ${suite.id} row count does not match its manifest.`);
      }
      expectedGoldSuites.push({ id: suite.id, path: suite.path, sha256: suite.sha256, rows: suite.rows });
    }
    requireGraph(goldManifest.corpusSha256 === goldCorpusSha256(expectedGoldSuites), "Gold manifest corpusSha256 does not match its suite identities.");
  }

  if (config.training?.datasetManifest !== expectedArtifacts.datasetManifest) {
    issues.push("Training config does not select the canonical immutable dataset manifest.");
  }
  if (config.export?.sourceCheckpoint !== `${expectedArtifacts.outDir}/checkpoint.pt` ||
      config.export?.compiledModel !== expectedArtifacts.compiledModel ||
      config.export?.manifest !== expectedArtifacts.manifest) {
    issues.push("Training config export paths do not match the canonical artifact graph.");
  }

  if (trainingReport) {
    requireGraph(RUN_ID_PATTERN.test(String(trainingReport.trainingRunId ?? "")), "Training report is missing a valid trainingRunId.");
    requireGraph(trainingReport.trainingComplete === true, "Training report does not declare trainingComplete=true.");
    requireGraph(trainingReport.checkpoint === `${expectedArtifacts.outDir}/checkpoint.pt`, "Training report checkpoint path is non-canonical.");
    requireGraph(trainingReport.checkpointSha256 === checkpointSha256, "Training report checkpointSha256 does not match checkpoint.pt.");
    requireGraph(trainingReport.trainerSha256 === trainerSha256, "Training report trainerSha256 does not match the current trainer.");
    requireGraph(trainingReport.vocabMetadata === expectedArtifacts.vocabMetadata, "Training report vocabulary path is non-canonical.");
    requireGraph(trainingReport.vocabMetadataSha256 === vocabSha256, "Training report vocabMetadataSha256 does not match the vocabulary artifact.");
    requireGraph(trainingReport.inputDatasetManifest === expectedArtifacts.datasetManifest, "Training report dataset manifest path is non-canonical.");
    requireGraph(trainingReport.inputDatasetManifestSha256 === datasetManifestSha256, "Training report dataset-manifest digest is stale.");
    requireGraph(trainingReport.inputDatasetContentSha256 === datasetManifest?.datasetContentSha256, "Training report stable dataset identity is stale.");
    requireGraph(deepEqual(trainingReport.inputDatasetSplitSha256, datasetManifest?.sha256), "Training report dataset split identities are stale.");
    requireGraph(deepEqual(trainingReport.configuredArtifactInputs, expectedArtifacts), "Training report configuredArtifactInputs do not match the canonical artifact graph.");
    requireGraph(deepEqual(trainingReport.effectiveArtifactInputs, expectedArtifacts), "Training report effectiveArtifactInputs differ from the canonical artifact graph.");
    requireGraph(isRecord(trainingReport.artifactOverrides) && Object.keys(trainingReport.artifactOverrides).length === 0, "Training report contains artifact/path overrides.");
    validateCanonicalBinding(
      trainingReport.effectiveArtifactInputs,
      trainingReport.effectiveArtifactInputsCanonicalJson,
      trainingReport.effectiveArtifactInputsSha256,
      "effective artifact inputs"
    );
    requireGraph(trainingReport.trainingExecutionModes?.skipTrain === false, "Training report was not produced by a fresh training invocation.");
    requireGraph(trainingReport.trainingExecutionModes?.skipCoreML === false, "Training report skipped Core ML export.");
  }

  if (!checkpointSha256) issues.push("Checkpoint artifact is missing.");
  if (!vocabSha256) issues.push("Vocabulary artifact is missing.");
  if (!datasetManifestSha256) issues.push("Dataset manifest artifact is missing.");
  if (!goldManifestSha256) issues.push("Gold manifest artifact is missing.");

  if (exportReport) {
    const validExportRunId = RUN_ID_PATTERN.test(String(exportReport.exportRunId ?? ""));
    const validExportTrainingRunId = RUN_ID_PATTERN.test(String(exportReport.trainingRunId ?? ""));
    requireGraph(validExportRunId, "Export report is missing a valid exportRunId.");
    requireGraph(validExportTrainingRunId && exportReport.trainingRunId === trainingReport?.trainingRunId, "Export report trainingRunId does not match the training report.");
    if (validExportRunId && validExportTrainingRunId) {
      requireGraph(exportReport.exportRunId !== exportReport.trainingRunId, "Export report reuses its trainingRunId as exportRunId.");
    }
    requireGraph(exportReport.status === "passed-open-vocab-seq2seq-candidate", "Export report does not record a successful candidate export.");
    requireGraph(exportReport.executionModes?.skipTrain === false, "Export report was not produced with a fresh training run.");
    requireGraph(exportReport.executionModes?.skipCoreML === false, "Export report skipped Core ML export.");
    requireGraph(exportReport.trainingContractSha256 === trainingContractSha256, "Export report training-contract digest is stale.");
    requireGraph(exportReport.checkpointSha256 === checkpointSha256, "Export report checkpoint digest is stale.");
    requireGraph(exportReport.trainingReportSha256 === currentTrainingReportSha256, "Export report training-report digest is stale.");
    requireGraph(exportReport.compiledModelSha256 === currentModelSha256, "Export report compiled-model digest is stale.");
    requireGraph(exportReport.manifestSha256 === currentManifestSha256, "Export report runtime-manifest digest is stale.");
    requireGraph(exportReport.coremlExport?.status === "passed", "Export report lacks a successful Core ML conversion.");
    requireGraph(exportReport.coremlExport?.compiledModel === expectedArtifacts.compiledModel, "Export report Core ML path is non-canonical.");
    requireGraph(exportReport.coremlExport?.compiledSha256 === currentModelSha256, "Export report Core ML digest is stale.");
    requireGraph(exportReport.mlpackage === `${expectedArtifacts.outDir}/LekhNeuralTransliterator.mlpackage`, "Export report Core ML package path is non-canonical.");
    requireGraph(exportReport.mlpackageSha256 === currentMLPackageSha256, "Export report Core ML package digest is stale.");
    requireGraph(exportReport.coremlExport?.mlpackage === `${expectedArtifacts.outDir}/LekhNeuralTransliterator.mlpackage`, "Core ML export package path is non-canonical.");
    requireGraph(exportReport.coremlExport?.mlpackageSha256 === currentMLPackageSha256, "Core ML export package digest is stale.");
    requireGraph(exportReport.measurements === `${expectedArtifacts.outDir}/coreml-device-measurements.json`, "Export report measurement path is non-canonical.");
    requireGraph(exportReport.measurementsSha256 === currentMeasurementsSha256, "Export report measurement digest is stale.");
    requireGraph(exportReport.predictions === `${expectedArtifacts.outDir}/gold-predictions.jsonl`, "Export report prediction path is non-canonical.");
    requireGraph(exportReport.predictionsSha256 === currentPredictionsSha256, "Export report prediction digest is stale.");
    requireGraph(exportReport.predictionsBackend === "coreml-compiled-model", "Export report predictionsBackend must be coreml-compiled-model.");
    requireGraph(exportReport.goldManifest === expectedArtifacts.goldManifest, "Export report gold-manifest path is non-canonical.");
    requireGraph(/^[a-f0-9]{64}$/u.test(String(exportReport.goldManifestSha256 ?? "")) && exportReport.goldManifestSha256 === goldManifestSha256, "Export report gold-manifest digest is stale.");
    requireGraph(/^[a-f0-9]{64}$/u.test(String(exportReport.goldCorpusSha256 ?? "")) && exportReport.goldCorpusSha256 === goldManifest?.corpusSha256, "Export report gold-corpus digest is stale.");
    requireGraph(deepEqual(exportReport.goldSuites, expectedGoldSuites), "Export report gold-suite evidence does not match the locked gold manifest.");
  } else {
    issues.push("Export report is absent; the compiled artifact graph is not bound to this training run.");
  }

  if (manifestValue) {
    const validManifestTrainingRunId = RUN_ID_PATTERN.test(String(manifestValue.trainingRunId ?? ""));
    const validManifestExportRunId = RUN_ID_PATTERN.test(String(manifestValue.exportRunId ?? ""));
    requireGraph(validManifestTrainingRunId && manifestValue.trainingRunId === trainingReport?.trainingRunId, "Runtime manifest trainingRunId does not match the training report.");
    requireGraph(validManifestExportRunId && manifestValue.exportRunId === exportReport?.exportRunId, "Runtime manifest exportRunId does not match the export report.");
    if (validManifestTrainingRunId && validManifestExportRunId) {
      requireGraph(manifestValue.exportRunId !== manifestValue.trainingRunId, "Runtime manifest reuses its trainingRunId as exportRunId.");
    }
    requireGraph(manifestValue.productionEligible === production, production
      ? "Production Phase 4 requires manifest.productionEligible=true."
      : "Development artifact must remain productionEligible=false.");
    requireGraph(manifestValue.sha256?.sourceCheckpoint === checkpointSha256, "Runtime manifest sourceCheckpoint digest is stale.");
    requireGraph(manifestValue.sha256?.vocabMetadata === vocabSha256, "Runtime manifest vocabMetadata digest is stale.");
    requireGraph(manifestValue.sha256?.trainingDatasetManifest === datasetManifestSha256, "Runtime manifest trainingDatasetManifest digest is stale.");
    requireGraph(manifestValue.sha256?.compiledModel === currentModelSha256, "Runtime manifest compiledModel digest is stale.");
    requireGraph(manifestValue.modelBytes === (modelEvidence?.bytes ?? null), "Runtime manifest modelBytes is stale.");
    requireGraph(manifestValue.parameterCount === trainingReport?.parameterCount, "Runtime manifest parameterCount does not match the training report.");
    const benchmarkDevices = manifestValue.performance?.devices;
    requireGraph(Array.isArray(benchmarkDevices) && benchmarkDevices.length > 0, "Runtime manifest has no benchmark device record.");
    for (const device of benchmarkDevices ?? []) {
      requireGraph(device.artifact === expectedArtifacts.compiledModel, "Runtime manifest benchmark did not load the canonical compiled model.");
      requireGraph([device.p50Ms, device.p95Ms, device.p99Ms].every((value) => Number.isFinite(value) && value >= 0), "Runtime manifest benchmark percentiles are missing or non-finite.");
    }
    const actualSources = Object.entries(trainingReport?.trainingSourceCounts ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([source]) => source)
      .sort();
    requireGraph(deepEqual(manifestValue.trainingSources, actualSources), "Runtime manifest trainingSources do not match actual checkpoint source counts.");
  }

  return { bound: issues.length === 0, issues };

  function requireGraph(condition, message) {
    if (!condition) issues.push(message);
  }

  function validateCanonicalBinding(value, canonicalJson, digest, label) {
    if (!isRecord(value) || typeof canonicalJson !== "string") {
      issues.push(`Training report does not bind ${label} canonical JSON.`);
      return;
    }
    try {
      requireGraph(deepEqual(JSON.parse(canonicalJson), value), `Training report ${label} canonical JSON does not match its object.`);
    } catch {
      issues.push(`Training report ${label} canonical JSON is invalid.`);
    }
    requireGraph(typeof digest === "string" && createHash("sha256").update(canonicalJson).digest("hex") === digest, `Training report ${label} digest is invalid.`);
  }
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function goldCorpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    hash.update(String(suite.id));
    hash.update("\0");
    hash.update(String(suite.path));
    hash.update("\0");
    hash.update(String(suite.sha256));
    hash.update("\0");
    hash.update(String(suite.rows));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function countNonemptyLines(contents) {
  return contents.toString("utf8").split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
}

function inspectCompiledGraph(evidence, path) {
  if (!evidence) return { path: relative(root, path), exists: false };
  const bytes = evidence.contents.toString("latin1");
  const hasInnerProduct = bytes.includes("inner_product");
  const hasSoftmax = bytes.includes("softmax");
  const hasAttention = /attention|self_attention|multihead|decoder|encoder/i.test(bytes);
  const hasRecurrent = /lstm|gru|recurrent/i.test(bytes);
  return {
    path: relative(root, path),
    exists: true,
    hasInnerProduct,
    hasSoftmax,
    hasAttention,
    hasRecurrent,
    closedVocabLinearSoftmax: hasInnerProduct && hasSoftmax && !hasAttention && !hasRecurrent
  };
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-training-contract.mjs",
    suite: "neural-training-contract",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
