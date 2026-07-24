import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
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
    "official"
  );
  const benchmarkManifest = join(benchmarkRoot, "manifest.json");
  const referenceRoot = join(
    root,
    "data",
    "neural",
    "benchmarks",
    "reference"
  );
  const referencePredictions = join(referenceRoot, "predictions.jsonl");
  const referenceManifest = join(referenceRoot, "manifest.json");
  const report = join(root, "reports", "official-evaluation.json");

  const suiteDefinitions = [
    ["native", "native-frequent", "nepal", "नेपाल"],
    ["indian", "indian-name", "niraj", "निरज"],
    ["foreign", "foreign-name", "rohan", "रोहन"]
  ];
  const suites = suiteDefinitions.map(([id, bucket, input, output]) => {
    const path = join(benchmarkRoot, `${id}.jsonl`);
    write(path, `${JSON.stringify({
      schemaVersion: 1,
      id,
      input,
      acceptable: [output],
      expected: [output]
    })}\n`);
    const evidence = inspectContainedRegularFile(root, path);
    return {
      id,
      path: portable(root, path),
      sha256: evidence.sha256,
      rows: 1,
      benchmarkBucket: bucket
    };
  });
  const corpusSha256 = benchmarkCorpusSha256(suites);
  writeJson(benchmarkManifest, {
    schemaVersion: 2,
    status: "official-public-benchmark-locked",
    trainingUse: "forbidden-evaluation-only",
    corpusSha256,
    suites
  });
  const benchmarkEvidence = inspectContainedRegularFile(
    root,
    benchmarkManifest
  );

  const candidateRows = suiteDefinitions.map(([id, , input, output]) => ({
    id,
    input,
    candidates: [output]
  }));
  write(
    predictions,
    `${candidateRows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
  const predictionEvidence = inspectContainedRegularFile(root, predictions);
  const referenceRows = suiteDefinitions.map(([id, bucket, input, output]) => ({
    id,
    input,
    benchmarkBucket: bucket,
    acceptable: [output],
    candidates: [output]
  }));
  write(
    referencePredictions,
    `${referenceRows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
  const referencePredictionEvidence = inspectContainedRegularFile(
    root,
    referencePredictions
  );
  writeJson(referenceManifest, {
    schemaVersion: 1,
    status: "measured-external-comparison",
    trainingUse: "forbidden-comparison-only",
    benchmark: {
      manifest: portable(root, benchmarkManifest),
      manifestSha256: benchmarkEvidence.sha256,
      corpusSha256,
      rows: 3
    },
    predictionArtifact: {
      path: portable(root, referencePredictions),
      sha256: referencePredictionEvidence.sha256,
      bytes: referencePredictionEvidence.bytes,
      rows: 3
    }
  });

  write(vocabulary, JSON.stringify({
    schemaVersion: 1,
    tokenization: "unicode-scalar-character"
  }));
  write(join(compiled, "model.bin"), "compiled-fixture");
  const vocabularyEvidence = inspectContainedRegularFile(root, vocabulary);
  const compiledEvidence = inspectContainedDirectoryTree(root, compiled);
  const trainingRunId = "a".repeat(32);
  const exportRunId = "b".repeat(32);
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
    manifest: portable(root, manifest),
    manifestSha256: manifestEvidence.sha256,
    comparisonBenchmark: {
      manifest: portable(root, benchmarkManifest),
      manifestSha256: benchmarkEvidence.sha256,
      corpusSha256,
      predictions: portable(root, predictions),
      predictionsSha256: predictionEvidence.sha256,
      rows: 3
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

function benchmarkCorpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    for (const [value, terminator] of [
      [suite.id, "\0"],
      [suite.path, "\0"],
      [suite.sha256, "\0"],
      [suite.rows, "\n"]
    ]) {
      hash.update(String(value));
      hash.update(terminator);
    }
  }
  return hash.digest("hex");
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
