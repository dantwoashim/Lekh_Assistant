import { normalizeCorrectionMemoryImportEntries } from "../../../src/engine/memory/importNormalization";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";
import type { SQLiteDatabase, SQLiteRow } from "./sqliteTypes";

export const CURRENT_SQLITE_SCHEMA_VERSION = 3;

export function migrateSQLiteDatabase(db: SQLiteDatabase): void {
  let version = sqliteUserVersion(db);
  assertSupportedSQLiteVersion(version, "migration staging database");
  while (version < CURRENT_SQLITE_SCHEMA_VERSION) {
    const nextVersion = version + 1;
    withSQLiteTransaction(db, () => {
      if (nextVersion === 1) migrateToVersion1(db);
      else if (nextVersion === 2) migrateToVersion2(db);
      else if (nextVersion === 3) migrateToVersion3(db);
      else throw new Error(`No SQLite keyboard storage migration exists for version ${nextVersion}`);
      db.exec(`PRAGMA user_version = ${nextVersion}`);
    });
    version = sqliteUserVersion(db);
    if (version !== nextVersion) {
      throw new Error(`SQLite keyboard storage migration did not set user_version to ${nextVersion}`);
    }
  }
}

export function assertCurrentSQLiteSchema(db: SQLiteDatabase, label: string): void {
  assertCanonicalSQLiteSchema(db, label, CURRENT_SQLITE_SCHEMA_VERSION);
}

function assertCanonicalSQLiteSchema(db: SQLiteDatabase, label: string, expectedVersion: number): void {
  const expectedColumns: Record<string, string[]> = {
    settings: ["id", "json", "updated_at"],
    personal_dictionary: [
      "id",
      "word",
      "romanized_json",
      "domains_json",
      "source",
      "created_at",
      "updated_at",
      "schema_version"
    ],
    correction_memory: [
      "id",
      "input_romanized",
      "input_preeti",
      "normalized_input",
      "chosen_output",
      "normalized_output",
      "rejected_alternatives_json",
      "context_domain",
      "source",
      "frequency",
      "confidence_at_selection",
      "first_seen",
      "last_used",
      "pinned",
      "blocked",
      "decay_weight"
    ],
    storage_metadata: ["id", "schema_version", "migrated_at"]
  };
  const actualTables = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(asRow).map((row) => stringValue(row.name));
  const expectedTables = Object.keys(expectedColumns).sort();
  if (!sameStrings(actualTables, expectedTables)) {
    throw new Error(`SQLite keyboard storage contains an unexpected or missing table for ${label}`);
  }

  const unexpectedExecutableSchema = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%'
  `).all();
  if (unexpectedExecutableSchema.length > 0) {
    throw new Error(`SQLite keyboard storage contains an unexpected view or trigger for ${label}`);
  }

  const actualIndexes = db.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND sql IS NOT NULL
    ORDER BY name
  `).all().map(asRow).map((row) => stringValue(row.name));
  const expectedIndexes = [
    "correction_memory_input_idx",
    "correction_memory_last_used_idx",
    "personal_dictionary_word_idx"
  ];
  if (!sameStrings(actualIndexes, expectedIndexes)) {
    throw new Error(`SQLite keyboard storage contains an unexpected or missing index for ${label}`);
  }
  const expectedIndexColumns: Record<string, string[]> = {
    correction_memory_input_idx: ["normalized_input"],
    correction_memory_last_used_idx: ["last_used"],
    personal_dictionary_word_idx: ["word"]
  };
  for (const [index, expected] of Object.entries(expectedIndexColumns)) {
    const actual = db.prepare(`PRAGMA index_info(${index})`).all()
      .map(asRow)
      .map((row) => stringValue(row.name));
    if (!sameStrings(actual, expected)) {
      throw new Error(`SQLite keyboard storage index ${index} has unexpected columns for ${label}`);
    }
  }

  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all()
      .map(asRow)
      .map((row) => stringValue(row.name));
    if (actual.length !== expected.length || expected.some((column, index) => actual[index] !== column)) {
      throw new Error(`SQLite keyboard storage schema mismatch in ${table} for ${label}`);
    }
  }
  const metadata = optionalRow(db.prepare("SELECT schema_version FROM storage_metadata WHERE id = 1").get());
  if (numberValue(metadata?.schema_version, -1) !== expectedVersion) {
    throw new Error(`SQLite keyboard storage metadata version mismatch for ${label}`);
  }
  const metadataRows = optionalRow(db.prepare("SELECT COUNT(*) AS count FROM storage_metadata").get());
  if (numberValue(metadataRows?.count, -1) !== 1) {
    throw new Error(`SQLite keyboard storage metadata row count mismatch for ${label}`);
  }
}

export function sqliteUserVersion(db: SQLiteDatabase): number {
  const row = optionalRow(db.prepare("PRAGMA user_version").get());
  return Math.trunc(numberValue(row?.user_version, 0));
}

export function assertSupportedSQLiteVersion(version: number, label: string): void {
  if (version < 0 || version > CURRENT_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `SQLite keyboard storage schema ${version} is not supported for ${label}; ` +
      `this build supports up to ${CURRENT_SQLITE_SCHEMA_VERSION}`
    );
  }
}

export function withSQLiteTransaction<T>(db: SQLiteDatabase, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original operation failure.
    }
    throw error;
  }
}

function migrateToVersion1(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_dictionary (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL,
      romanized_json TEXT NOT NULL,
      domains_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS personal_dictionary_word_idx ON personal_dictionary(word);
    CREATE TABLE IF NOT EXISTS correction_memory (
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
    CREATE INDEX IF NOT EXISTS correction_memory_input_idx ON correction_memory(normalized_input);
    CREATE INDEX IF NOT EXISTS correction_memory_last_used_idx ON correction_memory(last_used);
  `);
}

function migrateToVersion2(db: SQLiteDatabase): void {
  db.exec(`
    DROP INDEX IF EXISTS correction_memory_input_idx;
    DROP INDEX IF EXISTS correction_memory_last_used_idx;
    ALTER TABLE correction_memory RENAME TO correction_memory_v1;
  `);
  createCanonicalCorrectionMemoryTable(db);

  const entries = normalizeCorrectionMemoryImportEntries(
    db.prepare("SELECT * FROM correction_memory_v1").all().map(legacyCorrectionMemoryEntry),
    strictPersistedMemoryOptions()
  );
  insertCorrectionMemoryEntries(db, entries);

  db.exec(`
    DROP TABLE correction_memory_v1;
    CREATE INDEX correction_memory_input_idx ON correction_memory(normalized_input);
    CREATE INDEX correction_memory_last_used_idx ON correction_memory(last_used);
    CREATE TABLE storage_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      migrated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO storage_metadata (id, schema_version, migrated_at) VALUES (1, ?, ?)")
    .run(2, new Date().toISOString());
}

function migrateToVersion3(db: SQLiteDatabase): void {
  assertCanonicalSQLiteSchema(db, "schema-v2 migration source", 2);
  const entries = normalizeCorrectionMemoryImportEntries(
    db.prepare("SELECT * FROM correction_memory ORDER BY id").all().map(version2CorrectionMemoryEntry),
    strictPersistedMemoryOptions()
  );

  db.exec(`
    DROP INDEX correction_memory_input_idx;
    DROP INDEX correction_memory_last_used_idx;
    ALTER TABLE correction_memory RENAME TO correction_memory_v2;
  `);
  createCanonicalCorrectionMemoryTable(db);
  insertCorrectionMemoryEntries(db, entries);
  db.exec(`
    DROP TABLE correction_memory_v2;
    CREATE INDEX correction_memory_input_idx ON correction_memory(normalized_input);
    CREATE INDEX correction_memory_last_used_idx ON correction_memory(last_used);
  `);
  db.prepare(`
    UPDATE storage_metadata
    SET schema_version = ?, migrated_at = ?
    WHERE id = 1 AND schema_version = 2
  `).run(3, new Date().toISOString());
}

function createCanonicalCorrectionMemoryTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE correction_memory (
      id TEXT PRIMARY KEY,
      input_romanized TEXT,
      input_preeti TEXT,
      normalized_input TEXT NOT NULL,
      chosen_output TEXT NOT NULL,
      normalized_output TEXT NOT NULL,
      rejected_alternatives_json TEXT NOT NULL,
      context_domain TEXT,
      source TEXT NOT NULL,
      frequency INTEGER NOT NULL CHECK (frequency >= 0),
      confidence_at_selection REAL NOT NULL CHECK (confidence_at_selection >= 0 AND confidence_at_selection <= 1),
      first_seen TEXT NOT NULL,
      last_used TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
      decay_weight REAL
    );
  `);
}

function insertCorrectionMemoryEntries(db: SQLiteDatabase, entries: CorrectionMemoryEntry[]): void {
  const insert = db.prepare(`
    INSERT INTO correction_memory (
      id, input_romanized, input_preeti, normalized_input, chosen_output, normalized_output,
      rejected_alternatives_json, context_domain, source, frequency, confidence_at_selection,
      first_seen, last_used, pinned, blocked, decay_weight
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of entries) {
    insert.run(
      entry.id,
      entry.inputRomanized ?? null,
      entry.inputPreeti ?? null,
      entry.normalizedInput,
      entry.chosenOutput,
      entry.normalizedOutput,
      JSON.stringify(entry.rejectedAlternatives),
      entry.context.domain ?? null,
      entry.source,
      entry.frequency,
      entry.confidenceAtSelection,
      entry.timestamps.firstSeen,
      entry.timestamps.lastUsed,
      entry.pinned ? 1 : 0,
      entry.blocked ? 1 : 0,
      entry.decayWeight ?? null
    );
  }
}

function strictPersistedMemoryOptions() {
  return {
    requireTimestamps: true,
    requireKnownSource: true,
    scoringPolicy: "strict" as const,
    minimumFrequency: 0 as const
  };
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function legacyCorrectionMemoryEntry(value: unknown): Record<string, unknown> {
  const row = asRow(value);
  const context = parseJson(row.context_json, undefined);
  const rejectedAlternatives = parseJson(row.rejected_alternatives_json, undefined);
  if (!isRecord(context) || !Array.isArray(rejectedAlternatives)) {
    throw new Error("Legacy SQLite correction memory contains malformed JSON fields.");
  }
  return correctionMemoryImportRecord(row, context, rejectedAlternatives);
}

function version2CorrectionMemoryEntry(value: unknown): Record<string, unknown> {
  const row = asRow(value);
  const rejectedAlternatives = parseJson(row.rejected_alternatives_json, undefined);
  if (!Array.isArray(rejectedAlternatives)) {
    throw new Error("Schema-v2 SQLite correction memory contains malformed alternatives JSON.");
  }
  if (row.context_domain !== null && typeof row.context_domain !== "string") {
    throw new Error("Schema-v2 SQLite correction memory contains an invalid context domain.");
  }
  const context = row.context_domain === null
    ? { leftWindow: "", rightWindow: "" }
    : { leftWindow: "", rightWindow: "", domain: row.context_domain };
  return correctionMemoryImportRecord(row, context, rejectedAlternatives);
}

function correctionMemoryImportRecord(
  row: SQLiteRow,
  context: Record<string, unknown>,
  rejectedAlternatives: unknown[]
): Record<string, unknown> {
  return {
    id: row.id,
    ...(typeof row.input_romanized === "string" && row.input_romanized.length > 0
      ? { inputRomanized: row.input_romanized }
      : {}),
    ...(typeof row.input_preeti === "string" && row.input_preeti.length > 0
      ? { inputPreeti: row.input_preeti }
      : {}),
    normalizedInput: row.normalized_input,
    chosenOutput: row.chosen_output,
    normalizedOutput: row.normalized_output,
    rejectedAlternatives,
    context,
    source: row.source,
    frequency: row.frequency,
    confidenceAtSelection: row.confidence_at_selection,
    timestamps: {
      firstSeen: row.first_seen,
      lastUsed: row.last_used
    },
    pinned: legacyBoolean(row.pinned, "pinned"),
    blocked: legacyBoolean(row.blocked, "blocked"),
    ...(typeof row.decay_weight === "number" ? { decayWeight: row.decay_weight } : {})
  };
}

function legacyBoolean(value: unknown, label: string): boolean {
  if (value === 0 || value === false) return false;
  if (value === 1 || value === true) return true;
  throw new Error(`Legacy SQLite correction memory ${label} must be 0 or 1.`);
}

function optionalRow(value: unknown): SQLiteRow | undefined {
  return isRecord(value) ? value : undefined;
}

function asRow(value: unknown): SQLiteRow {
  return optionalRow(value) ?? {};
}

function isRecord(value: unknown): value is SQLiteRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sameStrings(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
