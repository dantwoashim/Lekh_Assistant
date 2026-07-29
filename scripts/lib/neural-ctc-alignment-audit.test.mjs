import { describe, expect, it } from "vitest";
import {
  ctcRequiredTimeSteps,
  NeuralCTCAlignmentAccumulator,
  normalizeCTCAuditInput,
  normalizeCTCAuditOutput
} from "./neural-ctc-alignment-audit.mjs";

describe("Transformer-CTC dataset alignment audit", () => {
  it("matches trainer normalization and exact repeated-label alignment", () => {
    expect(normalizeCTCAuditInput("  VAto\tKo  ")).toBe("vato ko");
    expect(normalizeCTCAuditOutput("  किँ  ")).toBe("किँ");
    expect(ctcRequiredTimeSteps("लेख")).toBe(3);
    expect(ctcRequiredTimeSteps("कक")).toBe(3);
    expect(ctcRequiredTimeSteps("ककक")).toBe(5);
    expect(ctcRequiredTimeSteps(["क", "्", "ष"])).toBe(3);
  });

  it("proves representability against the frozen train vocabulary", () => {
    const accumulator = new NeuralCTCAlignmentAccumulator({
      maxInputLength: 6,
      outputTimeSteps: 5
    });
    accumulator.add(datasetRow("train-a", "kaka", "कक"), "train", "train:1");
    accumulator.add(datasetRow("train-b", "lekha", "लेख"), "train", "train:2");
    accumulator.finishTrainingSplit();
    accumulator.add(datasetRow("dev-a", "kaka", "कक", "dev"), "dev", "dev:1");
    accumulator.add(datasetRow("test-a", "kaka", "झ", "test"), "test", "test:1");
    accumulator.addEvaluationRelease("gold", [
      evaluationRow("gold-pass", "lekha", ["लेख"]),
      evaluationRow("gold-fail", "kaka", ["झ"]),
      {
        id: "gold-negative",
        input: "github",
        expectedAction: "no-neural-candidate",
        expected: [],
        acceptable: []
      }
    ]);

    const report = accumulator.finalize(fixtureEvidence({
      train: 2,
      dev: 1,
      test: 1
    }));
    expect(report.status).toBe("failed-ctc-alignment-audit");
    expect(report.splits.train).toMatchObject({
      primaryRepeatedScalarRows: 1,
      primaryRepeatedScalarBoundaries: 1,
      primaryAlignmentOverflowRows: 0
    });
    expect(report.splits.dev).toMatchObject({
      primaryUnseenScalarRows: 0,
      rowsWithNoRepresentableTarget: 0
    });
    expect(report.splits.test).toMatchObject({
      primaryUnseenScalarRows: 1,
      rowsWithNoRepresentableTarget: 1
    });
    expect(report.evaluation.gold).toMatchObject({
      rows: 3,
      positiveRows: 2,
      negativeRows: 1,
      positiveRowsWithRepresentableTarget: 1,
      positiveRowsWithNoRepresentableTarget: 1
    });
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "test-unseen-primary-output-scalars",
        "test-unrepresentable-rows",
        "gold-unrepresentable-positive-rows"
      ])
    );
  });

  it("fails closed on input capacity, target grammar, and CTC alignment", () => {
    const accumulator = new NeuralCTCAlignmentAccumulator({
      maxInputLength: 5,
      outputTimeSteps: 3
    });
    accumulator.add(datasetRow("train-a", "abcd", "ककक"), "train", "train:1");
    accumulator.add(datasetRow("train-b", "abcde", "ेक"), "train", "train:2");
    accumulator.finishTrainingSplit();
    accumulator.add(datasetRow("dev-a", "abcd", "ककक", "dev"), "dev", "dev:1");
    accumulator.add(datasetRow("test-a", "abcd", "ककक", "test"), "test", "test:1");

    const report = accumulator.finalize(fixtureEvidence({
      train: 2,
      dev: 1,
      test: 1
    }));
    expect(report.splits.train).toMatchObject({
      inputOverCapacityRows: 1,
      invalidTargetVariants: 1,
      primaryAlignmentOverflowRows: 1,
      rowsWithNoRepresentableTarget: 2
    });
    expect(report.status).toBe("failed-ctc-alignment-audit");
  });

  it("produces deterministic output for the same ordered stream", () => {
    expect(JSON.stringify(passingFixture())).toBe(
      JSON.stringify(passingFixture())
    );
    expect(passingFixture().status).toBe("passed-ctc-alignment-audit");
  });
});

function passingFixture() {
  const accumulator = new NeuralCTCAlignmentAccumulator({
    maxInputLength: 6,
    outputTimeSteps: 5
  });
  accumulator.add(datasetRow("train-a", "lekha", "लेख"), "train", "train:1");
  accumulator.finishTrainingSplit();
  accumulator.add(datasetRow("dev-a", "lekha", "लेख", "dev"), "dev", "dev:1");
  accumulator.add(datasetRow("test-a", "lekha", "लेख", "test"), "test", "test:1");
  accumulator.addEvaluationRelease("gold", [
    evaluationRow("gold-pass", "lekha", ["लेख"])
  ]);
  return accumulator.finalize(fixtureEvidence({
    train: 1,
    dev: 1,
    test: 1
  }));
}

function datasetRow(id, input, target, split = "train") {
  return {
    id,
    split,
    action: "produce-candidate",
    input,
    target,
    acceptable: [target]
  };
}

function evaluationRow(id, input, expected) {
  return {
    id,
    input,
    expectedAction: "produce-candidate",
    expected,
    acceptable: []
  };
}

function fixtureEvidence(counts) {
  const splitArtifacts = Object.fromEntries(
    Object.entries(counts).map(([split, rows]) => [
      split,
      {
        path: `${split}.jsonl`,
        expected: {
          bytes: rows,
          rows,
          sha256: split.repeat(16).slice(0, 64).padEnd(64, "0")
        },
        observed: {
          bytes: rows,
          rows,
          sha256: split.repeat(16).slice(0, 64).padEnd(64, "0"),
          invalidJsonRows: 0
        },
        integrityMatches: true
      }
    ])
  );
  return {
    model: {
      id: "fixture-ctc",
      configPath: "fixture.json",
      configSha256: "a".repeat(64),
      implementationContractVersion: 1,
      runtimeModelContract: "fixture"
    },
    dataset: {
      id: "fixture",
      manifestPath: "manifest.json",
      manifestSha256: "b".repeat(64),
      declaredContentSha256: "c".repeat(64),
      declaredRows: Object.values(counts).reduce((sum, value) => sum + value, 0),
      declaredCounts: counts
    },
    artifacts: {
      splits: splitArtifacts,
      evaluationReferences: {}
    }
  };
}
