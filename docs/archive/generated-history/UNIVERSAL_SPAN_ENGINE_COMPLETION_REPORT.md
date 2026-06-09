# Universal Span Engine Completion Report

Updated: 2026-05-27T06:08:21Z

## Executive Summary

Implemented the universal typed span segmentation and span-routed conversion pipeline for mixed Nepali office text. The engine now routes Unicode Nepali, Preeti legacy islands, Romanized Nepali, English preserve spans, English stems with Nepali suffixes, protected identifiers, numbers, URLs, emails, files, punctuation, and unknown risky spans independently.

The scoped locked-suite result is clean: mixed span mutation exact output `1.0000`, action match `1.0000`, protected preservation `1.0000`, and silent corruption rate `0`.

Keyboard app implementation remains unstarted. Planning can continue, but native input work should wait for real-user validation and the prerequisites in `KEYBOARD_APP_PREREQUISITES.md`.

## Baseline Failures Fixed

- Mixed Unicode + Preeti islands such as `मृत्य' btf{`, `स'dg clwsf/L`, and `b'em]/ sfo{qmdsf nIox? k|fKt`.
- Romanized mixed-office cases such as `English tokenharu`, `jastaa`, `karyalayakaa`, `bhandaa bhandai`, `shabdaharu pani`, `samrakshaN`, `bhayeko`, `rakhnuparne`, and `kothamaa`.
- Scorecards now include a mixed-span mutation suite, so aggregate perfect scores no longer hide this class of failure.

## UniversalSpanSegmenter

Implemented under `src/engine/segmentation`.

Key properties:

- every character belongs to exactly one typed span
- URL/email/phone/file/form/ward/date/acronym protection wins first
- Preeti island detection uses profile coverage, sequence coverage, high-signal patterns, surrounding Nepali context, and English/protected penalties
- English stems with Nepali suffixes are a separate span kind
- low-confidence spans become `unknown-risky` and are warned/preserved

## Span Routing

Implemented under `src/engine/router`, `src/engine/lattice`, and `src/engine/verify`.

Routes:

- Unicode Nepali: preserve/proofread path
- Preeti legacy: baseline converter plus reviewed island repairs
- Romanized Nepali: existing candidate engine plus morphology repairs
- English suffix: preserve stem and convert suffix
- protected spans: byte-exact preserve
- unknown risky: warn/preserve

New modes:

- `romanized-mixed-office`
- `preeti-mixed-document`
- `mixed-unicode-legacy-repair`
- `diagnostic`

## Mutation Oracle Results

`npm run benchmark:mixed-span-mutations`:

| Metric | Value |
| --- | ---: |
| fixtures | 25 |
| exact output rate | 1.0000 |
| action match rate | 1.0000 |
| protected preservation | 1.0000 |
| silent corruption rate | 0 |
| failures | 0 |

## Benchmark Results

Latest scorecard:

- Romanized: top-1/top-3/top-5/MRR `1.0000`; hard-hostile fixtures `24`; self-consistency `2,130` fixtures, failures `0`.
- Preeti: `10,225` fixtures, exact `1.0000`, CER `0`, WER `0`.
- Protected spans: `12/12` preserved.
- Proofread: `9/9` exact.
- Competitor probes: Lekh expected-pass `10/10`; competitor outputs pending manual collection.
- Disjointness: `romanized-held-out` remains quarantined as contaminated regression; hard failure suites `0`.

## UI Safety Visibility

Romanized UI now displays span-route action, route confidence, typed span count, protected count, warnings, and span diagnostics while preserving the existing candidate workflow.

Preeti UI now includes a Repair mode for `mixed-unicode-legacy-repair` and displays action, typed span count, decoder/profile information, unknown glyphs, and warnings.

## Bundle And Performance

Latest `npm run build`:

- first-load app shell: `200.52 kB` minified / `63.63 kB` gzip
- shared engine/data chunk: `2,658.99 kB` minified / `452.47 kB` gzip
- Hunspell chunk: `956.51 kB` minified / `176.62 kB` gzip

Latest `npm run bench:perf`:

- 50-token hostile Romanized mixed sentence p95: `13 ms`
- 5KB mixed Preeti paragraph p95: `143 ms`

The shared engine/data chunk is acceptable for controlled testing but remains a future optimization target.

## Verification Command Results

| Command | Status |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run test` | Pass: 23 files, 143 tests |
| `npm run build` | Pass |
| `npm run check:privacy` | Pass |
| `npm run check:engine-local` | Pass |
| `npm run check:engine-no-dom` | Pass |
| `npm run check:user-data` | Pass |
| `npm run check:benchmark-disjointness` | Pass |
| `npm run audit:preeti-source` | Pass |
| `npm run benchmark:protected` | Pass |
| `npm run benchmark:preeti` | Pass |
| `npm run benchmark:preeti:fuzz` | Pass |
| `npm run benchmark:preeti:roundtrip` | Pass |
| `npm run benchmark:romanized` | Pass |
| `npm run benchmark:romanized:self` | Pass |
| `npm run benchmark:proofread` | Pass |
| `npm run benchmark:competitor` | Pass |
| `npm run benchmark:mixed-span-mutations` | Pass |
| `npm run benchmark` | Pass |
| `npm run bench:perf` | Pass |
| `npm run scorecard:engine` | Pass |
| `npm run verify` | Pass |
| `npm audit --audit-level=moderate` | Pass: 0 vulnerabilities |

The final push gate passed locally.

## Remaining Blockers

- Human-data: no consented real-user documents are committed.
- Market comparison: competitor outputs are pending manual collection.
- Platform-native: keyboard app, Tauri, Windows TSF, macOS InputMethodKit, and Keyman/provider shells are not implemented.
- Optimization: shared engine/data chunk should be split or compacted before broad public launch.

## Keyboard App Readiness

The repository is ready for serious web demo review. It is not yet ready for native keyboard implementation beyond planning. The next concrete step is controlled demo testing with real examples and consented fixture intake.
