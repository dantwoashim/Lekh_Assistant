# Lekh Keyboard

Lekh Keyboard is a local-first Nepali desktop keyboard project. The target product is a real Windows/macOS input method that lets people type Nepali inside normal apps such as Word, Chrome, Edge, Safari, WhatsApp, VS Code, TextEdit, Pages, and browser forms.

Current repo status is deliberately narrower than that target:

- The React/Vite browser surface is a typing-engine validation demo.
- The Electron shell is a companion/demo shell for settings, diagnostics, packaging, and first-run validation.
- The native macOS IMK path has a test installer for host-app validation.
- The native Windows TSF path is under active proof-spike development.
- The Electron/browser demo is **not** the keyboard app.
- The companion app is **not** the keyboard app.
- Preeti to Unicode is a side utility, not the main product.

The real keyboard product is the native input-method layer:

- Windows: TSF text service.
- macOS: InputMethodKit input method.
- Shared local keyboard engine for Romanized typing, Traditional typing, suggestions, proofread, dictionary, and personal memory.

## Contents

- [Why It Exists](#why-it-exists)
- [macOS Test Build](#macos-test-build)
- [What It Does](#what-it-does)
- [Privacy Model](#privacy-model)
- [Current Quality Evidence](#current-quality-evidence)
- [Run Locally](#run-locally)
- [Primary v1 Commands](#primary-v1-commands)
- [Project Shape](#project-shape)
- [Data Source Policy](#data-source-policy)
- [Feedback and Real-Document Validation](#feedback-and-real-document-validation)
- [Known Limitations](#known-limitations)
- [Maintainer Docs](#maintainer-docs)
- [License](#license)
- [What It Does Not Claim](#what-it-does-not-claim)

## Why It Exists

Nepali desktop users need a keyboard that works system-wide, understands real Romanized Nepali, preserves mixed English safely, and stays private by default. Existing copy-paste converters and browser boxes are not enough for daily desktop typing.

The product direction is deliberately conservative and native-first:

- Build real Windows TSF and macOS IMK input methods.
- Keep typing local and offline in the hot path.
- Prefer documented rules, reviewed data, and measurable benchmarks over hidden magic.
- Show candidates when Romanized input is ambiguous.
- Preserve protected tokens such as NID, PAN, PDF, emails, URLs, numbers, and IDs.
- Treat Preeti conversion as a side utility.
- Avoid unclear-license language data.

## macOS Test Build

The GitHub-visible macOS keyboard test artifact is:

- [`release/native/macos/Lekh-Keyboard-Test-Installer.zip`](release/native/macos/Lekh-Keyboard-Test-Installer.zip)

This zip is the current unsigned test installer for the native macOS InputMethodKit build. It is intended for development and host-app validation, not for public production distribution. A production macOS release still requires Developer ID signing, notarization, the full host-app matrix, secure-field evidence, install/uninstall evidence, and multi-day pilot use.

Build or refresh the local macOS test installer with:

```bash
npm run v1:package:macos
```

Because this artifact is ad-hoc signed and not notarized, macOS can block a downloaded copy. After extracting the ZIP, **Control-click or right-click `Lekh Keyboard Test Installer.app`, choose Open, then click Open again**. This is the preferred path. If macOS still blocks it, open **System Settings > Privacy & Security** and choose **Open Anyway** for the installer.

As a last resort, remove quarantine from the installer app only: open Terminal, type `xattr -dr com.apple.quarantine` followed by one space, drag `Lekh Keyboard Test Installer.app` into Terminal, and press Return. Then repeat the right-click → Open step. Do not run the command on your Downloads folder or home directory.

```bash
xattr -dr com.apple.quarantine "/path/to/Lekh Keyboard Test Installer.app"
```

On first run, the installer detects the quarantine marker and explains these same steps in plain language. None of these steps turns the build into an Apple-trusted, Developer ID-signed, or notarized release.

The ZIP also includes an optional technical integrity check: `Verify Lekh Release.command`, `SHA256SUMS.txt`, `RELEASE-MANIFEST.json`, `RELEASE-MANIFEST.json.minisig`, and `lekh-release-manifest-minisign.pub`. The verifier is self-contained and does not require Homebrew or a separately installed `minisign` binary. It is not required for the normal right-click → Open installation path.

```bash
bash "/path/to/Lekh Keyboard Test Installer/Verify Lekh Release.command"
```

The canonical signing key and its independently checkable fingerprint are published in [`docs/security/RELEASE_SIGNING_KEYS.md`](docs/security/RELEASE_SIGNING_KEYS.md). Package verification proves integrity under that project-owned key; it does not prove an Apple-verified developer identity.

The generated Homebrew Cask is a convenience for technical testers, not a Gatekeeper bypass or a substitute for Developer ID identity and notarization:

```bash
brew install --cask ./release/native/macos/lekh-keyboard-test.rb
```

After installation, save your work and log out and back in. Then open **System Settings > Keyboard > Text Input > Edit**, click **+**, and add `Lekh Keyboard` under **Nepali**. An unsigned installer can request TIS registration but cannot honestly guarantee that macOS persisted user approval, so the installer deliberately reports those as separate states. The packaged uninstaller asks for confirmation, restores the previous input source when macOS allows it, and deletes local learned words, dictionary packs, model files, install backups, caches, and Lekh logs.

Current macOS IMK test-build behavior includes:

- four native modes: Romanized-Romanized, Romanized-Traditional, Traditional-Traditional (Beta), and Traditional-Romanized (Beta)
- first-selection mode chooser plus a first-run `namaste` to `नमस्ते` tutorial
- underlined inline marked-text preview before commit
- Space commit, Escape cancel, Backspace composition edit, and Command/Control shortcut pass-through
- a custom non-activating candidate window with Devanagari font sizing, badges, and correction explainers
- proofread suggestions for active Traditional/Unicode composition using the bundled correction pairs
- smart Nepali punctuation for danda commit in Nepali output modes
- Traditional Option-key helpers for halanta, rakar/yaphala, chandrabindu, anusvara, and danda
- fallback InScript-style Traditional key mapping when macOS does not provide a Devanagari layout override
- input-menu preferences for transliteration strictness, halanta behavior, mixed-script preference, local dictionary export/edit/delete, diagnostics, and privacy controls

## What It Does

### Native Keyboard Work

The production target is a native keyboard:

- Windows TSF input method.
- macOS InputMethodKit input method.
- Per-user daemon/service for heavy packs, memory, dictionary, and diagnostics.
- Companion app for settings, privacy, dictionary, memory, diagnostics, and install status.

Native work is not yet public-launch-ready. Current native artifacts are proof-spike/build scaffolds and must pass real host-app testing before any production claim.

### Romanized Nepali Typing

Romanized typing is the flagship first-launch experience. It uses:

- phonology rules from [`docs/PHONOLOGY_CONTRACT.md`](docs/PHONOLOGY_CONTRACT.md)
- keyboard candidate ranking for phrase, dictionary, rule, variant, context, and local memory paths
- a quantized local n-gram model for context-aware next-word inline completion
- a gated Core ML tail slot for a future small open-vocabulary transliteration model; the current packaged Core ML artifact is only a closed-vocabulary baseline tail and is blocked by production gates
- domain-ranked local suggestions for office, government, education, legal, names, and places
- casual Nepali completions such as `ramro xa`, `kasto cha`, and `dherai ramro`
- mixed Nepali-English policy candidates that preserve protected tokens and offer loanword preferences
- full-output alternatives so selecting a candidate does not collapse a sentence into a single word
- local correction memory after explicit candidate selection

### Traditional Nepali Typing (Beta)

Traditional Unicode suggestions and proofread can be validated in the engine. The macOS IMK build now uses macOS layout override when available and an InScript-style fallback mapping when the override is unavailable. Every Traditional mode is labeled **Beta** because the repository has no verified physical-layout corpus or experienced-typist validation; Romanized remains the primary scheme.

### Preeti to Unicode

Preeti conversion remains a side utility. It wraps a documented converter baseline, preserves unknown characters instead of dropping them, reports uncertain mappings, and normalizes output before copy.

### Suggestions and Spell Hints

Suggestions and basic unknown-word hints run against bundled local data. They are meant to help users discover likely words, not to certify spelling or grammar.

The larger Hunspell dictionary is lazy-loaded as a local browser chunk, so the first app load is not forced to carry the full spellchecking asset.

### Browser Demo and Companion Shell

The browser demo and Electron shell exist to validate the engine, demonstrate typing behavior, and manage companion-style settings. They are not substitutes for TSF/IMK native input methods.

The production web build writes a service worker that precaches the app shell and Vite hashed assets. Offline behavior is checked as part of `npm run v1:check`.

## Privacy Model

Typed text, converted text, dictionary queries, raw keystrokes, clipboard content, spell tokens, and output text stay local. The engine hot path must not use the network.

Feedback is explicit. The app prepares a report only when the user chooses to copy or submit it. A deployment can enable email handoff with `VITE_FEEDBACK_EMAIL`; otherwise the report remains local.

Correction memory is local, explicit, and user-controlled. It must not learn secure-field text, passwords, protected tokens, IDs, emails, URLs, or excluded app input.

## Current Quality Evidence

Current keyboard-specific evidence is produced by committed scripts and generated local reports:

| Gate | Status |
| --- | --- |
| Deterministic v1 suite | `npm run v1:test` runs the frozen v1 unit-test surface |
| Cross-platform release check | `npm run v1:check` runs format, types, deterministic tests, the web build, IPC validation, and the passive-commit policy |
| macOS package | `npm run v1:package:macos` builds the unsigned universal IMK installer with neural typing forced off |
| Windows package | `npm run v1:package:windows` builds the unsigned Windows installer |

Internal fixture metrics are useful for regression control, but they are not public superiority claims and they are not a substitute for consented real-document validation or manually filled competitor outputs.

## Run Locally

Prerequisite: Node.js `^20.19.0` or `>=22.12.0`.

```bash
npm install
npm run v1:dev
```

Open the local URL printed by Vite, usually:

```text
http://127.0.0.1:5173/
```

## Primary v1 Commands

These eight commands are the supported top-level developer interface for v1.0.
The older maintenance scripts remain available to repository maintainers but
are intentionally not part of the primary workflow.

| Command | Purpose | Host |
|---|---|---|
| `npm run v1:dev` | Start the local Vite development surface | macOS / Windows |
| `npm run v1:build` | Build the web/companion UI | macOS / Windows |
| `npm run v1:test` | Run the deterministic v1 test suite | macOS / Windows |
| `npm run v1:check` | Run the cross-platform v1 preflight | macOS / Windows |
| `npm run v1:build:macos` | Compile the native macOS input method with neural typing off | macOS |
| `npm run v1:build:windows` | Compile the native Windows TSF service | Windows |
| `npm run v1:package:macos` | Build and verify the unsigned universal macOS installer ZIP | macOS |
| `npm run v1:package:windows` | Build the unsigned Windows installer | Windows |

## Project Shape

```text
src/
  app/                 React app entry and shell
  components/          Shared UI primitives
  core/
    normalize/         Unicode normalization
    preeti/            Preeti conversion wrapper
    transliteration/   Romanized engine, candidates, local correction memory
    dictionary/        Local suggestions and spell hints
    validation/        Real Preeti intake and de-identification pipeline
  data/
    fixtures/          Generated and curated test fixtures
    wordlists/         Local curated seed/domain wordlist
  features/            Product surfaces
scripts/               Fixture, dictionary, quality, privacy, and offline gates
docs/                  Contracts, validation plans, data policy, notices
native/                macOS IMK and Windows TSF native input-method source
public/                Manifest and icons
```

Important contracts:

- [`docs/ENGINE_CONTRACT.md`](docs/ENGINE_CONTRACT.md)
- [`docs/PHONOLOGY_CONTRACT.md`](docs/PHONOLOGY_CONTRACT.md)
- [`docs/PRIVACY.md`](docs/PRIVACY.md)
- [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)
- [`docs/REAL_PREETI_VALIDATION.md`](docs/REAL_PREETI_VALIDATION.md)
- [`docs/REAL_DOCUMENT_COLLECTION_PACKET.md`](docs/REAL_DOCUMENT_COLLECTION_PACKET.md)
- [`docs/VALIDATION_REPORT.md`](docs/VALIDATION_REPORT.md)
- [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)
- [`docs/REPOSITORY_GOVERNANCE.md`](docs/REPOSITORY_GOVERNANCE.md)

## Data Source Policy

Bundled data must have a documented source and license status. The app currently uses:

- project-owned seed words and domain packs
- seed-derived surface forms
- a reviewed `dictionary-ne` ranked lexical expansion derived from LGPL dictionary entries, with local Wikipedia frequency counts used only as ignored research input
- Romanized phrase and alias ranking packs
- local aggregate n-gram prediction packs
- 5,000 generated Romanized fixtures plus manual, hostile, contaminated-regression, and competitor-probe benchmark cases
- 10,000+ Preeti round-trip fixtures plus hard manual, held-out paragraph, and competitor-probe benchmark cases
- separate Preeti manual, generated, held-out, competitor-probe, and user-submitted fixture buckets
- `@nepalibhasha/converter` as the Preeti baseline
- `dictionary-ne` and `nspell` for browser-local spell validation, with LGPL/MIT notices and a replacement path

No GPL, noncommercial, unclear-license mapping table, scraped private-like document, or unclear-license corpus is bundled in production.

## Feedback and Real-Document Validation

Use the in-app feedback panel for explicit examples the user wants reviewed. Private documents should not be pasted into feedback.

Real Preeti validation has a separate intake path:

1. Collect written permission for each source document.
2. Keep raw documents and private manifests under ignored `data/private/`.
3. Use the repository's maintainer-only Preeti intake script.
4. Review de-identified fixtures and failure tags.
5. Promote only safe, consented, de-identified fixtures.

The current real-document collection count is `0`. Public real-document quality claims remain blocked until the project has 30-50 consented Preeti documents from target workflows.

## Known Limitations

- Preeti conversion is practical but not perfect. Legacy font documents can contain ambiguous or font-specific text.
- Romanized typing is a preview common-Nepali profile, not an official Romanization standard.
- Romanized hostile fixtures pass today, but one older file named held-out is contaminated by phrase-pack overlap and is treated only as regression evidence.
- Controlled testing is acceptable; broad demo and comparative claims stay blocked by missing consented real Preeti documents and pending manual competitor probes.
- The dictionary has curated domain packs, phrase/alias packs, and generated surface forms, not a complete Nepali dictionary.
- Spell hints are local unknown-word hints only. They are not grammar checks.
- The neural transliteration model is not production-shipped yet. Public model research is wired into source selection and readiness gates, but production requires a trained small Core ML artifact under `models/macos/`.
- The larger Hunspell spell asset is lazy-loaded locally; first-use spell hints can lag slightly on slower machines.
- Suggestions focus on the trailing typed token. Candidate alternatives are full-output ranked paths, but full cursor-aware replacement in the middle of a sentence is future work.
- Native macOS proofread decoration is composition-time candidate UI. Normal host apps do not give an IMK a universal way to draw persistent squiggles under arbitrary text after it is already committed.
- The custom macOS candidate window is non-activating and host-safe; exact caret anchoring can vary by app because some hosts expose limited caret geometry through IMK.
- Local correction memory improves repeated inputs through local storage: browser builds use browser-local memory and native macOS builds use a per-user SQLite lexicon.
- Generated Preeti round-trip fixtures are regression tests, not proof of real-world document coverage.
- Varnavinyas orthography checking is only a disabled local development probe.
- Offline support applies after the first successful load.

## Maintainer Docs

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Third-party notices](docs/THIRD_PARTY_NOTICES.md)

## License

MIT. See [`LICENSE`](LICENSE).

## What It Does Not Claim

Lekh does not claim official language authority, government endorsement, perfect Preeti conversion, perfect transliteration, official spellchecking, grammar correction, signed/notarized production native release status, a browser extension, sync, accounts, payments, or server-side text processing.
