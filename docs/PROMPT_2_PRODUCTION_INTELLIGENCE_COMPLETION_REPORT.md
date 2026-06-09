# Prompt 2 Production Intelligence Completion Report

Generated: 2026-05-27

Final verification log directory: `/tmp/lekh_prod_p2_final_1779905470`

## 1. Executive Summary

Prompt 2 production-intelligence work is complete for repo-executable scope. The repository remains ready for Prompt 3 native production work.

Implemented:

- Romanized live typing coverage expansion;
- Romanized helper suggestions;
- Romanized labels for known strong candidates;
- candidate dedupe, reason merging, and sequential shortcut metrics;
- phrase completion and conservative next-word baseline;
- Traditional Unicode suggestions and proofread while keeping physical layout pending;
- dictionary lookup without unsafe meanings;
- local correction memory, pinned entries, and never-suggest blocking;
- secure-input simulation and enforcement;
- upgraded Keyboard Lab validation surface;
- companion MVP shell/scaffold;
- expanded typing-session benchmarks and scorecard sections;
- Prompt 2 documentation.

Intentionally not implemented:

- production Windows TSF IME;
- production macOS IMK input method;
- fake Traditional physical keymap;
- unsafe dictionary meanings;
- Rust port;
- monorepo restructure;
- public-release readiness claim.

## 2. Prompt 1 Foundation Status

Prompt 1 foundation remained intact:

- `KeyboardEngine` API preserved;
- `processKeyStroke` remains required;
- session lifecycle preserved;
- secure input behavior preserved;
- smoke/full verification split preserved;
- native TSF/IMK scaffolds preserved.

## 3. Romanized Live Typing

Files changed:

- `src/engine/keyboard/candidates.ts`
- `src/engine/keyboard/helpers.ts`
- `src/engine/keyboard/followups.ts`
- `src/engine/keyboard/index.ts`
- `src/engine/keyboard/keyboardEngine.test.ts`

Passing examples include `swas`, `swasthya`, `swasthya karyalaya`, `jilla pra`, `jilla prashasan karyalaya`, `nagarikta pr`, `janma dar`, `mrityu dar`, `rajaswa shakha`, `kar karyalaya`, `sankalpa`, and `driDha`.

Protected inputs such as email, URL, file name, form number, and mixed `NID form` cases remain preserved.

## 4. Romanized Helper Suggestions

Helper candidates exist for `swas`, `karya`, `nagarik`, `rajaniti`, `shik`, and `pra`. They are typed as `romanized-helper`, stay secondary to Unicode candidates, and selecting a helper refines composition rather than committing Unicode.

## 5. Romanized Labels

Labels are optional via `showRomanizedLabels`. Known phrase/word labels are supplied from curated aliases or trace-safe mappings. Labels do not participate in dedupe.

## 6. Candidate Ranking, Dedupe, And Shortcuts

Prompt 2 preserved the Prompt 1 pipeline and added benchmark metrics:

- duplicate candidate count: 0;
- shortcut sequence validity: 1.0;
- Romanized label hit rate: 1.0.

Latency is not part of linguistic ranking.

## 7. Phrase Completion

Government and office phrase completions were expanded for health office, district administration, citizenship certificate, birth/death registration, revenue section, tax office, and education ministry examples.

## 8. Next-Word Prediction

Baseline followups pass for:

- जिल्ला -> प्रशासन;
- नेपाल -> सरकार;
- स्वास्थ्य -> कार्यालय;
- जन्म -> दर्ता;
- मृत्यु -> दर्ता.

No network service is used.

## 9. Traditional Mode Status

Traditional physical keymap remains `blocked-human` because verified source-of-truth layout data is not manually captured yet. Prompt 2 does not fake LTK mappings.

Traditional Unicode suggestions and proofread work for Unicode input in Keyboard Lab and benchmarks.

## 10. Proofread While Typing

`CandidateUpdate.proofHints` is populated for spelling, normalization, and postposition cases. Covered examples include `सवस्थ्य`, `प्रनलि`, `राजनितिज्ञ`, `हरु`, `विद्यालय को`, and `मन्त्रालय ले`.

## 11. Dictionary Lookup

Dictionary lookup works offline through `KeyboardEngine.lookupDictionary()`. It returns canonical spelling, aliases, domains, variants, and source/provenance where available. Meanings remain omitted until a safe licensed source exists.

## 12. Local Memory And Personal Dictionary

Local memory can boost accepted candidates, honor pinned entries, and block never-suggest candidates. Secure input disables candidates and memory writes.

Native SQLite/storage adapters remain Prompt 3 work.

## 13. Keyboard Lab

Keyboard Lab now exposes:

- mode selector;
- composition and display text;
- candidates and shortcuts;
- Romanized label toggle;
- Romanized helper lane;
- proof hints;
- dictionary lookup;
- memory/followup status;
- secure-input simulation;
- latency and warnings;
- candidate reasons.

The UI states that Keyboard Lab validates the engine and the final product is a native Windows/macOS IME.

## 14. Companion Shell

Added:

- `src/features/companion/CompanionShell.tsx`;
- `src/features/companion/settings.ts`;
- Companion tab in `src/app/App.tsx`;
- docs in `docs/COMPANION_APP_MVP.md`.

The companion shell is not the IME, not a global key hook, and not foreground text capture.

## 15. Benchmark Results

Final typing-session report:

- fixture count: 58;
- failed sessions: 0;
- Romanized top-1/top-3: 1.0 / 1.0;
- proofread hit rate: 1.0;
- dictionary hit rate: 1.0;
- memory boost success: 1.0;
- next-word success: 1.0;
- Romanized label hit rate: 1.0;
- duplicate candidate count: 0;
- shortcut sequence validity: 1.0;
- KSR mean baseline: 0.0339;
- update p95: 5 ms;
- commit p95: 0 ms.

## 16. Performance Results

Final `bench:perf:smoke` keyboard hot-path p95:

| Case | p95 ms |
| --- | ---: |
| Romanized live update | 8 |
| Candidate count cap | 8 |
| Traditional Unicode suggestion | 9 |
| Proofread hint update | 1 |
| Dictionary lookup | 16 |
| Memory ranking update | 7 |
| Candidate commit | 5 |
| Warm startup | 0 |
| Partial warm timeout | 1 |

Build still reports large chunks; Prompt 3 should continue bundle/performance hardening.

## 17. Scorecard Updates

`scorecard:engine` now includes Prompt 2 sections for Romanized live typing, helpers, labels, dedupe/shortcuts, ranking, next-word, Traditional status, proofread, dictionary, memory, Keyboard Lab, companion shell, performance, privacy, native scaffold, and release readiness.

Traditional physical layout is marked `blocked-human`. Native release readiness is `pending`.

## 18. Privacy Status

Prompt 2 remains local-first:

- no typed-text upload;
- no hidden telemetry;
- no network in normal typing;
- secure input disables candidates/proofread/memory;
- dictionary meanings are not fabricated.

## 19. Verification Command Table

| Command | Status | Duration |
| --- | --- | ---: |
| `npm run typecheck` | pass | 1.7s |
| `npm run test` | pass | 21.2s |
| `npm run build` | pass | 2.7s |
| `npm run check:privacy` | pass | 0.3s |
| `npm run check:engine-local` | pass | 0.3s |
| `npm run check:engine-no-dom` | pass | 0.3s |
| `npm run check:user-data` | pass | 0.3s |
| `npm run check:benchmark-disjointness` | pass | 0.5s |
| `npm run benchmark:typing-session` | pass | 2.4s |
| `npm run benchmark:romanized` | pass | 16.1s |
| `npm run benchmark:romanized:self:smoke` | pass | 2.4s |
| `npm run benchmark:proofread` | pass | 1.7s |
| `npm run benchmark` | pass | 20.2s |
| `npm run bench:perf:smoke` | pass | 4.0s |
| `npm run scorecard:engine` | pass | 0.3s |
| `npm run verify` | pass | 74.4s |
| `npm audit --audit-level=moderate` | pass | 1.7s |

## 20. Remaining Prompt 3 Work

- Windows TSF proof spike / native implementation path;
- macOS IMK proof spike / native implementation path;
- daemon/service implementation;
- IPC productionization;
- native storage adapters;
- installer/signing/notarization docs and gates;
- pilot feedback system;
- final native readiness closure.

## 21. External Blockers

- Windows code-signing certificate unavailable;
- Apple Developer ID/notarization unavailable;
- real Windows/macOS native test environment unavailable;
- human LTK layout validation unavailable;
- licensed dictionary meaning source unavailable.

## 22. Readiness For Prompt 3

Ready for Prompt 3 native production work. Repo-executable keyboard intelligence is in place, measured, documented, and conservative about remaining native/human blockers.
