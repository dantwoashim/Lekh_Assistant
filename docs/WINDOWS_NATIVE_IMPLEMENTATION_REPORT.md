# Windows Native Implementation Report

Generated: 2026-08-24

Status: `engineering-ready-unsigned`; public production release remains blocked by Authenticode and physical host/pilot validation.

The canonical build, install, recovery, and release instructions are in [`WINDOWS_RELEASE_BUILD.md`](./WINDOWS_RELEASE_BUILD.md).

## Implemented

- Native Windows TSF text service for Nepali with real composition, commit, cancel, display attributes, context-bound candidate placement, keyboard/pointer selection, and UI Automation semantics.
- 64-bit and 32-bit TSF DLLs for 64-bit Windows and compatibility applications.
- Machine-wide COM/TSF registration with rollback, modern-app capability, embedded profile icon, and per-user profile enablement without silently changing the default keyboard.
- Secure/unknown-context pass-through, bounded typed IPC, per-logon-session protected named pipe, exact broker-process verification, and no key consumption until the equivalent host edit succeeds.
- Native broker plus contained local daemon with bounded startup/restart behavior.
- Windows companion for two verified modes, privacy-first learning controls, per-application exclusions, diagnostics, one-UAC repair, run-at-sign-in, tray recovery, and local diagnostic export.
- Fail-closed NSIS packaging, dual-architecture registration/unregistration, Electron ASAR integrity, a complete nine-fuse policy, and unsigned/signed release modes.

## Verified Locally on Windows

- MSVC x64 and Win32 builds with `/W4 /WX /sdl`.
- Native protocol, candidate-state, TSF injection, COM lifetime, pipe ACL, server-identity, and daemon-backend tests.
- TypeScript typecheck, 50 Vitest files, production UI build, IPC schema, passive-commit exclusion, and composition work-bound checks.
- Unsigned x64 NSIS package containing both TSF architectures, native broker, daemon, and companion.
- Packaged executable fuse-wire verification and a live background launch/broker protocol-negotiation smoke test.
- Dependency audit reports zero known npm vulnerabilities at the time of this report.

## Not Yet Claimed

- The development installer is unsigned and will trigger normal Windows publisher warnings.
- This run did not mutate machine-wide registration because the current shell is not elevated.
- Notepad, Office, Chromium, VS Code, 32-bit host, touch, DPI, high-contrast, Narrator, sleep/resume, upgrade, and clean uninstall still require the physical release matrix.
- ARM64 build support exists in CI, but ARM64 packaging is not a supported public release until independently validated.
- “World-class” remains a usability outcome to prove with real Nepali typists, not a label established by automated tests.

## Release Decision

The Windows implementation is ready for signed release-candidate testing. It is not yet justified as a public production release until the external evidence gates in [`WINDOWS_RELEASE_BUILD.md`](./WINDOWS_RELEASE_BUILD.md) pass.
