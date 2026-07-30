import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  CTC_COREML_PARITY_CASE_IDS,
  CTC_COREML_PARITY_POLICY
} from "./lib/neural-ctc-coreml-parity-contract.mjs";
import {
  CTC_FINITE_PATH_DECODER_POLICY
} from "./lib/neural-ctc-finite-path-contract.mjs";

const evaluator = join(
  process.cwd(),
  "scripts",
  "evaluate-neural-official-benchmark.mjs"
);
const sourceRoot = process.cwd();

describe("official benchmark evaluator CLI", () => {
  it("binds exact export/model/benchmark bytes and reproduces reference metrics", () => {
    withFixture((fixture) => {
      const result = run(fixture);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = readJson(fixture.report);
      assert.equal(report.status, "passed-official-benchmark-evaluation");
      assert.equal(report.productionEligible, true);
      assert.equal(report.exactCoverage, true);
      assert.equal(report.metrics.overall.top1Accuracy, 1);
      assert.equal(report.qualityGate.passed, true);
      assert.equal(report.artifactIdentity.artifactSetSha256.length, 64);
      assert.equal(
        report.benchmarkIsolationVerification
          .recomputedFromDatasetSplits,
        true
      );
      assert.equal(
        report.benchmarkIsolationVerification.datasetManifest.sha256,
        fixture.datasetManifestEvidence.sha256
      );
    });
  });

  it("rejects predictions whose bytes changed after export publication", () => {
    withFixture((fixture) => {
      write(
        fixture.predictions,
        `${JSON.stringify({
          id: "native",
          input: "nepal",
          candidates: ["नेपाळ"]
        })}\n`
      );
      const result = run(fixture);
      assert.equal(result.status, 1);
      const report = readJson(fixture.report);
      assert.equal(report.productionEligible, false);
      assert.ok(report.failures.some((failure) =>
        /does not bind the exact official benchmark/u.test(failure)
      ));
    });
  });

  it("rejects missing or stale benchmark training-isolation evidence", () => {
    withFixture((fixture) => {
      const exportReport = readJson(fixture.exportReport);
      delete exportReport.comparisonBenchmark.trainingIsolation;
      writeJson(fixture.exportReport, exportReport);

      const result = run(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /training-isolation proof/u.test(failure)
      ));
    });
  });

  it("rejects a rehashed zero-overlap claim when train bytes contain an official input", () => {
    withFixture((fixture) => {
      injectRehashedTrainingLeakage(fixture);
      const result = run(fixture);
      assert.equal(result.status, 1);
      const report = readJson(fixture.report);
      assert.equal(report.productionEligible, false);
      assert.ok(report.failures.some((failure) =>
        /leakage recomputation failed/u.test(failure) &&
        /overlap-detected/u.test(failure)
      ));
    });
  });

  it("rejects train bytes changed without a matching dataset manifest", () => {
    withFixture((fixture) => {
      write(
        fixture.trainSplit,
        `${readFileSync(fixture.trainSplit, "utf8")}` +
          `${JSON.stringify(datasetRow("train", "tampered"))}\n`
      );
      const result = run(fixture);
      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /split-identity-invalid:train/u.test(failure)
      ));
    });
  });

  it("rejects an export without exact finite-path decoder evidence", () => {
    withFixture((fixture) => {
      const exportReport = readJson(fixture.exportReport);
      delete exportReport.coremlExport.finitePathDecoderPolicy;
      writeJson(fixture.exportReport, exportReport);

      const result = run(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /exact finite-path decoder policy/u.test(failure)
      ));
    });
  });

  it("rejects an export without representative Core ML parity", () => {
    withFixture((fixture) => {
      const exportReport = readJson(fixture.exportReport);
      delete exportReport.coremlExport.representativeParityPolicy;
      writeJson(fixture.exportReport, exportReport);

      const result = run(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /representative compiled Core ML parity evidence/u.test(failure)
      ));
    });
  });

  it("rejects a prediction backend identity that differs from the model bytes", () => {
    withFixture((fixture) => {
      const exportReport = readJson(fixture.exportReport);
      exportReport.comparisonBenchmark.predictionArtifactIdentity
        .compiledArtifacts.model.sha256 = "f".repeat(64);
      writeJson(fixture.exportReport, exportReport);

      const result = run(fixture);

      assert.equal(result.status, 1);
      assert.ok(readJson(fixture.report).failures.some((failure) =>
        /exact compiled candidate artifact set/u.test(failure)
      ));
    });
  });
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-official-eval-"));
  const rootAlias = join(parent, "repo");
  mkdirSync(rootAlias, { recursive: true });
  const root = realpathSync(rootAlias);
  try {
    callback(buildFixture(root));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function buildFixture(root) {
  const candidate = join(root, "data", "generated", "candidate");
  const manifest = join(
    candidate,
    "LekhNeuralTransliterator.manifest.json"
  );
  const vocabulary = join(
    candidate,
    "LekhNeuralTransliterator.vocab.json"
  );
  const compiled = join(candidate, "LekhNeuralTransliterator.mlmodelc");
  const predictions = join(candidate, "official-predictions.jsonl");
  const exportReport = join(candidate, "export-report.json");
  const datasetRoot = join(
    root,
    "data",
    "generated",
    "neural-open-vocab"
  );
  const trainSplit = join(datasetRoot, "train.jsonl");
  const devSplit = join(datasetRoot, "dev.jsonl");
  const datasetManifest = join(datasetRoot, "manifest.json");
  const benchmarkRoot = join(
    root,
    "data",
    "neural",
    "benchmarks",
    "aksharantar-nepali-test-v1"
  );
  const benchmarkManifest = join(benchmarkRoot, "manifest.json");
  const referenceRoot = join(
    root,
    "data",
    "neural",
    "benchmarks",
    "indicxlit-v1"
  );
  const referencePredictions = join(
    referenceRoot,
    "nepali-aksharantar-v1.predictions.jsonl"
  );
  const referenceManifest = join(referenceRoot, "manifest.json");
  const report = join(root, "reports", "official-evaluation.json");

  copyRelativeEvidence(
    root,
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
  );
  const benchmark = readJson(benchmarkManifest);
  for (const suite of benchmark.suites) {
    copyRelativeEvidence(root, suite.path);
  }
  copyRelativeEvidence(
    root,
    "data/neural/benchmarks/indicxlit-v1/manifest.json"
  );
  copyRelativeEvidence(
    root,
    "data/neural/benchmarks/indicxlit-v1/nepali-aksharantar-v1.predictions.jsonl"
  );
  const suites = benchmark.suites;
  const corpusSha256 = benchmark.corpusSha256;
  const benchmarkEvidence = inspectContainedRegularFile(
    root,
    benchmarkManifest
  );

  const benchmarkRows = suites.flatMap((suite) =>
    readJsonLines(join(root, suite.path))
  );
  writeJsonLines(trainSplit, [
    datasetRow("train", "kathmandu"),
    datasetRow("train", "pokhara")
  ]);
  writeJsonLines(devSplit, [
    datasetRow("dev", "biratnagar")
  ]);
  const splitEvidence = {
    train: inspectContainedRegularFile(root, trainSplit),
    dev: inspectContainedRegularFile(root, devSplit)
  };
  writeJson(datasetManifest, {
    schemaVersion: 2,
    datasetContentSha256: sha256("fixture-dataset-content"),
    splitFiles: {
      train: portable(root, trainSplit),
      dev: portable(root, devSplit)
    },
    counts: {
      train: 2,
      dev: 1
    },
    bytes: {
      train: splitEvidence.train.bytes,
      dev: splitEvidence.dev.bytes
    },
    sha256: {
      train: splitEvidence.train.sha256,
      dev: splitEvidence.dev.sha256
    },
    cleaningPolicy: {
      normalizeInput: "trim lowercase NFC collapse-whitespace"
    }
  });
  const datasetManifestEvidence = inspectContainedRegularFile(
    root,
    datasetManifest
  );
  const candidateRows = benchmarkRows.map((row) => ({
    id: row.id,
    input: row.input,
    candidates: [row.acceptable[0]]
  }));
  write(
    predictions,
    `${candidateRows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
  const predictionEvidence = inspectContainedRegularFile(root, predictions);
  const referencePredictionEvidence = inspectContainedRegularFile(
    root,
    referencePredictions
  );
  write(vocabulary, JSON.stringify({
    schemaVersion: 1,
    tokenization: "unicode-scalar-character"
  }));
  write(join(compiled, "model.bin"), "compiled-fixture");
  const vocabularyEvidence = inspectContainedRegularFile(root, vocabulary);
  const compiledEvidence = inspectContainedDirectoryTree(root, compiled);
  const trainingRunId = "a".repeat(32);
  const exportRunId = "b".repeat(32);
  const splitSha256 = {
    train: splitEvidence.train.sha256,
    dev: splitEvidence.dev.sha256
  };
  const suiteEvidence = suites.map((suite) => ({
    id: suite.id,
    path: suite.path,
    sha256: suite.sha256,
    rows: suite.rows,
    benchmarkBucket: suite.benchmarkBucket
  }));
  const trainingIsolation = {
    policy: "official-benchmark-inputs-absent-from-train-and-dev-v1",
    benchmarkInputSha256: officialBenchmarkInputSha256(benchmarkRows),
    comparedSplitSha256: splitSha256,
    overlappingInputCount: 0
  };
  writeJson(manifest, {
    schemaVersion: 2,
    trainingRunId,
    exportRunId,
    selectedArtifact: "lekh-open-vocab-ctc-transformer-v2",
    architecture: "fixed-shape-transformer-ctc",
    runtimeModelContract: "single-transformer-ctc-v1",
    tensorContract: {
      inputIds: { shape: [1, 32], dataType: "INT32" },
      logits: { shape: [1, 32, 128], dataType: "FLOAT16" }
    },
    productionEligible: false,
    openVocabulary: true,
    modelBytes: compiledEvidence.bytes,
    sha256: {
      vocabMetadata: vocabularyEvidence.sha256,
      compiledModel: compiledEvidence.sha256,
      trainingDatasetManifest: datasetManifestEvidence.sha256
    }
  });
  const manifestEvidence = inspectContainedRegularFile(root, manifest);
  writeJson(exportReport, {
    status: "passed-open-vocab-ctc-transformer-candidate",
    productionEligible: false,
    coremlExport: {
      status: "passed",
      finitePathDecoderPolicy:
        structuredClone(CTC_FINITE_PATH_DECODER_POLICY),
      ...ctcCoreMLParityEvidence()
    },
    runtimeArtifactContractIssues: [],
    trainingRunId,
    exportRunId,
    modelId: "lekh-open-vocab-ctc-transformer-v2",
    runtimeModelContract: "single-transformer-ctc-v1",
    artifactOverrides: {},
    runInputSnapshot: {
      dataset: {
        manifest: portable(root, datasetManifest),
        manifestSha256: datasetManifestEvidence.sha256,
        contentSha256:
          readJson(datasetManifest).datasetContentSha256,
        splits: {
          train: {
            path: portable(root, trainSplit),
            sha256: splitEvidence.train.sha256,
            bytes: splitEvidence.train.bytes,
            rows: 2
          },
          dev: {
            path: portable(root, devSplit),
            sha256: splitEvidence.dev.sha256,
            bytes: splitEvidence.dev.bytes,
            rows: 1
          }
        }
      },
      officialBenchmark: {
        manifest: portable(root, benchmarkManifest),
        manifestSha256: benchmarkEvidence.sha256,
        corpusSha256,
        suites: suiteEvidence,
        rows: benchmarkRows.length,
        trainingIsolation
      }
    },
    manifest: portable(root, manifest),
    manifestSha256: manifestEvidence.sha256,
    comparisonBenchmark: {
      manifest: portable(root, benchmarkManifest),
      manifestSha256: benchmarkEvidence.sha256,
      corpusSha256,
      predictions: portable(root, predictions),
      predictionsSha256: predictionEvidence.sha256,
      rows: benchmarkRows.length,
      suites: suiteEvidence,
      trainingIsolation,
      predictionsBackend: "coreml-compiled-transformer-ctc",
      predictionArtifactIdentity: {
        runtimeModelContract: "single-transformer-ctc-v1",
        compiledArtifacts: {
          model: {
            path: portable(root, compiled),
            sha256: compiledEvidence.sha256,
            bytes: compiledEvidence.bytes
          }
        }
      }
    }
  });
  return {
    root,
    predictions,
    exportReport,
    benchmarkManifest,
    referenceManifest,
    report,
    manifest,
    trainSplit,
    devSplit,
    datasetManifest,
    datasetManifestEvidence
  };
}

function ctcCoreMLParityEvidence() {
  const cases = CTC_COREML_PARITY_CASE_IDS.map((caseId, index) => ({
    caseId,
    contentLength: [6, 3, 5, 8, 31][index],
    inputSha256: sha256(`official-parity-input-${index}`),
    maximumAbsoluteLogitError: (index + 1) / 10_000
  }));
  const identities = cases.map((candidate) => ({
    caseId: candidate.caseId,
    contentLength: candidate.contentLength,
    inputSha256: candidate.inputSha256
  }));
  const suite = {
    schemaVersion: 1,
    status: "passed",
    policyId: CTC_COREML_PARITY_POLICY.policyId,
    caseCount: cases.length,
    caseIdentitySha256: sha256(JSON.stringify(identities)),
    maximumAbsoluteLogitError: 0.0005,
    relativeTolerance: 5e-3,
    absoluteTolerance: 5e-3,
    cases
  };
  return {
    tensorContract: {
      inputIds: { shape: [1, 32], dataType: "INT32" },
      logits: { shape: [1, 32, 128], dataType: "FLOAT16" }
    },
    representativeParityPolicy: structuredClone(
      CTC_COREML_PARITY_POLICY
    ),
    prePublicationValidation: {
      status: "passed",
      knownAnswerInputSha256: cases[0].inputSha256,
      maximumAbsoluteLogitError:
        cases[0].maximumAbsoluteLogitError,
      relativeTolerance: 5e-3,
      absoluteTolerance: 5e-3,
      representativeParitySuite: structuredClone(suite)
    },
    artifactValidation: {
      status: "passed",
      knownAnswerInputSha256: cases[0].inputSha256,
      maximumAbsoluteLogitError:
        cases[0].maximumAbsoluteLogitError,
      relativeTolerance: 5e-3,
      absoluteTolerance: 5e-3,
      representativeParitySuite: structuredClone(suite)
    }
  };
}

function run(fixture) {
  return spawnSync(process.execPath, [
    evaluator,
    "--predictions",
    fixture.predictions,
    "--export-report",
    fixture.exportReport,
    "--benchmark-manifest",
    fixture.benchmarkManifest,
    "--reference-manifest",
    fixture.referenceManifest,
    "--report",
    fixture.report
  ], {
    cwd: fixture.root,
    encoding: "utf8"
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function officialBenchmarkInputSha256(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(String(row.id));
    hash.update("\0");
    hash.update(
      String(row.input).normalize("NFC").trim().toLocaleLowerCase("en-US")
        .replace(/\s+/gu, " ")
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

function injectRehashedTrainingLeakage(fixture) {
  const benchmark = readJson(fixture.benchmarkManifest);
  const officialRows = benchmark.suites.flatMap((suite) =>
    readJsonLines(join(fixture.root, suite.path))
  );
  const leakedInput = officialRows[0].input;
  const trainRows = [
    datasetRow("train", "kathmandu"),
    datasetRow("train", leakedInput)
  ];
  writeJsonLines(fixture.trainSplit, trainRows);
  const trainEvidence = inspectContainedRegularFile(
    fixture.root,
    fixture.trainSplit
  );
  const devEvidence = inspectContainedRegularFile(
    fixture.root,
    fixture.devSplit
  );

  const datasetManifest = readJson(fixture.datasetManifest);
  datasetManifest.counts.train = trainRows.length;
  datasetManifest.bytes.train = trainEvidence.bytes;
  datasetManifest.sha256.train = trainEvidence.sha256;
  writeJson(fixture.datasetManifest, datasetManifest);
  const datasetManifestEvidence = inspectContainedRegularFile(
    fixture.root,
    fixture.datasetManifest
  );

  const manifest = readJson(fixture.manifest);
  manifest.sha256.trainingDatasetManifest =
    datasetManifestEvidence.sha256;
  writeJson(fixture.manifest, manifest);
  const manifestEvidence = inspectContainedRegularFile(
    fixture.root,
    fixture.manifest
  );

  const trainingIsolation = {
    policy: "official-benchmark-inputs-absent-from-train-and-dev-v1",
    benchmarkInputSha256: officialBenchmarkInputSha256(officialRows),
    comparedSplitSha256: {
      train: trainEvidence.sha256,
      dev: devEvidence.sha256
    },
    overlappingInputCount: 0
  };
  const exportReport = readJson(fixture.exportReport);
  exportReport.manifestSha256 = manifestEvidence.sha256;
  exportReport.runInputSnapshot.dataset.manifestSha256 =
    datasetManifestEvidence.sha256;
  exportReport.runInputSnapshot.dataset.splits.train = {
    path: portable(fixture.root, fixture.trainSplit),
    sha256: trainEvidence.sha256,
    bytes: trainEvidence.bytes,
    rows: trainRows.length
  };
  exportReport.runInputSnapshot.dataset.splits.dev = {
    path: portable(fixture.root, fixture.devSplit),
    sha256: devEvidence.sha256,
    bytes: devEvidence.bytes,
    rows: 1
  };
  exportReport.runInputSnapshot.officialBenchmark.trainingIsolation =
    trainingIsolation;
  exportReport.comparisonBenchmark.trainingIsolation =
    trainingIsolation;
  writeJson(fixture.exportReport, exportReport);
}

function datasetRow(split, input) {
  return {
    schemaVersion: 1,
    split,
    input
  };
}

function copyRelativeEvidence(root, relativePath) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(sourceRoot, relativePath), target);
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
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

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
