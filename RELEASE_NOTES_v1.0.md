# Lekh Assistant v1 Release Notes

Status: unsigned community preview built and verified by CI. The checksum block
is regenerated from the installers packaged in the same release run.

## What is included

### macOS

- System-wide Romanized Nepali typing through InputMethodKit.
- Deterministic Devanagari candidates and explicit candidate commit.
- Inline completion plus a non-activating candidate window.
- Traditional → Nepali and Traditional → Romanized modes, both labeled Beta.
- Local dictionary ranking, explicit-choice memory, and bounded proofread Fix
  candidates.
- Universal Apple Silicon and Intel payload.
- Unsigned ZIP installer and uninstaller with a tested first-run quarantine
  walkthrough.

### Windows

- System-wide Romanized Nepali typing through Windows Text Services Framework.
- Host-rendered inline ghost suggestions accepted with Tab or Right Arrow.
- A numbered candidate window with Up/Down, digits 1–8, Space, and Enter.
- Exact selected-candidate commit through the native TSF edit-session path.
- Local deterministic daemon and protected per-user named-pipe broker.
- Unsigned x64 installer with machine-wide TSF registration, background
  startup, explicit companion Exit action, and clean registration removal.

### Shared behavior

- Deterministic suggestions as you type.
- Local dictionary data and conservative proofread hints.
- Protected Latin tokens such as emails, URLs, IDs, PDF, and numbers remain
  unchanged.
- Password and unknown contexts fail closed instead of transforming text.
- No text telemetry, account, or network dependency in the typing path.
- Experimental neural/Core ML typing is disabled and excluded from v1.0
  packages.

## Install

Full step-by-step instructions are in [README.md](README.md).

macOS:

1. Extract Lekh-Keyboard-Test-Installer.zip.
2. Right-click Lekh Keyboard Test Installer.app, choose Open, then click Open
   again.
3. Log out and back in, then add Lekh Keyboard under System Settings → Keyboard
   → Text Input → Edit… → + → Nepali.

Windows:

1. Run the Lekh-Keyboard-Companion-<version>-Setup-x64.exe release asset.
2. Approve the unsigned-publisher and User Account Control prompts after
   checking the downloaded file name.
3. Press Windows key + Space and choose Lekh Keyboard Nepali.

## Verification

- Four-target CI is green on macOS ARM64, macOS Intel x64, Windows x64, and
  Windows ARM64.
- The scoped deterministic suite passes in the cited release workflow.
- TypeScript and Swift pass all 31 shared behavior-contract rows with
  byte-identical output.
- Windows CI commits selected Devanagari through a real TSF thread manager,
  document manager, context, edit session, and in-memory text store.
- Windows x64 CI installs silently, verifies COM/TSF/startup and daemon
  negotiation, uninstalls, and verifies cleanup.
- The packaged macOS ZIP detects simulated quarantine and prints the preferred
  Finder right-click → Open path.
- The locked Preeti benchmark passes 10,225/10,225 repository fixtures; this is
  regression evidence, not real-document validation.

Detailed receipts:

- [C2 macOS unsigned-install walkthrough](C2_MACOS_UNSIGNED_INSTALL_WALKTHROUGH.md)
- [C3 Traditional / Preeti corpus results](C3_TRADITIONAL_PREETI_CORPUS_RESULTS.md)

## Important limitations

- The macOS package is ad-hoc signed and not Apple-notarized.
- The Windows package is unsigned and can trigger SmartScreen.
- Physical Windows use in Notepad, browsers, and Word has not been claimed;
  native integration and state-machine paths are CI-verified proxies.
- Traditional physical typing is Beta and lacks a verified keymap corpus and
  experienced-typist validation.
- Preeti has no consented real-document or user-submitted validation set.
- Proofread is not full spelling or grammar correction.
- Windows ARM64 builds/tests pass, but its assembled NSIS package does not pass
  the install lifecycle; v1.0 therefore ships only the verified x64 installer.
- There is no automatic update service.

Read [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) before distributing the
release.

## Artifact checksums

CI replaces this paragraph with hashes computed from the installers in the same
release bundle. Never copy checksum values from an older release.
