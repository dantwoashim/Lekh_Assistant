# Windows Native Implementation Report

Generated: 2026-06-08

Status: `blocked-native-environment`

## 2026-06-08 Environment Evidence

Repo-executable native scaffold tests:

```bash
npm run test:native-scaffold
```

Result on 2026-06-08: passed, covering IPC message contracts, daemon dispatcher behavior, and native storage JSON-file stores.

Windows TSF build environment check:

```bash
cmake --version
```

Result on 2026-06-08: blocked in this environment because `cmake` is not installed and this host is not a Windows TSF host with Visual Studio/MSBuild. The exact Windows dev build path below remains the required next action on a Windows machine.

## What Exists

- Build-ready TSF proof-spike scaffold under `native/windows-tsf/skeleton`.
- CMake target: `LekhTextServicePlaceholder`.
- Placeholder key decision logic for:
  - `k`/`K`: start dummy composition candidate.
  - Enter: commit dummy candidate.
  - Escape: cancel composition.
  - daemon unavailable: pass through.
- IPC contract points at `session.processKeyStroke` over a per-user named pipe with a 50 ms hot-path timeout.
- Dev daemon dispatcher exists in `native/daemon/src/keyboardDaemon.ts`.
- IPC schema validation exists through `npm run check:ipc-schema`.

## What Is Not Claimed

This is not a production Windows IME. It has not been registered as a Windows Text Services Framework text service in this execution environment, and it has not been tested in Notepad, Word, Chrome, Edge, VS Code, Excel, or government web forms.

## External Blocker Proof

The current execution environment is macOS/Linux-style Node/Vite workspace execution, not a Windows TSF host. A real TSF text service requires Windows COM/TSF registration, app-host testing, and a Windows code-signing/install path. Those cannot be completed inside this repo execution without a Windows native test machine and certificate.

## Exact Dev Build Path

On Windows with Visual Studio Build Tools and CMake:

```powershell
cd native\windows-tsf\skeleton
cmake -S . -B build -G "Visual Studio 17 2022"
cmake --build build --config Debug
```

Expected proof-spike artifact:

- `build\Debug\LekhTextServicePlaceholder.dll`

This artifact is scaffold-only until COM registration, TSF profile registration, and host-app tests are implemented.

## Required Production Implementation Steps

1. Implement `ITfTextInputProcessor` and `ITfKeyEventSink`.
2. Register/unregister CLSID and language profile per user.
3. Create a composition manager that maps `CandidateUpdate.displayText` to TSF composition text.
4. Create native candidate UI for `CandidateUpdate.candidates`.
5. Add named pipe client with per-user ACL, 50 ms timeout, reconnect, and pass-through fallback.
6. Detect password/secure input scope and disable memory/proofread/suggestions.
7. Run test matrix:
   - Notepad
   - Word
   - Chrome
   - Edge
   - VS Code
   - Excel
   - government web form
8. Build signed MSI installer and verify uninstall cleanup.

## Owner / Action / Status

| Item | Owner | Status | Next action |
| --- | --- | --- | --- |
| Windows TSF native build machine | engineering | blocked-native-environment | Run CMake proof spike on Windows. |
| Code-signing certificate | product/release | blocked-external | Acquire Windows code-signing certificate. |
| TSF COM registration | engineering | pending | Implement after Windows environment is available. |
| Host-app test matrix | QA/engineering | blocked-native-environment | Run after the TSF DLL registers locally. |
| Signed installer | release | blocked-external | Build after certificate and TSF validation. |

## Launch Readiness

Windows is not production-launch-ready. It is ready for native Windows proof-spike implementation and validation once the external/native blockers are resolved.
