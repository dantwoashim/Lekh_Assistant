import { describe, expect, it } from "vitest";
import { validateNeuralDeviceMeasurements } from "./neural-device-measurements.mjs";

const manifest = {
  modelBytes: 3_528_631,
  sha256: { compiledModel: "a".repeat(64) }
};
const now = new Date("2026-07-17T12:00:00.000Z");

function computePlan(architecture, preferredNeural = architecture === "arm64") {
  const arm = architecture === "arm64";
  const modelPath = `/Applications/Lekh-${architecture}/LekhNeuralTransliterator.mlmodelc`;
  return {
    architecture,
    availableComputeDevices: arm ? ["cpu", "gpu", "neural-engine"] : ["cpu", "gpu"],
    configurationComputeUnits: "all",
    evidenceKind: "coreml-compute-plan-anticipated-device-usage",
    generatedAt: "2026-07-17T11:00:00Z",
    macOS: "15.5.0",
    modelBytes: manifest.modelBytes,
    modelKinds: ["program"],
    modelPath,
    modelSha256: manifest.sha256.compiledModel,
    neuralEngineAvailable: arm,
    neuralEnginePlanEvidence: arm && preferredNeural,
    neuralEnginePreferredOperationCount: arm && preferredNeural ? 12 : 0,
    neuralEngineSupportedOperationCount: arm ? 20 : 0,
    operationCount: 30,
    preferredComputeDeviceCounts: {
      cpu: arm && preferredNeural ? 8 : 20,
      gpu: 0,
      "neural-engine": arm && preferredNeural ? 12 : 0,
      unknown: 0
    },
    recordType: "lekh-neural-compute-plan-evidence",
    schemaVersion: 1,
    status: "passed",
    supportedComputeDeviceCounts: {
      cpu: 20,
      gpu: arm ? 15 : 10,
      "neural-engine": arm ? 20 : 0,
      unknown: 0
    },
    usageUnavailableCount: 10
  };
}

function measurement(architecture, preferredNeural) {
  const plan = computePlan(architecture, preferredNeural);
  return {
    architecture,
    artifact: plan.modelPath,
    computePlan: plan,
    configurationComputeUnits: "all",
    macOS: plan.macOS,
    name: `Mac-${architecture}`,
    measurementKind: "full-candidate-generation",
    p50Ms: 1,
    p95Ms: 1.5,
    p99Ms: 2,
    packagedApp: true,
    secureFieldInferenceCount: 0
  };
}

describe("neural packaged-device measurements", () => {
  it("requires every split runtime role to bind its own Neural Engine plan", () => {
    const artifacts = [
      {
        role: "encoder",
        sourcePath: "/Applications/Lekh/Encoder.mlmodelc",
        bundleName: "Encoder.mlmodelc",
        compiledSha256: "b".repeat(64),
        compiledBytes: 1_000
      },
      {
        role: "decoderStep",
        sourcePath: "/Applications/Lekh/DecoderStep.mlmodelc",
        bundleName: "DecoderStep.mlmodelc",
        compiledSha256: "c".repeat(64),
        compiledBytes: 2_000
      }
    ];
    const artifactDescriptor = {
      artifactSetSha256: "d".repeat(64),
      artifacts
    };
    const splitDevice = {
      architecture: "arm64",
      artifact: "/Applications/Lekh Keyboard.app",
      artifactSetSha256: artifactDescriptor.artifactSetSha256,
      computePlans: Object.fromEntries(artifacts.map((artifact) => {
        const plan = computePlan("arm64", true);
        plan.modelPath = artifact.sourcePath;
        plan.modelSha256 = artifact.compiledSha256;
        plan.modelBytes = artifact.compiledBytes;
        return [artifact.role, plan];
      })),
      configurationComputeUnits: "all",
      macOS: "15.5.0",
      name: "Mac-split-arm64",
      measurementKind: "full-candidate-generation",
      p50Ms: 2,
      p95Ms: 4,
      p99Ms: 5,
      packagedApp: true,
      secureFieldInferenceCount: 0
    };
    const result = validateNeuralDeviceMeasurements([splitDevice], {
      artifactDescriptor,
      now,
      production: true
    });
    expect(result.valid).toBe(true);
    expect(result.neuralEngineClaimAllowed).toBe(true);

    delete splitDevice.computePlans.encoder;
    const incomplete = validateNeuralDeviceMeasurements([splitDevice], {
      artifactDescriptor,
      now,
      production: true
    });
    expect(incomplete.issueCodes).toContain(
      "neural-device-measurements.compute-plan-inventory-invalid:Mac-split-arm64"
    );
  });

  it("requires Neural Engine placement on arm64 and accepts optional Intel fallback evidence", () => {
    const result = validateNeuralDeviceMeasurements([
      measurement("arm64", true),
      measurement("x86_64", false)
    ], { manifest, now, production: true });

    expect(result.valid).toBe(true);
    expect(result.neuralEngineClaimAllowed).toBe(true);
    expect(result.intelFallbackProven).toBe(true);
  });

  it("keeps current supported-but-not-preferred placement experimental", () => {
    const development = validateNeuralDeviceMeasurements([
      measurement("arm64", false)
    ], { manifest, now, production: false });
    expect(development.valid).toBe(true);
    expect(development.neuralEngineClaimAllowed).toBe(false);
    expect(development.warnings).toHaveLength(1);

    const production = validateNeuralDeviceMeasurements([
      measurement("arm64", false),
      measurement("x86_64", false)
    ], { manifest, now, production: true });
    expect(production.valid).toBe(false);
    expect(production.issueCodes).toEqual(expect.arrayContaining([
      "neural-device-measurements.neural-engine-plan-unproven",
      "neural-compute-plan.neural-engine-not-preferred:Mac-arm64"
    ]));
  });

  it("rejects invalid percentile ordering and secure-field inference", () => {
    const device = measurement("arm64", true);
    device.p50Ms = 2;
    device.p95Ms = 1;
    device.secureFieldInferenceCount = 1;
    const result = validateNeuralDeviceMeasurements([device], {
      manifest,
      now,
      production: false
    });
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "neural-device-measurements.latency-invalid:Mac-arm64",
      "neural-device-measurements.secure-field-inference:Mac-arm64"
    ]));
  });
});
