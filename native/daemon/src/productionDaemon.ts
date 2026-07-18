import { homedir } from "node:os";
import { isAbsolute, win32 } from "node:path";
import {
  MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES,
  createKeyboardEngine
} from "../../../src/engine/keyboard";
import type {
  KeyboardCorrectionMemoryStore,
  KeyboardEngine,
  KeyboardSettingsStore,
  PersonalDictionaryStore
} from "../../../src/engine/keyboard";
import { JsonFileKeyboardStorage } from "../../shared/storage/jsonFileStores";
import { SQLiteKeyboardStorage } from "../../shared/storage/sqliteStores";
import { KeyboardDaemon } from "./keyboardDaemon";
import { createDaemonLineHandler } from "./lineProtocol";
import type { DaemonLineHandler } from "./lineProtocol";

export const MAXIMUM_PRELOADED_CORRECTION_MEMORY_ENTRIES = MAXIMUM_STORED_CORRECTION_MEMORY_ENTRIES;
export const DEFAULT_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

export interface DaemonStorageResource {
  settings(): KeyboardSettingsStore;
  personalDictionary(): PersonalDictionaryStore;
  correctionMemory(): KeyboardCorrectionMemoryStore;
  close(): void | Promise<void>;
}

export interface StoredKeyboardDaemonOptions {
  engine?: KeyboardEngine;
  expirySweepIntervalMs?: number;
}

export interface ProductionKeyboardDaemonOptions extends StoredKeyboardDaemonOptions {
  databasePath?: string;
}

export interface DefaultStoragePathOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export async function createProductionKeyboardDaemon(
  options: ProductionKeyboardDaemonOptions = {}
): Promise<KeyboardDaemon> {
  const databasePath = options.databasePath ?? defaultProductionSQLitePath();
  assertProductionDatabasePath(databasePath);
  return createStorageBackedKeyboardDaemon(new SQLiteKeyboardStorage(databasePath), options);
}

export async function createProductionDaemonLineHandler(
  options: ProductionKeyboardDaemonOptions = {}
): Promise<DaemonLineHandler> {
  return createDaemonLineHandler(await createProductionKeyboardDaemon(options));
}

/**
 * Explicit development-only fallback. Production entry points never select
 * JSON automatically when SQLite startup fails.
 */
export async function createDevelopmentJsonKeyboardDaemon(
  jsonPath: string,
  options: StoredKeyboardDaemonOptions = {}
): Promise<KeyboardDaemon> {
  if (!isAbsolute(jsonPath)) {
    throw new Error("Development JSON keyboard storage requires an explicit absolute path.");
  }
  const storage = new JsonFileKeyboardStorage(jsonPath);
  return createStorageBackedKeyboardDaemon({
    settings: () => storage.settings(),
    personalDictionary: () => storage.personalDictionary(),
    correctionMemory: () => storage.correctionMemory(),
    close: () => undefined
  }, options);
}

export async function createStorageBackedKeyboardDaemon(
  storage: DaemonStorageResource,
  options: StoredKeyboardDaemonOptions = {}
): Promise<KeyboardDaemon> {
  const engine = options.engine ?? createKeyboardEngine();
  let handedOff = false;
  let closed = false;
  const closeStorage = async () => {
    if (closed) return;
    await storage.close();
    closed = true;
  };
  try {
    const settings = await storage.settings().getSettings();
    const correctionMemory = storage.correctionMemory();
    const entries = settings.memoryEnabled
      ? await correctionMemory.loadRecent(MAXIMUM_PRELOADED_CORRECTION_MEMORY_ENTRIES)
      : [];
    engine.preloadCorrectionMemory(entries);
    const daemon = new KeyboardDaemon({
      engine,
      persistence: {
        memoryEnabled: settings.memoryEnabled,
        correctionMemory,
        personalDictionary: storage.personalDictionary(),
        close: closeStorage
      },
      expirySweepIntervalMs: options.expirySweepIntervalMs ?? DEFAULT_EXPIRY_SWEEP_INTERVAL_MS
    });
    handedOff = true;
    return daemon;
  } finally {
    if (!handedOff) {
      try {
        await engine.shutdown();
      } finally {
        await closeStorage();
      }
    }
  }
}

export function defaultProductionSQLitePath(options: DefaultStoragePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (platform === "win32") {
    const appData = validAbsoluteWindowsPath(environment.APPDATA);
    if (appData) return win32.join(appData, "Lekh Keyboard", "lekh-keyboard.sqlite3");
    return SQLiteKeyboardStorage.defaultPath("windows", homeDirectory);
  }
  if (platform === "darwin") {
    return SQLiteKeyboardStorage.defaultPath("macos", homeDirectory);
  }
  return SQLiteKeyboardStorage.defaultPath("linux", homeDirectory);
}

function validAbsoluteWindowsPath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 &&
    !value.includes("\0") && win32.isAbsolute(value)
    ? win32.normalize(value)
    : undefined;
}

export function isDevelopmentJsonPath(value: string): boolean {
  return isAbsolute(value) && value.endsWith(".json") && !value.includes("\0") && value.length <= 32_768;
}

function assertProductionDatabasePath(databasePath: string): void {
  if (!isAbsolute(databasePath) || !databasePath.endsWith(".sqlite3") ||
      databasePath.includes("\0") || databasePath.length > 32_768) {
    throw new Error("Production SQLite storage requires an explicit absolute .sqlite3 path.");
  }
}
