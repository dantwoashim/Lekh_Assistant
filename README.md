# Lekh Keyboard

Lekh Keyboard is a local-first Nepali desktop keyboard project. The target product is a real Windows/macOS input method that lets people type Nepali inside normal apps such as Word, Chrome, Edge, Safari, WhatsApp, VS Code, TextEdit, Pages, and browser forms.

Current repo status is deliberately narrower than that target:

- The React/Vite browser surface is a typing-engine validation demo.
- The Electron shell is a companion/demo shell for settings, diagnostics, packaging, and first-run validation.
- The native Windows TSF and macOS IMK paths are under active proof-spike development.
- The Electron/browser demo is **not** the keyboard app.
- The companion app is **not** the keyboard app.
- Preeti to Unicode is a side utility, not the main product.

The real keyboard product is the native input-method layer:

- Windows: TSF text service.
- macOS: InputMethodKit input method.
- Shared local keyboard engine for Romanized typing, Traditional typing, suggestions, proofread, dictionary, and personal memory.

## Contents

- [Why It Exists](#why-it-exists)
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

Nepali desktop users need a keyboard that works system-wide, understands real Romanized Nepali, preserves mixed English safely, and stays private by default. Existing copy-paste converters and browser boxes are not enough for the workflow Niraj requested.

The product direction is deliberately conservative and native-first:

- Build real Windows TSF and macOS IMK input methods.
- Keep typing local and offline in the hot path.
- Prefer documented rules, reviewed data, and measurable benchmarks over hidden magic.
- Show candidates when Romanized input is ambiguous.
- Preserve protected tokens such as NID, PAN, PDF, emails, URLs, numbers, and IDs.
- Treat Preeti conversion as a side utility.
- Avoid unclear-license language data.

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
- domain-ranked local suggestions for office, government, education, legal, names, and places
- casual Nepali completions such as `ramro xa`, `kasto cha`, and `dherai ramro`
- mixed Nepali-English policy candidates that preserve protected tokens and offer loanword preferences
- full-output alternatives so selecting a candidate does not collapse a sentence into a single word
- local correction memory after explicit candidate selection

### Traditional Nepali Typing

Traditional Unicode suggestions and proofread can be validated in the engine. Traditional physical key mapping remains blocked until an LTK-compatible/standard layout source of truth is captured and validated by experienced Traditional typists. The project must not claim Traditional physical keyboard completion before that validation.

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

Latest local validation, recorded on 2026-05-26:

| Gate | Status |
| --- | --- |
| TypeScript typecheck | Passing: `tsc -b --noEmit` |
| Unit and smoke tests | 115 passing tests |
| Production build | Passing; initial JS `2,801.18 kB` minified / `500.41 kB` gzip after the expanded local lexicon; lazy Hunspell chunk `956.45 kB` / `176.58 kB` gzip |
| Privacy guard | No text telemetry payloads found |
| Offline gate | Service worker precaches app shell, notices, and hashed assets; 8 precached URLs |
| Runtime data guard | Benchmark/probe fixtures are excluded from production source and build output |
| npm audit | 0 moderate-or-higher vulnerabilities |
| Preeti benchmark | 10,225 fixtures; generated/manual/held-out/competitor exact `1.0000`; CER/WER `0`; English preservation `1.0000` |
| Romanized benchmark | 6,730 fixtures; generated/manual/regression/hostile/competitor top-1/top-3/top-5/MRR `1.0000`; mixed-English corruption `0`; suggestion hit@5 `0.9872`; no current benchmark failures |
| Benchmark disjointness | Passing, with `romanized-held-out` quarantined as contaminated regression data and excluded from public proof |

Those numbers are internal fixture metrics. They are useful for regression control, but they are not a public superiority claim and they are not a substitute for consented real-document validation or manually filled competitor outputs.

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
npm run check:offline
npm run check:runtime-data
npm run verify
npm run benchmark
npm run report:quality
npm run report:preeti
npm run dictionary:review
npm run rank:hunspell -- --apply --limit 36000
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
- The larger Hunspell spell asset is lazy-loaded locally; first-use spell hints can lag slightly on slower machines.
- Suggestions focus on the trailing typed token. Candidate alternatives are full-output ranked paths, but full cursor-aware replacement in the middle of a sentence is future work.
- Local correction memory improves exact repeated inputs on the same browser only.
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

Lekh does not claim official language authority, government endorsement, perfect Preeti conversion, perfect transliteration, official spellchecking, grammar correction, native Windows/macOS keyboard support, a browser extension, sync, accounts, payments, or server-side text processing.
