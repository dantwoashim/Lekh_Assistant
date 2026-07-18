import { describe, expect, it } from "vitest";
import {
  InMemoryKeyboardCorrectionMemoryStore,
  InMemoryKeyboardSettingsStore,
  InMemoryPersonalDictionaryStore,
  defaultKeyboardSettings
} from "./storage";
import { defaultTypingContext } from "./modes";
import { keyboardMemoryCandidates } from "./memory";
import { canonicalCorrectionMemoryId } from "../memory/importNormalization";
import type { CorrectionMemoryEntry } from "../memory/types";

describe("keyboard native storage contracts", () => {
  it("keeps telemetry disabled in settings patches", async () => {
    const store = new InMemoryKeyboardSettingsStore(defaultKeyboardSettings());
    await store.updateSettings({ showRomanizedLabels: true, telemetryEnabled: true as false });
    const settings = await store.getSettings();
    expect(settings.showRomanizedLabels).toBe(true);
    expect(settings.telemetryEnabled).toBe(false);
  });

  it("exports and imports personal dictionary entries", async () => {
    const store = new InMemoryPersonalDictionaryStore();
    await store.addWord({
      id: "personal_1",
      word: "स्वास्थ्य",
      romanized: ["swasthya"],
      domains: ["health"],
      source: "user",
      createdAt: "2026-05-27T00:00:00.000Z",
      updatedAt: "2026-05-27T00:00:00.000Z",
      schemaVersion: 1
    });

    expect(await store.lookup("swas")).toEqual([
      expect.objectContaining({ word: "स्वास्थ्य", source: "personal:user" })
    ]);

    const imported = new InMemoryPersonalDictionaryStore();
    await imported.import(await store.export());
    expect(await imported.lookup("स्वा")).toEqual([
      expect.objectContaining({ word: "स्वास्थ्य" })
    ]);
  });

  it("does not return correction memory in secure contexts", async () => {
    const store = new InMemoryKeyboardCorrectionMemoryStore();
    const entry: CorrectionMemoryEntry = {
      id: "mem_1",
      normalizedInput: "prabin",
      chosenOutput: "प्रबिन",
      normalizedOutput: "प्रबिन",
      rejectedAlternatives: [],
      context: { leftWindow: "", rightWindow: "" },
      source: "user-accept",
      frequency: 1,
      confidenceAtSelection: 0.9,
      timestamps: {
        firstSeen: "2026-05-27T00:00:00.000Z",
        lastUsed: "2026-05-27T00:00:00.000Z"
      }
    };
    await store.record(entry);

    expect(await store.query("pra", defaultTypingContext("romanized"))).toHaveLength(1);
    expect(await store.query("pra", { ...defaultTypingContext("romanized"), secureInput: true })).toHaveLength(0);
    expect(await store.query("pra", { ...defaultTypingContext("romanized"), fieldType: "unknown" })).toHaveLength(0);
  });

  it("forgets correction memory entries by input and optional output", async () => {
    const store = new InMemoryKeyboardCorrectionMemoryStore();
    await store.record(memoryEntry("mem_1", "niraj", "निरज"));
    await store.record(memoryEntry("mem_2", "niraj", "नीरज"));

    await store.forget("niraj", "निरज");
    expect(await store.query("niraj", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ chosenOutput: "नीरज" })
    ]);

    await store.forget("niraj");
    expect(await store.query("niraj", defaultTypingContext("romanized"))).toHaveLength(0);
  });

  it("canonicalizes and deduplicates in-memory correction imports", async () => {
    const store = new InMemoryKeyboardCorrectionMemoryStore();
    const first = {
      ...memoryEntry("attacker-id", "prabin", "प्रवीण"),
      inputRomanized: "prabin",
      frequency: 2
    };
    await store.import({
      schemaVersion: 1,
      entries: [first, { ...first, id: "other-id", frequency: 8 }]
    });
    expect(await store.query("prabin", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({
        id: canonicalCorrectionMemoryId("prabin", "प्रवीण"),
        frequency: 8
      })
    ]);

    await expect(store.import({
      schemaVersion: 1,
      entries: [{ ...first, timestamps: { firstSeen: "invalid", lastUsed: "invalid" } }]
    })).rejects.toThrow(/ISO 8601/);
    expect(await store.query("prabin", defaultTypingContext("romanized"))).toHaveLength(1);
  });

  it("scores personal memory with frequency and recency decay", () => {
    const session = {
      sessionId: "test-session",
      mode: "romanized" as const,
      context: { ...defaultTypingContext("romanized"), leftTextWindow: "mero " },
      compositionText: "niraj",
      caret: 5,
      candidates: [],
      proofHints: [],
      lastUpdateTime: Date.now(),
      lastCommittedText: "",
      commitEpoch: 0,
      warnings: [],
      committedHistory: []
    };
    const fresh = {
      ...memoryEntry("fresh", "niraj", "नीरज"),
      frequency: 2,
      timestamps: {
        firstSeen: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      }
    };
    const stale = {
      ...memoryEntry("stale", "niraj", "निरज"),
      frequency: 20,
      timestamps: {
        firstSeen: "2020-01-01T00:00:00.000Z",
        lastUsed: "2020-01-01T00:00:00.000Z"
      }
    };

    const candidates = keyboardMemoryCandidates("niraj", [stale, fresh], session);
    expect(candidates[0]?.text).toBe("नीरज");
    expect(candidates[0]?.reason.join(" ")).toMatch(/recency/);
  });
});

function memoryEntry(id: string, normalizedInput: string, chosenOutput: string): CorrectionMemoryEntry {
  return {
    id,
    normalizedInput,
    chosenOutput,
    normalizedOutput: chosenOutput,
    rejectedAlternatives: [],
    context: { leftWindow: "", rightWindow: "" },
    source: "user-accept",
    frequency: 1,
    confidenceAtSelection: 0.9,
    timestamps: {
      firstSeen: "2026-05-27T00:00:00.000Z",
      lastUsed: "2026-05-27T00:00:00.000Z"
    }
  };
}
