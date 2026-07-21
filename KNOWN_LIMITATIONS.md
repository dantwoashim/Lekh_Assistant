# Lekh Assistant v1.0 — Known Limitations

This document distinguishes what the release automation proves from what still requires use on a physical computer. A documented hardware gap is not represented as tested.

## Windows typing validation

CI runs a native Windows integration test on x64 and ARM64. The test creates the real Windows Text Services Framework thread manager, document manager, focused context, and edit session; commits the deterministic engine result `नमस्ते` through `ITfInsertAtSelection`; and asserts that an in-memory `ITextStoreACP` target receives the exact Devanagari text while preserving pre-existing Latin text.

This proves the final native TSF text-mutation path without substituting clipboard or synthetic-key injection. The current CI sink does not emulate the full incremental composition lifecycle, prove interactive behavior in physical installations of Notepad, browsers, or Microsoft Word, exercise application-specific TSF quirks, or visually inspect the candidate popup. Those gaps require real Windows hardware and are not claimed as verified for v1.0.

## Windows candidate-window validation

CI verifies the complete headless candidate interaction state machine for digits 1–8, Up/Down, Space, and Enter. It also compiles the concrete non-activating Win32 renderer on x64 and ARM64 and verifies that a digit-selected candidate reaches the real TSF test sink as exact Devanagari text.

CI does not capture and inspect candidate-window pixels inside a physical Notepad, browser, or Word session. Rendering and application-specific placement therefore remain documented real-hardware validation gaps rather than claimed results.

## Windows distribution

The Windows installer is unsigned. Windows may show an unknown-publisher or SmartScreen warning, and no claim of Microsoft trust, signing, or certification is made. The input method uses machine-wide COM and TSF registration, so installation and removal require administrator approval through Windows User Account Control.

The silent install/startup/daemon/uninstall lifecycle is CI-verified for the x64 installer. Windows ARM64 compiles and passes the native service tests on an ARM64 runner, but an ARM64 installer artifact is not yet produced by the current packaging configuration.

## macOS distribution

The macOS build is ad-hoc signed and is not Apple-notarized because this project
has no paid Apple Developer ID. A freshly downloaded copy can therefore be
blocked by Gatekeeper. The supported first step is to Control-click or
right-click `Lekh Keyboard Test Installer.app`, choose **Open**, and click
**Open** again. If macOS still blocks it, use **System Settings → Privacy &
Security → Open Anyway**. The documented one-line `xattr` command is a last
resort and is intentionally scoped to that installer app; users are not asked
to disable Gatekeeper system-wide.

CI and the local packaging walkthrough verify quarantine detection and the
instructions shown after Finder approval. They cannot make an unsigned build
trusted by Apple, suppress every Gatekeeper warning, or reproduce every macOS
policy version. No Apple signing or notarization claim is made.

## Traditional typing is beta

Traditional typing is labeled **Beta**. The existing pending-layout audit is
green only because it verifies that no guessed physical keymap is treated as
final. The final-layout audit still fails: the repository has zero scorable
physical key mappings and neither of its two required verified layout files.
The macOS input method uses an available macOS Nepali layout override and an
InScript-style fallback, but no experienced Traditional typist has validated
the complete physical layout. Romanized typing is the primary v1.0 scheme.

The Preeti converter passed all 10,225 locked benchmark fixtures, but 9,920 are
generated dictionary round trips and there are no user-submitted or consented
real-document fixtures. That result is regression evidence, not a promise of
perfect conversion for every legacy-font document.
