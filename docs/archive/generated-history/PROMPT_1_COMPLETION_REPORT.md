# Prompt 1 Completion Report

Reconstructed from current repository state after one-shot completion.

## Summary

The safety foundation is present and verified: `src/engine` exposes stable conversion wrappers, protected spans are enforced, classification exists, local/no-DOM checks exist, UI paths route through the engine, and benchmark/scorecard scripts now fail visibly instead of silently passing empty suites.

## Preserved Infrastructure

- Engine facade and `ConversionResult` contract.
- Protected span detectors and sentinel restoration path.
- Classifier, proofread, memory, and legacy modules.
- Existing Preeti and Romanized core converters.
- Existing UI components, now routed through engine wrappers.
- Benchmark and report structure under `bench/`.

## Targeted Fix Status

| Fix | Status |
| --- | --- |
| Preeti `pRtd\` / `उच्चतम्` | Fixed and tested. |
| Preeti terminal `?` / `हरू` boundary | Fixed with boundary-aware normalization. |
| Romanized `ri` / `ृ` hard words | Covered by hostile prose fixtures and converter overrides. |
| Romanized conjunct stress words | Covered by hard token and paragraph fixtures. |
| Mode-aware digit conversion | `Bi.Sam. 2083` converts to `वि.सं. २०८३`; protected IDs remain preserved. |
| Hunspell reverse-alias reporting | Alias factory/collision reports are generated and gated. |

## Verification Truth

- Vitest workers are bounded.
- `npm run test` exits cleanly.
- `npm run verify` runs typecheck, tests, build, privacy/offline/runtime/user-data gates, disjointness, benchmarks, perf, scorecard, and engine checks.
- Benchmark disjointness reports contaminated suites and excludes them from public proof.
- Scorecards are regenerated from current reports.

## UI Routing

User-facing Preeti and Romanized tools consume `ConversionResult` from `src/engine` paths. Remaining direct core converter imports are kept inside engine/core compatibility layers, not user-facing components.

## Public Claims

Allowed claims remain limited to local-first prototype, mixed-document protected-span support, benchmark-driven engine architecture, and engine-under-validation language.

## Ready For Prompt 2

Yes. The repository has a truthful safety and verification base for deterministic Preeti work.
