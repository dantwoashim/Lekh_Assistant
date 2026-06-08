# Keyboard Corpus Build Report

Generated: 2026-06-08T06:52:18.359Z

## Counts

| Dataset | Target | Built | Status |
| --- | ---: | ---: | --- |
| wordAliases | 1,000,000 | 1,000,000 | met |
| phraseAliases | 100,000 | 100,000 | met |
| casualSentences | 250,000 | 250,000 | met |
| mixedSentences | 250,000 | 250,000 | met |
| proofreadPairs | 100,000 | 100,000 | met |
| nameVariants | 50,000 | 50,000 | met |
| nextWordContexts | 1,000,000 | 1,000,000 | met |
| blindTest | 100,000 | 100,000 | met |

## Review Tiers

- `auto-reviewed-open-license`: Machine-filtered open dataset row. Not human-reviewed.
- `auto-reviewed-token-aligned`: Phrase generated from high-confidence token aliases. Not human-reviewed.
- `pii-screened-open-social`: Public/social row with automated PII and quality filters. Not human-reviewed.
- `synthetic-silver`: Generated from reviewed rules/templates for coverage and stress testing. Needs human promotion before gold use.
- `project-internal-seed`: Project-curated seed data; useful for bootstrapping but not frequency evidence.

## Source Safety

- Public/social rows are PII-screened automatically but still require human privacy review before redistribution.
- Synthetic silver rows are coverage data, not real user-frequency evidence.
- Human review must promote rows to gold before using them for public 99%+ claims.

