import {
  evaluateNeuralPredictions,
  validateNeuralEvaluationSafety,
  validateNeuralPredictionRows
} from "./neural-evaluation.mjs";
import {
  evaluateOfficialBenchmarkQuality,
  scoreOfficialBenchmark
} from "./neural-official-benchmark.mjs";
import {
  validateDevanagariWordSequence
} from "./devanagari-word-sequence.mjs";

export const NEURAL_GOLD_PRODUCTION_THRESHOLDS = Object.freeze({
  tailTop1Accuracy: 0.88,
  tailTop3Accuracy: 0.96,
  chatConventionTop1Accuracy: 0.92,
  chatConventionTop3Accuracy: 0.98,
  namesTop3Accuracy: 0.90
});

const NEURAL_GOLD_METRIC_UNIT = "suite-assertion";
const NEURAL_GOLD_METRIC_UNIT_DESCRIPTION =
  "Each gold row is one suite assertion; compatible repeated input/context " +
  "assertions remain separate metric observations.";

export function recomputeNeuralGoldEvaluationEvidence({
  goldRows,
  predictionRows
}) {
  const replayIssueCodes = validateLockedPredictionSequence({
    lockedRows: goldRows,
    predictionRows,
    issuePrefix: "neural-evaluation-replay",
    rejectInvalidCandidates: true
  });
  const predictionValidation = augmentPredictionValidation(
    validateNeuralPredictionRows(
      predictionRows,
      goldRows
    ),
    replayIssueCodes
  );
  const metrics = evaluateNeuralPredictions(
    goldRows,
    predictionValidation,
    "test"
  );
  const metricsBySplit = predictionValidation.metricsReportable
    ? Object.fromEntries(
        ["train", "dev", "test", "all"].map((split) => [
          split,
          evaluateNeuralPredictions(goldRows, predictionValidation, split)
        ])
      )
    : null;
  const suiteIds = Array.isArray(goldRows)
    ? [...new Set(goldRows.map((row) => row?.suiteId))].sort()
    : [];
  const metricsBySuite = predictionValidation.metricsReportable &&
      suiteIds.every((suiteId) =>
        typeof suiteId === "string" && suiteId.length > 0
      )
    ? Object.fromEntries(
        suiteIds.map((suiteId) => [
          suiteId,
          evaluateNeuralPredictions(
            goldRows.filter((row) => row.suiteId === suiteId),
            predictionValidation,
            "all"
          )
        ])
      )
    : null;
  const issues = [...predictionValidation.issueCodes];
  if (metricsBySuite === null) {
    issues.push("neural-evaluation-replay.gold-suite-identity-missing");
  }
  if (metrics === null) {
    issues.push("neural-evaluation-replay.aggregate-metrics-unreportable");
  } else {
    issues.push(...validateNeuralEvaluationSafety(metrics).issueCodes);
    for (const [metric, minimum] of Object.entries(
      NEURAL_GOLD_PRODUCTION_THRESHOLDS
    )) {
      const observed = metrics[metric];
      if (!Number.isFinite(observed) || observed < minimum) {
        issues.push(
          `neural-evaluation-replay.production-threshold-failed:${metric}`
        );
      }
    }
  }

  const issueCodes = uniqueSorted(issues);
  return deepFreeze({
    valid: issueCodes.length === 0,
    issueCodes,
    predictionRows: Array.isArray(predictionRows)
      ? predictionRows.length
      : 0,
    goldRows: Array.isArray(goldRows) ? goldRows.length : 0,
    goldSuiteAssertionCount: Array.isArray(goldRows)
      ? goldRows.length
      : 0,
    metricUnit: NEURAL_GOLD_METRIC_UNIT,
    metricUnitDescription: NEURAL_GOLD_METRIC_UNIT_DESCRIPTION,
    promotionSplit: "test",
    metrics,
    metricsBySplit,
    metricsBySuite,
    predictionValidation: {
      exactCoverage: predictionValidation.exactCoverage,
      metricsReportable: predictionValidation.metricsReportable,
      issueCodes: predictionValidation.issueCodes
    }
  });
}

export function validateRecomputedNeuralGoldEvaluation({
  report,
  goldRows,
  predictionRows
}) {
  const recomputed = recomputeNeuralGoldEvaluationEvidence({
    goldRows,
    predictionRows
  });
  const issues = [...recomputed.issueCodes];
  for (const field of [
    "predictionRows",
    "goldRows",
    "goldSuiteAssertionCount",
    "metricUnit",
    "metricUnitDescription",
    "promotionSplit",
    "metrics",
    "metricsBySplit",
    "metricsBySuite",
    "predictionValidation"
  ]) {
    if (!deepEqual(report?.[field], recomputed[field])) {
      issues.push(`neural-evaluation-replay.report-${field}-mismatch`);
    }
  }
  const issueCodes = uniqueSorted(issues);
  return deepFreeze({
    valid: issueCodes.length === 0,
    issueCodes,
    recomputed
  });
}

export function recomputeOfficialBenchmarkEvaluationEvidence({
  benchmarkRows,
  candidatePredictionRows,
  referencePredictionRows
}) {
  const candidateReplayIssues = validateLockedPredictionSequence({
    lockedRows: benchmarkRows,
    predictionRows: candidatePredictionRows,
    issuePrefix: "official-benchmark-replay.candidate",
    rejectInvalidCandidates: true
  });
  const referenceReplayIssues = validateLockedPredictionSequence({
    lockedRows: benchmarkRows,
    predictionRows: referencePredictionRows,
    issuePrefix: "official-benchmark-replay.reference",
    rejectInvalidCandidates: false
  });
  const candidate = scoreOfficialBenchmark(
    benchmarkRows,
    candidatePredictionRows
  );
  const reference = scoreOfficialBenchmark(
    benchmarkRows,
    referencePredictionRows,
    { allowReferenceAnnotations: true }
  );
  const candidateExactCoverage = candidate.valid &&
      candidate.exactCoverage &&
      candidateReplayIssues.length === 0;
  const referenceExactCoverage = reference.valid &&
      reference.exactCoverage &&
      referenceReplayIssues.length === 0;
  const qualityGate = candidateExactCoverage &&
      candidate.metrics &&
      referenceExactCoverage &&
      reference.metrics
    ? evaluateOfficialBenchmarkQuality(
        candidate.metrics,
        reference.metrics
      )
    : null;
  const issues = [
    ...candidateReplayIssues,
    ...referenceReplayIssues,
    ...candidate.issueCodes.map((issue) => `candidate:${issue}`),
    ...reference.issueCodes.map((issue) => `reference:${issue}`)
  ];
  if (!candidateExactCoverage) {
    issues.push("official-benchmark-replay.candidate-coverage-incomplete");
  }
  if (!referenceExactCoverage) {
    issues.push("official-benchmark-replay.reference-coverage-incomplete");
  }
  if (qualityGate?.passed !== true) {
    issues.push("official-benchmark-replay.quality-gate-failed");
  }
  const issueCodes = uniqueSorted(issues);
  return deepFreeze({
    valid: issueCodes.length === 0,
    issueCodes,
    predictionRows: candidate.predictionRows,
    distinctInputCount: candidate.distinctInputCount,
    exactCoverage: candidateExactCoverage,
    metrics: candidate.metrics,
    targetLengthDiagnosticPolicy:
      candidate.targetLengthDiagnosticPolicy,
    metricsByTargetLength: candidate.metricsByTargetLength,
    reference: {
      runtimeFilteredInvalidCandidateCount:
        reference.filteredInvalidCandidateCount,
      metrics: reference.metrics,
      metricsByTargetLength: reference.metricsByTargetLength
    },
    qualityGate
  });
}

export function validateRecomputedOfficialBenchmarkEvaluation({
  report,
  benchmarkRows,
  candidatePredictionRows,
  referencePredictionRows
}) {
  const recomputed = recomputeOfficialBenchmarkEvaluationEvidence({
    benchmarkRows,
    candidatePredictionRows,
    referencePredictionRows
  });
  const issues = [...recomputed.issueCodes];
  for (const field of [
    "predictionRows",
    "distinctInputCount",
    "exactCoverage",
    "metrics",
    "targetLengthDiagnosticPolicy",
    "metricsByTargetLength",
    "qualityGate"
  ]) {
    if (!deepEqual(report?.[field], recomputed[field])) {
      issues.push(`official-benchmark-replay.report-${field}-mismatch`);
    }
  }
  for (const field of [
    "runtimeFilteredInvalidCandidateCount",
    "metrics",
    "metricsByTargetLength"
  ]) {
    if (!deepEqual(report?.reference?.[field], recomputed.reference[field])) {
      issues.push(
        `official-benchmark-replay.report-reference-${field}-mismatch`
      );
    }
  }
  const issueCodes = uniqueSorted(issues);
  return deepFreeze({
    valid: issueCodes.length === 0,
    issueCodes,
    recomputed
  });
}

function augmentPredictionValidation(validation, replayIssueCodes) {
  if (replayIssueCodes.length === 0) return validation;
  return Object.freeze({
    valid: false,
    exactCoverage: false,
    metricsReportable: false,
    issueCodes: uniqueSorted([
      ...validation.issueCodes,
      ...replayIssueCodes
    ]),
    predictionsById: validation.predictionsById,
    goldById: validation.goldById
  });
}

function validateLockedPredictionSequence({
  lockedRows,
  predictionRows,
  issuePrefix,
  rejectInvalidCandidates
}) {
  const issues = [];
  if (!Array.isArray(lockedRows) || !Array.isArray(predictionRows)) {
    return uniqueSorted(issues);
  }
  if (lockedRows.length !== predictionRows.length) {
    issues.push(`${issuePrefix}.row-count-mismatch`);
  }
  const comparedRows = Math.min(lockedRows.length, predictionRows.length);
  for (let index = 0; index < comparedRows; index += 1) {
    const locked = lockedRows[index];
    const prediction = predictionRows[index];
    if (prediction?.id !== locked?.id) {
      issues.push(`${issuePrefix}.row-id-order-mismatch:${index + 1}`);
    }
    if (prediction?.input !== locked?.input) {
      issues.push(`${issuePrefix}.row-input-mismatch:${index + 1}`);
    }
    if (!rejectInvalidCandidates ||
        !Array.isArray(prediction?.candidates)) {
      continue;
    }
    for (const [candidateIndex, candidate] of
      prediction.candidates.entries()) {
      if (typeof candidate !== "string" ||
          !validateDevanagariWordSequence(candidate).valid) {
        issues.push(
          `${issuePrefix}.candidate-invalid:${index + 1}:` +
          `${candidateIndex + 1}`
        );
      }
    }
  }
  return uniqueSorted(issues);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" ||
      typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqual(left[key], right[key])
    );
}

function uniqueSorted(values) {
  return Object.freeze([...new Set(values)].sort());
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
