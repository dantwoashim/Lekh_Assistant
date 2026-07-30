import {
  validateNeuralPostExportMemoryEvidence
} from "./neural-post-export-memory-evidence.mjs";
import {
  validateDevanagariWordSequence
} from "./devanagari-word-sequence.mjs";

export const NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT = deepFreeze({
  orderedTokens: [
    "prashasan",
    "nagarikta",
    "mantralaya",
    "sambidhan",
    "paryatan"
  ],
  warmupPasses: 1,
  measuredPasses: 48,
  targetP95Ms: 50
});

/**
 * Validate the closed steady-state workload emitted by every full native
 * service benchmark (experimental, candidate-promotion, and production).
 *
 * Runtime-placement capture intentionally has a separate, shorter contract.
 */
export function validateNeuralNativeServiceBenchmarkReport(report) {
  const issues = [];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const contract = NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  const expectedWarmupRequests =
    contract.orderedTokens.length * contract.warmupPasses;
  const expectedSteadyStateSamples =
    contract.orderedTokens.length * contract.measuredPasses;

  if (
    !isRecord(report) ||
    report.placementCapture !== false ||
    report.benchmarkPasses !==
      contract.warmupPasses + contract.measuredPasses ||
    report.warmupPasses !== contract.warmupPasses ||
    report.measuredPasses !== contract.measuredPasses ||
    report.warmupRequests !== expectedWarmupRequests ||
    report.steadyStateSamples !== expectedSteadyStateSamples ||
    !deepEqual(report.workloadTokens, contract.orderedTokens)
  ) {
    addIssue("neural-native-service-benchmark.workload-invalid");
  }

  const expectedTokens = [...contract.orderedTokens].sort(compareText);
  const sampleStreamsValid =
    isRecord(report?.byTokenMs) &&
    deepEqual(
      Object.keys(report.byTokenMs).sort(compareText),
      expectedTokens
    ) &&
    Object.values(report.byTokenMs).every(
      (samples) =>
        Array.isArray(samples) &&
        samples.length === contract.measuredPasses &&
        samples.every(
          (sample) =>
            typeof sample === "number" &&
            Number.isFinite(sample) &&
            sample >= 0
        )
    );
  if (!sampleStreamsValid) {
    addIssue("neural-native-service-benchmark.samples-invalid");
  }

  const candidateResultsValid =
    isRecord(report?.candidateResultsByToken) &&
    deepEqual(
      Object.keys(report.candidateResultsByToken).sort(compareText),
      expectedTokens
    ) &&
    contract.orderedTokens.every((token) => {
      const results = report.candidateResultsByToken[token];
      return Array.isArray(results) &&
        results.length === contract.measuredPasses &&
        results.every(
          (candidates) =>
            Array.isArray(candidates) &&
            candidates.length >= 1 &&
            candidates.length <= 4 &&
            new Set(candidates).size === candidates.length &&
            candidates.every(
              (candidate) =>
                typeof candidate === "string" &&
                validateDevanagariWordSequence(candidate).valid
            )
        );
    });
  const finalPredictionsMatch =
    candidateResultsValid &&
    isRecord(report?.predictions) &&
    deepEqual(
      Object.keys(report.predictions).sort(compareText),
      expectedTokens
    ) &&
    contract.orderedTokens.every((token) =>
      deepEqual(
        report.predictions[token],
        report.candidateResultsByToken[token].at(-1)
      )
    );
  if (!candidateResultsValid || !finalPredictionsMatch) {
    addIssue("neural-native-service-benchmark.candidates-invalid");
  }

  const performanceKeys = ["p50Ms", "p95Ms", "p99Ms"];
  const performance = report?.performance;
  const performanceStructureInvalid =
    report?.targetP95Ms !== contract.targetP95Ms ||
    !isRecord(performance) ||
    !deepEqual(
      Object.keys(performance).sort(compareText),
      [...performanceKeys].sort(compareText)
    ) ||
    performanceKeys.some(
      (key) =>
        typeof performance?.[key] !== "number" ||
        !Number.isFinite(performance[key]) ||
        performance[key] < 0
    ) ||
    performance?.p50Ms > performance?.p95Ms ||
    performance?.p95Ms > performance?.p99Ms;
  const samples = sampleStreamsValid
    ? contract.orderedTokens.flatMap((token) => report.byTokenMs[token])
    : [];
  const performanceMatchesSamples =
    sampleStreamsValid &&
    !performanceStructureInvalid &&
    performance.p50Ms === nearestRankPercentile(samples, 0.5) &&
    performance.p95Ms === nearestRankPercentile(samples, 0.95) &&
    performance.p99Ms === nearestRankPercentile(samples, 0.99);
  if (performanceStructureInvalid || !performanceMatchesSamples) {
    addIssue("neural-native-service-benchmark.performance-invalid");
  }

  const memoryValidation =
    validateNeuralPostExportMemoryEvidence(report?.memory);
  for (const issue of memoryValidation.issueCodes) addIssue(issue);

  return Object.freeze({
    valid: issues.length === 0,
    issueCodes: Object.freeze([...issues].sort(compareText))
  });
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nearestRankPercentile(samples, quantile) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  );
  return sorted[index];
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
