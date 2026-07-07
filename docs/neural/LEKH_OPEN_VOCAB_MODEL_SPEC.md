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
npm run neural:source:syubraj
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

## 15. Phase 3 distillation plan proof

Phase 3 is complete when the repo can prove the offline teacher and distillation boundary without downloading or packaging a fake production model:

```txt
data/neural/training/open-vocab-seq2seq-v1.config.json
scripts/check-neural-distillation-plan.mjs
reports/neural-distillation-plan-report.json
```

The proof command is:

```bash
npm run neural:phase3:distillation
```

The Phase 3 gate must:

- read the Phase 2 generated dataset manifest;
- verify `ai4bharat-indicxlit` is teacher-only and not a training row source;
- verify the production-required source ids are represented in the source registry;
- allow the teacher checkpoint to be absent in dev while warning clearly;
- fail production until the teacher manifest exists and required production sources are imported.

Production proof is intentionally separate:

```bash
node scripts/check-neural-distillation-plan.mjs --production
```

## 16. Phase 4 training and Core ML export contract proof

Phase 4 is complete when the production student architecture, export paths, and manifest/digest checks are executable:

```txt
data/neural/training/open-vocab-seq2seq-v1.config.json
scripts/check-neural-training-contract.mjs
reports/neural-training-contract-report.json
```

The proof command is:

```bash
npm run neural:phase4:training-contract
```

The Phase 4 gate must:

- require `lekh-open-vocab-seq2seq-v1`;
- require Core ML, local-only, neural-tail-only output;
- require open-vocabulary GRU/Transformer seq2seq configuration;
- require beam search, no whitespace output, no Latin output, and no auto-commit eligibility;
- require a 1M-5M parameter budget and a <= 16 MB compiled model budget;
- flag the existing closed-vocabulary model directory as disconnected until a matching production manifest and digest exist.

Production proof is intentionally separate:

```bash
node scripts/check-neural-training-contract.mjs --production
```

## 17. Phase 5 evaluation and device benchmark proof

Phase 5 is complete when evaluation and latency evidence can be generated from real model outputs:

```txt
scripts/evaluate-neural-open-vocab-model.mjs
scripts/benchmark-neural-coreml-device.mjs
reports/neural-open-vocab-evaluation.json
reports/neural-coreml-device-benchmark.json
```

The proof commands are:

```bash
npm run neural:phase5:evaluate
npm run neural:phase5:benchmark
```

Without a model, the dev commands pass only as harness proof and mark the reports as non-production evidence. Production requires:

```bash
node scripts/evaluate-neural-open-vocab-model.mjs --production --predictions <model-predictions.jsonl>
node scripts/benchmark-neural-coreml-device.mjs --production --measurements <device-measurements.json>
```

The prediction JSONL rows must contain:

```json
{"id":"gold-row-id","candidates":["देवनागरी","..."]}
```

The device measurement JSON must contain packaged-app measurements for both Apple Silicon and Intel:

```json
{
  "devices": [
    {
      "name": "Apple Silicon benchmark Mac",
      "macOS": "26",
      "architecture": "arm64",
      "packagedApp": true,
      "p50Ms": 0.8,
      "p95Ms": 1.7,
      "p99Ms": 2.6,
      "secureFieldInferenceCount": 0
    }
  ]
}
```

## 18. Phase 6 native integration and release guard proof

Phase 6 is complete when native packaging and IMK source checks prove the model cannot be accidentally shipped or invoked before production evidence exists:

```txt
scripts/check-neural-native-integration.mjs
reports/neural-native-integration-report.json
```

The proof command is:

```bash
npm run neural:phase6:native-integration
```

The Phase 6 dev gate must prove:

- the old native `LekhNeuralTransliterator.swift` remains deleted;
- the IMK diagnostics still say `neural=disabled-until-async-production-model`;
- secure input checks and fail-open raw typing remain present;
- dev packaging does not copy `LekhNeuralTransliterator.mlmodelc`;
- candidate acceptance remains explicit.

Production proof is intentionally separate:

```bash
node scripts/check-neural-native-integration.mjs --production
```

Production must fail until the disabled diagnostic is replaced by a verified async Core ML tail service backed by a production manifest, compiled model, evaluation report, and two-device benchmark.

## 19. Aggregate Phase 3-6 proof

The repo-level Phase 3-6 gate is:

```bash
npm run check:neural-phase3-6
```

The full neural dev readiness gate now includes Phase 0-6:

```bash
npm run check:neural-transliteration
```

The production Phase 3-6 command is expected to fail until real training data, model predictions, device measurements, and a verified Core ML artifact exist:

```bash
npm run check:neural-phase3-6:production
```

## 20. Phase 7 human review intake proof

Phase 7 is complete when the repo defines the private reviewed-data intake contract:

```txt
data/neural/review/README.md
data/neural/review/private-source-manifest.example.json
scripts/check-neural-review-intake.mjs
reports/neural-review-intake-report.json
```

The proof command is:

```bash
npm run neural:phase7:review-intake
```

Production proof is intentionally separate:

```bash
node scripts/check-neural-review-intake.mjs --production
```

Production must fail until private reviewed JSONL files exist for `human-reviewed-lekh-gold-v1`, `lekh-chat-conventions-v1`, and `lekh-name-lexicon-v1`, with sufficient row counts, categories, review tiers, and project-owned licensing.

## 21. Phase 8 training-run readiness proof

Phase 8 is complete when the repo can prove that the generated open-vocabulary dataset and production architecture config are ready for a real training job:

```txt
scripts/prepare-neural-training-run.mjs
reports/neural-training-run-readiness-report.json
```

The proof command is:

```bash
npm run neural:phase8:training-run
```

Production proof is intentionally separate:

```bash
node scripts/prepare-neural-training-run.mjs --production
```

Production must fail until `data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/training-report.json` and `checkpoint.pt` exist and match the current generated dataset manifest.

## 22. Phase 9 promotion guard proof

Phase 9 is complete when the repo has a single promotion guard that refuses to promote the model unless every earlier report and artifact is present:

```txt
scripts/check-neural-production-promotion.mjs
reports/neural-production-promotion-report.json
```

The proof command is:

```bash
npm run neural:phase9:promotion
```

Production proof is intentionally separate:

```bash
node scripts/check-neural-production-promotion.mjs --production
```

Production promotion requires:

- at least 1,000,000 cleaned rows;
- Phase 7 reviewed-source production pass;
- Phase 8 completed training run;
- production evaluation pass;
- production Core ML device benchmark pass;
- production native integration pass;
- `models/macos/LekhNeuralTransliterator.mlmodelc`;
- `models/macos/LekhNeuralTransliterator.manifest.json`;
- model selection and readiness reports.

## 23. Aggregate Phase 3-9 proof

The repo-level Phase 3-9 gate is:

```bash
npm run check:neural-phase3-9
```

The full neural dev readiness gate includes Phase 0-9:

```bash
npm run check:neural-transliteration
```

The production Phase 3-9 command is expected to fail until reviewed data, trained checkpoint, model predictions, device measurements, and verified Core ML promotion artifacts exist:

```bash
npm run check:neural-phase3-9:production
```

## 24. Phase 10 SOTA/world-class verification proof

Phase 10 is complete when the repo has a final audit gate that checks Phase 0-9 reports, Level-5 truthfulness, model artifact existence, production manifest validity, generated dataset scale, native fail-open safety, and promotion-readiness evidence:

```txt
scripts/check-neural-sota-worldclass.mjs
reports/neural-sota-worldclass-report.json
```

The proof command is:

```bash
npm run neural:phase10:sota
```

The aggregate Phase 0-10 dev command is:

```bash
npm run check:neural-phase0-10
```

Production proof is intentionally separate:

```bash
node scripts/check-neural-sota-worldclass.mjs --production
```

Production Phase 10 must fail unless the actual `lekh-open-vocab-seq2seq-v1` Core ML artifact, manifest, reviewed data, evaluation report, benchmark report, native integration report, and promotion report all exist and pass production criteria. If any of those are missing, the final verdict must be `production-neural-model-not-verified-no-artifact-or-production-evidence`.

The full neural readiness command is:

```bash
npm run check:neural-transliteration
```

The full production command is expected to fail until real model evidence exists:

```bash
npm run check:neural-phase0-10:production
```
