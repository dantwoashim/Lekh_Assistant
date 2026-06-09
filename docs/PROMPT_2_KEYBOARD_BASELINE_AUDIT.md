# Prompt 2 Keyboard Baseline Audit

Generated: 2026-05-27

## Prompt 1 Completion Status

Prompt 1 foundation is present and intact:

- `docs/archive/generated-history/PROMPT_1_KEYBOARD_COMPLETION_REPORT.md` exists.
- keyboard-first scope freeze exists.
- Engineering MVP vs Product MVP documentation exists.
- Traditional layout source-of-truth audit scaffold exists.
- `src/engine/keyboard/*` exists.
- `KeyboardEngine` exposes required `processKeyStroke`.
- session lifecycle, composition update, commit/cancel, warm, and UTF-16 range helpers exist.
- Keyboard Lab exists in the browser prototype.
- typing-session benchmark and scorecard integration exist.
- native feasibility docs exist without native implementation.

The first baseline wrapper attempt used the zsh read-only variable name `status` and stopped before useful measurement. The loop was rerun with `cmd_status`; the rerun is the baseline recorded below.

## Existing Keyboard API Status

The API is additive and preserves the existing converter facade. `src/engine/index.ts` exports keyboard types with aliases where needed, while `convert`, `convertRomanized`, and `convertPreeti` remain backward compatible.

Current behavior:

- Romanized mode returns per-keystroke `CandidateUpdate` objects.
- Traditional mode is a safe placeholder because only pending layout artifacts exist.
- secure/password/code contexts return raw pass-through behavior and avoid memory writes.
- warm startup reports ready/partial state and does not block indefinitely.

## Existing Keyboard Lab Status

The Keyboard Lab tab exists and shows:

- mode selection
- raw composition input
- display preview
- candidates
- proof hints
- warnings
- latency
- commit/cancel/raw controls

Prompt 2 should expand this lab with helper suggestions, labels, dictionary, memory status, followups, and clearer Traditional/proofread surfaces.

## Existing Romanized Candidate Behavior

Baseline typing-session examples pass:

- `swas` includes `स्वास्थ्य`.
- `swasthya` produces `स्वास्थ्य`.
- `swasthya karyalaya` produces `स्वास्थ्य कार्यालय`.
- `jilla pra` produces `जिल्ला प्रशासन`.
- `nagarikta pr` produces `नागरिकता प्रमाणपत्र`.
- `rajaniti` produces `राजनीति`.
- `raajanitigya` produces `राजनीतिज्ञ`.
- `mero NID form` preserves `NID` and `form`.

Gaps for Prompt 2:

- Romanized helper suggestions are not yet first-class.
- Romanized labels are not consistently attached to candidates.
- memory does not yet influence keyboard ranking.
- follow-up candidates are not yet meaningful.

## Existing Traditional Layout Artifact Status

Only pending layout scaffolds are present:

- `data/layouts/traditional-ltk-compatible.pending.json`
- `data/layouts/traditional-standard.pending.json`
- `bench/fixtures/traditional-layout/layout-audit.pending.jsonl`

No verified `traditional-ltk-compatible.json` or `traditional-standard.json` is present. Prompt 2 must not invent final key mappings. Unicode-prefix suggestions and proofread can still work in Traditional mode where Unicode input is already available.

## Existing Proofread Status

`npm run benchmark:proofread` passes with 9 fixtures, exact match rate 1.0000, and `autoFixPrecisionProxy` 1.0000. Keyboard proof hints exist through the wrapper but need stronger live-update tests and UI surfacing.

## Existing Dictionary/Memory Status

Dictionary:

- existing dictionary and lexical authority modules are local.
- current keyboard lookup is safe but minimal.
- meanings are not available from a safe licensed source and must not be fabricated.

Memory:

- engine memory tests pass.
- keyboard sessions avoid memory in secure fields.
- Prompt 2 must connect candidate commits to a keyboard-local memory ranking boost.

## Existing Benchmark Status

Baseline command results:

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
| `npm run benchmark:typing-session` | Pass |
| `npm run benchmark:romanized` | Pass |
| `npm run benchmark:proofread` | Pass |
| `npm run benchmark` | Pass |
| `npm run bench:perf` | Pass |
| `npm run scorecard:engine` | Pass |
| `npm run verify` | Pass |
| `npm audit --audit-level=moderate` | Pass, 0 vulnerabilities |

Baseline typing-session metrics:

- fixture count: 11
- Romanized sessions: 9
- Traditional placeholder sessions: 2
- Romanized top-1: 1.0000
- Romanized top-3: 1.0000
- failed sessions: 0
- candidate p95: 3 ms in scorecard run
- update p95: 3 ms in scorecard run
- commit p95: 0 ms
- mean KSR: 0.0840

## Failures Before Prompt 2 Changes

No verification command failed after the shell wrapper was corrected.

Known non-failing blockers:

- Traditional final keymap is blocked on human/manual layout audit.
- dictionary meanings are blocked on safe licensed data.
- competitor comparison remains pending manual collection.
- `romanized-held-out` remains marked contaminated by disjointness and excluded from public proof.
