import { createHash } from "node:crypto";

const categoryPriority = Object.freeze([
  "name",
  "chat-convention",
  "ambiguity",
  "adversarial-safety",
  "protected-token",
  "non-nepali-pass-through",
  "romanized-token"
]);
const sourceTierPriority = Object.freeze([
  "gold",
  "safety-negative",
  "contract-seed",
  "licensed-public",
  "runtime-derived",
  "dictionary-derived"
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableChoice(values, priority) {
  const rank = new Map(priority.map((value, index) => [value, index]));
  return [...values].sort((left, right) =>
    (rank.get(left) ?? priority.length) - (rank.get(right) ?? priority.length) ||
    left.localeCompare(right)
  )[0];
}

function mergedReviewTier(values) {
  const tiers = new Set(values);
  if (tiers.has("adjudicated-gold") || tiers.has("adjudicated-review") ||
      tiers.has("native-speaker-reviewed")) return "adjudicated-review";
  if (tiers.has("dual-reviewed")) return "dual-reviewed";
  if (tiers.has("linguist-reviewed")) return "linguist-reviewed";
  if (tiers.has("gold")) return "gold";
  if (tiers.has("curated-public-corroborated") ||
      (tiers.has("curated-public-aksharantar") && tiers.has("silver-public-transliteration"))) {
    return "curated-public-corroborated";
  }
  if (tiers.has("curated-public-aksharantar")) return "curated-public-aksharantar";
  return [...tiers].sort().join("+") || "unknown";
}

export function createNeuralOpenVocabAccumulator(candidate) {
  return {
    schemaVersion: 1,
    split: candidate.split,
    action: candidate.action,
    input: candidate.input,
    target: candidate.target,
    acceptable: new Set(candidate.acceptable),
    categories: new Set([candidate.category]),
    sourceIds: new Set(candidate.sourceIds),
    sourceTiers: new Set([candidate.sourceTier]),
    reviewTiers: new Set([candidate.reviewTier]),
    licenses: new Set([candidate.license]),
    maximumWeight: Number(candidate.weight),
    duplicateCount: 0
  };
}

export function mergeNeuralOpenVocabAccumulator(accumulator, candidate) {
  if (accumulator.split !== candidate.split || accumulator.action !== candidate.action ||
      accumulator.input !== candidate.input || accumulator.target !== candidate.target) {
    throw new TypeError("Cannot merge different neural open-vocabulary examples.");
  }
  for (const value of candidate.acceptable) accumulator.acceptable.add(value);
  accumulator.categories.add(candidate.category);
  for (const value of candidate.sourceIds) accumulator.sourceIds.add(value);
  accumulator.sourceTiers.add(candidate.sourceTier);
  accumulator.reviewTiers.add(candidate.reviewTier);
  accumulator.licenses.add(candidate.license);
  accumulator.maximumWeight = Math.max(accumulator.maximumWeight, Number(candidate.weight));
  accumulator.duplicateCount += 1;
  return accumulator;
}

export function finalizeNeuralOpenVocabAccumulator(accumulator) {
  const identity = [
    accumulator.action,
    accumulator.input,
    accumulator.target ?? "<NO_NEURAL_CANDIDATE>"
  ].join("\u0000");
  const record = {
    schemaVersion: 1,
    id: `neural_open_vocab_${sha256(identity).slice(0, 16)}`,
    split: accumulator.split,
    action: accumulator.action,
    input: accumulator.input,
    target: accumulator.target,
    acceptable: [...accumulator.acceptable].sort(),
    category: stableChoice(accumulator.categories, categoryPriority),
    sourceIds: [...accumulator.sourceIds].sort(),
    sourceTier: stableChoice(accumulator.sourceTiers, sourceTierPriority),
    reviewTier: mergedReviewTier(accumulator.reviewTiers),
    license: [...accumulator.licenses].sort().join(" AND "),
    weight: Math.min(12, Number((accumulator.maximumWeight + (0.15 * accumulator.duplicateCount)).toFixed(6)))
  };
  return Object.freeze({ ...record, rowHash: sha256(JSON.stringify(record)) });
}

export function validateNeuralOpenVocabRecord(record) {
  const issues = [];
  const identity = [record.action, record.input, record.target ?? "<NO_NEURAL_CANDIDATE>"].join("\u0000");
  if (record.id !== `neural_open_vocab_${sha256(identity).slice(0, 16)}`) {
    issues.push("neural-open-vocab-record.id-invalid");
  }
  const { rowHash, ...content } = record;
  if (rowHash !== sha256(JSON.stringify(content))) {
    issues.push("neural-open-vocab-record.row-hash-invalid");
  }
  return Object.freeze({ valid: issues.length === 0, issueCodes: Object.freeze(issues) });
}
