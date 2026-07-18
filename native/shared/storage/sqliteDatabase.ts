import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import {
  assertCurrentSQLiteSchema,
  assertSupportedSQLiteVersion,
  CURRENT_SQLITE_SCHEMA_VERSION,
  migrateSQLiteDatabase,
  sqliteUserVersion
} from "./sqliteMigrations";
import type { SQLiteDatabase, SQLiteModule, SQLiteRow } from "./sqliteTypes";

const require = createRequire(import.meta.url);
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");
const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
const STALE_MIGRATION_LOCK_MS = 30_000;

export function prepareSQLiteDatabase(dbPath: string): SQLiteDatabase {
  preparePrivateDirectory(dirname(dbPath));
  return withMigrationLock(dbPath, () => {
    cleanupDeadRuntimeLeases(dbPath);
    recoverInterruptedMigration(dbPath);
    if (existsSync(dbPath)) {
      restrictDatabaseFiles(dbPath);
      assertSQLiteFileHeader(dbPath);
    }

    const current = existsSync(dbPath) ? openDatabase(dbPath) : undefined;
    if (current) {
      try {
        configurePreflightConnection(current);
        assertDatabaseIntegrity(current, dbPath);
        const version = sqliteUserVersion(current);
        assertSupportedSQLiteVersion(version, dbPath);
        if (version === CURRENT_SQLITE_SCHEMA_VERSION) {
          assertCurrentSQLiteSchema(current, dbPath);
          configureRuntimeConnection(current);
          restrictDatabaseFiles(dbPath);
          return attachRuntimeLease(dbPath, current);
        }
        assertNoActiveRuntimeLeases(dbPath);
        checkpointForMigration(current, dbPath);
        current.exec("BEGIN EXCLUSIVE");
        assertNoPendingWal(dbPath);
      } catch (error) {
        current.close();
        throw error;
      }
      return attachRuntimeLease(dbPath, migrateOnStagingCopy(dbPath, true, current));
    }

    assertNoActiveRuntimeLeases(dbPath);
    return attachRuntimeLease(dbPath, migrateOnStagingCopy(dbPath, false));
  });
}

function migrateOnStagingCopy(dbPath: string, sourceExists: boolean, lockedSource?: SQLiteDatabase): SQLiteDatabase {
  const stagingPath = migrationStagingPath(dbPath);
  const backupPath = migrationBackupPath(dbPath);
  let promoted = false;

  try {
    if (sourceExists) {
      copyFileSync(dbPath, stagingPath, constants.COPYFILE_EXCL);
      restrictFile(stagingPath);
    }

    const staging = openDatabase(stagingPath);
    try {
      configureStagingConnection(staging);
      migrateSQLiteDatabase(staging);
      staging.exec("VACUUM");
      assertDatabaseIntegrity(staging, stagingPath);
      assertCurrentSQLiteSchema(staging, stagingPath);
    } finally {
      staging.close();
    }

    const sourceToRelease = lockedSource;
    lockedSource = undefined;
    releaseLockedMigrationSource(sourceToRelease);
    removeSQLiteSidecars(dbPath);
    if (sourceExists) {
      renameSync(dbPath, backupPath);
      restrictFile(backupPath);
      syncParentDirectory(dbPath);
    }
    try {
      renameSync(stagingPath, dbPath);
      promoted = true;
      restrictFile(dbPath);
      syncParentDirectory(dbPath);
      let database: SQLiteDatabase | undefined;
      try {
        database = openDatabase(dbPath);
        configurePreflightConnection(database);
        assertDatabaseIntegrity(database, dbPath);
        assertCurrentSQLiteSchema(database, dbPath);
        configureRuntimeConnection(database);
        restrictDatabaseFiles(dbPath);
        if (sourceExists) {
          rmSync(backupPath, { force: true });
          syncParentDirectory(dbPath);
        }
        return database;
      } catch (error) {
        database?.close();
        throw error;
      }
    } catch (error) {
      removeSQLiteSidecars(dbPath);
      if (promoted) rmSync(dbPath, { force: true });
      if (sourceExists && existsSync(backupPath)) {
        renameSync(backupPath, dbPath);
        syncParentDirectory(dbPath);
      }
      throw new Error(`SQLite keyboard storage migration could not be promoted safely: ${dbPath}`, { cause: error });
    }
  } catch (error) {
    if (!promoted) rmSync(stagingPath, { force: true });
    if (sourceExists && existsSync(backupPath) && !existsSync(dbPath)) {
      renameSync(backupPath, dbPath);
      syncParentDirectory(dbPath);
    }
    throw error;
  } finally {
    const sourceToRelease = lockedSource;
    lockedSource = undefined;
    releaseLockedMigrationSource(sourceToRelease);
    rmSync(stagingPath, { force: true });
    removeSQLiteSidecars(stagingPath);
    if (existsSync(dbPath)) restrictDatabaseFiles(dbPath);
  }
}

function releaseLockedMigrationSource(database: SQLiteDatabase | undefined): void {
  if (!database) return;
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

function openDatabase(dbPath: string): SQLiteDatabase {
  try {
    const sqlite = require("node:sqlite") as SQLiteModule;
    return new sqlite.DatabaseSync(dbPath);
  } catch (error) {
    if (error instanceof Error && /No such built-in module: node:sqlite/.test(error.message)) {
      throw new Error(
        "SQLite keyboard storage requires a Node.js runtime with node:sqlite. " +
        "Use JsonFileKeyboardStorage with an explicit .json path for development fallback storage.",
        { cause: error }
      );
    }
    throw error;
  }
}

function configurePreflightConnection(db: SQLiteDatabase): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
  `);
}

function configureStagingConnection(db: SQLiteDatabase): void {
  configurePreflightConnection(db);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
  `);
}

function configureRuntimeConnection(db: SQLiteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 5000;
  `);
}

function checkpointForMigration(db: SQLiteDatabase, label: string): void {
  const result = optionalRow(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
  if (numberValue(result?.busy, 1) !== 0) {
    throw new Error(`SQLite keyboard storage migration cannot safely checkpoint an active database: ${label}`);
  }
}

function assertDatabaseIntegrity(db: SQLiteDatabase, label: string): void {
  const messages = db.prepare("PRAGMA integrity_check").all()
    .map(asRow)
    .flatMap((row) => Object.values(row))
    .filter((value): value is string => typeof value === "string");
  if (messages.length !== 1 || messages[0] !== "ok") {
    throw new Error(`SQLite keyboard storage integrity check failed for ${label}: ${messages.join("; ") || "no result"}`);
  }
}

function migrationStagingPath(dbPath: string): string {
  return `${dbPath}.migration`;
}

function migrationBackupPath(dbPath: string): string {
  return `${dbPath}.backup`;
}

function recoverInterruptedMigration(dbPath: string): void {
  const stagingPath = migrationStagingPath(dbPath);
  const backupPath = migrationBackupPath(dbPath);
  if (existsSync(backupPath)) {
    restrictFile(backupPath);
    if (!existsSync(dbPath)) {
      removeSQLiteSidecars(dbPath);
      renameSync(backupPath, dbPath);
      restrictFile(dbPath);
      syncParentDirectory(dbPath);
    } else {
      const state = inspectPromotedDatabase(dbPath);
      if (state === "current") {
        rmSync(backupPath, { force: true });
        syncParentDirectory(dbPath);
      } else if (state === "invalid") {
        assertNoActiveRuntimeLeases(dbPath);
        removeSQLiteSidecars(dbPath);
        rmSync(dbPath, { force: true });
        renameSync(backupPath, dbPath);
        restrictFile(dbPath);
        syncParentDirectory(dbPath);
      } else {
        // A newer build owns the current database. This build must not restore
        // an older backup or delete recovery material it cannot understand.
        return;
      }
    }
  }

  rmSync(stagingPath, { force: true });
  removeSQLiteSidecars(stagingPath);
}

function inspectPromotedDatabase(dbPath: string): "current" | "future" | "invalid" {
  let database: SQLiteDatabase | undefined;
  try {
    assertSQLiteFileHeader(dbPath);
    database = openDatabase(dbPath);
    configurePreflightConnection(database);
    assertDatabaseIntegrity(database, dbPath);
    const version = sqliteUserVersion(database);
    if (version > CURRENT_SQLITE_SCHEMA_VERSION) return "future";
    if (version !== CURRENT_SQLITE_SCHEMA_VERSION) return "invalid";
    assertCurrentSQLiteSchema(database, dbPath);
    return "current";
  } catch {
    return "invalid";
  } finally {
    database?.close();
  }
}

function assertNoPendingWal(dbPath: string): void {
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath) && statSync(walPath).size !== 0) {
    throw new Error(`SQLite keyboard storage migration detected a write after checkpoint: ${dbPath}`);
  }
}

function runtimeLeasePaths(dbPath: string): string[] {
  const directory = dirname(dbPath);
  const prefix = `${basename(dbPath)}.runtime-`;
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".lease"))
    .map((name) => join(directory, name));
}

function cleanupDeadRuntimeLeases(dbPath: string): void {
  for (const leasePath of runtimeLeasePaths(dbPath)) {
    const record = readOwnershipRecord(leasePath);
    if (record) {
      if (!isProcessAlive(record.pid)) removeOwnedFile(leasePath, record.token);
      continue;
    }
    if (isOlderThan(leasePath, STALE_MIGRATION_LOCK_MS)) rmSync(leasePath, { force: true });
  }
}

function assertNoActiveRuntimeLeases(dbPath: string): void {
  cleanupDeadRuntimeLeases(dbPath);
  const active = runtimeLeasePaths(dbPath);
  if (active.length > 0) {
    throw new Error(
      `SQLite keyboard storage migration refused while ${active.length} runtime connection lease(s) are active: ${dbPath}`
    );
  }
}

function attachRuntimeLease(dbPath: string, database: SQLiteDatabase): SQLiteDatabase {
  const token = randomUUID();
  const leasePath = `${dbPath}.runtime-${process.pid}-${token}.lease`;
  let descriptor: number | undefined;
  try {
    descriptor = createOwnershipFile(leasePath, token);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue ownership cleanup and preserve the original failure.
      }
    }
    removeOwnedFile(leasePath, token);
    try {
      database.close();
    } catch {
      // Preserve the lease-creation failure.
    }
    throw error;
  }

  let closed = false;
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(sql);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        removeOwnedFile(leasePath, token);
      }
    }
  };
}

interface OwnershipRecord {
  pid: number;
  token: string;
}

function createOwnershipFile(filePath: string, token: string): number {
  const descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const payload = Buffer.from(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), "utf8");
    if (writeSync(descriptor, payload, 0, payload.length) !== payload.length) {
      throw new Error(`Could not write complete SQLite ownership record: ${filePath}`);
    }
    fsyncSync(descriptor);
    restrictFile(filePath);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    rmSync(filePath, { force: true });
    throw error;
  }
}

function readOwnershipRecord(filePath: string): OwnershipRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        typeof value.token !== "string" || value.token.length < 16) {
      return undefined;
    }
    return { pid: value.pid, token: value.token };
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function removeOwnedFile(filePath: string, token: string): void {
  const record = readOwnershipRecord(filePath);
  if (record?.token === token) rmSync(filePath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function isOlderThan(filePath: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(filePath).mtimeMs > ageMs;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function withMigrationLock<T>(dbPath: string, operation: () => T): T {
  const lockPath = `${dbPath}.migration.lock`;
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  const token = randomUUID();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = createOwnershipFile(lockPath, token);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (reclaimAbandonedLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for SQLite keyboard storage migration lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  try {
    return operation();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      removeOwnedFile(lockPath, token);
    }
  }
}

function reclaimAbandonedLock(lockPath: string): boolean {
  const record = readOwnershipRecord(lockPath);
  if (record) {
    if (isProcessAlive(record.pid)) return false;
    removeOwnedFile(lockPath, record.token);
    return !existsSync(lockPath);
  }
  if (!isOlderThan(lockPath, STALE_MIGRATION_LOCK_MS)) return false;
  rmSync(lockPath, { force: true });
  return !existsSync(lockPath);
}

function preparePrivateDirectory(directory: string): void {
  const createdDirectory = mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Never change permissions on an arbitrary pre-existing parent supplied by
  // a caller. Newly created app-owned directories are private; database and
  // sidecar files are restricted independently in every case.
  if (process.platform !== "win32" && createdDirectory !== undefined) chmodSync(directory, 0o700);
}

function syncParentDirectory(filePath: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(filePath), constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // SQLite FULL synchronous mode protects file contents. Some filesystems do
    // not permit directory fsync, so this remains a best-effort metadata fence.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function restrictDatabaseFiles(dbPath: string): void {
  restrictFile(dbPath);
  restrictFile(`${dbPath}-wal`);
  restrictFile(`${dbPath}-shm`);
}

function restrictFile(filePath: string): void {
  if (process.platform !== "win32" && existsSync(filePath)) chmodSync(filePath, 0o600);
}

function removeSQLiteSidecars(dbPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

function assertSQLiteFileHeader(filePath: string): void {
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const descriptor = openSync(filePath, constants.O_RDONLY);
  try {
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== SQLITE_HEADER.length || !header.equals(SQLITE_HEADER)) {
      throw new Error(`SQLite keyboard storage rejected a non-SQLite or truncated file without modifying it: ${filePath}`);
    }
  } finally {
    closeSync(descriptor);
  }
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

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
