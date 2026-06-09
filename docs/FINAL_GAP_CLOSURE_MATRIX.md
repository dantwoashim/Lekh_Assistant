# Final Gap Closure Matrix

Generated: 2026-06-08

| Item | Status | Evidence | Tests | Blocker type | Next action | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| verification stability | complete | `npm run verify` baseline pass | verify | none | rerun final loop | engineering |
| scorecard truth | complete | fresh report gate | scorecard | none | keep reports fresh | engineering |
| KeyboardEngine | complete | API/tests | test:keyboard | none | native integration | engineering |
| Romanized | complete | typing suites | benchmark:typing-session | none | pilot feedback | product/engineering |
| Romanized helper | complete | helper suite | benchmark:typing-session | none | tune ranking | engineering |
| labels | complete | label hit rate 1 | benchmark:typing-session | none | user setting polish | engineering |
| candidate dedupe | complete | duplicate count 0 | benchmark:typing-session | none | monitor | engineering |
| shortcuts | complete | shortcut validity 1 | benchmark:typing-session | none | monitor | engineering |
| ranking | complete | phrase suites pass | benchmark:typing-session | none | pilot tuning | engineering |
| next-word | complete | next-word success 1 | benchmark:typing-session | none | expand after pilot | engineering |
| Traditional physical | blocked-human | capture gate | audit:traditional-layout | human | run LTK capture/typist validation | product/engineering |
| Traditional suggestions | complete | Unicode suite | benchmark:typing-session | none | pilot tune | engineering |
| proofread | complete | proof hit rate 1 | benchmark:proofread | none | expand rules safely | engineering |
| dictionary | complete | dictionary suite | benchmark:dictionary | none for lookup | add meanings only with licensed source | product |
| memory | complete | memory suite | benchmark:memory | none | native storage pilot | engineering |
| secure input | complete | tests/fixtures | test:keyboard | none | native secure field validation | engineering |
| protected tokens | complete | protected benchmark | benchmark:protected | none | monitor | engineering |
| Keyboard Lab | complete | smoke test | test:companion/app smoke | none | demo | product |
| companion | partial desktop companion | unsigned macOS dev `.app` plus CompanionShell | test:companion/build:companion/package:macos:unsigned | signing/native install validation | signed packaging and daemon/service integration | engineering |
| daemon | complete for dev dispatcher | keyboardDaemon | test:native-scaffold | native packaging | wrap in OS service/XPC | engineering |
| IPC | complete for schema/dispatcher | schema validator | check:ipc-schema | native transport | named pipe/XPC transport | engineering |
| Windows TSF | blocked-native-environment | source tests plus `build:windows` blocker report | build:windows/test:native-scaffold | native env | build/register/test on Windows | engineering |
| macOS IMK | blocked-native-environment | Swift IMK proof target builds | build:macos/test:native-scaffold | native env/signing | package as input method, install/test/sign/notarize | engineering/release |
| storage | complete for JSON dev path | jsonFileStores | test:native-scaffold | none | SQLite hardening optional | engineering |
| installer | blocked-native-environment | release docs plus package blocker reports | package:windows/package:macos | native env | create signed installers | release |
| signing | blocked-external | checklist plus signed package blocker reports | package:windows/package:macos | external | acquire certs | product/release |
| notarization | blocked-external | checklist plus macOS signed package blocker report | package:macos | external | acquire Apple Developer ID | product/release |
| performance | complete for JS hot path | perf report | bench:perf:smoke | native env for TSF/IMK | measure native latency | engineering |
| privacy | complete for repo path | privacy checks/docs | check:privacy | native review | final privacy review | product/engineering |
| pilot | partial | pilot docs | n/a | human | run private pilot | product |
| release docs | complete | release checklists | n/a | none | maintain with artifacts | release |
