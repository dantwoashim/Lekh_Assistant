import { createHash } from "node:crypto";
import {
  validateNeuralPostExportMemoryEvidence
} from "./neural-post-export-memory-evidence.mjs";

const MAX_SOURCE_REPORT_BYTES = 64 * 1024 * 1024;

/**
 * Inspect the exact native measurement-report bytes consumed by the Core ML
 * benchmark. The returned digest is over those bytes, not reserialized JSON.
 * Valid memory is copied into one stable schema order before it is retained in
 * the derived benchmark report.
 */
export function inspectNeuralCoreMLMeasurementReport(
  sourceBytes,
  { production = false } = {}
) {
  const issues = [];
  const bytes = asBytes(sourceBytes);
  if (!bytes || bytes.byteLength < 1 ||
      bytes.byteLength > MAX_SOURCE_REPORT_BYTES) {
    issues.push("neural-coreml-measurement-provenance.source-bytes-invalid");
    return result({
      bytes: bytes?.byteLength ?? 0,
      memory: null,
      report: null,
      sha256: null
    });
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let report = null;
  try {
    report = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    issues.push("neural-coreml-measurement-provenance.source-json-invalid");
  }
  if (!isRecord(report)) {
    if (report !== null) {
      issues.push("neural-coreml-measurement-provenance.source-schema-invalid");
    }
    return result({
      bytes: bytes.byteLength,
      memory: null,
      report: null,
      sha256
    });
  }

  const hasMemory = Object.hasOwn(report, "memory");
  let memory = null;
  if (production && !hasMemory) {
    issues.push("neural-coreml-measurement-provenance.memory-missing");
  }
  if (hasMemory) {
    const validation =
      validateNeuralPostExportMemoryEvidence(report.memory);
    if (!validation.valid) {
      issues.push(...validation.issueCodes.map((code) =>
        `${code}:source-report`
      ));
    } else {
      memory = canonicalMemory(report.memory);
    }
  }

  return result({
    bytes: bytes.byteLength,
    memory,
    report,
    sha256
  });

  function result(value) {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...new Set(issues)].sort(compareText)),
      sourceReportBytes: value.bytes,
      sourceReportSha256: value.sha256,
      report: value.report,
      memory: value.memory
    });
  }
}

function canonicalMemory(value) {
  return deepFreeze({
    schemaVersion: value.schemaVersion,
    measurementKind: value.measurementKind,
    api: value.api,
    units: value.units,
    baselinePhysicalFootprintBytes:
      value.baselinePhysicalFootprintBytes,
    lifetimePeakPhysicalFootprintBytes:
      value.lifetimePeakPhysicalFootprintBytes,
    peakIncreaseFromBaselineBytes:
      value.peakIncreaseFromBaselineBytes
  });
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
