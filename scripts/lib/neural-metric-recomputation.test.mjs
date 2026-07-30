import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  recomputeNeuralGoldEvaluationEvidence,
  recomputeOfficialBenchmarkEvaluationEvidence,
  validateRecomputedNeuralGoldEvaluation,
  validateRecomputedOfficialBenchmarkEvaluation
} from "./neural-metric-recomputation.mjs";

describe("neural metric recomputation", () => {
  it("replays the complete gold report from locked rows and predictions", () => {
    const evidence = recomputeNeuralGoldEvaluationEvidence({
      goldRows: goldRows(),
      predictionRows: goldPredictions()
    });
    assert.equal(evidence.valid, true);
    assert.equal(validateRecomputedNeuralGoldEvaluation({
      report: structuredClone(evidence),
      goldRows: goldRows(),
      predictionRows: goldPredictions()
    }).valid, true);
  });

  it("rejects a re-hashed gold report with forged metrics", () => {
    const report = structuredClone(recomputeNeuralGoldEvaluationEvidence({
      goldRows: goldRows(),
      predictionRows: goldPredictions()
    }));
    report.metrics.tailTop1Accuracy = 0.99;
    const validation = validateRecomputedNeuralGoldEvaluation({
      report,
      goldRows: goldRows(),
      predictionRows: goldPredictions()
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.issueCodes.includes(
      "neural-evaluation-replay.report-metrics-mismatch"
    ));
  });

  it("rejects unsafe gold predictions even if a report claims success", () => {
    const predictions = goldPredictions();
    predictions.find((row) => row.id === "protected").candidates = ["पासवर्ड"];
    const report = structuredClone(recomputeNeuralGoldEvaluationEvidence({
      goldRows: goldRows(),
      predictionRows: goldPredictions()
    }));
    const validation = validateRecomputedNeuralGoldEvaluation({
      report,
      goldRows: goldRows(),
      predictionRows: predictions
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.issueCodes.some((issue) =>
      issue.includes("protected")
    ));
  });

  it("requires exact gold prediction order and raw input identity", () => {
    const reordered = goldPredictions();
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    const reorderedEvidence = recomputeNeuralGoldEvaluationEvidence({
      goldRows: goldRows(),
      predictionRows: reordered
    });
    assert.equal(reorderedEvidence.valid, false);
    assert.ok(reorderedEvidence.issueCodes.includes(
      "neural-evaluation-replay.row-id-order-mismatch:1"
    ));

    const normalizedButNotExact = goldPredictions();
    normalizedButNotExact[0].input = " BATO ";
    const inputEvidence = recomputeNeuralGoldEvaluationEvidence({
      goldRows: goldRows(),
      predictionRows: normalizedButNotExact
    });
    assert.equal(inputEvidence.valid, false);
    assert.ok(inputEvidence.issueCodes.includes(
      "neural-evaluation-replay.row-input-mismatch:1"
    ));
  });

  it("rejects every non-Devanagari gold candidate scalar sequence", () => {
    for (const invalidCandidate of ["кириллица", "🙂", ".", "\uFFFD"]) {
      const predictions = goldPredictions();
      predictions[0].candidates.push(invalidCandidate);
      const evidence = recomputeNeuralGoldEvaluationEvidence({
        goldRows: goldRows(),
        predictionRows: predictions
      });
      assert.equal(evidence.valid, false, invalidCandidate);
      assert.ok(evidence.issueCodes.includes(
        "neural-evaluation-replay.candidate-invalid:1:2"
      ), invalidCandidate);
    }
  });

  it("replays candidate, reference, diagnostics, and quality policy", () => {
    const evidence = recomputeOfficialBenchmarkEvaluationEvidence({
      benchmarkRows: officialRows(),
      candidatePredictionRows: officialCandidatePredictions(),
      referencePredictionRows: officialReferencePredictions()
    });
    assert.equal(evidence.valid, true);
    assert.equal(validateRecomputedOfficialBenchmarkEvaluation({
      report: structuredClone(evidence),
      benchmarkRows: officialRows(),
      candidatePredictionRows: officialCandidatePredictions(),
      referencePredictionRows: officialReferencePredictions()
    }).valid, true);
  });

  it("rejects re-hashed official metrics and quality-gate claims", () => {
    const report = structuredClone(
      recomputeOfficialBenchmarkEvaluationEvidence({
        benchmarkRows: officialRows(),
        candidatePredictionRows: officialCandidatePredictions(),
        referencePredictionRows: officialReferencePredictions()
      })
    );
    report.metrics.overall.top1Hits = 0;
    report.qualityGate.passed = false;
    const validation = validateRecomputedOfficialBenchmarkEvaluation({
      report,
      benchmarkRows: officialRows(),
      candidatePredictionRows: officialCandidatePredictions(),
      referencePredictionRows: officialReferencePredictions()
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.issueCodes.includes(
      "official-benchmark-replay.report-metrics-mismatch"
    ));
    assert.ok(validation.issueCodes.includes(
      "official-benchmark-replay.report-qualityGate-mismatch"
    ));
  });

  it("requires exact official candidate and reference row identity", () => {
    const reorderedCandidate = officialCandidatePredictions();
    [reorderedCandidate[0], reorderedCandidate[1]] = [
      reorderedCandidate[1],
      reorderedCandidate[0]
    ];
    const candidateEvidence = recomputeOfficialBenchmarkEvaluationEvidence({
      benchmarkRows: officialRows(),
      candidatePredictionRows: reorderedCandidate,
      referencePredictionRows: officialReferencePredictions()
    });
    assert.equal(candidateEvidence.valid, false);
    assert.ok(candidateEvidence.issueCodes.includes(
      "official-benchmark-replay.candidate.row-id-order-mismatch:1"
    ));

    const alteredReference = officialReferencePredictions();
    alteredReference[0].input = "NEPAL";
    const referenceEvidence = recomputeOfficialBenchmarkEvaluationEvidence({
      benchmarkRows: officialRows(),
      candidatePredictionRows: officialCandidatePredictions(),
      referencePredictionRows: alteredReference
    });
    assert.equal(referenceEvidence.valid, false);
    assert.ok(referenceEvidence.issueCodes.includes(
      "official-benchmark-replay.reference.row-input-mismatch:1"
    ));
  });

  it("rejects invalid candidate output while preserving reference filtering", () => {
    const candidatePredictions = officialCandidatePredictions();
    candidatePredictions[0].candidates.push("🙂");
    const candidateEvidence = recomputeOfficialBenchmarkEvaluationEvidence({
      benchmarkRows: officialRows(),
      candidatePredictionRows: candidatePredictions,
      referencePredictionRows: officialReferencePredictions()
    });
    assert.equal(candidateEvidence.valid, false);
    assert.ok(candidateEvidence.issueCodes.includes(
      "official-benchmark-replay.candidate.candidate-invalid:1:2"
    ));

    const referencePredictions = officialReferencePredictions();
    referencePredictions[0].candidates.push("मातृभाषाहरूलে");
    const referenceEvidence = recomputeOfficialBenchmarkEvaluationEvidence({
      benchmarkRows: officialRows(),
      candidatePredictionRows: officialCandidatePredictions(),
      referencePredictionRows: referencePredictions
    });
    assert.equal(referenceEvidence.valid, true);
    assert.equal(
      referenceEvidence.reference.runtimeFilteredInvalidCandidateCount,
      1
    );
  });
});

function goldRows() {
  return [
    goldRow("tail", "bato", "बाटो", "general"),
    goldRow("chat", "chha", "छ", "chat-convention"),
    goldRow("name", "rohan", "रोहन", "name"),
    {
      ...goldRow("protected", "hunter2", "", "adversarial-safety"),
      expectedAction: "no-neural-candidate",
      acceptableOutputs: [],
      forbiddenOutputs: ["पासवर्ड"]
    },
    goldRow("adversarial", "admin", "एडमिन", "adversarial-safety")
  ];
}

function goldRow(id, input, expected, category) {
  return {
    id,
    input,
    split: "test",
    suiteId: "fixture-suite",
    suitePath: "fixture.jsonl",
    previousContext: [],
    expectedAction: "produce-candidate",
    acceptableOutputs: [expected],
    forbiddenOutputs: [],
    category
  };
}

function goldPredictions() {
  return goldRows().map((row) => ({
    id: row.id,
    input: row.input,
    candidates: row.expectedAction === "no-neural-candidate"
      ? []
      : [row.acceptableOutputs[0]]
  }));
}

function officialRows() {
  return [
    officialRow("native", "nepal", "नेपाल", "native-frequent"),
    officialRow("indian", "niraj", "निरज", "indian-name"),
    officialRow("foreign", "rohan", "रोहन", "foreign-name")
  ];
}

function officialRow(id, input, target, benchmarkBucket) {
  return { id, input, acceptable: [target], benchmarkBucket };
}

function officialCandidatePredictions() {
  return officialRows().map(({ id, input, acceptable }) => ({
    id,
    input,
    candidates: [acceptable[0]]
  }));
}

function officialReferencePredictions() {
  return officialRows().map((row) => ({
    ...row,
    candidates: [row.acceptable[0]]
  }));
}
