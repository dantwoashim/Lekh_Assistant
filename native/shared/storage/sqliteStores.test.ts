import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultTypingContext } from "../../../src/engine/keyboard";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";
import { SQLiteKeyboardStorage } from "./sqliteStores";

interface IntegrityDatabase {
  prepare(sql: string): { get(): Record<string, unknown> };
  close(): void;
}

const require = createRequire(import.meta.url);

describe("native SQLite keyboard stores", () => {
  it("persists settings locally with telemetry forced off", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    await storage.settings().updateSettings({ showRomanizedLabels: true, telemetryEnabled: true as false });
    storage.close();

    const reopened = new SQLiteKeyboardStorage(filePath);
    expect(await reopened.settings().getSettings()).toEqual(
      expect.objectContaining({
        showRomanizedLabels: true,
        telemetryEnabled: false,
        schemaVersion: 1
      })
    );
    reopened.close();
  });

  it("persists personal dictionary entries across process-style reopen", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    await storage.personalDictionary().addWord({
      id: "pd_1",
      word: "स्वास्थ्य",
      romanized: ["swasthya"],
      domains: ["health"],
      source: "user",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      schemaVersion: 1
    });
    storage.close();

    const reopened = new SQLiteKeyboardStorage(filePath);
    expect(await reopened.personalDictionary().lookup("swas")).toEqual([
      expect.objectContaining({ word: "स्वास्थ्य", source: "personal:user" })
    ]);
    reopened.close();
  });

  it("stores correction memory, suppresses secure reads, and forgets entries", async () => {
    const storage = new SQLiteKeyboardStorage(await tempStoragePath());
    const memory = storage.correctionMemory();
    await memory.record(memoryEntry("mem_1", "niraj", "निरज", 1));
    await memory.record(memoryEntry("mem_2", "niraj", "नीरज", 3));

    expect(await memory.query("nir", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ chosenOutput: "नीरज" }),
      expect.objectContaining({ chosenOutput: "निरज" })
    ]);
    expect(await memory.query("nir", { ...defaultTypingContext("romanized"), fieldType: "password" })).toHaveLength(0);
    expect(await memory.query("nir", { ...defaultTypingContext("romanized"), fieldType: "unknown" })).toHaveLength(0);

    await memory.forget("niraj", "नीरज");
    expect(await memory.query("nir", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ chosenOutput: "निरज" })
    ]);

    await memory.forget("niraj");
    expect(await memory.query("nir", defaultTypingContext("romanized"))).toHaveLength(0);
    storage.close();
  });

  it("creates an actual SQLite file rather than JSON under a .sqlite3 name", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    storage.close();

    const header = (await readFile(filePath)).subarray(0, 16).toString("utf8");
    expect(header).toBe("SQLite format 3\0");
  });

  it("survives a native SQLite integrity check and storage reopen", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    await storage.settings().updateSettings({ showRomanizedLabels: true });
    storage.close();

    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => IntegrityDatabase };
    const database = new sqlite.DatabaseSync(filePath);
    try {
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      database.close();
    }

    const reopened = new SQLiteKeyboardStorage(filePath);
    expect(await reopened.settings().getSettings()).toEqual(
      expect.objectContaining({ showRomanizedLabels: true })
    );
    reopened.close();
  });

  it("rejects a non-SQLite file without modifying its bytes", async () => {
    const filePath = await tempStoragePath();
    const original = Buffer.from("not a SQLite database\n", "utf8");
    await writeFile(filePath, original);

    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow();
    expect(await readFile(filePath)).toEqual(original);
  });
});

async function tempStoragePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lekh-keyboard-sqlite-"));
  return join(dir, "lekh-keyboard.sqlite3");
}

function memoryEntry(id: string, normalizedInput: string, chosenOutput: string, frequency: number): CorrectionMemoryEntry {
  return {
    id,
    inputRomanized: normalizedInput,
    normalizedInput,
    chosenOutput,
    normalizedOutput: chosenOutput,
    rejectedAlternatives: [],
    context: { leftWindow: "", rightWindow: "" },
    source: "user-accept",
    frequency,
    confidenceAtSelection: 0.9,
    timestamps: {
      firstSeen: "2026-06-12T00:00:00.000Z",
      lastUsed: `2026-06-12T00:00:0${frequency}.000Z`
    }
  };
}
