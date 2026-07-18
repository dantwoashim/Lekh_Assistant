import { isSecureContext } from "./modes";
import type { DictionaryResult, TypingContext } from "./types";
import { normalizeCorrectionMemoryImportEntries } from "../memory/importNormalization";
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
  loadRecent(maximumEntries: number): Promise<CorrectionMemoryEntry[]>;
  query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]>;
  forget(input: string, chosenOutput?: string): Promise<void>;
  reset(): Promise<void>;
  export(): Promise<unknown>;
  import(data: unknown): Promise<void>;
}

export const MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES = 500;

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
    const next = installBoundedCorrectionMemoryEntry(this.entries, clone(entry));
    if (!next) throw new Error("Correction memory is full and every retained entry is pinned.");
    this.entries = next;
  }

  async loadRecent(maximumEntries: number): Promise<CorrectionMemoryEntry[]> {
    assertMemoryLoadLimit(maximumEntries);
    return clone(this.entries)
      .sort(compareStoredMemoryEntries)
      .slice(0, maximumEntries);
  }

  async query(input: string, context: TypingContext): Promise<CorrectionMemoryEntry[]> {
    if (isSecureContext(context)) return [];
    const normalizedInput = input.trim().toLowerCase();
    if (!normalizedInput) return [];
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
    this.entries = boundedCorrectionMemoryEntries(normalizeCorrectionMemoryImportEntries(data.entries, {
      requireTimestamps: true,
      requireKnownSource: true,
      scoringPolicy: "strict",
      minimumFrequency: 0
    }));
  }
}

function isPersonalDictionaryExport(data: unknown): data is { schemaVersion: 1; entries: PersonalDictionaryEntry[] } {
  return typeof data === "object" && data !== null && Array.isArray((data as { entries?: unknown }).entries);
}

function isCorrectionMemoryExport(data: unknown): data is { schemaVersion: 1; entries: CorrectionMemoryEntry[] } {
  return typeof data === "object" && data !== null &&
    (data as { schemaVersion?: unknown }).schemaVersion === 1 &&
    Array.isArray((data as { entries?: unknown }).entries);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertMemoryLoadLimit(maximumEntries: number): void {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 ||
      maximumEntries > MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES) {
    throw new Error(
      `Correction-memory preload limit must be a safe integer from 1 through ${MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES}.`
    );
  }
}

export function boundedCorrectionMemoryEntries(
  entries: readonly CorrectionMemoryEntry[]
): CorrectionMemoryEntry[] {
  return entries.slice().sort(compareStoredMemoryEntries)
    .slice(0, MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES);
}

/**
 * Installs a just-confirmed correction without evicting a pinned entry. The
 * new row is retained so a successful durable record can be mirrored exactly
 * by the live engine. `undefined` means all available capacity is pinned.
 */
export function installBoundedCorrectionMemoryEntry(
  entries: readonly CorrectionMemoryEntry[],
  entry: CorrectionMemoryEntry
): CorrectionMemoryEntry[] | undefined {
  const existingIndex = entries.findIndex((item) => item.id === entry.id);
  if (existingIndex >= 0) {
    const next = entries.slice();
    next[existingIndex] = entry;
    return next;
  }
  if (entries.length < MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES) {
    return [...entries, entry];
  }

  let evictionIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]!.pinned) continue;
    if (evictionIndex < 0 || compareStoredMemoryEntries(entries[index]!, entries[evictionIndex]!) > 0) {
      evictionIndex = index;
    }
  }
  if (evictionIndex < 0) return undefined;
  return [
    ...entries.slice(0, evictionIndex),
    ...entries.slice(evictionIndex + 1),
    entry
  ];
}

export function compareStoredMemoryEntries(left: CorrectionMemoryEntry, right: CorrectionMemoryEntry): number {
  return Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
    right.frequency - left.frequency ||
    compareCodeUnits(right.timestamps.lastUsed, left.timestamps.lastUsed) ||
    compareCodeUnits(left.id, right.id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
