import { describe, expect, it } from "vitest";
import {
  InMemoryCorrectionMemoryStore,
  correctionMemoryCandidates,
  emptyMemorySnapshot,
  exportCorrectionMemory,
  importCorrectionMemory,
  migrateLegacyCorrections
} from "./index";

describe("correction memory migration", () => {
  it("migrates legacy local correction entries into schema v2", () => {
    const snapshot = migrateLegacyCorrections([
      {
        input: "niraj",
        normalizedInput: "niraj",
        output: "नीरज",
        normalizedOutput: "नीरज",
        count: 2,
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ], "2026-05-26T01:00:00.000Z");

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.migratedFrom).toContain("lekh-keyboard:romanized-corrections:v1");
    expect(snapshot.entries[0]).toMatchObject({
      inputRomanized: "niraj",
      chosenOutput: "नीरज",
      frequency: 2,
      source: "user-accept"
    });
  });

  it("merges duplicate imports and round-trips export/import", () => {
    const snapshot = migrateLegacyCorrections([
      {
        input: "lakshmi",
        normalizedInput: "lakshmi",
        output: "लक्ष्मी",
        normalizedOutput: "लक्ष्मी",
        count: 1,
        updatedAt: "2026-05-26T00:00:00.000Z"
      },
      {
        input: "lakshmi",
        normalizedInput: "lakshmi",
        output: "लक्ष्मी",
        normalizedOutput: "लक्ष्मी",
        count: 3,
        updatedAt: "2026-05-26T02:00:00.000Z"
      }
    ]);
    const imported = importCorrectionMemory(exportCorrectionMemory(snapshot));

    expect(imported.entries).toHaveLength(1);
    expect(imported.entries[0].frequency).toBe(4);
  });

  it("privacy-projects imported context and canonicalizes scoring bounds", () => {
    const privateLeft = "private sentence before the correction";
    const privateRight = "private sentence after the correction";
    const imported = importCorrectionMemory(JSON.stringify({
      schemaVersion: 2,
      entries: [{
        id: "",
        inputRomanized: "prabin",
        normalizedInput: "prabin",
        chosenOutput: "प्रवीण",
        normalizedOutput: "प्रवीण",
        rejectedAlternatives: [],
        context: { leftWindow: privateLeft, rightWindow: privateRight, domain: "HEALTH" },
        source: "import",
        frequency: 1.9,
        confidenceAtSelection: 4,
        timestamps: {
          firstSeen: "2026-05-26T00:00:00.000Z",
          lastUsed: "2026-05-26T00:00:00.000Z"
        },
        decayWeight: 9
      }]
    }));

    expect(imported.entries[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^memory-[a-f0-9]{40}$/),
      context: { leftWindow: "", rightWindow: "", domain: "health" },
      frequency: 1,
      confidenceAtSelection: 1,
      decayWeight: 2
    }));
    expect(JSON.stringify(imported)).not.toContain(privateLeft);
    expect(JSON.stringify(imported)).not.toContain(privateRight);
  });

  it("scores exact memory only in matching, unprotected contexts", () => {
    const snapshot = migrateLegacyCorrections([
      {
        input: "niraj",
        normalizedInput: "niraj",
        output: "नीरज",
        normalizedOutput: "नीरज",
        count: 3,
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    ]);

    expect(correctionMemoryCandidates(snapshot.entries, { input: "niraj" })[0].normalizedText).toBe("नीरज");
    expect(correctionMemoryCandidates(snapshot.entries, { input: "niraj", protectedOriginals: ["niraj"] })).toHaveLength(0);
    expect(correctionMemoryCandidates(snapshot.entries, { input: "nirajan" })).toHaveLength(0);
  });

  it("supports a pure storage adapter without DOM access", async () => {
    const store = new InMemoryCorrectionMemoryStore();
    const snapshot = migrateLegacyCorrections([{
      input: "niraj",
      normalizedInput: "niraj",
      output: "नीरज",
      normalizedOutput: "नीरज",
      count: 1,
      updatedAt: "2026-05-26T00:00:00.000Z"
    }]);
    snapshot.entries[0]!.context = {
      leftWindow: "private in-memory left context",
      rightWindow: "private in-memory right context",
      domain: "HEALTH"
    };
    await store.save(snapshot);
    const loaded = await store.load();
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.entries[0]?.context).toEqual({ leftWindow: "", rightWindow: "", domain: "health" });
    expect(exportCorrectionMemory(snapshot)).not.toContain("private in-memory");
    await store.reset();
    expect(await store.load()).toEqual(emptyMemorySnapshot());
  });
});
