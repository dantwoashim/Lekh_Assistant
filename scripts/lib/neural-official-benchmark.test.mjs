import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  evaluateOfficialBenchmarkQuality,
  scoreOfficialBenchmark
} from "./neural-official-benchmark.mjs";

const rows = Object.freeze([
  Object.freeze({
    id: "native-1",
    input: "nepal",
    acceptable: Object.freeze(["नेपाल"]),
    benchmarkBucket: "native-frequent"
  }),
  Object.freeze({
    id: "indian-1",
    input: "niraj",
    acceptable: Object.freeze(["निरज", "नीरज"]),
    benchmarkBucket: "indian-name"
  }),
  Object.freeze({
    id: "foreign-1",
    input: "rohan",
    acceptable: Object.freeze(["रोहन"]),
    benchmarkBucket: "foreign-name"
  })
]);

describe("locked official neural benchmark", () => {
  it("requires exact ID/input coverage and reports auditable hit counts", () => {
    const result = scoreOfficialBenchmark(rows, [
      { id: "native-1", input: "nepal", candidates: ["नेपाल"] },
      { id: "indian-1", input: "niraj", candidates: ["निराज", "नीरज"] },
      { id: "foreign-1", input: "rohan", candidates: ["रोहण", "रोहन"] }
    ]);

    assert.equal(result.valid, true);
    assert.equal(result.exactCoverage, true);
    assert.deepEqual(result.metrics.overall, {
      rows: 3,
      top1Hits: 1,
      top3Hits: 3,
      top1Accuracy: 0.333333,
      top3Accuracy: 1
    });
    assert.equal(
      result.metrics.byBucket["native-frequent"].top1Accuracy,
      1
    );
  });

  it("rejects extra fields, duplicate candidates, bad Unicode, and missing rows", () => {
    const result = scoreOfficialBenchmark(rows, [
      {
        id: "native-1",
        input: "nepal",
        candidates: ["नेपाल", "नेपाल"],
        score: 0.9
      },
      { id: "indian-1", input: "niraj", candidates: ["Latin"] }
    ]);

    assert.equal(result.valid, false);
    assert.equal(result.metrics, null);
    assert.ok(result.issueCodes.some((value) =>
      value.includes("prediction-schema-invalid:native-1")
    ));
    assert.ok(result.issueCodes.some((value) =>
      value.includes("candidate-invalid:indian-1")
    ));
    assert.ok(result.issueCodes.some((value) =>
      value.includes("prediction-id-missing:foreign-1")
    ));
  });

  it("validates the annotated frozen reference with the same scorer", () => {
    const result = scoreOfficialBenchmark(
      rows,
      rows.map((row) => ({
        id: row.id,
        input: row.input,
        benchmarkBucket: row.benchmarkBucket,
        acceptable: [...row.acceptable],
        candidates: [...row.acceptable]
      })),
      { allowReferenceAnnotations: true }
    );
    assert.equal(result.valid, true);
    assert.equal(result.metrics.overall.top1Accuracy, 1);
  });

  it("requires near-parity with every protected reference slice", () => {
    const reference = perfectMetrics();
    const passing = structuredClone(reference);
    passing.overall.top1Accuracy = 0.98;
    passing.overall.top1Hits = 98;
    passing.overall.rows = 100;
    const passGate = evaluateOfficialBenchmarkQuality(passing, reference);
    assert.equal(passGate.passed, true);

    const failing = structuredClone(reference);
    failing.byBucket["foreign-name"].top1Accuracy = 0.96;
    const failGate = evaluateOfficialBenchmarkQuality(failing, reference);
    assert.equal(failGate.passed, false);
    assert.equal(
      failGate.checks.find((value) =>
        value.metric === "foreignNameTop1Accuracy"
      ).passed,
      false
    );
  });
});

function perfectMetrics() {
  const bucket = {
    rows: 100,
    top1Hits: 100,
    top3Hits: 100,
    top1Accuracy: 1,
    top3Accuracy: 1
  };
  return {
    overall: structuredClone(bucket),
    byBucket: {
      "native-frequent": structuredClone(bucket),
      "indian-name": structuredClone(bucket),
      "foreign-name": structuredClone(bucket)
    }
  };
}
