# Engine Quality Scorecard

Updated: 2026-06-13T04:38:57.685Z

This scorecard reads existing fresh report files from `bench/reports`. It does not recompute the heavy benchmark universe. Missing, stale, zero-fixture, or schema-weak reports are visible below.

## Report Freshness

| Report | Status | Fixtures | Mode | Command | Note |
| --- | --- | ---: | --- | --- | --- |
| Romanized benchmark | fresh | 776 | smoke | npm run benchmark:romanized:smoke |  |
| Romanized self-consistency | fresh | 140 | smoke | npm run benchmark:romanized:self:smoke |  |
| Typing-session benchmark | fresh | 66 | full | npm run benchmark:typing-session |  |
| Typing-session dictionary benchmark | fresh | 5 | full | npm run benchmark:typing-session -- dictionary-lookup |  |
| Typing-session memory benchmark | fresh | 4 | full | npm run benchmark:typing-session -- memory-ranking,memory-controls |  |
| Proofread benchmark | fresh | 9 | full | npm run benchmark:proofread |  |
| Performance smoke benchmark | fresh | 12 | smoke | npm run bench:perf:smoke |  |
| Benchmark disjointness | fresh | 17001 | full | npm run check:benchmark-disjointness |  |
| Keyboard corpus package | fresh | 11 | n/a | npm run corpus:keyboard:package-check |  |
| Preeti benchmark | fresh | 10225 | full | npm run benchmark:preeti |  |
| Mixed span mutations | fresh | 25 | full | npm run benchmark:mixed-span-mutations |  |
| Romanized alias collisions | fresh | 76193 | full | npm run check:alias-collisions |  |

## Keyboard Foundation

| Area | Status |
| --- | --- |
| KeyboardEngine API | implemented |
| processKeyStroke | required and tested |
| updateComposition | browser/lab path |
| candidate dedupe | normalized text dedupe before shortcuts |
| shortcuts | sequential after final sort |
| secure input | memory/proofread/suggestions disabled or reduced |

## Romanized

| Metric | Value |
| --- | ---: |
| fixtures | 776 |
| mode | smoke |
| top-1 | 1.0000 |
| top-3 | 1.0000 |
| top-5 | 1.0000 |
| MRR | 1.0000 |
| self-consistency fixtures | 140 |
| self-consistency failures | 0 |

## Corpus Package

| Metric | Value |
| --- | --- |
| package status | passed |
| source registry rows | 11 |
| human-reviewed gold rows | 124 |
| gold promotions | 149 |
| reviewed scale status | partial |
| frozen blind rows | 100000 |
| real blind benchmark status | partial |
| leakage audit | passed |
| blind leakage gate | passed |
| public-proof eligible fixtures | 1896 |
| public-proof eligible suites | romanized-manual, romanized-hostile, romanized-hard-hostile-heldout, romanized-mixed-office-root-cause, romanized-admin-mixed, romanized-competitor, preeti-held-out, preeti-manual-hard, preeti-mixed-unicode-legacy-repair, preeti-competitor |
| quarantined benchmark suites | romanized-held-out |
| benchmark evidence risk | perfect benchmark scores require real frozen human-reviewed blind validation before public accuracy claims |

## Typing Sessions

| Metric | Value |
| --- | ---: |
| fixtures | 66 |
| failed sessions | 0 |
| proof hint hit rate | 1.0000 |
| dictionary hit rate | 1.0000 |
| memory boost success | 1.0000 |
| next-word success | 1.0000 |
| Romanized label hit rate | 1.0000 |
| duplicate candidate count | 0 |
| shortcut sequence validity | 1.0000 |

## Prompt 2 Keyboard Intelligence

| Area | Status |
| --- | --- |
| Romanized live typing | complete |
| Romanized government phrases | complete |
| Romanized helper suggestions | complete |
| Romanized labels | complete |
| candidate dedupe and shortcuts | complete |
| ranking and phrase completion | complete |
| next-word prediction | complete |
| KSR baseline | 0.025062567044890426 |
| Traditional physical layout | blocked-human |
| Traditional Unicode suggestions | complete |
| Traditional proofread | complete |
| proofread while typing | complete |
| dictionary lookup | complete |
| personal memory | complete |
| memory controls | complete |
| Keyboard Lab | complete |
| companion shell | complete |
| typing latency p95 ms | 80 |
| native release readiness | pending |

## Performance

| Case | p95 ms | Gate ms | Status |
| --- | ---: | ---: | --- |
| 50-token hostile Romanized mixed sentence | 1 | 30 | pass |
| 5KB mixed Preeti paragraph | 30 | 100 | pass |
| KeyboardEngine warm startup | 0 | 500 | pass |
| KeyboardEngine partial warm timeout | 0 | 50 | pass |
| Keyboard Romanized live update | 0 | 20 | pass |
| Keyboard candidate count cap | 0 | 20 | pass |
| Keyboard Traditional Unicode suggestion | 0 | 20 | pass |
| Keyboard proofread hint update | 0 | 40 | pass |
| Keyboard dictionary lookup | 0 | 30 | pass |
| Keyboard memory ranking update | 0 | 10 | pass |
| Keyboard candidate commit | 3 | 10 | pass |
| Native IPC JSON envelope simulation | 0 | 10 | pass |

Performance target misses: 0

## Native And Release

| Area | Status |
| --- | --- |
| Windows TSF source | present |
| macOS IMK source | dev input method install proof passed |
| IPC schema | present |
| daemon lifecycle | documented |
| companion desktop shell | present |
| release status | blocked until Windows TSF host tests, macOS host-app matrix tests, signing/notarization, and pilot feedback |

## Final Production Scorecard

| Area | Status |
| --- | --- |
| verification | complete |
| tests | complete |
| benchmarks | complete |
| Romanized | complete |
| Traditional physical | blocked-human |
| Traditional suggestions | complete |
| proofread | complete |
| dictionary | complete |
| memory | complete |
| candidate quality | complete |
| Keyboard Lab | complete |
| companion app | partial |
| daemon/IPC | complete |
| Windows native | blocked-native-environment |
| macOS native | partial native-dev proof |
| storage | complete |
| installer/signing | blocked-external |
| privacy/security | complete |
| pilot readiness | partial |
| release readiness | blocked-external |
| public claims | conservative |

Launch recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`

## Public Claim Status

Allowed if phrased honestly:

- local-first keyboard engine prototype
- Romanized live typing prototype
- Traditional layout under source-of-truth audit
- proofread/dictionary/memory prototype
- native architecture/scaffold
- unsigned macOS IMK development input method installs/registers/enables/launch-smokes without auto-selecting globally

Forbidden until evidence exists:

- beats Gboard
- beats Hamro
- 100% accurate
- government-ready
- production Windows IME complete
- production macOS IME complete
- fully signed/notarized release
- complete LTK replacement
