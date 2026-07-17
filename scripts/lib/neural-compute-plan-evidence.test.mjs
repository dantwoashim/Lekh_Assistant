import { describe, expect, it } from "vitest";
import { validateNeuralComputePlanEvidence } from "./neural-compute-plan-evidence.mjs";

const now = new Date("2026-07-17T12:00:00.000Z");
const manifest = {
  modelBytes: 3_528_631,
  sha256: { compiledModel: "a".repeat(64) }
};

function evidence(architecture = "arm64") {
  const arm = architecture === "arm64";
  return {
    architecture,
    availableComputeDevices: arm ? ["cpu", "gpu", "neural-engine"] : ["cpu", "gpu"],
    configurationComputeUnits: "all",
    evidenceKind: "coreml-compute-plan-anticipated-device-usage",
    generatedAt: "2026-07-17T11:00:00Z",
    macOS: "15.5.0",
    modelBytes: manifest.modelBytes,
    modelKinds: ["program"],
    modelPath: "/Applications/Lekh/Resources/LekhNeuralTransliterator.mlmodelc",
    modelSha256: manifest.sha256.compiledModel,
    neuralEngineAvailable: arm,
    neuralEnginePlanEvidence: arm,
    neuralEnginePreferredOperationCount: arm ? 12 : 0,
    neuralEngineSupportedOperationCount: arm ? 20 : 0,
    operationCount: 30,
    preferredComputeDeviceCounts: {
      cpu: arm ? 8 : 20,
      gpu: 0,
      "neural-engine": arm ? 12 : 0,
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

function validate(value, production = false) {
  return validateNeuralComputePlanEvidence(value, {
    expectedArchitecture: value.architecture,
    manifest,
    now,
    production
  });
}

describe("neural compute-plan evidence", () => {
  it("permits a Neural Engine claim only when the plan actually prefers it", () => {
    const result = validate(evidence("arm64"), true);
    expect(result.valid).toBe(true);
    expect(result.neuralEngineClaimAllowed).toBe(true);
    expect(result.deterministicFallbackProven).toBe(false);
  });

  it("keeps supported-but-not-preferred models experimental", () => {
    const value = evidence("arm64");
    value.preferredComputeDeviceCounts.cpu += value.preferredComputeDeviceCounts["neural-engine"];
    value.preferredComputeDeviceCounts["neural-engine"] = 0;
    value.neuralEnginePreferredOperationCount = 0;
    value.neuralEnginePlanEvidence = false;

    const development = validate(value);
    expect(development.valid).toBe(true);
    expect(development.neuralEngineClaimAllowed).toBe(false);
    expect(development.warnings).toHaveLength(1);

    const production = validate(value, true);
    expect(production.valid).toBe(false);
    expect(production.issueCodes).toContain("neural-compute-plan.neural-engine-not-preferred");
  });

  it("accepts explicit Intel CPU/GPU fallback and rejects identity or accounting drift", () => {
    const fallback = validate(evidence("x86_64"), true);
    expect(fallback.valid).toBe(true);
    expect(fallback.deterministicFallbackProven).toBe(true);

    const tampered = evidence("x86_64");
    tampered.modelSha256 = "b".repeat(64);
    tampered.usageUnavailableCount = 9;
    tampered.extra = true;
    const result = validate(tampered, true);
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "neural-compute-plan.schema-invalid"
    ]));
  });
});
