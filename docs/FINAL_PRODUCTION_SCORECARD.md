# Final Production Scorecard

Generated: 2026-06-08

Source: `bench/reports/engine-scorecard.json` from `npm run scorecard:engine`.

## Summary

| Area | Status | Evidence |
| --- | --- | --- |
| verification | complete | required scorecard reports fresh; `hardFailureCount: 0` |
| tests | complete | unit, keyboard, companion, native scaffold tests pass in current run history |
| benchmarks | complete | typing-session fixture count 66; failed sessions 0 |
| Romanized | complete | live, helper, labels, protected, phrase suites pass |
| Traditional physical | blocked-human | source-of-truth LTK layout validation unavailable |
| Traditional suggestions | complete | Unicode suggestion/proofread suite passes |
| proofread | complete | proof hint hit rate 1 |
| dictionary | complete | dictionary hit rate 1; no fake meanings |
| memory | complete | memory boost success rate 1; secure context suppression covered |
| candidate quality | complete | duplicate candidate count 0; shortcut validity 1 |
| Keyboard Lab | complete | app smoke covers candidates, labels, dictionary, proofread, Traditional warning |
| companion app | partial desktop companion | production pages visible; unsigned macOS dev `.app` builds; not an IME |
| daemon/IPC | complete for dev dispatcher | `check:ipc-schema`, `test:native-scaffold`, `build:daemon` pass |
| Windows native | blocked-native-environment | TSF requires Windows registration/host-app validation |
| macOS native | blocked-native-environment | installed IMK/XPC validation required |
| storage | complete for dev/native JSON path | JSON stores tested; SQLite optional later hardening |
| installer/signing | blocked-external | Windows cert and Apple Developer ID unavailable |
| privacy/security | complete for repo-executable path | no telemetry/network hot path checks pass |
| pilot readiness | partial | consent/pilot docs ready; no human feedback exists |
| release readiness | blocked-external | native validation/signing/pilot blockers remain |
| public claims | conservative | production native release claims forbidden |

Launch recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

## Important Metrics

- typing-session fixtures: 66.
- typing-session failures: 0.
- typing-session update p95: 1 ms.
- typing-session commit p95: 0 ms.
- duplicate candidate count: 0.
- shortcut sequence validity: 1.
- proofread hit rate: 1.
- dictionary hit rate: 1.
- memory boost success rate: 1.
- next-word success rate: 1.
- Romanized label hit rate: 1.
- KSR mean baseline: 0.0162889756411158.

## External Blockers

- Windows code-signing certificate.
- Windows TSF host-app validation environment.
- Apple Developer ID and notarization.
- macOS installed IMK/XPC validation.
- Human LTK Traditional layout validation.
- Licensed dictionary meaning source.
