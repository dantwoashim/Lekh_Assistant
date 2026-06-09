# Prompt 3 Keyboard Completion Report

Date: 2026-05-27

## 1. Executive Summary

Prompt 3 completed the repo-executable native/release foundation for Lekh Keyboard without claiming a production native IME.

Completed:

- native scaffold directory
- IPC schema and typed messages
- daemon lifecycle scaffold
- Windows TSF feasibility skeleton
- macOS IMK feasibility skeleton
- companion app architecture scaffold
- native storage contracts and in-memory adapters
- performance hardening measurements
- packaging/signing docs
- pilot and consent docs
- final scorecard native/keyboard sections
- readiness gate and gap closure

Prompt 1 and Prompt 2 remain intact: `KeyboardEngine`, Romanized live typing, helper suggestions, labels, Traditional Unicode suggestions, proofread, dictionary, memory, next-word baseline, Keyboard Lab, and typing-session benchmarks still pass.

Repo-executable plan status: complete.

External blockers remain: Windows signing and native testing, Apple Developer ID/notarization and native testing, human pilot feedback, Traditional layout manual audit, and safe licensed dictionary meanings.

## 2. Native Scaffold

Folders added:

- `native/shared/ipc`
- `native/shared/storage`
- `native/shared/diagnostics`
- `native/daemon`
- `native/windows-tsf`
- `native/macos-imk`
- `native/companion`

Windows TSF status: scaffolded with placeholder C++ and actionable docs. Not production.

macOS IMK status: scaffolded with placeholder Swift and XPC-specific docs. Not production.

Daemon status: lifecycle and protocol documented. Runtime implementation pending native work.

IPC status: versioned schema and TypeScript message types compile; maps directly to `KeyboardEngine`.

## 3. Companion Scaffold

The companion is documented as the settings, privacy, memory, dictionary, diagnostics, update, and document-tools surface. It is not the IME and not a global keyboard hook.

Pages defined:

- Home/status
- Typing settings
- Romanized settings
- Traditional layout settings
- Dictionary
- Personal memory
- Privacy
- Document tools/Preeti side utility
- Diagnostics
- About/update

## 4. Storage

Current storage:

- in-memory settings store
- in-memory personal dictionary store
- in-memory correction memory adapter

Native future:

- SQLite behind daemon-owned adapters
- Windows path `%APPDATA%/Lekh Keyboard/`
- macOS path `~/Library/Application Support/Lekh Keyboard/`

Privacy:

- secure/password/code contexts do not record correction memory
- no server sync in MVP
- no hidden telemetry

## 5. Performance

Fresh `npm run bench:perf` p95 results:

| Metric | p95 ms |
| --- | ---: |
| warm startup | 0 |
| partial warm timeout | 0 |
| Romanized update | 2 |
| candidate count cap | 1 |
| Traditional Unicode suggestion | 1 |
| proofread hint | 0 |
| dictionary lookup | 4 |
| memory ranking | 1 |
| candidate commit | 1 |
| IPC JSON envelope simulation | 0 |
| hostile Romanized mixed sentence | 6 |
| 5KB mixed Preeti paragraph | 75 |

Bundle bottleneck remains the lazy shared engine/data chunk and Hunspell chunk. This is acceptable for controlled demo review but should be split/compacted before broad public launch.

## 6. Packaging And Release

Windows blockers:

- code-signing certificate
- real TSF implementation and test matrix
- installer validation

macOS blockers:

- Developer ID
- notarization
- real IMK/XPC implementation and test matrix

Release channels documented:

- internal dev build
- private pilot
- LTK/Niraj review build
- public beta
- stable release

## 7. Pilot And Feedback

Pilot policy is opt-in only. No hidden typed-text collection is allowed. Users submit redacted examples manually with consent metadata.

Pilot targets:

- Niraj/LTK reviewers
- traditional typists
- students
- teachers
- office users
- developers
- document-heavy users

## 8. Scorecard

The scorecard now includes:

- keyboard typing-session metrics
- performance p95s
- native scaffold status
- IPC status
- daemon lifecycle status
- Windows/macOS signing blockers
- public claim status

Public claim status remains conservative. Production Windows/macOS keyboard and public release claims are blocked.

## 9. Verification Status

Final verification logs: `/tmp/lekh_prompt3_final_1779880000`.

| Command | Status |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run test` | pass: 27 files, 163 tests |
| `npm run build` | pass |
| `npm run check:privacy` | pass |
| `npm run check:engine-local` | pass |
| `npm run check:engine-no-dom` | pass |
| `npm run check:user-data` | pass |
| `npm run check:benchmark-disjointness` | pass |
| `npm run audit:preeti-source` | pass |
| `npm run benchmark:protected` | pass |
| `npm run benchmark:preeti` | pass |
| `npm run benchmark:preeti:fuzz` | pass |
| `npm run benchmark:preeti:roundtrip` | pass |
| `npm run benchmark:romanized` | pass |
| `npm run benchmark:romanized:self` | pass |
| `npm run benchmark:proofread` | pass |
| `npm run benchmark:competitor` | pass |
| `npm run benchmark:typing-session` | pass |
| `npm run benchmark` | pass |
| `npm run bench:perf` | pass |
| `npm run scorecard:engine` | pass |
| `npm run verify` | pass |
| `npm audit --audit-level=moderate` | pass: 0 vulnerabilities |

## 10. Final Gap Closure

See `docs/FINAL_KEYBOARD_GAP_CLOSURE.md`.

Complete:

- repo-executable keyboard foundation
- native/release scaffolds
- final readiness docs
- scorecard native visibility

Partial or blocked:

- Traditional physical layout: blocked-human
- Windows native implementation: blocked-native-environment and blocked-external
- macOS native implementation: blocked-native-environment and blocked-external
- public release: blocked-human/native/external

## 11. Final Recommendation

Ready for native implementation: yes.

Ready for Niraj/engineering demo: yes, as a browser Keyboard Lab plus native architecture scaffold.

Ready for public release: no.

Next required work:

1. Capture Traditional layout source-of-truth.
2. Build and test Windows TSF feasibility spike on Windows.
3. Build and test macOS IMK/XPC feasibility spike on macOS.
4. Select native storage runtime.
5. Obtain signing/notarization credentials.
6. Run private pilot with consented feedback.
