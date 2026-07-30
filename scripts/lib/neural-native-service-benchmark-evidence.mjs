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
  deterministicExactBypassToken: "dhanyabad",
  protectedLatinTokens: [
    "PostgreSQL",
    "GitHub",
    "npm",
    "SwiftUI",
    "macOS",
    "README",
    "hello"
  ],
  secureFieldProbeToken: "password",
  latestRequestTokens: [
    "prashasan",
    "nagarikta",
    "mantralaya",
    "paryatan"
  ],
  warmupPasses: 1,
  measuredPasses: 48,
  targetP95Ms: 50
});

const MODE_CONTRACTS = deepFreeze({
  experimental: {
    status: "passed-experimental",
    serviceStatus:
      "experimental-async-coreml-tail-artifact-verified-ready"
  },
  "candidate-promotion": {
    status: "passed-candidate-promotion-evidence",
    serviceStatus:
      "experimental-async-coreml-tail-artifact-verified-ready"
  },
  production: {
    status: "passed-production",
    serviceStatus:
      "production-async-coreml-tail-attested-ready"
  }
});
const PREDICTOR_INVOCATION_EVIDENCE_KEYS = Object.freeze([
  "afterDeterministicBypass",
  "afterProtectedBypass",
  "afterSecureField",
  "beforeDeterministicBypass",
  "beforeProtectedBypass",
  "beforeSecureField"
].sort(compareText));
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;

/**
 * Validate the closed steady-state workload emitted by every full native
 * service benchmark (experimental, candidate-promotion, and production).
 *
 * Runtime-placement capture intentionally has a separate, shorter contract.
 */
export function validateNeuralNativeServiceBenchmarkWorkload(report) {
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

/**
 * Validate a fully enriched native-service report.
 *
 * The benchmark CLI adds proof mode and artifact identity after the Swift
 * producer exits. Callers must provide the independently resolved artifact
 * descriptor so a report cannot validate an identity that it invented itself.
 */
export function validateNeuralNativeServiceBenchmarkReport(
  report,
  context = {}
) {
  const workloadValidation =
    validateNeuralNativeServiceBenchmarkWorkload(report);
  const issues = [...workloadValidation.issueCodes];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const contract = NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  const modeContract = MODE_CONTRACTS[report?.proofMode];

  if (
    !modeContract ||
    (
      context.expectedProofMode !== undefined &&
      report?.proofMode !== context.expectedProofMode
    ) ||
    report?.suite !== "native-neural-service-e2e" ||
    report?.status !== modeContract?.status ||
    report?.singleForwardBenchmarkIsConsumerLatency !== false
  ) {
    addIssue("neural-native-service-benchmark.identity-invalid");
  }
  if (
    report?.serviceStatus !== modeContract?.serviceStatus ||
    typeof report?.serviceInitializationMs !== "number" ||
    !Number.isFinite(report.serviceInitializationMs) ||
    report.serviceInitializationMs < 0 ||
    report.serviceInitializationMs >= 10
  ) {
    addIssue("neural-native-service-benchmark.lifecycle-invalid");
  }

  validateArtifactIdentity(
    report?.artifactIdentity,
    context.artifactDescriptor,
    report?.proofMode,
    addIssue
  );

  const invocationEvidence = report?.predictorInvocationEvidence;
  const invocationEvidenceValid =
    exactKeys(
      invocationEvidence,
      PREDICTOR_INVOCATION_EVIDENCE_KEYS
    ) &&
    Object.values(invocationEvidence).every(nonnegativeSafeInteger) &&
    invocationEvidence.beforeDeterministicBypass <=
      invocationEvidence.afterDeterministicBypass &&
    invocationEvidence.afterDeterministicBypass ===
      invocationEvidence.beforeProtectedBypass &&
    invocationEvidence.beforeProtectedBypass <=
      invocationEvidence.afterProtectedBypass &&
    invocationEvidence.afterProtectedBypass <=
      invocationEvidence.beforeSecureField &&
    invocationEvidence.beforeSecureField <=
      invocationEvidence.afterSecureField;
  const deterministicInferenceCount = invocationEvidenceValid
    ? invocationEvidence.afterDeterministicBypass -
      invocationEvidence.beforeDeterministicBypass
    : null;
  const protectedInferenceCount = invocationEvidenceValid
    ? invocationEvidence.afterProtectedBypass -
      invocationEvidence.beforeProtectedBypass
    : null;
  const secureInferenceCount = invocationEvidenceValid
    ? invocationEvidence.afterSecureField -
      invocationEvidence.beforeSecureField
    : null;

  if (
    report?.secureFieldProbeToken !== contract.secureFieldProbeToken ||
    !deepEqual(report?.secureFieldCandidates, []) ||
    report?.secureFieldInferenceCount !== secureInferenceCount ||
    secureInferenceCount !== 0 ||
    !Array.isArray(report?.devices) ||
    report.devices.length !== 1 ||
    report.devices[0]?.secureFieldInferenceCount !== secureInferenceCount
  ) {
    addIssue("neural-native-service-benchmark.secure-field-invalid");
  }

  const protectedBypass = report?.protectedLatinBypassCandidates;
  const protectedBypassValid =
    isRecord(protectedBypass) &&
    deepEqual(
      Object.keys(protectedBypass).sort(compareText),
      [...contract.protectedLatinTokens].sort(compareText)
    ) &&
    contract.protectedLatinTokens.every((token) =>
      deepEqual(protectedBypass[token], [])
    );
  if (
    !invocationEvidenceValid ||
    report?.deterministicExactBypassToken !==
      contract.deterministicExactBypassToken ||
    !deepEqual(report?.deterministicExactBypassCandidates, []) ||
    report?.deterministicExactBypassInferenceCount !==
      deterministicInferenceCount ||
    deterministicInferenceCount !== 0 ||
    !protectedBypassValid ||
    report?.protectedLatinBypassInferenceCount !==
      protectedInferenceCount ||
    protectedInferenceCount !== 0 ||
    report?.singleTokenPhraseExpansionRate !== 0
  ) {
    addIssue("neural-native-service-benchmark.bypass-invalid");
  }

  if (
    !deepEqual(
      report?.latestRequestTokens,
      contract.latestRequestTokens
    ) ||
    !deepEqual(
      report?.latestRequestCompletions,
      [contract.latestRequestTokens.at(-1)]
    ) ||
    report?.latestRequestWins !== true
  ) {
    addIssue("neural-native-service-benchmark.latest-request-invalid");
  }
  if (
    report?.cancelledCompletionCalled !== false ||
    report?.cancelPendingSuppressesCompletion !== true
  ) {
    addIssue("neural-native-service-benchmark.cancellation-invalid");
  }

  return Object.freeze({
    valid: issues.length === 0,
    issueCodes: Object.freeze([...issues].sort(compareText))
  });
}

/**
 * Re-validate and replay a retained full native-service benchmark report.
 *
 * This is the reusable acceptance boundary for callers that did not execute
 * the benchmark themselves. It composes the canonical validator, requires an
 * explicit proof-mode expectation, binds the report to an independently
 * resolved compiled-artifact descriptor, recomputes latency percentiles from
 * the closed raw sample streams, and derives bypass/secure-field safety from
 * predictor invocation deltas. No retained summary is accepted as evidence
 * for a value that can be recomputed.
 */
export function replayRetainedNeuralNativeServiceBenchmarkEvidence(
  report,
  context = {}
) {
  const replayContext = isRecord(context) ? context : {};
  const canonicalValidation =
    validateNeuralNativeServiceBenchmarkReport(report, replayContext);
  const issues = [...canonicalValidation.issueCodes];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const expectedProofMode = replayContext.expectedProofMode;
  if (
    typeof expectedProofMode !== "string" ||
    !Object.hasOwn(MODE_CONTRACTS, expectedProofMode)
  ) {
    addIssue(
      "neural-native-service-benchmark-replay.proof-mode-context-invalid"
    );
  }

  const performance = deriveRetainedPerformance(report);
  if (!performance) {
    addIssue(
      "neural-native-service-benchmark-replay.latency-unrecomputable"
    );
  } else if (
    !exactKeys(
      report?.performance,
      ["p50Ms", "p95Ms", "p99Ms"].sort(compareText)
    ) ||
    report.performance.p50Ms !== performance.p50Ms ||
    report.performance.p95Ms !== performance.p95Ms ||
    report.performance.p99Ms !== performance.p99Ms
  ) {
    addIssue(
      "neural-native-service-benchmark-replay.performance-summary-mismatch"
    );
  }

  const inferenceSafety =
    deriveRetainedInferenceSafety(report?.predictorInvocationEvidence);
  if (!inferenceSafety) {
    addIssue(
      "neural-native-service-benchmark-replay.invocation-evidence-invalid"
    );
  } else {
    const expectedWorkloadInferenceCount =
      NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens.length *
      (
        NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.warmupPasses +
        NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.measuredPasses
      );
    if (
      inferenceSafety.workloadInferenceCount !==
        expectedWorkloadInferenceCount
    ) {
      addIssue(
        "neural-native-service-benchmark-replay." +
          "workload-inference-count-invalid"
      );
    }
    if (
      inferenceSafety.deterministicExactBypassInferenceCount !== 0 ||
      inferenceSafety.protectedLatinBypassInferenceCount !== 0 ||
      inferenceSafety.secureFieldInferenceCount !== 0
    ) {
      addIssue(
        "neural-native-service-benchmark-replay.inference-safety-failed"
      );
    }
  }

  const valid = issues.length === 0;
  const evidence = valid
    ? {
        proofMode: expectedProofMode,
        artifactIdentity: artifactIdentityFromDescriptor(
          replayContext.artifactDescriptor
        ),
        workload: {
          orderedTokens: [
            ...NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens
          ],
          warmupPasses:
            NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.warmupPasses,
          measuredPasses:
            NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.measuredPasses,
          warmupRequests:
            NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens.length *
            NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.warmupPasses,
          steadyStateSamples:
            NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens.length *
            NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.measuredPasses
        },
        performance,
        inferenceSafety
      }
    : null;

  return deepFreeze({
    valid,
    issueCodes: [...issues].sort(compareText),
    evidence
  });
}

function validateArtifactIdentity(value, descriptor, proofMode, addIssue) {
  if (!isRecord(descriptor) ||
      !isRecord(descriptor.manifest) ||
      !Array.isArray(descriptor.artifacts) ||
      descriptor.artifacts.length < 1) {
    addIssue(
      "neural-native-service-benchmark.artifact-context-missing"
    );
    return;
  }
  const singleModel = descriptor.artifactLayout === "single-model";
  const expectedKeys = [
    "artifactSetSha256",
    singleModel ? "compiledModelSha256" : "compiledModels",
    "exportRunId",
    "manifestSha256",
    "trainingRunId",
    "vocabSha256"
  ].sort(compareText);
  const expectedTrainingRunId =
    descriptor.manifest.trainingRunId ?? null;
  const expectedExportRunId =
    descriptor.manifest.exportRunId ?? null;
  let compiledIdentityValid = false;
  if (singleModel) {
    compiledIdentityValid =
      descriptor.artifacts.length === 1 &&
      value?.compiledModelSha256 ===
        descriptor.artifacts[0]?.compiledSha256 &&
      SHA256_PATTERN.test(String(value?.compiledModelSha256 ?? ""));
  } else {
    const expectedRoles = descriptor.artifacts
      .map((artifact) => artifact.role)
      .sort(compareText);
    compiledIdentityValid =
      isRecord(value?.compiledModels) &&
      deepEqual(
        Object.keys(value.compiledModels).sort(compareText),
        expectedRoles
      ) &&
      descriptor.artifacts.every((artifact) =>
        value.compiledModels[artifact.role] === artifact.compiledSha256 &&
        SHA256_PATTERN.test(String(artifact.compiledSha256 ?? ""))
      );
  }
  const runIdsValid =
    value?.trainingRunId === expectedTrainingRunId &&
    value?.exportRunId === expectedExportRunId &&
    (
      proofMode === "experimental" ||
      (
        RUN_ID_PATTERN.test(String(value?.trainingRunId ?? "")) &&
        RUN_ID_PATTERN.test(String(value?.exportRunId ?? "")) &&
        value.trainingRunId !== value.exportRunId
      )
    );
  if (
    !exactKeys(value, expectedKeys) ||
    !runIdsValid ||
    value.manifestSha256 !== descriptor.manifestSha256 ||
    value.vocabSha256 !== descriptor.vocabSha256 ||
    value.artifactSetSha256 !== descriptor.artifactSetSha256 ||
    !SHA256_PATTERN.test(String(value.manifestSha256 ?? "")) ||
    !SHA256_PATTERN.test(String(value.vocabSha256 ?? "")) ||
    !SHA256_PATTERN.test(String(value.artifactSetSha256 ?? "")) ||
    !compiledIdentityValid
  ) {
    addIssue(
      "neural-native-service-benchmark.artifact-identity-invalid"
    );
  }
}

function deriveRetainedPerformance(report) {
  const contract = NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  if (
    !isRecord(report?.byTokenMs) ||
    !deepEqual(
      Object.keys(report.byTokenMs).sort(compareText),
      [...contract.orderedTokens].sort(compareText)
    )
  ) {
    return null;
  }
  const samples = [];
  for (const token of contract.orderedTokens) {
    const tokenSamples = report.byTokenMs[token];
    if (
      !Array.isArray(tokenSamples) ||
      tokenSamples.length !== contract.measuredPasses ||
      tokenSamples.some(
        (sample) =>
          typeof sample !== "number" ||
          !Number.isFinite(sample) ||
          sample < 0
      )
    ) {
      return null;
    }
    samples.push(...tokenSamples);
  }
  return Object.freeze({
    source: "byTokenMs-nearest-rank",
    sampleCount: samples.length,
    p50Ms: nearestRankPercentile(samples, 0.5),
    p95Ms: nearestRankPercentile(samples, 0.95),
    p99Ms: nearestRankPercentile(samples, 0.99)
  });
}

function deriveRetainedInferenceSafety(invocationEvidence) {
  if (
    !exactKeys(
      invocationEvidence,
      PREDICTOR_INVOCATION_EVIDENCE_KEYS
    ) ||
    !Object.values(invocationEvidence).every(nonnegativeSafeInteger) ||
    invocationEvidence.beforeDeterministicBypass >
      invocationEvidence.afterDeterministicBypass ||
    invocationEvidence.afterDeterministicBypass !==
      invocationEvidence.beforeProtectedBypass ||
    invocationEvidence.beforeProtectedBypass >
      invocationEvidence.afterProtectedBypass ||
    invocationEvidence.afterProtectedBypass >
      invocationEvidence.beforeSecureField ||
    invocationEvidence.beforeSecureField >
      invocationEvidence.afterSecureField
  ) {
    return null;
  }
  const deterministicExactBypassInferenceCount =
    invocationEvidence.afterDeterministicBypass -
    invocationEvidence.beforeDeterministicBypass;
  const protectedLatinBypassInferenceCount =
    invocationEvidence.afterProtectedBypass -
    invocationEvidence.beforeProtectedBypass;
  const workloadInferenceCount =
    invocationEvidence.beforeSecureField -
    invocationEvidence.afterProtectedBypass;
  const secureFieldInferenceCount =
    invocationEvidence.afterSecureField -
    invocationEvidence.beforeSecureField;
  return Object.freeze({
    source: "predictorInvocationEvidence-deltas",
    deterministicExactBypassInferenceCount,
    protectedLatinBypassInferenceCount,
    workloadInferenceCount,
    secureFieldInferenceCount,
    deterministicExactBypassFailClosed:
      deterministicExactBypassInferenceCount === 0,
    protectedLatinBypassFailClosed:
      protectedLatinBypassInferenceCount === 0,
    secureFieldFailClosed: secureFieldInferenceCount === 0
  });
}

function artifactIdentityFromDescriptor(descriptor) {
  const identity = {
    trainingRunId: descriptor.manifest.trainingRunId ?? null,
    exportRunId: descriptor.manifest.exportRunId ?? null,
    manifestSha256: descriptor.manifestSha256,
    vocabSha256: descriptor.vocabSha256,
    artifactSetSha256: descriptor.artifactSetSha256
  };
  if (descriptor.artifactLayout === "single-model") {
    identity.compiledModelSha256 =
      descriptor.artifacts[0].compiledSha256;
  } else {
    identity.compiledModels = Object.fromEntries(
      [...descriptor.artifacts]
        .sort((left, right) => compareText(left.role, right.role))
        .map((artifact) => [artifact.role, artifact.compiledSha256])
    );
  }
  return identity;
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    deepEqual(Object.keys(value).sort(compareText), expected);
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
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
