import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultTypingContext } from "../../../src/engine/keyboard";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";
import { JsonFileKeyboardStorage, nativeKeyboardDataDir } from "./jsonFileStores";

describe("native JSON file keyboard stores", () => {
  it("persists settings with telemetry forced off", async () => {
    const storage = new JsonFileKeyboardStorage(await tempStoragePath());
    const settings = storage.settings();
    await settings.updateSettings({ showRomanizedLabels: true, telemetryEnabled: true as false });
    expect(await settings.getSettings()).toEqual(
      expect.objectContaining({
        showRomanizedLabels: true,
        telemetryEnabled: false,
        schemaVersion: 1
      })
    );
  });

  it("persists personal dictionary entries with export/import", async () => {
    const storage = new JsonFileKeyboardStorage(await tempStoragePath());
    const dictionary = storage.personalDictionary();
    await dictionary.addWord({
      id: "pd_1",
      word: "स्वास्थ्य",
      romanized: ["swasthya"],
      domains: ["health"],
      source: "user",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      schemaVersion: 1
    });

    expect(await dictionary.lookup("swas")).toEqual([expect.objectContaining({ word: "स्वास्थ्य" })]);

    const imported = new JsonFileKeyboardStorage(await tempStoragePath());
    await imported.personalDictionary().import(await dictionary.export());
    expect(await imported.personalDictionary().lookup("स्वा")).toEqual([expect.objectContaining({ word: "स्वास्थ्य" })]);
  });

  it("persists correction memory but suppresses secure-context queries", async () => {
    const filePath = await tempStoragePath();
    const storage = new JsonFileKeyboardStorage(filePath);
    const memory = storage.correctionMemory();
    const entry: CorrectionMemoryEntry = {
      id: "mem_1",
      normalizedInput: "prabin",
      chosenOutput: "प्रवीण",
      normalizedOutput: "प्रवीण",
      rejectedAlternatives: ["प्रबिन"],
      context: { leftWindow: "", rightWindow: "" },
      source: "user-accept",
      frequency: 2,
      confidenceAtSelection: 0.9,
      timestamps: {
        firstSeen: "2026-05-28T00:00:00.000Z",
        lastUsed: "2026-05-28T00:00:00.000Z"
      }
    };
    await memory.record(entry);

    expect(await memory.query("pra", defaultTypingContext("romanized"))).toHaveLength(1);
    expect(await memory.query("pra", { ...defaultTypingContext("romanized"), secureInput: true })).toHaveLength(0);
    expect(await memory.query("pra", { ...defaultTypingContext("romanized"), fieldType: "unknown" })).toHaveLength(0);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(
      expect.objectContaining({ schemaVersion: 1, correctionMemory: [expect.objectContaining({ id: "mem_1" })] })
    );

    await memory.reset();
    expect(await memory.query("pra", defaultTypingContext("romanized"))).toHaveLength(0);
  });

  it("strips reconstructable context windows from new and legacy JSON storage", async () => {
    const filePath = await tempStoragePath();
    const leftWindow = "private sentence before the correction";
    const rightWindow = "private sentence after the correction";
    const storage = new JsonFileKeyboardStorage(filePath);
    await storage.correctionMemory().record({
      ...memoryEntry("private", "swasthya", "स्वास्थ्य"),
      context: { leftWindow, rightWindow, domain: "health" }
    });
    expect(await storage.correctionMemory().query("swas", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ context: { leftWindow: "", rightWindow: "", domain: "health" } })
    ]);
    expect(await readFile(filePath, "utf8")).not.toContain(leftWindow);
    expect(await readFile(filePath, "utf8")).not.toContain(rightWindow);

    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const entries = legacy.correctionMemory as CorrectionMemoryEntry[];
    entries[0] = {
      ...entries[0],
      context: { leftWindow, rightWindow, domain: "health" },
      privateText: "unknown fields must not survive normalization"
    } as CorrectionMemoryEntry;
    await writeFile(filePath, JSON.stringify(legacy), "utf8");

    await storage.read();
    expect(await readFile(filePath, "utf8")).not.toContain(leftWindow);
    expect(await readFile(filePath, "utf8")).not.toContain(rightWindow);
    expect(await readFile(filePath, "utf8")).not.toContain("unknown fields must not survive normalization");
  });

  it("returns no correction history for an empty query", async () => {
    const storage = new JsonFileKeyboardStorage(await tempStoragePath());
    await storage.correctionMemory().record(memoryEntry("mem_1", "niraj", "नीरज"));
    expect(await storage.correctionMemory().query("   ", defaultTypingContext("romanized"))).toEqual([]);
  });

  it("rejects a future JSON schema without rewriting the original file", async () => {
    const filePath = await tempStoragePath();
    const future = JSON.stringify({ schemaVersion: 99, privateFutureData: "preserve exactly" });
    await writeFile(filePath, future, "utf8");
    const storage = new JsonFileKeyboardStorage(filePath);
    await expect(storage.read()).rejects.toThrow(/schema version/);
    expect(await readFile(filePath, "utf8")).toBe(future);
  });

  it("refuses to write JSON under a SQLite filename", async () => {
    const filePath = (await tempStoragePath()).replace(/\.json$/, ".sqlite3");
    expect(() => new JsonFileKeyboardStorage(filePath)).toThrow(/requires an explicit \.json path/);
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates private JSON storage permissions where chmod is supported", async () => {
    const filePath = await tempStoragePath();
    const storage = new JsonFileKeyboardStorage(filePath);
    await storage.settings().updateSettings({ showRomanizedLabels: true });
    if (process.platform !== "win32") {
      expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("forgets correction memory by input and chosen output", async () => {
    const storage = new JsonFileKeyboardStorage(await tempStoragePath());
    const memory = storage.correctionMemory();
    await memory.record(memoryEntry("mem_1", "niraj", "निरज"));
    await memory.record(memoryEntry("mem_2", "niraj", "नीरज"));

    await memory.forget("niraj", "निरज");
    expect(await memory.query("niraj", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ chosenOutput: "नीरज" })
    ]);

    await memory.forget("niraj");
    expect(await memory.query("niraj", defaultTypingContext("romanized"))).toHaveLength(0);
  });

  it("documents per-user platform storage directories", () => {
    expect(nativeKeyboardDataDir("windows", "C:\\Users\\rohan")).toContain("AppData");
    expect(nativeKeyboardDataDir("macos", "/Users/rohan")).toBe("/Users/rohan/Library/Application Support/Lekh Keyboard");
    expect(nativeKeyboardDataDir("linux", "/home/rohan")).toBe("/home/rohan/.local/share/lekh-keyboard");
  });
});

async function tempStoragePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lekh-keyboard-storage-"));
  return join(dir, "keyboard-store.json");
}

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
      firstSeen: "2026-05-28T00:00:00.000Z",
      lastUsed: "2026-05-28T00:00:00.000Z"
    }
  };
}
