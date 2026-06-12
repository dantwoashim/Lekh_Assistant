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
