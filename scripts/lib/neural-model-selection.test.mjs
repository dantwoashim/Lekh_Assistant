import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  NeuralModelSelectionError,
  buildNeuralSelectionReport,
  validateNeuralSelectionReport
} from "./neural-model-selection.mjs";

const SHA = Object.freeze({
  datasetManifest: "1".repeat(64),
  datasetContent: "2".repeat(64),
  goldManifest: "3".repeat(64),
  goldCorpus: "4".repeat(64),
  benchmarkManifest: "5".repeat(64),
  benchmarkCorpus: "6".repeat(64)
});

describe("immutable neural model selection", () => {
  it("selects by the frozen quality-first order and validates its own receipt", () => {
    const baseline = candidate("baseline", "a", {
      officialOverallTop1Accuracy: 0.71,
      latencyP99Ms: 8
    });
    const attention = candidate("attention", "b", {
      officialOverallTop1Accuracy: 0.72,
      latencyP99Ms: 18
    });

    const report = buildNeuralSelectionReport({
      candidates: [baseline, attention],
      generatedAt: "2026-07-24T00:00:00.000Z"
    });
    const validated = validateNeuralSelectionReport(report);

    assert.equal(report.status, "passed-neural-model-selection");
    assert.equal(report.winner.candidateId, attention.candidateId);
    assert.deepEqual(report.ranking, [
      { rank: 1, candidateId: attention.candidateId },
      { rank: 2, candidateId: baseline.candidateId }
    ]);
    assert.equal(validated.selectionId, report.selectionId);
    assert.equal(validated.winner.identity.artifactSetSha256, "b".repeat(64));
  });

  it("uses packaged latency and bytes only after all quality metrics tie", () => {
    const slower = candidate("slower", "c", {
      latencyP99Ms: 20,
      compiledBytes: 2_000_000
    });
    const faster = candidate("faster", "d", {
      latencyP99Ms: 10,
      compiledBytes: 4_000_000
    });
    const report = buildNeuralSelectionReport({
      candidates: [slower, faster],
      generatedAt: "2026-07-24T00:00:00.000Z"
    });
    assert.equal(report.winner.candidateId, faster.candidateId);
  });

  it("rejects candidates evaluated on different immutable corpora", () => {
    const baseline = candidate("baseline", "a");
    const attention = candidate("attention", "b");
    attention.bindings.benchmarkCorpusSha256 = "f".repeat(64);

    assert.throws(
      () => buildNeuralSelectionReport({
        candidates: [baseline, attention],
        generatedAt: "2026-07-24T00:00:00.000Z"
      }),
      (error) =>
        error instanceof NeuralModelSelectionError &&
        /exact same dataset/u.test(error.message)
    );
  });

  it("rejects duplicate artifact sets masquerading as independent candidates", () => {
    const baseline = candidate("baseline", "a");
    const replay = candidate("replay", "a");

    assert.throws(
      () => buildNeuralSelectionReport({
        candidates: [baseline, replay],
        generatedAt: "2026-07-24T00:00:00.000Z"
      }),
      /distinct compiled artifact sets/u
    );
  });

  it("rejects re-exports of the same training run or source checkpoint", () => {
    const original = candidate("original", "a");
    for (const mutation of [
      (replay) => {
        replay.identity.trainingRunId = original.identity.trainingRunId;
      },
      (replay) => {
        replay.identity.sourceCheckpointSha256 =
          original.identity.sourceCheckpointSha256;
        replay.evidence.checkpoint.sha256 =
          original.identity.sourceCheckpointSha256;
      }
    ]) {
      const replay = candidate("replay", "b");
      mutation(replay);
      assert.throws(
        () => buildNeuralSelectionReport({
          candidates: [original, replay],
          generatedAt: "2026-07-24T00:00:00.000Z"
        }),
        /distinct trainingRunId|distinct source checkpoints/u
      );
    }
  });

  it("detects winner, ranking, evidence, and selection-id tampering", () => {
    const report = buildNeuralSelectionReport({
      candidates: [candidate("baseline", "a"), candidate("attention", "b", {
        officialOverallTop1Accuracy: 0.72
      })],
      generatedAt: "2026-07-24T00:00:00.000Z"
    });

    for (const mutate of [
      (copy) => {
        copy.winner = copy.candidates.find(
          (value) => value.candidateId !== copy.winner.candidateId
        );
      },
      (copy) => {
        copy.ranking.reverse();
      },
      (copy) => {
        copy.candidates[0].evidence.comparisonReport.sha256 = "f".repeat(64);
      },
      (copy) => {
        copy.selectionId = "0".repeat(64);
      }
    ]) {
      const copy = structuredClone(report);
      mutate(copy);
      assert.throws(
        () => validateNeuralSelectionReport(copy),
        NeuralModelSelectionError
      );
    }
  });
});

function candidate(name, digestSeed, metricOverrides = {}) {
  const suffix = digestSeed.charCodeAt(0).toString(16).padStart(2, "0");
  const digest = (offset) => {
    const value = (
      (Number.parseInt(suffix, 16) + offset) % 16
    ).toString(16);
    return value.repeat(64);
  };
  const trainingRunId = digestSeed.repeat(32);
  const exportSeed = String.fromCharCode(digestSeed.charCodeAt(0) + 1)
    .replace(/[^a-f]/u, "f");
  const exportRunId = exportSeed.repeat(32);
  const manifestSha256 = digest(1);
  const exportReportSha256 = digest(2);
  return {
    candidateId: `${name}:${exportRunId}`,
    candidateRoot: `data/generated/${name}`,
    modelId: name === "attention"
      ? "lekh-open-vocab-bigru-attention-v1"
      : "lekh-open-vocab-seq2seq-v1",
    architecture: name === "attention"
      ? "bidirectional-gru-additive-attention-seq2seq"
      : "gru-encoder-decoder-seq2seq",
    eligible: true,
    identity: {
      trainingRunId,
      exportRunId,
      sourceCheckpointSha256: digest(9),
      trainingReportSha256: digest(10),
      effectiveTrainingConfigSha256: digest(11),
      trainingSeed: digestSeed.charCodeAt(0),
      manifestSha256,
      exportReportSha256,
      vocabSha256: digest(3),
      artifactSetSha256: digestSeed.repeat(64)
    },
    evidence: {
      specification: {
        path: `reports/${name}-candidate.json`,
        sha256: digest(4)
      },
      manifest: {
        path: `data/generated/${name}/LekhNeuralTransliterator.manifest.json`,
        sha256: manifestSha256
      },
      exportReport: {
        path: `data/generated/${name}/export-report.json`,
        sha256: exportReportSha256
      },
      checkpoint: {
        path: `data/generated/${name}/checkpoint.pt`,
        sha256: digest(9)
      },
      trainingReport: {
        path: `data/generated/${name}/training-report.json`,
        sha256: digest(10)
      },
      evaluationReport: {
        path: `reports/${name}-evaluation.json`,
        sha256: digest(5)
      },
      datasetManifest: {
        path: "data/generated/neural-open-vocab/manifest.json",
        sha256: SHA.datasetManifest
      },
      goldManifest: {
        path: "data/neural/gold/manifest.json",
        sha256: SHA.goldManifest
      },
      benchmarkReport: {
        path: `reports/${name}-benchmark.json`,
        sha256: digest(6)
      },
      comparisonReport: {
        path: `reports/${name}-comparison.json`,
        sha256: digest(7)
      },
      benchmarkManifest: {
        path: "data/neural/benchmarks/official/manifest.json",
        sha256: SHA.benchmarkManifest
      },
      comparisonPredictions: {
        path: `data/generated/${name}/official-predictions.jsonl`,
        sha256: digest(8)
      }
    },
    bindings: {
      datasetManifestSha256: SHA.datasetManifest,
      datasetContentSha256: SHA.datasetContent,
      goldManifestSha256: SHA.goldManifest,
      goldCorpusSha256: SHA.goldCorpus,
      benchmarkManifestSha256: SHA.benchmarkManifest,
      benchmarkCorpusSha256: SHA.benchmarkCorpus
    },
    metrics: {
      officialOverallTop1Accuracy: 0.7,
      officialOverallTop3Accuracy: 0.85,
      officialNativeTop1Accuracy: 0.8,
      officialNameTop1Accuracy: 0.6,
      goldTailTop1Accuracy: 0.9,
      goldTailTop3Accuracy: 0.98,
      latencyP99Ms: 15,
      compiledBytes: 3_000_000,
      ...metricOverrides
    }
  };
}
