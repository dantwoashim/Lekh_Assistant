const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GENERATED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const TOP_LEVEL_KEYS = Object.freeze([
  "architecture",
  "artifactIdentity",
  "capture",
  "correlation",
  "evidenceKind",
  "generatedAt",
  "hardware",
  "macOS",
  "observations",
  "recordType",
  "schemaVersion",
  "status",
  "workload"
]);
const ARTIFACT_IDENTITY_KEYS = Object.freeze([
  "artifactSetSha256",
  "manifestSha256",
  "runtimeRoles",
  "vocabSha256"
]);
const ROLE_IDENTITY_KEYS = Object.freeze([
  "bundleName",
  "compiledBytes",
  "compiledSha256"
]);
const CAPTURE_KEYS = Object.freeze([
  "coreMLInstrument",
  "neuralEngineInstrument",
  "tool",
  "traceExportSha256",
  "traceSha256",
  "xcodeVersion"
]);
const HARDWARE_KEYS = Object.freeze(["chip", "modelIdentifier"]);
const CORRELATION_KEYS = Object.freeze([
  "coreMLComputeLane",
  "neuralEngineHardwareTrack",
  "predictionIntervalsCorrelated",
  "processScoped",
  "rolePathsResolved"
]);
const WORKLOAD_KEYS = Object.freeze([
  "inputCorpusSha256",
  "measuredIterations",
  "measurementKind",
  "warmupIterations"
]);
const OBSERVATION_KEYS = Object.freeze([
  "coreMLPredictionCount",
  "neuralEngineComputeEventCount",
  "roleExecutions"
]);
const ROLE_EXECUTION_KEYS = Object.freeze([
  "bundleName",
  "compiledSha256",
  "neuralEngineComputeObserved",
  "predictionCount"
]);

/**
 * Validate observed runtime placement separately from MLComputePlan.
 *
 * Compute plans describe anticipated support/preference. This contract is
 * intentionally limited to evidence exported from a live Core ML Instruments
 * trace correlated with the Neural Engine hardware track for the exact
 * packaged artifact set.
 */
export function validateNeuralRuntimePlacementEvidence(
  evidence,
  context = {}
) {
  const issues = [];
  const addIssue = (code) => {
    if (!issues.includes(code)) issues.push(code);
  };
  if (!exactKeys(evidence, TOP_LEVEL_KEYS)) {
    addIssue("neural-runtime-placement.schema-invalid");
    return result();
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.recordType !== "lekh-neural-runtime-placement-evidence" ||
    evidence.status !== "passed" ||
    evidence.evidenceKind !==
      "instruments-coreml-neural-engine-runtime-trace"
  ) {
    addIssue("neural-runtime-placement.identity-invalid");
  }
  if (
    evidence.architecture !== "arm64" ||
    evidence.architecture !==
      (context.expectedArchitecture ?? "arm64") ||
    !validVersion(evidence.macOS) ||
    !validDate(evidence.generatedAt, context.now ?? new Date())
  ) {
    addIssue("neural-runtime-placement.environment-invalid");
  }
  if (
    !exactKeys(evidence.hardware, HARDWARE_KEYS) ||
    !shortText(evidence.hardware.chip) ||
    !shortText(evidence.hardware.modelIdentifier)
  ) {
    addIssue("neural-runtime-placement.hardware-invalid");
  }
  if (
    !exactKeys(evidence.capture, CAPTURE_KEYS) ||
    evidence.capture.tool !== "Instruments" ||
    evidence.capture.coreMLInstrument !== true ||
    evidence.capture.neuralEngineInstrument !== true ||
    !validVersion(evidence.capture.xcodeVersion) ||
    !validSha256(evidence.capture.traceSha256) ||
    !validSha256(evidence.capture.traceExportSha256)
  ) {
    addIssue("neural-runtime-placement.capture-invalid");
  }
  if (
    !exactKeys(evidence.correlation, CORRELATION_KEYS) ||
    Object.values(evidence.correlation).some((value) => value !== true)
  ) {
    addIssue("neural-runtime-placement.correlation-invalid");
  }
  if (
    !exactKeys(evidence.workload, WORKLOAD_KEYS) ||
    evidence.workload.measurementKind !==
      "full-candidate-generation" ||
    !validSha256(evidence.workload.inputCorpusSha256) ||
    !Number.isSafeInteger(evidence.workload.warmupIterations) ||
    evidence.workload.warmupIterations < 5 ||
    !Number.isSafeInteger(evidence.workload.measuredIterations) ||
    evidence.workload.measuredIterations < 30
  ) {
    addIssue("neural-runtime-placement.workload-invalid");
  }

  const descriptor = context.artifactDescriptor;
  if (!isRecord(descriptor) ||
      !Array.isArray(descriptor.artifacts) ||
      descriptor.artifacts.length < 1) {
    addIssue("neural-runtime-placement.descriptor-missing");
  } else {
    validateArtifactIdentity(evidence.artifactIdentity, descriptor, addIssue);
    validateObservations(
      evidence.observations,
      evidence.workload,
      descriptor,
      addIssue
    );
  }
  return result();

  function result() {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...issues].sort(compareText)),
      neuralEngineClaimAllowed: issues.length === 0
    });
  }
}

function validateArtifactIdentity(value, descriptor, addIssue) {
  if (
    !exactKeys(value, ARTIFACT_IDENTITY_KEYS) ||
    value.artifactSetSha256 !== descriptor.artifactSetSha256 ||
    value.manifestSha256 !== descriptor.manifestSha256 ||
    value.vocabSha256 !== descriptor.vocabSha256 ||
    !validSha256(value.artifactSetSha256) ||
    !validSha256(value.manifestSha256) ||
    !validSha256(value.vocabSha256)
  ) {
    addIssue("neural-runtime-placement.artifact-identity-invalid");
    return;
  }
  const expectedRoles = descriptor.artifacts
    .map(({ role }) => role)
    .sort(compareText);
  if (!isRecord(value.runtimeRoles) ||
      !deepEqual(Object.keys(value.runtimeRoles).sort(compareText), expectedRoles)) {
    addIssue("neural-runtime-placement.role-inventory-invalid");
    return;
  }
  for (const artifact of descriptor.artifacts) {
    const role = value.runtimeRoles[artifact.role];
    if (
      !exactKeys(role, ROLE_IDENTITY_KEYS) ||
      role.bundleName !== artifact.bundleName ||
      role.compiledSha256 !== artifact.compiledSha256 ||
      role.compiledBytes !== artifact.compiledBytes
    ) {
      addIssue(`neural-runtime-placement.role-identity-invalid:${artifact.role}`);
    }
  }
}

function validateObservations(value, workload, descriptor, addIssue) {
  if (
    !exactKeys(value, OBSERVATION_KEYS) ||
    !Number.isSafeInteger(value.coreMLPredictionCount) ||
    value.coreMLPredictionCount < (workload?.measuredIterations ?? Infinity) ||
    !Number.isSafeInteger(value.neuralEngineComputeEventCount) ||
    value.neuralEngineComputeEventCount < 1
  ) {
    addIssue("neural-runtime-placement.observations-invalid");
    return;
  }
  const expectedRoles = descriptor.artifacts
    .map(({ role }) => role)
    .sort(compareText);
  if (!isRecord(value.roleExecutions) ||
      !deepEqual(
        Object.keys(value.roleExecutions).sort(compareText),
        expectedRoles
      )) {
    addIssue("neural-runtime-placement.execution-inventory-invalid");
    return;
  }
  let totalRolePredictions = 0;
  let allRoleCountsValid = true;
  for (const artifact of descriptor.artifacts) {
    const execution = value.roleExecutions[artifact.role];
    const predictionCount = execution?.predictionCount;
    if (
      !exactKeys(execution, ROLE_EXECUTION_KEYS) ||
      execution.bundleName !== artifact.bundleName ||
      execution.compiledSha256 !== artifact.compiledSha256 ||
      !Number.isSafeInteger(predictionCount) ||
      predictionCount < (workload?.measuredIterations ?? Infinity) ||
      execution.neuralEngineComputeObserved !== true
    ) {
      addIssue(`neural-runtime-placement.execution-invalid:${artifact.role}`);
    }
    if (Number.isSafeInteger(predictionCount) && predictionCount >= 0) {
      totalRolePredictions += predictionCount;
    } else {
      allRoleCountsValid = false;
    }
  }
  if (
    allRoleCountsValid &&
    totalRolePredictions !== value.coreMLPredictionCount
  ) {
    addIssue("neural-runtime-placement.prediction-count-mismatch");
  }
}

function exactKeys(value, keys) {
  return isRecord(value) &&
    deepEqual(Object.keys(value).sort(compareText), [...keys].sort(compareText));
}

function validDate(value, now) {
  if (typeof value !== "string" || !GENERATED_AT_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  const fullCanonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
  const secondCanonical = fullCanonical?.replace(".000Z", "Z");
  return (fullCanonical === value || secondCanonical === value) &&
    milliseconds <= now.getTime() + 5 * 60 * 1000;
}

function validVersion(value) {
  return typeof value === "string" &&
    /^\d+(?:\.\d+){1,2}$/u.test(value);
}

function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function shortText(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

function isRecord(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return deepEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
