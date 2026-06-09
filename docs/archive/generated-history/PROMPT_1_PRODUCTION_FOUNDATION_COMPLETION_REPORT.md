# Prompt 1 Production Foundation Completion Report

Generated: 2026-05-27

Final verification log directory: `/tmp/lekh_prod_p1_final_1779903362`

## 1. Executive Summary

Prompt 1 production-foundation work is complete for repo-executable scope.

Implemented:

- full baseline audit;
- stable smoke/full verification split;
- non-hanging default test and verify paths;
- scorecard refactor to read fresh existing reports;
- report metadata and freshness checks;
- candidate dedupe, reason merging, and sequential shortcut cleanup;
- KeyboardEngine API hardening for native/browser paths;
- Traditional layout audit framework and validator;
- native IPC diagnostics contract;
- production architecture, release gate, privacy, performance, and roadmap docs;
- Keyboard Lab clarity that it is validation only.

Intentionally not implemented:

- production Windows TSF IME;
- production macOS IMK input method;
- full companion desktop app;
- Rust port;
- monorepo restructure;
- fake Traditional physical keymap;
- unsafe dictionary meaning data.

Repository is ready for Prompt 2 keyboard intelligence/product UX work, with Traditional physical typing still pending verified layout data.

## 2. Baseline Audit Summary

Created `docs/PROMPT_1_PRODUCTION_BASELINE_AUDIT.md`.

Baseline results:

- `npm ci`: pass.
- `npm run test`: pass, 27 files and 163 tests at baseline.
- `npm run verify`: pass but too heavy at about 96s.
- `scorecard:engine`: pass but recomputed expensive benchmark logic.
- build: pass with known large chunk warning.
- privacy/local/no-DOM/user-data checks: pass.

Baseline risks fixed in this prompt:

- default verification was too expensive;
- scorecards could be stale or too easy to misread;
- generated fixture scripts rewrote unchanged files and falsely staled reports;
- candidate duplicates/shortcut gaps were possible;
- Traditional layout pending status needed a validator and decision doc.

## 3. Verification Stability Fixes

Created `docs/VERIFICATION_STABILITY_REPORT.md`.

Changes:

- `bench:perf` now maps to `bench:perf:smoke`.
- Added `bench:perf:full`.
- Added `benchmark:romanized:smoke` and `benchmark:romanized:full`.
- Added `benchmark:romanized:self:smoke` and `benchmark:romanized:self:full`.
- Added `verify:full`.
- Default `verify` now runs smoke/default checks instead of the full heavy benchmark universe.
- `scorecard:engine` now reads existing reports from `bench/reports` and fails on required missing/stale/zero/schema-weak reports.
- Required report metadata now includes `generatedAt`, `command`, `suite`, `mode`, `durationMs`, and `fixtureCount`.
- `generate-benchmark-fixtures.ts` and `generate-mixed-span-mutation-fixtures.ts` only write when content changes, preventing false stale scorecards.

## 4. Test And Benchmark Results

Final mandated loop passed.

| Command | Status | Duration |
| --- | --- | ---: |
| `npm run typecheck` | pass | 0s |
| `npm run test` | pass | 24s |
| `npm run build` | pass | 3s |
| `npm run check:privacy` | pass | 0s |
| `npm run check:engine-local` | pass | 1s |
| `npm run check:engine-no-dom` | pass | 0s |
| `npm run check:user-data` | pass | 0s |
| `npm run check:benchmark-disjointness` | pass | 1s |
| `npm run benchmark:typing-session` | pass | 2s |
| `npm run benchmark:romanized` | pass | 15s |
| `npm run benchmark:romanized:self:smoke` | pass | 2s |
| `npm run benchmark:proofread` | pass | 2s |
| `npm run benchmark` | pass | 17s |
| `npm run bench:perf:smoke` | pass | 4s |
| `npm run scorecard:engine` | pass | 1s |
| `npm run verify` | pass | 46s |
| `npm audit --audit-level=moderate` | pass | 1s |

Final full test result: 27 files, 166 tests passed.

## 5. Scorecard Changes

Updated `scripts/generate-engine-scorecard.ts`.

Scorecard behavior:

- reads reports instead of recomputing heavy suites;
- marks required reports missing/stale/zero/schema-weak as failures;
- shows optional Preeti/mutation/alias reports honestly without failing smoke scorecard when optional reports are stale;
- separates Romanized, self-consistency, typing-session, proofread, performance, disjointness, native, and public-claim sections;
- lists allowed and forbidden public claims.

Final scorecard status:

- required reports: 6;
- fresh required reports: 6;
- hard failure count: 0.

## 6. Candidate Dedupe And Shortcut Fixes

Updated `src/engine/keyboard/candidates.ts`.

Behavior:

- candidates dedupe by normalized candidate text;
- duplicate reasons are merged;
- best candidate shape is retained by confidence/type priority;
- labels do not create fake uniqueness;
- shortcuts are assigned after final sort and cap;
- shortcuts are sequential with no gaps.

Tests added in `src/engine/keyboard/keyboardEngine.test.ts`:

- duplicate candidate text merges;
- reasons merge;
- shortcuts are sequential;
- live Romanized candidates are unique;
- unknown sessions return safe diagnostics.

Keyboard Lab now shows shortcut and merged candidate reasons.

## 7. KeyboardEngine API Hardening

Updated:

- `src/engine/keyboard/index.ts`
- `src/engine/keyboard/composition.ts`
- `src/engine/keyboard/candidates.ts`
- `docs/KEYBOARD_ENGINE_API.md`

Hardened behavior:

- unknown session IDs return safe diagnostic updates/results;
- malformed key events normalize missing modifiers;
- `processKeyStroke` remains required native path;
- `updateComposition` remains browser/lab path;
- `compositionText` and `displayText` are documented separately;
- `consumedRange` and `replacementRange` use UTF-16 boundary semantics;
- secure input remains memory/proofread/suggestion limited.

## 8. Traditional Layout Audit Status

Created:

- `docs/TRADITIONAL_LAYOUT_DECISION.md`
- `scripts/validate-traditional-layout-audit.ts`

Updated:

- `docs/TRADITIONAL_LAYOUT_SOURCE_OF_TRUTH_AUDIT.md`
- `package.json` with `audit:traditional-layout`

Status:

- LTK-compatible layout: pending manual capture.
- Standard layout: pending authoritative-source review.
- Pending files have `implementationAllowed: false`.
- No fake mapping is treated as production truth.
- Traditional Unicode suggestions remain allowed because they do not depend on guessed physical keymaps.

## 9. Native Proof-Spike Scaffolds

Existing native scaffolds were preserved and docs tightened:

- Windows TSF: `native/windows-tsf/*`, `docs/WINDOWS_TSF_FEASIBILITY_SPIKE.md`
- macOS IMK: `native/macos-imk/*`, `docs/MACOS_IMK_FEASIBILITY_SPIKE.md`
- daemon: `native/daemon/*`, `docs/NATIVE_DAEMON_LIFECYCLE.md`
- companion scaffold: `native/companion/README.md`

Status:

- scaffolded and actionable;
- not production native IME;
- Windows path uses TSF plus per-user named pipe;
- macOS path uses IMK plus XPC;
- fail-open/pass-through behavior is specified.

## 10. Daemon And IPC Contract Status

Updated:

- `native/shared/ipc/messages.ts`
- `native/shared/ipc/lekh-keyboard-ipc.schema.json`
- `docs/NATIVE_IPC_CONTRACT.md`

Added:

- `diagnostics.getMetrics`
- redacted metrics result shape;
- no typed-text diagnostics rule.

IPC maps directly to `KeyboardEngine` methods and keeps 50 ms hard timeout policy for hot keystroke paths.

## 11. Production Docs Created

Created:

- `docs/LEKH_KEYBOARD_PRODUCTION_ARCHITECTURE.md`
- `docs/KEYBOARD_PRODUCT_REQUIREMENTS.md`
- `docs/PRODUCTION_PUBLIC_CLAIMS_POLICY.md`
- `docs/KEYBOARD_PERFORMANCE_BASELINE.md`
- `docs/KEYBOARD_PRIVACY_AND_SECURITY_MODEL.md`
- `docs/PROTOTYPE_TO_PRODUCTION_EXECUTION_PLAN.md`
- `docs/KEYBOARD_NATIVE_RELEASE_CRITERIA.md`
- `docs/PRODUCTION_EXECUTION_ROADMAP.md`
- `docs/PROMPT_1_PRODUCTION_FOUNDATION_COMPLETION_REPORT.md`

Updated:

- `docs/KEYBOARD_READINESS_GATE.md`
- `docs/KEYBOARD_ENGINE_API.md`
- `docs/KEYBOARD_LAB.md` behavior through UI copy.

## 12. Performance Baseline

Final smoke metrics:

| Case | p95 ms |
| --- | ---: |
| Romanized hostile mixed sentence | 14-15 |
| 5KB mixed Preeti paragraph | 158 |
| KeyboardEngine warm startup | 1 |
| Partial warm timeout | 0 |
| Keyboard Romanized live update | 3 |
| Candidate count cap | 2-3 |
| Traditional Unicode suggestion | 3-4 |
| Proofread hint update | 0 |
| Dictionary lookup | 8 |
| Memory ranking update | 2-3 |
| Candidate commit | 2-3 |
| Native IPC JSON envelope simulation | 0 |

Build still warns about large chunks:

- `nepaliHunspell-*.js`: about 956.48 kB minified, 176.60 kB gzip.
- largest `index-*.js`: about 2,603.75 kB minified, 434.48 kB gzip.

Prompt 2/3 should keep heavy data lazy and ensure benchmark fixtures are never bundled into the hot UI path.

## 13. Privacy And Security Baseline

Created `docs/KEYBOARD_PRIVACY_AND_SECURITY_MODEL.md`.

Verified:

- no text telemetry payloads found;
- no network primitives in `src/engine`;
- no DOM/browser hot-path APIs in `src/engine`;
- no tracked raw/private files or obvious fixture PII found.

Model:

- no network in hot typing path;
- secure fields disable memory/proofread/suggestions or reduce behavior safely;
- diagnostics are redacted;
- pilot examples require consent;
- Windows named pipe is per-user;
- macOS IPC is XPC-scoped.

## 14. Keyboard Lab Status

Updated:

- `src/features/keyboard/KeyboardLab.tsx`
- `src/features/keyboard/CandidatePanel.tsx`

Status:

- visible copy says Keyboard Lab is a validation surface, not final native keyboard;
- candidate chips show shortcut, type, confidence, label, and merged reasons;
- existing Keyboard Lab behavior remains intact.

## 15. Remaining Prompt 2 Work

- Romanized live typing polish beyond foundation.
- Romanized helper and label UX refinement.
- Candidate ranking improvements using memory and domain context.
- Traditional physical typing only after verified layout artifacts exist.
- Traditional suggestions/proofread polish.
- Dictionary and memory UX depth.
- Next-word prediction improvements.
- Keyboard Lab polish and companion MVP shell.

## 16. Remaining Prompt 3 Work

- Real Windows TSF proof spike implementation and native tests.
- Real macOS IMK/XPC proof spike implementation and native tests.
- Daemon IPC runtime implementation.
- Companion app production shell.
- Native storage adapters.
- Installer/signing/notarization work.
- Private pilot feedback.
- Final native release readiness report.

## 17. External Blockers

- Apple Developer ID and notarization.
- Windows code-signing certificate.
- Real Windows/macOS native test environments.
- Human LTK/Traditional layout validation.
- Human pilot feedback.
- Safe licensed dictionary meaning source.

## 18. Commit And Push Note

The embedded Prompt 1 text said not to commit or push, but the user explicitly requested 10+ commits and a final push in this execution. This report follows the explicit user instruction for repository publishing while keeping product claims conservative.

## 19. Final Readiness For Prompt 2

Ready for Prompt 2. The repo foundation is stable, measurable, and honest. Prompt 2 can proceed with keyboard intelligence and UX work without pretending the browser lab is the native product or that Traditional physical layout is complete.
