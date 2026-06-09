# Prompt 3 Completion Report

Updated: 2026-05-27.

## Summary

The Romanized correctness pass added the hard long-form prose suite, fixed the known hostile tokens and full paragraph, strengthened alias collision behavior, exposed safety state in the UI, refreshed scorecards, and kept public claims conservative.

## Romanized Work

- Added `bench/fixtures/romanized/hostile-heldout/hard-long-prose.jsonl`.
- Added hard tokens for long vowels, diphthongs, `ri`/`ृ`, conjunct-heavy words, and `Bi.Sam. 2083`.
- Added the full stress paragraph as a hostile held-out case.
- Converted the full paragraph to the expected Unicode output under prose mode.
- Kept overlapping cases marked as regression where disjointness detected alias overlap.

## Confidence And Alias Policy

- Collision-heavy name inputs such as `sita`, `ram`, `sharma`, and `neupane` are candidate-gated with `ROMANIZED_ALIAS_COLLISION`.
- Curated phrases/aliases remain stronger than imported/generated aliases.
- Protected spans remain stronger than all conversion candidates.

## Preeti Work

- Selected baseline path now emits `उच्चतम्` for `pRtd\`.
- Terminal `हरु` normalization is boundary-aware and no longer corrupts unrelated words.
- Atom decoder remains in compare mode until broader cutover is proven.

## UI Work

- Preeti and Romanized tools show mode/action/confidence, candidate counts, warning counts, protected spans, proofread hints, and decoder diagnostics.
- Tool panels are lazy-loaded so the first-load bundle is sharply reduced.

## Latest Metrics

- Romanized total fixtures: 6,756, top-1/top-3/top-5/MRR `1.0000`.
- Romanized hard hostile prose: 24 held-out fixtures, top-1/top-3/top-5/MRR `1.0000`.
- Preeti total fixtures: 10,225, exact `1.0000`, CER `0`, WER `0`.
- Protected spans: 12/12 pass.
- Proofread: 9/9 pass.
- Alias collisions: 4,499 total; 4,237 still need review.
- Competitor outputs: pending manual collection.

## Completion Status

Repo-executable conversion correctness work is complete against current locked fixtures and hostile suites. Human-data, competitor, and native keyboard work remain separate gates.
