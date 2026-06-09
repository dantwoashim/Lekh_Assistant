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
    await store.save(migrateLegacyCorrections([]));
    expect((await store.load()).schemaVersion).toBe(2);
    await store.reset();
    expect(await store.load()).toEqual(emptyMemorySnapshot());
  });
});
