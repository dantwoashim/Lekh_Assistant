import { createHash } from "node:crypto";

export const CTC_COREML_PARITY_CASE_IDS = Object.freeze([
  "lexical-prefix-baseline",
  "minimum-admitted-length",
  "typical-nepal",
  "repeated-scalar",
  "maximum-content-length"
]);

export const CTC_COREML_PARITY_POLICY = Object.freeze({
  schemaVersion: 1,
  policyId: "ctc-representative-logit-parity-v1",
  sourceBackend: "pytorch-fp32-checkpoint",
  targetBackend: "compiled-coreml-fp16-mlprogram",
  comparison: "all-logits-numpy-allclose",
  caseIds: CTC_COREML_PARITY_CASE_IDS,
  purpose: "verify-conversion-across-runtime-input-boundaries"
});

const POLICY_KEYS = Object.freeze([
  "caseIds",
  "comparison",
  "policyId",
  "purpose",
  "schemaVersion",
  "sourceBackend",
  "targetBackend"
]);
const SUITE_KEYS = Object.freeze([
  "absoluteTolerance",
  "caseCount",
  "caseIdentitySha256",
  "cases",
  "maximumAbsoluteLogitError",
  "policyId",
  "relativeTolerance",
  "schemaVersion",
  "status"
]);
const CASE_KEYS = Object.freeze([
  "caseId",
  "contentLength",
  "inputSha256",
  "maximumAbsoluteLogitError"
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PARITY_TOLERANCE = 5e-3;

export function isCTCCoreMLParityPolicy(value) {
  return isObject(value) &&
    sameKeys(value, POLICY_KEYS) &&
    value.schemaVersion === CTC_COREML_PARITY_POLICY.schemaVersion &&
    value.policyId === CTC_COREML_PARITY_POLICY.policyId &&
    value.sourceBackend === CTC_COREML_PARITY_POLICY.sourceBackend &&
    value.targetBackend === CTC_COREML_PARITY_POLICY.targetBackend &&
    value.comparison === CTC_COREML_PARITY_POLICY.comparison &&
    value.purpose === CTC_COREML_PARITY_POLICY.purpose &&
    Array.isArray(value.caseIds) &&
    JSON.stringify(value.caseIds) ===
      JSON.stringify(CTC_COREML_PARITY_CASE_IDS);
}

export function isCTCCoreMLParitySuite(
  value,
  { maximumInputLength = 32 } = {}
) {
  if (!Number.isSafeInteger(maximumInputLength) ||
      maximumInputLength < 9 ||
      !isObject(value) ||
      !sameKeys(value, SUITE_KEYS) ||
      value.schemaVersion !== 1 ||
      value.status !== "passed" ||
      value.policyId !== CTC_COREML_PARITY_POLICY.policyId ||
      value.caseCount !== CTC_COREML_PARITY_CASE_IDS.length ||
      value.relativeTolerance !== PARITY_TOLERANCE ||
      value.absoluteTolerance !== PARITY_TOLERANCE ||
      !Array.isArray(value.cases) ||
      value.cases.length !== CTC_COREML_PARITY_CASE_IDS.length) {
    return false;
  }

  const expectedLengths = [
    Math.min(6, maximumInputLength - 1),
    3,
    5,
    8,
    maximumInputLength - 1
  ];
  for (let index = 0; index < value.cases.length; index += 1) {
    const candidate = value.cases[index];
    if (!isObject(candidate) ||
        !sameKeys(candidate, CASE_KEYS) ||
        candidate.caseId !== CTC_COREML_PARITY_CASE_IDS[index] ||
        candidate.contentLength !== expectedLengths[index] ||
        !SHA256_PATTERN.test(String(candidate.inputSha256 ?? "")) ||
        !isFiniteNonnegative(candidate.maximumAbsoluteLogitError)) {
      return false;
    }
  }

  const identities = value.cases.map((candidate) => ({
    caseId: candidate.caseId,
    contentLength: candidate.contentLength,
    inputSha256: candidate.inputSha256
  }));
  const uniqueInputs = new Set(
    identities.map((candidate) => candidate.inputSha256)
  );
  const maximumError = Math.max(
    ...value.cases.map(
      (candidate) => candidate.maximumAbsoluteLogitError
    )
  );
  return uniqueInputs.size === value.cases.length &&
    value.caseIdentitySha256 === sha256(JSON.stringify(identities)) &&
    value.maximumAbsoluteLogitError === maximumError;
}

export function hasCTCCoreMLParityEvidence(coremlExport) {
  if (!isObject(coremlExport) ||
      !isCTCCoreMLParityPolicy(coremlExport.representativeParityPolicy)) {
    return false;
  }
  const inputShape = coremlExport.tensorContract?.inputIds?.shape;
  if (!Array.isArray(inputShape) ||
      inputShape.length !== 2 ||
      inputShape[0] !== 1 ||
      !Number.isSafeInteger(inputShape[1])) {
    return false;
  }
  const prepublication = coremlExport.prePublicationValidation;
  const artifact = coremlExport.artifactValidation;
  const prepublicationSuite = prepublication?.representativeParitySuite;
  const artifactSuite = artifact?.representativeParitySuite;
  return isCTCCoreMLParitySuite(prepublicationSuite, {
    maximumInputLength: inputShape[1]
  }) &&
    isCTCCoreMLParitySuite(artifactSuite, {
      maximumInputLength: inputShape[1]
    }) &&
    prepublicationSuite.caseIdentitySha256 ===
      artifactSuite.caseIdentitySha256 &&
    prepublication?.status === "passed" &&
    artifact?.status === "passed" &&
    prepublication?.knownAnswerInputSha256 ===
      prepublicationSuite.cases[0].inputSha256 &&
    artifact?.knownAnswerInputSha256 ===
      artifactSuite.cases[0].inputSha256 &&
    prepublication?.maximumAbsoluteLogitError ===
      prepublicationSuite.cases[0].maximumAbsoluteLogitError &&
    artifact?.maximumAbsoluteLogitError ===
      artifactSuite.cases[0].maximumAbsoluteLogitError &&
    prepublication?.relativeTolerance ===
      prepublicationSuite.relativeTolerance &&
    artifact?.relativeTolerance === artifactSuite.relativeTolerance &&
    prepublication?.absoluteTolerance ===
      prepublicationSuite.absoluteTolerance &&
    artifact?.absoluteTolerance === artifactSuite.absoluteTolerance;
}

function isObject(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function sameKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify(expected);
}

function isFiniteNonnegative(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
