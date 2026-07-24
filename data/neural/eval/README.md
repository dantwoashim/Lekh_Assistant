# Lekh Neural Evaluation Protocol

This directory defines the locked, token-only evaluation contract for the open-vocabulary neural tail. It contains no private raw review data and makes no native-speaker or human-adjudication claim.

## Required gold suites

The production model must be evaluated against these logical suites:

| Suite | Locked path | Assertions | Purpose |
| --- | --- | ---: | --- |
| Romanized token gold | `data/neural/gold/romanized-nepali-token-gold.v1.jsonl` | 11 | General Romanized token to Devanagari token accuracy |
| Chat convention gold | `data/neural/gold/chat-convention-token-only-gold.v2.jsonl` | 7 | `xa`, `xaina`, vowel length, casual spellings |
| Names gold | `data/neural/gold/names-gold.v1.jsonl` | 6 | Person/place/organization names and accepted variants |
| Ambiguity gold | `data/neural/gold/ambiguity-gold.v1.jsonl` | 5 | Multiple acceptable outputs and ranking behavior |
| Non-Nepali pass-through gold | `data/neural/gold/non-nepali-pass-through-gold.v1.jsonl` | 6 | English/code/protected text that must not be converted |
| Protected token gold | `data/neural/gold/protected-token-gold.v1.jsonl` | 6 | URLs, emails, handles, versions, paths, product tokens |
| Adversarial safety gold | `data/neural/gold/adversarial-neural-tail-gold.v1.jsonl` | 6 | Phrase expansion, mixed script, whitespace, unsafe output |

The corpus has 47 suite assertions and 42 distinct normalized inputs. This is a
small, content-addressed regression and safety corpus; every report and release
note must state that limitation. Optional future reviewed corpora may strengthen
later releases, but unavailable data is not a release gate.

## Gold row schema

The authoritative schema is:

```txt
data/neural/schema/lekh-neural-gold-row-v2.schema.json
```

Each JSONL row must use this shape:

```json
{
  "id": "gold_chat_000001",
  "input": "xaina",
  "expectedAction": "produce-candidate",
  "expected": ["छैन"],
  "acceptable": ["छैन", "छैन्"],
  "forbiddenOutputs": ["छैन होला"],
  "previousContext": [],
  "category": "chat-convention",
  "source": "lekh-phase1-contract-seed-v1",
  "reviewTier": "contract-seed",
  "reviewer": "lekh-internal-seed",
  "license": "project-internal-contract-seed",
  "split": "test",
  "notes": "Common chat spelling for chaina/chhaina/xaina."
}
```

Rules:

- `input` is a single active Romanized token.
- `expectedAction` is `produce-candidate` or `no-neural-candidate`.
- `expected` contains the preferred output(s).
- `acceptable` contains every output that should count as correct.
- `forbiddenOutputs` contains unsafe outputs that must never be emitted.
- `previousContext` must be empty. This model and runtime are token-only.
- `split` must be one of `train`, `dev`, or `test`.
- Evaluation metrics use **suite assertions** as their unit: every gold row is
  one assertion for its suite, including a compatible assertion repeated in a
  second suite. Reports expose `metricUnit: "suite-assertion"`,
  `suiteAssertionCount`, and `distinctInputCount`; the assertion count
  must not be described as a count of unique inputs.
- A normalized input may repeat in different suites only in the same split,
  with identical `expectedAction` and normalized acceptable-output set.
  Categories and `forbiddenOutputs` remain
  suite-specific and may differ or add stricter forbidden-output supersets.
- Predictions for compatible repeated assertions must contain the exact same
  candidates in the exact same order for every row ID. This preserves exact
  per-ID coverage without allowing suite-aware prediction gaming.
- A same-suite duplicate or any repeated-input conflict in split, action, or
  acceptable targets makes aggregate metrics unreportable.
- A normalized input must not appear across multiple splits, even with a
  different output.
- A normalized input-output pair must not appear across multiple splits.
- Personal/private user text must not be included.
- Required held-out cases must remain test-only. Training scripts may not copy,
  oversample, or probe their expected answers during fitting or dev selection.
- Tokenizer vocabularies must be frozen independently or built from train only;
  dev/test labels cannot influence them.

For protected and pass-through rows, use:

```json
{
  "expectedAction": "no-neural-candidate",
  "expected": [],
  "acceptable": []
}
```

## Required metrics

The production manifest must be backed by an evaluation report proving:

| Metric | Minimum |
| --- | ---: |
| Tail token top-1 acceptable accuracy | 0.88 |
| Tail token top-3 acceptable accuracy | 0.96 |
| Chat convention top-1 accuracy | 0.92 |
| Chat convention top-3 accuracy | 0.98 |
| Names top-3 accuracy | 0.90 |
| Protected false-conversion rate | 0 |
| Single-token phrase expansion rate | 0 |
| Forbidden candidate rate | 0 |
| Adversarial forbidden candidate rate | 0 |
| Secure-field inference count | 0 |

Promotion metrics use only the frozen `test` split. Train, dev, and all-row
metrics are diagnostic and cannot be substituted for test results. Report
token-weighted and type-weighted metrics separately; a single aggregate score
is not enough. Secure-field inference is proved by the packaged/native runtime
evidence, never inferred or hard-coded by the prediction evaluator.

## Required failure buckets

Every evaluation report must include counts and examples for:

- `ba` / `va` ambiguity;
- `cha` / `chha` / `xa` ambiguity;
- vowel length;
- Sanskrit clusters such as `ksha`, `gya`, `tra`;
- names;
- code-mixed English;
- over-normalization;
- under-generation;
- unsafe whitespace or phrase output;
- protected-token conversion.

## Required reports

The final manifest must reference:

```txt
reports/neural-open-vocab-dataset-report.json
reports/neural-open-vocab-evaluation.json
reports/neural-coreml-device-benchmark.json
```

Those reports must be reproducible from committed scripts and exact
content-addressed inputs. Raw upstream or user data must not be committed.

## Phase 1 foundation proof

The committed foundation suites are:

```txt
data/neural/gold/manifest.v3.json
data/neural/gold/romanized-nepali-token-gold.v1.jsonl
data/neural/gold/chat-convention-token-only-gold.v2.jsonl
data/neural/gold/names-gold.v1.jsonl
data/neural/gold/ambiguity-gold.v1.jsonl
data/neural/gold/non-nepali-pass-through-gold.v1.jsonl
data/neural/gold/protected-token-gold.v1.jsonl
data/neural/gold/adversarial-neural-tail-gold.v1.jsonl
```

Run the foundation validator:

```bash
npm run check:neural-gold
```

This command verifies:

- every suite exists;
- every row has the required schema fields;
- all text is NFC-normalized;
- active inputs are single tokens;
- token outputs contain no whitespace;
- protected/pass-through rows expect no neural candidate;
- forbidden outputs do not overlap acceptable outputs;
- required cases are present;
- normalized inputs and input/output pairs do not leak across train/dev/test
  splits.

Production validation re-runs the exact locked-corpus, leakage, normalization,
and safety checks:

```bash
npm run check:neural-gold:production
```

It does not invent a larger corpus or claim human review. The 47-row limitation
must remain visible in evaluation reports and release documentation.

## Phase 2 cleaned training/evaluation data

The cleaned open-vocabulary dataset is generated by:

```bash
npm run neural:source:syubraj
npm run check:neural-open-vocab-data
```

Outputs:

```txt
data/generated/neural-open-vocab/manifest.json
data/generated/neural-open-vocab/train.jsonl
data/generated/neural-open-vocab/dev.jsonl
data/generated/neural-open-vocab/test.jsonl
reports/neural-open-vocab-dataset-report.json
```

The source registry is:

```txt
data/neural/sources.v1.json
```

The cleaned row schema is:

```txt
data/neural/schema/lekh-neural-open-vocab-row.schema.json
```

The generated schema-v2 manifest binds each split's row count, bytes, and
SHA-256, plus the exact builder, registry, row schema, locked gold release,
private import snapshots, and legacy inputs. Its canonical
`datasetContentSha256` excludes only the volatile generation timestamp. Model
evidence must bind this stable digest; a full manifest-file hash alone is not a
reproducible dataset identity.

This dataset is allowed to include contract seeds and local silver rows. It is not production data until:

```bash
npm run check:neural-open-vocab-data:production
```

passes.

## Required safety cases

The evaluation must include and pass:

```txt
vato -> बाटो
bato -> बाटो
baato -> बाटो
chha -> छ
cha -> छ
xa -> छ
xaina -> छैन
```

The model must reject or return no candidate for single-token outputs that contain whitespace.

## Secure-field policy

Secure-field tests must prove:

- no neural request is created;
- no Core ML prediction is called;
- no candidates are returned;
- no logs contain typed content;
- no memory/persistence writes occur.
