import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  buildCompletionArtifact,
  readJson,
  serializeJson,
  validateArtifactShape
} from "./token-completion-lib.mjs";

const root = process.cwd();
const seeds = readJson(join(root, "data/completion/v1/token-completion-seeds.json"));
const registry = readJson(join(root, "data/completion/v1/source-registry.json"));
const evaluation = readJson(join(root, "data/completion/v1/eval-regression.json"));

describe("token completion pipeline", () => {
  it("builds a deterministic, provenance-complete, single-token artifact", () => {
    const first = buildCompletionArtifact({ seeds, registry, evaluation });
    const second = buildCompletionArtifact({ seeds, registry, evaluation });
    expect(first.failures).toEqual([]);
    expect(validateArtifactShape(first.artifact)).toEqual([]);
    expect(serializeJson(first.artifact)).toBe(serializeJson(second.artifact));
    expect(first.evaluation.positiveTop1Accuracy).toBe(1);
    expect(first.evaluation.negativeSuppressionRate).toBe(1);
    expect(first.artifact.entries.every((entry) =>
      entry.candidates.every((candidate) =>
        !candidate.source.includes(" ") &&
        !candidate.target.includes(" ") &&
        candidate.seedId && candidate.sourceId && candidate.license && candidate.reviewTier
      )
    )).toBe(true);
  });

  it("rejects phrases, names, missing provenance and ambiguous winners", () => {
    const badSeeds = structuredClone(seeds);
    badSeeds.rows.push({
      id: "bad-phrase",
      source: "janma miti",
      target: "जन्म मिति",
      prefixes: ["janma"],
      rankScore: 900,
      kind: "phrase"
    });
    badSeeds.rows.push({
      id: "bad-name",
      source: "niraaj",
      target: "निराज",
      prefixes: ["nira"],
      rankScore: 900,
      kind: "name"
    });
    badSeeds.rows.push({
      id: "bad-ambiguous-winner",
      source: "lekhana",
      target: "लेखन",
      prefixes: ["lekh"],
      rankScore: 995,
      kind: "word"
    });
    const badRegistry = structuredClone(registry);
    badRegistry.sources[0].runtimeEligible = false;
    const result = buildCompletionArtifact({ seeds: badSeeds, registry: badRegistry, evaluation });
    expect(result.failures.some((failure) => failure.includes("not runtime eligible"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("kind must be word"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("Roman token"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("Devanagari-only token"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("insufficient deterministic winner margin"))).toBe(true);

    const missingProvenanceRegistry = structuredClone(registry);
    missingProvenanceRegistry.sources[0].license = "";
    const missingProvenance = buildCompletionArtifact({
      seeds,
      registry: missingProvenanceRegistry,
      evaluation
    });
    expect(missingProvenance.failures.some((failure) => failure.includes("license or review tier"))).toBe(true);
  });

  it("keeps protected, name-like, phrase and sensitive prefixes absent", () => {
    const { artifact, failures } = buildCompletionArtifact({ seeds, registry, evaluation });
    expect(failures).toEqual([]);
    const prefixes = new Set(artifact.entries.map((entry) => entry.prefix));
    for (const blocked of ["openai", "github", "prab", "nira", "janma miti", "a@b.com", "9800000000"]) {
      expect(prefixes.has(blocked)).toBe(false);
    }
  });
});
