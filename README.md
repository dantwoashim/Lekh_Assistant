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
- [Useful Commands](#useful-commands)
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
npm run package:macos:imk:test-installer
```

Because this artifact is ad-hoc signed unless `LEKH_MAC_DEVELOPER_ID` is provided at build time, a downloaded zip can be blocked by Gatekeeper. For test builds only, open **System Settings > Privacy & Security** and choose **Open Anyway** for `Lekh Keyboard Test Installer.app`.

If macOS shows only **Move to Trash** or **Done** with no install/open option, use the terminal fallback included in the zip:

```bash
cd ~/Downloads/'Lekh Keyboard Test Installer'
xattr -dr com.apple.quarantine .
./Install\ Lekh\ Keyboard\ from\ Terminal.command
```

That fallback is only for unsigned QA builds. Production builds must be Developer ID signed, notarized, and stapled instead of asking users to bypass Gatekeeper.

The zip also includes `Verify Lekh Release.command`, `SHA256SUMS.txt`, `RELEASE-MANIFEST.json`, `RELEASE-MANIFEST.json.minisig`, and `lekh-release-manifest-minisign.pub`. Testers with `minisign` installed can verify the extracted folder before installing:

```bash
./Verify\ Lekh\ Release.command
```

For terminal-first QA distribution without Developer ID, the release folder also generates a Homebrew Cask:

```bash
brew install --cask ./release/native/macos/lekh-keyboard-test.rb
```

After installation, choose `Lekh Keyboard` from the macOS input menu in the menu bar. If it does not appear immediately, log out and back in, then add it from **Keyboard Settings > Text Input > Edit > Nepali**. The packaged uninstaller asks for confirmation, restores the previous input source when macOS allows it, and deletes local learned words, dictionary packs, model files, install backups, caches, and Lekh logs.

Current macOS IMK test-build behavior includes:

- four native modes: Romanized-Romanized, Romanized-Traditional, Traditional-Traditional, and Traditional-Romanized
- first-selection mode chooser plus a first-run `namaste` to `नमस्ते` tutorial
- underlined inline marked-text preview before commit
- Space commit, Escape cancel, Backspace composition edit, and Command/Control shortcut pass-through
- a custom non-activating candidate window with Devanagari font sizing, badges, and correction explainers
- proofread suggestions for active Traditional/Unicode composition using the bundled correction pairs
- smart Nepali punctuation for danda commit in Nepali output modes
- Traditional Option-key helpers for halanta, rakar/yaphala, chandrabindu, anusvara, and danda
- fallback InScript-style Traditional key mapping when macOS does not provide a Devanagari layout override
- input-menu preferences for transliteration strictness, halanta behavior, mixed-script preference, local dictionary export/edit/delete, diagnostics, and privacy controls

The recovery command remains:

```bash
npm run restore:macos-keyboard
```

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

### Traditional Nepali Typing

Traditional Unicode suggestions and proofread can be validated in the engine. The macOS IMK build now uses macOS layout override when available and an InScript-style fallback mapping when the override is unavailable. This still needs experienced Traditional typist validation before any public quality claim.

### Preeti to Unicode

Preeti conversion remains a side utility. It wraps a documented converter baseline, preserves unknown characters instead of dropping them, reports uncertain mappings, and normalizes output before copy.

### Suggestions and Spell Hints

Suggestions and basic unknown-word hints run against bundled local data. They are meant to help users discover likely words, not to certify spelling or grammar.

The larger Hunspell dictionary is lazy-loaded as a local browser chunk, so the first app load is not forced to carry the full spellchecking asset.

### Browser Demo and Companion Shell

The browser demo and Electron shell exist to validate the engine, demonstrate typing behavior, and manage companion-style settings. They are not substitutes for TSF/IMK native input methods.

The production web build writes a service worker that precaches the app shell and Vite hashed assets. Offline behavior is checked as part of `npm run verify`.

## Privacy Model

Typed text, converted text, dictionary queries, raw keystrokes, clipboard content, spell tokens, and output text stay local. The engine hot path must not use the network.

Feedback is explicit. The app prepares a report only when the user chooses to copy or submit it. A deployment can enable email handoff with `VITE_FEEDBACK_EMAIL`; otherwise the report remains local.

Correction memory is local, explicit, and user-controlled. It must not learn secure-field text, passwords, protected tokens, IDs, emails, URLs, or excluded app input.

## Current Quality Evidence

Current keyboard-specific evidence is produced by committed scripts and generated local reports:

| Gate | Status |
| --- | --- |
| Shared keyboard engine | `npm run test:keyboard` covers Romanized, Traditional Unicode suggestions, memory, protected tokens, secure pass-through, runtime pack candidates, trained context candidates, and inline next-word completion |
| Quantized inline completion model | `npm run build:ngram-lm` emits `35,000` local n-gram rows with NFC, self-loop, unsafe-token, duplicate, and spelling-quality validation |
| Core ML transliteration readiness | `npm run check:neural-transliteration` permits the current closed-vocabulary baseline only for dev/test and blocks production unless the open-vocabulary seq2seq/GRU/Transformer model, manifest, beam decoding, context reranking, measured latency, and local-only policy pass |
| macOS native bundle | `npm run package:macos:imk:test-installer` produces the unsigned IMK test installer zip for manual host-app validation |
| Privacy guard | `npm run check:privacy` blocks text telemetry payloads |
| Local-first guard | `npm run check:engine-local` verifies the hot path stays local |
| Runtime data guard | `npm run check:runtime-data` keeps benchmark/probe fixtures out of production source and build output |
| Production readiness | Still blocked until the signed/notarized app and real host-app matrix pass |

Internal fixture metrics are useful for regression control, but they are not public superiority claims and they are not a substitute for consented real-document validation or manually filled competitor outputs.

## Run Locally

Prerequisite: Node.js `^20.19.0` or `>=22.12.0`.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually:

```text
http://127.0.0.1:5173/
```

## Useful Commands

```bash
npm run test
npm run build
npm run check:privacy
npm run build:ngram-lm
npm run neural:dataset
npm run check:neural-transliteration
npm run check:offline
npm run check:runtime-data
npm run verify
npm run benchmark
npm run report:quality
npm run report:preeti
npm run dictionary:review
npm run rank:hunspell -- --apply --limit 36000
npm run package:macos:imk:test-installer
npm run restore:macos-keyboard
npm audit --audit-level=moderate
```

Fixture and data maintenance:

```bash
npm run generate:fixtures
npm run generate:wordlist
npm run ingest:preeti-real -- data/private/preeti-real-manifest.json
```

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
3. Run `npm run ingest:preeti-real -- data/private/preeti-real-manifest.json`.
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
