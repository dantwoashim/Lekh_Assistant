import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultTypingContext } from "../../../src/engine/keyboard";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";
import { SQLiteKeyboardStorage } from "./sqliteStores";

interface TestStatement {
  all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
  get(...params: Array<string | number | null>): Record<string, unknown>;
  run(...params: Array<string | number | null>): unknown;
}

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

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

  it("treats SQLite wildcard characters as literal correction-memory input", async () => {
    const storage = new SQLiteKeyboardStorage(await tempStoragePath());
    await storage.correctionMemory().record(memoryEntry("mem_1", "niraj", "नीरज", 1));
    expect(await storage.correctionMemory().query("%", defaultTypingContext("romanized"))).toEqual([]);
    expect(await storage.correctionMemory().query("_", defaultTypingContext("romanized"))).toEqual([]);
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

    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => TestDatabase };
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

  it("uses an explicit schema version and removes legacy surrounding-text context during migration", async () => {
    const filePath = await tempStoragePath();
    const surroundingSentence = "यो अत्यन्त निजी वरिपरिको वाक्य हो";
    createLegacyVersion1Database(filePath, surroundingSentence);

    const storage = new SQLiteKeyboardStorage(filePath);
    expect(await storage.correctionMemory().query("legacy", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({
        context: { leftWindow: "", rightWindow: "", domain: "health" },
        normalizedInput: "legacy"
      })
    ]);
    storage.close();

    const database = openTestDatabase(filePath);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(database.prepare("SELECT schema_version FROM storage_metadata WHERE id = 1").get()).toEqual({
        schema_version: 2
      });
      const columns = database.prepare("PRAGMA table_info(correction_memory)").all().map((row) => row.name);
      expect(columns).toContain("context_domain");
      expect(columns).not.toContain("context_json");
    } finally {
      database.close();
    }

    expect((await readFile(filePath)).includes(Buffer.from(surroundingSentence, "utf8"))).toBe(false);
  });

  it("never persists reconstructable context windows for new correction-memory records", async () => {
    const filePath = await tempStoragePath();
    const leftWindow = "The patient's full surrounding sentence before the correction";
    const rightWindow = "and the rest of that private sentence after it";
    const storage = new SQLiteKeyboardStorage(filePath);
    await storage.correctionMemory().record({
      ...memoryEntry("private_context", "swasthya", "स्वास्थ्य", 1),
      context: { leftWindow, rightWindow, domain: "health" }
    });
    expect(await storage.correctionMemory().query("swas", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ context: { leftWindow: "", rightWindow: "", domain: "health" } })
    ]);
    storage.close();

    const bytes = await readFile(filePath);
    expect(bytes.includes(Buffer.from(leftWindow, "utf8"))).toBe(false);
    expect(bytes.includes(Buffer.from(rightWindow, "utf8"))).toBe(false);
  });

  it("keeps the original database recoverable when a migration fails", async () => {
    const filePath = await tempStoragePath();
    const database = openTestDatabase(filePath);
    database.exec("CREATE TABLE migration_sentinel (value TEXT NOT NULL); PRAGMA user_version = 1;");
    database.prepare("INSERT INTO migration_sentinel (value) VALUES (?)").run("preserve-me");
    database.close();
    const original = await readFile(filePath);

    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow();
    expect(await readFile(filePath)).toEqual(original);
    const recovered = openTestDatabase(filePath);
    try {
      expect(recovered.prepare("SELECT value FROM migration_sentinel").get()).toEqual({ value: "preserve-me" });
      expect(recovered.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      recovered.close();
    }
    expect((await readdir(dirname(filePath))).filter((name) => name.includes(".migration-") || name.includes(".backup-")))
      .toEqual([]);
  });

  it("recovers an original database after a crash between backup and promotion", async () => {
    const filePath = await tempStoragePath();
    createLegacyVersion1Database(filePath, "recover this private legacy context");
    await rename(filePath, `${filePath}.backup`);

    const recovered = new SQLiteKeyboardStorage(filePath);
    expect(await recovered.correctionMemory().query("legacy", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ normalizedInput: "legacy", context: { leftWindow: "", rightWindow: "", domain: "health" } })
    ]);
    recovered.close();
    await expect(readFile(`${filePath}.backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes cleanup after a crash that left a validated database and its backup", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    await storage.settings().updateSettings({ showRomanizedLabels: true });
    storage.close();
    await copyFile(filePath, `${filePath}.backup`);

    const recovered = new SQLiteKeyboardStorage(filePath);
    expect(await recovered.settings().getSettings()).toEqual(expect.objectContaining({ showRomanizedLabels: true }));
    recovered.close();
    await expect(readFile(`${filePath}.backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses migration while a live runtime lease exists and reclaims a dead lease", async () => {
    const filePath = await tempStoragePath();
    createLegacyVersion1Database(filePath, "private legacy context");
    const liveLease = `${filePath}.runtime-${process.pid}-manual.lease`;
    await writeFile(liveLease, JSON.stringify({
      pid: process.pid,
      token: "live-runtime-lease-token",
      createdAt: new Date().toISOString()
    }));
    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow(/runtime connection lease/);
    await rm(liveLease, { force: true });

    const deadLease = `${filePath}.runtime-2147483647-manual.lease`;
    await writeFile(deadLease, JSON.stringify({
      pid: 2147483647,
      token: "dead-runtime-lease-token",
      createdAt: new Date(0).toISOString()
    }));
    const migrated = new SQLiteKeyboardStorage(filePath);
    migrated.close();
    await expect(readFile(deadLease)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never steals an old migration lock from a live owner and reclaims a dead owner", async () => {
    const filePath = await tempStoragePath();
    const initialized = new SQLiteKeyboardStorage(filePath);
    initialized.close();
    const lockPath = `${filePath}.migration.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      token: "live-migration-lock-token",
      createdAt: new Date(0).toISOString()
    }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow(/Timed out waiting/);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(expect.objectContaining({
      token: "live-migration-lock-token"
    }));
    await rm(lockPath, { force: true });

    await writeFile(lockPath, JSON.stringify({
      pid: 2147483647,
      token: "dead-migration-lock-token",
      createdAt: new Date(0).toISOString()
    }));
    const recovered = new SQLiteKeyboardStorage(filePath);
    recovered.close();
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("rejects migration while another connection can write, then succeeds after startup becomes exclusive", async () => {
    const filePath = await tempStoragePath();
    createLegacyVersion1Database(filePath, "private legacy context");
    const activeWriter = openTestDatabase(filePath);
    activeWriter.exec("BEGIN IMMEDIATE");
    try {
      expect(() => new SQLiteKeyboardStorage(filePath)).toThrow(/checkpoint|locked/i);
    } finally {
      activeWriter.exec("ROLLBACK");
      activeWriter.close();
    }

    const migrated = new SQLiteKeyboardStorage(filePath);
    migrated.close();
    const database = openTestDatabase(filePath);
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      database.close();
    }
  }, 15_000);

  it("rejects future schema versions without downgrading or modifying them", async () => {
    const filePath = await tempStoragePath();
    const database = openTestDatabase(filePath);
    database.exec("CREATE TABLE future_data (value TEXT NOT NULL); PRAGMA user_version = 999;");
    database.prepare("INSERT INTO future_data (value) VALUES (?)").run("future");
    database.close();
    const original = await readFile(filePath);

    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow(/schema 999 is not supported/);
    expect(await readFile(filePath)).toEqual(original);
  });

  it("rejects unexpected user tables instead of accepting a schema with hidden data", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    storage.close();
    const database = openTestDatabase(filePath);
    database.exec("CREATE TABLE unexpected_private_data (value TEXT NOT NULL)");
    database.prepare("INSERT INTO unexpected_private_data (value) VALUES (?)").run("must-remain-recoverable");
    database.close();

    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow(/unexpected or missing table/);
    const original = openTestDatabase(filePath);
    try {
      expect(original.prepare("SELECT value FROM unexpected_private_data").get()).toEqual({
        value: "must-remain-recoverable"
      });
    } finally {
      original.close();
    }
  });

  it("rolls back a failed bulk import instead of exposing a partial replacement", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    const memory = storage.correctionMemory();
    const existing = memoryEntry("existing", "niraj", "नीरज", 1);
    await memory.record(existing);

    const invalid = { ...memoryEntry("invalid", "bad", "खराब", -1), frequency: -1 };
    await expect(memory.import({
      schemaVersion: 1,
      entries: [memoryEntry("replacement", "ram", "राम", 1), invalid]
    })).rejects.toThrow();
    expect(await memory.query("niraj", defaultTypingContext("romanized"))).toEqual([
      expect.objectContaining({ id: "existing" })
    ]);
    expect(await memory.query("ram", defaultTypingContext("romanized"))).toHaveLength(0);
    storage.close();
  });

  it("serializes first-use migrations across processes without losing either writer", async () => {
    const filePath = await tempStoragePath();
    const moduleUrl = pathToFileURL(join(process.cwd(), "native/shared/storage/sqliteStores.ts")).href;
    const childScript = (id: string, word: string) => `
      import { SQLiteKeyboardStorage } from ${JSON.stringify(moduleUrl)};
      const storage = new SQLiteKeyboardStorage(${JSON.stringify(filePath)});
      await storage.personalDictionary().addWord({
        id: ${JSON.stringify(id)},
        word: ${JSON.stringify(word)},
        source: "user",
        createdAt: "2026-06-12T00:00:00.000Z",
        updatedAt: "2026-06-12T00:00:00.000Z",
        schemaVersion: 1
      });
      storage.close();
    `;
    const options = {
      cwd: process.cwd(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    };

    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript("child-a", "शब्दक")], options),
      execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript("child-b", "शब्दख")], options)
    ]);

    const storage = new SQLiteKeyboardStorage(filePath);
    expect(await storage.personalDictionary().lookup("शब्द")).toEqual([
      expect.objectContaining({ word: "शब्दक" }),
      expect.objectContaining({ word: "शब्दख" })
    ]);
    storage.close();
  });

  it("creates private storage directory and database permissions where chmod is supported", async () => {
    const filePath = await tempStoragePath();
    const storage = new SQLiteKeyboardStorage(filePath);
    storage.close();
    if (process.platform !== "win32") {
      expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects header-shaped corrupt SQLite data without modifying it", async () => {
    const filePath = await tempStoragePath();
    const corrupt = Buffer.alloc(4096, 0x5a);
    Buffer.from("SQLite format 3\0", "utf8").copy(corrupt, 0);
    await writeFile(filePath, corrupt);

    expect(() => new SQLiteKeyboardStorage(filePath)).toThrow();
    expect(await readFile(filePath)).toEqual(corrupt);
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

function openTestDatabase(filePath: string): TestDatabase {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => TestDatabase };
  return new sqlite.DatabaseSync(filePath);
}

function createLegacyVersion1Database(filePath: string, surroundingSentence: string): void {
  const current = new SQLiteKeyboardStorage(filePath);
  current.close();
  const database = openTestDatabase(filePath);
  try {
    database.exec(`
      DROP TABLE storage_metadata;
      DROP INDEX correction_memory_input_idx;
      DROP INDEX correction_memory_last_used_idx;
      DROP TABLE correction_memory;
      CREATE TABLE correction_memory (
        id TEXT PRIMARY KEY,
        input_romanized TEXT,
        input_preeti TEXT,
        normalized_input TEXT NOT NULL,
        chosen_output TEXT NOT NULL,
        normalized_output TEXT NOT NULL,
        rejected_alternatives_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        source TEXT NOT NULL,
        frequency INTEGER NOT NULL,
        confidence_at_selection REAL NOT NULL,
        first_seen TEXT NOT NULL,
        last_used TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        decay_weight REAL
      );
      CREATE INDEX correction_memory_input_idx ON correction_memory(normalized_input);
      CREATE INDEX correction_memory_last_used_idx ON correction_memory(last_used);
      PRAGMA user_version = 1;
    `);
    database.prepare(`
      INSERT INTO correction_memory (
        id, input_romanized, input_preeti, normalized_input, chosen_output, normalized_output,
        rejected_alternatives_json, context_json, source, frequency, confidence_at_selection,
        first_seen, last_used, pinned, blocked, decay_weight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-memory",
      "legacy",
      null,
      "legacy",
      "लेगेसी",
      "लेगेसी",
      "[]",
      JSON.stringify({ leftWindow: surroundingSentence, rightWindow: surroundingSentence, domain: "health" }),
      "user-accept",
      1,
      0.9,
      "2026-06-12T00:00:00.000Z",
      "2026-06-12T00:00:00.000Z",
      0,
      0,
      null
    );
  } finally {
    database.close();
  }
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
