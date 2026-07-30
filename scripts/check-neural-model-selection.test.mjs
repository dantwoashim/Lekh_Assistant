import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, it } from "vitest";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  recomputeNeuralGoldEvaluationEvidence,
  recomputeOfficialBenchmarkEvaluationEvidence
} from "./lib/neural-metric-recomputation.mjs";
import {
  verifyOfficialBenchmarkTrainingIsolation
} from "./lib/neural-official-benchmark-isolation.mjs";
import {
  NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
} from "./lib/neural-runtime-placement-evidence.mjs";

const checker = join(
  process.cwd(),
  "scripts",
  "check-neural-model-selection.mjs"
);
const sourceRoot = process.cwd();
const DATASET_CONTENT_SHA = "1".repeat(64);
const GOLD_CORPUS_SHA =
  "d0cb6cef6df9f54b2adb25b4251ef24f4c93679a1c48005a50a0ac6c6519952b";
const BENCHMARK_CORPUS_SHA =
  "149d44c4e8832b91908c4bccfb67e60abcdf8ed99a1d873dc60ef7d0a130744a";
const BENCHMARK_MANIFEST_SHA =
  "d492040eeb6ddd2883fee50d0f03c051e20a08d1f469da00679b66751136781f";

describe("neural model-selection CLI evidence graph", () => {
  it("verifies two complete candidate graphs and publishes one immutable winner", () => {
    withFixture((fixture) => {
      const result = runSelection(fixture);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = readJson(fixture.report);
      assert.equal(report.status, "passed-neural-model-selection");
      assert.equal(
        report.winner.candidateId,
        `ctc:${fixture.candidates[1].exportRunId}`
      );
      assert.equal(report.candidates.length, 2);
      assert.equal(
        report.comparableBindings.benchmarkCorpusSha256,
        BENCHMARK_CORPUS_SHA
      );
    });
  });

  it("refuses official predictions that changed after their evaluation report", () => {
    withFixture((fixture) => {
      write(
        fixture.candidates[1].comparisonPredictions,
        `${JSON.stringify({
          id: "official-native",
          input: "nepal",
          candidates: ["नेपाळ"]
        })}\n`
      );
      const result = runSelection(fixture);
      assert.equal(result.status, 1);
      const report = readJson(fixture.report);
      assert.ok(report.failures.some((failure) =>
        /bytes do not match the declared SHA-256/u.test(failure)
      ));
    });
  });

  it("refuses a comparison report with forged training-isolation evidence", () => {
    withFixture((fixture) => {
      const comparison = readJson(fixture.candidates[0].comparisonPath);
      comparison.benchmarkIsolation.overlappingInputCount = 1;
      writeJson(fixture.candidates[0].comparisonPath, comparison);

      const result = runSelection(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /training-isolation evidence/u.test(failure)
      ));
    });
  });

  it("refuses compute-plan preference without observed runtime placement", () => {
    withFixture((fixture) => {
      const benchmarkPath = join(
        fixture.root,
        "reports",
        "baseline-benchmark.json"
      );
      const benchmark = readJson(benchmarkPath);
      delete benchmark.computePlacement.runtimePlacement;
      writeJson(benchmarkPath, benchmark);

      const result = runSelection(fixture);
      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /Neural Engine benchmark/u.test(failure)
      ));
    });
  });

  it("keeps production selection closed without verified raw trace provenance", () => {
    withFixture((fixture) => {
      const result = runSelection(fixture, { production: true });
      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /Neural Engine benchmark/u.test(failure)
      ));
    });
  });

  it("rejects a forged passed-prefix candidate export status", () => {
    withFixture((fixture) => {
      const exportReport = readJson(fixture.candidates[0].exportReportPath);
      exportReport.status = "passed-forged-candidate";
      writeJson(fixture.candidates[0].exportReportPath, exportReport);

      const result = runSelection(fixture);
      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /exact|immutable Core ML export/u.test(failure)
      ));
    });
  });

  it("rejects a gold-manifest override even when its hashes are refreshed", () => {
    withFixture((fixture) => {
      const candidate = fixture.candidates[0];
      const exportReport = readJson(candidate.exportReportPath);
      exportReport.artifactOverrides.goldManifest = {
        configured: "data/neural/gold/manifest.v3.json",
        effective: "data/neural/gold/manifest.v3.json",
        source: "command-line"
      };
      writeJson(candidate.exportReportPath, exportReport);
      const exportEvidence = inspectContainedRegularFile(
        fixture.root,
        candidate.exportReportPath
      );
      const evaluation = readJson(candidate.evaluationPath);
      evaluation.exportReportSha256 = exportEvidence.sha256;
      writeJson(candidate.evaluationPath, evaluation);
      const comparison = readJson(candidate.comparisonPath);
      comparison.exportReportSha256 = exportEvidence.sha256;
      writeJson(candidate.comparisonPath, comparison);

      const result = runSelection(fixture);
      assert.equal(result.status, 1);
      const report = readJson(fixture.report);
      assert.ok(
        report.failures.some((failure) =>
          /gold-manifest-override-forbidden/u.test(failure)
        ),
        JSON.stringify(report.failures)
      );
    });
  });

  it("rejects a rehashed gold report with forged production metrics", () => {
    withFixture((fixture) => {
      const candidate = fixture.candidates[0];
      const evaluation = readJson(candidate.evaluationPath);
      evaluation.metrics.tailTop1Accuracy = 0.99;
      writeJson(candidate.evaluationPath, evaluation);

      const result = runSelection(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /neural-evaluation-replay\.report-metrics-mismatch/u.test(failure)
      ));
    });
  });

  it("rejects a rehashed official report with another candidate's metrics", () => {
    withFixture((fixture) => {
      const baseline = readJson(fixture.candidates[0].comparisonPath);
      const ctc = readJson(fixture.candidates[1].comparisonPath);
      baseline.metrics = structuredClone(ctc.metrics);
      baseline.metricsByTargetLength =
        structuredClone(ctc.metricsByTargetLength);
      baseline.qualityGate = structuredClone(ctc.qualityGate);
      writeJson(fixture.candidates[0].comparisonPath, baseline);

      const result = runSelection(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /official-benchmark-replay\.report-(metrics|metricsByTargetLength|qualityGate)-mismatch/u
          .test(failure)
      ));
    });
  });
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-neural-selection-"));
  const rootAlias = join(parent, "repo");
  mkdirSync(rootAlias, { recursive: true });
  const root = realpathSync(rootAlias);
  try {
    const shared = buildSharedEvidence(root);
    const baseline = buildCandidate(root, shared, {
      label: "baseline",
      runSeed: "a",
      officialTop1Misses: 1
    });
    const ctc = buildCandidate(root, shared, {
      label: "ctc",
      kind: "ctc",
      runSeed: "c",
      officialTop1Misses: 0
    });
    callback({
      root,
      report: join(root, "reports", "selection.json"),
      candidates: [baseline, ctc]
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function buildSharedEvidence(root) {
  const datasetManifest = join(
    root,
    "data",
    "generated",
    "neural-open-vocab",
    "manifest.json"
  );
  const datasetTrain = join(
    root,
    "data",
    "generated",
    "neural-open-vocab",
    "train.jsonl"
  );
  const datasetDev = join(
    root,
    "data",
    "generated",
    "neural-open-vocab",
    "dev.jsonl"
  );
  const benchmarkManifest = join(
    root,
    "data",
    "neural",
    "benchmarks",
    "aksharantar-nepali-test-v1",
    "manifest.json"
  );
  const referenceManifest = join(
    root,
    "data",
    "neural",
    "benchmarks",
    "indicxlit-v1",
    "manifest.json"
  );
  writeJsonLines(datasetTrain, [{
    schemaVersion: 1,
    split: "train",
    input: "fixture-training-only-input"
  }]);
  writeJsonLines(datasetDev, [{
    schemaVersion: 1,
    split: "dev",
    input: "fixture-development-only-input"
  }]);
  const datasetSplitEvidence = {
    train: inspectContainedRegularFile(root, datasetTrain),
    dev: inspectContainedRegularFile(root, datasetDev)
  };
  writeJson(datasetManifest, {
    schemaVersion: 2,
    datasetContentSha256: DATASET_CONTENT_SHA,
    splitFiles: {
      train: portable(root, datasetTrain),
      dev: portable(root, datasetDev)
    },
    counts: {
      train: 1,
      dev: 1
    },
    bytes: {
      train: datasetSplitEvidence.train.bytes,
      dev: datasetSplitEvidence.dev.bytes
    },
    sha256: {
      train: datasetSplitEvidence.train.sha256,
      dev: datasetSplitEvidence.dev.sha256
    },
    cleaningPolicy: {
      normalizeInput: "trim lowercase NFC collapse-whitespace"
    }
  });
  const datasetEvidence = inspectContainedRegularFile(
    root,
    datasetManifest
  );
  const canonicalGoldManifest = join(
    root,
    "data",
    "neural",
    "gold",
    "manifest.v3.json"
  );
  mkdirSync(dirname(canonicalGoldManifest), { recursive: true });
  copyFileSync(
    join(sourceRoot, "data/neural/gold/manifest.v3.json"),
    canonicalGoldManifest
  );
  copyRelativeEvidence(
    root,
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
  );
  copyRelativeEvidence(
    root,
    "data/neural/benchmarks/indicxlit-v1/manifest.json"
  );
  const goldManifest = readJson(canonicalGoldManifest);
  const officialManifest = readJson(benchmarkManifest);
  const reference = readJson(referenceManifest);
  const goldRows = materializeLockedSuiteRows(root, goldManifest);
  const benchmarkRows = materializeLockedSuiteRows(
    root,
    officialManifest
  );
  const isolationReplay = verifyOfficialBenchmarkTrainingIsolation({
    repoRoot: root,
    datasetManifestPath: datasetManifest,
    expectedDatasetManifestSha256: datasetEvidence.sha256,
    officialRows: benchmarkRows
  });
  assert.equal(
    isolationReplay.valid,
    true,
    isolationReplay.issueCodes.join(", ")
  );
  copyRelativeEvidence(root, reference.predictionArtifact.path);
  const referencePredictions = join(
    root,
    reference.predictionArtifact.path
  );
  return {
    datasetManifest,
    datasetEvidence,
    datasetSplitEvidence,
    datasetSplits: isolationReplay.comparedSplits,
    trainingIsolation: isolationReplay.evidence,
    goldManifest: canonicalGoldManifest,
    goldEvidence: inspectContainedRegularFile(root, canonicalGoldManifest),
    goldRows,
    benchmarkManifest,
    benchmarkEvidence: inspectContainedRegularFile(root, benchmarkManifest),
    benchmarkRows,
    referenceManifest,
    referenceEvidence: inspectContainedRegularFile(root, referenceManifest),
    referencePredictions,
    referencePredictionEvidence: inspectContainedRegularFile(
      root,
      referencePredictions
    ),
    referencePredictionRows: readJsonLines(referencePredictions)
  };
}

function buildCandidate(root, shared, options) {
  const ctc = options.kind === "ctc";
  const candidateRoot = join(
    root,
    "data",
    "generated",
    options.label
  );
  const manifestPath = join(
    candidateRoot,
    "LekhNeuralTransliterator.manifest.json"
  );
  const vocabularyPath = join(
    candidateRoot,
    "LekhNeuralTransliterator.vocab.json"
  );
  const compiledModel = join(
    candidateRoot,
    "LekhNeuralTransliterator.mlmodelc"
  );
  const exportReportPath = join(candidateRoot, "export-report.json");
  const checkpointPath = join(candidateRoot, "checkpoint.pt");
  const trainingReportPath = join(candidateRoot, "training-report.json");
  const goldPredictions = join(
    candidateRoot,
    "gold-predictions.jsonl"
  );
  const comparisonPredictions = join(
    candidateRoot,
    "official-benchmark-predictions.jsonl"
  );
  const evaluationPath = join(
    root,
    "reports",
    `${options.label}-evaluation.json`
  );
  const benchmarkPath = join(
    root,
    "reports",
    `${options.label}-benchmark.json`
  );
  const comparisonPath = join(
    root,
    "reports",
    `${options.label}-official.json`
  );
  const specificationPath = join(
    root,
    "reports",
    `${options.label}-specification.json`
  );
  write(vocabularyPath, JSON.stringify({
    schemaVersion: 1,
    modelId: options.label,
    tokenization: "unicode-scalar-character"
  }));
  write(join(compiledModel, "model.bin"), `compiled-${options.label}`);
  write(checkpointPath, `checkpoint-${options.label}`);
  const vocabularyEvidence = inspectContainedRegularFile(root, vocabularyPath);
  const compiledEvidence = inspectContainedDirectoryTree(root, compiledModel);
  const checkpointEvidence = inspectContainedRegularFile(root, checkpointPath);
  const trainingRunId = options.runSeed.repeat(32);
  const exportRunId = String.fromCharCode(options.runSeed.charCodeAt(0) + 1)
    .repeat(32);
  const manifest = {
    schemaVersion: 2,
    trainingRunId,
    exportRunId,
    selectedArtifact: ctc
      ? "lekh-open-vocab-ctc-transformer-v2"
      : "lekh-open-vocab-seq2seq-v1",
    architecture: ctc
      ? "fixed-shape-transformer-ctc"
      : "gru-encoder-decoder-seq2seq",
    runtime: "CoreML",
    localOnly: true,
    neuralTailOnly: true,
    productionEligible: false,
    openVocabulary: true,
    trainingSources: ["ai4bharat-aksharantar-nepali"],
    modelBytes: compiledEvidence.bytes,
    sha256: {
      sourceCheckpoint: checkpointEvidence.sha256,
      trainingDatasetManifest: shared.datasetEvidence.sha256,
      vocabMetadata: vocabularyEvidence.sha256,
      compiledModel: compiledEvidence.sha256
    }
  };
  if (ctc) {
    manifest.runtimeModelContract = "single-transformer-ctc-v1";
    manifest.tensorContract = {
      inputIds: { shape: [1, 32], dataType: "INT32" },
      logits: { shape: [1, 32, 128], dataType: "FLOAT16" }
    };
  }
  writeJson(manifestPath, manifest);
  const manifestEvidence = inspectContainedRegularFile(root, manifestPath);
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: root,
    manifest,
    manifestPath,
    vocabPath: vocabularyPath
  });
  const splitSha256 = {
    train: shared.datasetSplitEvidence.train.sha256,
    dev: shared.datasetSplitEvidence.dev.sha256
  };
  const trainingIsolation = structuredClone(
    shared.trainingIsolation
  );
  const predictionArtifactIdentity = {
    runtimeModelContract: descriptor.runtimeModelContract,
    compiledArtifacts: {
      model: {
        path: portable(root, compiledModel),
        sha256: compiledEvidence.sha256,
        bytes: compiledEvidence.bytes
      }
    }
  };
  const effectiveTrainingConfig = {
    trainingRun: {
      seed: options.runSeed.charCodeAt(0)
    }
  };
  const effectiveTrainingConfigCanonicalJson =
    JSON.stringify(effectiveTrainingConfig);
  const effectiveTrainingConfigSha256 = createHash("sha256")
    .update(effectiveTrainingConfigCanonicalJson)
    .digest("hex");
  const trainingReport = {
    status: "passed-training-checkpoint",
    trainingComplete: true,
    modelId: manifest.selectedArtifact,
    trainingRunId,
    checkpoint: portable(root, checkpointPath),
    checkpointSha256: checkpointEvidence.sha256,
    effectiveTrainingConfig,
    effectiveTrainingConfigCanonicalJson,
    effectiveTrainingConfigSha256
  };
  writeJson(trainingReportPath, trainingReport);
  const trainingReportEvidence = inspectContainedRegularFile(
    root,
    trainingReportPath
  );
  const goldPredictionRows = shared.goldRows.map((row) => ({
    id: row.id,
    input: row.input,
    candidates: row.expectedAction === "no-neural-candidate"
      ? []
      : [firstAcceptedTarget(row)]
  }));
  writeJsonLines(goldPredictions, goldPredictionRows);
  const goldPredictionEvidence = inspectContainedRegularFile(
    root,
    goldPredictions
  );
  const officialPredictionRows = shared.benchmarkRows.map(
    (row, index) => {
      const target = firstAcceptedTarget(row);
      return {
        id: row.id,
        input: row.input,
        candidates: index < options.officialTop1Misses
          ? ["गलत", target]
          : [target]
      };
    }
  );
  writeJsonLines(comparisonPredictions, officialPredictionRows);
  const comparisonPredictionEvidence = inspectContainedRegularFile(
    root,
    comparisonPredictions
  );
  const goldReplay = recomputeNeuralGoldEvaluationEvidence({
    goldRows: shared.goldRows,
    predictionRows: goldPredictionRows
  });
  assert.equal(
    goldReplay.valid,
    true,
    goldReplay.issueCodes.join(", ")
  );
  const officialReplay = recomputeOfficialBenchmarkEvaluationEvidence({
    benchmarkRows: shared.benchmarkRows,
    candidatePredictionRows: officialPredictionRows,
    referencePredictionRows: shared.referencePredictionRows
  });
  assert.equal(
    officialReplay.valid,
    true,
    officialReplay.issueCodes.join(", ")
  );
  const goldSuites = lockedSuiteEvidence(readJson(shared.goldManifest));
  const officialSuites = lockedSuiteEvidence(
    readJson(shared.benchmarkManifest)
  );
  const officialBenchmarkSnapshot = {
    manifest: portable(root, shared.benchmarkManifest),
    manifestSha256: shared.benchmarkEvidence.sha256,
    corpusSha256: BENCHMARK_CORPUS_SHA,
    suites: officialSuites,
    rows: shared.benchmarkRows.length,
    trainingIsolation
  };
  const exportReport = {
    status: ctc
      ? "passed-open-vocab-ctc-transformer-candidate"
      : "passed-open-vocab-seq2seq-candidate",
    productionEligible: false,
    coremlExport: { status: "passed" },
    runtimeArtifactContractIssues: [],
    trainingRunId,
    exportRunId,
    effectiveTrainingConfigSha256,
    checkpoint: portable(root, checkpointPath),
    checkpointSha256: checkpointEvidence.sha256,
    trainingReport: portable(root, trainingReportPath),
    trainingReportSha256: trainingReportEvidence.sha256,
    modelId: manifest.selectedArtifact,
    predictions: portable(root, goldPredictions),
    predictionsSha256: goldPredictionEvidence.sha256,
    predictionsBackend: descriptor.predictionsBackend,
    goldManifest: portable(root, shared.goldManifest),
    goldManifestSha256: shared.goldEvidence.sha256,
    goldCorpusSha256: GOLD_CORPUS_SHA,
    goldSuites,
    goldRows: shared.goldRows.length,
    artifactOverrides: {},
    runInputSnapshot: {
      dataset: {
        manifest: portable(root, shared.datasetManifest),
        manifestSha256: shared.datasetEvidence.sha256,
        contentSha256: DATASET_CONTENT_SHA,
        splits: structuredClone(shared.datasetSplits)
      },
      officialBenchmark: officialBenchmarkSnapshot
    },
    comparisonBenchmark: {
      manifest: portable(root, shared.benchmarkManifest),
      manifestSha256: shared.benchmarkEvidence.sha256,
      corpusSha256: BENCHMARK_CORPUS_SHA,
      suites: officialSuites,
      rows: shared.benchmarkRows.length,
      trainingIsolation,
      predictions: portable(root, comparisonPredictions),
      predictionsSha256: comparisonPredictionEvidence.sha256,
      predictionsBackend: descriptor.predictionsBackend,
      predictionArtifactIdentity
    },
    manifest: portable(root, manifestPath),
    manifestSha256: manifestEvidence.sha256
  };
  if (ctc) {
    exportReport.runtimeModelContract = "single-transformer-ctc-v1";
  }
  writeJson(exportReportPath, exportReport);
  const exportEvidence = inspectContainedRegularFile(root, exportReportPath);
  const artifactIdentity = {
    trainingRunId,
    exportRunId,
    manifestSha256: manifestEvidence.sha256,
    vocabSha256: vocabularyEvidence.sha256,
    artifactSetSha256: descriptor.artifactSetSha256
  };
  const evaluationArtifactIdentity = {
    trainingRunId,
    exportRunId,
    manifestSha256: manifestEvidence.sha256,
    vocabSha256: vocabularyEvidence.sha256,
    compiledModelSha256: manifest.sha256.compiledModel,
    compiledModels: null
  };
  const evaluation = {
    status: "passed-production-phase5-evaluation",
    production: true,
    productionEligible: true,
    failures: [],
    trainingRunId,
    exportRunId,
    candidateManifestSha256: manifestEvidence.sha256,
    exportReportSha256: exportEvidence.sha256,
    artifactIdentity: evaluationArtifactIdentity,
    datasetManifest: portable(root, shared.datasetManifest),
    datasetManifestSha256: shared.datasetEvidence.sha256,
    datasetContentSha256: DATASET_CONTENT_SHA,
    goldManifest: portable(root, shared.goldManifest),
    goldManifestSha256: shared.goldEvidence.sha256,
    goldCorpusSha256: GOLD_CORPUS_SHA,
    predictions: portable(root, goldPredictions),
    predictionsSha256: goldPredictionEvidence.sha256,
    ...replayReportFields(goldReplay)
  };
  writeJson(evaluationPath, evaluation);
  const benchmark = {
    status: "passed-candidate-promotion-evidence",
    proofMode: "candidate-promotion",
    singleForwardBenchmarkIsConsumerLatency: false,
    failures: [],
    artifactIdentity,
    computePlacement: {
      neuralEngineCompatibilityIndicated: true,
      neuralEngineRuntimeObserved: true,
      neuralEngineClaimAllowed: true,
      architectures: ["arm64"],
      runtimePlacement: runtimePlacementEvidence(descriptor)
    },
    performance: {
      p99Ms: ctc ? 20 : 10
    }
  };
  writeJson(benchmarkPath, benchmark);
  const {
    reference: officialReference,
    ...officialReplayFields
  } = replayReportFields(officialReplay);
  const comparison = {
    schemaVersion: 1,
    status: "passed-official-benchmark-evaluation",
    suite: "neural-official-benchmark-evaluation",
    productionEligible: true,
    failures: [],
    trainingRunId,
    exportRunId,
    candidateManifestSha256: manifestEvidence.sha256,
    exportReport: portable(root, exportReportPath),
    exportReportSha256: exportEvidence.sha256,
    artifactIdentity,
    benchmarkManifest:
      "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
    benchmarkManifestSha256: BENCHMARK_MANIFEST_SHA,
    benchmarkCorpusSha256: BENCHMARK_CORPUS_SHA,
    benchmarkIsolation: trainingIsolation,
    predictions: portable(root, comparisonPredictions),
    predictionsSha256: comparisonPredictionEvidence.sha256,
    predictionsBackend: descriptor.predictionsBackend,
    predictionArtifactIdentity,
    reference: {
      manifest: portable(root, shared.referenceManifest),
      manifestSha256: shared.referenceEvidence.sha256,
      predictions: portable(root, shared.referencePredictions),
      predictionsSha256: shared.referencePredictionEvidence.sha256,
      ...officialReference
    },
    ...officialReplayFields
  };
  writeJson(comparisonPath, comparison);
  writeJson(specificationPath, {
    schemaVersion: 1,
    label: options.label,
    candidateRoot: portable(root, candidateRoot),
    evaluationReport: portable(root, evaluationPath),
    benchmarkReport: portable(root, benchmarkPath),
    comparisonReport: portable(root, comparisonPath)
  });
  return {
    specificationPath,
    evaluationPath,
    exportReportPath,
    checkpointPath,
    trainingReportPath,
    goldPredictions,
    comparisonPath,
    comparisonPredictions,
    exportRunId
  };
}

function runSelection(fixture, options = {}) {
  const productionArgs = options.production === true
    ? ["--production"]
    : [];
  return spawnSync(process.execPath, [
    checker,
    ...productionArgs,
    "--candidate-spec",
    fixture.candidates[0].specificationPath,
    "--candidate-spec",
    fixture.candidates[1].specificationPath,
    "--report",
    fixture.report
  ], {
    cwd: fixture.root,
    encoding: "utf8"
  });
}

function runtimePlacementEvidence(descriptor) {
  const runtimeRoles = {};
  const roleExecutions = {};
  for (const artifact of descriptor.artifacts) {
    runtimeRoles[artifact.role] = {
      bundleName: artifact.bundleName,
      compiledBytes: artifact.compiledBytes,
      compiledSha256: artifact.compiledSha256
    };
    roleExecutions[artifact.role] = {
      bundleName: artifact.bundleName,
      compiledSha256: artifact.compiledSha256,
      neuralEngineComputeObserved: true,
      predictionCount: 40
    };
  }
  const coreMLPredictionCount = Object.values(roleExecutions)
    .reduce((total, role) => total + role.predictionCount, 0);
  return {
    schemaVersion: 1,
    recordType: "lekh-neural-runtime-placement-evidence",
    status: "passed",
    evidenceKind: "instruments-coreml-neural-engine-runtime-trace",
    generatedAt: "2026-07-28T00:00:00Z",
    architecture: "arm64",
    macOS: "26.0",
    hardware: {
      chip: "Apple M-series",
      modelIdentifier: "MacFixture1,1"
    },
    capture: {
      tool: "Instruments",
      xcodeVersion: "26.0",
      coreMLInstrument: true,
      neuralEngineInstrument: true,
      traceSha256: "7".repeat(64),
      traceExportSha256: "8".repeat(64)
    },
    artifactIdentity: {
      manifestSha256: descriptor.manifestSha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256,
      runtimeRoles
    },
    workload: {
      ...NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
    },
    correlation: {
      processScoped: true,
      predictionIntervalsCorrelated: true,
      rolePathsResolved: true,
      coreMLComputeLane: true,
      neuralEngineHardwareTrack: true
    },
    observations: {
      coreMLPredictionCount,
      neuralEngineComputeEventCount: coreMLPredictionCount,
      roleExecutions
    }
  };
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonLines(path, rows) {
  write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function materializeLockedSuiteRows(root, manifest) {
  return manifest.suites.flatMap((suite) => {
    copyRelativeEvidence(root, suite.path);
    return readJsonLines(join(root, suite.path)).map((row) => ({
      ...row,
      suiteId: suite.id,
      suitePath: suite.path,
      ...(suite.benchmarkBucket === undefined
        ? {}
        : { benchmarkBucket: suite.benchmarkBucket })
    }));
  });
}

function lockedSuiteEvidence(manifest) {
  return manifest.suites.map((suite) => ({
    id: suite.id,
    path: suite.path,
    sha256: suite.sha256,
    rows: suite.rows,
    ...(suite.benchmarkBucket === undefined
      ? {}
      : { benchmarkBucket: suite.benchmarkBucket })
  }));
}

function copyRelativeEvidence(root, path) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(sourceRoot, path), destination);
}

function firstAcceptedTarget(row) {
  const acceptable = row.acceptable ?? row.expected;
  assert.ok(
    Array.isArray(acceptable) &&
    typeof acceptable[0] === "string" &&
    acceptable[0].length > 0
  );
  return acceptable[0];
}

function replayReportFields(replay) {
  const {
    valid: _valid,
    issueCodes: _issueCodes,
    ...fields
  } = replay;
  return structuredClone(fields);
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
