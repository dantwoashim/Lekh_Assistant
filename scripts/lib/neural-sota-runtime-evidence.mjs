import {
  validateNeuralDeviceMeasurements
} from "./neural-device-measurements.mjs";
import {
  validateNeuralNativeServiceBenchmarkReport
} from "./neural-native-service-benchmark-evidence.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Revalidate the final native-service measurement and bind the derived Core ML
 * summary to those exact report bytes.
 *
 * Status fields are intentionally insufficient here: the final release guard
 * replays the native workload/memory validators and the packaged-device
 * validator before accepting the downstream summary.
 */
export function validateNeuralSotaRuntimeEvidence({
  nativeReport,
  nativeReportSha256,
  coreMLReport,
  artifactDescriptor,
  now
}) {
  const issues = [];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };

  const nativeValidation =
    validateNeuralNativeServiceBenchmarkReport(nativeReport, {
      artifactDescriptor,
      expectedProofMode: "production"
    });
  for (const issue of nativeValidation.issueCodes) {
    addIssue(`neural-sota-runtime.native:${issue}`);
  }

  const deviceValidation = validateNeuralDeviceMeasurements(
    nativeReport?.devices,
    {
      artifactDescriptor,
      memoryEvidence: nativeReport?.memory,
      now,
      production: true
    }
  );
  for (const issue of deviceValidation.issueCodes) {
    addIssue(`neural-sota-runtime.device:${issue}`);
  }

  if (!SHA256_PATTERN.test(String(nativeReportSha256 ?? "")) ||
      coreMLReport?.measurementsSha256 !== nativeReportSha256) {
    addIssue("neural-sota-runtime.measurements-sha256-mismatch");
  }

  const performance = coreMLReport?.performance;
  const expectedPerformance = expectedCoreMLPerformance(nativeReport);
  if (!expectedPerformance ||
      !isRecord(performance) ||
      performance.p50Ms !== expectedPerformance.p50Ms ||
      performance.p95Ms !== expectedPerformance.p95Ms ||
      performance.p99Ms !== expectedPerformance.p99Ms ||
      performance.targetP99Ms !== 50 ||
      performance.measuredOnDevice !== true ||
      canonicalJson(performance.memory) !==
        canonicalJson(nativeReport?.memory) ||
      canonicalJson(performance.devices) !==
        canonicalJson(nativeReport?.devices)) {
    addIssue("neural-sota-runtime.coreml-summary-mismatch");
  }

  return Object.freeze({
    valid: issues.length === 0,
    issueCodes: Object.freeze([...issues].sort(compareText))
  });
}

function expectedCoreMLPerformance(nativeReport) {
  if (!Array.isArray(nativeReport?.devices) ||
      nativeReport.devices.length === 0) {
    return null;
  }
  const values = {};
  for (const field of ["p50Ms", "p95Ms", "p99Ms"]) {
    const measurements = nativeReport.devices.map((device) =>
      device?.[field]
    );
    if (measurements.some((value) =>
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0
    )) {
      return null;
    }
    values[field] = round(Math.max(...measurements));
  }
  return values;
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
