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

Unsigned companion installer on Windows:

```bash
npm run package:windows:unsigned
npm run check:windows-release
```

Cross-packaging is an explicit development-only escape hatch: set
`LEKH_ALLOW_CROSS_WINDOWS_PACKAGE=1` before `package:windows:unsigned`. It can
never produce signed release evidence, and it does not replace native build,
registration, installer, or host-application validation on Windows.

Daemon-only development:

```bash
npm run build:daemon
npm run daemon:dev
```

Standalone Node named-pipe diagnostics (not the installed trust boundary):

```powershell
npm run build:daemon
npm run daemon:named-pipe
```

Signed installer on the release host:

```bash
export CSC_LINK=/secure/path/windows-authenticode.pfx
export CSC_KEY_PASSWORD=...
export LEKH_WINDOWS_SIGNER_SHA256=<64-hex SHA-256 of the expected publisher certificate>
npm run package:windows
npm run check:windows-release
```

The unsigned `.exe` is a dev artifact. Its report discovers every packaged Windows PE payload by file magic and binds the resulting closed-world inventory by path, byte length, modification time, and SHA-256, but it is not public-release evidence. Signed packaging is Windows-only, requires the source revision to remain clean and unchanged through final verification, and requires timestamp-aware `signtool verify /pa /all /v /tw` success for every inventoried PE. The NSIS installer, companion executable, TSF DLL, and native broker must also match the independently pinned publisher-certificate SHA-256; valid third-party Electron runtime binaries retain their own verified publisher identities.

## Signed Release Build Requirements

- Windows TSF DLL builds, registers, and unregisters cleanly.
- Raw-in-range key conservation, first-Escape fail-open behavior, secure-field fail-open behavior, COM-identity focus-stack handling, terminal End acknowledgement/purge, and stale/reactivated completion-token rejection pass in real TSF hosts.
- Companion starts hidden at login and keeps the native broker alive when the settings window closes; relaunching the shortcut reopens settings in the single background instance.
- The named pipe uses the explicit protected logon-session DACL and the TSF verifies the exact installed broker image.
- The package and NSIS installer fail closed if either the TSF DLL or broker is absent.
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
