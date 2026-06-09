# Prompt 2 Completion Report

Reconstructed from current repository state after one-shot completion.

## Summary

The deterministic Preeti layer exists beside the baseline converter. The baseline remains the selected safe path by default, while the atom decoder, tokenizer, assembler, verifier, profile diagnostics, source-audit fixtures, fuzz fixtures, and roundtrip oracle run as verification pressure.

## Prompt 1 Preservation

- Engine facade preserved.
- Protected spans still pass.
- UI routing through `src/engine` preserved.
- Benchmark and scorecard scripts remain non-empty and fresh.

## Source-Text Audit

`npm run audit:preeti-source` checks 12 manual hard cases:

- 11 conversion-scored fixtures.
- 1 proofread/style fixture.
- 3 historical converter-bug cases now match expected output.
- 0 source-text typo or expected-output bug cases currently active.

## Legacy Profile And Decoder

- Semantic Preeti profile structures and diagnostics exist.
- Kantipur/Sagarmatha/Himali remain planned or diagnostic-only unless legal reviewed maps are added.
- Atom decoder runs in compare mode and is verifier-gated.
- Baseline fallback remains available.

## Oracle/Fuzz

- `benchmark:preeti:fuzz`: 26 fixtures, legal exact `1.0000`, illegal safety `1.0000`.
- `benchmark:preeti:roundtrip`: 15 fixtures, exact `1.0000`.
- Generated/oracle suites are treated as regression pressure, not real-document market proof.

## Benchmarks

Current `benchmark:preeti`:

- 10,225 fixtures.
- Manual/generated/held-out/competitor buckets exact `1.0000`.
- CER `0`, WER `0`.
- Protected English and line breaks preserved in current fixtures.

## Ready For Prompt 3

Yes. The Preeti correctness layer is verifier-gated and the baseline path is fixed for the hard selected-path bugs without deleting fallback behavior.
