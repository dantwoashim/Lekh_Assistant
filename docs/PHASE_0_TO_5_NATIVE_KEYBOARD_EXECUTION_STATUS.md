# Phase 0-5 Native Keyboard Execution Status

Generated: 2026-06-10

## Executive Decision

The repo-executable Phase 0-5 work is now tightened around the real product: a native Windows TSF and macOS InputMethodKit keyboard backed by the local KeyboardEngine. The browser demo and Electron build are explicitly guarded as validation/companion surfaces, not as the final keyboard.

The project must still not be called production-launch-ready until the Windows TSF path is built and tested on Windows, the macOS IMK/XPC path is installed and tested in real apps, signing/notarization are available, and Traditional physical layout is validated by humans.

## Phase 0 - Product Truth And Scope Lock

Status: complete for repo gates.

Evidence:

- `README.md` now states that the Electron/browser demo is not the keyboard app.
- `electron-builder.config.cjs` continues to package `Lekh Keyboard Companion`, not a fake keyboard.
- `scripts/check-product-truth.mjs` fails verification if key truth markers are removed.
- `npm run verify` now includes `check:product-truth`.

Exit boundary:

- The native keyboard is TSF on Windows and InputMethodKit on macOS.
- The companion app is for status, settings, diagnostics, privacy controls, and packaging.
- Preeti remains a side utility.

## Phase 1 - Native Proof Spike

Status: partially complete, with true platform blockers.

macOS progress:

- `native/macos-imk/skeleton` builds a Swift proof target with `npm run build:macos`.
- `LekhInputController` defaults to the packaged local native runtime suggestion pack and can force the future XPC path with `LEKH_IMK_USE_XPC`.
- The proof engine now buffers real typed sequences, returns marked text, commits on Enter/Tab, cancels on Escape, supports backspace, and proves flagship examples such as `swasthya`, `ramro xa`, and `mero swasthya ramro xa`.
- `npm run test:native-scaffold` source-scans the proof path so it cannot silently regress to a single dummy key.

Windows status:

- Windows TSF source and release scripts exist, but this macOS environment cannot build or host-test a TSF input method.
- Current launch status remains `blocked-native-environment` for Windows until a Windows machine/CI runner builds, registers, and tests it in Notepad, Word, Chrome, Edge, and VS Code.

Not claimed:

- No signed Windows installer.
- No signed/notarized macOS IMK release.
- No production native keyboard claim.

## Phase 2 - Engine Contract

Status: improved and tested.

Engine behavior now covered:

- `CandidateUpdate.action` supports host decisions such as `passThrough`, `compose`, `commit`, `cancel`, and `errorFallback`.
- Secure contexts pass through without composition or memory writes.
- Candidate shortcuts `1-9` commit existing candidates without inserting digits into the composition buffer.
- Commit/cancel/raw commit behavior remains covered by keyboard tests.
- Mixed/protected spans preserve structured tokens without bypassing the engine.

Latest focused evidence:

- `npm run test:keyboard` passes.
- `npm run typecheck` passes.

## Phase 3 - Romanized Core Excellence

Status: improved for current engine/lab scope.

Covered behavior:

- Per-keystroke Romanized composition.
- `swas`, `swasthya`, government phrases, casual phrases, typo correction, and phrase correction are covered by existing keyboard and typing-session suites.
- Candidate shortcut commit is native-host friendly.
- Protected/mixed examples preserve IDs, emails, and uppercase acronyms.

Remaining quality work before public quality claims:

- Real human-reviewed blind data must continue expanding.
- Accuracy claims must be based on source-disjoint benchmarks, not runtime pack overlap.

## Phase 4 - Premium Candidate UX

Status: improved for browser demo and native contract.

Current behavior:

- Browser demo provides minimal typing with inline/near-word suggestion behavior from the existing UI work.
- Engine candidates stay deduped and sequential.
- Desktop Tab/Enter and mobile click/tap flows are supported in the demo layer.
- Native candidate shortcuts now work through `processKeyStroke`.

Not claimed:

- Browser UI is still a demo/validation surface, not a system keyboard.

## Phase 5 - Mixed Nepali-English Intelligence

Status: materially improved, still pilot-tunable.

New engine behavior:

- Generic mixed-token policy now handles inputs beyond exact fixture rows.
- Protected tokens such as uppercase acronyms, emails, URLs, IDs, and date/number patterns are preserved as spans.
- Preference loanwords such as `file`, `form`, `report`, `submit`, `upload`, `download`, `system`, `office`, and `record` produce preserve and converted options.
- Example covered by tests: `mero PAN file upload bhayena` produces both `मेरो PAN file upload भएन` and `मेरो PAN फाइल अपलोड भएन`.

Remaining before universal quality claims:

- Broader real-world casual/mixed data and human review are still required.
- The product should keep offering candidates/preferences instead of forcing every loanword into Devanagari.

## Current Launch Boundary

The repo is stronger for Niraj-facing validation and native development, but the honest launch decision remains:

`NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`

## Verification Evidence From This Run

Timestamp: 2026-06-10 18:00 Asia/Kathmandu.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run check:product-truth` | passed | product-scope markers found in README, Electron config, and current readiness status |
| `npm run test:keyboard` | passed | 3 files / 52 tests |
| `npm run test:native-scaffold` | passed | 7 files / 22 tests |
| `npm run build:macos` | passed | Swift IMK proof target build complete |
| `npm run build:companion` | passed unsigned dev build | Electron packaged `release/mac-arm64`; signing skipped because no Developer ID identity is installed |
| `npm run typecheck` | passed | TypeScript project build no emit |
| `npm run build` | passed | Vite app and service worker built |
| `npm run benchmark:protected` | passed | 12/12 protected cases preserved, 0 corrupted spans |
| `npm run benchmark:typing-session` | passed | 66 fixtures, 0 failed sessions, duplicate candidate count 0 |
| `npm run bench:perf:smoke` | passed | target miss count 0 |
| `npm run verify` | passed | 34 files / 228 tests, all default gates completed |
| `npm run build:daemon` | passed | `native/daemon/dist/lekh-keyboard-daemon.mjs` produced |
| `npm run build:windows` | blocked-native-environment | Windows TSF DLL requires Windows host with MSVC and Windows SDK; manual commands emitted |

Required to change that decision:

- Windows TSF build/register/type test on Windows.
- macOS IMK/XPC install/type test in real apps.
- Signed Windows installer and Apple Developer ID notarization.
- Traditional physical keymap source-of-truth capture and human validation.
- Private pilot feedback loop.
