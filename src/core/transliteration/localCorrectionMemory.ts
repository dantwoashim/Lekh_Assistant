import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import type { Candidate } from "../types";
import { normalizeLatinInput } from "./latinNormalize";

export interface LocalCorrection {
  input: string;
  normalizedInput: string;
  output: string;
  normalizedOutput: string;
  count: number;
  updatedAt: string;
}

export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LOCAL_CORRECTION_KEY = "lekh-keyboard:romanized-corrections:v1";
const MAX_CORRECTIONS = 100;

export function normalizeCorrectionInput(input: string): string {
  return normalizeLatinInput(input).toLowerCase();
}

export function loadLocalCorrections(storage = getBrowserStorage()): LocalCorrection[] {
  if (!storage) return [];

  try {
    const raw = storage.getItem(LOCAL_CORRECTION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocalCorrection[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidCorrection).slice(0, MAX_CORRECTIONS);
  } catch {
    return [];
  }
}

export function recordLocalCorrection(input: string, output: string, storage = getBrowserStorage()): LocalCorrection[] {
  if (!storage) return [];

  const normalizedInput = normalizeCorrectionInput(input);
  const normalizedOutput = normalizeNepaliText(output);
  if (!normalizedInput || !normalizedOutput) return loadLocalCorrections(storage);

  const existing = loadLocalCorrections(storage);
  const previous = existing.find((entry) => entry.normalizedInput === normalizedInput && entry.normalizedOutput === normalizedOutput);
  const nextEntry: LocalCorrection = {
    input: normalizeLatinInput(input),
    normalizedInput,
    output,
    normalizedOutput,
    count: (previous?.count ?? 0) + 1,
    updatedAt: new Date().toISOString()
  };

  const next = [
    nextEntry,
    ...existing.filter((entry) => !(entry.normalizedInput === normalizedInput && entry.normalizedOutput === normalizedOutput))
  ]
    .sort((a, b) => b.count - a.count || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CORRECTIONS);

  storage.setItem(LOCAL_CORRECTION_KEY, JSON.stringify(next));
  return next;
}

export function clearLocalCorrections(storage = getBrowserStorage()) {
  storage?.removeItem(LOCAL_CORRECTION_KEY);
}

export function exportLocalCorrections(storage = getBrowserStorage()): string {
  return JSON.stringify(loadLocalCorrections(storage), null, 2);
}

export function importLocalCorrections(raw: string, storage = getBrowserStorage()): LocalCorrection[] {
  if (!storage) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return loadLocalCorrections(storage);
    const imported = parsed
      .filter(isValidCorrection)
      .map((entry) => ({
        ...entry,
        normalizedInput: normalizeCorrectionInput(entry.input),
        normalizedOutput: normalizeNepaliText(entry.output)
      }))
      .slice(0, MAX_CORRECTIONS);
    storage.setItem(LOCAL_CORRECTION_KEY, JSON.stringify(imported));
    return imported;
  } catch {
    return loadLocalCorrections(storage);
  }
}

export function localCorrectionCandidates(input: string, corrections: LocalCorrection[] = []): Candidate[] {
  const normalizedInput = normalizeCorrectionInput(input);
  return corrections
    .filter((entry) => entry.normalizedInput === normalizedInput)
    .map((entry) => ({
      text: entry.output,
      normalizedText: entry.normalizedOutput,
      score: 1600 + entry.count,
      source: "user-feedback",
      reason: "Local correction memory from this browser"
    }));
}

function getBrowserStorage(): MinimalStorage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function isValidCorrection(value: Partial<LocalCorrection>): value is LocalCorrection {
  return Boolean(
    value &&
      typeof value.input === "string" &&
      typeof value.normalizedInput === "string" &&
      typeof value.output === "string" &&
      typeof value.normalizedOutput === "string" &&
      typeof value.count === "number" &&
      typeof value.updatedAt === "string"
  );
}
