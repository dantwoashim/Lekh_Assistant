import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
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
import {
  normalizeCorrectionMemoryImportEntries,
  normalizeCorrectionMemoryImportEntry
} from "../../../src/engine/memory/importNormalization";
import type { CorrectionMemoryEntry } from "../../../src/engine/memory/types";

export interface NativeKeyboardStorageFile {
  schemaVersion: 1;
  settings: KeyboardSettings;
  personalDictionary: PersonalDictionaryEntry[];
  correctionMemory: CorrectionMemoryEntry[];
  updatedAt: string;
}

export function defaultNativeKeyboardStorageFile(): NativeKeyboardStorageFile {
  return {
    schemaVersion: 1,
    settings: defaultKeyboardSettings(),
    personalDictionary: [],
    correctionMemory: [],
    updatedAt: new Date(0).toISOString()
  };
}

export function nativeKeyboardDataDir(platform: "windows" | "macos" | "linux", homeDir: string): string {
  if (platform === "windows") return win32.join(homeDir, "AppData", "Roaming", "Lekh Keyboard");
  if (platform === "macos") return posix.join(homeDir, "Library", "Application Support", "Lekh Keyboard");
  return posix.join(homeDir, ".local", "share", "lekh-keyboard");
}

export class JsonFileKeyboardStorage {
  constructor(private readonly filePath: string) {
    if (!filePath.endsWith(".json")) {
      throw new Error(`JSON keyboard storage requires an explicit .json path: ${filePath}`);
    }
  }

  settings(): KeyboardSettingsStore {
    return new JsonFileKeyboardSettingsStore(this);
  }

  personalDictionary(): PersonalDictionaryStore {
    return new JsonFilePersonalDictionaryStore(this);
  }

  correctionMemory(): KeyboardCorrectionMemoryStore {
    return new JsonFileCorrectionMemoryStore(this);
  }

  async read(): Promise<NativeKeyboardStorageFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeStorage(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) await this.write(normalized);
      return normalized;
    } catch (error) {
      if (isMissingFileError(error)) return defaultNativeKeyboardStorageFile();
      throw error;
    }
  }

  async write(next: NativeKeyboardStorageFile): Promise<void> {
    const normalized = normalizeStorage({ ...next, updatedAt: new Date().toISOString() });
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const tmpPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flush: true
      });
      if (process.platform !== "win32") await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.filePath);
      if (process.platform !== "win32") await chmod(this.filePath, 0o600);
    } finally {
      await rm(tmpPath, { force: true });
    }
  }
}

export class JsonFileKeyboardSettingsStore implements KeyboardSettingsStore {
  constructor(private readonly storage: JsonFileKeyboardStorage) {}

  async getSettings(): Promise<KeyboardSettings> {
    return (await this.storage.read()).settings;
  }

  async updateSettings(patch: Partial<KeyboardSettings>): Promise<void> {
    const current = await this.storage.read();
    await this.storage.write({
      ...current,
      settings: {
        ...current.settings,
        ...patch,
        telemetryEnabled: false,
        schemaVersion: 1
      }
    });
  }
}

export class JsonFilePersonalDictionaryStore implements PersonalDictionaryStore {
  constructor(private readonly storage: JsonFileKeyboardStorage) {}

  async lookup(query: string): Promise<DictionaryResult[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const current = await this.storage.read();
    return current.personalDictionary
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
        confidence: 0.9
      }));
  }

  async addWord(entry: PersonalDictionaryEntry): Promise<void> {
    const current = await this.storage.read();
    const normalizedEntry = normalizePersonalDictionaryEntry(entry);
    await this.storage.write({
      ...current,
      personalDictionary: [
        ...current.personalDictionary.filter((item) => item.id !== normalizedEntry.id),
        normalizedEntry
      ]
    });
  }

  async removeWord(id: string): Promise<void> {
    const current = await this.storage.read();
    await this.storage.write({
      ...current,
      personalDictionary: current.personalDictionary.filter((entry) => entry.id !== id)
    });
  }

  async export(): Promise<unknown> {
    const current = await this.storage.read();
    return { schemaVersion: 1, entries: clone(current.personalDictionary) };
  }

  async import(data: unknown): Promise<void> {
    if (!isEntryExport<PersonalDictionaryEntry>(data)) return;
    const current = await this.storage.read();
    await this.storage.write({
      ...current,
      personalDictionary: data.entries.map(normalizePersonalDictionaryEntry)
    });
  }
}

export class JsonFileCorrectionMemoryStore implements KeyboardCorrectionMemoryStore {
  constructor(private readonly storage: JsonFileKeyboardStorage) {}

  async record(entry: CorrectionMemoryEntry): Promise<void> {
    const current = await this.storage.read();
    const normalizedEntry = privacySafeCorrectionMemoryEntry(entry);
    await this.storage.write({
      ...current,
      correctionMemory: [
        ...current.correctionMemory.filter((item) => item.id !== normalizedEntry.id),
        normalizedEntry
      ]
    });
  }

  async query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]> {
    if (isSecureContext(context)) return [];
    const normalizedInput = input.trim().toLowerCase();
    if (!normalizedInput) return [];
    const current = await this.storage.read();
    return current.correctionMemory.filter((entry) => entry.normalizedInput.toLowerCase().startsWith(normalizedInput));
  }

  async forget(input: string, chosenOutput?: string): Promise<void> {
    const normalizedInput = input.trim().toLowerCase();
    const normalizedOutput = chosenOutput?.trim().toLowerCase();
    const current = await this.storage.read();
    await this.storage.write({
      ...current,
      correctionMemory: current.correctionMemory.filter((entry) => {
        if (entry.normalizedInput.toLowerCase() !== normalizedInput) return true;
        if (!normalizedOutput) return false;
        return entry.normalizedOutput.toLowerCase() !== normalizedOutput && entry.chosenOutput.trim().toLowerCase() !== normalizedOutput;
      })
    });
  }

  async reset(): Promise<void> {
    const current = await this.storage.read();
    await this.storage.write({ ...current, correctionMemory: [] });
  }

  async export(): Promise<unknown> {
    const current = await this.storage.read();
    return { schemaVersion: 1, entries: clone(current.correctionMemory) };
  }

  async import(data: unknown): Promise<void> {
    if (!isEntryExport<CorrectionMemoryEntry>(data)) return;
    const current = await this.storage.read();
    await this.storage.write({
      ...current,
      correctionMemory: normalizeCorrectionMemoryImportEntries(data.entries, {
        requireTimestamps: true,
        requireKnownSource: true,
        scoringPolicy: "strict",
        minimumFrequency: 0
      })
    });
  }
}

function normalizeStorage(value: unknown): NativeKeyboardStorageFile {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("JSON keyboard storage has an unsupported or malformed schema version.");
  }
  if (!Array.isArray(value.personalDictionary) || !Array.isArray(value.correctionMemory)) {
    throw new Error("JSON keyboard storage contains malformed entry collections.");
  }
  return {
    schemaVersion: 1,
    settings: normalizeKeyboardSettings(value.settings),
    personalDictionary: value.personalDictionary.map(normalizePersonalDictionaryEntry),
    correctionMemory: normalizeCorrectionMemoryImportEntries(value.correctionMemory, {
      requireTimestamps: true,
      requireKnownSource: true,
      scoringPolicy: "strict",
      minimumFrequency: 0
    }),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

export function normalizeKeyboardSettings(value: unknown): KeyboardSettings {
  const defaults = defaultKeyboardSettings();
  const record = isRecord(value) ? value : {};
  const mode = typeof record.defaultMode === "string" && KEYBOARD_MODES.has(record.defaultMode)
    ? record.defaultMode as KeyboardSettings["defaultMode"]
    : defaults.defaultMode;
  const surfaces = Array.isArray(record.enabledSurfaces)
    ? record.enabledSurfaces.filter((item): item is KeyboardSettings["enabledSurfaces"][number] => (
      typeof item === "string" && SUGGESTION_SURFACES.has(item)
    ))
    : defaults.enabledSurfaces;
  const layoutId = optionalBoundedString(record.layoutId, 128);
  return {
    defaultMode: mode,
    enabledSurfaces: [...new Set(surfaces)],
    preserveEnglish: booleanOr(record.preserveEnglish, defaults.preserveEnglish),
    showRomanizedLabels: booleanOr(record.showRomanizedLabels, defaults.showRomanizedLabels),
    enableNextWordPrediction: booleanOr(record.enableNextWordPrediction, defaults.enableNextWordPrediction),
    proofreadAggressiveness: record.proofreadAggressiveness === "balanced" ? "balanced" : "conservative",
    memoryEnabled: booleanOr(record.memoryEnabled, defaults.memoryEnabled),
    telemetryEnabled: false,
    ...(layoutId ? { layoutId } : {}),
    schemaVersion: 1
  };
}

function isEntryExport<T>(value: unknown): value is { schemaVersion: 1; entries: T[] } {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export function normalizePersonalDictionaryEntry(value: unknown): PersonalDictionaryEntry {
  if (!isRecord(value) || value.schemaVersion !== 1 || (value.source !== "user" && value.source !== "import")) {
    throw new Error("JSON keyboard storage contains a malformed personal-dictionary entry.");
  }
  return {
    id: requiredBoundedString(value.id, 256, "personal-dictionary id"),
    word: requiredBoundedString(value.word, 512, "personal-dictionary word"),
    ...(value.romanized === undefined ? {} : { romanized: boundedStringArray(value.romanized, 32, 256) }),
    ...(value.domains === undefined ? {} : { domains: boundedStringArray(value.domains, 32, 128) }),
    source: value.source,
    createdAt: requiredBoundedString(value.createdAt, 64, "personal-dictionary createdAt"),
    updatedAt: requiredBoundedString(value.updatedAt, 64, "personal-dictionary updatedAt"),
    schemaVersion: 1
  };
}

export function privacySafeCorrectionMemoryEntry(value: unknown): CorrectionMemoryEntry {
  if (!isRecord(value) || !CORRECTION_MEMORY_SOURCES.has(String(value.source))) {
    throw new Error("JSON keyboard storage contains a malformed correction-memory entry.");
  }
  return normalizeCorrectionMemoryImportEntry(value, {
    requireTimestamps: true,
    requireKnownSource: true,
    scoringPolicy: "strict",
    minimumFrequency: 0
  });
}

function requiredBoundedString(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`JSON keyboard storage contains an invalid ${label}.`);
  }
  return value;
}

function optionalBoundedString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : undefined;
}

function boundedStringArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => (
    typeof item !== "string" || item.length === 0 || item.length > maximumLength
  ))) {
    throw new Error("JSON keyboard storage contains an invalid bounded string collection.");
  }
  return [...new Set(value)];
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const KEYBOARD_MODES = new Set<string>([
  "romanized",
  "traditional",
  "romanized-romanized",
  "romanized-traditional",
  "traditional-traditional",
  "traditional-romanized",
  "unicode-proofread",
  "dictionary-lookup",
  "diagnostic"
]);

const SUGGESTION_SURFACES = new Set<string>([
  "romanized-to-unicode",
  "romanized-to-romanized",
  "romanized-to-unicode-with-labels",
  "traditional-to-unicode",
  "traditional-to-romanized-helper",
  "traditional-to-traditional-proofread"
]);

const CORRECTION_MEMORY_SOURCES = new Set<string>([
  "user-accept",
  "user-edit",
  "user-add-dictionary",
  "proofread-accept",
  "import"
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
