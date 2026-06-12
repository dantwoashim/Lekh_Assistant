import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  if (platform === "windows") return join(homeDir, "AppData", "Roaming", "Lekh Keyboard");
  if (platform === "macos") return join(homeDir, "Library", "Application Support", "Lekh Keyboard");
  return join(homeDir, ".local", "share", "lekh-keyboard");
}

export class JsonFileKeyboardStorage {
  constructor(private readonly filePath: string) {}

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
      return normalizeStorage(JSON.parse(raw));
    } catch (error) {
      if (isMissingFileError(error)) return defaultNativeKeyboardStorageFile();
      throw error;
    }
  }

  async write(next: NativeKeyboardStorageFile): Promise<void> {
    const normalized = normalizeStorage({ ...next, updatedAt: new Date().toISOString() });
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
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
    await this.storage.write({
      ...current,
      personalDictionary: [...current.personalDictionary.filter((item) => item.id !== entry.id), clone(entry)]
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
    await this.storage.write({ ...current, personalDictionary: clone(data.entries) });
  }
}

export class JsonFileCorrectionMemoryStore implements KeyboardCorrectionMemoryStore {
  constructor(private readonly storage: JsonFileKeyboardStorage) {}

  async record(entry: CorrectionMemoryEntry): Promise<void> {
    const current = await this.storage.read();
    await this.storage.write({
      ...current,
      correctionMemory: [...current.correctionMemory.filter((item) => item.id !== entry.id), clone(entry)]
    });
  }

  async query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]> {
    if (context.secureInput || context.fieldType === "password" || context.fieldType === "code") return [];
    const normalizedInput = input.trim().toLowerCase();
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
    await this.storage.write({ ...current, correctionMemory: clone(data.entries) });
  }
}

function normalizeStorage(value: unknown): NativeKeyboardStorageFile {
  if (!isRecord(value)) return defaultNativeKeyboardStorageFile();
  return {
    schemaVersion: 1,
    settings: normalizeSettings(value.settings),
    personalDictionary: Array.isArray(value.personalDictionary) ? clone(value.personalDictionary) : [],
    correctionMemory: Array.isArray(value.correctionMemory) ? clone(value.correctionMemory) : [],
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

function normalizeSettings(value: unknown): KeyboardSettings {
  return {
    ...defaultKeyboardSettings(),
    ...(isRecord(value) ? value : {}),
    telemetryEnabled: false,
    schemaVersion: 1
  };
}

function isEntryExport<T>(value: unknown): value is { schemaVersion: 1; entries: T[] } {
  return isRecord(value) && Array.isArray(value.entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
