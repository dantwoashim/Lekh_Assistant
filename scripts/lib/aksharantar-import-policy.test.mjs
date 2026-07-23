import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  AKSHARANTAR_IMPORT_CONTENT_IDENTITY,
  AksharantarCanonicalPairTracker,
  aksharantarSplitPriority,
  createDeterministicAksharantarImportManifest,
  orderAksharantarMembersByHeldOutPrecedence
} from "./aksharantar-import-policy.mjs";

describe("Aksharantar import policy", () => {
  it("orders official members with test ahead of validation and train", () => {
    const members = orderAksharantarMembersByHeldOutPrecedence([
      { split: "train", member: "train.json" },
      { split: "test", member: "test.json" },
      { split: "validation", member: "validation.json" }
    ]);

    expect(members.map(({ split }) => split)).toEqual(["test", "validation", "train"]);
    expect(members.map(({ split }) => aksharantarSplitPriority(split))).toEqual([3, 2, 1]);
  });

  it("keeps the test observation when the same pair also occurs in validation", () => {
    const tracker = new AksharantarCanonicalPairTracker();

    expect(tracker.observe("anup", "अनुप", "test")).toBe(true);
    expect(tracker.observe("anup", "अनुप", "validation")).toBe(false);
    expect(tracker.observe("anup", "अनुप", "train")).toBe(false);
  });

  it("rejects a lower-priority-first traversal that could hide held-out observations", () => {
    const tracker = new AksharantarCanonicalPairTracker();
    expect(tracker.observe("anup", "अनुप", "train")).toBe(true);
    expect(() => tracker.observe("anup", "अनुप", "test"))
      .toThrow("test > validation > train precedence order");
  });

  it("rejects unknown upstream split labels", () => {
    expect(() => orderAksharantarMembersByHeldOutPrecedence([{ split: "dev", member: "dev.json" }]))
      .toThrow("Unsupported Aksharantar split: dev");
  });

  it("builds a timestamp-free manifest with stable policy and content identity", () => {
    const input = {
      sourceId: "ai4bharat-aksharantar-nepali",
      upstream: { repository: "fixture", rawDataCommitted: false },
      files: [{ upstreamPath: "fixture.zip", bytes: 42, sha256: "a".repeat(64) }],
      output: { tsv: "fixture.tsv", sha256: "b".repeat(64) },
      counts: { rawRows: 3, importedRows: 2, duplicatePairs: 1 },
      rejected: {},
      maxRows: null,
      failures: [],
      warnings: []
    };

    const first = createDeterministicAksharantarImportManifest(input);
    const second = createDeterministicAksharantarImportManifest(structuredClone(input));
    const firstJson = JSON.stringify(first);
    const secondJson = JSON.stringify(second);

    expect(first.contentIdentity).toBe(AKSHARANTAR_IMPORT_CONTENT_IDENTITY);
    expect(first.policy.duplicatePairResolution).toBe("test-over-validation-over-train");
    expect(first).not.toHaveProperty("importedAt");
    expect(first).not.toHaveProperty("generatedAt");
    expect(secondJson).toBe(firstJson);
    expect(sha256(secondJson)).toBe(sha256(firstJson));
  });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
