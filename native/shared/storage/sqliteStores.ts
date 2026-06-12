import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  KeyboardCorrectionMemoryStore,
  KeyboardSettings,
  KeyboardSettingsStore,
  PersonalDictionaryEntry,
  PersonalDictionaryStore
} from "../../../src/engine/keyboard/storage";
import { defaultKeyboardSettings } from "../../../src/engine/keyboard/storage";
import type { DictionaryResult, TypingContext } from "../../../src/engine/keyboard/types";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";
import { nativeKeyboardDataDir } from "./jsonFileStores";

type SqlitePrimitive = string | number | bigint | null;

interface StatementSync {
  all(...params: SqlitePrimitive[]): unknown[];
  get(...params: SqlitePrimitive[]): unknown;
  run(...params: SqlitePrimitive[]): unknown;
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

interface Row {
  [key: string]: unknown;
}

const require = createRequire(import.meta.url);

export class SQLiteKeyboardStorage {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.initialize();
  }

  static defaultPath(platform: "windows" | "macos" | "linux", homeDir: string): string {
    return join(nativeKeyboardDataDir(platform, homeDir), "lekh-keyboard.sqlite3");
  }

  settings(): KeyboardSettingsStore {
    return new SQLiteKeyboardSettingsStore(this.db);
  }

  personalDictionary(): PersonalDictionaryStore {
    return new SQLitePersonalDictionaryStore(this.db);
  }

  correctionMemory(): KeyboardCorrectionMemoryStore {
    return new SQLiteCorrectionMemoryStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
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
}

export class SQLiteKeyboardSettingsStore implements KeyboardSettingsStore {
  constructor(private readonly db: DatabaseSync) {}

  async getSettings(): Promise<KeyboardSettings> {
    const row = asRow(this.db.prepare("SELECT json FROM settings WHERE id = 1").get());
    return normalizeSettings(parseJson(row?.json, defaultKeyboardSettings()));
  }

  async updateSettings(patch: Partial<KeyboardSettings>): Promise<void> {
    const settings = normalizeSettings({
      ...(await this.getSettings()),
      ...patch,
      telemetryEnabled: false,
      schemaVersion: 1
    });
    this.db.prepare(`
      INSERT INTO settings (id, json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), new Date().toISOString());
  }
}

export class SQLitePersonalDictionaryStore implements PersonalDictionaryStore {
  constructor(private readonly db: DatabaseSync) {}

  async lookup(query: string): Promise<DictionaryResult[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return this.rows()
      .filter((entry) => {
        const aliases = entry.romanized?.map((alias) => alias.toLowerCase()) ?? [];
        return entry.word.startsWith(query) || aliases.some((alias) => alias.startsWith(normalized));
      })
      .map((entry) => ({
        query,
        word: entry.word,
        romanized: entry.romanized,
        domains: entry.domains,
        source: `personal:${entry.source}`,
        confidence: 0.92
      }));
  }

  async addWord(entry: PersonalDictionaryEntry): Promise<void> {
    this.db.prepare(`
      INSERT INTO personal_dictionary (
        id, word, romanized_json, domains_json, source, created_at, updated_at, schema_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        word = excluded.word,
        romanized_json = excluded.romanized_json,
        domains_json = excluded.domains_json,
        source = excluded.source,
        updated_at = excluded.updated_at,
        schema_version = excluded.schema_version
    `).run(
      entry.id,
      entry.word,
      JSON.stringify(entry.romanized ?? []),
      JSON.stringify(entry.domains ?? []),
      entry.source,
      entry.createdAt,
      entry.updatedAt,
      entry.schemaVersion
    );
  }

  async removeWord(id: string): Promise<void> {
    this.db.prepare("DELETE FROM personal_dictionary WHERE id = ?").run(id);
  }

  async export(): Promise<unknown> {
    return { schemaVersion: 1, entries: this.rows() };
  }

  async import(data: unknown): Promise<void> {
    if (!isEntryExport<PersonalDictionaryEntry>(data)) return;
    this.db.exec("DELETE FROM personal_dictionary");
    for (const entry of data.entries) {
      await this.addWord(entry);
    }
  }

  private rows(): PersonalDictionaryEntry[] {
    return this.db.prepare(`
      SELECT id, word, romanized_json, domains_json, source, created_at, updated_at, schema_version
      FROM personal_dictionary
      ORDER BY updated_at DESC, word ASC
    `).all().map((raw) => personalDictionaryEntryFromRow(asRequiredRow(raw)));
  }
}

export class SQLiteCorrectionMemoryStore implements KeyboardCorrectionMemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  async record(entry: CorrectionMemoryEntry): Promise<void> {
    this.db.prepare(`
      INSERT INTO correction_memory (
        id, input_romanized, input_preeti, normalized_input, chosen_output, normalized_output,
        rejected_alternatives_json, context_json, source, frequency, confidence_at_selection,
        first_seen, last_used, pinned, blocked, decay_weight
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        input_romanized = excluded.input_romanized,
        input_preeti = excluded.input_preeti,
        normalized_input = excluded.normalized_input,
        chosen_output = excluded.chosen_output,
        normalized_output = excluded.normalized_output,
        rejected_alternatives_json = excluded.rejected_alternatives_json,
        context_json = excluded.context_json,
        source = excluded.source,
        frequency = excluded.frequency,
        confidence_at_selection = excluded.confidence_at_selection,
        last_used = excluded.last_used,
        pinned = excluded.pinned,
        blocked = excluded.blocked,
        decay_weight = excluded.decay_weight
    `).run(
      entry.id,
      entry.inputRomanized ?? null,
      entry.inputPreeti ?? null,
      entry.normalizedInput,
      entry.chosenOutput,
      entry.normalizedOutput,
      JSON.stringify(entry.rejectedAlternatives),
      JSON.stringify(entry.context),
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

  async query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]> {
    if (context.secureInput || context.fieldType === "password" || context.fieldType === "code") return [];
    const normalizedInput = input.trim().toLowerCase();
    if (!normalizedInput) return [];
    return this.db.prepare(`
      SELECT *
      FROM correction_memory
      WHERE normalized_input LIKE ?
      ORDER BY pinned DESC, frequency DESC, last_used DESC
      LIMIT 20
    `).all(`${normalizedInput}%`).map((raw) => correctionMemoryEntryFromRow(asRequiredRow(raw)));
  }

  async forget(input: string, chosenOutput?: string): Promise<void> {
    const normalizedInput = input.trim().toLowerCase();
    const normalizedOutput = chosenOutput?.trim().toLowerCase();
    if (!normalizedInput) return;
    if (!normalizedOutput) {
      this.db.prepare("DELETE FROM correction_memory WHERE normalized_input = ?").run(normalizedInput);
      return;
    }
    this.db.prepare(`
      DELETE FROM correction_memory
      WHERE normalized_input = ?
        AND (lower(normalized_output) = ? OR lower(chosen_output) = ?)
    `).run(normalizedInput, normalizedOutput, normalizedOutput);
  }

  async reset(): Promise<void> {
    this.db.exec("DELETE FROM correction_memory");
  }

  async export(): Promise<unknown> {
    return {
      schemaVersion: 1,
      entries: this.db.prepare("SELECT * FROM correction_memory ORDER BY last_used DESC").all()
        .map((raw) => correctionMemoryEntryFromRow(asRequiredRow(raw)))
    };
  }

  async import(data: unknown): Promise<void> {
    if (!isEntryExport<CorrectionMemoryEntry>(data)) return;
    await this.reset();
    for (const entry of data.entries) {
      await this.record(entry);
    }
  }
}

function openDatabase(dbPath: string): DatabaseSync {
  try {
    const sqlite = require("node:sqlite") as SqliteModule;
    return new sqlite.DatabaseSync(dbPath);
  } catch (error) {
    if (error instanceof Error && /No such built-in module: node:sqlite/.test(error.message)) {
      return new JsonBackedDatabaseSync(dbPath);
    }
    throw error;
  }
}

interface JsonBackedState {
  settings?: { json: string; updated_at: string };
  personal_dictionary: Row[];
  correction_memory: Row[];
}

class JsonBackedDatabaseSync implements DatabaseSync {
  private state: JsonBackedState;

  constructor(private readonly dbPath: string) {
    this.state = this.load();
  }

  exec(sql: string): void {
    const normalized = normalizeSql(sql);
    if (normalized === "delete from personal_dictionary") {
      this.state.personal_dictionary = [];
      this.save();
      return;
    }
    if (normalized === "delete from correction_memory") {
      this.state.correction_memory = [];
      this.save();
    }
  }

  prepare(sql: string): StatementSync {
    return new JsonBackedStatementSync(this, normalizeSql(sql));
  }

  close(): void {
    this.save();
  }

  getSettings(): Row | undefined {
    return this.state.settings;
  }

  upsertSettings(json: string, updatedAt: string): void {
    this.state.settings = { json, updated_at: updatedAt };
    this.save();
  }

  personalDictionaryRows(): Row[] {
    return [...this.state.personal_dictionary].sort((a, b) =>
      stringValue(b.updated_at).localeCompare(stringValue(a.updated_at)) || stringValue(a.word).localeCompare(stringValue(b.word), "ne")
    );
  }

  upsertPersonalDictionary(values: SqlitePrimitive[]): void {
    const [id, word, romanizedJson, domainsJson, source, createdAt, updatedAt, schemaVersion] = values;
    const row: Row = {
      id,
      word,
      romanized_json: romanizedJson,
      domains_json: domainsJson,
      source,
      created_at: createdAt,
      updated_at: updatedAt,
      schema_version: schemaVersion
    };
    const index = this.state.personal_dictionary.findIndex((entry) => entry.id === id);
    if (index >= 0) this.state.personal_dictionary[index] = row;
    else this.state.personal_dictionary.push(row);
    this.save();
  }

  removePersonalDictionary(id: SqlitePrimitive): void {
    this.state.personal_dictionary = this.state.personal_dictionary.filter((entry) => entry.id !== id);
    this.save();
  }

  correctionMemoryRows(): Row[] {
    return [...this.state.correction_memory];
  }

  upsertCorrectionMemory(values: SqlitePrimitive[]): void {
    const [
      id,
      inputRomanized,
      inputPreeti,
      normalizedInput,
      chosenOutput,
      normalizedOutput,
      rejectedAlternativesJson,
      contextJson,
      source,
      frequency,
      confidenceAtSelection,
      firstSeen,
      lastUsed,
      pinned,
      blocked,
      decayWeight
    ] = values;
    const existing = this.state.correction_memory.find((entry) => entry.id === id);
    const row: Row = {
      id,
      input_romanized: inputRomanized,
      input_preeti: inputPreeti,
      normalized_input: normalizedInput,
      chosen_output: chosenOutput,
      normalized_output: normalizedOutput,
      rejected_alternatives_json: rejectedAlternativesJson,
      context_json: contextJson,
      source,
      frequency,
      confidence_at_selection: confidenceAtSelection,
      first_seen: existing?.first_seen ?? firstSeen,
      last_used: lastUsed,
      pinned,
      blocked,
      decay_weight: decayWeight
    };
    const index = this.state.correction_memory.findIndex((entry) => entry.id === id);
    if (index >= 0) this.state.correction_memory[index] = row;
    else this.state.correction_memory.push(row);
    this.save();
  }

  queryCorrectionMemory(prefix: string): Row[] {
    const normalizedPrefix = prefix.replace(/%$/, "");
    return this.state.correction_memory
      .filter((entry) => stringValue(entry.normalized_input).startsWith(normalizedPrefix))
      .sort((a, b) => {
        const pinned = numberValue(b.pinned, 0) - numberValue(a.pinned, 0);
        if (pinned !== 0) return pinned;
        const frequency = numberValue(b.frequency, 0) - numberValue(a.frequency, 0);
        if (frequency !== 0) return frequency;
        return stringValue(b.last_used).localeCompare(stringValue(a.last_used));
      })
      .slice(0, 20);
  }

  removeCorrectionMemory(normalizedInput: SqlitePrimitive, normalizedOutput?: SqlitePrimitive): void {
    this.state.correction_memory = this.state.correction_memory.filter((entry) => {
      if (entry.normalized_input !== normalizedInput) return true;
      if (normalizedOutput === undefined) return false;
      return (
        stringValue(entry.normalized_output).toLowerCase() !== normalizedOutput &&
        stringValue(entry.chosen_output).toLowerCase() !== normalizedOutput
      );
    });
    this.save();
  }

  private load(): JsonBackedState {
    if (!existsSync(this.dbPath)) {
      return { personal_dictionary: [], correction_memory: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.dbPath, "utf8"));
      return {
        settings: isRecord(parsed.settings) ? parsed.settings : undefined,
        personal_dictionary: Array.isArray(parsed.personal_dictionary) ? parsed.personal_dictionary.filter(isRecord) : [],
        correction_memory: Array.isArray(parsed.correction_memory) ? parsed.correction_memory.filter(isRecord) : []
      };
    } catch {
      return { personal_dictionary: [], correction_memory: [] };
    }
  }

  private save(): void {
    writeFileSync(this.dbPath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

class JsonBackedStatementSync implements StatementSync {
  constructor(
    private readonly db: JsonBackedDatabaseSync,
    private readonly sql: string
  ) {}

  all(...params: SqlitePrimitive[]): unknown[] {
    if (this.sql.startsWith("select id, word, romanized_json")) return this.db.personalDictionaryRows();
    if (this.sql.startsWith("select * from correction_memory where normalized_input like")) {
      return this.db.queryCorrectionMemory(String(params[0] ?? ""));
    }
    if (this.sql.startsWith("select * from correction_memory order by")) {
      return this.db.correctionMemoryRows().sort((a, b) => stringValue(b.last_used).localeCompare(stringValue(a.last_used)));
    }
    return [];
  }

  get(): unknown {
    if (this.sql.startsWith("select json from settings")) return this.db.getSettings();
    return undefined;
  }

  run(...params: SqlitePrimitive[]): unknown {
    if (this.sql.startsWith("insert into settings")) {
      this.db.upsertSettings(String(params[0] ?? ""), String(params[1] ?? ""));
      return {};
    }
    if (this.sql.startsWith("insert into personal_dictionary")) {
      this.db.upsertPersonalDictionary(params);
      return {};
    }
    if (this.sql.startsWith("delete from personal_dictionary where id = ?")) {
      this.db.removePersonalDictionary(params[0]);
      return {};
    }
    if (this.sql.startsWith("insert into correction_memory")) {
      this.db.upsertCorrectionMemory(params);
      return {};
    }
    if (this.sql.startsWith("delete from correction_memory where normalized_input = ? and")) {
      this.db.removeCorrectionMemory(params[0], params[1]);
      return {};
    }
    if (this.sql.startsWith("delete from correction_memory where normalized_input = ?")) {
      this.db.removeCorrectionMemory(params[0]);
      return {};
    }
    return {};
  }
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeSettings(value: unknown): KeyboardSettings {
  return {
    ...defaultKeyboardSettings(),
    ...(isRecord(value) ? value : {}),
    telemetryEnabled: false,
    schemaVersion: 1
  };
}

function personalDictionaryEntryFromRow(row: Row): PersonalDictionaryEntry {
  return {
    id: stringValue(row.id),
    word: stringValue(row.word),
    romanized: parseStringArray(row.romanized_json),
    domains: parseStringArray(row.domains_json),
    source: stringValue(row.source) === "import" ? "import" : "user",
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    schemaVersion: 1
  };
}

function correctionMemoryEntryFromRow(row: Row): CorrectionMemoryEntry {
  return {
    id: stringValue(row.id),
    inputRomanized: optionalString(row.input_romanized),
    inputPreeti: optionalString(row.input_preeti),
    normalizedInput: stringValue(row.normalized_input),
    chosenOutput: stringValue(row.chosen_output),
    normalizedOutput: stringValue(row.normalized_output),
    rejectedAlternatives: parseStringArray(row.rejected_alternatives_json),
    context: parseJson(row.context_json, { leftWindow: "", rightWindow: "" }) as CorrectionMemoryEntry["context"],
    source: correctionMemorySource(row.source),
    frequency: numberValue(row.frequency, 1),
    confidenceAtSelection: numberValue(row.confidence_at_selection, 0.8),
    timestamps: {
      firstSeen: stringValue(row.first_seen),
      lastUsed: stringValue(row.last_used)
    },
    pinned: booleanValue(row.pinned),
    blocked: booleanValue(row.blocked),
    decayWeight: optionalNumber(row.decay_weight)
  };
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isEntryExport<T>(value: unknown): value is { schemaVersion: 1; entries: T[] } {
  return isRecord(value) && Array.isArray(value.entries);
}

function correctionMemorySource(value: unknown): CorrectionMemoryEntry["source"] {
  if (
    value === "user-accept" ||
    value === "user-edit" ||
    value === "user-add-dictionary" ||
    value === "proofread-accept" ||
    value === "import"
  ) {
    return value;
  }
  return "import";
}

function asRow(value: unknown): Row | undefined {
  return isRecord(value) ? value : undefined;
}

function asRequiredRow(value: unknown): Row {
  return asRow(value) ?? {};
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  return undefined;
}
