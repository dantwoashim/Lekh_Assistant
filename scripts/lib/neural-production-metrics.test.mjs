import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  NEURAL_PRODUCTION_MANIFEST_METRIC_KEYS,
  projectNeuralProductionManifestMetrics
} from "./neural-production-metrics.mjs";

describe("neural production manifest metrics", () => {
  it("projects exactly the closed eight-field production surface", () => {
    const result = projectNeuralProductionManifestMetrics({
      recomputedGoldEvaluation: goldEvaluation(),
      nativeBenchmarkDevices: [nativeDevice()]
    });

    assert.equal(result.valid, true);
    assert.deepEqual(
      Object.keys(result.metrics).sort(),
      [...NEURAL_PRODUCTION_MANIFEST_METRIC_KEYS].sort()
    );
    assert.deepEqual(result.metrics, {
      tailTop1Accuracy: 0.9,
      tailTop3Accuracy: 0.97,
      chatConventionTop1Accuracy: 0.93,
      chatConventionTop3Accuracy: 0.99,
      namesTop3Accuracy: 0.91,
      protectedFalseConversionRate: 0,
      singleTokenPhraseExpansionRate: 0,
      secureFieldInferenceCount: 0
    });
    assert.equal(Object.isFrozen(result.metrics), true);
  });

  it("rejects incomplete or non-production gold replay metrics", () => {
    const incomplete = goldEvaluation();
    delete incomplete.metrics.namesTop3Accuracy;
    const incompleteResult =
      projectNeuralProductionManifestMetrics({
        recomputedGoldEvaluation: incomplete,
        nativeBenchmarkDevices: [nativeDevice()]
      });
    assert.equal(incompleteResult.valid, false);
    assert.equal(incompleteResult.metrics, null);
    assert.ok(incompleteResult.issueCodes.includes(
      "neural-production-metrics.gold-metric-invalid:namesTop3Accuracy"
    ));

    const unsafe = goldEvaluation();
    unsafe.metrics.protectedFalseConversionRate = 0.01;
    const unsafeResult = projectNeuralProductionManifestMetrics({
      recomputedGoldEvaluation: unsafe,
      nativeBenchmarkDevices: [nativeDevice()]
    });
    assert.equal(unsafeResult.valid, false);
    assert.ok(unsafeResult.issueCodes.includes(
      "neural-production-metrics.gold-safety-nonzero:" +
      "protectedFalseConversionRate"
    ));
  });

  it("derives secure-field evidence only from packaged native devices", () => {
    const observed = nativeDevice();
    observed.secureFieldInferenceCount = 1;
    const observedResult =
      projectNeuralProductionManifestMetrics({
        recomputedGoldEvaluation: goldEvaluation(),
        nativeBenchmarkDevices: [observed]
      });
    assert.equal(observedResult.valid, false);
    assert.ok(observedResult.issueCodes.includes(
      "neural-production-metrics.secure-field-inference-observed"
    ));

    const nonNative = nativeDevice();
    nonNative.packagedApp = false;
    const nonNativeResult =
      projectNeuralProductionManifestMetrics({
        recomputedGoldEvaluation: goldEvaluation(),
        nativeBenchmarkDevices: [nonNative]
      });
    assert.equal(nonNativeResult.valid, false);
    assert.ok(nonNativeResult.issueCodes.includes(
      "neural-production-metrics.native-benchmark-device-invalid:0"
    ));
  });
});

function goldEvaluation() {
  return {
    valid: true,
    metrics: {
      split: "test",
      metricUnit: "suite-assertion",
      rowCount: 47,
      tailTop1Accuracy: 0.9,
      tailTop3Accuracy: 0.97,
      chatConventionTop1Accuracy: 0.93,
      chatConventionTop3Accuracy: 0.99,
      namesTop3Accuracy: 0.91,
      protectedFalseConversionRate: 0,
      singleTokenPhraseExpansionRate: 0,
      forbiddenCandidateRate: 0
    }
  };
}

function nativeDevice() {
  return {
    packagedApp: true,
    measurementKind: "full-candidate-generation",
    secureFieldInferenceCount: 0
  };
}
