import type {
  ActivationPhase,
  CompanionLocale,
  CompanionSection
} from "./companionCopy";

export type CompanionLoadState =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: "noBridge" | "readFailure" }
  | { kind: "ready"; status: LekhNativeStatus; preferences: LekhNativePreferences };

export interface CompanionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const applicationIdentifierPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const localeStorageKey = "lekh.companion.locale";
const sectionStorageKey = "lekh.companion.section";

function browserStorage(): CompanionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStorage(storage: CompanionStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: CompanionStorage | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function detectCompanionLocale(storage: CompanionStorage | null = browserStorage()): CompanionLocale {
  const stored = readStorage(storage, localeStorageKey);
  if (stored === "en" || stored === "ne") return stored;
  try {
    return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ne")
      ? "ne"
      : "en";
  } catch {
    return "en";
  }
}

export function detectCompanionSection(storage: CompanionStorage | null = browserStorage()): CompanionSection {
  const stored = readStorage(storage, sectionStorageKey);
  return stored === "privacy" || stored === "updates" ? stored : "typing";
}

export function persistCompanionLocale(
  locale: CompanionLocale,
  storage: CompanionStorage | null = browserStorage()
): boolean {
  return writeStorage(storage, localeStorageKey, locale);
}

export function persistCompanionSection(
  section: CompanionSection,
  storage: CompanionStorage | null = browserStorage()
): boolean {
  return writeStorage(storage, sectionStorageKey, section);
}

export function activationPhase(status: LekhNativeStatus | null): ActivationPhase {
  if (!status?.installed) return "missing";
  if (!status.enabled) return "installed";
  return status.selected ? "selected" : "enabled";
}

export function friendlyApplicationIdentifier(identifier: string): string {
  const parts = identifier.split(".");
  const finalPart = parts[parts.length - 1] ?? identifier;
  return finalPart.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
}

export function normalizeApplicationIdentifiers(identifiers: readonly string[]): string[] | null {
  const unique = Array.from(new Set(identifiers.map((item) => item.trim()).filter(Boolean)));
  return unique.every((item) => applicationIdentifierPattern.test(item)) ? unique : null;
}
