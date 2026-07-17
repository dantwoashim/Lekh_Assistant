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
9. Daemon flushes local memory on safe intervals and shutdown.

Keystroke calls must use a hard 50 ms timeout and fail open.
