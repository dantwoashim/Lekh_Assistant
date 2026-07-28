import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
} from "./lib/neural-runtime-placement-evidence.mjs";

const checker = join(
  process.cwd(),
  "scripts",
  "check-neural-model-selection.mjs"
);
const sourceRoot = process.cwd();
const DATASET_CONTENT_SHA = "1".repeat(64);
const GOLD_CORPUS_SHA = "2".repeat(64);
const BENCHMARK_CORPUS_SHA =
  "149d44c4e8832b91908c4bccfb67e60abcdf8ed99a1d873dc60ef7d0a130744a";
const BENCHMARK_MANIFEST_SHA =
  "d492040eeb6ddd2883fee50d0f03c051e20a08d1f469da00679b66751136781f";
const REFERENCE_MANIFEST_SHA =
  "c3bd96c57a322455026df920dab74dc214113bb2a33aa67f6420805b195c52c6";

describe("neural model-selection CLI evidence graph", () => {
  it("verifies two complete candidate graphs and publishes one immutable winner", () => {
    withFixture((fixture) => {
      const result = runSelection(fixture);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = readJson(fixture.report);
      assert.equal(report.status, "passed-neural-model-selection");
      assert.equal(
        report.winner.candidateId,
        `attention:${fixture.candidates[1].exportRunId}`
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
      officialTop1Hits: 1
    });
    const attention = buildCandidate(root, shared, {
      label: "attention",
      runSeed: "c",
      officialTop1Hits: 3
    });
    callback({
      root,
      report: join(root, "reports", "selection.json"),
      candidates: [baseline, attention]
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
  const goldManifest = join(root, "data", "neural", "gold", "manifest.json");
  const benchmarkManifest = join(
    root,
    "data",
    "neural",
    "benchmarks",
    "aksharantar-nepali-test-v1",
    "manifest.json"
  );
  writeJson(datasetManifest, {
    schemaVersion: 2,
    datasetContentSha256: DATASET_CONTENT_SHA
  });
  writeJson(goldManifest, {
    schemaVersion: 2,
    corpusSha256: GOLD_CORPUS_SHA,
    suites: []
  });
  mkdirSync(dirname(benchmarkManifest), { recursive: true });
  copyFileSync(
    join(
      sourceRoot,
      "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
    ),
    benchmarkManifest
  );
  return {
    datasetManifest,
    datasetEvidence: inspectContainedRegularFile(root, datasetManifest),
    goldManifest,
    goldEvidence: inspectContainedRegularFile(root, goldManifest),
    benchmarkManifest,
    benchmarkEvidence: inspectContainedRegularFile(root, benchmarkManifest)
  };
}

function buildCandidate(root, shared, options) {
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
  const vocabularyEvidence = inspectContainedRegularFile(root, vocabularyPath);
  const compiledEvidence = inspectContainedDirectoryTree(root, compiledModel);
  const trainingRunId = options.runSeed.repeat(32);
  const exportRunId = String.fromCharCode(options.runSeed.charCodeAt(0) + 1)
    .repeat(32);
  const manifest = {
    schemaVersion: 2,
    trainingRunId,
    exportRunId,
    selectedArtifact: "lekh-open-vocab-seq2seq-v1",
    architecture: "gru-encoder-decoder-seq2seq",
    runtime: "CoreML",
    localOnly: true,
    neuralTailOnly: true,
    productionEligible: false,
    openVocabulary: true,
    trainingSources: ["ai4bharat-aksharantar-nepali"],
    modelBytes: compiledEvidence.bytes,
    sha256: {
      vocabMetadata: vocabularyEvidence.sha256,
      compiledModel: compiledEvidence.sha256
    }
  };
  writeJson(manifestPath, manifest);
  const manifestEvidence = inspectContainedRegularFile(root, manifestPath);
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: root,
    manifest,
    manifestPath,
    vocabPath: vocabularyPath
  });
  const splitSha256 = {
    train: "4".repeat(64),
    dev: "5".repeat(64)
  };
  const trainingIsolation = {
    policy: "official-benchmark-inputs-absent-from-train-and-dev-v1",
    benchmarkInputSha256: "6".repeat(64),
    comparedSplitSha256: splitSha256,
    overlappingInputCount: 0
  };
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
  const exportReport = {
    status: "passed-open-vocab-seq2seq-candidate",
    productionEligible: false,
    coremlExport: { status: "passed" },
    runtimeArtifactContractIssues: [],
    trainingRunId,
    exportRunId,
    modelId: manifest.selectedArtifact,
    artifactOverrides: {},
    runInputSnapshot: {
      dataset: {
        splits: {
          train: { sha256: splitSha256.train },
          dev: { sha256: splitSha256.dev }
        }
      },
      officialBenchmark: {
        trainingIsolation
      }
    },
    comparisonBenchmark: {
      trainingIsolation
    },
    manifest: portable(root, manifestPath),
    manifestSha256: manifestEvidence.sha256
  };
  writeJson(exportReportPath, exportReport);
  const exportEvidence = inspectContainedRegularFile(root, exportReportPath);
  const artifactIdentity = {
    trainingRunId,
    exportRunId,
    manifestSha256: manifestEvidence.sha256,
    vocabSha256: vocabularyEvidence.sha256,
    artifactSetSha256: descriptor.artifactSetSha256
  };
  const evaluation = {
    status: "passed-production-phase5-evaluation",
    production: true,
    productionEligible: true,
    predictionValidation: {
      exactCoverage: true,
      metricsReportable: true
    },
    failures: [],
    trainingRunId,
    exportRunId,
    candidateManifestSha256: manifestEvidence.sha256,
    exportReportSha256: exportEvidence.sha256,
    artifactIdentity,
    datasetManifest: portable(root, shared.datasetManifest),
    datasetManifestSha256: shared.datasetEvidence.sha256,
    datasetContentSha256: DATASET_CONTENT_SHA,
    goldManifest: portable(root, shared.goldManifest),
    goldManifestSha256: shared.goldEvidence.sha256,
    goldCorpusSha256: GOLD_CORPUS_SHA,
    metrics: {
      tailTop1Accuracy: 0.91,
      tailTop3Accuracy: 0.98
    }
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
      p99Ms: options.label === "attention" ? 20 : 10
    }
  };
  writeJson(benchmarkPath, benchmark);
  write(
    comparisonPredictions,
    [
      {
        id: "official-native",
        input: "nepal",
        candidates: ["नेपाल"]
      },
      {
        id: "official-indian",
        input: "niraj",
        candidates: ["निरज"]
      },
      {
        id: "official-foreign",
        input: "rohan",
        candidates: ["रोहन"]
      }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n"
  );
  const predictionEvidence = inspectContainedRegularFile(
    root,
    comparisonPredictions
  );
  const top1Hits = options.officialTop1Hits;
  const comparison = {
    schemaVersion: 1,
    status: "passed-official-benchmark-evaluation",
    suite: "neural-official-benchmark-evaluation",
    productionEligible: true,
    failures: [],
    qualityGate: { passed: true },
    trainingRunId,
    exportRunId,
    candidateManifestSha256: manifestEvidence.sha256,
    artifactIdentity,
    benchmarkManifest:
      "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
    benchmarkManifestSha256: BENCHMARK_MANIFEST_SHA,
    benchmarkCorpusSha256: BENCHMARK_CORPUS_SHA,
    benchmarkIsolation: trainingIsolation,
    predictions: portable(root, comparisonPredictions),
    predictionsSha256: predictionEvidence.sha256,
    predictionsBackend: "coreml-compiled-model",
    predictionArtifactIdentity,
    predictionRows: 3,
    distinctInputCount: 3,
    reference: {
      manifest: "data/neural/benchmarks/indicxlit-v1/manifest.json",
      manifestSha256: REFERENCE_MANIFEST_SHA
    },
    metrics: {
      overall: metric(3, top1Hits, 3),
      byBucket: {
        "native-frequent": metric(
          1,
          top1Hits >= 1 ? 1 : 0,
          1
        ),
        "indian-name": metric(
          1,
          top1Hits >= 2 ? 1 : 0,
          1
        ),
        "foreign-name": metric(
          1,
          top1Hits >= 3 ? 1 : 0,
          1
        )
      }
    }
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
    comparisonPath,
    comparisonPredictions,
    exportRunId
  };
}

function runSelection(fixture) {
  return spawnSync(process.execPath, [
    checker,
    "--production",
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

function metric(rows, top1Hits, top3Hits) {
  return {
    rows,
    top1Hits,
    top3Hits,
    top1Accuracy: round(top1Hits / rows),
    top3Accuracy: round(top3Hits / rows)
  };
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
