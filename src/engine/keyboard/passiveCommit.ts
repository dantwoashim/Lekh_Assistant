import passiveCommitPolicy from "../../../data/engine/lekh-experimental-passive-commit.v1.json";
import tokenCandidatePack from "../../../data/engine/lekh-token-candidates.v1.json";
import { sha256Hex } from "../util/sha256";
import type { Candidate, CandidateUpdate, TypingContext } from "./types";

export const EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID = "lekh-experimental-passive-commit-v1" as const;
const QUARANTINED_AMBIGUOUS_INPUTS = new Set(["le", "ko", "cha", "ho", "xa", "lai", "ani", "aba", "nepal", "nepali"]);

interface PassiveCommitEntry {
  input: string;
  output: string;
}

const AUTHORIZED_ENTRIES = new Map<string, PassiveCommitEntry>(
  passiveCommitPolicy.entries.map((entry) => [entry.input, entry])
);

export function experimentalPassiveSpaceCandidate(
  rawInput: string,
  update: CandidateUpdate,
  context: TypingContext,
  trustedPolicyId: string | undefined
): Candidate | undefined {
  if (trustedPolicyId !== EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID) return undefined;
  if (update.mode !== "romanized" && update.mode !== "romanized-traditional") return undefined;
  if (!/^[a-z]+$/.test(rawInput) || [...rawInput].length < passiveCommitPolicy.minimumInputCodePoints) return undefined;

  const entry = AUTHORIZED_ENTRIES.get(rawInput);
  const primary = update.primary;
  if (!entry || !primary || primary.type !== "word" || primary.text !== entry.output ||
      primary.confidence < passiveCommitPolicy.minimumConfidence ||
      !primary.replaceRange || primary.replaceRange[0] !== 0 || primary.replaceRange[1] !== rawInput.length ||
      /\s/u.test(primary.text) || /[A-Za-z]/.test(primary.text) ||
      !primary.reason.some((reason) =>
        reason === `Shared ${tokenCandidatePack.id} deterministic token candidate`
      )) {
    return undefined;
  }

  const sourceRow = tokenCandidatePack.rows.find((row) => row.input === rawInput);
  if (!sourceRow || sourceRow.outputs.length !== 1 ||
      sourceRow.outputs[0]?.text !== entry.output ||
      (sourceRow.outputs[0]?.confidence ?? 0) < passiveCommitPolicy.minimumConfidence) {
    return undefined;
  }
  return primary;
}

export function validateExperimentalPassiveCommitPolicy(): string[] {
  return validateExperimentalPassiveCommitPolicyValue(passiveCommitPolicy, tokenCandidatePack);
}

export function validateExperimentalPassiveCommitPolicyValue(
  policyValue: unknown,
  sourcePackValue: unknown
): string[] {
  const errors: string[] = [];
  if (!isRecord(policyValue) || !isRecord(sourcePackValue)) {
    return ["Experimental passive-commit policy and source pack must be objects."];
  }
  const policy = policyValue;
  const sourcePack = sourcePackValue;
  if (!hasExactKeys(policy, [
    "schemaVersion", "recordType", "id", "sourceContract", "productionEligible", "activation",
    "policy", "notes", "normalization", "delimiter", "minimumConfidence", "minimumInputCodePoints",
    "evidenceRequirements", "entries"
  ])) {
    errors.push("Experimental passive-commit policy fields are not closed.");
  }
  const sourceContract = isRecord(policy.sourceContract) ? policy.sourceContract : undefined;
  let canonicalSourceDigest: string | undefined;
  try {
    canonicalSourceDigest = sha256Hex(JSON.stringify(sourcePack));
  } catch {
    // A non-JSON/cyclic value cannot be a source contract.
  }
  if (policy.schemaVersion !== 1 ||
      policy.recordType !== "lekh-experimental-passive-commit-policy" ||
      policy.id !== EXPERIMENTAL_PASSIVE_COMMIT_POLICY_ID ||
      policy.activation !== "opaque-test-build-capability-only" ||
      policy.policy !== "exact-single-output-repository-contract" ||
      typeof policy.notes !== "string" || [...policy.notes].length < 1 || [...policy.notes].length > 1024 ||
      policy.normalization !== "NFC-lowercase-ascii-input" ||
      policy.delimiter !== " " ||
      !sourceContract || !hasExactKeys(sourceContract, ["id", "path", "sha256", "canonicalJsonSha256"]) ||
      sourceContract.id !== sourcePack.id ||
      sourceContract.path !== "data/engine/lekh-token-candidates.v1.json" ||
      typeof sourceContract.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceContract.sha256) ||
      sourceContract.canonicalJsonSha256 !== canonicalSourceDigest) {
    errors.push("Experimental passive-commit policy identity or source binding is invalid.");
  }
  if (policy.productionEligible !== false) {
    errors.push("Experimental passive-commit policy must not claim production eligibility.");
  }
  const minimumConfidence = policy.minimumConfidence;
  const minimumInputCodePoints = policy.minimumInputCodePoints;
  if (typeof minimumConfidence !== "number" || !Number.isFinite(minimumConfidence) ||
      minimumConfidence < 0 || minimumConfidence > 1 ||
      typeof minimumInputCodePoints !== "number" || !Number.isSafeInteger(minimumInputCodePoints) ||
      minimumInputCodePoints < 4 || minimumInputCodePoints > 64) {
    errors.push("Experimental passive-commit thresholds are invalid.");
  }
  const requirements = isRecord(policy.evidenceRequirements) ? policy.evidenceRequirements : undefined;
  if (!requirements || !hasExactKeys(requirements, [
    "humanRatedSamplesPerEntry", "maximumAmbiguityRate", "maximumUndoRate", "requiredNegativeCorpora"
  ]) || typeof requirements.humanRatedSamplesPerEntry !== "number" ||
      !Number.isSafeInteger(requirements.humanRatedSamplesPerEntry) || requirements.humanRatedSamplesPerEntry < 1 ||
      !isUnitInterval(requirements.maximumAmbiguityRate) || !isUnitInterval(requirements.maximumUndoRate) ||
      !Array.isArray(requirements.requiredNegativeCorpora) ||
      requirements.requiredNegativeCorpora.join("\u0000") !== ["english", "names", "mixed-language"].join("\u0000")) {
    errors.push("Experimental passive-commit evidence requirements are invalid.");
  }
  const entries = Array.isArray(policy.entries) ? policy.entries : [];
  if (entries.length < 1 || entries.length > 256) {
    errors.push("Experimental passive-commit entries must contain 1...256 rows.");
  }
  const seenInputs = new Set<string>();
  const sourceRows = Array.isArray(sourcePack.rows) ? sourcePack.rows : [];
  for (const [index, entryValue] of entries.entries()) {
    if (!isRecord(entryValue) || !hasExactKeys(entryValue, ["input", "output", "evidence"])) {
      errors.push(`Experimental passive-commit entry ${index} fields are invalid.`);
      continue;
    }
    const entry = entryValue;
    if (typeof entry.input !== "string" || typeof entry.output !== "string" ||
        !/^[a-z]+$/.test(entry.input) || [...entry.input].length < (typeof minimumInputCodePoints === "number" ? minimumInputCodePoints : 4) ||
        [...entry.input].length > 64 || [...entry.output].length < 1 || [...entry.output].length > 128 ||
        entry.input.normalize("NFC") !== entry.input || !entry.output || entry.output.normalize("NFC") !== entry.output ||
        /\s/u.test(entry.output) || /[A-Za-z]/.test(entry.output) || !/[\u0900-\u097f]/u.test(entry.output) ||
        QUARANTINED_AMBIGUOUS_INPUTS.has(entry.input)) {
      errors.push(`Invalid experimental passive-commit entry: ${entry.input}.`);
      continue;
    }
    if (seenInputs.has(entry.input)) errors.push(`Experimental passive-commit input duplicates ${entry.input}.`);
    seenInputs.add(entry.input);
    const evidence = isRecord(entry.evidence) ? entry.evidence : undefined;
    if (!evidence || !hasExactKeys(evidence, [
      "provenance", "humanRatedSamples", "observedAmbiguityRate", "observedUndoRate"
    ]) || evidence.provenance !== "repository-curated-contract" || evidence.humanRatedSamples !== 0 ||
        evidence.observedAmbiguityRate !== null || evidence.observedUndoRate !== null) {
      errors.push(`Experimental passive-commit entry overclaims evidence: ${entry.input}.`);
    }
    const matchingRows = sourceRows.filter((row) => isRecord(row) && row.input === entry.input);
    const sourceRow = matchingRows[0];
    const outputs = sourceRow && Array.isArray(sourceRow.outputs) ? sourceRow.outputs : [];
    const output = outputs[0];
    if (matchingRows.length !== 1 || outputs.length !== 1 || !isRecord(output) || output.text !== entry.output ||
        typeof output.confidence !== "number" || typeof minimumConfidence !== "number" ||
        output.confidence < minimumConfidence) {
      errors.push(`Experimental passive-commit entry is not an exact unique high-confidence source row: ${entry.input}.`);
    }
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === expected.slice().sort().join("\u0000");
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
