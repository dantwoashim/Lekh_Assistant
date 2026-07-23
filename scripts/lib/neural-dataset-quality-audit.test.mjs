import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRepoRegularFile } from "../audit-neural-open-vocab-dataset.mjs";
import {
  createEvaluationIdentityIndex,
  NeuralDatasetQualityAccumulator,
  normalizeAuditInput,
  normalizeAuditOutput,
  trainerOutputGraphemes
} from "./neural-dataset-quality-audit.mjs";

describe("neural open-vocabulary dataset quality audit", () => {
  it("mirrors the trainer's normalization and Devanagari tokenization", () => {
    expect(normalizeAuditInput("  VAto\tKo  ")).toBe("vato ko");
    expect(normalizeAuditOutput("  किँ  ")).toBe("किँ");
    expect(trainerOutputGraphemes("किं")).toEqual(["किं"]);
    expect(trainerOutputGraphemes("क्ष")).toEqual(["क्", "ष"]);
  });

  it("reports capacity, alphabet, conflict, Unicode, vocabulary, and leakage risks", () => {
    const report = fixtureReport();

    expect(report.status).toBe("failed-data-quality-audit");
    expect(report.lengths.capacityRisk).toMatchObject({
      inputOverContentCapacity: 1,
      outputOverContentCapacity: 1,
      rowsThatWouldBeSilentlyTruncated: 0,
      trainingWouldAbort: true
    });
    expect(report.punctuationAndDigits).toMatchObject({
      inputContainsDigit: 1,
      inputUnsupportedByTrainer: 2,
      outputContainsDevanagariDigit: 1
    });
    expect(report.conflicts).toMatchObject({
      conflictingInputs: 1,
      conflictingRows: 2,
      maximumTargetsPerInput: 2
    });
    expect(report.invalidUnicodeAndStructure.counts["input-control-or-format"]).toBe(1);
    expect(report.evaluationLeakage.gold.byDatasetSplit.train).toMatchObject({
      inputRows: 1,
      targetRows: 1,
      exactPairRows: 1,
      uniquePairs: 1
    });
    expect(report.vocabulary.unseenRowsComparedWithTrain.dev).toMatchObject({
      inputCharacterRows: 1,
      outputGraphemeRows: 1
    });
    expect(report.findings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "invalid-rows",
      "trainer-length-incompatibility",
      "trainer-input-alphabet-incompatibility",
      "gold-train-leakage",
      "conflicting-targets",
      "dev-unseen-vocabulary"
    ]));
  });

  it("produces deterministic reports for the same ordered stream", () => {
    expect(JSON.stringify(fixtureReport())).toBe(JSON.stringify(fixtureReport()));
  });

  it("turns artifact tampering and manifest count drift into error findings", () => {
    const accumulator = new NeuralDatasetQualityAccumulator();
    accumulator.add(row("only", "lekha", "लेख"), "train", "train:1");
    const report = accumulator.finalize({
      dataset: { id: "tampered", declaredRows: 2, declaredCounts: { train: 2, dev: 0, test: 0 } },
      artifacts: {
        splits: {
          train: { path: "train.jsonl", integrityMatches: false, observed: { rows: 1 } },
          dev: { path: "dev.jsonl", integrityMatches: true, observed: { rows: 0 } },
          test: { path: "test.jsonl", integrityMatches: true, observed: { rows: 0 } }
        },
        evaluationReferences: {}
      }
    });
    expect(report.findings.filter(({ severity }) => severity === "error").map(({ code }) => code)).toEqual(expect.arrayContaining([
      "artifact-integrity-mismatch",
      "declared-row-count-mismatch"
    ]));
  });

  it("rejects repository escapes and symbolic-link inputs", () => {
    expect(() => resolveRepoRegularFile("/etc/hosts", "fixture")).toThrow(/outside repository root/u);
    const temporaryRoot = resolve(process.cwd(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(resolve(temporaryRoot, "neural-audit-path-"));
    const link = resolve(directory, "dataset.jsonl");
    try {
      symlinkSync(resolve(process.cwd(), "scripts/lib/neural-dataset-quality-audit.mjs"), link);
      expect(() => resolveRepoRegularFile(link, "fixture")).toThrow(/symbolic-link/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fixtureReport() {
  const evaluationIndex = createEvaluationIdentityIndex("gold", [{
    input: "vato",
    expectedAction: "produce-candidate",
    expected: ["बाटो"],
    acceptable: []
  }]);
  const accumulator = new NeuralDatasetQualityAccumulator({ evaluationIndexes: [evaluationIndex] });
  const rows = [
    row("a", "vato", "बाटो"),
    row("b", "same", "एक"),
    row("c", "same", "दुई"),
    row("d", "abc1", "१२"),
    row("e", "a".repeat(32), "क".repeat(31)),
    row("f", "ctrl\u0001", "क")
  ];
  rows.forEach((value, index) => accumulator.add(value, "train", `train:${index + 1}`));
  accumulator.add(row("g", "z", "झ", "dev"), "dev", "dev:1");
  accumulator.add(row("h", "vato", "बाटो", "test"), "test", "test:1");
  return accumulator.finalize({
    dataset: { id: "fixture", declaredRows: 8, declaredCounts: { train: 6, dev: 1, test: 1 } },
    artifacts: {
      splits: Object.fromEntries(["train", "dev", "test"].map((split) => [split, {
        path: `${split}.jsonl`,
        integrityMatches: true,
        observed: { rows: { train: 6, dev: 1, test: 1 }[split] }
      }])),
      evaluationReferences: {}
    }
  });
}

function row(id, input, target, split = "train") {
  return {
    id,
    split,
    action: "produce-candidate",
    input,
    target,
    category: "romanized-token",
    sourceIds: ["fixture-source"],
    sourceTier: "fixture",
    reviewTier: "fixture",
    weight: 1
  };
}
