import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT,
  replayRetainedNeuralNativeServiceBenchmarkEvidence,
  validateNeuralNativeServiceBenchmarkReport
} from "./neural-native-service-benchmark-evidence.mjs";

const root = process.cwd();

describe("full native neural-service benchmark evidence", () => {
  it("freezes one warm-up plus 48 measured passes over five tokens", () => {
    expect(NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT).toEqual({
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
    expect(
      NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens.length *
        NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.measuredPasses
    ).toBe(240);
  });

  it("accepts only the complete 240-sample steady-state structure", () => {
    expect(
      validateReport(validReport())
    ).toEqual({
      valid: true,
      issueCodes: []
    });
  });

  for (const [label, mutate, issue] of [
    [
      "legacy three-pass schedule",
      (value) => {
        value.benchmarkPasses = 3;
        value.measuredPasses = 2;
        value.steadyStateSamples = 10;
      },
      "neural-native-service-benchmark.workload-invalid"
    ],
    [
      "placement-capture substitution",
      (value) => {
        value.placementCapture = true;
      },
      "neural-native-service-benchmark.workload-invalid"
    ],
    [
      "reordered workload",
      (value) => {
        value.workloadTokens.reverse();
      },
      "neural-native-service-benchmark.workload-invalid"
    ],
    [
      "missing token stream",
      (value) => {
        delete value.byTokenMs.paryatan;
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "short per-token stream",
      (value) => {
        value.byTokenMs.prashasan.pop();
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "non-finite sample",
      (value) => {
        value.byTokenMs.prashasan[0] = Number.NaN;
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "negative sample",
      (value) => {
        value.byTokenMs.prashasan[0] = -1;
      },
      "neural-native-service-benchmark.samples-invalid"
    ],
    [
      "wrong latency target",
      (value) => {
        value.targetP95Ms = 49;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "missing performance",
      (value) => {
        delete value.performance;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "non-finite performance",
      (value) => {
        value.performance.p95Ms = Number.NaN;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "negative performance",
      (value) => {
        value.performance.p50Ms = -1;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "non-monotonic percentiles",
      (value) => {
        value.performance.p50Ms = 2;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "unlisted performance field",
      (value) => {
        value.performance.meanMs = 1;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "percentiles inconsistent with raw samples",
      (value) => {
        value.performance.p95Ms = 1.1;
        value.performance.p99Ms = 1.1;
      },
      "neural-native-service-benchmark.performance-invalid"
    ],
    [
      "missing memory evidence",
      (value) => {
        delete value.memory;
      },
      "neural-post-export-memory.schema-invalid"
    ],
    [
      "inconsistent memory delta",
      (value) => {
        value.memory.peakIncreaseFromBaselineBytes += 1;
      },
      "neural-post-export-memory.consistency-invalid"
    ],
    [
      "memory above the inclusive ceiling",
      (value) => {
        value.memory.lifetimePeakPhysicalFootprintBytes = 134_217_729;
        value.memory.peakIncreaseFromBaselineBytes =
          value.memory.lifetimePeakPhysicalFootprintBytes -
          value.memory.baselinePhysicalFootprintBytes;
      },
      "neural-post-export-memory.ceiling-exceeded"
    ],
    [
      "all-empty candidate generation",
      (value) => {
        for (const token of value.workloadTokens) {
          value.candidateResultsByToken[token] =
            value.candidateResultsByToken[token].map(() => []);
          value.predictions[token] = [];
        }
      },
      "neural-native-service-benchmark.candidates-invalid"
    ],
    [
      "one earlier failed candidate request",
      (value) => {
        value.candidateResultsByToken.prashasan[3] = [];
      },
      "neural-native-service-benchmark.candidates-invalid"
    ],
    [
      "unsafe candidate result",
      (value) => {
        value.candidateResultsByToken.prashasan[0] = ["latin"];
      },
      "neural-native-service-benchmark.candidates-invalid"
    ],
    [
      "final prediction inconsistent with measured results",
      (value) => {
        value.predictions.prashasan = ["नेपाल"];
      },
      "neural-native-service-benchmark.candidates-invalid"
    ]
  ]) {
    it(`rejects ${label}`, () => {
      const report = validReport();
      mutate(report);
      const validation = validateReport(report);
      expect(validation.valid).toBe(false);
      expect(validation.issueCodes).toContain(issue);
    });
  }

  for (const [label, mutate, issue] of [
    [
      "wrong service status",
      (value) => {
        value.serviceStatus =
          "experimental-async-coreml-tail-artifact-verified-ready";
      },
      "neural-native-service-benchmark.lifecycle-invalid"
    ],
    [
      "unbounded initialization latency",
      (value) => {
        value.serviceInitializationMs = 10;
      },
      "neural-native-service-benchmark.lifecycle-invalid"
    ],
    [
      "wrong proof mode",
      (value) => {
        value.proofMode = "experimental";
        value.status = "passed-experimental";
        value.serviceStatus =
          "experimental-async-coreml-tail-artifact-verified-ready";
      },
      "neural-native-service-benchmark.identity-invalid"
    ],
    [
      "wrong suite identity",
      (value) => {
        value.suite = "native-neural-service-smoke";
      },
      "neural-native-service-benchmark.identity-invalid"
    ],
    [
      "single-forward latency substitution",
      (value) => {
        value.singleForwardBenchmarkIsConsumerLatency = true;
      },
      "neural-native-service-benchmark.identity-invalid"
    ],
    [
      "secure-field candidates",
      (value) => {
        value.secureFieldCandidates = ["पासवर्ड"];
      },
      "neural-native-service-benchmark.secure-field-invalid"
    ],
    [
      "forged constant secure-field count",
      (value) => {
        value.predictorInvocationEvidence.afterSecureField += 1;
      },
      "neural-native-service-benchmark.secure-field-invalid"
    ],
    [
      "device/report secure-field count mismatch",
      (value) => {
        value.devices[0].secureFieldInferenceCount = 1;
      },
      "neural-native-service-benchmark.secure-field-invalid"
    ],
    [
      "deterministic token reaching prediction",
      (value) => {
        value.predictorInvocationEvidence
          .afterDeterministicBypass += 1;
      },
      "neural-native-service-benchmark.bypass-invalid"
    ],
    [
      "protected token producing a candidate",
      (value) => {
        value.protectedLatinBypassCandidates.GitHub = ["गिटहब"];
      },
      "neural-native-service-benchmark.bypass-invalid"
    ],
    [
      "missing protected bypass row",
      (value) => {
        delete value.protectedLatinBypassCandidates.PostgreSQL;
      },
      "neural-native-service-benchmark.bypass-invalid"
    ],
    [
      "phrase expansion claim",
      (value) => {
        value.singleTokenPhraseExpansionRate = 0.01;
      },
      "neural-native-service-benchmark.bypass-invalid"
    ],
    [
      "stale latest-request completion",
      (value) => {
        value.latestRequestCompletions = ["prashasan"];
      },
      "neural-native-service-benchmark.latest-request-invalid"
    ],
    [
      "false latest-request result",
      (value) => {
        value.latestRequestWins = false;
      },
      "neural-native-service-benchmark.latest-request-invalid"
    ],
    [
      "called cancelled completion",
      (value) => {
        value.cancelledCompletionCalled = true;
      },
      "neural-native-service-benchmark.cancellation-invalid"
    ],
    [
      "false cancellation result",
      (value) => {
        value.cancelPendingSuppressesCompletion = false;
      },
      "neural-native-service-benchmark.cancellation-invalid"
    ],
    [
      "artifact digest tampering",
      (value) => {
        value.artifactIdentity.artifactSetSha256 = "f".repeat(64);
      },
      "neural-native-service-benchmark.artifact-identity-invalid"
    ]
  ]) {
    it(`fails closed on ${label}`, () => {
      const report = validReport();
      mutate(report);
      const validation = validateReport(report);
      expect(validation.valid).toBe(false);
      expect(validation.issueCodes).toContain(issue);
    });
  }

  it("requires independent artifact context", () => {
    const validation =
      validateNeuralNativeServiceBenchmarkReport(validReport(), {
        expectedProofMode: "production"
      });
    expect(validation.valid).toBe(false);
    expect(validation.issueCodes).toContain(
      "neural-native-service-benchmark.artifact-context-missing"
    );
  });

  it("replays retained evidence from raw samples and invocation deltas", () => {
    const replay = replayReport(validReport());
    expect(replay).toEqual({
      valid: true,
      issueCodes: [],
      evidence: {
        proofMode: "production",
        artifactIdentity: {
          trainingRunId: "1".repeat(32),
          exportRunId: "2".repeat(32),
          manifestSha256: "a".repeat(64),
          vocabSha256: "b".repeat(64),
          artifactSetSha256: "c".repeat(64),
          compiledModelSha256: "d".repeat(64)
        },
        workload: {
          orderedTokens: [
            ...NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT.orderedTokens
          ],
          warmupPasses: 1,
          measuredPasses: 48,
          warmupRequests: 5,
          steadyStateSamples: 240
        },
        performance: {
          source: "byTokenMs-nearest-rank",
          sampleCount: 240,
          p50Ms: 1,
          p95Ms: 1,
          p99Ms: 1
        },
        inferenceSafety: {
          source: "predictorInvocationEvidence-deltas",
          deterministicExactBypassInferenceCount: 0,
          protectedLatinBypassInferenceCount: 0,
          workloadInferenceCount: 245,
          secureFieldInferenceCount: 0,
          deterministicExactBypassFailClosed: true,
          protectedLatinBypassFailClosed: true,
          secureFieldFailClosed: true
        }
      }
    });
    expect(Object.isFrozen(replay)).toBe(true);
    expect(Object.isFrozen(replay.evidence.performance)).toBe(true);
  });

  it("requires an explicit recognized retained-evidence proof mode", () => {
    const missingMode =
      replayRetainedNeuralNativeServiceBenchmarkEvidence(
        validReport(),
        { artifactDescriptor: validArtifactDescriptor() }
      );
    expect(missingMode.valid).toBe(false);
    expect(missingMode.evidence).toBeNull();
    expect(missingMode.issueCodes).toContain(
      "neural-native-service-benchmark-replay." +
        "proof-mode-context-invalid"
    );

    const unknownMode = replayReport(validReport(), {
      expectedProofMode: "future-proof"
    });
    expect(unknownMode.valid).toBe(false);
    expect(unknownMode.evidence).toBeNull();
    expect(unknownMode.issueCodes).toContain(
      "neural-native-service-benchmark-replay." +
        "proof-mode-context-invalid"
    );
  });

  it("independently recomputes nearest-rank retained percentiles", () => {
    const report = validReport();
    for (const token of report.workloadTokens) {
      report.byTokenMs[token] = Array.from(
        { length: report.measuredPasses },
        (_, index) => index + 1
      );
    }
    report.performance = { p50Ms: 24, p95Ms: 46, p99Ms: 48 };

    expect(replayReport(report).evidence.performance).toEqual({
      source: "byTokenMs-nearest-rank",
      sampleCount: 240,
      p50Ms: 24,
      p95Ms: 46,
      p99Ms: 48
    });
  });

  it("rejects a retained latency summary inconsistent with raw samples", () => {
    const report = validReport();
    report.performance = { p50Ms: 1, p95Ms: 2, p99Ms: 2 };
    const replay = replayReport(report);

    expect(replay.valid).toBe(false);
    expect(replay.evidence).toBeNull();
    expect(replay.issueCodes).toContain(
      "neural-native-service-benchmark.performance-invalid"
    );
    expect(replay.issueCodes).toContain(
      "neural-native-service-benchmark-replay." +
        "performance-summary-mismatch"
    );
  });

  it("derives secure-field safety instead of trusting zero summaries", () => {
    const report = validReport();
    report.predictorInvocationEvidence.afterSecureField += 1;
    report.secureFieldInferenceCount = 1;
    report.devices[0].secureFieldInferenceCount = 1;
    const replay = replayReport(report);

    expect(replay.valid).toBe(false);
    expect(replay.evidence).toBeNull();
    expect(replay.issueCodes).toContain(
      "neural-native-service-benchmark.secure-field-invalid"
    );
    expect(replay.issueCodes).toContain(
      "neural-native-service-benchmark-replay.inference-safety-failed"
    );
  });

  it("binds invocation evidence to the complete retained workload", () => {
    const report = validReport();
    report.predictorInvocationEvidence.beforeSecureField -= 1;
    report.predictorInvocationEvidence.afterSecureField -= 1;
    const replay = replayReport(report);

    expect(replay.valid).toBe(false);
    expect(replay.evidence).toBeNull();
    expect(replay.issueCodes).toContain(
      "neural-native-service-benchmark-replay." +
        "workload-inference-count-invalid"
    );
  });

  it("binds retained evidence to the exact compiled artifact", () => {
    const report = validReport();
    report.artifactIdentity.compiledModelSha256 = "e".repeat(64);
    const replay = replayReport(report);

    expect(replay.valid).toBe(false);
    expect(replay.evidence).toBeNull();
    expect(replay.issueCodes).toContain(
      "neural-native-service-benchmark.artifact-identity-invalid"
    );
  });

  it("binds every compiled role in a split-model artifact", () => {
    const descriptor = validSplitArtifactDescriptor();
    const report = validReport();
    report.artifactIdentity = {
      trainingRunId: descriptor.manifest.trainingRunId,
      exportRunId: descriptor.manifest.exportRunId,
      manifestSha256: descriptor.manifestSha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256,
      compiledModels: {
        encoder: descriptor.artifacts[0].compiledSha256,
        decoderStep: descriptor.artifacts[1].compiledSha256
      }
    };

    const replay = replayReport(report, {
      artifactDescriptor: descriptor
    });
    expect(replay.valid).toBe(true);
    expect(replay.evidence.artifactIdentity.compiledModels).toEqual({
      decoderStep: "f".repeat(64),
      encoder: "e".repeat(64)
    });

    report.artifactIdentity.compiledModels.decoderStep = "0".repeat(64);
    const substituted = replayReport(report, {
      artifactDescriptor: descriptor
    });
    expect(substituted.valid).toBe(false);
    expect(substituted.evidence).toBeNull();
    expect(substituted.issueCodes).toContain(
      "neural-native-service-benchmark.artifact-identity-invalid"
    );
  });

  it("binds the valid status and service state for every full proof mode", () => {
    for (const [proofMode, status, serviceStatus] of [
      [
        "experimental",
        "passed-experimental",
        "experimental-async-coreml-tail-artifact-verified-ready"
      ],
      [
        "candidate-promotion",
        "passed-candidate-promotion-evidence",
        "experimental-async-coreml-tail-artifact-verified-ready"
      ],
      [
        "production",
        "passed-production",
        "production-async-coreml-tail-attested-ready"
      ]
    ]) {
      const report = validReport();
      report.proofMode = proofMode;
      report.status = status;
      report.serviceStatus = serviceStatus;
      expect(validateReport(report, {
        expectedProofMode: proofMode
      }).valid).toBe(true);
    }
  });

  it("binds the Swift producer to 48 full passes and eight capture passes", () => {
    const source = readFileSync(
      join(
        root,
        "native/macos-imk/skeleton/Tests/" +
          "LekhInputMethodBehaviorProbe/main.swift"
      ),
      "utf8"
    );
    expect(source).toContain("let benchmarkWarmupPasses = 1");
    expect(source).toContain(
      "let benchmarkMeasuredPasses = placementCapture ? 8 : 48"
    );
    expect(source).toContain(
      "let benchmarkIterations = benchmarkWarmupPasses + " +
        "benchmarkMeasuredPasses"
    );
    expect(source).toContain("service.predictorInvocationCount");
    expect(source).toContain('"predictorInvocationEvidence": [');
    expect(source).toContain(
      '"secureFieldInferenceCount": secureFieldInferenceCount'
    );
    expect(source).not.toContain('"secureFieldInferenceCount": 0');
  });

  it.skipIf(process.platform === "win32")(
    "makes the benchmark CLI reject a structurally short probe report",
    () => {
      mkdirSync(join(root, ".tmp"), { recursive: true });
      const fixtureRoot = mkdtempSync(
        join(root, ".tmp/neural-native-service-contract-")
      );
      try {
        const bundle = join(
          fixtureRoot,
          "Lekh Keyboard.imkdevbundle"
        );
        const resources = join(bundle, "Contents", "Resources");
        mkdirSync(resources, { recursive: true });
        writeFileSync(
          join(resources, "LekhNeuralTransliterator.manifest.json"),
          "{}\n"
        );
        writeFileSync(
          join(resources, "LekhNeuralTransliterator.vocab.json"),
          "{}\n"
        );
        const fakeSwift = join(fixtureRoot, "bin", "swift");
        mkdirSync(dirname(fakeSwift), { recursive: true });
        writeFileSync(fakeSwift, fakeSwiftSource());
        chmodSync(fakeSwift, 0o755);
        const reportPath = join(fixtureRoot, "report.json");
        const result = spawnSync(
          process.execPath,
          [
            join(root, "scripts/benchmark-neural-native-service.mjs"),
            "--bundle",
            bundle,
            "--report",
            reportPath
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${dirname(fakeSwift)}${delimiter}${process.env.PATH ?? ""}`
            },
            encoding: "utf8"
          }
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "Full native neural-service benchmark workload drifted from " +
            "its closed contract"
        );
        expect(result.stderr).toContain(
          "neural-native-service-benchmark.workload-invalid"
        );
        expect(existsSync(reportPath)).toBe(false);
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  );
});

function validReport() {
  const contract = NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  const descriptor = validArtifactDescriptor();
  const predictorInvocationsBeforeSecureField =
    contract.orderedTokens.length *
    (contract.warmupPasses + contract.measuredPasses);
  return {
    suite: "native-neural-service-e2e",
    status: "passed-production",
    proofMode: "production",
    serviceStatus:
      "production-async-coreml-tail-attested-ready",
    serviceInitializationMs: 1,
    singleForwardBenchmarkIsConsumerLatency: false,
    artifactIdentity: {
      trainingRunId: descriptor.manifest.trainingRunId,
      exportRunId: descriptor.manifest.exportRunId,
      manifestSha256: descriptor.manifestSha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256,
      compiledModelSha256:
        descriptor.artifacts[0].compiledSha256
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
    memory: {
      schemaVersion: 1,
      measurementKind: "isolated-process-physical-footprint-v1",
      api: "proc_pid_rusage:RUSAGE_INFO_V4",
      units: "bytes",
      baselinePhysicalFootprintBytes: 40 * 1024 * 1024,
      lifetimePeakPhysicalFootprintBytes: 96 * 1024 * 1024,
      peakIncreaseFromBaselineBytes: 56 * 1024 * 1024
    },
    candidateResultsByToken: Object.fromEntries(
      contract.orderedTokens.map((token) => [
        token,
        Array.from(
          { length: contract.measuredPasses },
          () => ["नेपाली"]
        )
      ])
    ),
    predictions: Object.fromEntries(
      contract.orderedTokens.map((token) => [token, ["नेपाली"]])
    ),
    devices: [{ secureFieldInferenceCount: 0 }],
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
      beforeSecureField: predictorInvocationsBeforeSecureField,
      afterSecureField: predictorInvocationsBeforeSecureField
    },
    latestRequestTokens: [...contract.latestRequestTokens],
    latestRequestCompletions: [
      contract.latestRequestTokens.at(-1)
    ],
    latestRequestWins: true,
    cancelledCompletionCalled: false,
    cancelPendingSuppressesCompletion: true,
    byTokenMs: Object.fromEntries(
      contract.orderedTokens.map((token) => [
        token,
        Array(contract.measuredPasses).fill(1)
      ])
    )
  };
}

function validateReport(report, context = {}) {
  return validateNeuralNativeServiceBenchmarkReport(report, {
    artifactDescriptor: validArtifactDescriptor(),
    expectedProofMode: "production",
    ...context
  });
}

function replayReport(report, context = {}) {
  return replayRetainedNeuralNativeServiceBenchmarkEvidence(report, {
    artifactDescriptor: validArtifactDescriptor(),
    expectedProofMode: "production",
    ...context
  });
}

function validArtifactDescriptor() {
  return {
    artifactLayout: "single-model",
    manifest: {
      trainingRunId: "1".repeat(32),
      exportRunId: "2".repeat(32)
    },
    manifestSha256: "a".repeat(64),
    vocabSha256: "b".repeat(64),
    artifactSetSha256: "c".repeat(64),
    artifacts: [{
      role: "model",
      compiledSha256: "d".repeat(64)
    }]
  };
}

function validSplitArtifactDescriptor() {
  return {
    artifactLayout: "split-attention",
    manifest: {
      trainingRunId: "1".repeat(32),
      exportRunId: "2".repeat(32)
    },
    manifestSha256: "a".repeat(64),
    vocabSha256: "b".repeat(64),
    artifactSetSha256: "c".repeat(64),
    artifacts: [
      {
        role: "encoder",
        compiledSha256: "e".repeat(64)
      },
      {
        role: "decoderStep",
        compiledSha256: "f".repeat(64)
      }
    ]
  };
}

function fakeSwiftSource() {
  return `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const reportPath = process.env.LEKH_NEURAL_BENCH_REPORT;
const payload = {
  runNonce: process.env.LEKH_NEURAL_BENCH_NONCE,
  bundle: process.env.LEKH_NEURAL_BENCH_BUNDLE,
  status: "passed-experimental",
  placementCapture: false,
  workloadTokens: ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"],
  benchmarkPasses: 3,
  warmupPasses: 1,
  measuredPasses: 2,
  warmupRequests: 5,
  steadyStateSamples: 10,
  byTokenMs: Object.fromEntries(
    ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"]
      .map((token) => [token, [1, 1]])
  ),
  targetP95Ms: 50,
  performance: { p50Ms: 1, p95Ms: 1, p99Ms: 1 },
  memory: {
    schemaVersion: 1,
    measurementKind: "isolated-process-physical-footprint-v1",
    api: "proc_pid_rusage:RUSAGE_INFO_V4",
    units: "bytes",
    baselinePhysicalFootprintBytes: 41943040,
    lifetimePeakPhysicalFootprintBytes: 100663296,
    peakIncreaseFromBaselineBytes: 58720256
  },
  candidateResultsByToken: Object.fromEntries(
    ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"]
      .map((token) => [token, Array.from({ length: 2 }, () => ["नेपाली"])])
  ),
  predictions: Object.fromEntries(
    ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"]
      .map((token) => [token, ["नेपाली"]])
  )
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(payload));
`;
}
