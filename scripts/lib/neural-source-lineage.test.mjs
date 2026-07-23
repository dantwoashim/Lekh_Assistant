import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LeakageSafeSplitPlanner,
  novelSourceIdsForLineages,
  selectAksharantarRows
} from "./neural-source-lineage.mjs";

describe("neural source lineage", () => {
  it("admits official Aksharantar and blocks its mirrors from production training", () => {
    const registry = JSON.parse(readFileSync(join(process.cwd(), "data/neural/sources.v1.json"), "utf8"));
    const sources = new Map(registry.sources.map((source) => [source.id, source]));
    const official = sources.get("ai4bharat-aksharantar-nepali");
    const mirrors = [
      sources.get("syubraj-roman2nepali-transliteration"),
      sources.get("saugatkafley-nepali-roman-transliteration")
    ];

    expect(registry.productionRequiredSources).toContain(official.id);
    expect(official.productionRequired).toBe(true);
    expect(official.allowedForOpenVocabTokenTraining).toBe(true);
    for (const mirror of mirrors) {
      expect(registry.productionRequiredSources).not.toContain(mirror.id);
      expect(mirror.status).toBe("blocked");
      expect(mirror.allowedForOpenVocabTokenTraining).toBe(false);
      expect(mirror.lineageId).toBe(official.lineageId);
      expect(mirror.canonicalTrainingSource).toBe(official.id);
    }
  });

  it("keeps all official held-out rows when a deterministic train cap is applied", () => {
    const rows = [
      row("train-c", "train"),
      row("test-a", "test"),
      row("train-a", "train"),
      row("dev-a", "validation"),
      row("train-b", "train")
    ];
    const forward = selectAksharantarRows(rows, 2);
    const reversed = selectAksharantarRows([...rows].reverse(), 2);

    expect(forward.heldOut.map(({ input }) => input).sort()).toEqual(["dev-a", "test-a"]);
    expect(forward.selectedTrain.map(({ input }) => input).sort()).toEqual(
      reversed.selectedTrain.map(({ input }) => input).sort()
    );
    expect(forward.availableTrainRows).toBe(3);
    expect(forward.omittedTrainRows).toBe(1);
  });

  it("consumes the full official snapshot by default", () => {
    const rows = [row("train-a", "train"), row("dev-a", "validation"), row("test-a", "test")];
    const selection = selectAksharantarRows(rows);
    expect(selection.selectedRows).toHaveLength(rows.length);
    expect(selection.omittedTrainRows).toBe(0);
  });

  it("rejects unknown official split labels instead of silently treating them as train", () => {
    expect(() => selectAksharantarRows([row("unknown-a", "holdout")]))
      .toThrow("Unsupported Aksharantar upstream split: holdout");
  });

  it("lets held-out input or target assignments override train regardless of load order", () => {
    const stableTrain = () => "train";
    const trainFirst = new LeakageSafeSplitPlanner(stableTrain);
    trainFirst.add("alias-a", "साझा", "train");
    trainFirst.add("alias-b", "साझा", "test");

    const testFirst = new LeakageSafeSplitPlanner(stableTrain);
    testFirst.add("alias-b", "साझा", "test");
    testFirst.add("alias-a", "साझा", "train");

    expect(trainFirst.splitFor("alias-a")).toBe("test");
    expect(trainFirst.splitFor("alias-b")).toBe("test");
    expect(testFirst.splitFor("alias-a")).toBe("test");
    expect(testFirst.splitFor("alias-b")).toBe("test");
  });

  it("does not treat an identical mirror-lineage row as independent corroboration", () => {
    const sources = new Map([
      ["ai4bharat-aksharantar-nepali", { lineageId: "aksharantar-nepali-public-lineage" }],
      ["syubraj-roman2nepali-transliteration", { lineageId: "aksharantar-nepali-public-lineage" }],
      ["human-reviewed-lekh-gold-v1", { lineageId: "human-reviewed-lekh-gold-v1" }]
    ]);
    expect(novelSourceIdsForLineages(
      ["ai4bharat-aksharantar-nepali"],
      ["syubraj-roman2nepali-transliteration"],
      sources
    )).toEqual([]);
    expect(novelSourceIdsForLineages(
      ["ai4bharat-aksharantar-nepali"],
      ["syubraj-roman2nepali-transliteration", "human-reviewed-lekh-gold-v1"],
      sources
    )).toEqual(["human-reviewed-lekh-gold-v1"]);
  });
});

function row(input, upstreamSplit) {
  return { input, target: `देवनागरी-${input}`, upstreamSplit, upstreamId: input, upstreamSource: "fixture" };
}
