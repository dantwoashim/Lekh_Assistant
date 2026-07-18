import { join } from "node:path";
import type {
  KeyboardCorrectionMemoryStore,
  KeyboardSettings,
  KeyboardSettingsStore,
  PersonalDictionaryEntry,
  PersonalDictionaryStore
} from "../../../src/engine/keyboard/storage";
import { defaultKeyboardSettings } from "../../../src/engine/keyboard/storage";
import { isSecureContext } from "../../../src/engine/keyboard/modes";
import type { DictionaryResult, TypingContext } from "../../../src/engine/keyboard/types";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";
import { privacySafeCorrectionMemoryDomain } from "../../../src/engine/memory/types";
import {
  nativeKeyboardDataDir,
  normalizeKeyboardSettings,
  normalizePersonalDictionaryEntry,
  privacySafeCorrectionMemoryEntry
} from "./jsonFileStores";
import { prepareSQLiteDatabase } from "./sqliteDatabase";
import { withSQLiteTransaction } from "./sqliteMigrations";
import type { SQLiteDatabase, SQLiteRow } from "./sqliteTypes";

export class SQLiteKeyboardStorage {
  private readonly db: SQLiteDatabase;

  constructor(dbPath: string) {
    if (!dbPath.endsWith(".sqlite3")) {
      throw new Error(`SQLite keyboard storage requires a .sqlite3 path: ${dbPath}`);
    }
    this.db = prepareSQLiteDatabase(dbPath);
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
}

export class SQLiteKeyboardSettingsStore implements KeyboardSettingsStore {
  constructor(private readonly db: SQLiteDatabase) {}

  async getSettings(): Promise<KeyboardSettings> {
    const row = asRow(this.db.prepare("SELECT json FROM settings WHERE id = 1").get());
    return normalizeKeyboardSettings(parseJson(row?.json, defaultKeyboardSettings()));
  }

  async updateSettings(patch: Partial<KeyboardSettings>): Promise<void> {
    const settings = normalizeKeyboardSettings({
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
  constructor(private readonly db: SQLiteDatabase) {}

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
    this.upsert(entry);
  }

  async removeWord(id: string): Promise<void> {
    this.db.prepare("DELETE FROM personal_dictionary WHERE id = ?").run(id);
  }

  async export(): Promise<unknown> {
    return { schemaVersion: 1, entries: this.rows() };
  }

  async import(data: unknown): Promise<void> {
    if (!isEntryExport<PersonalDictionaryEntry>(data)) return;
    withSQLiteTransaction(this.db, () => {
      this.db.exec("DELETE FROM personal_dictionary");
      for (const entry of data.entries) this.upsert(entry);
    });
  }

  private upsert(entry: PersonalDictionaryEntry): void {
    const normalizedEntry = normalizePersonalDictionaryEntry(entry);
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
      normalizedEntry.id,
      normalizedEntry.word,
      JSON.stringify(normalizedEntry.romanized ?? []),
      JSON.stringify(normalizedEntry.domains ?? []),
      normalizedEntry.source,
      normalizedEntry.createdAt,
      normalizedEntry.updatedAt,
      normalizedEntry.schemaVersion
    );
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
  constructor(private readonly db: SQLiteDatabase) {}

  async record(entry: CorrectionMemoryEntry): Promise<void> {
    this.upsert(entry);
  }

  async query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]> {
    if (isSecureContext(context)) return [];
    const normalizedInput = input.trim().toLowerCase();
    if (!normalizedInput) return [];
    return this.db.prepare(`
      SELECT *
      FROM correction_memory
      WHERE instr(lower(normalized_input), ?) = 1
      ORDER BY pinned DESC, frequency DESC, last_used DESC
      LIMIT 20
    `).all(normalizedInput).map((raw) => correctionMemoryEntryFromRow(asRequiredRow(raw)));
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
    withSQLiteTransaction(this.db, () => {
      this.db.exec("DELETE FROM correction_memory");
      for (const entry of data.entries) this.upsert(entry);
    });
  }

  private upsert(entry: CorrectionMemoryEntry): void {
    const normalizedEntry = privacySafeCorrectionMemoryEntry(entry);
    this.db.prepare(`
      INSERT INTO correction_memory (
        id, input_romanized, input_preeti, normalized_input, chosen_output, normalized_output,
        rejected_alternatives_json, context_domain, source, frequency, confidence_at_selection,
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
        context_domain = excluded.context_domain,
        source = excluded.source,
        frequency = excluded.frequency,
        confidence_at_selection = excluded.confidence_at_selection,
        last_used = excluded.last_used,
        pinned = excluded.pinned,
        blocked = excluded.blocked,
        decay_weight = excluded.decay_weight
    `).run(
      normalizedEntry.id,
      normalizedEntry.inputRomanized ?? null,
      normalizedEntry.inputPreeti ?? null,
      normalizedEntry.normalizedInput,
      normalizedEntry.chosenOutput,
      normalizedEntry.normalizedOutput,
      JSON.stringify(normalizedEntry.rejectedAlternatives),
      sanitizedContextDomain(normalizedEntry.context.domain),
      normalizedEntry.source,
      normalizedEntry.frequency,
      normalizedEntry.confidenceAtSelection,
      normalizedEntry.timestamps.firstSeen,
      normalizedEntry.timestamps.lastUsed,
      normalizedEntry.pinned ? 1 : 0,
      normalizedEntry.blocked ? 1 : 0,
      normalizedEntry.decayWeight ?? null
    );
  }
}

function personalDictionaryEntryFromRow(row: SQLiteRow): PersonalDictionaryEntry {
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

function correctionMemoryEntryFromRow(row: SQLiteRow): CorrectionMemoryEntry {
  const domain = sanitizedContextDomain(row.context_domain);
  return {
    id: stringValue(row.id),
    inputRomanized: optionalString(row.input_romanized),
    inputPreeti: optionalString(row.input_preeti),
    normalizedInput: stringValue(row.normalized_input),
    chosenOutput: stringValue(row.chosen_output),
    normalizedOutput: stringValue(row.normalized_output),
    rejectedAlternatives: parseStringArray(row.rejected_alternatives_json),
    context: {
      leftWindow: "",
      rightWindow: "",
      ...(domain ? { domain } : {})
    },
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

function sanitizedContextDomain(value: unknown): string | null {
  return privacySafeCorrectionMemoryDomain(value) ?? null;
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

function asRow(value: unknown): SQLiteRow | undefined {
  return isRecord(value) ? value : undefined;
}

function asRequiredRow(value: unknown): SQLiteRow {
  return asRow(value) ?? {};
}

function isRecord(value: unknown): value is SQLiteRow {
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
