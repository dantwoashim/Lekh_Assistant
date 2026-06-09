# Windows Release Build

Generated: 2026-06-08

Status: `blocked-native-environment` for TSF validation and `blocked-external` for signed release.

## Primary Installer Strategy

Use a signed per-user NSIS `.exe` installer first:

- TSF DLL: `native/windows-tsf/skeleton/build/bin/Release/LekhTextService.dll`
- Per-user daemon: TypeScript/Node daemon process built from `native/daemon/src/daemonCli.ts`
- Bundled daemon artifact: `native/daemon/dist/lekh-keyboard-daemon.mjs`
- Companion app: Electron-packaged React UI from `electron/main.cjs`
- Installer hook: `build/installer/windows/installer.nsh`

MSI/MSIX can be evaluated later, but the current repo-executable Windows installer target is an NSIS `.exe`.

## Unsigned Dev Build Path

```powershell
cd native\windows-tsf\skeleton
.\build.ps1
.\register-dev.ps1
```

Unsigned companion installer from any host supported by electron-builder:

```bash
npm run package:windows:unsigned
npm run check:windows-release
```

Daemon-only development:

```bash
npm run build:daemon
npm run daemon:dev
```

Windows named-pipe development:

```powershell
npm run build:daemon
npm run daemon:named-pipe
```

Signed installer on the release host:

```bash
export CSC_LINK=/secure/path/windows-authenticode.pfx
export CSC_KEY_PASSWORD=...
npm run package:windows
```

The unsigned `.exe` is a dev artifact. Public release requires Authenticode signing and Windows host-app validation.

## Signed Release Build Requirements

- Windows TSF DLL builds, registers, and unregisters cleanly.
- Per-user daemon starts at login or through companion.
- Named pipe is per-user ACL scoped.
- Companion app installs with the daemon.
- Secure input passes through or disables memory/proofread/suggestions.
- Crash logs are local and redacted.
- Uninstall removes TSF profile, daemon startup entry, companion app, and optional user data only after confirmation.
- Code-signing certificate is available.

## Privacy Requirements

- Normal typing is local-first and does not send typed text to a server.
- Secure input disables memory, proofread, and aggressive suggestions.
- Diagnostics exports must be redacted before sharing.
- Pilot examples require explicit consent and manual redaction.

## Manual Test Matrix

- Notepad
- Word
- Chrome
- Edge
- VS Code
- Excel
- government web form

## Release Blockers

| Blocker | Type | Resolution |
| --- | --- | --- |
| Windows test machine | blocked-native-environment | Run TSF registration and host-app test matrix on Windows. |
| Code-signing certificate | blocked-external | Acquire certificate and sign DLL/daemon/NSIS `.exe`. |
| Installer validation | blocked-native-environment | Verify install, update, repair, uninstall. |

## Launch Claim

Windows release is not production-ready until TSF host-app validation, signed installer, and pilot feedback are complete.
