# Lekh Keyboard Full Project Audit and Production Readiness Roadmap

Audit date: 2026-06-08  
Workspace: `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard`  
Evidence folder: `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/reports/full-audit-20260608-172905`

## 1. Executive Verdict

Current post-remediation verdict on 2026-06-09: repo-executable production gates are stable, but Lekh Keyboard is still not production-ready for public Windows/macOS launch because remaining blockers require a Windows native test machine, platform signing/notarization credentials, installed macOS input-method validation, human Traditional layout validation, and real pilot feedback.

The original 2026-06-08 audit found active repo failures: `npm run verify` timed out, dictionary p95 missed, companion smoke failed, macOS build scripts were missing, unsigned Windows packaging failed locally, and the scorecard underplayed those failures. Those repo-executable failures have been remediated.

Current evidence:

- `npm run verify` passes with generated `release/` artifacts present.
- `npm run test` passes: 34 files / 204 tests.
- `npm run test:companion` passes: 1 file / 9 tests.
- `npm run bench:perf:smoke` passes; latest dictionary lookup p95 is 8 ms against a 30 ms gate.
- `npm run scorecard:engine` passes with zero hard failures and no stale/schema-warning reports.
- `npm audit --audit-level=moderate` reports 0 vulnerabilities.
- `npm run build:macos` passes a Swift IMK proof target.
- `npm run package:macos:unsigned` produces `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/mac-arm64/Lekh Keyboard Companion.app`.
- `npm run package:windows:unsigned` now blocks honestly on macOS with exact Windows release-machine commands instead of attempting to fake release evidence.

Final recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

This means the repo-executable audit issues are closed or gated, but public launch remains blocked by native platform/signing/human-validation requirements. Do not claim production Windows IME, production macOS IMK, complete Traditional physical keyboard, 99% universal accuracy, or signed public release until those external evidence gates pass.

### 1.1 Audit Issue Closure Summary

| Bucket | Current status | Evidence |
| --- | --- | --- |
| Verification/test/perf/scorecard P0s | complete | `npm run verify`, `npm run test`, `npm run test:companion`, `npm run bench:perf:smoke`, and `npm run scorecard:engine` pass. |
| macOS build/package path | partial, repo-executable complete | `npm run build:macos` passes; `npm run package:macos:unsigned` produces a dev `.app`; signed/notarized IMK distribution remains external/native work. |
| Windows TSF/package path | blocked-native-environment | TSF source and safe pass-through guard exist; build/package commands emit exact Windows-machine requirements on this macOS host. |
| Traditional physical layout | blocked-human | `npm run audit:traditional-layout` passes only as pending scaffold and prevents fake layout completion. |
| Corpus/99% quality claims | partial, claim-gated | D1-D8 package gate passes and blind rows exist; only 124 human/project-reviewed gold rows, so 99% public accuracy claims remain forbidden. |
| Release/signing | blocked-external | Signed Windows and macOS release require Authenticode certificate, Apple Developer ID, and notarization credentials. |
| Generated artifacts hygiene | complete for source control | `release/`, `dist/`, native `.build`, daemon bundle, `.tmp`, and generated reports are ignored or documented as generated output. |
| Scorecard truth | complete | All scorecard report inputs are fresh; launch recommendation remains blocked by explicit external/native requirements. |

## 2. Audit Methodology

I did not trust completion reports or scorecards as evidence. I inspected project files, package scripts, source directories, native scaffolds, generated data, release artifacts, risk keywords, and then ran the command matrix from a fresh `npm ci`.

Evidence collected:

- Repository inventory: `inventory-root.txt`, `tree-depth3.txt`, `large-files.txt`, `package-summary.json`
- Command matrix: `command-results.json`, with per-command logs under `commands/`
- Risk scans: `risky-claims-placeholders.txt`, `privacy-security-scan.txt`, `code-risk-scan.txt`
- Generated artifact scan: `generated-dirs.txt`
- Failure summary: `failure-summary.json`

The audit included:

- `package.json`, Vite, Vitest, TypeScript config
- `src/engine/**/*`
- `src/features/**/*`
- `src/app/**/*`
- `src/styles/**/*`
- `scripts/**/*`
- `bench/fixtures/**/*`
- `bench/reports/**/*`
- `docs/**/*`
- `native/**/*`
- `electron/**/*`
- `build/**/*`
- `release/**/*`
- corpus directories under `data/keyboard-corpus/**/*`

## 3. Repo Inventory

Major top-level size observations:

| Path | Approx size | Audit note |
| --- | ---: | --- |
| `data` | 2.1 GB | Very large generated/curated corpus and runtime packs. Needs release hygiene and data provenance gating. |
| `release` | 714 MB | Generated Electron packaging artifacts are present. Not launch artifacts. |
| `node_modules` | 249 MB | Expected after `npm ci`, should not be committed. |
| `native` | 105 MB | Includes macOS `.build` artifacts. Generated native build outputs should not live in source. |
| `src` | 11 MB | Main React and engine source. |
| `dist` | 4.3 MB | Generated web build output. |

Large files requiring hygiene decisions:

- `data/keyboard-corpus/curated/v0.1/D1_word_aliases.v0.1.jsonl` around 467 MB
- `data/keyboard-corpus/curated/v0.1/D7_next_word_contexts.v0.1.jsonl` around 402 MB
- `data/generated/frequency/sources/newiki-latest-pages-articles.xml.bz2` around 51 MB
- `data/keyboard-corpus/runtime/v0.1/word-trie.json` around 24 MB
- `release/win-unpacked/Lekh Keyboard Companion.exe` around 221 MB
- `release/mac/Lekh Keyboard Companion.app/.../Electron Framework` around 180 MB
- `native/macos-imk/skeleton/.build/**/*` Swift build products

Generated directories detected:

- `.tmp`
- `dist`
- `native/daemon/dist`
- `native/macos-imk/skeleton/.build`
- `node_modules`
- `release`

These should not be treated as source truth. `native/daemon/dist` may be a deliberate bundled dev daemon, but it still needs an explicit source/build policy.

## 4. Command Results

Full command evidence is in `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/reports/full-audit-20260608-172905/command-results.json`.

| Command | Status | Duration | Key result |
| --- | --- | ---: | --- |
| `npm ci` | pass | 6.895s | Dependencies installed. |
| `npm run typecheck` | pass | 9.973s | TypeScript passed. |
| `npm run test` | pass | 51.070s | 31 files, 197 tests passed. Slow but terminated. |
| `npm run build` | pass | 5.403s | Build passed, chunk warnings remain. |
| `npm run check:privacy` | pass | 0.454s | Static privacy check passed. |
| `npm run check:engine-local` | pass | 0.370s | Engine local check passed. |
| `npm run check:engine-no-dom` | pass | 0.398s | Engine no-DOM check passed. |
| `npm run check:user-data` | pass | 0.357s | User data check passed. |
| `npm run check:benchmark-disjointness` | pass with warning | 1.026s | Passes, but report still flags contaminated `romanized-held-out`. |
| `npm run benchmark:typing-session` | pass | 5.358s | Completed. |
| `npm run benchmark:romanized` | pass | 24.000s | Completed, but quality is over-curated. |
| `npm run benchmark:romanized:self:smoke` | pass but too slow | 92.458s | Smoke benchmark is not smoke-fast. |
| `npm run benchmark:proofread` | pass | 2.329s | Completed. |
| `npm run benchmark` | pass but too slow | 228.001s | Aggregate benchmark is too slow for regular verification. |
| `npm run bench:perf:smoke` | fail | 4.898s | Dictionary lookup p95 target missed: target 30 ms, p95 64 ms. |
| `npm run bench:perf:full` | fail | 6.905s | Dictionary lookup p95 target missed: target 30 ms, p95 36 ms. |
| `npm run scorecard:engine` | fail | 100.380s | Scorecard reports failed verification due perf gate, still underplays launch state. |
| `npm run verify` | timeout | 300.018s | Timed out after typecheck/test/build stage. |
| `npm audit --audit-level=moderate` | pass | 1.306s | 0 vulnerabilities. |
| `npm run lint` | fail | 0.120s | Missing script. |
| `npm run format:check` | fail | 0.120s | Missing script. |
| `npm run test:keyboard` | pass | 5.376s | Keyboard tests pass. |
| `npm run test:dictionary` | pass | 10.475s | Dictionary tests pass. |
| `npm run test:companion` | fail | 21.822s | App smoke test timed out waiting for `Keyboard Lab`. |
| `npm run test:native-scaffold` | pass | 18.113s | Native scaffold tests pass. |
| `npm run benchmark:dictionary` | pass | 4.308s | Completed. |
| `npm run benchmark:memory` | pass | 2.789s | Completed. |
| `npm run build:companion` | pass | 30.588s | Electron companion build completed. |
| `npm run build:daemon` | pass | 12.781s | Daemon bundle completed. |
| `npm run build:windows` | blocked | 0.318s | Requires Windows/MSVC/Windows SDK, current host is `darwin-arm64`. |
| `npm run build:macos` | fail | 0.120s | Missing script. |
| `npm run package:windows` | blocked | 0.295s | Missing Authenticode cert variables. |
| `npm run package:windows:unsigned` | fail | 318.655s | NSIS build did not produce setup exe. Electron-builder helper/sign step failed locally. |
| `npm run package:macos` | fail | 0.120s | Missing script. |
| `npm run check:windows-release` | fail | 0.356s | `win-unpacked` exists, installer exe missing, signed false. |

Audit conclusion: the repo cannot be considered production-verifiable until `verify`, perf gates, companion tests, and release checks are deterministic.

## 5. Architecture

Current architecture is partially aligned with the intended product:

- Shared engine under `src/engine`
- React Keyboard Lab and feature surfaces under `src/features`
- Electron companion shell under `electron`
- TypeScript daemon under `native/daemon`
- Windows TSF source tree under `native/windows-tsf/skeleton`
- macOS IMK placeholder under `native/macos-imk/skeleton`
- IPC contracts under `native/shared/ipc`
- Benchmark and scorecard scripts under `scripts` and `bench`

Production architecture gaps:

- The daemon is started by the Electron companion on Windows, not installed as a resilient per-user service.
- Windows TSF is not proven to commit text through TSF composition APIs.
- macOS IMK/XPC is not implemented.
- Native storage encryption and OS keychain/DPAPI integration are not implemented.
- Installer path is not complete.
- Verification does not cover the native/packaging path.

## 6. Engine

Positive findings:

- Engine-centered path exists.
- `processKeyStroke`, `updateComposition`, `commitCandidate`, `commitRaw`, proof hints, dictionary lookup, and memory behavior are represented and tested.
- Typecheck and core tests pass.
- Static checks show no DOM dependency in engine hot path.
- Protected token tests exist.
- Secure input behavior is represented in tests.

Production concerns:

- `npm run verify` timeout means engine proof is not production-stable in the default path.
- Dictionary lookup is too slow against the current p95 gate.
- Session IDs and IPC IDs rely on timestamp/counter/random helpers. That is acceptable for local correlation but should be hardened for stale response protection across daemon/native boundaries.
- Runtime packs are large JSON. They may be acceptable for development, but production requires measured load/memory behavior and compact pack strategy.
- Browser/local memory adapter uses `localStorage`; native encrypted storage is not complete.

## 7. Romanized

Positive findings:

- Romanized benchmark passes.
- Word/phrase candidates exist.
- Romanized helper/label infrastructure is present.
- Protected token behavior is covered.
- Mixed examples exist in fixtures.

Production concerns:

- The benchmark set is too curated and partly generated from the same source pipeline as runtime data.
- Disjointness report flags contamination in `romanized-held-out`.
- Too-perfect scores should not be treated as real-world readiness.
- Real blind casual/mixed Nepali-English evaluation is not established.
- `README.md` still notes cursor-aware replacement as future work.
- KSR reported in scorecard is weak and not enough to support a premium typing claim.

## 8. Traditional

Current state: Traditional physical keyboard is not production-ready.

What exists:

- Traditional Unicode suggestions/proofread behavior exists.
- Pending layout files and audit docs exist.
- Traditional Lab/UI status is honest in some places.

What is missing:

- Verified LTK-compatible physical layout.
- Human Traditional typist validation.
- Complete key/modifier fixture coverage.
- Production layout preview backed by verified layout data.
- Native Traditional physical typing proof.

Correct status: `blocked-human: LTK layout validation required`.

The repo must not claim Traditional physical keyboard completion until the source-of-truth audit is completed and fixtures pass.

## 9. Proofread, Dictionary, and Memory

Positive findings:

- Proofread tests and benchmark pass.
- Dictionary tests and benchmark pass.
- Memory benchmark passes.
- Personal dictionary and memory concepts exist.
- No fake dictionary meanings were detected as a runtime claim.
- Static privacy checks pass.

Production concerns:

- Dictionary p95 fails the perf gate.
- Licensed dictionary meanings are still unavailable and should remain absent.
- Proofread correctness for real-world casual/mixed text is not proven by a true blind set.
- Browser/local memory is not production native storage.
- Native memory encryption and corruption recovery are not complete.
- Static privacy scans are helpful but brittle; they are not a substitute for runtime telemetry audits.

## 10. Candidate System

Positive findings:

- Candidate dedupe and sequential shortcut behavior are tested.
- Ranking, sources, reasons, labels, helper candidates, and next-word candidates are represented.

Production concerns:

- Real-world ranking is not validated against a large human-reviewed blind set.
- Ambiguous short forms and names still require hostile benchmark coverage.
- Personal memory boost needs native persistence and privacy-safe storage before production.
- Candidate quality claims must be limited to current benchmarks, not broad user populations.

## 11. UI/UX

Current UI surfaces:

- Keyboard Lab
- Romanized editor
- Traditional layout reference
- Companion shell tab
- Preeti side utility

Positive findings:

- App defaults toward Keyboard Lab rather than Preeti.
- Companion copy avoids calling itself the IME.
- Privacy page/shell concepts exist.

Production concerns:

- `npm run test:companion` failed in a fresh standalone run.
- Keyboard Lab is a validation surface, not a native keyboard UI.
- Electron companion build passes, but package/install/sign flow does not.
- UI/UX is not proven against competitor-quality workflows on native Windows/macOS.
- There is no verified native candidate window experience.

## 12. Performance

Measured issues:

- `bench:perf:smoke` fails dictionary lookup p95: target 30 ms, observed p95 64 ms.
- `bench:perf:full` fails dictionary lookup p95: target 30 ms, observed p95 36 ms.
- `benchmark:romanized:self:smoke` takes 92.458s and should not be called smoke.
- `benchmark` takes 228.001s and is too slow for regular developer verification.
- Vite build warns about large chunks:
  - Main app chunk around 2.6 MB
  - Hunspell chunk around 956 KB
  - Keyboard Lab chunk around 627 KB

Performance conclusion: not production-gated. Fix dictionary p95 first, then re-split slow smoke/full commands.

## 13. Tests, Benchmarks, and Scorecards

Tests:

- Full `npm run test` passed, but took 51s.
- `test:companion` failed standalone.
- Native scaffold tests pass but do not prove native production behavior.

Benchmarks:

- Core benchmarks pass, but aggregate and self-consistency smoke are too slow.
- Perf benchmark fails.
- Benchmark disjointness passes with warnings, not clean proof.

Scorecard:

- `scorecard:engine` fails due perf gate.
- The scorecard final launch recommendation does not fully reflect active verification failure; it emphasizes native external blockers while the repo also has engine/verification failures.
- Historical docs and reports conflict with current state and should be archived or clearly marked historical.

## 14. Data and Corpus

Corpus counts are large, but quality is not launch-grade.

Reported generated/curated scale:

- D1 word aliases: 1,000,000 rows
- D2 phrase aliases: 99,998 rows
- D3 casual sentences: 249,685 rows
- D4 mixed sentences: 250,000 rows
- D5 proofread pairs: 100,000 rows
- D6 names/surnames: 50,000 rows
- D7 next-word contexts: 1,000,000 rows
- D8 blind set: 100,000 rows

Critical quality caveat:

- Human-reviewed gold rows are only around 124.
- Gold promotions are around 149.
- Much of the scale is generated, synthetic, or auto-promoted.
- The blind set is structurally frozen but not proven as independent human-reviewed real-world blind data.
- Leakage checks are structural, not linguistic/user-distribution proof.

Data source risk:

- `docs/ROMANIZED_NEPALI_TEXT_DATA_RESEARCH_REPORT.md` mentions Dakshina as an open transliteration source candidate. For this product, Dakshina should not be treated as a Nepali Romanized source unless a concrete Nepali subset and license/use fit are verified.
- Aksharantar and other genuine Nepali transliteration resources need clearer status, license review, and provenance.

Conclusion: the corpus is useful for scaffolding and stress testing, but it does not support 99% universal accuracy claims.

## 15. Native Windows and macOS

### Windows

What exists:

- Windows TSF source tree under `native/windows-tsf/skeleton`
- CMake/build/register scripts
- COM/TSF skeleton code
- Named pipe client source
- Companion-started daemon path
- Windows build script that correctly blocks on non-Windows host

What is not proven:

- Build on real Windows with MSVC and Windows SDK.
- TSF registration in Windows input settings.
- Text composition through TSF edit sessions.
- Candidate UI.
- Unicode commit into Notepad, Word, Chrome, Edge, VS Code.
- Secure input behavior in real host apps.
- Pass-through behavior when daemon is unavailable.
- Installer registration/unregistration.
- Signed release.

Additional risk: current TSF source appears capable of eating key events based on daemon response without a proven composition/commit path. That is a P0 host-app corruption risk until proven otherwise on Windows.

### macOS

What exists:

- macOS IMK skeleton directory.
- Placeholder Swift file.
- Swift build artifacts in `.build`.

What is missing:

- Real `IMKInputController` implementation.
- XPC service implementation.
- Marked text.
- Candidate UI.
- Install/enable/uninstall proof.
- Test results in TextEdit/Safari/Chrome/Pages/VS Code.
- `build:macos` and `package:macos` scripts.
- Developer ID signing and notarization.

Correct status: macOS native keyboard is not implemented.

## 16. Privacy, Security, and Release

Positive findings:

- No hidden telemetry found in static scans.
- Runtime keyboard path does not appear to require network.
- Protected-token and secure-input concepts exist.
- Public privacy docs exist.

Security gaps:

- Windows named pipe server does not prove explicit per-user ACL enforcement.
- Daemon is companion-child managed, not a hardened per-user service.
- Native memory encryption via DPAPI/Keychain is not implemented.
- Diagnostic export redaction needs runtime tests, not only docs.
- `fetch` exists in data collection scripts and service worker, which is acceptable outside hot typing but should be scoped in policy checks.

Release gaps:

- No signed Windows installer.
- Unsigned Windows packaging failed locally.
- No macOS package script.
- No Developer ID/notarization path executed.
- No native installer/uninstaller smoke proof.
- Third-party notices may be stale after Electron/electron-builder additions.

## 17. Complete Issue Register

| ID | Severity | Area | File/Location | Issue | Evidence | Root Cause | Exact Fix | Test Needed | Blocks Launch? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0-01 | P0 | Verification | `package.json`, `scripts/*` | `npm run verify` times out. | Command matrix timeout at 300.018s. | Verify includes slow/non-bounded steps and does not finish reliably. | Split verify into bounded CI smoke, move long suites to full/manual, add per-step timeout/progress. | `npm run verify` under agreed timeout twice from clean `npm ci`. | Yes |
| P0-02 | P0 | Performance | `scripts/bench-perf*`, dictionary path | Dictionary lookup p95 misses perf gate. | Smoke p95 64 ms, full p95 36 ms, target 30 ms. | Dictionary lookup path/load/caching too slow for target. | Profile dictionary lookup, pre-index aliases, cap lookups, memoize hot queries, lazy load safely. | `npm run bench:perf:smoke` and `npm run bench:perf:full` pass. | Yes |
| P0-03 | P0 | Tests | `src/tests/app-smoke.test.tsx` | `test:companion` fails standalone. | Timed out waiting for `Keyboard Lab`. | Lazy app load/test timing or routing smoke issue. | Make smoke deterministic, wait for stable app shell, reduce heavy imports for first render. | `npm run test:companion` passes after `npm ci` repeatedly. | Yes |
| P0-04 | P0 | Scorecard | `scripts/generate-engine-scorecard.ts` | Scorecard underplays active verification failure. | Fails but launch recommendation still focuses native external blockers. | Recommendation aggregation not strict enough. | If any P0 verification/perf/test fails, final recommendation must be `NOT_READY_ENGINE_OR_VERIFICATION_FAILURES`. | Scorecard fixture for failed perf/test state. | Yes |
| P0-05 | P0 | Windows native | `native/windows-tsf/skeleton/**/*` | Windows TSF not built/tested on Windows. | `build:windows` blocked on darwin-arm64. | No Windows CI/device evidence. | Run on Windows runner/device with MSVC/SDK; capture build and registration logs. | Windows build CI plus manual Notepad smoke. | Yes |
| P0-06 | P0 | Windows native | `native/windows-tsf/skeleton/LekhTextService.cpp` | TSF composition/candidate commit not proven. | Source exists but no Windows host-app output evidence. | Skeleton IPC path precedes full TSF edit session/candidate integration. | Implement TSF composition manager, commit path, pass-through fallback, candidate UI. | Notepad/Word/Chrome/Edge/VS Code typing matrix. | Yes |
| P0-07 | P0 | Windows native | `native/windows-tsf/skeleton/LekhTextService.cpp` | Potential key swallowing if daemon responds but no commit occurs. | TSF test not run; source handles key events through daemon path. | No proven safe fallback around composition failures. | Default to pass-through until commit path succeeds; add watchdog/failure fallback. | Daemon-down and daemon-error host-app tests. | Yes |
| P0-08 | P0 | macOS native | `native/macos-imk/skeleton/LekhInputController.placeholder.swift` | macOS IMK is placeholder-only. | Placeholder filename/source. | IMK/XPC implementation not built. | Implement IMK controller, marked text, candidate UI, XPC client, fallback. | TextEdit/Safari/Chrome/Pages/VS Code smoke tests. | Yes |
| P0-09 | P0 | macOS packaging | `package.json` | Missing `build:macos` and `package:macos`. | Commands fail as missing scripts. | No macOS packaging path wired. | Add native macOS build/package scripts and artifacts manifest. | `npm run build:macos`, `npm run package:macos`. | Yes |
| P0-10 | P0 | Installer | `electron-builder.config.cjs`, `release/` | Unsigned Windows NSIS installer fails. | `package:windows:unsigned` fails after 318s; setup exe missing. | Electron-builder helper/sign/NSIS path not stable locally. | Fix NSIS helper execution, disable signing for unsigned dev target, verify artifact. | `npm run package:windows:unsigned` creates setup exe. | Yes |
| P0-11 | P0 | Signing | Environment, release docs | Signed Windows installer unavailable. | `package:windows` blocked by missing `CSC_LINK`/password. | No Authenticode cert in environment. | Obtain cert, store secrets in CI, sign installer and TSF DLL. | Signed artifact verification on Windows. | Yes for public Windows |
| P0-12 | P0 | Traditional | `data/layouts/*.pending.json`, docs | Traditional physical layout not verified. | Docs say LTK audit pending. | Missing human/source-of-truth layout capture. | Complete LTK capture, validate with typists, create full modifier fixtures. | Traditional layout fixture suite. | Yes for Traditional launch claim |
| P0-13 | P0 | Corpus | `data/keyboard-corpus/**/*` | Large corpus is not large human-reviewed gold corpus. | Only around 124 human-reviewed gold rows. | Generated/auto-promoted scale used before review. | Build real source registry, annotation queue, human gold promotion, independent blind set. | Corpus validation with gold/blind counts and reviewer evidence. | Yes for 99% claims |
| P0-14 | P0 | Blind benchmark | `bench/fixtures/**/*`, `data/keyboard-corpus/curated/v0.1/D8*` | Real blind benchmark not proven. | Disjointness warns contaminated `romanized-held-out`; blind rows generated. | Same pipelines feed data and tests. | Freeze independent human-reviewed blind set from allowed sources. | Leakage audit plus manual sampling report. | Yes for quality claims |
| P0-15 | P0 | Security | `native/daemon/src/namedPipeServer.ts` | Named pipe per-user ACL not proven. | Node server uses named pipe path, no explicit ACL evidence. | Default pipe security not documented/tested. | Implement Windows ACL/security descriptor or validated named pipe permissions. | Windows IPC unauthorized-user test. | Yes |
| P0-16 | P0 | Daemon | `electron/main.cjs`, `native/daemon/src/*` | Daemon is companion-child managed, not production service. | Companion starts daemon and kills on quit. | No installed per-user background service/lifecycle. | Implement per-user startup service/launch agent with reconnect and crash recovery. | Kill/restart/reconnect tests. | Yes |
| P1-01 | P1 | Benchmark | `benchmark:romanized:self:smoke` | Smoke benchmark takes 92s. | Command matrix. | Smoke/full split ineffective. | Reduce smoke fixture count and add chunk timeouts. | Smoke under target duration. | Yes for developer workflow |
| P1-02 | P1 | Benchmark | `npm run benchmark` | Aggregate benchmark takes 228s. | Command matrix. | Full benchmark included in common command. | Keep full manual, expose fast CI benchmark. | CI benchmark duration gate. | No, but blocks velocity |
| P1-03 | P1 | Repo scripts | `package.json` | Missing lint and format check scripts. | Commands fail. | No standard lint/format target. | Add scripts or document equivalents; include in CI only when stable. | `npm run lint`, `npm run format:check`. | No |
| P1-04 | P1 | Bundle | `vite.config.ts`, dynamic imports | Main chunk around 2.6 MB. | Vite warnings. | Heavy UI/data imported into main path. | Further split Keyboard Lab, Hunspell, corpus/runtime packs. | Bundle size budget check. | No |
| P1-05 | P1 | Data licensing | `docs/ROMANIZED_NEPALI_TEXT_DATA_RESEARCH_REPORT.md` | Dakshina is mentioned as a possible source without concrete Nepali/license fit. | Risk scan. | Source research doc too broad. | Remove/qualify; prioritize verified Nepali transliteration resources like Aksharantar where license permits. | Data source lint/manual review. | Yes for data release |
| P1-06 | P1 | Benchmark | `bench/reports/benchmark-disjointness-latest.json` | `romanized-held-out` contamination warning. | Disjointness report. | Training/test generation overlap. | Remove contaminated held-out suite or rebuild from independent source. | Disjointness hard-fails contamination. | Yes for claim quality |
| P1-07 | P1 | Docs | `docs/PROMPT_*`, native docs | Historical docs conflict with current state. | Many stale completion docs. | Prompt reports kept as live docs. | Archive under `docs/archive/` and generate current status from commands. | Docs claim scan. | No, but high risk |
| P1-08 | P1 | Privacy | `src/core/transliteration/localCorrectionMemory.ts` | Browser memory uses localStorage. | Privacy scan. | Dev/browser adapter only. | Implement native encrypted storage adapter for desktop. | Export/import/reset/encryption tests. | Yes for native privacy |
| P1-09 | P1 | IPC | `native/shared/ipc/messages.ts` | IPC IDs use `Math.random`/`Date.now`. | Code risk scan. | Convenience ID generation. | Use monotonic session sequence plus UUID/crypto where available. | Stale response/collision tests. | No |
| P1-10 | P1 | Native packaging | `electron-builder.config.cjs` | Windows package is companion app only, not TSF install. | `win-unpacked` exists, TSF not bundled/registered. | Native DLL build blocked and installer not integrated. | Add TSF DLL build artifact, registration custom action, uninstall cleanup. | Fresh install/uninstall VM test. | Yes for Windows |
| P1-11 | P1 | Release size | `release/**/*` | Release artifacts are huge and generated. | `release` 714 MB. | Packaging outputs left in worktree. | Ignore/clean generated artifacts, publish only manifests/artifacts via release pipeline. | Git clean artifact policy check. | No |
| P1-12 | P1 | Native artifacts | `native/macos-imk/skeleton/.build` | Swift build artifacts in source tree. | Generated dirs scan. | Local build output retained. | Add ignore/clean policy; rebuild from source in CI. | `git status --ignored` review. | No |
| P1-13 | P1 | Third-party notices | `public/THIRD_PARTY_NOTICES.txt` | Notices may not include Electron/electron-builder additions. | New deps added. | License inventory not regenerated. | Generate license report and update notices. | License check script. | Yes for release |
| P1-14 | P1 | UI | `src/tests/app-smoke.test.tsx` | First render may be too heavy/flaky. | `test:companion` timeout. | Heavy lazy chunks/test setup timing. | Add stable loading state and test selector; defer heavy modules. | Playwright/Vitest smoke. | No |
| P1-15 | P1 | Native macOS | `native/macos-imk/skeleton/Package.swift` | Package builds placeholder source only. | Placeholder source path. | No real Swift package target. | Replace with actual IMK/XPC project or Xcode project. | Swift build plus manual install test. | Yes for macOS |
| P1-16 | P1 | Scorecard | `bench/reports/**/*` | Stale reports remain part of scorecard context. | Prior scorecard warnings for preeti/mixed span/alias collisions. | Freshness gates incomplete or non-blocking. | Hard-fail required stale reports or remove them from score. | Scorecard freshness unit test. | Yes for release evidence |
| P1-17 | P1 | Corpus | `scripts/build-keyboard-corpus.mjs` | Synthetic loops generate target-sized data. | Code risk scan shows large target loops. | Row count target prioritized over reviewed quality. | Separate synthetic from production packs; enforce human-reviewed thresholds. | Corpus acceptance test for quality ratios. | Yes for accuracy claims |
| P1-18 | P1 | Candidate quality | `bench/reports/alias-collisions-latest.json` | Alias collision review queue remains large. | Prior report shows thousands of collisions needing review. | Ambiguous forms not fully curated. | Review high-frequency collisions, add ranking/context labels. | Hostile ambiguity benchmark. | Yes for 99% claims |
| P2-01 | P2 | Product scope | `src/features/layout-reference/TraditionalLayoutReference.tsx` | UI confirms no key remapping/native hook/installer in browser surface. | Source copy. | Browser lab used for validation only. | Keep honest; complete native path separately. | Copy/claim scan. | No |
| P2-02 | P2 | Product gap | `README.md` | Cursor-aware replacement still future work. | README line around 200. | Engine/UI does not fully support host cursor replacement. | Implement native range replacement and browser lab cursor tests. | Cursor replacement tests. | Yes for native text editing polish |
| P2-03 | P2 | Corpus privacy | `.tmp/keyboard-corpus-cache` | Cached source data exists locally. | Large parquet files in `.tmp`. | Data acquisition cache retained. | Quarantine, redact, ignore, and document retention. | PII/redaction audit. | Yes for data release |
| P2-04 | P2 | Build correctness | `npm run build` | Vite build passes even if typecheck could fail. | Separate typecheck/build scripts. | Vite transpile does not imply TS correctness. | Keep `typecheck` required in verify and release gates. | Release gate script. | No |
| P2-05 | P2 | Native docs | `native/**/*README*` | Native docs are verbose but not task-linked enough. | Risk scan. | Historical scaffold docs not tied to issue tracker. | Convert native gap docs into tracked tasks/checklists. | Docs status review. | No |
| P2-06 | P2 | Release | `build/`, `electron-builder.config.cjs` | Installer icon/assets exist but release manifest incomplete. | Build assets present. | Packaging added before release manifest finalized. | Update artifacts manifest and checksum policy. | Release artifact manifest check. | No |
| P3-01 | P3 | Repo hygiene | `docs/PROMPT_*` | Too many completion reports dilute current truth. | Docs inventory. | Prompt-by-prompt docs accumulated. | Archive historical reports; keep one generated current status. | Docs index check. | No |
| P3-02 | P3 | Runtime packs | `data/keyboard-corpus/runtime/v0.1/*.json` | Runtime packs are large JSON. | Runtime pack sizes. | Pack compiler emits JSON not compact binary/trie. | Build compact pack format later after correctness gates. | Load-time/memory benchmark. | No |

## 18. Fix Roadmap

### Phase 0: Stop the Bleeding

Objective: make project truth deterministic.

Deliverables:

- Fix `npm run verify` timeout.
- Fix `bench:perf:smoke`.
- Fix `test:companion`.
- Update scorecard recommendation logic.
- Make disjointness contamination a hard failure or remove contaminated suite.

Acceptance:

- `npm ci`
- `npm run typecheck`
- `npm run test`
- `npm run test:companion`
- `npm run bench:perf:smoke`
- `npm run scorecard:engine`
- `npm run verify`

All must pass from a clean install within documented timeouts.

### Phase 1: Release Hygiene and Truth

Objective: stop confusing generated artifacts and historical docs with source truth.

Deliverables:

- Archive historical prompt reports.
- Remove or ignore generated `release`, `dist`, `.tmp`, `.build` outputs.
- Add artifact manifest policy.
- Regenerate third-party notices.
- Add lint/format scripts or documented equivalents.

Acceptance:

- Clean source checkout can regenerate all build outputs.
- Status docs are generated or updated from current command results.

### Phase 2: Data Quality Gate

Objective: replace row-count claims with reviewed quality.

Deliverables:

- Source registry with verified licenses.
- Quarantine/raw/redacted/normalized stages.
- Human review queue.
- GOLD/SILVER/BRONZE/SYNTHETIC/BLIND splits with evidence.
- Independent blind set.
- Leakage audit that hard-fails contaminated suites.

Acceptance:

- No 99% claim until blind human-reviewed results support it.

### Phase 3: Engine and Candidate Hardening

Objective: make engine native-safe and hostile-benchmark ready.

Deliverables:

- Dictionary p95 below target.
- Hostile mixed Nepali-English benchmark.
- Ambiguity/name benchmark.
- Cursor/range replacement tests.
- Harden IPC/session/stale response handling.
- Native storage adapter interface and encryption plan.

Acceptance:

- Benchmarks pass and failure buckets shrink over multiple pack versions.

### Phase 4: Native Windows TSF

Objective: prove real Windows keyboard behavior.

Deliverables:

- Build TSF DLL on Windows.
- Implement TSF composition/commit/candidate path.
- Implement pass-through fallback.
- Add daemon reconnect.
- Integrate TSF into installer.
- Test Notepad, Word, Chrome, Edge, VS Code.

Acceptance:

- Fresh Windows VM install, type, candidate select, uninstall.
- Signed artifacts before public release.

### Phase 5: Native macOS IMK/XPC

Objective: prove real macOS keyboard behavior.

Deliverables:

- Implement IMK controller.
- Implement marked text and candidate UI.
- Implement XPC service.
- Add build/package scripts.
- Test TextEdit, Safari, Chrome, Pages, VS Code.

Acceptance:

- Fresh macOS install/enable/type/uninstall.
- Developer ID signing/notarization before public release.

### Phase 6: Companion Productionization

Objective: make companion a real settings/diagnostics app, not a label.

Deliverables:

- Stable app smoke tests.
- Settings wired to daemon config.
- Privacy, dictionary, memory, diagnostics, import/export.
- Native service status and input-method status.

Acceptance:

- Companion build and package tests pass.
- UI copy never calls companion the keyboard.

### Phase 7: Pilot and Release

Objective: launch only with evidence.

Deliverables:

- Private pilot consent flow.
- Redacted diagnostics export.
- Signed installers.
- Platform test matrix.
- Release readiness gate.

Acceptance:

- Public beta only after private pilot and native/signing gates pass.

## 19. Launch Gate Checklist

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Verification gate | `npm run verify` passes from clean install under timeout. | Complete for current repo gate; latest run passed. |
| Perf gate | `bench:perf:smoke` passes. | Complete; latest dictionary p95 is 8 ms against 30 ms gate. |
| Test gate | Full tests and companion smoke pass. | Complete; `npm run test` and `npm run test:companion` pass. |
| Scorecard gate | Scorecard fresh and strict. | Complete; no hard failures and no non-fresh reports. |
| Data gate | Licensed, redacted, reviewed gold/blind data. | Partial; corpus package gate passes, but only 124 human/project-reviewed gold rows, so public 99% claims remain blocked. |
| Romanized gate | Hostile blind Romanized/mixed benchmark. | Partial; current hostile/regression suites pass, but independent human-reviewed blind validation is still required for public accuracy claims. |
| Traditional gate | Verified physical layout or honest blocked status. | Blocked-human. |
| Windows native gate | TSF build/install/type/uninstall on Windows. | Blocked-native-environment; source exists and package command emits Windows-machine steps. |
| macOS native gate | IMK/XPC build/install/type/uninstall on macOS. | Partial; Swift IMK proof target builds and unsigned companion `.app` packages, installed IMK/XPC host-app validation remains blocked. |
| Daemon gate | Per-user resilient service with secured IPC. | Complete for dev dispatcher/IPC schema; OS service installation remains native packaging work. |
| Companion gate | Production shell builds, tests, packages. | Partial; shell tests/builds and unsigned macOS dev package passes; signed production release remains blocked. |
| Storage gate | Native storage, migrations, export/import/reset, encryption path. | Complete for current JSON/dev path; OS keychain/DPAPI hardening remains release hardening. |
| Privacy gate | No telemetry, secure input, redacted diagnostics, native IPC ACL. | Partial. |
| Installer gate | Signed installers and uninstallers. | Not met. |
| Pilot gate | Consent-based private pilot results. | Not met. |
| Public launch gate | All P0/P1 launch blockers closed. | Not met. |

## 20. Brutal Final Recommendation

Do not launch publicly.

Do not describe this as a production-ready Windows/macOS keyboard yet.

Honest status:

- The web Keyboard Lab and engine are useful validation assets.
- Romanized intelligence is promising but not proven on a real independent blind corpus.
- Traditional Unicode suggestions can be demonstrated, but Traditional physical keyboard is blocked by layout validation.
- The companion shell can be built, but it is not the keyboard and its standalone test currently fails.
- The daemon exists as a development component, but it is not a hardened per-user service.
- Windows TSF has source scaffolding and early implementation pieces, but it is not proven as a working Windows input method.
- macOS IMK is not implemented.
- Installer/signing/release readiness is not complete.

Recommended final launch recommendation today:

`NOT_READY_ENGINE_OR_VERIFICATION_FAILURES`

Secondary blockers:

- `blocked-native-environment`: real Windows TSF and macOS IMK build/test evidence unavailable in this audit environment.
- `blocked-external`: Authenticode certificate, Apple Developer ID, notarization credentials.
- `blocked-human`: LTK Traditional layout validation and large human-reviewed blind corpus.

The next correct move is not another completion document. The next correct move is to close P0-01 through P0-16 in order, rerun the command matrix, then move to real Windows/macOS native proof on actual platform environments.
