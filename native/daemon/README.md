# Lekh Keyboard Daemon

The daemon will host the shared `KeyboardEngine`, maintain warm state, own local storage adapters, and serve Windows TSF, macOS IMK/XPC, and the companion app over local-only IPC.

Prompt 3 adds a repo-executable TypeScript daemon:

- `native/daemon/src/keyboardDaemon.ts`
- `native/daemon/src/keyboardDaemon.test.ts`
- `native/daemon/src/lineProtocol.ts`
- `native/daemon/src/daemonCli.ts`
- `native/daemon/src/namedPipeServer.ts`
- `native/daemon/dist/lekh-keyboard-daemon.mjs`

It handles every IPC message, validates envelopes, tracks diagnostics, exercises timeout fallback, and is covered by `npm run test:native-scaffold`. On Windows, the packaged companion can start it as a separate background process exposing `\\.\pipe\LekhKeyboard` for the TSF service.

## Responsibilities

- Load and warm the keyboard engine.
- Maintain session TTL cleanup.
- Serve the IPC messages defined in `native/shared/ipc`.
- Own crash-safe local memory and dictionary storage.
- Return partial warm state when heavy modules are unavailable.
- Never send typed text to the network.

## Failure Policy

If daemon IPC is unavailable, native input methods must pass through raw keystrokes and surface diagnostics later through the companion app. Host applications must never freeze while waiting for the daemon.

## Local Commands

- `npm run check:ipc-schema`
- `npm run test:native-scaffold`
- `npm run build:daemon`
- `npm run daemon:dev`
- `npm run daemon:named-pipe` on Windows
