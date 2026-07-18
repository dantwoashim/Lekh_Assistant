# Daemon Source

This directory contains the executable local TypeScript daemon used by the Windows TSF path. It owns the engine, per-user SQLite startup, protocol negotiation, epoch-scoped sessions, request ordering, deadlines, diagnostics, and the private-standard-I/O/diagnostic-named-pipe transports.

The Windows transport currently enforces:

- a SID-derived pipe name with no shared fallback or environment-selected endpoint;
- strict UTF-8 newline framing with a 64 KiB frame ceiling;
- at most 16 active connections and 32 queued requests per connection;
- ordered writes with cancellation of work that has not started after disconnect;
- bounded idle time and sanitized transport failures.

`productionDaemon.ts` is the only default daemon bootstrap. It resolves a per-user SQLite path, validates/migrates storage, reads the memory-enabled setting, preloads a bounded correction set outside the typing hot path, and transfers ownership of the database to `KeyboardDaemon`. `memory.learn` uses the engine's opaque prepare/commit transaction: SQLite must durably accept the exact prepared row before live memory changes or the IPC response can say `learned: true`. Personal dictionary lookup is merged deterministically and secure lookups bypass persistent stores.

An unrefed maintenance timer serializes idle expiry behind request dispatch, so client crashes retire protocol identities and raw engine sessions without waiting for a later request. Exact completed retries remain replayable after their original deadline without rerunning work. Shutdown clears that timer, makes an accepted shutdown request a terminal queue barrier, drains earlier request order, clears engine state, and closes SQLite exactly once, including failure paths.

The native broker owns the public Windows pipe and contains this daemon behind private inherited handles. The standalone Node named-pipe mode is a diagnostic and uses the same SQLite lifecycle, but it is not the installed authorization boundary.

Do not move language-engine logic into the TSF DLL or IMK adapter. Native adapters marshal typed protocol messages, mutate host text only through the host API, and fail open.
