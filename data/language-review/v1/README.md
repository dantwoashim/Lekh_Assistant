# Human Language and Accessibility Review

This directory is the intake point for review artifacts that cannot be manufactured by implementation work.

Production requires the eight domains in `config/human-authority-policy.v1.json`: Traditional layout, Romanized aliases, ambiguous Romanization, corrections and proofread behavior, dictionary meanings, names, code-mixed behavior, and accessible language.

Generated, synthetic, auto-reviewed, and `project-curation` labels are candidate-data states. They are not human approval.

The final approval must be stored at `human-authority-approval.json` and bind the exact SHA-256 of every required artifact. At minimum, each domain needs a named internal product owner and two named external reviewers. Traditional layout additionally needs two experienced Traditional typists. Accessible language needs an accessibility reviewer. Reviewers may satisfy more than one role only when their recorded experience supports each role.

Do not place private user text, unconsented names, contact details, credentials, or other personal data in these files. Use consented or synthetic examples for names and code-mixed cases.

Current missing review artifacts are intentional blockers, not empty files to fill with guessed content:

- `accessibility-language.jsonl`
- `ambiguous-romanization.jsonl`
- `dictionary-meanings.jsonl`

Traditional layout remains governed by `docs/TRADITIONAL_LAYOUT_SOURCE_OF_TRUTH_AUDIT.md` and must use the final audited layout files, not the pending scaffolds.
