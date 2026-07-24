# Phase 7 Human Review Intake

Phase 7 defines how real reviewed rows enter the neural training and evaluation pipeline without committing private raw data.

Use the template:

```bash
mkdir -p data/private/neural/review-sources
cp data/neural/review/private-source-manifest.example.json data/private/neural/review-sources/manifest.json
```

Then add private JSONL files listed by that manifest. Each row must validate against:

```txt
data/neural/schema/lekh-neural-gold-row-v2.schema.json
```

Required production sources:

- `human-reviewed-lekh-gold-v1`
- `lekh-chat-conventions-v1`
- `lekh-name-lexicon-v1`

The proof command is:

```bash
npm run neural:phase7:review-intake
```

Production proof is:

```bash
node scripts/check-neural-review-intake.mjs --production
```

The production command must fail until the private reviewed row files exist and satisfy their source-specific counts, categories, review tiers, and licenses.
