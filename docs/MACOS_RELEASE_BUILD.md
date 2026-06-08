# macOS Release Build

Generated: 2026-05-28

Status: `blocked-native-environment` for installed IMK/XPC validation and `blocked-external` for Developer ID/notarization.

## Unsigned Dev Build Path

```bash
cd native/macos-imk/skeleton
swift build
```

The current Swift package validates proof-spike decision logic only. A production `.inputmethod` bundle still needs native implementation and installation.

## Signed Release Build Requirements

- `.inputmethod` bundle installs under `~/Library/Input Methods/`.
- User can enable Lekh Keyboard in macOS Keyboard settings.
- XPC service `com.lekh.keyboard.EngineXPC` is bundled and local-only.
- Marked text, candidate UI, commit, cancel, and pass-through all work.
- Secure input suppresses memory/proofread/suggestions.
- Companion app can manage settings and diagnostics.
- Developer ID signing, hardened runtime, notarization, stapling, and Gatekeeper validation pass.
- Uninstall removes input method, XPC service, daemon/companion files, and optional user data only after confirmation.

## Privacy Requirements

- Normal typing is local-first and does not send typed text to a server.
- Secure input disables memory, proofread, and aggressive suggestions.
- Diagnostics exports must be redacted before sharing.
- Pilot examples require explicit consent and manual redaction.

## Manual Test Matrix

- TextEdit
- Safari
- Chrome
- Pages
- VS Code
- Notes

## Release Blockers

| Blocker | Type | Resolution |
| --- | --- | --- |
| Apple Developer ID | blocked-external | Acquire Developer ID and team access. |
| Notarization | blocked-external | Sign, notarize, staple, and validate. |
| Installed IMK validation | blocked-native-environment | Test real input source in host apps. |

## Launch Claim

macOS release is not production-ready until IMK/XPC implementation, installed validation, signed/notarized distribution, and pilot feedback are complete.
