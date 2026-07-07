# Lekh Open-Vocabulary Neural Transliterator Production Contract

Status: Phase 0 frozen contract.

This document defines the only neural model that may be called production for the macOS Lekh input method. It is intentionally stricter than the old closed-vocabulary Core ML baseline. A model that fails any item here must remain a research artifact and must not be packaged, advertised, or invoked by the native IMK hot path.

## 1. Artifact identity

The production neural artifact is:

```txt
models/macos/LekhNeuralTransliterator.mlmodelc
```

The production manifest is:

```txt
models/macos/LekhNeuralTransliterator.manifest.json
```

The manifest must validate against:

```txt
data/neural/schema/lekh-neural-manifest.schema.json
```

The production artifact identifier is fixed:

```txt
lekh-open-vocab-seq2seq-v1
```

The rejected closed-vocabulary baseline under `models/rejected/closed-vocabulary-baseline/` is not eligible for this contract.

## 2. Product role

The neural model is a tail candidate generator for hard Romanized-to-Nepali token cases. It is not the keyboard engine.

Allowed role:

- run after deterministic FST, dictionary, binary lexicon, context rows, and user memory have produced first paint;
- add token-level Devanagari candidates when deterministic candidates are weak, sparse, or missing;
- improve chat conventions, rare spellings, names, and ambiguity coverage;
- run locally through Core ML only.

Forbidden role:

- no first-paint dependency;
- no network inference;
- no synchronous dependency in the per-keystroke deterministic path;
- no auto-commit authority;
- no phrase expansion for a single active token;
- no inference in secure fields;
- no raw text telemetry, OSLog payloads, filenames, crash annotations, or diagnostics.

## 3. Supported mode for v1

Version 1 supports only:

```txt
romanized-traditional
```

That means Romanized source token to Devanagari candidate token.

The v1 model must not be used for:

- Romanized-to-Romanized;
- Traditional-to-Nepali physical key composition;
- Traditional-to-Romanized reverse romanization;
- phrase or sentence generation.

## 4. Runtime input contract

The neural tail request may contain:

```json
{
  "schemaVersion": 1,
  "generation": 42,
  "mode": "romanized-traditional",
  "rawToken": "xaina",
  "previousContextTokens": ["malai"],
  "deterministicCandidateCount": 1,
  "deterministicTopConfidence": 0.62
}
```

Constraints:

- `rawToken` is the active token only, not the document;
- `previousContextTokens` contains at most two already committed tokens and is kept in memory only;
- the request is never created while Secure Event Input is active;
- the request is cancelled or ignored when a new generation starts;
- the request is never persisted.

## 5. Runtime output contract

The neural tail output must be:

```json
{
  "schemaVersion": 1,
  "generation": 42,
  "candidates": [
    {
      "text": "छैन",
      "probability": 0.91,
      "source": "neural",
      "spanKind": "token",
      "autoCommitEligible": false
    }
  ]
}
```

Output constraints:

- candidate text must be NFC-normalized Devanagari;
- candidate text must contain no whitespace;
- candidate text must not contain Latin text;
- `spanKind` must be `token`;
- `autoCommitEligible` must always be `false`;
- maximum candidate count is 8;
- stale generations must be ignored.

## 6. Required model family

The model must be open-vocabulary.

Accepted architecture families:

- GRU encoder-decoder seq2seq;
- tiny Transformer encoder-decoder;
- other Core ML compatible seq2seq decoder approved by the manifest schema.

Rejected architecture families:

- flat softmax over fixed words;
- class-only top-N labels;
- nearest-neighbor lookup pretending to be neural;
- downloaded general-purpose text model;
- remote API model.

The compiled graph must not be only `inner_product + softmax` with no recurrent, decoder, attention, or sequence-generation structure.

## 7. Size and latency budgets

Hard limits:

| Requirement | Limit |
| --- | ---: |
| Parameters | 1,000,000 to 5,000,000 |
| Compiled model bytes | <= 16,777,216 |
| Warm neural p99 | <= 3 ms |
| Context window | >= 2 previous tokens |
| Beam width | 2 to 8 |
| Output candidates | <= 8 |

The deterministic native path must still remain below the existing 5 ms p99 release gate with the model present.

## 8. Required data provenance

The production manifest must include at least these training sources:

```txt
syubraj-roman2nepali-transliteration
human-reviewed-lekh-gold-v1
lekh-chat-conventions-v1
lekh-name-lexicon-v1
```

The model may use teacher-only sources, but teacher checkpoints must not be packaged.

All raw upstream data must stay out of git unless a source is explicitly project-owned and approved for committed fixtures.

## 9. Required evaluation suites

The evaluation protocol is defined in:

```txt
data/neural/eval/README.md
```

The production manifest must point to evaluation reports proving these gates:

| Gate | Minimum |
| --- | ---: |
| Tail token top-1 acceptable accuracy | >= 0.88 |
| Tail token top-3 acceptable accuracy | >= 0.96 |
| Chat convention top-1 accuracy | >= 0.92 |
| Chat convention top-3 accuracy | >= 0.98 |
| Names top-3 accuracy | >= 0.90 |
| Protected false-conversion rate | 0 |
| Single-token phrase expansion rate | 0 |
| Secure-field inference count | 0 |

The manifest must include the required cases:

```txt
vato -> बाटो
bato -> बाटो
baato -> बाटो
chha -> छ
cha -> छ
xa -> छ
xaina -> छैन
```

## 10. Manifest requirements

The manifest must include:

- schema version;
- artifact identity;
- model family and architecture;
- tokenizer/sequence contract;
- decoder/beam-search contract;
- language-model rescoring contract;
- training sources;
- dataset reports;
- evaluation reports;
- device benchmark reports;
- model byte count;
- parameter count;
- compiled model SHA-256 directory digest;
- source checkpoint SHA-256;
- training dataset manifest SHA-256;
- metrics and failure safety rates;
- limitations.

The schema file is authoritative for exact field names.

## 11. Native IMK integration requirements

The native IMK may invoke the model only through an async neural tail service with:

- generation IDs;
- stale result rejection;
- secure-input cancellation;
- mode-switch cancellation;
- fail-open behavior when the model is absent, corrupt, slow, or unsupported;
- no synchronous XPC/network dependency;
- no raw text logging;
- no persistence writes from inference.

The model must not be copied by packaging until both production neural gates pass.

## 12. Phase 0 completion proof

Phase 0 is complete when all of these files exist and are internally consistent:

```txt
docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md
data/neural/schema/lekh-neural-manifest.schema.json
data/neural/eval/README.md
scripts/check-neural-production-contract.mjs
```

The proof command is:

```bash
npm run check:neural-contract
```

## 13. Phase 1 gold evaluation foundation proof

Phase 1 is complete when these files exist and pass the foundation validator:

```txt
data/neural/schema/lekh-neural-gold-row.schema.json
data/neural/gold/manifest.v1.json
data/neural/gold/romanized-nepali-token-gold.v1.jsonl
data/neural/gold/chat-convention-gold.v1.jsonl
data/neural/gold/names-gold.v1.jsonl
data/neural/gold/ambiguity-gold.v1.jsonl
data/neural/gold/non-nepali-pass-through-gold.v1.jsonl
data/neural/gold/protected-token-gold.v1.jsonl
data/neural/gold/adversarial-neural-tail-gold.v1.jsonl
scripts/validate-neural-gold-eval.mjs
```

The proof command is:

```bash
npm run check:neural-gold
```

Production proof is intentionally separate:

```bash
npm run check:neural-gold:production
```

The production command must fail until the real human-reviewed row-count targets in `data/neural/gold/manifest.v1.json` are satisfied. Phase 1 seed rows prove the evaluation contract; they are not accuracy evidence for a public neural model.

## 14. Phase 2 source-cleaning proof

Phase 2 is complete when these files exist and pass the open-vocabulary dataset builder:

```txt
data/neural/sources.v1.json
data/neural/schema/lekh-neural-source-registry.schema.json
data/neural/schema/lekh-neural-open-vocab-row.schema.json
scripts/build-neural-open-vocab-dataset.mjs
data/generated/neural-open-vocab/manifest.json
data/generated/neural-open-vocab/train.jsonl
data/generated/neural-open-vocab/dev.jsonl
data/generated/neural-open-vocab/test.jsonl
reports/neural-open-vocab-dataset-report.json
```

The proof command is:

```bash
npm run check:neural-open-vocab-data
```

The builder must:

- consume Phase 1 gold rows;
- consume only allowed token-level local generated TSV sources;
- reject phrase sources such as `runtime-phrases`;
- reject whitespace outputs;
- reject Latin outputs;
- keep protected/pass-through rows as `no-neural-candidate` safety negatives;
- dedupe rows;
- split by normalized input so input/target pairs cannot leak across train/dev/test;
- write deterministic JSONL plus a manifest with SHA-256 for every split.

Production proof is intentionally separate:

```bash
npm run check:neural-open-vocab-data:production
```

The production command must fail until required large licensed/public and human-reviewed sources are imported locally and the dataset reaches the production row-count gates.
