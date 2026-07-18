import { describe, expect, it } from "vitest";
import {
  InMemoryCorrectionMemoryStore,
  canonicalCorrectionMemoryId,
  canonicalIsoTimestamp,
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
      id: canonicalCorrectionMemoryId("niraj", "नीरज"),
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
      id: expect.stringMatching(/^kbd-memory-[a-f0-9]{40}$/),
      context: { leftWindow: "", rightWindow: "", domain: "health" },
      frequency: 1,
      confidenceAtSelection: 1,
      decayWeight: 2
    }));
    expect(JSON.stringify(imported)).not.toContain(privateLeft);
    expect(JSON.stringify(imported)).not.toContain(privateRight);
  });

  it("derives import identity from canonical semantics and merges duplicate aliases", () => {
    const imported = importCorrectionMemory(JSON.stringify({
      schemaVersion: 2,
      entries: [
        correctionImportEntry({
          id: "attacker-shared-id",
          inputRomanized: "ＰＲＡＢＩＮ",
          normalizedInput: "forged-input",
          frequency: 2,
          timestamps: {
            firstSeen: "2026-05-26T05:45:00+05:45",
            lastUsed: "2026-05-26T06:45:00+05:45"
          }
        }),
        correctionImportEntry({
          id: "attacker-different-id",
          inputRomanized: "prabin",
          frequency: 9,
          pinned: true,
          timestamps: {
            firstSeen: "2026-05-25T00:00:00.000Z",
            lastUsed: "2026-05-26T01:00:00.000Z"
          }
        }),
        correctionImportEntry({
          id: "attacker-shared-id",
          inputRomanized: "niraj",
          normalizedInput: "niraj",
          chosenOutput: "नीरज",
          normalizedOutput: "नीरज"
        })
      ]
    }));

    expect(imported.entries).toHaveLength(2);
    const prabin = imported.entries.find((entry) => entry.normalizedInput === "prabin");
    const niraj = imported.entries.find((entry) => entry.normalizedInput === "niraj");
    expect(prabin).toEqual(expect.objectContaining({
      id: canonicalCorrectionMemoryId("prabin", "प्रवीण"),
      frequency: 9,
      pinned: true,
      timestamps: {
        firstSeen: "2026-05-25T00:00:00.000Z",
        lastUsed: "2026-05-26T01:00:00.000Z"
      }
    }));
    expect(niraj?.id).toBe(canonicalCorrectionMemoryId("niraj", "नीरज"));
    expect(niraj?.id).not.toBe(prabin?.id);
    expect(imported.entries.map((entry) => entry.id)).not.toContain("attacker-shared-id");
  });

  it("rejects malformed UTF-16 and invalid or reversed imported timestamps", () => {
    const invalidEntries = [
      correctionImportEntry({ chosenOutput: "broken-\ud800" }),
      correctionImportEntry({ normalizedOutput: "broken-\udc00" }),
      correctionImportEntry({ rejectedAlternatives: ["broken-\ud800"] }),
      correctionImportEntry({ context: { leftWindow: "broken-\ud800", rightWindow: "" } }),
      correctionImportEntry({ context: { leftWindow: "x".repeat(16_385), rightWindow: "" } })
    ];
    for (const entry of invalidEntries) {
      expect(() => importCorrectionMemory(JSON.stringify({ schemaVersion: 2, entries: [entry] }))).toThrow();
    }

    for (const timestamps of [
      { firstSeen: "not-a-date", lastUsed: "2026-05-26T00:00:00.000Z" },
      { firstSeen: "2026-02-30T00:00:00.000Z", lastUsed: "2026-03-01T00:00:00.000Z" },
      { firstSeen: "2026-05-27T00:00:00.000Z", lastUsed: "2026-05-26T00:00:00.000Z" }
    ]) {
      expect(() => importCorrectionMemory(JSON.stringify({
        schemaVersion: 2,
        entries: [correctionImportEntry({ timestamps })]
      }))).toThrow();
    }
    const missingTimestamps = correctionImportEntry();
    delete (missingTimestamps as { timestamps?: unknown }).timestamps;
    expect(() => importCorrectionMemory(JSON.stringify({
      schemaVersion: 2,
      entries: [missingTimestamps]
    }))).toThrow(/timestamps/);
  });

  it("canonicalizes valid ISO offsets and rejects offsets beyond the ISO bound", () => {
    expect(canonicalIsoTimestamp("2026-05-26T00:00:00Z", "test")).toBe("2026-05-26T00:00:00.000Z");
    expect(canonicalIsoTimestamp("2026-05-26T05:45:00+05:45", "test")).toBe("2026-05-26T00:00:00.000Z");
    expect(canonicalIsoTimestamp("2026-05-26T14:00:00+14:00", "test")).toBe("2026-05-26T00:00:00.000Z");
    expect(() => canonicalIsoTimestamp("2026-05-26T14:01:00+14:01", "test")).toThrow(/valid ISO/);
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

function correctionImportEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "supplied-id",
    inputRomanized: "prabin",
    normalizedInput: "prabin",
    chosenOutput: "प्रवीण",
    normalizedOutput: "प्रवीण",
    rejectedAlternatives: [],
    context: { leftWindow: "", rightWindow: "" },
    source: "import",
    frequency: 1,
    confidenceAtSelection: 0.8,
    timestamps: {
      firstSeen: "2026-05-26T00:00:00.000Z",
      lastUsed: "2026-05-26T00:00:00.000Z"
    },
    ...overrides
  };
}
