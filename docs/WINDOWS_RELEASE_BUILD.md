# Windows Release Build

Generated: 2026-05-28

Status: `blocked-native-environment` for TSF validation and `blocked-external` for signed release.

## Primary Installer Strategy

Use a signed per-user MSI first. MSIX is deferred until TSF registration constraints are verified.

## Unsigned Dev Build Path

```powershell
cd native\windows-tsf\skeleton
cmake -S . -B build -G "Visual Studio 17 2022"
cmake --build build --config Debug
```

The current proof artifact is scaffold-only. It must not be distributed as a production IME.

## Signed Release Build Requirements

- Windows TSF DLL registers and unregisters cleanly.
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
| Code-signing certificate | blocked-external | Acquire certificate and sign DLL/MSI. |
| Installer validation | blocked-native-environment | Verify install, update, repair, uninstall. |

## Launch Claim

Windows release is not production-ready until TSF implementation, host-app validation, signed installer, and pilot feedback are complete.
