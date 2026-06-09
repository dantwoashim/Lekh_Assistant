# Production Keyboard Completion Report

Generated: 2026-06-08

Final recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

## Executive Summary

Prompt 3 completed the repo-executable production-readiness work: engine hardening, Romanized coverage, Traditional audit gate, dev daemon dispatcher, IPC schema validation, native JSON storage adapters, companion shell packaging, native Windows/macOS implementation reports, release checklists, pilot/demo package, final scorecard, final readiness gate, final gap matrix, and final verification evidence.

The repo is ready for native implementation and stakeholder demo. It is not ready for public Windows/macOS launch because real native TSF/IMK validation, signing/notarization, human Traditional layout validation, and pilot feedback remain external/native/human blockers.

## What Was Fixed In Prompt 3

- Added Prompt 3 production baseline audit.
- Added IPC runtime validation and schema drift check.
- Added tested TypeScript development daemon dispatcher.
- Added tested native JSON file settings/dictionary/memory stores.
- Hardened KeyboardEngine native-path tests.
- Expanded Romanized production phrase coverage.
- Added Traditional layout capture gate.
- Hardened companion production shell.
- Detailed Windows TSF and macOS IMK/XPC proof paths.
- Added release, signing, installer, artifact, pilot, and stakeholder docs.
- Added focused dictionary and memory benchmark commands.
- Added final performance, scorecard, readiness, claims, and gap docs.

## KeyboardEngine Production Status

Status: complete for repo-executable/native-ready API.

Evidence:

- `processKeyStroke` and `updateComposition` paths tested.
- malformed native events pass through safely.
- Backspace/Delete/Tab/Escape/Space/Enter covered.
- multiple sessions and stale events covered.
- shutdown clears sessions and local memory.
- secure fields suppress candidates/proof hints/memory.
- no DOM/network engine checks pass.

## Romanized Production Status

Status: complete for engine/lab and ready for native validation.

Evidence:

- typing-session Romanized suites pass.
- live phrase examples include government, health, civil registration, protected-token, and formal phrase coverage.
- helper suggestions and labels are active.
- duplicate candidate count is 0.
- shortcut sequence validity is 1.

## Traditional Production Status

Status: mixed.

- Traditional Unicode suggestions/proofread: complete.
- Traditional physical keymap: `blocked-human`.

Reason:

The LTK-compatible physical layout source-of-truth has not been manually captured and validated by Traditional typists. Prompt 3 added `data/layouts/traditional-layout-capture-template.json` and validation rules so this cannot be faked.

## Proofread, Dictionary, Memory, Next-Word

Status: complete for repo-executable engine/lab behavior.

- proofread hit rate: 1.
- dictionary hit rate: 1.
- memory boost success rate: 1.
- next-word success rate: 1.
- secure input suppression covered.
- dictionary meanings remain blocked until a licensed source exists.

## Companion App Status

Status: partial desktop companion.

The companion shell exposes pages for settings, Romanized preferences, Traditional layout status, layout preview, candidates, proofread, dictionary, personal memory, privacy, diagnostics, Preeti side utility, import/export, and updates/about. It builds with `npm run build:companion`, and `npm run package:macos:unsigned` produces an unsigned development `.app` at `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/mac-arm64/Lekh Keyboard Companion.app`. It is explicitly not the IME and does not globally hook keys. Production companion release still needs signed/notarized packaging and daemon/service installation validation.

## Daemon and IPC Status

Status: complete for development daemon and contract.

- `native/daemon/src/keyboardDaemon.ts` handles all IPC messages.
- `native/shared/ipc/messages.ts` validates envelopes and creates responses.
- `scripts/check-ipc-schema.ts` prevents schema drift.
- `npm run test:native-scaffold` and `npm run build:daemon` pass.

Production OS service packaging remains native-platform work.

## Windows Native Status

Status: `blocked-native-environment`.

The Windows TSF path is build-ready as a proof-spike scaffold and documented in `docs/WINDOWS_NATIVE_IMPLEMENTATION_REPORT.md`. Production completion requires a Windows TSF environment, COM/profile registration, host-app tests, named pipe transport validation, signed MSI, and code-signing certificate.

## macOS Native Status

Status: `blocked-native-environment` plus `blocked-external` for signing/notarization.

The macOS IMK proof target now builds with `npm run build:macos` and includes `LekhInputController`, `LekhCandidateController`, and `LekhXpcClient`. Production completion still requires installed IMK/XPC validation, Developer ID signing, notarization, host-app tests, and packaging validation.

## Storage Status

Status: complete for dev/native proof path.

- In-memory stores remain available for browser/lab/tests.
- JSON file stores exist under `native/shared/storage/jsonFileStores.ts`.
- export/import/reset and secure-context memory suppression are tested.
- SQLite remains optional future hardening after native packaging and migration behavior are validated.

## Installer and Signing Status

Status: blocked-external/native-environment.

Docs created:

- `docs/WINDOWS_RELEASE_BUILD.md`
- `docs/MACOS_RELEASE_BUILD.md`
- `docs/SIGNING_AND_NOTARIZATION_CHECKLIST.md`
- `docs/INSTALLER_UNINSTALLER_CHECKLIST.md`
- `docs/RELEASE_ARTIFACTS_MANIFEST.md`

## Privacy and Security Status

Status: complete for repo-executable path.

- no typed-text telemetry.
- no network in engine hot path.
- no DOM in engine hot path.
- secure input disables memory/proofread/suggestions.
- companion is not a key hook.
- pilot feedback requires consent/redaction.

## Pilot and Feedback Readiness

Status: partial.

Ready:

- feedback system docs.
- consent policy.
- private pilot checklist.
- Niraj demo script and summary.

Blocked:

- real pilot feedback does not exist.
- native dev builds must be validated before installed-keyboard pilot.
- Traditional physical layout requires human validation.

## Performance Metrics

Final report source: `bench/reports/perf-report.json` and `bench/reports/typing-session-report.json`.

- hostile Romanized mixed sentence p95: 1 ms.
- Preeti side utility 5KB p95: 21 ms.
- warm startup p95: 0 ms.
- partial warm p95: 0 ms.
- Romanized live update p95: 1 ms.
- Traditional Unicode suggestion p95: 2 ms.
- proofread p95: 0 ms.
- dictionary lookup p95: 8 ms.
- memory ranking p95: 0 ms.
- commit p95: 1 ms.
- typing-session update p95: 1 ms.
- native IPC JSON simulation p95: 0 ms.

## Verification Command Table

Final log directory from the scripted Prompt 3 evidence sweep: `/tmp/lekh_prod_p3_final_1779907449`.

Latest post-cleanup rerun on 2026-06-09: `npm run verify` passed after corpus trace cleanup, runtime-pack regeneration, readiness doc refresh, and generated-release-output test exclusion. The rerun included 34 test files / 204 tests, corpus package check, Traditional audit, benchmark disjointness, typing-session, Romanized smoke, proofread, competitor, performance smoke, scorecard, protected-span benchmark, and Romanized self-consistency smoke.

| Command | Status | Duration | Log |
| --- | --- | ---: | --- |
| `npm run typecheck` | pass | 0.31s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_typecheck.log` |
| `npm run test` | pass | 40.56s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_test.log` |
| `npm run build` | pass | 3.96s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_build.log` |
| `npm run check:privacy` | pass | 0.46s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_check_privacy.log` |
| `npm run check:engine-local` | pass | 0.63s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_check_engine-local.log` |
| `npm run check:engine-no-dom` | pass | 0.41s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_check_engine-no-dom.log` |
| `npm run check:user-data` | pass | 0.47s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_check_user-data.log` |
| `npm run check:benchmark-disjointness` | pass | 1.39s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_check_benchmark-disjointness.log` |
| `npm run benchmark:typing-session` | pass | 3.66s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark_typing-session.log` |
| `npm run benchmark:romanized` | pass | 18.84s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark_romanized.log` |
| `npm run benchmark:romanized:self:smoke` | pass | 3.26s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark_romanized_self_smoke.log` |
| `npm run benchmark:proofread` | pass | 3.84s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark_proofread.log` |
| `npm run benchmark` | pass | 24.51s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark.log` |
| `npm run bench:perf:smoke` | pass | 7.25s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_bench_perf_smoke.log` |
| `npm run scorecard:engine` | pass | 0.59s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_scorecard_engine.log` |
| `npm run verify` | pass | 86.02s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_verify.log` |
| `npm audit --audit-level=moderate` | pass | 1.53s | `/tmp/lekh_prod_p3_final_1779907449/npm_audit_--audit-level=moderate.log` |
| `npm run test:keyboard` | pass | 7.40s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_test_keyboard.log` |
| `npm run test:dictionary` | pass | 8.19s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_test_dictionary.log` |
| `npm run test:companion` | pass | 8.53s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_test_companion.log` |
| `npm run test:native-scaffold` | pass | 6.77s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_test_native-scaffold.log` |
| `npm run benchmark:dictionary` | pass | 3.63s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark_dictionary.log` |
| `npm run benchmark:memory` | pass | 3.67s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_benchmark_memory.log` |
| `npm run build:companion` | pass | 4.75s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_build_companion.log` |
| `npm run build:daemon` | pass | 1.10s | `/tmp/lekh_prod_p3_final_1779907449/npm_run_build_daemon.log` |

## Scorecard Summary

Source: `bench/reports/engine-scorecard.json`

- `hardFailureCount`: 0.
- final production verification: complete.
- tests: complete.
- benchmarks: complete.
- Romanized: complete.
- Traditional physical: blocked-human.
- Windows native: blocked-native-environment.
- macOS native: blocked-native-environment.
- installer/signing: blocked-external.
- release readiness: blocked-external.

## External Blockers

- Windows code-signing certificate unavailable.
- Windows TSF native test environment unavailable in this repo execution.
- Apple Developer ID/notarization unavailable.
- Installed macOS IMK/XPC host-app validation unavailable in this repo execution.
- Human LTK Traditional layout validation unavailable.
- Licensed dictionary meaning source unavailable.
- Human pilot feedback unavailable.

## Exact Remaining Actions

1. Run Windows TSF proof spike on a Windows machine.
2. Implement/register TSF profile and run Windows host-app matrix.
3. Run macOS IMK/XPC proof spike as an installed input method.
4. Acquire Windows code-signing certificate and Apple Developer ID.
5. Build signed installers and validate install/update/uninstall.
6. Complete Traditional physical layout capture and typist validation.
7. Run private pilot with consented/redacted feedback.

## Final Launch Recommendation

`NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`

Repo-executable keyboard foundation complete. Native release still requires platform testing, signing/notarization, and pilot feedback.
