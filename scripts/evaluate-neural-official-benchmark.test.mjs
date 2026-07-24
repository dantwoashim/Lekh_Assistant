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
    train: "c".repeat(64),
    dev: "d".repeat(64)
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
    selectedArtifact: "lekh-open-vocab-seq2seq-v1",
    architecture: "gru-encoder-decoder-seq2seq",
    productionEligible: false,
    openVocabulary: true,
    modelBytes: compiledEvidence.bytes,
    sha256: {
      vocabMetadata: vocabularyEvidence.sha256,
      compiledModel: compiledEvidence.sha256
    }
  });
  const manifestEvidence = inspectContainedRegularFile(root, manifest);
  writeJson(exportReport, {
    status: "passed-open-vocab-seq2seq-candidate",
    productionEligible: false,
    coremlExport: { status: "passed" },
    runtimeArtifactContractIssues: [],
    trainingRunId,
    exportRunId,
    modelId: "lekh-open-vocab-seq2seq-v1",
    artifactOverrides: {},
    runInputSnapshot: {
      dataset: {
        splits: {
          train: { sha256: splitSha256.train },
          dev: { sha256: splitSha256.dev }
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
      predictionsBackend: "coreml-compiled-model",
      predictionArtifactIdentity: {
        runtimeModelContract: "single-seq2seq-v1",
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
    report
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
