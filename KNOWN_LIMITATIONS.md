# Lekh Assistant v1.0 — Known Limitations

This document distinguishes what the release automation proves from what still requires use on a physical computer. A documented hardware gap is not represented as tested.

| Area | v1.0 reality |
|---|---|
| macOS trust | Ad-hoc signed, unsigned by Apple, and not notarized |
| Windows trust | Unsigned; SmartScreen/unknown-publisher warning is expected |
| Windows host apps | Native path is CI-tested; physical Notepad/browser/Word use is not claimed |
| Traditional typing | Beta; no verified physical-layout corpus or typist sign-off |
| Preeti | Locked-fixture regression coverage, no consented real-document coverage |
| Proofread | Conservative active-token hints, not grammar correction |
| Updates | No automatic update service; users install new releases manually |
| Neural typing | Disabled and not packaged; v1.0 is deterministic |

## Windows typing validation

CI runs a native Windows integration test on x64 and ARM64. The test creates the real Windows Text Services Framework thread manager, document manager, focused context, and edit session; commits the deterministic engine result `नमस्ते` through `ITfInsertAtSelection`; and asserts that an in-memory `ITextStoreACP` target receives the exact Devanagari text while preserving pre-existing Latin text.

This proves the final native TSF text-mutation path without substituting clipboard or synthetic-key injection. The current CI sink does not emulate the full incremental composition lifecycle, prove interactive behavior in physical installations of Notepad, browsers, or Microsoft Word, exercise application-specific TSF quirks, or visually inspect the candidate popup. Those gaps require real Windows hardware and are not claimed as verified for v1.0.

## Windows candidate-window validation

CI verifies the complete headless candidate interaction state machine for digits 1–8, Up/Down, Space, and Enter. It also compiles the concrete non-activating Win32 renderer on x64 and ARM64 and verifies that a digit-selected candidate reaches the real TSF test sink as exact Devanagari text.

CI does not capture and inspect candidate-window pixels inside a physical Notepad, browser, or Word session. Rendering and application-specific placement therefore remain documented real-hardware validation gaps rather than claimed results.

## Windows distribution

The Windows installer is unsigned. Windows may show an unknown-publisher or SmartScreen warning, and no claim of Microsoft trust, signing, or certification is made. The input method uses machine-wide COM and TSF registration, so installation and removal require administrator approval through Windows User Account Control.

The silent install/startup/daemon/uninstall lifecycle is CI-verified for the x64 installer. Windows ARM64 compiles and passes the native service tests on an ARM64 runner, but an ARM64 installer artifact is not yet produced by the current packaging configuration.

The lifecycle check proves removal of installed files, running Lekh processes,
the startup entry, COM registration, and the TSF profile. The Windows installer
does not promise to delete every per-user preference or cache file. Users who
need forensic removal should not interpret a normal uninstall as that stronger
claim.

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

## Proofread and dictionary quality

Proofread is a bounded deterministic rule set. It can offer a **Fix** candidate
for supported active Nepali tokens, but it does not scan a whole document,
understand general grammar, certify official spelling, or draw persistent
correction marks after text has been committed in every host app. A missing
hint does not mean the text is correct, and a hint still requires explicit user
selection.

Bundled dictionary data supports local lookup and candidate ranking. It is not
presented as a complete or authoritative Nepali dictionary, and v1.0 does not
claim professionally reviewed definitions for every entry.

## macOS host-app validation

The Romanized engine, Swift adapter, grapheme behavior, Latin pass-through,
unsigned-install walkthrough, universal architecture, and package integrity
are automated. v1.0 does not claim a fresh physical host-app matrix across
TextEdit, Safari, Chrome, Microsoft Word, Pages, Electron apps, and every secure
field. Some hosts expose limited caret geometry, so candidate-window placement
can vary. These are documented validation gaps, not hidden passes.

## Updates and deterministic-only scope

v1.0 has no automatic update service or trusted update channel. Users must
download and install a newer release manually and should verify that it comes
from the project's GitHub Releases page.

The experimental neural/Core ML pipeline is off by default and excluded from
v1.0 packages. All v1.0 typing claims refer to the deterministic engine.
