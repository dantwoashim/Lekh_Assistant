# Native Storage

Native storage is local-only and user-scoped.

Planned locations:

- Windows: `%APPDATA%/Lekh Keyboard/`
- macOS: `~/Library/Application Support/Lekh Keyboard/`

Prompt 3 defines storage contracts in `src/engine/keyboard/storage.ts` and adds repo-executable local adapters in:

- `native/shared/storage/jsonFileStores.ts`
- `native/shared/storage/jsonFileStores.test.ts`
- `native/shared/storage/sqliteStores.ts`
- `native/shared/storage/sqliteStores.test.ts`

The SQLite adapter is the production path for user lexicon and correction memory. It uses a per-user local database under `~/Library/Application Support/Lekh Keyboard/` on macOS, enables WAL mode, never enables telemetry, and suppresses correction-memory reads in secure/password/code contexts. Browser Keyboard Lab may use in-memory or browser-local adapters. Secure fields must not record correction memory.

Persistence invariants:

- SQLite schema changes advance both `PRAGMA user_version` and the singleton `storage_metadata` record.
- Schema v3 rebuilds schema-v2 correction memory from canonical input/output/domain semantics. It discards caller-supplied legacy IDs, merges duplicate ranking rows without frequency amplification, and leaves settings and personal-dictionary tables untouched.
- Migrations run transactionally on an integrity-checked private staging copy. Fixed staging and backup paths make every rename crash point recoverable on the next startup; the original is removed only after the promoted database has been reopened and validated.
- Migration locks carry an owner PID and random token. A live owner is never displaced because a wall-clock timeout elapsed; valid owner records are removed only when their token matches, while an incomplete record must age past the recovery threshold.
- Every `SQLiteKeyboardStorage` connection holds a lifetime lease. A schema migration refuses to replace a database while another supported process can still write through an older inode; crashed-process leases are reclaimed before startup.
- After a truncating WAL checkpoint, migration takes an exclusive SQLite write transaction and rechecks that no WAL frame appeared in the checkpoint-to-lock gap before copying.
- Startup rejects corrupt databases and schema versions newer than the running build. It never silently replaces or downgrades them.
- Current schema validation uses a closed-world table, index, view, trigger, column, and metadata inventory so hidden legacy data or executable schema cannot ride through an upgrade.
- SQLite, WAL, lock, lease, backup, staging, and JSON files use private per-user permissions where the platform supports POSIX modes.
- Correction memory persists the accepted input/output and an optional bounded domain classification, but never surrounding left/right sentence windows.
- `JsonFileKeyboardStorage` is a development fallback and accepts only an explicit `.json` path. It cannot write a JSON document under a `.sqlite3` filename, rejects future schemas without rewriting them, and projects every accepted record onto a bounded privacy-safe shape.
