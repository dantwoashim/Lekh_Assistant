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

- Build-ready TSF DLL source under `native/windows-tsf/skeleton`.
- CMake target: `LekhTextService`.
- COM DLL exports:
  - `DllGetClassObject`
  - `DllCanUnloadNow`
  - `DllRegisterServer`
  - `DllUnregisterServer`
- TSF interfaces:
  - `ITfTextInputProcessor`
  - `ITfTextInputProcessorEx`
  - `ITfKeyEventSink`
- Per-user COM registration under `HKCU\Software\Classes`.
- TSF language profile registration for Nepali.
- Named-pipe IPC client for the local daemon, deriving a per-user name such as `\\.\pipe\LekhKeyboard-{SID}` and failing open if the current-user SID cannot be resolved. Production code accepts neither an environment-selected pipe nor a shared fallback name; controlled tests inject an explicit pipe through the client/server constructors.
- 50 ms hot-path timeout and pass-through fallback when the daemon is unavailable.
- Key-eating is disabled by default and must be explicitly enabled with `LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING` after daemon/commit behavior is validated on Windows.
- Dev daemon dispatcher and JSONL CLI in `native/daemon/src`.
- IPC schema validation exists through `npm run check:ipc-schema`.

## What Is Not Claimed

This is not yet a proven production Windows release. The source is build-ready, but it has not been compiled, registered, installed, and host-tested on a Windows machine in this execution environment.

## External Blocker Proof

The current execution environment is macOS/Linux-style Node/Vite workspace execution, not a Windows TSF host. A real TSF text service requires Windows COM/TSF registration, app-host testing, and a Windows code-signing/install path. Those cannot be completed inside this repo execution without a Windows native test machine and certificate.

## Exact Dev Build Path

On Windows with Visual Studio Build Tools and CMake:

```powershell
cd native\windows-tsf\skeleton
.\build.ps1
.\register-dev.ps1
```

Expected proof-spike artifact:

- `build\bin\Release\LekhTextService.dll`

Manual smoke:

1. Start daemon: `npm run daemon:dev`
2. Register TSF: `.\register-dev.ps1`
3. Enable `Lekh Keyboard Nepali` in Windows language/input settings.
4. Test Notepad, Word, Chrome, Edge, VS Code, Excel, and one government web form.
5. Unregister: `.\unregister-dev.ps1`

## Required Production Implementation Steps

1. Build and register the TSF DLL on Windows.
2. Validate the named-pipe daemon bridge with the host-app test matrix.
3. Complete marked-text/candidate UI behavior after Windows host validation identifies app-specific TSF behavior.
4. Detect password/secure input scope and disable memory/proofread/suggestions.
5. Run test matrix:
   - Notepad
   - Word
   - Chrome
   - Edge
   - VS Code
   - Excel
   - government web form
6. Build signed NSIS `.exe` installer and verify uninstall cleanup.

## Owner / Action / Status

| Item | Owner | Status | Next action |
| --- | --- | --- | --- |
| Windows TSF native build machine | engineering | blocked-native-environment | Run CMake proof spike on Windows. |
| Code-signing certificate | product/release | blocked-external | Acquire Windows code-signing certificate. |
| TSF COM registration | engineering | ready-for-windows-validation | Run `register-dev.ps1` on Windows. |
| Host-app test matrix | QA/engineering | blocked-native-environment | Run after the TSF DLL registers locally. |
| Signed installer | release | blocked-external | Build after certificate and TSF validation. |

## Launch Readiness

Windows is not production-launch-ready. It is ready for native Windows proof-spike implementation and validation once the external/native blockers are resolved.
