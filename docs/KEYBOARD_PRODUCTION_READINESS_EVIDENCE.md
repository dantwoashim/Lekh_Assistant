# Keyboard Production Readiness Evidence

Generated: 2026-06-08

## Status Summary

Repo-executable keyboard engine checks, runtime pack integration, default verification, companion shell, unsigned macOS companion dev package, macOS IMK Swift proof target, privacy surface, installer-flow documentation validation, and daemon/IPC development path are passing.

Native production launch is not claimed. Full Windows/macOS launch remains blocked by unresolved native implementation and external release requirements:

- Windows TSF must be built/tested on Windows with MSVC/Windows SDK and real host apps.
- macOS IMK proof source builds, but installable IMK bundle/XPC validation still requires native packaging, host-app tests, signing, and notarization.
- Windows signing certificate, Apple Developer ID, and notarization credentials are unavailable.
- Traditional physical layout still needs human LTK validation.
- Public quality claims need a real human-reviewed blind benchmark and pilot feedback.

## Verification Evidence

Command:

```bash
npm run verify
```

Result on 2026-06-08: passed end to end after stabilization. It was rerun after corpus trace cleanup and runtime-pack regeneration; the final rerun also passed.

Verification summary from the current run:

- TypeScript passed.
- 34 test files and 204 tests passed.
- Standalone companion smoke passed.
- Production build passed.
- Privacy, offline, runtime-data, user-data, IPC schema, installer-flow, corpus package, Traditional audit, disjointness, typing-session, Romanized smoke, proofread, competitor, performance smoke, scorecard, engine-local, engine-no-DOM, protected-span, and Romanized self-consistency smoke checks passed.

Audit command still required before a release tag:

```bash
npm audit --audit-level=moderate
```

## Data Pipeline Evidence

Command:

```bash
npm run corpus:keyboard:package-check
```

Result: passed.

Counts:

| Dataset | Count |
| --- | ---: |
| Romanized word aliases | 1,000,000 |
| Romanized phrase aliases | 99,998 |
| Casual Romanized sentences | 249,685 |
| Mixed Nepali-English sentences | 250,000 |
| Proofread error/correction pairs | 100,000 |
| Name/surname variants | 50,000 |
| Next-word contexts | 1,000,000 |
| Frozen blind test | 100,000 |

Curation status:

- `sources.jsonl` exists with license metadata.
- Raw source quarantine exists under `data/keyboard-corpus/quarantine`.
- D1-D8 curated JSONL files exist under `data/keyboard-corpus/curated/v0.1`.
- Blind leakage audit passed structurally.
- Review queue exists.
- Human/project-reviewed gold rows: 124.
- GOLD promotion seed rows: 149.
- Reviewed scale status: partial.

The large corpus is present, but it is not a million-row human-reviewed proof set.

## Engine And Benchmark Evidence

Commands:

```bash
npm run benchmark:typing-session
npm run benchmark:romanized:smoke
npm run benchmark:proofread
npm run benchmark:protected
```

Current typing-session summary:

- fixture count: 66
- failed sessions: 0
- duplicate candidate count: 0
- shortcut sequence validity: 1.0
- dictionary hit rate: 1.0
- memory boost success rate: 1.0
- next-word success rate: 1.0

Romanized self-consistency smoke now runs 140 fixtures and completed in 186 ms in the latest verification run.

## Performance Evidence

Command:

```bash
npm run bench:perf:smoke
```

Result: passed.

Latest p95 numbers:

| Path | p95 |
| --- | ---: |
| hostile Romanized mixed sentence | 1 ms |
| 5KB mixed Preeti side utility | 21 ms |
| KeyboardEngine warm startup | 0 ms |
| partial warm timeout | 0 ms |
| Romanized live update | 1 ms |
| candidate count cap | 1 ms |
| Traditional Unicode suggestion | 2 ms |
| proofread hint update | 0 ms |
| dictionary lookup | 8 ms |
| memory ranking update | 0 ms |
| candidate commit | 1 ms |
| native IPC JSON envelope simulation | 0 ms |

## Companion And Privacy Evidence

Commands:

```bash
npm run test:companion
npm run build:companion
npm run package:macos:unsigned
npm run check:privacy
```

Results:

- `test:companion`: passed, 9 tests.
- `build:companion`: passed in current run history.
- `package:macos:unsigned`: passed and produced `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/mac-arm64/Lekh Keyboard Companion.app`.
- `check:privacy`: passed.

Companion status:

- Companion shell is a settings/diagnostics app, not the keyboard.
- Privacy page readiness panel is tested.
- Privacy controls include telemetry off, secure input, consent controls, redacted diagnostics, and data deletion.
- Companion does not globally hook keys.

## Installer Flow Evidence

Command:

```bash
npm run check:installer-flow
```

Result: passed.

Report:

- `reports/installer-flow-check.json`

Packaging command evidence:

| Command | Result |
| --- | --- |
| `npm run package:windows:unsigned` | `blocked-native-environment` on darwin-arm64; manual Windows commands emitted. |
| `npm run build:macos` | passed Swift IMK proof target. |
| `npm run package:macos:unsigned` | passed unsigned dev companion `.app`. |
| `npm run package:macos` | blocked until Developer ID and notarization credentials exist. |
| `npm run package:windows` | blocked until Authenticode certificate material exists. |

## Native Evidence

Windows:

- TSF source exists.
- TSF source now defaults to pass-through unless `LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING` is explicitly enabled.
- TSF client derives the default named pipe from the Windows user SID when available.
- Native scaffold source tests check the pass-through guard and per-user pipe source contract.
- Real TSF build/install/type/uninstall must run on Windows.

macOS:

- `npm run build:macos` passes a Swift package containing `LekhInputController`, `LekhCandidateController`, and `LekhXpcClient`.
- Installed IMK/XPC validation remains blocked until the proof target is packaged as an input method bundle and tested in TextEdit, Safari, Chrome, Pages, and VS Code.

## Final Launch Classification

Current recommendation: `NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`.

The repo is ready for engine/data/companion validation and private engineering demo. Public launch requires native Windows/macOS implementation evidence, signed installers, Traditional layout human validation, a real blind benchmark, and pilot feedback.
