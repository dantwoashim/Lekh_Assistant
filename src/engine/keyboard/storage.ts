import { isSecureContext } from "./modes";
import type { DictionaryResult, TypingContext } from "./types";
import type { CorrectionMemoryEntry } from "../memory/types";

export interface KeyboardSettings {
  defaultMode: TypingContext["mode"];
  enabledSurfaces: TypingContext["enabledSurfaces"];
  preserveEnglish: boolean;
  showRomanizedLabels: boolean;
  enableNextWordPrediction: boolean;
  proofreadAggressiveness: "conservative" | "balanced";
  memoryEnabled: boolean;
  telemetryEnabled: false;
  layoutId?: string;
  schemaVersion: 1;
}

export interface PersonalDictionaryEntry {
  id: string;
  word: string;
  romanized?: string[];
  domains?: string[];
  source: "user" | "import";
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface KeyboardSettingsStore {
  getSettings(): Promise<KeyboardSettings>;
  updateSettings(patch: Partial<KeyboardSettings>): Promise<void>;
}

export interface PersonalDictionaryStore {
  lookup(query: string): Promise<DictionaryResult[]>;
  addWord(entry: PersonalDictionaryEntry): Promise<void>;
  removeWord(id: string): Promise<void>;
  export(): Promise<unknown>;
  import(data: unknown): Promise<void>;
}

export interface KeyboardCorrectionMemoryStore {
  record(entry: CorrectionMemoryEntry): Promise<void>;
  query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]>;
  forget(input: string, chosenOutput?: string): Promise<void>;
  reset(): Promise<void>;
  export(): Promise<unknown>;
  import(data: unknown): Promise<void>;
}

export function defaultKeyboardSettings(): KeyboardSettings {
  return {
    defaultMode: "romanized",
    enabledSurfaces: ["romanized-to-unicode", "romanized-to-romanized", "romanized-to-unicode-with-labels"],
    preserveEnglish: true,
    showRomanizedLabels: false,
    enableNextWordPrediction: true,
    proofreadAggressiveness: "conservative",
    memoryEnabled: true,
    telemetryEnabled: false,
    schemaVersion: 1
  };
}

export class InMemoryKeyboardSettingsStore implements KeyboardSettingsStore {
  private settings: KeyboardSettings;

  constructor(initial: KeyboardSettings = defaultKeyboardSettings()) {
    this.settings = clone(initial);
  }

  async getSettings(): Promise<KeyboardSettings> {
    return clone(this.settings);
  }

  async updateSettings(patch: Partial<KeyboardSettings>): Promise<void> {
    this.settings = { ...this.settings, ...clone(patch), telemetryEnabled: false, schemaVersion: 1 };
  }
}

export class InMemoryPersonalDictionaryStore implements PersonalDictionaryStore {
  private entries: PersonalDictionaryEntry[] = [];

  async lookup(query: string): Promise<DictionaryResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    return this.entries
      .filter((entry) => {
        const aliases = entry.romanized?.map((value) => value.toLowerCase()) ?? [];
        return entry.word === query || entry.word.startsWith(query) || aliases.some((alias) => alias.startsWith(normalizedQuery));
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
    this.entries = [...this.entries.filter((item) => item.id !== entry.id), clone(entry)];
  }

  async removeWord(id: string): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  }

  async export(): Promise<unknown> {
    return { schemaVersion: 1, entries: clone(this.entries) };
  }

  async import(data: unknown): Promise<void> {
    if (!isPersonalDictionaryExport(data)) return;
    this.entries = clone(data.entries);
  }
}

export class InMemoryKeyboardCorrectionMemoryStore implements KeyboardCorrectionMemoryStore {
  private entries: CorrectionMemoryEntry[] = [];

  async record(entry: CorrectionMemoryEntry): Promise<void> {
    this.entries = [...this.entries.filter((item) => item.id !== entry.id), clone(entry)];
  }

  async query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]> {
    if (isSecureContext(context)) return [];
    const normalizedInput = input.trim().toLowerCase();
    return this.entries.filter((entry) => entry.normalizedInput.toLowerCase().startsWith(normalizedInput));
  }

  async forget(input: string, chosenOutput?: string): Promise<void> {
    const normalizedInput = input.trim().toLowerCase();
    const normalizedOutput = chosenOutput?.trim().toLowerCase();
    this.entries = this.entries.filter((entry) => {
      if (entry.normalizedInput.toLowerCase() !== normalizedInput) return true;
      if (!normalizedOutput) return false;
      return entry.normalizedOutput.toLowerCase() !== normalizedOutput && entry.chosenOutput.trim().toLowerCase() !== normalizedOutput;
    });
  }

  async reset(): Promise<void> {
    this.entries = [];
  }

  async export(): Promise<unknown> {
    return { schemaVersion: 1, entries: clone(this.entries) };
  }

  async import(data: unknown): Promise<void> {
    if (!isCorrectionMemoryExport(data)) return;
    this.entries = clone(data.entries);
  }
}

function isPersonalDictionaryExport(data: unknown): data is { schemaVersion: 1; entries: PersonalDictionaryEntry[] } {
  return typeof data === "object" && data !== null && Array.isArray((data as { entries?: unknown }).entries);
}

function isCorrectionMemoryExport(data: unknown): data is { schemaVersion: 1; entries: CorrectionMemoryEntry[] } {
  return typeof data === "object" && data !== null && Array.isArray((data as { entries?: unknown }).entries);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
