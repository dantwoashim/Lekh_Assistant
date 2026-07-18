# Daemon Protocol

The daemon protocol is the IPC contract in `native/shared/ipc`.

Lifecycle:

1. On Windows, the companion starts the native broker at login.
2. The broker contains the daemon behind private handles and completes `protocol.negotiate` before exposing its protected pipe.
3. Each TSF client performs its own `protocol.negotiate` sequence.
4. Native input shell calls `engine.warm` with a short timeout.
5. Native input shell begins a session for each focused editable field.
6. Keystrokes use `session.processKeyStroke`.
7. Browser-style composition uses `session.updateComposition`.
8. Candidate actions use commit/cancel/end messages.
9. After the host successfully applies a candidate edit, it sends the one-time `memory.learn` receipt.
10. Daemon prepares the exact next memory row without mutating ranking, durably writes it to per-user SQLite, commits the prepared engine transaction, then acknowledges `learned: true`.
11. An unrefed maintenance timer expires abandoned client and session state without requiring another request.
12. Daemon clears engine state, closes SQLite, and releases the runtime lease on shutdown.

Keystroke calls must use a hard 50 ms timeout and fail open.
