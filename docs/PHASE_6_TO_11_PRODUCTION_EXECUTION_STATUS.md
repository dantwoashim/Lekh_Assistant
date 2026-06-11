# Phase 6-11 Production Execution Status

Generated: 2026-06-10

Source of truth: user-provided phase plan covering Phase 6 Personal Memory, Phase 7 Proofread & Dictionary, Phase 8 Companion App, Phase 9 Traditional Keyboard, Phase 10 Daemon & IPC, and Phase 11 Installers & Signing.

## Executive Decision

The repo-executable Phase 6-11 work has been tightened and verified where the current macOS environment can run it. The project is stronger for private native validation, but it is still not a public production launch because three hard gates remain outside this repo session:

- Windows TSF must be built, registered, and tested on a Windows host.
- Traditional physical layout must be validated by experienced Traditional typists from a source-of-truth capture.
- Public Windows/macOS releases require signing/notarization credentials and fresh-machine installer tests.

## Phase 6 - Personal Memory

Status: implemented for engine/lab/native storage path; native pilot controls still need real-user validation.

Implemented:

- Local correction memory already affects ranking through the KeyboardEngine.
- Secure contexts disable memory queries and writes.
- Native JSON file storage persists settings, personal dictionary, and correction memory.
- Companion settings now include `pauseLearning` and `excludedMemoryApps`.
- Companion settings normalize unsafe patches, keep telemetry disabled, support export/import, and map into engine `TypingContext`.
- Companion UI exposes learning paused/excluded-app status.

Evidence:

- `src/features/companion/settings.test.ts`
- `native/shared/storage/jsonFileStores.test.ts`
- `src/engine/keyboard/storage.test.ts`
- `npm run test:native-scaffold` passes with daemon/storage coverage
- `npm run test`
- `npm run verify`

Not allowed:

- Learning secure-field text.
- Learning IDs, emails, URLs, or protected tokens.
- Hidden telemetry.

## Phase 7 - Proofread And Dictionary

Status: implemented for current curated/rule data, with licensed meanings still intentionally absent.

Implemented:

- Proofread hints cover high-confidence spelling, postposition, normalization, matra/halanta-style corrections, and common typo variants.
- Dictionary lookup supports Romanized and Unicode lookup, canonical spelling, aliases, variants, domain tags, and personal entries.
- Unknown dictionary queries return safe empty results.
- No fake dictionary meanings are generated.

Evidence:

- `npm run benchmark:proofread`
- `npm run benchmark:dictionary`
- `npm run verify`

Known boundary:

- Full dictionary meanings require a safe licensed source. Until then, dictionary results must not invent meanings.

## Phase 8 - Companion App

Status: unsigned development companion builds and packages; not the IME.

Implemented:

- Companion shell states clearly that it is not the keyboard.
- Pages/status areas exist for home/status, mode settings, Romanized preferences, Traditional settings, layout preview, candidate behavior, proofread, dictionary, memory, privacy, diagnostics, Preeti side utility, import/export, updates/about.
- Settings can be exported/imported and converted to engine typing context.
- Privacy controls show local-first behavior, telemetry-off defaults, secure input, consent controls, redacted diagnostics, and data deletion.
- Native status remains accurate: Windows and macOS are blocked until platform validation.

Evidence:

- `npm run test:companion`
- `npm run build:companion`
- `npm run package:macos:unsigned`
- `npm run check:product-truth`

Not claimed:

- The companion app is not the keyboard.
- The Electron shell is not the keyboard.

## Phase 9 - Traditional Keyboard

Status: Traditional Unicode suggestions/proofread are available; physical Traditional keyboard remains blocked-human.

Implemented:

- Pending layout audit framework, capture template, and validator exist.
- Normal audit gate passes in pending mode.
- Final audit gate fails honestly until verified layout JSON files exist.
- Traditional Unicode suggestions/proofread remain available for already-Unicode input.
- Companion status marks Traditional layout as blocked-human.

Evidence:

- `npm run audit:traditional-layout`
- `npm run audit:traditional-layout:final` exits 1 with explicit missing `traditional-ltk-compatible.json` and `traditional-standard.json`
- `npm run benchmark:typing-session`

Required before completion:

- Capture base, Shift, AltGr/Option, Shift+AltGr, punctuation, digits, matras, halanta, and conjunct behavior.
- Validate with at least 3 experienced Traditional typists.
- Generate final layout JSON, engine keymap, preview UI, fixtures, and sign-off table.

Not allowed:

- No fake Traditional physical mapping.
- No claim that Traditional physical keyboard is complete before human validation.

## Phase 10 - Daemon And IPC

Status: dev daemon/IPC works, schema validates, payload limits exist, and hot-path fallback is now enforced in daemon dispatch.

Implemented:

- IPC methods cover health, warm, session lifecycle, processKeyStroke, updateComposition, commitCandidate, commitRaw, cancel, end, setMode, setLayout, suggestions, proof hints, dictionary, memory learn, diagnostics, and shutdown.
- JSONL daemon rejects malformed and oversized messages safely.
- Windows named-pipe server is per-user-name based and enforces payload limits/socket idle timeout.
- Daemon metrics expose uptime, active sessions, warm status, last error, processed keystrokes, IPC timeouts, pass-through fallbacks, and committed candidates.
- Native hot-path daemon dispatch wraps keystroke, composition update, candidate commit, and raw commit with a 50 ms pass-through fallback.
- Windows TSF source now uses per-focus session IDs instead of a constant dev session.

Evidence:

- `npm run check:ipc-schema`
- `npm run test:native-scaffold` passes with 7 files / 24 tests
- `npm run build:daemon`
- `npm run bench:perf:smoke`

Native survival rule:

- The native keyboard must fail open. If daemon/IPC is unavailable or slow, the host app receives pass-through behavior rather than freezing.

## Phase 11 - Installers And Signing

Status: unsigned macOS companion package and unsigned macOS IMK development input-method package work; public signed installers remain blocked-external/native-environment.

Implemented:

- Companion build path packages an unsigned macOS app on this machine.
- macOS IMK development input-method app builds, packages, installs to `~/Library/Input Methods`, registers, enables, and launch-smokes without auto-selecting globally.
- macOS IMK development bundle includes `runtime-suggestions.json` so the native proof path loads real local word, phrase, and name suggestions instead of a tiny hardcoded demo list.
- Windows installer scripts, NSIS include, TSF registration scripts, and release artifact checks exist.
- Installer-flow and third-party-notice gates pass.
- Windows build/package commands block honestly on macOS and emit manual Windows commands.
- Current readiness docs do not claim signed or notarized release readiness.

Evidence:

- `npm run build:companion`
- `npm run package:macos:unsigned` passes and produces `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/Lekh Keyboard Companion.app`
- `npm run package:macos:imk:dev` passes and produces `/Users/rohanbasnet14/Documents/Romanized-Nepali-Keyboard/release/native/macos/Lekh Keyboard.app`
- `native/macos-imk/skeleton/install-dev.sh` registers and enables `com.lekh.inputmethod.keyboard` without selecting it for daily typing.
- `npm run check:macos-imk-bundle` verifies the packaged native runtime suggestions pack.
- `npm run check:macos-imk-install` passes against the installed input method
- `npm run check:installer-flow`
- `npm run check:third-party-notices`
- `npm run build:windows` returns `blocked-native-environment` on darwin-arm64 with required Windows commands.
- `npm run package:windows:unsigned` returns `blocked-native-environment` on darwin-arm64 with required Windows release-machine commands.

Required before public launch:

- Windows unsigned dev build on Windows.
- Windows signed private pilot build with Authenticode certificate.
- Windows fresh VM install/type/uninstall smoke.
- macOS IMK host-app typing matrix across TextEdit, Safari, Chrome, Pages, VS Code, and secure fields.
- macOS Developer ID signing, notarization, hardened runtime, stapled ticket.
- macOS fresh machine install/type/uninstall smoke.

## Final Phase 6-11 Recommendation

Current recommendation remains:

`NOT_READY_BLOCKED_BY_EXTERNAL_NATIVE_REQUIREMENTS`

The repo is ready for the next real platform validation pass, not for public launch.

## Verification Evidence From This Run

Timestamp: 2026-06-10 18:11 Asia/Kathmandu.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | passed | TypeScript project build no emit |
| `npm run test` | passed | 35 files / 233 tests |
| `npm run test:native-scaffold` | passed | 7 files / 25 tests |
| `npm run test:companion` | passed | 1 file / 15 tests |
| `npm run build` | passed | Vite app and service worker built |
| `npm run build:daemon` | passed | daemon bundle generated |
| `npm run build:macos` | passed | Swift IMK proof target builds |
| `npm run package:macos:imk:dev` | passed | unsigned IMK development input method produced |
| `native/macos-imk/skeleton/install-dev.sh` | passed | installed, registered, and enabled macOS input source without auto-selecting |
| `npm run check:macos-imk-install` | passed | installed IMK bundle is discoverable and launch-smoked |
| `npm run build:companion` | passed unsigned dev build | Electron companion packaged for local dev |
| `npm run package:macos:unsigned` | passed | unsigned companion app produced |
| `npm run package:windows:unsigned` | blocked-native-environment | requires Windows release machine; manual commands emitted |
| `npm run audit:traditional-layout:final` | blocked-human, expected | missing verified layout JSON files |
| `npm run verify` | passed | default verification completed end to end |
