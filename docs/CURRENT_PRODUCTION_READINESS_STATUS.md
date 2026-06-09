# Current Production Readiness Status

Generated: 2026-06-09

## Current Decision

Final launch recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

The JavaScript/TypeScript keyboard engine, default verification loop, hard-timeout test gate, corpus package gate, active blind leakage gate, bundle budget gate, third-party notice gate, Keyboard Lab validation path, companion shell, unsigned macOS companion dev package, macOS IMK Swift proof target, dev daemon/IPC contract, and privacy checks are currently passing. The native-facing engine API now returns explicit host actions (`passThrough`, `compose`, `commit`, `cancel`, `errorFallback`), user-data safety fails closed without Git metadata, Windows TSF IPC source uses bounded overlapped named-pipe IO, and the daemon line protocol rejects oversized IPC payloads. The project is not public-launch-ready because installed macOS IMK/XPC validation still requires host-app tests, Windows TSF has not been built/tested on Windows, signed installers are unavailable, Traditional physical layout needs human LTK validation, and real pilot feedback is not complete.

## User-Reported Readiness List

| Area | Current status | Evidence | Remaining blocker |
| --- | --- | --- | --- |
| Production verification | ready for default repo gate | `npm run verify` passed on 2026-06-09 with bundle budget and notice gates | rerun before release tag |
| Full test reliability | ready for default suites | 34 files / 208 tests passed in `npm run verify`; `test:native-scaffold` passed with 7 files / 21 tests | keep timing gates in CI |
| Full corpus | partial | D1-D8 row counts present; package check passed | only 124 human/project-reviewed gold rows |
| Real blind benchmark | partial | 100k blind rows frozen; active disjointness contamination is `0`; 1,896 public-proof eligible benchmark fixtures | not a 100k human-reviewed real-world blind set |
| Mixed Nepali-English flagship behavior | ready for engine/lab validation | typing-session protected/mixed suites pass | private pilot tuning still needed |
| Traditional physical keyboard | blocked-human | normal audit gate passes pending scaffold; `audit:traditional-layout:final` fails until verified layout JSON exists | LTK capture and typist validation required |
| Windows native keyboard | blocked-native-environment | TSF source exists, safe pass-through guard is tested by source scan, and IPC client uses bounded overlapped IO | real Windows build, TSF host tests, signing cert |
| macOS native keyboard | blocked-native-environment | `npm run build:macos` passes a Swift IMK proof target | installable IMK bundle, XPC service, host-app tests, Developer ID/notarization |
| Production companion app | partial | `npm run build:companion` passed; `npm run package:macos:unsigned` produced `.app` | signed/notarized package and daemon/service integration |
| Installers/signing | blocked-external plus implementation work | Windows package command now blocks honestly on macOS; mac unsigned companion package passes | Windows release machine, Authenticode cert, Developer ID, notarization |
| Public launch | not ready | scorecard says `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS` | platform tests, signing, Traditional validation, pilot feedback |

## Issue Closure Snapshot

| ID | Status | Evidence |
| --- | --- | --- |
| P0-01 | fixed | Typecheck passes and package/runtime identity is now `lekh-keyboard`. |
| P0-02 | fixed | `npm run test` exits cleanly. |
| P0-03 | fixed | `npm run verify` passes after removing duplicate self-smoke work. |
| P0-04 | fixed for gate truth | `npm run corpus:keyboard:package-check` is wired into `verify` and exposes human-reviewed row count. |
| P0-05 | fixed | scorecard fails on stale required reports and p95 target misses; launch recommendation now distinguishes native implementation failure. |
| P1-01 | fixed | `benchmark:romanized:self:smoke` now runs 140 cases in under 1s in the latest run. |
| P1-02 | fixed | mixed full-span fixtures pass in typing-session. |
| P1-03 | fixed | `swasthay` correction fixture passes. |
| P1-04 | fixed | `nagrikta praman patr` correction fixture passes. |
| P1-05 | fixed | unknown English-like token preserve gate covered. |
| P1-06 | fixed | protected spans no longer preserve the whole mixed sentence. |
| P1-07 | fixed for engine policy | loanword preference/context candidates present; user preference remains settings/pilot work. |
| P1-08 | blocked-human | Traditional physical layout cannot be completed without source capture. |
| P1-09 | fixed | active-prefix proofread suppression covered. |
| P1-10 | partial/safe | Windows TSF source now defaults to pass-through unless experimental key-eating flag is set; macOS IMK proof target builds; real native install/host-app validation still needed. |
| P1-11 | fixed | scorecard marks companion as partial, not complete native keyboard. |
| P2-01 | fixed | perf gate fails on target misses; latest p95 targets pass. |
| P2-02 | partially fixed/gated | app shell and feature chunks are split; `check:bundle-budget` passes; remaining large chunks are approved lazy local data/Hunspell packs. |
| P2-03 | fixed for current docs | current readiness docs now reflect command evidence. |
| P2-04 | fixed | corpus package reports human-reviewed gold rows separately. |
| P2-05 | fixed | `ram` exact-name prior test passes. |
| P2-06 | partial | hostile cases exist; real human-reviewed blind benchmark remains data work. |
| P2-07 | fixed | `verify` runs typecheck before build. |
| P3-01 | partial | current docs updated; historical prompt reports remain archival clutter. |
| P3-02 | partial | native docs are tied to explicit build/package blockers. |
| P3-03 | pending | runtime JSON packs work; compact binary/trie packs remain optimization work. |
| P0 native action gap | fixed | `CandidateUpdate.action` and `CommitResult.action` now expose host decisions; keyboard tests cover pass-through, commit, cancel, and error fallback. |
| P0 user-data fail-open | fixed | `check:user-data` passes in Git and fails closed outside Git metadata. |
| P0 Traditional final gate | fixed | `audit:traditional-layout:final` exits 1 with explicit missing verified layout files. |
| P1 runtime scan risk | improved | runtime suggestion pack now uses a lazy prefix index instead of whole-pack scans per keystroke. |
| P1 IPC hardening | improved | daemon line protocol has 64KB payload cap, named-pipe socket timeout, and oversized payload tests. |

## Latest Key Metrics

| Metric | Latest value |
| --- | ---: |
| typing-session fixtures | 66 |
| typing-session failed sessions | 0 |
| duplicate candidate count | 0 |
| shortcut sequence validity | 1.0 |
| Romanized live update p95 | 1 ms |
| dictionary lookup p95 | 8 ms |
| memory ranking p95 | 0 ms |
| 5KB Preeti side utility p95 | 19 ms |
| public-proof eligible fixtures | 1,896 |
| human/project-reviewed gold rows | 124 |
| frozen blind rows | 100,000 |

## Native Evidence

| Command | Result |
| --- | --- |
| `npm run test:native-scaffold` | passed, 7 files / 21 tests |
| `npm run build:daemon` | passed |
| `npm run build:windows` | `blocked-native-environment` on darwin-arm64 |
| `npm run package:windows:unsigned` | `blocked-native-environment` on darwin-arm64; manual Windows commands emitted |
| `npm run build:macos` | passed; Swift IMK proof target builds |
| `npm run package:macos:unsigned` | passed; produced `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/mac-arm64/Lekh Keyboard Companion.app` |
| `npm run audit:traditional-layout:final` | expected fail; verified layout JSON files are missing, so final launch gate remains blocked-human |

## Public Claim Boundary

Allowed: local-first engine/lab validation, verified repo checks, Romanized engine behavior, mixed/protected-token behavior, proofread/dictionary/memory prototypes, companion dev shell, unsigned macOS companion dev package, buildable macOS IMK proof target, native source/proof scaffolds.

Not allowed yet: public launch, production Windows IME, production macOS IMK input method, signed/notarized installers, 99% universal accuracy, complete Traditional physical keyboard, complete LTK replacement.
