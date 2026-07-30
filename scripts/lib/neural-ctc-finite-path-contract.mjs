export const CTC_FINITE_PATH_DECODER_POLICY = Object.freeze({
  schemaVersion: 2,
  policyId: "ctc-finite-terminal-path-v2",
  finitePathRule:
    "repeat-aware-required-time-steps<=logit-time-steps",
  finalPruneRule:
    "sequence-eligibility-before-final-beam-truncation",
  purpose: "return-ranked-finite-terminable-candidates"
});

const POLICY_KEYS = Object.freeze([
  "finalPruneRule",
  "finitePathRule",
  "policyId",
  "purpose",
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
    value.finitePathRule ===
      CTC_FINITE_PATH_DECODER_POLICY.finitePathRule &&
    value.finalPruneRule ===
      CTC_FINITE_PATH_DECODER_POLICY.finalPruneRule &&
    value.purpose === CTC_FINITE_PATH_DECODER_POLICY.purpose;
}
