import { describe, expect, it } from "vitest";
import {
  createNeuralOpenVocabAccumulator,
  finalizeNeuralOpenVocabAccumulator,
  mergeNeuralOpenVocabAccumulator,
  validateNeuralOpenVocabRecord
} from "./neural-open-vocab-record.mjs";

describe("neural open-vocabulary record identity", () => {
  it("is invariant to duplicate-source merge order", () => {
    const candidates = [
      candidate({ sourceIds: ["silver"], weight: 1, sourceTier: "licensed-public", reviewTier: "silver-public-transliteration" }),
      candidate({ sourceIds: ["gold"], weight: 10, sourceTier: "gold", reviewTier: "native-speaker-reviewed", category: "name" }),
      candidate({ sourceIds: ["dictionary"], weight: 2, sourceTier: "dictionary-derived", reviewTier: "silver-dictionary-derived" })
    ];
    const left = merged(candidates);
    const right = merged([...candidates].reverse());
    expect(left).toEqual(right);
    expect(left.sourceIds).toEqual(["dictionary", "gold", "silver"]);
    expect(left.category).toBe("name");
    expect(left.sourceTier).toBe("gold");
    expect(left.reviewTier).toBe("adjudicated-review");
    expect(validateNeuralOpenVocabRecord(left).issueCodes).toEqual([]);
  });

  it("keeps example identity stable while the full record digest detects metadata drift", () => {
    const first = merged([candidate({ sourceIds: ["one"] })]);
    const second = merged([candidate({ sourceIds: ["two"] })]);
    expect(first.id).toBe(second.id);
    expect(first.rowHash).not.toBe(second.rowHash);
    expect(validateNeuralOpenVocabRecord({ ...first, weight: 99 }).issueCodes)
      .toContain("neural-open-vocab-record.row-hash-invalid");
  });
});

function merged(candidates) {
  const accumulator = createNeuralOpenVocabAccumulator(candidates[0]);
  for (const item of candidates.slice(1)) mergeNeuralOpenVocabAccumulator(accumulator, item);
  return finalizeNeuralOpenVocabAccumulator(accumulator);
}

function candidate(overrides = {}) {
  return {
    split: "train",
    action: "produce-candidate",
    input: "niraj",
    target: "निरज",
    acceptable: ["निरज"],
    category: "romanized-token",
    sourceIds: ["base"],
    sourceTier: "runtime-derived",
    reviewTier: "silver-runtime-derived",
    license: "project-owned",
    weight: 1,
    ...overrides
  };
}
