# Keyboard Production Readiness Evidence

Generated: 2026-06-08

## Status Summary

Repo-executable keyboard data, runtime pack integration, companion shell, privacy surface, installer-flow validation, and macOS Swift IMK proof build are complete in this environment.

Native production launch is not claimed. Full Windows/macOS launch remains blocked by real external/native requirements: Windows TSF host machine and signing certificate, full Xcode/IMK installation validation, Apple Developer ID, notarization, and human Traditional layout validation.

## Final Verification Evidence

Commands:

```bash
npm run verify
npm audit --audit-level=moderate
```

Result on 2026-06-08: both passed after upgrading Vitest to the audit-safe line, pinning `vite-node` to the Vite 7-compatible runner, and stabilizing the smoke performance harness with one untimed warmup plus at least 20 smoke samples.

Verification log:

- `.tmp/final-verify.log`

## Data Pipeline Evidence

Command:

```bash
npm run corpus:keyboard:validate
```

Result: passed.

Counts:

| Dataset | Count | Target |
| --- | ---: | ---: |
| Romanized word aliases | 1,000,000 | 1,000,000 |
| Romanized phrase aliases | 100,000 | 100,000 |
| Casual Romanized sentences | 250,000 | 250,000 |
| Mixed Nepali-English sentences | 250,000 | 250,000 |
| Proofread error/correction pairs | 100,000 | 100,000 |
| Name/surname variants | 50,000 | 50,000 |
| Next-word contexts | 1,000,000 | 1,000,000 |
| Frozen blind test | 100,000 | 100,000 |

Curation status:

- `sources.jsonl` exists with license metadata.
- Raw source quarantine exists under `data/keyboard-corpus/quarantine`.
- D1-D8 curated JSONL files exist under `data/keyboard-corpus/curated/v0.1`.
- Blind leakage audit passed with zero violations.
- Review queue contains 25,000 rows.
- GOLD promotion seed contains 149 rows.
- Runtime packs exist under `data/keyboard-corpus/runtime/v0.1`.
- Bundled runtime suggestion pack exists at `src/data/keyboard-packs/v0.1/runtime-suggestions.json`.

Git packaging note:

- The pushed repository includes the source registry, quarantine metadata, reports, review scaffolding, and runtime packs.
- The heaviest generated and curated JSONL corpora remain reproducible local artifacts and are rebuilt with `npm run corpus:keyboard` rather than committed into remote Git history.

## Engine And Benchmark Loop

Command:

```bash
npm run benchmark:typing-session
npm run benchmark:keyboard:failure-buckets
```

Result: both passed.

Typing-session summary:

- fixture count: 60
- failed sessions: 0
- Romanized top-1: 1.0
- Romanized top-3: 1.0
- duplicate candidate count: 0
- shortcut sequence validity: 1.0
- dictionary hit rate: 1.0
- memory boost success rate: 1.0
- next-word success rate: 1.0
- failure buckets: none

Loop artifacts:

- `bench/reports/typing-session-report.json`
- `data/keyboard-corpus/review/v0.1/benchmark_failure_buckets.json`
- `data/keyboard-corpus/review/v0.1/benchmark_failure_review_queue.jsonl`

## Performance Evidence

Command:

```bash
npm run bench:perf:smoke
```

Result: passed.

Key p95 numbers:

| Path | p95 |
| --- | ---: |
| KeyboardEngine warm startup | 1 ms |
| partial warm timeout | 0 ms |
| Romanized live update | 6 ms |
| candidate count cap | 5 ms |
| Traditional Unicode suggestion | 6 ms |
| proofread hint update | 1 ms |
| dictionary lookup | 12 ms |
| memory ranking update | 3 ms |
| candidate commit | 3 ms |
| native IPC JSON envelope simulation | 0 ms |

## Companion And Privacy Evidence

Commands:

```bash
npm run test:companion
npm run build:companion
npm run check:privacy
```

Results: passed.

Companion status:

- Companion app console builds in the production web bundle.
- Privacy page readiness panel is tested.
- Privacy controls include telemetry off, secure input, consent controls, redacted diagnostics, and data deletion.
- Companion is explicitly not the IME and does not globally hook keys.

## Installer Flow Evidence

Command:

```bash
npm run check:installer-flow
```

Result: passed.

Report:

- `reports/installer-flow-check.json`

This validates the repo-executable installer/release flow documentation for Windows and macOS. It does not build signed installers, because signing assets and native host validation are external blockers.

## Native Evidence

macOS proof build:

```bash
cd native/macos-imk/skeleton
swift build
```

Result: passed with Swift 6.2.3.

macOS installed IMK blocker:

- `xcodebuild -version` fails because full Xcode is not selected; only Command Line Tools are active.
- Developer ID and notarization access are unavailable in the repo environment.

Windows TSF blocker:

- `cmake --version` fails because CMake is not installed here.
- This host is not a Windows TSF host with Visual Studio/MSBuild.
- Windows code-signing certificate is unavailable in the repo environment.

## Final Launch Classification

Current recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

The repo is ready for engine/data/companion/macOS-proof-build validation and private engineering demo. Public launch requires installed native input method validation, signing/notarization, installer QA, Traditional layout human validation, and pilot feedback.
