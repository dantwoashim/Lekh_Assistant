# Keyboard Performance Report

Generated from `npm run bench:perf` on 2026-05-27.

The benchmark is a local smoke/performance guard. It fails only on gross slowdowns over 10x the gate, but the table below tracks the actual targets used for keyboard readiness.

| Metric | p95 ms | Target | Status |
| --- | ---: | ---: | --- |
| KeyboardEngine warm startup | 0 | 500 | pass |
| KeyboardEngine partial warm timeout | 0 | 50 | pass |
| Romanized keystroke update | 2 | 20 | pass |
| candidate count cap check | 1 | 20 | pass |
| Traditional Unicode suggestion update | 1 | 20 | pass |
| proofread hint update | 0 | 40 | pass |
| dictionary lookup | 4 | 30 | pass |
| memory ranking update | 1 | 10 | pass |
| candidate commit | 1 | 10 | pass |
| native IPC JSON envelope simulation | 0 | 10 | pass |
| 50-token hostile Romanized mixed sentence | 6 | 30 | pass |
| 5KB mixed Preeti paragraph | 75 | 100 | pass |

## Bundle Status

Latest build still shows large lazy engine/data chunks. The first-load app shell is small enough for controlled demo review, but the shared engine and Hunspell chunks need further splitting or compaction before broad public launch.

## Hardening Decisions

- Ranking quality is not penalized by latency.
- Performance is controlled through candidate caps, bounded windows, lazy loading, and benchmark gates.
- Native IPC has a hard keystroke timeout target of 50 ms.
- Native shells must fail open/pass through if the daemon or XPC path misses the timeout.

### Composition work-bound selection (2026-07-18)

The neutral engine contract caps active composition at 128 UTF-16 code units. The reproducible benchmark uses the real `LocalKeyboardEngine.updateComposition` refresh path, including proofread scanning, candidate and trained-model evaluation, and final semantic SHA-256 candidate IDs. It alternates two exact-length Romanized inputs to defeat the refresh cache, performs 100 warm-up updates, then records three 1,000-sample batches for each candidate bound. Each bound runs in an isolated process and requests garbage collection between batches.

Production correctly rejects compositions above 128 before this work. For comparison only, each isolated benchmark process raises the imported contract value before loading the unchanged engine module. This makes 192, 256, and 512 exercise the same implementation as 128 without weakening the checked-in production contract.

| Candidate bound | p50 | p95 | p99 | Maximum | Decision |
| ---: | ---: | ---: | ---: | ---: | --- |
| 128 | 0.303 ms | 0.334 ms | 0.418 ms | 1.067 ms | selected; lowest measured work and more than 11x p99 margin under the 5 ms target |
| 192 | 0.389 ms | 0.425 ms | 0.547 ms | 1.096 ms | unnecessary composition headroom |
| 256 | 0.475 ms | 0.515 ms | 0.777 ms | 1.175 ms | unnecessary composition headroom and higher steady-state work |
| 512 | 0.856 ms | 0.925 ms | 1.321 ms | 1.892 ms | unnecessary headroom and 3.16x the selected p99 |

These figures are from an Apple M4, macOS Darwin 25.2.0 arm64, Node.js 24.14.0, and V8 13.6.233.17. They characterize the exact single-token synthetic workload, not every possible composition or native-host latency. The [machine-readable evidence](evidence/composition-work-bound.json) records the full environment, per-batch results, method, pipeline assertions, and SHA-256 hashes of the measured sources. Reproduce it with:

```sh
npx vite-node scripts/benchmark-composition-work-bound.ts --write
npx vite-node scripts/benchmark-composition-work-bound.ts --check
```

The 128-unit limit is enforced before refresh-cache key construction, model/candidate generation, proofread scans, and candidate-ID hashing. The 16,384-unit general text/output limit remains separate, so an exact-bound composition can still commit with a delimiter.

## Remaining Work

- Measure real TSF and IMK hot path latency on native platforms.
- Measure daemon startup and warm behavior outside the web lab.
- Split large shared engine/data chunks before public launch.
- Add production crash and timeout telemetry that never includes raw typed text.
