# Keyboard Corpus Annotation Guide v0.1

## Quality Labels

- `gold`: human/project-reviewed, license-safe, PII-safe, conversion target verified.
- `silver`: open or derived row with strong automated checks; needs spot review before public accuracy claims.
- `bronze`: public/social row after automated screening; needs privacy/license/conversion review.
- `synthetic`: generated coverage/stress row; useful for robustness, not frequency evidence.
- `blind`: frozen holdout row. Never train or tune on this split.

## Required Reviewer Decisions

- Conversion target: definite Unicode, multiple candidates, preserve, preference, unknown.
- Token policy: convert, preserve, candidate, preference, warn.
- Domain: casual, government, education, health, tech, legal, office, names, general.
- Privacy: no names tied to real examples, no phones, no emails, no handles, no addresses, no private text.
- License: reusable, runtime-eligible, pattern-only, quote-only, not reusable.

## Promotion Rule

Rows may move to GOLD only after license, privacy, normalization, dedupe, and conversion review are all marked pass.
