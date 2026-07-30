import { createHash } from "node:crypto";

const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function validateNeuralTrainingCandidateIdentity({
  manifest,
  exportReport,
  trainingReport,
  checkpointSha256,
  trainingReportSha256
}) {
  const issueCodes = [];
  const effectiveTrainingConfigSha256 =
    exportReport?.effectiveTrainingConfigSha256;
  const canonicalConfig =
    trainingReport?.effectiveTrainingConfigCanonicalJson;
  let parsedCanonicalConfig = null;
  try {
    parsedCanonicalConfig = JSON.parse(canonicalConfig);
  } catch {
    issueCodes.push("neural-training-identity.canonical-config-invalid");
  }
  const trainingSeed =
    trainingReport?.effectiveTrainingConfig?.trainingRun?.seed;

  if (!RUN_ID_PATTERN.test(String(manifest?.trainingRunId ?? "")) ||
      exportReport?.trainingRunId !== manifest?.trainingRunId ||
      trainingReport?.trainingRunId !== manifest?.trainingRunId) {
    issueCodes.push("neural-training-identity.training-run-mismatch");
  }
  if (trainingReport?.status !== "passed-training-checkpoint" ||
      trainingReport?.trainingComplete !== true ||
      trainingReport?.modelId !== manifest?.selectedArtifact) {
    issueCodes.push("neural-training-identity.training-report-not-complete");
  }
  if (!SHA256_PATTERN.test(String(checkpointSha256 ?? "")) ||
      exportReport?.checkpointSha256 !== checkpointSha256 ||
      trainingReport?.checkpointSha256 !== checkpointSha256 ||
      manifest?.sha256?.sourceCheckpoint !== checkpointSha256) {
    issueCodes.push("neural-training-identity.checkpoint-mismatch");
  }
  if (!SHA256_PATTERN.test(String(trainingReportSha256 ?? "")) ||
      exportReport?.trainingReportSha256 !== trainingReportSha256) {
    issueCodes.push("neural-training-identity.training-report-mismatch");
  }
  if (!SHA256_PATTERN.test(String(effectiveTrainingConfigSha256 ?? "")) ||
      trainingReport?.effectiveTrainingConfigSha256 !==
        effectiveTrainingConfigSha256 ||
      typeof canonicalConfig !== "string" ||
      sha256Text(canonicalConfig) !== effectiveTrainingConfigSha256 ||
      !deepEqual(
        parsedCanonicalConfig,
        trainingReport?.effectiveTrainingConfig
      )) {
    issueCodes.push("neural-training-identity.effective-config-mismatch");
  }
  if (!Number.isSafeInteger(trainingSeed) ||
      trainingSeed < 0 ||
      trainingSeed > 0xffff_ffff) {
    issueCodes.push("neural-training-identity.seed-invalid");
  }

  return Object.freeze({
    valid: issueCodes.length === 0,
    issueCodes: Object.freeze([...new Set(issueCodes)].sort()),
    identity: issueCodes.length === 0
      ? Object.freeze({
          trainingRunId: manifest.trainingRunId,
          sourceCheckpointSha256: checkpointSha256,
          trainingReportSha256,
          effectiveTrainingConfigSha256,
          trainingSeed
        })
      : null
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!left || !right ||
      typeof left !== "object" ||
      typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqual(left[key], right[key])
    );
}
