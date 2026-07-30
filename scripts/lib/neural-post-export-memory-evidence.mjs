export const NEURAL_POST_EXPORT_MEMORY_POLICY = deepFreeze({
  schemaVersion: 1,
  measurementKind: "isolated-process-physical-footprint-v1",
  api: "proc_pid_rusage:RUSAGE_INFO_V4",
  units: "bytes",
  maximumLifetimePeakPhysicalFootprintBytes: 128 * 1024 * 1024
});

const MEMORY_EVIDENCE_KEYS = Object.freeze([
  "api",
  "baselinePhysicalFootprintBytes",
  "lifetimePeakPhysicalFootprintBytes",
  "measurementKind",
  "peakIncreaseFromBaselineBytes",
  "schemaVersion",
  "units"
].sort());

/**
 * Validate the process-memory evidence captured around one isolated,
 * post-export native-service benchmark.
 *
 * The ceiling is inclusive: an exact 128 MiB absolute lifetime peak passes.
 * The baseline-relative increase is diagnostic and cannot hide a bloated
 * process baseline.
 */
export function validateNeuralPostExportMemoryEvidence(evidence) {
  const issues = [];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  const policy = NEURAL_POST_EXPORT_MEMORY_POLICY;

  if (!exactKeys(evidence, MEMORY_EVIDENCE_KEYS)) {
    addIssue("neural-post-export-memory.schema-invalid");
    return result();
  }
  if (
    evidence.schemaVersion !== policy.schemaVersion ||
    evidence.measurementKind !== policy.measurementKind ||
    evidence.api !== policy.api ||
    evidence.units !== policy.units
  ) {
    addIssue("neural-post-export-memory.identity-invalid");
  }

  const baseline = evidence.baselinePhysicalFootprintBytes;
  const lifetimePeak = evidence.lifetimePeakPhysicalFootprintBytes;
  const delta = evidence.peakIncreaseFromBaselineBytes;
  if (
    !positiveSafeInteger(baseline) ||
    !positiveSafeInteger(lifetimePeak) ||
    !nonnegativeSafeInteger(delta)
  ) {
    addIssue("neural-post-export-memory.measurement-invalid");
  } else {
    if (lifetimePeak < baseline || delta !== lifetimePeak - baseline) {
      addIssue("neural-post-export-memory.consistency-invalid");
    }
    if (
      lifetimePeak >
      policy.maximumLifetimePeakPhysicalFootprintBytes
    ) {
      addIssue("neural-post-export-memory.ceiling-exceeded");
    }
  }

  return result();

  function result() {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...issues].sort(compareText))
    });
  }
}

function exactKeys(value, expected) {
  return isRecord(value) &&
    Object.keys(value).sort(compareText).join("\0") === expected.join("\0");
}

function isRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
