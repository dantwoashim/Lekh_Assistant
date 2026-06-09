# Release Artifacts Manifest

Generated: 2026-06-08

## Internal Dev Build

- Web/lab build from `npm run build`.
- TypeScript daemon dispatcher validation from `npm run build:daemon`.
- Windows TSF DLL source and CMake build path under `native/windows-tsf`.
- Companion desktop package from `npm run build:companion`.
- Unsigned macOS companion dev app from `npm run package:macos:unsigned`: `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/mac-arm64/Lekh Keyboard Companion.app`.
- Windows unsigned packaging is blocked on this macOS host and emits exact Windows release commands from `npm run package:windows:unsigned`.
- Scorecards and benchmark reports under `bench/reports`.

## Windows Release Artifacts

Status: blocked until native Windows validation and signing.

- signed TSF DLL.
- signed daemon executable.
- signed companion executable.
- signed NSIS `.exe` installer.
- release notes.
- privacy policy.
- checksum manifest.

## macOS Release Artifacts

Status: blocked until IMK/XPC validation, Developer ID, and notarization.

- signed companion app.
- signed `.inputmethod` bundle.
- signed XPC service.
- signed daemon/helper.
- notarized installer or disk image.
- release notes.
- privacy policy.
- checksum manifest.

## Public Claim Gate

Do not claim production Windows/macOS release until the platform artifacts above exist and pass install, update, uninstall, and host-app typing validation.
