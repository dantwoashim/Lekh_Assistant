export const CTC_FINITE_PATH_DECODER_POLICY = Object.freeze({
  schemaVersion: 1,
  policyId: "ctc-finite-path-only-v1",
  rule: "repeat-aware-required-time-steps<=logit-time-steps",
  purpose: "exclude-zero-probability-prefixes"
});

const POLICY_KEYS = Object.freeze([
  "policyId",
  "purpose",
  "rule",
  "schemaVersion"
]);

export function isCTCFinitePathDecoderPolicy(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(POLICY_KEYS) &&
    value.schemaVersion === CTC_FINITE_PATH_DECODER_POLICY.schemaVersion &&
    value.policyId === CTC_FINITE_PATH_DECODER_POLICY.policyId &&
    value.rule === CTC_FINITE_PATH_DECODER_POLICY.rule &&
    value.purpose === CTC_FINITE_PATH_DECODER_POLICY.purpose;
}
