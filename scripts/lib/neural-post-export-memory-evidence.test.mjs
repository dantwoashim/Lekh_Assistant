import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEURAL_POST_EXPORT_MEMORY_POLICY,
  validateCanonicalNeuralMemorySummary,
  validateNeuralPostExportMemoryEvidence
} from "./neural-post-export-memory-evidence.mjs";

const root = process.cwd();

describe("post-export neural process-memory evidence", () => {
  it("owns the inclusive 128 MiB absolute lifetime-peak policy", () => {
    expect(NEURAL_POST_EXPORT_MEMORY_POLICY).toEqual({
      schemaVersion: 1,
      measurementKind: "isolated-process-physical-footprint-v1",
      api: "proc_pid_rusage:RUSAGE_INFO_V4",
      units: "bytes",
      maximumLifetimePeakPhysicalFootprintBytes: 134_217_728
    });
    expect(Object.isFrozen(NEURAL_POST_EXPORT_MEMORY_POLICY)).toBe(true);
  });

  it("accepts an exact and internally consistent measurement", () => {
    expect(validateNeuralPostExportMemoryEvidence(validEvidence())).toEqual({
      valid: true,
      issueCodes: []
    });
  });

  it("accepts the inclusive 128 MiB boundary", () => {
    const evidence = validEvidence();
    evidence.lifetimePeakPhysicalFootprintBytes =
      NEURAL_POST_EXPORT_MEMORY_POLICY
        .maximumLifetimePeakPhysicalFootprintBytes;
    evidence.peakIncreaseFromBaselineBytes =
      evidence.lifetimePeakPhysicalFootprintBytes -
      evidence.baselinePhysicalFootprintBytes;

    expect(validateNeuralPostExportMemoryEvidence(evidence).valid).toBe(true);
  });

  it("requires the summary to be the exact worst observed device row", () => {
    const worst = validEvidence();
    const lower = validEvidence();
    lower.lifetimePeakPhysicalFootprintBytes = 80 * 1024 * 1024;
    lower.peakIncreaseFromBaselineBytes =
      lower.lifetimePeakPhysicalFootprintBytes -
      lower.baselinePhysicalFootprintBytes;
    expect(
      validateCanonicalNeuralMemorySummary(worst, [lower, worst])
    ).toMatchObject({
      valid: true,
      matchingDeviceIndexes: [1],
      exceedingDeviceIndexes: []
    });

    const lowerSummary = structuredClone(lower);
    const notWorst = validateCanonicalNeuralMemorySummary(
      lowerSummary,
      [lower, worst]
    );
    expect(notWorst.valid).toBe(false);
    expect(notWorst.issueCodes).toContain(
      "neural-post-export-memory.summary-not-worst:device-1"
    );

    const unobserved = structuredClone(worst);
    unobserved.baselinePhysicalFootprintBytes += 1;
    unobserved.peakIncreaseFromBaselineBytes -= 1;
    const synthetic = validateCanonicalNeuralMemorySummary(
      unobserved,
      [lower, worst]
    );
    expect(synthetic.valid).toBe(false);
    expect(synthetic.issueCodes).toContain(
      "neural-post-export-memory.summary-not-observed"
    );
  });

  for (const [label, mutate, issue] of [
    [
      "missing field",
      (value) => {
        delete value.units;
      },
      "neural-post-export-memory.schema-invalid"
    ],
    [
      "unlisted field",
      (value) => {
        value.residentSizeBytes = 1;
      },
      "neural-post-export-memory.schema-invalid"
    ],
    [
      "substituted API",
      (value) => {
        value.api = "task_info";
      },
      "neural-post-export-memory.identity-invalid"
    ],
    [
      "substituted measurement kind",
      (value) => {
        value.measurementKind = "resident-size-v1";
      },
      "neural-post-export-memory.identity-invalid"
    ],
    [
      "zero baseline",
      (value) => {
        value.baselinePhysicalFootprintBytes = 0;
      },
      "neural-post-export-memory.measurement-invalid"
    ],
    [
      "fractional peak",
      (value) => {
        value.lifetimePeakPhysicalFootprintBytes = 1.5;
      },
      "neural-post-export-memory.measurement-invalid"
    ],
    [
      "unsafe delta",
      (value) => {
        value.peakIncreaseFromBaselineBytes =
          Number.MAX_SAFE_INTEGER + 1;
      },
      "neural-post-export-memory.measurement-invalid"
    ],
    [
      "peak below baseline",
      (value) => {
        value.lifetimePeakPhysicalFootprintBytes =
          value.baselinePhysicalFootprintBytes - 1;
        value.peakIncreaseFromBaselineBytes = 0;
      },
      "neural-post-export-memory.consistency-invalid"
    ],
    [
      "inconsistent delta",
      (value) => {
        value.peakIncreaseFromBaselineBytes += 1;
      },
      "neural-post-export-memory.consistency-invalid"
    ],
    [
      "ceiling exceeded by one byte",
      (value) => {
        value.lifetimePeakPhysicalFootprintBytes =
          NEURAL_POST_EXPORT_MEMORY_POLICY
            .maximumLifetimePeakPhysicalFootprintBytes + 1;
        value.peakIncreaseFromBaselineBytes =
          value.lifetimePeakPhysicalFootprintBytes -
          value.baselinePhysicalFootprintBytes;
      },
      "neural-post-export-memory.ceiling-exceeded"
    ]
  ]) {
    it(`rejects ${label}`, () => {
      const evidence = validEvidence();
      mutate(evidence);
      const validation =
        validateNeuralPostExportMemoryEvidence(evidence);
      expect(validation.valid).toBe(false);
      expect(validation.issueCodes).toContain(issue);
    });
  }

  it("binds the isolated Swift producer to proc_pid_rusage V4", () => {
    const source = readFileSync(
      join(
        root,
        "native/macos-imk/skeleton/Tests/" +
          "LekhInputMethodBehaviorProbe/main.swift"
      ),
      "utf8"
    );
    const benchmarkBranch = source.indexOf(
      "if neuralBenchmarkRequested {"
    );
    const engineConstruction = source.indexOf(
      "private let behaviorEngine = LekhNativeEngineClient()"
    );
    expect(benchmarkBranch).toBeGreaterThan(0);
    expect(engineConstruction).toBeGreaterThan(benchmarkBranch);
    expect(source).toContain("proc_pid_rusage(");
    expect(source).toContain("RUSAGE_INFO_V4");
    expect(source).toContain('"memory": memoryEvidence');
  });
});

function validEvidence() {
  return {
    schemaVersion: 1,
    measurementKind: "isolated-process-physical-footprint-v1",
    api: "proc_pid_rusage:RUSAGE_INFO_V4",
    units: "bytes",
    baselinePhysicalFootprintBytes: 40 * 1024 * 1024,
    lifetimePeakPhysicalFootprintBytes: 96 * 1024 * 1024,
    peakIncreaseFromBaselineBytes: 56 * 1024 * 1024
  };
}
