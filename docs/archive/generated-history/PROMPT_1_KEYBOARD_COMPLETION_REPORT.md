# Prompt 1 Keyboard Completion Report

Generated: 2026-05-27

## 1. Executive Summary

Prompt 1 established the keyboard-first foundation without replacing the existing converter engine. The repository now has a typed `KeyboardEngine` API, session lifecycle, key-event and browser composition paths, UTF-16 range helpers, bounded candidate updates, warm/partial startup behavior, typing-session benchmarks, a browser Keyboard Lab, Traditional layout audit scaffolding, native feasibility specs, onboarding defaults, and fresh scorecard integration.

Intentionally not implemented in Prompt 1:

- production Windows TSF input method
- production macOS InputMethodKit input method
- final Traditional keymap conversion
- Rust port
- monorepo restructuring
- full companion app shell
- new unsafe dictionary or meaning data

The repo is ready for Prompt 2 keyboard intelligence work: live Romanized typing improvements, Traditional implementation after layout audit, helper suggestions, dictionary/memory integration, and stronger ranking.

## 2. Scope Freeze

Core product:

- Windows/macOS Nepali keyboard
- Romanized typing
- Traditional typing
- live suggestions
- proofread while typing
- dictionary while typing
- local correction memory
- local-first privacy
- companion app

Side utility:

- Preeti to Unicode converter
- legacy font/document conversion tools

Deferred:

- advanced mixed-document repair beyond the existing engine path
- cloud sync
- account system
- mobile keyboard
- voice input
- OCR
- rewriting features
- enterprise dashboard
- production native IME implementation in Prompt 1

The documented rule is: the keyboard roadmap must not be blocked by advanced Preeti document repair. The keyboard engine prioritizes live Romanized and Traditional typing.

## 3. Traditional Layout Audit

Created:

- `docs/TRADITIONAL_LAYOUT_SOURCE_OF_TRUTH_AUDIT.md`
- `data/layouts/traditional-ltk-compatible.pending.json`
- `data/layouts/traditional-standard.pending.json`
- `bench/fixtures/traditional-layout/layout-audit.pending.jsonl`

Pending human/manual research:

- capture normal, Shift, AltGr/Option, and relevant modifier states from the current LTK online typing tool
- cross-reference against a verified Nepali Unicode keyboard standard
- classify differences as LTK-compatible, standard-compatible, LTK-specific, or unresolved
- decide the MVP default layout

Implementation status: final Traditional keymap conversion remains pending by design. Prompt 1 exposes a safe Traditional placeholder and warning instead of inventing unverified mappings.

## 4. KeyboardEngine API

Added `src/engine/keyboard/*` with:

- `KeyboardEngine`
- required `processKeyStroke`
- `KeyboardKeyEvent`
- `TypingContext`
- `CandidateUpdate`
- `CommitResult`
- `WarmResult`
- `Candidate`
- `ProofHint`
- `DictionaryResult`

Implemented methods:

- `beginSession`
- `updateComposition`
- `processKeyStroke`
- `commitCandidate`
- `commitRaw`
- `cancelComposition`
- `endSession`
- `getSuggestions`
- `getProofHints`
- `lookupDictionary`
- `learnCorrection`
- `setMode`
- `setLayout`
- `warm`
- `shutdown`

Semantics documented:

- `compositionText` is the raw active buffer.
- `displayText` is the Unicode preview intended for marked/composition display.
- `consumedRange` clears composition-buffer text.
- `replacementRange` replaces already committed surrounding context.
- native boundary offsets use UTF-16 code units.
- warm can return full or partial readiness with loaded/unavailable module lists.

## 5. Session Lifecycle

Implemented in `src/engine/keyboard/session.ts` and `src/engine/keyboard/index.ts`.

Covered behavior:

- begin/update/process/commit/cancel/end
- mode switch
- layout switch
- multiple concurrent sessions
- unknown session safe errors
- secure/password/code contexts reduce suggestions and disable memory recording
- shutdown clears active state

## 6. Browser/Web-Lab Simulator

Added:

- `src/features/keyboard/KeyboardLab.tsx`
- `src/features/keyboard/KeyboardSessionDebug.tsx`
- Keyboard Lab tab in `src/app/App.tsx`
- responsive styles in `src/styles/globals.css`
- smoke coverage in `src/tests/app-smoke.test.tsx`

How to test:

1. Run the app.
2. Open the `Keyboard Lab` tab.
3. Type Romanized input and inspect composition, display preview, candidates, proof hints, warnings, and latency.
4. Switch to Traditional mode and confirm the pending-layout warning is visible.

## 7. Typing Benchmark

Added:

- `bench/fixtures/typing-session/romanized-basic.jsonl`
- `bench/fixtures/typing-session/romanized-government.jsonl`
- `bench/fixtures/typing-session/traditional-placeholder.jsonl`
- `scripts/benchmark-typing-session.ts`
- package script `benchmark:typing-session`

Latest report:

- fixture count: 11
- Romanized sessions: 9
- Traditional placeholder sessions: 2
- Romanized top-1 hit rate: 1.0000
- Romanized top-3 hit rate: 1.0000
- failed sessions: 0
- candidate p50: 2 ms
- candidate p95: 3 ms
- update p95: 3 ms
- commit p95: 0 ms
- mean KSR baseline: 0.0840

KSR is documented as `1 - (keystrokes_to_commit / committed_Devanagari_character_count)`. Prompt 1 records baseline behavior only; Prompt 2 should improve real keystroke savings with stronger live suggestions.

## 8. Native Feasibility Docs

Created:

- `docs/WINDOWS_TSF_FEASIBILITY_SPIKE.md`
- `docs/MACOS_IMK_FEASIBILITY_SPIKE.md`
- `docs/NATIVE_DAEMON_LIFECYCLE.md`
- `docs/NATIVE_IPC_CONTRACT.md`

Windows path:

- TSF DLL receives key events and talks to `lekh-imed.exe`
- daemon starts through installer login task or companion-managed background process
- named pipe preferred
- length-prefixed CBOR preferred for production, JSON allowed for debug
- strict IPC timeouts
- fail open/pass-through if unavailable

macOS path:

- InputMethodKit bundle receives input
- XPC service hosts or bridges to engine
- pass-through on unavailable XPC/daemon
- marked text and candidate UI are feasibility gates

## 9. Onboarding Defaults

Created `docs/FIRST_RUN_ONBOARDING_DEFAULTS.md`.

Defaults:

- first launch asks Romanized, Traditional, or Both
- skipped setup defaults to Romanized
- LTK migration flow defaults to Traditional/LTK-compatible after audited layout exists
- proofread is conservative
- local memory is on with clear reset/export controls
- telemetry/network is off/none
- dictionary meanings disabled unless safe data exists
- high-confidence Space auto-commit only
- secure/password fields disable suggestions and memory

## 10. Verification Status

Final verification loop results:

| Command | Status |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm run test` | Pass |
| `npm run build` | Pass |
| `npm run check:privacy` | Pass |
| `npm run check:engine-local` | Pass |
| `npm run check:engine-no-dom` | Pass |
| `npm run check:user-data` | Pass |
| `npm run check:benchmark-disjointness` | Pass |
| `npm run audit:preeti-source` | Pass |
| `npm run benchmark:protected` | Pass |
| `npm run benchmark:preeti` | Pass |
| `npm run benchmark:preeti:fuzz` | Pass |
| `npm run benchmark:preeti:roundtrip` | Pass |
| `npm run benchmark:romanized` | Pass |
| `npm run benchmark:romanized:self` | Pass |
| `npm run benchmark:proofread` | Pass |
| `npm run benchmark:competitor` | Pass |
| `npm run benchmark:typing-session` | Pass |
| `npm run benchmark` | Pass |
| `npm run bench:perf` | Pass |
| `npm run scorecard:engine` | Pass |
| `npm run verify` | Pass |
| `npm audit --audit-level=moderate` | Pass, 0 vulnerabilities |

Notes:

- `romanized-held-out` remains marked contaminated by the disjointness report and is excluded from public proof.
- competitor collection remains pending manual collection, so market comparison claims stay blocked.
- the production bundle still has large engine/data and Hunspell chunks; this is documented in performance notes for follow-up optimization.

## 11. Remaining Work for Prompt 2

- Romanized live typing intelligence
- Romanized-to-Romanized helper suggestions
- Traditional layout engine after source-of-truth audit
- Traditional suggestions/proofread
- candidate ranking improvements
- dictionary integration with safe data only
- local correction memory integration in keyboard sessions
- higher KSR on government/office vocabulary

## 12. Remaining Work for Prompt 3

- native TSF feasibility skeleton
- native IMK feasibility skeleton
- daemon/IPC implementation
- companion app shell
- native performance hardening
- installer/signing/notarization docs
- final release scorecards
- keyboard readiness gate

