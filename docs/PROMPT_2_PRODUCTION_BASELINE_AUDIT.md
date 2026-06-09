# Prompt 2 Production Baseline Audit

Generated: 2026-05-27

Baseline log directory: `/tmp/lekh_prod_p2_baseline_1779904028`

## Executive Summary

Prompt 1 foundation was present and stable before Prompt 2 feature work began. The required baseline loop passed end to end after `npm ci`, with fresh benchmark and scorecard reports generated under `bench/reports`.

Prompt 2 can proceed on top of the existing `KeyboardEngine` session API, Romanized live typing prototype, Traditional placeholder status, proofread hooks, dictionary lookup, local memory, Keyboard Lab, native scaffolds, and smoke/full verification split.

No native Windows TSF or macOS IMK production implementation exists at this baseline, and Traditional physical layout remains pending source-of-truth audit.

## Prompt 1 Acceptance Status

Prompt 1 completion evidence exists in:

- `docs/archive/generated-history/PROMPT_1_PRODUCTION_FOUNDATION_COMPLETION_REPORT.md`
- `docs/PROMPT_1_PRODUCTION_BASELINE_AUDIT.md`
- `docs/VERIFICATION_STABILITY_REPORT.md`
- `docs/KEYBOARD_ENGINE_API.md`
- `docs/TRADITIONAL_LAYOUT_DECISION.md`
- `docs/TRADITIONAL_LAYOUT_SOURCE_OF_TRUTH_AUDIT.md`
- `docs/NATIVE_IPC_CONTRACT.md`
- `docs/NATIVE_DAEMON_LIFECYCLE.md`
- `docs/LEKH_KEYBOARD_PRODUCTION_ARCHITECTURE.md`
- `docs/KEYBOARD_READINESS_GATE.md`
- `docs/KEYBOARD_PERFORMANCE_BASELINE.md`
- `docs/KEYBOARD_PRIVACY_AND_SECURITY_MODEL.md`

Status: complete for repo-executable Prompt 1 scope.

## Current Verification Status

All baseline commands passed.

| Command | Status | Notes |
| --- | --- | --- |
| `npm ci` | pass | 171 packages, 0 vulnerabilities |
| `npm run typecheck` | pass | TypeScript project references clean |
| `npm run test` | pass | 27 files, 166 tests |
| `npm run build` | pass | Known large chunk warning remains |
| `npm run check:privacy` | pass | No hidden text telemetry detected |
| `npm run check:engine-local` | pass | Engine remains local-first |
| `npm run check:engine-no-dom` | pass | Engine avoids DOM dependency |
| `npm run check:user-data` | pass | User data safety check passed |
| `npm run check:benchmark-disjointness` | pass | Report refreshed |
| `npm run benchmark:typing-session` | pass | 33 fixtures, 0 failures |
| `npm run benchmark:romanized` | pass | 776 fixtures, top-1 1.0 |
| `npm run benchmark:romanized:self:smoke` | pass | 390 fixtures, 0 failures |
| `npm run benchmark:proofread` | pass | 9 fixtures, exact match 1.0 |
| `npm run benchmark` | pass | Summary and typing-session pass |
| `npm run bench:perf:smoke` | pass | 12 performance cases |
| `npm run scorecard:engine` | pass | Required reports fresh |
| `npm run verify` | pass | Default verification stable |
| `npm audit --audit-level=moderate` | pass | 0 vulnerabilities |

## Current Romanized Behavior

Romanized mode already supports live session updates through `KeyboardEngine.updateComposition` and `KeyboardEngine.processKeyStroke`. Baseline typing-session results show Romanized suites passing, but Prompt 2 must expand coverage for additional government phrases, helper candidates, labels, protected mixed input, next-word predictions, KSR, and duplicate/shortcut metrics.

Current typing-session baseline:

- fixture count: 33
- Romanized sessions: 23
- Romanized top-1 hit rate: 1.0
- Romanized top-3 hit rate: 1.0
- failed sessions: 0
- mean KSR: 0.1294
- candidate p95: 6 ms
- update p95: 6 ms

## Current Traditional Status

Traditional physical keymap is not production enabled. Pending layout files and audit docs exist, and the engine preserves honest warnings instead of inventing mappings.

Current Traditional behavior:

- physical Latin-key Traditional mapping: pending LTK/manual audit
- Unicode prefix suggestions: present in lab/benchmark path
- proofread over Unicode input: present where fixtures exercise it
- placeholder warning: present

Prompt 2 must keep physical layout pending unless verified layout artifacts are available.

## Current Candidate Dedupe And Shortcut Status

Prompt 1 added dedupe, reason merging, and sequential shortcut assignment in `src/engine/keyboard/candidates.ts`. Baseline tests pass. Prompt 2 must preserve this while expanding sources, helper lanes, memory boosting, phrase completions, and next-word candidates.

## Current Proofread Status

Proofread benchmark passed with 9 fixtures, exact match rate 1.0, and 4 generated hint cases. Prompt 2 must deepen typing-flow integration and add fixture coverage for additional common mistakes and postposition spacing.

## Current Dictionary Status

Dictionary lookup is local and meaning-safe: it reports canonical spelling, aliases, tags, and variants where available, without inventing licensed meanings. Baseline dictionary typing-session suite passed 3 cases.

Prompt 2 must expose lookup more clearly in Keyboard Lab and add dictionary fixtures for additional Romanized and Unicode queries.

## Current Memory Status

Local correction memory exists and typing-session baseline includes one passing memory-ranking case. Prompt 2 must expand tests for repeated selection, rejected candidates, pinned/preferred behavior where supported, never-suggest behavior, and secure-input non-recording.

## Current Keyboard Lab Status

Keyboard Lab exists and exposes composition, display text, candidates, shortcuts, proof hints, dictionary, memory/followups, latency, warnings, and debug reason view. Prompt 2 must add secure-input simulation, clearer helper-candidate lane, label toggles, richer dictionary/memory surfaces, and explicit validation-only copy.

## Current Companion Status

Native companion scaffold documentation exists under `native/companion`, but there is not yet a Prompt 2 MVP shell in the web app. Prompt 2 must add a lightweight companion shell/scaffold without claiming it is the IME.

## Current Benchmark Status

Fresh reports exist for required Prompt 2 baseline:

- `bench/reports/typing-session-report.json`
- `bench/reports/romanized-report.json`
- `bench/reports/romanized-self-consistency-report.json`
- `bench/reports/proofread-report.json`
- `bench/reports/perf-report.json`
- `bench/reports/benchmark-disjointness-report.json`
- `bench/reports/engine-scorecard.json`

Scorecard marks required reports fresh and optional stale reports honestly.

## What Prompt 2 Must Improve

- broaden Romanized phrase and government-office coverage;
- add Romanized helper candidates for required prefixes;
- make Romanized labels toggleable and reliable;
- keep dedupe and shortcuts stable under more sources;
- expand next-word prediction fixtures;
- preserve Traditional physical layout pending status unless audited artifacts exist;
- add more Traditional Unicode suggestion and proofread cases;
- improve dictionary, proofread, memory, and personal dictionary coverage;
- upgrade Keyboard Lab validation UI;
- add companion MVP shell/scaffold;
- expand typing-session metrics for duplicate candidates and shortcut validity;
- update scorecard and docs with honest Prompt 2 intelligence status;
- rerun the full Prompt 2 verification loop.
