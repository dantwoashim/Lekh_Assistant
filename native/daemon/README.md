# Lekh Keyboard Daemon

The daemon hosts the shared TypeScript `KeyboardEngine` for the Windows TSF development path, maintains warm/session state, and owns the local IPC protocol boundary. The current macOS IMK hot path uses its in-process Swift engine rather than this daemon.

Prompt 3 adds a repo-executable TypeScript daemon:

- `native/daemon/src/keyboardDaemon.ts`
- `native/daemon/src/keyboardDaemon.test.ts`
- `native/daemon/src/lineProtocol.ts`
- `native/daemon/src/daemonCli.ts`
- `native/daemon/src/namedPipeServer.ts`
- `native/daemon/dist/lekh-keyboard-daemon.mjs`

It handles every IPC message, validates envelopes, tracks diagnostics, exercises timeout fallback, and is covered by `npm run test:native-scaffold`. On Windows, named-pipe development mode derives `\\.\pipe\LekhKeyboard-{current-user-SID}` and refuses to start if the SID cannot be resolved.

## Responsibilities

- Load and warm the keyboard engine.
- Maintain session TTL cleanup.
- Serve the IPC messages defined in `native/shared/ipc`.
- Own crash-safe local memory and dictionary storage.
- Return partial warm state when heavy modules are unavailable.
- Never send typed text to the network.

## Failure Policy

If daemon IPC is unavailable, native input methods must pass through raw keystrokes and surface diagnostics later through the companion app. Host applications must never freeze while waiting for the daemon.

The Node listener does not yet prove an explicit user-only Windows DACL. Production authorization remains blocked until the native pipe owner creates every instance with a verified security descriptor and the TSF client verifies that server's installed identity.

## Local Commands

- `npm run check:ipc-schema`
- `npm run test:native-scaffold`
- `npm run build:daemon`
- `npm run daemon:dev`
- `npm run daemon:named-pipe` on Windows
