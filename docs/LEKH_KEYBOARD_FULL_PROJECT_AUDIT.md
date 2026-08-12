# Lekh Keyboard Full Project Audit and Production Readiness Roadmap

> Historical baseline: this audit records the repository state examined in June 2026. For current release truth and the 2026-07-17 cross-audit hardening status, use [CURRENT_PRODUCTION_READINESS_STATUS.md](CURRENT_PRODUCTION_READINESS_STATUS.md). Do not treat historical pass counts or native-install claims below as current artifact evidence.

Audit date: 2026-06-09  
Workspace: `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard`  
Fresh evidence folder: `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/reports/full-audit-2026-06-09T06-15-19-307Z`  
Primary result file: `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/reports/full-audit-2026-06-09T06-15-19-307Z/command-results.json`

## 1. Executive Verdict

Final audit verdict: `NOT_READY_NATIVE_BLOCKERS`.

The repo-executable foundation is in much better shape than the earlier failing state. TypeScript passes, unit tests pass, default verification passes, smoke and full performance benchmarks pass, the scorecard no longer silently marks the project launch-ready, the companion shell builds, the daemon bundle builds, the macOS Swift proof target builds, and an unsigned macOS companion app can be packaged.

That is not the same as a production-ready Windows/macOS keyboard. Lekh Keyboard must not be publicly described as production-ready until the native input-method gates pass on real platform environments. The current hard blockers are:

- Windows TSF DLL build, registration, text composition, candidate UI, and install/uninstall are not verified on Windows.
- Windows signed installer is blocked by Windows host requirements and signing certificate availability.
- macOS IMK proof code builds, but installed input-method behavior, XPC service integration, candidate UI, host-app testing, signing, and notarization are not complete.
- Traditional physical key layout remains blocked by human/source-of-truth LTK validation.
- The large corpus package is generated and quality-gated, but only 124 rows are human/project-reviewed gold evidence. It cannot support 99% universal accuracy claims yet.
- The active blind/held-out leakage gate is clean, but the former `romanized-held-out` suite remains quarantined and excluded from public-proof scoring.
- Real private pilot feedback is not yet collected.

Allowed claim today: the engine, lab, data pipeline, daemon scaffold, companion shell, and native proof paths are ready for platform validation.  
Forbidden claim today: fully launched, production Windows IME, production macOS IMK, 99% universal accuracy, complete Traditional keyboard, signed public release, or competitor-beating quality.

## 1.1 Follow-Up Closure on 2026-06-09

This follow-up pass closed or tightened several repo-executable issues from the launch-blocker table:

| Area | Current evidence |
| --- | --- |
| Test hang | `npm run test` completed cleanly in the latest verify run: 34 files / 208 tests passed. |
| Native scaffold hang | `npm run test:native-scaffold` completed: 7 files / 21 tests passed. |
| Daemon build | `npm run build:daemon` completed and emitted `native/daemon/dist/lekh-keyboard-daemon.mjs`. |
| Scorecard | `npm run scorecard:engine` completed from fresh reports and still recommends `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`. |
| User-data safety | Git metadata inspection now fails closed; outside a Git checkout the check exits 1 instead of treating Git failure as an empty tracked-file list. |
| Engine host action | `CandidateUpdate` and `CommitResult` now include explicit native host actions: `passThrough`, `compose`, `commit`, `cancel`, and `errorFallback`. |
| Native key semantics | Space commits active composition, empty backspace/delete/space pass through, secure-field native keys pass through without mutating composition, and tests cover those paths. |
| Session lifecycle | Session manager now has TTL cleanup and max-session LRU eviction for daemon/native lifecycle safety. |
| Runtime pack lookup | Runtime suggestion packs now use a lazy prefix index instead of full-pack scans per keystroke. |
| Traditional final gate | `npm run audit:traditional-layout:final` now fails until verified final layout files exist. The normal development audit still passes the honest pending scaffold. |
| Windows IPC freeze risk | Windows TSF IPC client source uses overlapped named-pipe read/write with bounded timeout and cancellation. |
| Daemon IPC hardening | JSONL IPC has a 64KB line cap, named-pipe sockets have idle timeout, and oversized payloads return a recoverable IPC error. |
| Docs hygiene | Historical completion narratives were removed; active status lives in `docs/CURRENT_PRODUCTION_READINESS_STATUS.md` and `docs/ENGINE_QUALITY_SCORECARD.md`. |

Remaining launch blockers are still real: Windows TSF must be built/tested on Windows, macOS IMK/XPC must be installed and tested in target apps, Traditional physical layout needs human/source-of-truth validation, signed installers need certificates, and pilot feedback must be collected with consent.

## 2. Audit Methodology

This audit used fresh local command evidence and did not treat existing completion reports as proof. The command matrix was run after `npm ci`, and each command wrote a log under the evidence folder.

Inspected areas:

- `package.json`, Vite, Vitest, and TypeScript config
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
- generated release/build output directories
- keyboard corpus package reports under `bench/reports`

Evidence rules:

- A passing scorecard is not enough if underlying command logs disagree.
- A native scaffold is not a native product.
- A browser lab or Electron companion is not the keyboard.
- Generated corpus scale is not human-reviewed accuracy evidence.
- External blockers must be named with exact commands and evidence needed.

## 3. Repository Inventory

Top-level size observations from this audit:

| Path | Approx size | Audit meaning |
| --- | ---: | --- |
| repository total | 5.1 GB | Large local workspace due data, release artifacts, native build output, and dependencies. |
| `data` | 2.1 GB | Large corpus/runtime data. Good for experimentation, risky for release hygiene without strict provenance and pack compilation. |
| `release` | 709 MB | Generated packaging output. Not source evidence and not a signed launch artifact. |
| `native` | 218 MB | Includes native source and generated Swift build output. Source/build separation must stay clean. |
| `dist` | 4.3 MB | Web build output. Useful validation artifact, not final IME. |
| `bench` | 3.1 MB | Fixtures and fresh reports. |
| `reports` | 1.6 MB | Local evidence logs, ignored by git. |

Repository structure is broadly coherent: shared engine in `src/engine`, browser validation UI in `src/features`, native scaffolds under `native`, Electron companion shell in repo-level packaging, scripts for corpus/bench/scorecard/release gates, and docs for release policy. The main structural risk is that generated data and release/build outputs are large enough to obscure what is source versus artifact.

## 4. Command and Verification Results

Fresh command matrix summary:

| Command | Status | Duration | Key result |
| --- | --- | ---: | --- |
| `npm ci` | pass | 7.211s | Installed 454 packages, 0 vulnerabilities; deprecation warnings remain. |
| `npm run typecheck` | pass | 8.783s | TypeScript project build passed. |
| `npm run test` | pass | latest verify | 34 files / 208 tests passed. |
| `npm run build` | pass with controlled warning | latest verify | Vite build passed; shell/feature chunks are split, lazy lexicon/Hunspell data chunks remain large. |
| `npm run check:privacy` | pass | 0.536s | Privacy scan passed. |
| `npm run check:engine-local` | pass | 0.325s | Engine local-first check passed. |
| `npm run check:engine-no-dom` | pass | 0.342s | Engine DOM-free check passed. |
| `npm run check:user-data` | pass | 0.353s | User-data safety check passed. |
| `npm run check:bundle-budget` | pass | latest verify | Fails accidental oversized app chunks; allows known lazy local data/Hunspell packs. |
| `npm run check:benchmark-disjointness` | pass | latest verify | Active contaminated suites `0`; `romanized-held-out` is quarantined and excluded from public-proof scoring. |
| `npm run benchmark:typing-session` | pass | 3.556s | 66 fixtures, no failures in report. |
| `npm run benchmark:romanized` | pass | 9.179s | Full Romanized benchmark passed; scores are suspiciously perfect and need harder blind data. |
| `npm run benchmark:romanized:self:smoke` | pass | 3.058s | Smoke self-consistency passed. |
| `npm run benchmark:proofread` | pass | 2.577s | 9 fixtures, exact match rate 1. |
| `npm run benchmark` | pass | 13.340s | Aggregate benchmark passed. |
| `npm run bench:perf:smoke` | pass | 3.825s | Performance smoke passed. |
| `npm run scorecard:engine` | pass | 0.542s | Scorecard generated honest blocked-native recommendation. |
| `npm run verify` | pass | latest verify | Default verification completed with bundle budget and third-party notice checks included. |
| `npm audit --audit-level=moderate` | pass | 1.132s | 0 vulnerabilities. |
| `npm run lint` | pass | 1.324s | Typecheck/privacy/no-DOM lint target passed. |
| `npm run format:check` | pass | 0.343s | Format check passed. |
| `npm run test:keyboard` | pass | 7.598s | 3 files / 37 tests passed. |
| `npm run test:dictionary` | pass | 7.402s | 1 file / 12 tests passed. |
| `npm run test:companion` | pass | 7.082s | Companion smoke tests passed. |
| `npm run test:native-scaffold` | pass | 10.70s | 7 files / 21 tests passed. |
| `npm run benchmark:dictionary` | pass | 2.913s | Dictionary typing-session suite passed. |
| `npm run benchmark:memory` | pass | 2.941s | Memory ranking/control suite passed. |
| `npm run bench:perf:full` | pass | 4.554s | Full perf suite passed. |
| `npm run build:companion` | pass | 23.361s | Daemon bundle, web build, and Electron dir build passed. |
| `npm run build:daemon` | pass | 11.443s | Built `native/daemon/dist/lekh-keyboard-daemon.mjs`. |
| `npm run build:windows` | blocked | 0.148s | Requires Windows host with MSVC and Windows SDK. |
| `npm run build:macos` | pass | 1.282s | Swift IMK proof target builds. |
| `npm run package:windows` | blocked | 0.173s | Signed Windows installer requires signing cert env. |
| `npm run package:windows:unsigned` | blocked | 0.207s | Windows NSIS/TSF release must be produced on Windows. |
| `npm run package:macos` | blocked | 0.165s | Requires Developer ID and notarization credentials. |
| `npm run package:macos:unsigned` | pass | 21.599s | Produced unsigned companion app under `release/mac-arm64`. |

The four failing commands are correctly categorized as external/native-environment blockers, not TypeScript or test failures. They still block production launch for the affected platforms.

## 5. Architecture Review

Current architecture is the right broad shape:

- Shared keyboard intelligence in `src/engine`.
- Browser Keyboard Lab as validation surface.
- Electron companion shell built from the React UI.
- Development daemon under `native/daemon`.
- IPC schema and message contract under `native/shared/ipc`.
- Windows TSF path under `native/windows-tsf`.
- macOS IMK path under `native/macos-imk`.
- Release scripts that fail honestly when platform/signing prerequisites are missing.

Production risk:

- The architecture is still split between working repo-executable validation and unproven native input surfaces.
- The Electron shell is a companion, not the IME. It must never be marketed as the keyboard.
- The daemon currently builds as a development/runtime component, but per-user service install, lifecycle recovery, OS-specific security, and native reconnection behavior need real platform tests.
- The native shells need host-app proof in Notepad/Word/Chrome/Edge/VS Code and TextEdit/Safari/Chrome/Pages/VS Code before launch.

## 6. Keyboard Engine Review

Strengths:

- Engine checks pass for local-first behavior and no DOM dependency.
- `processKeyStroke`, `updateComposition`, candidates, proof hints, dictionary lookup, memory, protected spans, secure input behavior, and session-oriented tests are covered by the passing suite.
- Default verification now terminates.
- Candidate dedupe and sequential shortcut behavior are benchmarked in typing sessions.

Remaining engine risks:

- Engine correctness is only as good as the current curated fixtures. The full Romanized benchmark reports perfect top-1/top-3/top-5 rates, which is a warning sign for fixture leakage or overly curated cases.
- Stale/native responses and host-app pass-through behavior still need end-to-end native proof.
- Range behavior and grapheme replacement should receive more hostile Devanagari tests before public beta.
- A large collision queue remains in alias data: 4,499 alias collisions and 4,237 review-needed items in the collision report.

## 7. Romanized Intelligence Review

Current verified state:

- Romanized benchmark passes.
- Typing-session benchmark passes.
- Mixed span mutation report shows no silent corruption on its current 25 fixtures.
- Romanized helpers, labels, phrase completion, memory influence, next-word fixtures, and protected tokens are wired into benchmark/UI paths.

Quality warning:

- `benchmark:romanized` reported perfect top-1/top-3/top-5 and MRR over 6,756 fixtures in the command output. A real universal keyboard should not trust a perfect internal score without a frozen human-reviewed blind set.
- `bench/reports/romanized-report.json` is the fresh smoke report from `benchmark:romanized:smoke`, 776 fixtures, top-1/top-3/top-5 all 1, suggestionHitAt5 0.926.
- The disjointness report now separates active contamination from quarantine: active contaminated suites are `0`, `romanized-held-out` is quarantined, and 1,896 fixtures are public-proof eligible. Public 99% claims remain blocked because the reviewed blind/gold evidence is still too small.

## 8. Traditional Keyboard Review

Current verified state:

- Traditional Unicode suggestions/proofread paths are present and covered by current tests/benchmarks.
- `audit:traditional-layout` is part of `verify`, so fake layout completion is gated.
- Docs and scorecard correctly mark Traditional physical mode as `blocked-human`.

Production blocker:

- Traditional physical keyboard is not production-complete until every key/modifier state is captured from an authoritative LTK/source-of-truth process and validated by Traditional typists.

Exact unblock path:

1. Capture LTK-compatible base, Shift, AltGr/Option, and Shift+AltGr behavior.
2. Compare against standard Nepali Unicode layout.
3. Generate layout JSON and every-key fixtures.
4. Validate with human Traditional typists.
5. Run layout preview consistency tests.
6. Only then mark physical Traditional complete.

## 9. Proofread / Dictionary / Memory Review

Proofread:

- `npm run benchmark:proofread` passed in 2.577s.
- Fresh proofread report has 9 fixtures and exact match rate 1.
- This proves the curated smoke scope, not universal proofreading.

Dictionary:

- `npm run test:dictionary` and `npm run benchmark:dictionary` passed.
- Dictionary lookup is offline and no unsafe dictionary meanings are included.
- Meaning support remains dependent on licensed sources.

Memory:

- `npm run benchmark:memory` passed.
- Memory ranking/control suite has 4 fixtures, memoryBoostSuccessRate 1, secure/code warnings present, duplicateCandidateCount 0.
- Production still needs real storage lifecycle tests for export/import/reset on installed desktop builds.

## 10. Candidate System Review

Current strengths:

- Candidate dedupe and shortcut sequence validity are checked by typing-session reports.
- Memory boost, dictionary, labels, protected spans, and helper candidates are visible through current engine/lab flows.
- No duplicate candidate count was reported in current typing-session memory/dictionary fixtures.

Open risks:

- Alias collisions are numerous and need review priority. Examples like short aliases and names require conservative candidate ordering.
- Candidate ranking must be validated against hostile mixed-language cases, not only generated fixtures.
- The ranking formula should keep latency out of linguistic scoring, but native IPC timeout/fallback must still be separately enforced.

## 11. UI / UX Review

Current state:

- The React app builds.
- Keyboard Lab validates engine behavior and is not the final IME.
- Companion shell smoke tests pass.
- `npm run build:companion` passed and produced Electron directory output.
- `npm run package:macos:unsigned` produced an unsigned companion `.app`.

Production gaps:

- UI/UX is not yet proven against competitor-quality desktop workflows.
- The companion shell is production-directional, but not a final signed install experience.
- Native candidate windows, input-method menus, onboarding, and OS settings flows are unproven.
- The web lab should remain a demo/diagnostic surface, not a product substitute.

## 12. Performance and Bundle Review

Fresh full performance report from `bench/reports/perf-report.json`:

| Case | p95 | Gate | Status |
| --- | ---: | ---: | --- |
| 50-token hostile Romanized mixed sentence | 1 ms | 30 ms | pass |
| 5KB mixed Preeti paragraph | 19 ms | 100 ms | pass |
| KeyboardEngine warm startup | 0 ms | 500 ms | pass |
| Partial warm timeout | 0 ms | 50 ms | pass |
| Romanized live update | 1 ms | 20 ms | pass |
| Candidate count cap | 1 ms | 20 ms | pass |
| Traditional Unicode suggestion | 3 ms | 20 ms | pass |
| Proofread hint update | 0 ms | 40 ms | pass |
| Dictionary lookup | 8 ms | 30 ms | pass |
| Memory ranking update | 0 ms | 10 ms | pass |
| Candidate commit | 1 ms | 10 ms | pass |
| Native IPC JSON envelope simulation | 0 ms | 10 ms | pass |

Bundle state:

- Feature shell chunks are now split: `KeyboardLab` is about 9.56 kB minified, `RomanizedEditor` about 7.96 kB, `CompanionShell` about 6.98 kB, and engine feature chunks are under 67 kB.
- Known large lazy local data chunks remain: `keyboard-lexicon-data` about 2,537.64 kB, `vendor-hunspell` about 955.98 kB, and `keyboard-runtime-pack` about 582.35 kB.
- `npm run check:bundle-budget` now gates this policy and passes with 19 checked JS assets.

Performance is currently acceptable for engine smoke/full benchmarks. Bundle splitting is improved and gated; the remaining release-hardening task is replacing the large JSON/TSV runtime packs with compact indexed assets.

## 13. Tests / Benchmarks / Scorecards Review

Good:

- Test reliability is currently fixed.
- `verify` passes and exits.
- Scorecard is fresh and recommends blocked-native, not launch-ready.
- Benchmark scripts do not pass with zero cases in current package checks.

Not good enough for public accuracy claims:

- Generated/internal fixtures dominate quality evidence.
- Active held-out contamination is fixed; `romanized-held-out` is quarantined and excluded from public-proof scoring.
- The blind set exists in corpus packaging counts, but independent human-reviewed quality and leakage audits must be proven before 99% claims.
- The scorecard should keep treating perfect benchmark scores as a review signal, not as production proof.

Fresh scorecard final production statuses:

| Area | Status |
| --- | --- |
| verification/tests/benchmarks | complete |
| Romanized | complete within current benchmark scope |
| Traditional physical | blocked-human |
| Traditional suggestions | complete within current scope |
| proofread/dictionary/memory | complete within current scope |
| companion app | partial |
| daemon IPC | complete for repo-executable tests |
| Windows native | blocked-native-environment |
| macOS native | blocked-native-environment |
| installer/signing | blocked-external |
| pilot readiness | partial |
| release readiness | blocked-external |

## 14. Data and Corpus Plan Review

Fresh corpus package report:

| Dataset | Curated rows |
| --- | ---: |
| D1 word aliases | 1,000,000 |
| D2 phrase aliases | 99,998 |
| D3 casual Romanized sentences | 249,685 |
| D4 mixed Nepali-English sentences | 250,000 |
| D5 proofread pairs | 100,000 |
| D6 names/surnames | 50,000 |
| D7 next-word contexts | 1,000,000 |
| D8 blind examples | 100,000 |

Quality counts:

| Quality | Count |
| --- | ---: |
| gold | 124 |
| silver | 54,876 |
| bronze | 0 |
| synthetic | 10,000 |
| blind | 100,000 |

Verdict:

- The corpus pipeline is large and gated.
- It is not yet a million-row human-reviewed gold corpus.
- Only 124 human/project-reviewed gold rows are current public-quality evidence.
- Generated and silver rows can power development, ranking experiments, and review queues, but not 99% universal claims.

Exact next data work:

1. Resolve `romanized-held-out` contamination.
2. Freeze a clean blind set that is never used in tuning.
3. Promote high-impact ambiguous aliases to gold by human review.
4. Prioritize collisions, names, mixed English, loanword preferences, and casual spelling variants.
5. Track license/source status per source row.
6. Keep runtime packs compact and compiled, not raw giant JSON in production.

## 15. Native Windows/macOS Review

### Windows

Current state:

- Windows TSF source path exists.
- `npm run build:windows` fails honestly on macOS with `blocked-native-environment`.
- Manual commands are emitted: `cd native\windows-tsf\skeleton`, `.\build.ps1`, `.\register-dev.ps1`.
- `npm run package:windows` and `npm run package:windows:unsigned` are blocked by Windows host/signing requirements.

Not proven:

- TSF DLL build on Windows.
- Registration in Windows input settings.
- Text composition and Unicode commit in Notepad/Word/Chrome/Edge/VS Code.
- Candidate UI in native context.
- Daemon disconnect pass-through under real TSF event flow.
- Installer registration/unregistration.
- Authenticode signing.

### macOS

Current state:

- `npm run build:macos` passes Swift build.
- `npm run package:macos:unsigned` creates an unsigned companion `.app`.
- `npm run package:macos` blocks honestly on missing Developer ID and notarization credentials.

Not proven:

- Installed `.inputmethod` behavior.
- IMK marked text and candidate UI in TextEdit/Safari/Chrome/Pages/VS Code.
- XPC service integration in installed app context.
- Secure input fallback.
- Signed/notarized release.
- Clean install/enable/disable/uninstall flow.

## 16. Privacy / Security / Release Review

Current positives:

- Privacy, local-first, no-DOM, offline, user-data, IPC schema, runtime-data, and installer-flow checks are wired into `verify`.
- No hidden telemetry was found by the current scripted checks.
- Normal typing does not require network in the engine path.

Remaining release/security blockers:

- Windows named pipe ACL/security must be verified on Windows.
- macOS XPC scope and entitlement behavior must be verified in installed app context.
- Secure input behavior must be proven in real native apps.
- Signed Windows installer requires certificate and CI/secret setup.
- Signed macOS release requires Developer ID, hardened runtime, and notarization.
- Third-party notices/license manifest should be regenerated after Electron packaging dependencies.

## 17. Complete Issue Register

Open Noble-plan rows: 0; active v1 rows: 8; deferred beyond v1: 15. This historical register no longer defines release scope.

| ID | Severity | Area | Status | Evidence | Exact fix |
| --- | --- | --- | --- | --- | --- |
| P0-01 | P0 | Windows TSF | active-v1 | `build:windows` blocked on `darwin-arm64`. | Build TSF DLL on Windows with MSVC/SDK, register, test host-app typing, save logs. |
| P0-02 | P0 | Windows text commit | active-v1 | No Notepad/Word/Chrome proof. | Prove TSF composition/commit/candidate flow and daemon failure pass-through. |
| P0-03 | P0 | Windows installer | active-v1 | `package:windows*` blocked. | Produce and CI-test the unsigned v1 Windows installer and uninstaller. |
| P0-04 | P0 | macOS IMK | active-v1 | Swift builds, installed IMK not validated. | Install `.inputmethod`, enable, test marked text/commit/candidates in target apps. |
| P0-05 | P0 | macOS signing | moved-v2 | `package:macos` requires Developer ID/notarization env. | Add Developer ID credentials, hardened runtime, notarize, staple, verify. |
| P0-06 | P0 | Traditional physical | moved-v2 | Scorecard `traditionalPhysical=blocked-human`. | Complete LTK capture, fixtures, typist validation, and layout preview consistency. |
| P0-07 | P0 | Blind benchmark | moved-v2 | Active contaminated suites are `0`; `romanized-held-out` is quarantined; public-proof eligible fixtures `1,896`. | Keep quarantined suite excluded, grow independent human-reviewed blind set, and block public 99% claims until reviewed evidence is sufficient. |
| P0-08 | P0 | Corpus quality | moved-v2 | 124 gold rows only. | Grow human-reviewed gold rows in high-impact queues before accuracy claims. |
| P0-09 | P0 | Pilot feedback | moved-v2 | No real pilot evidence. | Run consented private pilot and import redacted feedback into review queue. |
| P0-10 | P0 | Launch claim policy | moved-v2 | Scorecard blocks release. | Keep public claims conservative until native/signing/pilot gates pass. |
| P1-01 | P1 | Alias collisions | moved-v2 | 4,499 collisions, 4,237 review-needed. | Prioritize short aliases, names, loanwords, and high-frequency terms for review. |
| P1-02 | P1 | Benchmark trust | moved-v2 | Perfect Romanized scores. | Add hostile real-world blind mixed cases and fail on suspicious leakage. |
| P1-03 | P1 | Bundle size | moved-v2 | App/feature shell split; bundle budget passes; large lazy local data packs remain. | Replace raw TSV/JSON runtime packs with compact indexed assets after native data-pack format is finalized. |
| P1-04 | P1 | Daemon install | active-v1-windows; macOS moved-v2 | Dev daemon builds, service install unproven. | Verify Windows daemon startup and removal through the v1 installer flow. |
| P1-05 | P1 | IPC security | active-v1-windows; macOS moved-v2 | ACL/XPC security not OS-tested. | Keep the existing Windows per-user pipe security tests green for v1. |
| P1-06 | P1 | Companion UX | moved-v2 | Tests/build pass, no native onboarding proof. | User-test install/status/settings/privacy/diagnostics flows. |
| P1-07 | P1 | Release licenses | moved-v2 | `check:third-party-notices` is wired into `verify` and passes. | Regenerate full transitive license manifest before signed public release artifacts. |
| P1-08 | P1 | Runtime data | moved-v2 | `data` is 2.1 GB. | Keep only compiled/minimal runtime packs in app builds. |
| P1-09 | P1 | Native candidate UI | active-v1 | No real OS candidate window evidence. | Implement and test native candidate UI selection on both platforms. |
| P1-10 | P1 | Secure input native | active-v1 | Engine tests pass; native secure input unproven. | Test password/secure fields and ensure memory/proofread disabled. |
| P2-01 | P2 | Dependency hygiene | moved-v2 | `npm ci` deprecation warnings. | Upgrade/replace deprecated transitive paths where practical. |
| P2-02 | P2 | Generated artifacts | moved-v2 | `release`, native build output, reports are large. | Keep ignored; do not commit generated binaries unless release artifact policy says so. |
| P2-03 | P2 | Documentation volume | moved-v2 | Many historical reports exist. | Maintain current status index and archive stale completion docs. |

Resolved in current evidence:

| ID | Prior issue | Current evidence |
| --- | --- | --- |
| R-01 | `.at()`/TypeScript failure | `npm run typecheck` passes. |
| R-02 | `npm run test` hang | `npm run test` passes in 42.096s. |
| R-03 | `npm run verify` failure | `npm run verify` passes in 76.578s. |
| R-04 | Corpus validation missing files | `corpus:keyboard:package-check` passes. |
| R-05 | Scorecard lying about failure | Scorecard says `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`. |
| R-06 | Full Romanized benchmark hang | Full benchmark completes in 9.179s. |
| R-07 | Companion shell smoke failure | `test:companion` passes. |
| R-08 | macOS build script missing | `build:macos` passes. |
| R-09 | macOS unsigned package missing | `package:macos:unsigned` passes. |
| R-10 | Performance target missed | `bench:perf:full` shows no target misses. |

## 18. Production-Ready Fix Roadmap

### Phase 1: Clean Public-Claim Data Gates

Objective: prevent fake accuracy claims.

Actions:

1. Keep quarantined `romanized-held-out` fixtures excluded from public-proof scoring.
2. Freeze blind v0.2 from non-overlapping, human-reviewed source rows.
3. Promote high-impact rows to gold by human review.
4. Run benchmarks against blind and hostile mixed suites.
5. Fail scorecard if blind leakage or perfect-score suspiciousness remains unresolved.

Exit gate: fresh disjointness report has no active contaminated suites, quarantined suites remain excluded, and blind benchmark has meaningful human-reviewed failure buckets.

### Phase 2: Traditional Physical Layout Validation

Objective: make Traditional physical keyboard real or keep it blocked honestly.

Actions:

1. Capture every LTK key/modifier.
2. Produce JSON layout and fixtures.
3. Review with Traditional typists.
4. Add every-key benchmark and layout preview test.
5. Only then enable Traditional physical mode.

Exit gate: `traditionalPhysical=complete` with human validation evidence.

### Phase 3: Windows Native Release Candidate

Objective: prove a working Windows keyboard, not a companion app.

Actions:

1. Run `native\windows-tsf\skeleton\build.ps1` on Windows.
2. Register with `register-dev.ps1`.
3. Start daemon.
4. Type and commit candidates in Notepad, Word, Chrome, Edge, VS Code.
5. Test daemon down/error pass-through.
6. Package unsigned installer.
7. Package signed installer after certificate is available.

Exit gate: Windows install/type/uninstall logs plus signed artifact verification.

### Phase 4: macOS Native Release Candidate

Objective: prove installed IMK/XPC behavior.

Actions:

1. Build/install input method bundle.
2. Enable in macOS input settings.
3. Test TextEdit, Safari, Chrome, Pages, VS Code.
4. Validate marked text, candidate UI, commit, pass-through, secure input.
5. Package unsigned development build.
6. Sign/notarize once Developer ID credentials exist.

Exit gate: installed IMK host-app test logs plus signed/notarized artifact verification.

### Phase 5: Companion and Installer Polish

Objective: make the companion useful and honest.

Actions:

1. Keep companion labeled as settings/status app, not the keyboard.
2. Wire native status, daemon status, privacy, diagnostics, dictionary, memory, and import/export flows.
3. Add install/uninstall cleanup checklists.
4. Regenerate third-party notices.

Exit gate: companion build, smoke tests, package checks, and manual UX test pass.

### Phase 6: Private Pilot

Objective: validate real users before public claims.

Actions:

1. Run consented pilot with Romanized, mixed English, Traditional typists, office, education, casual, and tech users.
2. Collect redacted failure buckets only.
3. Promote reviewed fixes into data/ranking packs.
4. Rerun blind and hostile benchmarks.

Exit gate: measurable failure buckets shrink and no P0 native/input corruption remains.

## 19. Final Launch Gate Checklist

| Gate | Required evidence | Current status |
| --- | --- | --- |
| TypeScript | `npm run typecheck` pass | pass |
| Tests | `npm run test`, split tests pass | pass |
| Default verification | `npm run verify` pass | pass |
| Performance | smoke/full target misses false | pass |
| Scorecard truth | fresh scorecard blocks release correctly | pass |
| Romanized engine | benchmark/lab pass plus blind set | partial: internal pass, blind trust blocked |
| Mixed typing | hostile blind mixed suite | partial: current small suite passes |
| Proofread/dictionary/memory | tests/benchmarks pass | pass in current scope |
| Traditional physical | captured layout + human validation | blocked-human |
| Keyboard Lab | builds and validates engine | pass |
| Companion | builds/packages unsigned, UX tested | partial |
| Daemon | build + OS lifecycle tests | partial |
| Windows TSF | build/register/type/uninstall on Windows | blocked-native-environment |
| Windows installer | signed installer verified | blocked-external |
| macOS IMK/XPC | installed input method host-app tests | blocked-native-environment |
| macOS signing/notarization | signed/notarized/stapled artifact | blocked-external |
| Privacy/security | scripted checks + native secure input | partial |
| Corpus | licenses, redaction, gold review, leakage clean | partial |
| Pilot | consented private pilot results | pending |
| Public beta | no P0/P1 launch blockers | not ready |
| Stable launch | signed native installers, pilot evidence | not ready |

## 20. Brutal Final Recommendation

Do not ship this as a public production Windows/macOS Nepali keyboard yet.

The repository is no longer in a broken-foundation state. Verification is stable, tests pass, performance passes, the scorecard is honest, the companion shell builds, the daemon builds, and native release scripts fail with explicit blockers instead of pretending to succeed.

But the product is still not launch-ready because the only thing that matters for a desktop keyboard is native input behavior inside real host applications. That is not proven on Windows or macOS. Traditional physical typing is also not complete without human/source-of-truth layout validation. The corpus is large, but the reviewed gold evidence is far too small for universal 99% quality claims.

Final recommendation: `NOT_READY_NATIVE_BLOCKERS`.

Next correct work:

1. Fix blind-set contamination and corpus review gates.
2. Complete Traditional layout validation.
3. Build and test Windows TSF on Windows.
4. Install and test macOS IMK/XPC on macOS.
5. Sign/notarize/package installers.
6. Run consented private pilot.
7. Only then reopen public beta or stable launch gates.
