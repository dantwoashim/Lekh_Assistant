import { describe, expect, it } from "vitest";
import {
  NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT,
  NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY,
  validateNeuralPlacementCaptureReport,
  validateNeuralRuntimePlacementEvidence
} from "./neural-runtime-placement-evidence.mjs";

describe("observed Neural Engine runtime placement evidence", () => {
  it("accepts an exact split-artifact Instruments trace summary", () => {
    const descriptor = splitDescriptor();
    const result = validateNeuralRuntimePlacementEvidence(
      evidence(descriptor),
      {
        artifactDescriptor: descriptor,
        now: new Date("2026-07-29T00:00:00Z")
      }
    );

    expect(result).toEqual({
      valid: true,
      issueCodes: [],
      neuralEngineClaimAllowed: true
    });
  });

  for (const [label, mutate, issue] of [
    [
      "compute-plan substitution",
      (value) => {
        value.evidenceKind =
          "coreml-compute-plan-anticipated-device-usage";
      },
      "neural-runtime-placement.identity-invalid"
    ],
    [
      "uncorrelated hardware activity",
      (value) => {
        value.correlation.predictionIntervalsCorrelated = false;
      },
      "neural-runtime-placement.correlation-invalid"
    ],
    [
      "artifact-set drift",
      (value) => {
        value.artifactIdentity.artifactSetSha256 = "f".repeat(64);
      },
      "neural-runtime-placement.artifact-identity-invalid"
    ],
    [
      "partial role inventory",
      (value) => {
        delete value.observations.roleExecutions.decoderStep;
      },
      "neural-runtime-placement.execution-inventory-invalid"
    ],
    [
      "role without observed Neural Engine compute",
      (value) => {
        value.observations.roleExecutions.encoder
          .neuralEngineComputeObserved = false;
      },
      "neural-runtime-placement.execution-invalid:encoder"
    ],
    [
      "role not observed for every measured request",
      (value) => {
        value.observations.roleExecutions.encoder.predictionCount = 39;
        value.observations.coreMLPredictionCount = 1239;
      },
      "neural-runtime-placement.execution-invalid:encoder"
    ],
    [
      "inconsistent aggregate prediction count",
      (value) => {
        value.observations.coreMLPredictionCount += 1;
      },
      "neural-runtime-placement.prediction-count-mismatch"
    ],
    [
      "workload schedule drift",
      (value) => {
        value.workload.measuredIterations -= 1;
      },
      "neural-runtime-placement.workload-invalid"
    ],
    [
      "substituted workload corpus",
      (value) => {
        value.workload.inputCorpusSha256 = "f".repeat(64);
      },
      "neural-runtime-placement.workload-invalid"
    ],
    [
      "noncanonical capture timestamp",
      (value) => {
        value.generatedAt = "2026-02-30T12:00:00Z";
      },
      "neural-runtime-placement.environment-invalid"
    ],
    [
      "open schema",
      (value) => {
        value.claim = "trust-me";
      },
      "neural-runtime-placement.schema-invalid"
    ]
  ]) {
    it(`rejects ${label}`, () => {
      const descriptor = splitDescriptor();
      const value = evidence(descriptor);
      mutate(value);
      const result = validateNeuralRuntimePlacementEvidence(value, {
        artifactDescriptor: descriptor,
        now: new Date("2026-07-29T00:00:00Z")
      });

      expect(result.valid).toBe(false);
      expect(result.neuralEngineClaimAllowed).toBe(false);
      expect(result.issueCodes).toContain(issue);
    });
  }

  it("accepts the single-model role branch", () => {
    const descriptor = {
      manifestSha256: "1".repeat(64),
      vocabSha256: "2".repeat(64),
      artifactSetSha256: "3".repeat(64),
      artifacts: [{
        role: "model",
        bundleName: "LekhNeuralTransliterator.mlmodelc",
        compiledBytes: 1024,
        compiledSha256: "4".repeat(64)
      }]
    };
    expect(validateNeuralRuntimePlacementEvidence(
      evidence(descriptor),
      {
        artifactDescriptor: descriptor,
        now: new Date("2026-07-29T00:00:00Z")
      }
    ).valid).toBe(true);
  });

  it("accepts a capture report for the exact native probe schedule", () => {
    expect(validateNeuralPlacementCaptureReport(captureReport())).toEqual({
      valid: true,
      issueCodes: []
    });
  });

  for (const [label, mutate, issue] of [
    [
      "reordered tokens",
      (value) => {
        value.workloadTokens.reverse();
      },
      "neural-placement-capture.workload-invalid"
    ],
    [
      "missing measured request",
      (value) => {
        value.steadyStateSamples -= 1;
      },
      "neural-placement-capture.workload-invalid"
    ],
    [
      "short per-token sample stream",
      (value) => {
        value.byTokenMs.prashasan.pop();
      },
      "neural-placement-capture.samples-invalid"
    ],
    [
      "missing prediction token",
      (value) => {
        delete value.predictions.paryatan;
      },
      "neural-placement-capture.predictions-invalid"
    ]
  ]) {
    it(`rejects placement capture with ${label}`, () => {
      const value = captureReport();
      mutate(value);
      const result = validateNeuralPlacementCaptureReport(value);
      expect(result.valid).toBe(false);
      expect(result.issueCodes).toContain(issue);
    });
  }
});

function splitDescriptor() {
  return {
    manifestSha256: "1".repeat(64),
    vocabSha256: "2".repeat(64),
    artifactSetSha256: "3".repeat(64),
    artifacts: [
      {
        role: "encoder",
        bundleName: "LekhNeuralTransliteratorEncoder.mlmodelc",
        compiledBytes: 1024,
        compiledSha256: "4".repeat(64)
      },
      {
        role: "decoderStep",
        bundleName: "LekhNeuralTransliteratorDecoderStep.mlmodelc",
        compiledBytes: 2048,
        compiledSha256: "5".repeat(64)
      }
    ]
  };
}

function evidence(descriptor) {
  const runtimeRoles = {};
  const roleExecutions = {};
  for (const artifact of descriptor.artifacts) {
    runtimeRoles[artifact.role] = {
      bundleName: artifact.bundleName,
      compiledBytes: artifact.compiledBytes,
      compiledSha256: artifact.compiledSha256
    };
    roleExecutions[artifact.role] = {
      bundleName: artifact.bundleName,
      compiledSha256: artifact.compiledSha256,
      predictionCount: artifact.role === "encoder" ? 40 : 1200,
      neuralEngineComputeObserved: true
    };
  }
  const coreMLPredictionCount = Object.values(roleExecutions)
    .reduce((total, role) => total + role.predictionCount, 0);
  return {
    schemaVersion: 1,
    recordType: "lekh-neural-runtime-placement-evidence",
    status: "passed",
    evidenceKind: "instruments-coreml-neural-engine-runtime-trace",
    generatedAt: "2026-07-28T12:00:00Z",
    architecture: "arm64",
    macOS: "26.2",
    hardware: {
      chip: "Apple M-series",
      modelIdentifier: "MacFixture1,1"
    },
    capture: {
      tool: "Instruments",
      xcodeVersion: "26.0",
      coreMLInstrument: true,
      neuralEngineInstrument: true,
      traceSha256: "6".repeat(64),
      traceExportSha256: "7".repeat(64)
    },
    artifactIdentity: {
      manifestSha256: descriptor.manifestSha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256,
      runtimeRoles
    },
    workload: {
      ...NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
    },
    correlation: {
      processScoped: true,
      predictionIntervalsCorrelated: true,
      rolePathsResolved: true,
      coreMLComputeLane: true,
      neuralEngineHardwareTrack: true
    },
    observations: {
      coreMLPredictionCount,
      neuralEngineComputeEventCount: coreMLPredictionCount,
      roleExecutions
    }
  };
}

function captureReport() {
  const samples = Object.fromEntries(
    NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.orderedTokens.map(
      (token) => [
        token,
        Array(
          NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.measuredPasses
        ).fill(1)
      ]
    )
  );
  return {
    proofMode: "placement-capture",
    placementCapture: true,
    benchmarkPasses:
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.warmupPasses +
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.measuredPasses,
    warmupPasses:
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.warmupPasses,
    measuredPasses:
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.measuredPasses,
    warmupRequests:
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY.warmupIterations,
    steadyStateSamples:
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY.measuredIterations,
    workloadTokens: [
      ...NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.orderedTokens
    ],
    runtimePlacementWorkload: {
      ...NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
    },
    byTokenMs: samples,
    predictions: Object.fromEntries(
      NEURAL_RUNTIME_PLACEMENT_WORKLOAD_CONTRACT.orderedTokens.map(
        (token) => [token, ["नेपाली"]]
      )
    )
  };
}
