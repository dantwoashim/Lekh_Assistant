import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT
} from "./neural-native-service-benchmark-evidence.mjs";
import {
  validateNeuralSotaRuntimeEvidence
} from "./neural-sota-runtime-evidence.mjs";

const root = process.cwd();
const now = new Date("2026-07-30T04:00:00.000Z");
const nativeReportSha256 = "a".repeat(64);

describe("final neural runtime-evidence verification", () => {
  it("accepts an exact native report and Core ML digest/summary binding", () => {
    const fixture = validFixture();
    expect(validate(fixture)).toEqual({
      valid: true,
      issueCodes: []
    });
  });

  it("rejects over-budget native memory even when both reports still say passed", () => {
    const fixture = validFixture();
    fixture.nativeReport.memory =
      memoryEvidence(128 * 1024 * 1024 + 1);
    fixture.nativeReport.devices[0].memory =
      structuredClone(fixture.nativeReport.memory);
    fixture.coreMLReport.performance.devices =
      structuredClone(fixture.nativeReport.devices);

    const result = validate(fixture);
    expect(result.valid).toBe(false);
    expect(result.issueCodes).toContain(
      "neural-sota-runtime.native:" +
        "neural-post-export-memory.ceiling-exceeded"
    );
    expect(result.issueCodes).toContain(
      "neural-sota-runtime.device:" +
        "neural-post-export-memory.ceiling-exceeded:fixture-arm64"
    );
  });

  it("rejects a valid-looking device memory record that differs from the summary", () => {
    const fixture = validFixture();
    fixture.nativeReport.devices[0].memory =
      memoryEvidence(100 * 1024 * 1024);
    fixture.coreMLReport.performance.devices =
      structuredClone(fixture.nativeReport.devices);

    const result = validate(fixture);
    expect(result.issueCodes).toContain(
      "neural-sota-runtime.device:" +
        "neural-device-measurements.memory-mismatch:summary"
    );
  });

  it("rejects stale Core ML source digests and independently edited summaries", () => {
    const stale = validFixture();
    stale.coreMLReport.measurementsSha256 = "b".repeat(64);
    expect(validate(stale).issueCodes).toContain(
      "neural-sota-runtime.measurements-sha256-mismatch"
    );

    const edited = validFixture();
    edited.coreMLReport.performance.p99Ms = 2;
    expect(validate(edited).issueCodes).toContain(
      "neural-sota-runtime.coreml-summary-mismatch"
    );
  });

  it("replays native lifecycle and safety evidence instead of trusting passed status", () => {
    const fixture = validFixture();
    fixture.nativeReport.latestRequestWins = false;
    fixture.nativeReport.cancelledCompletionCalled = true;
    const result = validate(fixture);
    expect(result.issueCodes).toContain(
      "neural-sota-runtime.native:" +
        "neural-native-service-benchmark.latest-request-invalid"
    );
    expect(result.issueCodes).toContain(
      "neural-sota-runtime.native:" +
        "neural-native-service-benchmark.cancellation-invalid"
    );
  });

  it("publishes the exact measurement-file SHA-256 in the Core ML report", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "lekh-coreml-measurement-digest-")
    );
    try {
      const measurementsPath = join(fixtureRoot, "measurements.json");
      const reportPath = join(fixtureRoot, "coreml-report.json");
      const measurementBytes = Buffer.from(
        `${JSON.stringify({ devices: [] }, null, 2)}\n`
      );
      mkdirSync(dirname(measurementsPath), { recursive: true });
      writeFileSync(measurementsPath, measurementBytes);

      const result = spawnSync(
        process.execPath,
        [
          join(root, "scripts/benchmark-neural-coreml-device.mjs"),
          "--measurements",
          measurementsPath,
          "--report",
          reportPath
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8"
        }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.measurementsSha256).toBe(
        createHash("sha256").update(measurementBytes).digest("hex")
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("wires the final checker to the exact inspected native-report digest", () => {
    const source = readFileSync(
      join(root, "scripts/check-neural-sota-worldclass.mjs"),
      "utf8"
    );
    expect(source).toContain("validateNeuralSotaRuntimeEvidence({");
    expect(source).toContain(
      "nativeReportSha256: productionE2E.file.sha256"
    );
    expect(source).toContain("!runtimeEvidenceValidation.valid");
  });
});

function validate(fixture) {
  return validateNeuralSotaRuntimeEvidence({
    ...fixture,
    nativeReportSha256,
    now
  });
}

function validFixture() {
  const artifact = {
    role: "model",
    bundleName: "LekhNeuralTransliterator.mlmodelc",
    compiledSha256: "c".repeat(64),
    compiledBytes: 4_000_000
  };
  const artifactDescriptor = {
    artifactLayout: "single-model",
    manifest: {
      trainingRunId: "1".repeat(32),
      exportRunId: "2".repeat(32)
    },
    manifestSha256: "e".repeat(64),
    vocabSha256: "f".repeat(64),
    artifactSetSha256: "d".repeat(64),
    artifacts: [artifact]
  };
  const memory = memoryEvidence();
  const device = {
    architecture: "arm64",
    artifact: "/Applications/Lekh Keyboard.app",
    artifactSetSha256: artifactDescriptor.artifactSetSha256,
    computePlans: {
      model: computePlan(artifact)
    },
    configurationComputeUnits: "all",
    macOS: "15.5.0",
    name: "fixture-arm64",
    measurementKind: "full-candidate-generation",
    p50Ms: 1,
    p95Ms: 1,
    p99Ms: 1,
    packagedApp: true,
    secureFieldInferenceCount: 0,
    memory: structuredClone(memory)
  };
  const contract = NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  const candidates = {
    prashasan: ["प्रशासन"],
    nagarikta: ["नागरिकता"],
    mantralaya: ["मन्त्रालय"],
    sambidhan: ["संविधान"],
    paryatan: ["पर्यटन"]
  };
  const candidateResultsByToken = Object.fromEntries(
    contract.orderedTokens.map((token) => [
      token,
      Array.from(
        { length: contract.measuredPasses },
        () => [...candidates[token]]
      )
    ])
  );
  const nativeReport = {
    suite: "native-neural-service-e2e",
    status: "passed-production",
    proofMode: "production",
    serviceStatus:
      "production-async-coreml-tail-attested-ready",
    serviceInitializationMs: 1,
    singleForwardBenchmarkIsConsumerLatency: false,
    artifactIdentity: {
      trainingRunId: artifactDescriptor.manifest.trainingRunId,
      exportRunId: artifactDescriptor.manifest.exportRunId,
      manifestSha256: artifactDescriptor.manifestSha256,
      vocabSha256: artifactDescriptor.vocabSha256,
      artifactSetSha256:
        artifactDescriptor.artifactSetSha256,
      compiledModelSha256: artifact.compiledSha256
    },
    placementCapture: false,
    workloadTokens: [...contract.orderedTokens],
    benchmarkPasses:
      contract.warmupPasses + contract.measuredPasses,
    warmupPasses: contract.warmupPasses,
    measuredPasses: contract.measuredPasses,
    warmupRequests:
      contract.orderedTokens.length * contract.warmupPasses,
    steadyStateSamples:
      contract.orderedTokens.length * contract.measuredPasses,
    targetP95Ms: contract.targetP95Ms,
    performance: { p50Ms: 1, p95Ms: 1, p99Ms: 1 },
    memory: structuredClone(memory),
    byTokenMs: Object.fromEntries(
      contract.orderedTokens.map((token) => [
        token,
        Array(contract.measuredPasses).fill(1)
      ])
    ),
    candidateResultsByToken,
    predictions: Object.fromEntries(
      contract.orderedTokens.map((token) => [
        token,
        [...candidates[token]]
      ])
    ),
    singleTokenPhraseExpansionRate: 0,
    secureFieldProbeToken: contract.secureFieldProbeToken,
    secureFieldCandidates: [],
    secureFieldInferenceCount: 0,
    deterministicExactBypassToken:
      contract.deterministicExactBypassToken,
    deterministicExactBypassCandidates: [],
    deterministicExactBypassInferenceCount: 0,
    protectedLatinBypassCandidates: Object.fromEntries(
      contract.protectedLatinTokens.map((token) => [token, []])
    ),
    protectedLatinBypassInferenceCount: 0,
    predictorInvocationEvidence: {
      beforeDeterministicBypass: 0,
      afterDeterministicBypass: 0,
      beforeProtectedBypass: 0,
      afterProtectedBypass: 0,
      beforeSecureField:
        contract.orderedTokens.length *
        (contract.warmupPasses + contract.measuredPasses),
      afterSecureField:
        contract.orderedTokens.length *
        (contract.warmupPasses + contract.measuredPasses)
    },
    latestRequestTokens: [...contract.latestRequestTokens],
    latestRequestCompletions: [
      contract.latestRequestTokens.at(-1)
    ],
    latestRequestWins: true,
    cancelledCompletionCalled: false,
    cancelPendingSuppressesCompletion: true,
    devices: [device]
  };
  const coreMLReport = {
    measurementsSha256: nativeReportSha256,
    performance: {
      p50Ms: 1,
      p95Ms: 1,
      p99Ms: 1,
      targetP99Ms: 50,
      measuredOnDevice: true,
      memory: structuredClone(nativeReport.memory),
      devices: structuredClone(nativeReport.devices)
    }
  };
  return { nativeReport, coreMLReport, artifactDescriptor };
}

function memoryEvidence(
  lifetimePeakPhysicalFootprintBytes = 96 * 1024 * 1024
) {
  const baselinePhysicalFootprintBytes = 40 * 1024 * 1024;
  return {
    schemaVersion: 1,
    measurementKind: "isolated-process-physical-footprint-v1",
    api: "proc_pid_rusage:RUSAGE_INFO_V4",
    units: "bytes",
    baselinePhysicalFootprintBytes,
    lifetimePeakPhysicalFootprintBytes,
    peakIncreaseFromBaselineBytes:
      lifetimePeakPhysicalFootprintBytes -
      baselinePhysicalFootprintBytes
  };
}

function computePlan(artifact) {
  return {
    architecture: "arm64",
    availableComputeDevices: ["cpu", "gpu", "neural-engine"],
    configurationComputeUnits: "all",
    evidenceKind: "coreml-compute-plan-anticipated-device-usage",
    generatedAt: "2026-07-30T03:00:00Z",
    macOS: "15.5.0",
    modelBytes: artifact.compiledBytes,
    modelKinds: ["program"],
    modelPath: `/Applications/${artifact.bundleName}`,
    modelSha256: artifact.compiledSha256,
    neuralEngineAvailable: true,
    neuralEnginePlanEvidence: true,
    neuralEnginePreferredOperationCount: 12,
    neuralEngineSupportedOperationCount: 20,
    operationCount: 30,
    preferredComputeDeviceCounts: {
      cpu: 8,
      gpu: 0,
      "neural-engine": 12,
      unknown: 0
    },
    recordType: "lekh-neural-compute-plan-evidence",
    schemaVersion: 1,
    status: "passed",
    supportedComputeDeviceCounts: {
      cpu: 20,
      gpu: 15,
      "neural-engine": 20,
      unknown: 0
    },
    usageUnavailableCount: 10
  };
}
