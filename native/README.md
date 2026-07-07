# Lekh Native Scaffolding

This folder contains repo-executable architecture scaffolding for the future Windows and macOS keyboard integrations.

It is not a production native input method. The TypeScript engine and browser Keyboard Lab remain reference/testing surfaces, not the macOS keyboard. Native release still requires real Windows/macOS testing, signing, notarization, installer validation, and pilot feedback.

## Layout

| Folder | Purpose |
| --- | --- |
| `shared/ipc` | Versioned local IPC envelope, message types, and JSON schema shared by native shells, daemon, and companion. |
| `shared/storage` | Native storage expectations and privacy boundaries. |
| `shared/diagnostics` | Diagnostics event categories and crash/fallback reporting notes. |
| `daemon` | Lifecycle and protocol scaffold for the local keyboard engine host. |
| `windows-tsf` | Windows Text Services Framework feasibility skeleton and contract. |
| `macos-imk` | Buildable macOS InputMethodKit proof target with an in-process deterministic engine. |
| `companion` | Companion app architecture scaffold. |

No native build is wired into `npm run verify` because the current repository environment verifies the TypeScript/web-lab engine. Platform builds are explicitly blocked until Windows/macOS toolchains and signing environments are available.
