# macOS Native Implementation Report

Generated: 2026-06-08

Status: `blocked-external` for production distribution and `blocked-native-environment` for installed IMK validation.

## 2026-06-08 Build Evidence

Repo-executable macOS proof build:

```bash
cd native/macos-imk/skeleton
swift build
```

Result on 2026-06-08: passed with Apple Swift 6.2.3, target `arm64-apple-macosx26.0`.

Native environment check:

```bash
xcodebuild -version
```

Result on 2026-06-08: blocked because `xcodebuild` requires full Xcode, but the active developer directory is `/Library/Developer/CommandLineTools`.

This proves the Swift IMK/XPC decision scaffold builds here. It does not prove an installed `.inputmethod` bundle, because full Xcode, input source registration, Developer ID signing, notarization, and host-app validation are still required.

## What Exists

- Build-ready IMK/XPC proof-spike scaffold under `native/macos-imk/skeleton`.
- Swift package target: `LekhInputMethodPlaceholder`.
- Placeholder key decision logic for:
  - `k`/`K`: set dummy marked text candidate.
  - Enter: commit dummy text.
  - Escape: cancel.
  - XPC unavailable/timed out: pass through.
- XPC contract points at `session.processKeyStroke` with a 50 ms hot-path timeout.
- Dev daemon dispatcher exists in `native/daemon/src/keyboardDaemon.ts`.
- IPC schema validation exists through `npm run check:ipc-schema`.

## What Is Not Claimed

This is not a production macOS input method. It has not been installed under `~/Library/Input Methods/`, enabled in Keyboard settings, signed, notarized, or tested across TextEdit, Safari, Chrome, Pages, VS Code, and Notes during this repo execution.

## External Blocker Proof

Production distribution requires Apple Developer ID signing and notarization. Installed input method behavior also needs manual host-app validation because IMK behavior depends on macOS input source registration, app sandboxing, marked text handling, and XPC launch behavior.

## Exact Dev Build Path

On macOS with Swift 5.9+:

```bash
cd native/macos-imk/skeleton
swift build
swift test
```

Expected proof-spike artifact:

- `.build/debug/LekhInputMethodPlaceholder`

This Swift package validates shared decision logic only. A real IMK bundle must still be created and installed under `~/Library/Input Methods/`.

## Required Production Implementation Steps

1. Create an `.inputmethod` bundle with `IMKInputController`.
2. Register the input source metadata and install under `~/Library/Input Methods/`.
3. Add XPC service `com.lekh.keyboard.EngineXPC` with local-only IPC.
4. Map `KeyboardKeyEvent` into `session.processKeyStroke`.
5. Map `CandidateUpdate.displayText` to marked text.
6. Use `IMKCandidates` for first native candidate UI.
7. Detect secure input and suppress memory/proofread/suggestions.
8. Run test matrix:
   - TextEdit
   - Safari
   - Chrome
   - Pages
   - VS Code
   - Notes
9. Sign with Developer ID, enable hardened runtime, notarize, staple, and verify install/uninstall.

## Owner / Action / Status

| Item | Owner | Status | Next action |
| --- | --- | --- | --- |
| Apple Developer ID | product/release | blocked-external | Acquire certificate and team access. |
| IMK bundle project | engineering | pending | Create after native signing/test path is available. |
| XPC service validation | engineering | blocked-native-environment | Validate on installed macOS input method. |
| Host-app test matrix | QA/engineering | blocked-native-environment | Run after local input method install. |
| Notarized installer | release | blocked-external | Build after Developer ID and IMK validation. |

## Launch Readiness

macOS is not production-launch-ready. It is ready for IMK/XPC proof-spike implementation and installed validation once signing and native test work are available.
