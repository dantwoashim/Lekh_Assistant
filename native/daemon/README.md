# Lekh Keyboard Daemon

The daemon hosts the shared TypeScript `KeyboardEngine` for the Windows TSF development path, maintains warm/session state, and owns the local IPC protocol boundary. The current macOS IMK hot path uses its in-process Swift engine rather than this daemon.

Prompt 3 adds a repo-executable TypeScript daemon:

- `native/daemon/src/keyboardDaemon.ts`
- `native/daemon/src/keyboardDaemon.test.ts`
- `native/daemon/src/lineProtocol.ts`
- `native/daemon/src/daemonCli.ts`
- `native/daemon/src/namedPipeServer.ts`
- `native/daemon/dist/lekh-keyboard-daemon.mjs`

It handles every IPC message, validates envelopes, tracks diagnostics, exercises timeout fallback, and is covered by `npm run test:native-scaffold`. The standalone Node named-pipe mode remains a development diagnostic. The installed Windows path runs the daemon over private inherited standard-I/O handles behind `LekhPipeBroker.exe`.

Both the installed standard-I/O child and the standalone named-pipe diagnostic use the per-user SQLite adapter. Direct `KeyboardDaemon` and `createDaemonLineHandler()` construction stays storage-free for isolated unit tests; only the production factories resolve a user path. JSON storage requires the explicit development flag shown below and is never an automatic recovery path.

## Responsibilities

- Load and warm the keyboard engine.
- Preload at most 500 deterministic, privacy-projected correction rows before sessions begin.
- Persist `memory.learn` only after the native host's explicit commit confirmation; acknowledge it only after SQLite returns from a durable write, then apply the exact prepared state to live ranking.
- Merge personal SQLite dictionary rows ahead of duplicate built-in rows with a deterministic eight-result cap.
- Maintain proactive timer-driven client/session TTL cleanup even when a crashed client sends no later request; the timer is unrefed and removed on shutdown.
- Serve the IPC messages defined in `native/shared/ipc`.
- Own crash-safe local memory and dictionary storage.
- Return partial warm state when heavy modules are unavailable.
- Never send typed text to the network.
- Expire abandoned negotiated clients and retire their owned engine sessions after the generated 30-minute idle TTL.
- Shut the engine down directly and idempotently after transport queues drain; shutdown does not consume a client slot or depend on protocol negotiation.
- Close the SQLite connection and release its runtime lease during every shutdown path, including engine-shutdown failures.

## Failure Policy

If daemon IPC is unavailable, native input methods must pass through raw keystrokes and surface diagnostics later through the companion app. Host applications must never freeze while waiting for the daemon.

Malformed JSON and engine exceptions receive stable generic wire messages. Raw exception text is not echoed into IPC responses or retained in exported diagnostics.

The native Windows broker owns every public pipe instance. It derives the endpoint name from the current user SID, protects the DACL to the current logon SID plus LocalSystem (falling back to the current user SID for non-interactive tokens without a logon SID), rejects remote clients, verifies the live ACL, and uses first-instance creation. The TSF client also requires the server process to run as the current user and to be the exact `LekhPipeBroker.exe` installed beside the DLL. The daemon never owns the public production pipe.

## Local Commands

- `npm run check:ipc-schema`
- `npm run test:native-scaffold`
- `npm run build:daemon`
- `npm run daemon:dev`
- `npm run daemon:named-pipe` on Windows for transport diagnostics only
- `npm run daemon:dev -- --development-json-storage=/absolute/development-only.json` for an explicit JSON development store
