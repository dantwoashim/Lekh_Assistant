# Prompt 2 Keyboard Completion Report

Completed: 2026-05-27

## 1. Executive Summary

Prompt 2 implemented the keyboard intelligence layer on top of the Prompt 1 `KeyboardEngine` foundation.

Implemented:

- Romanized live typing candidates through `KeyboardEngine`.
- Romanized helper suggestions.
- optional Romanized labels on Devanagari candidates.
- bounded keyboard ranking with protected-token and memory priority.
- Traditional physical-key placeholder safety plus Traditional Unicode suggestions.
- proofread while typing.
- local dictionary lookup.
- local correction memory integration.
- conservative next-word followups.
- upgraded Keyboard Lab UI.
- expanded typing-session benchmark and scorecard.
- keyboard hot-path performance coverage.

Intentionally not implemented:

- production Windows TSF IME;
- production macOS InputMethodKit IME;
- Rust hot-path port;
- monorepo restructure;
- full Tauri companion app;
- fake Traditional keymaps;
- unsafe dictionary meanings.

Repo status: ready for Prompt 3 native/companion/release scaffolding.

## 2. Prompt 1 Foundation Status

- API preserved: `src/engine/keyboard/*` remains the public keyboard layer.
- Session lifecycle preserved: begin/update/process/commit/cancel/end all remain covered.
- Benchmark preserved: `npm run benchmark:typing-session` now covers 33 fixtures.
- Docs preserved: scope, API, onboarding, native feasibility, IPC, and layout audit docs remain in place.

## 3. Romanized Live Typing

Files changed:

- `src/engine/keyboard/candidates.ts`
- `src/engine/keyboard/helpers.ts`
- `src/features/keyboard/*`
- typing-session fixtures and benchmark.

Examples passing:

- `swas` -> `स्वास्थ्य`
- `swasthya` -> `स्वास्थ्य`
- `swasthya karyalaya` -> `स्वास्थ्य कार्यालय`
- `jilla pra` -> `जिल्ला प्रशासन`, `जिल्ला प्रशासन कार्यालय`
- `nagarikta pr` -> `नागरिकता प्रमाणपत्र`
- `rajaniti` -> `राजनीति`
- `raajanitigya` -> `राजनीतिज्ञ`
- `mero NID form` preserves `NID form`

Candidate behavior:

- primary Unicode candidate previews in `displayText`;
- raw Romanized buffer remains in `compositionText`;
- helper suggestions appear after stronger Unicode candidates;
- labels are optional through `showRomanizedLabels`.

Limitations:

- current coverage is benchmark/fixture driven;
- native candidate windows are Prompt 3 scope.

## 4. Traditional Mode

Layout audit data: not yet verified.

Status:

- physical key mapping remains placeholder-pending;
- Latin Traditional input is preserved with warning;
- no fake LTK or standard layout is shipped as truth;
- Unicode Traditional suggestions are active for Devanagari buffers.

Examples:

- `स्वा` -> `स्वास्थ्य`
- `कार्या` -> `कार्यालय`
- `जिल्ला प्रशा` -> `जिल्ला प्रशासन`
- `सवस्थ्य` -> proof hint `स्वास्थ्य`
- `विद्यालय को` -> proof hint `विद्यालयको`

Risk:

- Traditional production typing cannot proceed until the source-of-truth layout audit is complete.

## 5. Candidate Ranking

Ranking factors:

- protected token safety;
- local memory;
- exact keyboard phrase rows;
- dictionary and phrase prefix match;
- existing Romanized candidates;
- Romanized helper suggestions;
- collision/ambiguity safety.

Caps:

- max displayed candidates: 8;
- helper suggestions are bounded and reserved near the tail;
- generated candidates remain capped.

Collision behavior:

- high-collision aliases remain candidate-based rather than forced auto output.

Memory boost:

- committed candidate choices can rise to top rank in future matching contexts.

## 6. Proofread While Typing

Integrated rules:

- spelling hints;
- postposition hints;
- normalization hints through existing proofread engine.

Range behavior:

- proof hints preserve engine-provided UTF-16 ranges.

Limitations:

- hints are conservative and not destructive;
- secure/password/code fields return no proof hints.

## 7. Dictionary Lookup

Sources:

- existing lexicon authority;
- local seed word data;
- runtime dictionary rows where available.

Safe data status:

- local only;
- no unsafe meaning data added.

Meanings:

- omitted unless a safe licensed source is added later.

## 8. Local Memory

Behavior:

- `commitCandidate` records local selection outside secure contexts;
- repeated selection can boost a candidate;
- memory is not recorded in secure/password/code contexts;
- memory does not override protected structured tokens.

Storage status:

- in-engine local memory for Prompt 2;
- native persistent adapters belong to Prompt 3.

## 9. Next-Word Prediction

Baseline behavior:

- `जिल्ला` -> `प्रशासन`, `कार्यालय`
- `स्वास्थ्य` -> `कार्यालय`, `सेवा`, `मन्त्रालय`
- `नेपाल` -> `सरकार`

Data source:

- small local phrase-continuation table.

Limitations:

- no statistical language model;
- no auto-insertion;
- user action required.

## 10. Keyboard Lab

Added UI:

- mode switcher;
- Romanized label toggle;
- candidate panel with reasons;
- proof hint panel;
- dictionary panel;
- memory/followup panel;
- warnings, confidence, and latency display.

How to test:

- run `npm run dev`;
- open the `Keyboard Lab` tab;
- try `swasthya karyalaya`, `jilla pra`, `Form No. 2079-080`, `स्वा`, and `विद्यालय को`.

## 11. Benchmarks

Typing-session fixtures: 33.

Latest results:

- failed sessions: 0;
- Romanized top-1: 1.0000;
- Romanized top-3: 1.0000;
- Traditional placeholder sessions: 2;
- Traditional Unicode suggestion sessions: 3;
- proof hint hit rate: 1.0000;
- dictionary hit rate: 1.0000;
- memory boost success: 1.0000;
- next-word success: 1.0000;
- candidate p95: 2 ms;
- update p95: 2 ms;
- commit p95: 0-1 ms;
- KSR baseline: about 0.1294.

Performance:

- Romanized keyboard update p95: 2 ms;
- Traditional Unicode suggestion p95: 2 ms;
- proof hint p95: 0 ms;
- dictionary lookup p95: 5 ms;
- memory ranking p95: 2 ms;
- candidate commit p95: 2 ms.

## 12. Scorecard

Updated sections:

- Keyboard intelligence and typing sessions.
- suite-separated typing benchmark status.
- proofread/dictionary/memory/next-word rates.
- Traditional audit status.
- native status.

Pending/native status:

- Traditional physical layout audit pending.
- TSF/IMK native integration pending Prompt 3.
- competitor collection still pending manual collection.

## 13. Verification Status

Final verification loop:

| Command | Status |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run test` | Pass |
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
| `npm run benchmark:typing-session` | Pass |
| `npm run benchmark` | Pass |
| `npm run bench:perf` | Pass |
| `npm run scorecard:engine` | Pass |
| `npm run verify` | Pass |
| `npm audit --audit-level=moderate` | Pass, 0 vulnerabilities |

Browser check:

- Keyboard Lab rendered with candidates and dictionary panel in the local browser.
- Browser screenshot capture timed out in the browser runtime; DOM and React smoke checks passed.

## 14. Remaining Work For Prompt 3

- Windows TSF feasibility skeleton.
- macOS IMK feasibility skeleton.
- daemon/IPC scaffold.
- companion app shell.
- native storage adapters.
- packaging docs.
- final performance hardening.
- final release readiness report.
