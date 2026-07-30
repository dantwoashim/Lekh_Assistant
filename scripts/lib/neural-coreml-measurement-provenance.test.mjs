import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectNeuralCoreMLMeasurementReport
} from "./neural-coreml-measurement-provenance.mjs";

const root = process.cwd();

describe("Core ML native-measurement provenance", () => {
  it("retains canonical memory and hashes exact source bytes", () => {
    const source = Buffer.from(JSON.stringify({
      status: "passed-production",
      memory: memoryEvidence(),
      devices: []
    }, null, 2) + "\n");
    const inspected = inspectNeuralCoreMLMeasurementReport(
      source,
      { production: true }
    );

    expect(inspected.valid).toBe(true);
    expect(inspected.sourceReportBytes).toBe(source.byteLength);
    expect(inspected.sourceReportSha256).toBe(
      createHash("sha256").update(source).digest("hex")
    );
    expect(inspected.memory).toEqual(memoryEvidence());
    expect(Object.keys(inspected.memory)).toEqual([
      "schemaVersion",
      "measurementKind",
      "api",
      "units",
      "baselinePhysicalFootprintBytes",
      "lifetimePeakPhysicalFootprintBytes",
      "peakIncreaseFromBaselineBytes"
    ]);
    expect(Object.isFrozen(inspected.memory)).toBe(true);

    inspected.report.memory.peakIncreaseFromBaselineBytes += 1;
    expect(inspected.memory).toEqual(memoryEvidence());
  });

  it("changes the digest after same-length source tampering", () => {
    const first = Buffer.from(JSON.stringify({
      nonce: "a",
      memory: memoryEvidence()
    }));
    const second = Buffer.from(
      first.toString("utf8").replace('"nonce":"a"', '"nonce":"b"')
    );
    expect(second.byteLength).toBe(first.byteLength);

    const before = inspectNeuralCoreMLMeasurementReport(
      first,
      { production: true }
    );
    const after = inspectNeuralCoreMLMeasurementReport(
      second,
      { production: true }
    );
    expect(before.valid).toBe(true);
    expect(after.valid).toBe(true);
    expect(after.sourceReportSha256).not.toBe(before.sourceReportSha256);
  });

  it("fails production closed on missing or tampered memory", () => {
    const missing = inspectNeuralCoreMLMeasurementReport(
      Buffer.from("{}"),
      { production: true }
    );
    expect(missing.issueCodes).toContain(
      "neural-coreml-measurement-provenance.memory-missing"
    );
    expect(missing.memory).toBeNull();

    const inconsistent = memoryEvidence();
    inconsistent.peakIncreaseFromBaselineBytes += 1;
    const tampered = inspectNeuralCoreMLMeasurementReport(
      Buffer.from(JSON.stringify({ memory: inconsistent })),
      { production: true }
    );
    expect(tampered.issueCodes).toContain(
      "neural-post-export-memory.consistency-invalid:source-report"
    );
    expect(tampered.memory).toBeNull();
  });

  it("keeps legacy development reports explicit without inventing memory", () => {
    const inspected = inspectNeuralCoreMLMeasurementReport(
      Buffer.from("{}"),
      { production: false }
    );
    expect(inspected.valid).toBe(true);
    expect(inspected.memory).toBeNull();
  });

  it("rejects malformed source bytes while still reporting their digest", () => {
    const source = Buffer.from([0xff, 0xfe, 0xfd]);
    const inspected = inspectNeuralCoreMLMeasurementReport(
      source,
      { production: true }
    );
    expect(inspected.valid).toBe(false);
    expect(inspected.issueCodes).toContain(
      "neural-coreml-measurement-provenance.source-json-invalid"
    );
    expect(inspected.sourceReportSha256).toBe(
      createHash("sha256").update(source).digest("hex")
    );
  });

  it("retains both fields in the generated production report", () => {
    const temporary = mkdtempSync(
      join(tmpdir(), "lekh-coreml-provenance-")
    );
    try {
      const sourcePath = join(temporary, "native-measurements.json");
      const reportPath = join(temporary, "derived-benchmark.json");
      const source = Buffer.from(JSON.stringify({
        status: "passed-production",
        proofMode: "production",
        memory: memoryEvidence(),
        devices: [{ p50Ms: 1, p95Ms: 2, p99Ms: 3 }]
      }, null, 2) + "\n");
      writeFileSync(sourcePath, source);
      const child = spawnSync(
        process.execPath,
        [
          join(root, "scripts/benchmark-neural-coreml-device.mjs"),
          "--production",
          "--measurements",
          sourcePath,
          "--report",
          reportPath
        ],
        {
          cwd: temporary,
          encoding: "utf8"
        }
      );
      // The fixture deliberately has no production artifact or Instruments
      // trace. The derived failure report must still retain its exact source
      // provenance for diagnosis rather than silently dropping it.
      expect(child.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(report.production).toBe(true);
      expect(report.performance.memory).toEqual(memoryEvidence());
      expect(report.measurementsSha256).toBe(
        createHash("sha256").update(source).digest("hex")
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

function memoryEvidence() {
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
