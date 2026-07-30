const ACCURACY_METRICS = Object.freeze([
  "tailTop1Accuracy",
  "tailTop3Accuracy",
  "chatConventionTop1Accuracy",
  "chatConventionTop3Accuracy",
  "namesTop3Accuracy"
]);

const ZERO_RATE_METRICS = Object.freeze([
  "protectedFalseConversionRate",
  "singleTokenPhraseExpansionRate"
]);

export const NEURAL_PRODUCTION_MANIFEST_METRIC_KEYS = Object.freeze([
  ...ACCURACY_METRICS,
  ...ZERO_RATE_METRICS,
  "secureFieldInferenceCount"
]);

/**
 * Project the closed production-manifest metric surface from evidence that
 * can be independently replayed. Extra diagnostic fields in the gold
 * evaluation are intentionally excluded.
 */
export function projectNeuralProductionManifestMetrics({
  recomputedGoldEvaluation,
  nativeBenchmarkDevices
}) {
  const issues = [];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const goldMetrics = recomputedGoldEvaluation?.metrics;
  if (recomputedGoldEvaluation?.valid !== true ||
      !isRecord(goldMetrics)) {
    addIssue("neural-production-metrics.gold-evaluation-invalid");
  }
  for (const key of ACCURACY_METRICS) {
    const value = goldMetrics?.[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      addIssue(`neural-production-metrics.gold-metric-invalid:${key}`);
    }
  }
  for (const key of ZERO_RATE_METRICS) {
    if (goldMetrics?.[key] !== 0) {
      addIssue(`neural-production-metrics.gold-safety-nonzero:${key}`);
    }
  }

  let secureFieldInferenceCount = 0;
  if (!Array.isArray(nativeBenchmarkDevices) ||
      nativeBenchmarkDevices.length < 1) {
    addIssue("neural-production-metrics.native-benchmark-devices-invalid");
  } else {
    for (const [index, device] of nativeBenchmarkDevices.entries()) {
      if (!isRecord(device) ||
          device.packagedApp !== true ||
          device.measurementKind !== "full-candidate-generation") {
        addIssue(
          `neural-production-metrics.native-benchmark-device-invalid:${index}`
        );
        continue;
      }
      const count = device.secureFieldInferenceCount;
      if (!Number.isSafeInteger(count) || count < 0 ||
          !Number.isSafeInteger(secureFieldInferenceCount + count)) {
        addIssue(
          `neural-production-metrics.secure-field-count-invalid:${index}`
        );
        continue;
      }
      secureFieldInferenceCount += count;
    }
  }
  if (secureFieldInferenceCount !== 0) {
    addIssue("neural-production-metrics.secure-field-inference-observed");
  }

  const issueCodes = Object.freeze([...issues].sort());
  const metrics = issueCodes.length === 0
    ? deepFreeze({
        tailTop1Accuracy: goldMetrics.tailTop1Accuracy,
        tailTop3Accuracy: goldMetrics.tailTop3Accuracy,
        chatConventionTop1Accuracy:
          goldMetrics.chatConventionTop1Accuracy,
        chatConventionTop3Accuracy:
          goldMetrics.chatConventionTop3Accuracy,
        namesTop3Accuracy: goldMetrics.namesTop3Accuracy,
        protectedFalseConversionRate:
          goldMetrics.protectedFalseConversionRate,
        singleTokenPhraseExpansionRate:
          goldMetrics.singleTokenPhraseExpansionRate,
        secureFieldInferenceCount
      })
    : null;
  return deepFreeze({
    valid: issueCodes.length === 0,
    issueCodes,
    metrics
  });
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
