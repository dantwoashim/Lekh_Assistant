# Lekh open-vocabulary neural tail contract

Status: implementation contract for candidate qualification and production
promotion. The deterministic engine remains the first-line product path. A
neural model is an optional, local candidate tail and is never a replacement
for deterministic typing or its safety rules.

## Product boundary

- no network inference;
- no text telemetry;
- no inference in secure fields;
- no neural request for an exact deterministic token;
- no automatic text commit from an unreviewed neural result;
- cancellation and generation IDs prevent stale asynchronous results from
  reaching the candidate window;
- `autoCommitEligible` remains false for the neural tail;
- raw Latin typing fails open when model loading, verification, prediction, or
  decoding fails.

The model consumes one normalized Romanized token. It does not consume previous
words, clipboard contents, surrounding document text, or host-application
state. Output is one Devanagari token candidate, never a phrase.

## Runtime artifacts

The production unit is one atomic directory:

```text
models/macos/LekhNeuralTransliterator.production/
  LekhNeuralTransliterator.manifest.json
  LekhNeuralTransliterator.vocab.json
  neural-candidate-promotion-report.json
  ...one complete compiled runtime layout...
```

Two closed manifest branches are supported:

1. `lekh-open-vocab-seq2seq-v1`
   (`single-seq2seq-v1` after normalization):
   `LekhNeuralTransliterator.mlmodelc`.
2. `lekh-open-vocab-bigru-attention-v1`
   (`split-attention-incremental-v1`):
   `LekhNeuralTransliteratorEncoder.mlmodelc` and
   `LekhNeuralTransliteratorDecoderStep.mlmodelc`.

The split branch also records its exact tensor I/O contract and its export-only
`.mlpackage` identities. The packages are provenance artifacts; the app ships
only compiled runtime models, vocabulary, and manifest.

`scripts/lib/neural-artifact-descriptor.mjs` is the single normalization
boundary. It verifies every source path, byte count, digest, role, canonical
bundle name, and vocabulary identity. It produces `artifactSetSha256`, a stable
digest over model ID, runtime contract, vocabulary digest, tensor-contract
digest, and the sorted compiled role inventory. Absolute paths and timestamps
are deliberately excluded.

The JSON Schema at
`data/neural/schema/lekh-neural-manifest.schema.json` is closed and
discriminated. A baseline manifest cannot contain split fields; a split
manifest must contain exactly `encoder` and `decoderStep`. Both use
schemaVersion 2 and distinct 32-hex `trainingRunId` and `exportRunId` values.

## Token and decoder contract

- tokenization: `unicode-scalar-character`;
- output grammar: `devanagari-word-sequence-v1`;
- decoder: bounded beam search;
- beam width: 2–8;
- output tensor length: 32 scalars;
- maximum decoder steps: 31, reserving the complete final EOS transition;
- score: accumulated log-softmax;
- length normalization: score divided by token count including SOS;
- whitespace, Latin, malformed combining sequences, danda, unreachable EOS,
  and invalid special-token transitions are rejected.

The JavaScript/Python and Swift paths share
`contracts/neural-decoder/v2/lekh-neural-decoder.v2.json`. Swift validates the
same scalar grammar before exposing a candidate.

The language-model rescorer is explicitly absent:
`{"enabled":false,"source":"none","weight":0}`. `contextWindowWords` is 0.

## Data lineage

The canonical dataset is
`data/generated/neural-open-vocab/manifest.json`. Its content identity covers
the exact train/dev/test files. Production reconstruction is read-only and must
be byte-stable:

```sh
npm run check:neural-open-vocab-data:production
```

The canonical gold inventory is
`data/neural/gold/manifest.v3.json`. Existing v1/v2 evidence is immutable; v3
adds the token-only chat suite without rewriting old artifacts.

Training input snapshots bind:

- trainer bytes;
- effective training config;
- dataset manifest/content/split digests;
- gold manifest/corpus/suite digests;
- official benchmark manifest/corpus/suite digests and the ordered normalized
  input identity;
- proof that no official benchmark input occurs in train or dev;
- runtime versions;
- training and export run identities.

Vocabulary construction uses train rows only. Normalized inputs may not cross
train/dev/test. Candidate artifacts are written only under their immutable
`data/generated/neural-open-vocab-model/<modelId>` root; promotion alone may
write the production directory. Gold and official-benchmark prediction
generation run through the exact exported compiled Core ML artifact and cannot
read expected labels.

## Evaluation

The locked suite measures safety and release regressions. Each JSONL row is one
assertion; repeated inputs with distinct contexts remain distinct assertions.
Production floors are:

- tail top-1 acceptable accuracy: at least 0.88;
- tail top-3 acceptable accuracy: at least 0.96;
- chat-convention top-1: at least 0.92;
- chat-convention top-3: at least 0.98;
- names top-3: at least 0.90;
- protected false-conversion rate: exactly 0;
- single-token phrase expansion rate: exactly 0;
- secure-field inference count: exactly 0.

These small locked suites are promotion safety gates, not a scientific
state-of-the-art claim. Candidate ranking therefore uses the locked 4,085-input
official Aksharantar Nepali test benchmark. Its native-frequency, Indian-name,
and foreign-name partitions remain separate, duplicate inputs are already
collapsed into acceptable-output sets, and the bytes are forbidden for
training.

The official comparison uses the same runtime-visible candidate validation for
both Lekh and the frozen AI4Bharat IndicXlit v1.0 beam-4 reference. Promotion
requires near-parity: no more than 0.02 regression in overall top-1, overall
top-3, or native-frequency top-1, and no more than 0.03 regression in either
name-partition top-1. These are release-quality floors, not a state-of-the-art
claim.

All selection candidates must have identical dataset, Lekh gold, and official
benchmark identities. Ranking is deterministic: official overall top-1,
native-frequency top-1, combined name top-1, official overall top-3, Lekh gold
tail top-1, packaged p99 latency, compiled bytes, then artifact-set SHA-256.
At least two distinct exports and artifact sets are required.

Evaluation reads the candidate `export-report.json` and verifies the exact
predictions, candidate manifest, vocabulary/model identities, gold corpus, and
dataset snapshot before reporting metrics. A candidate remains
`productionEligible=false` throughout evaluation.

## Device and Neural Engine evidence

Consumer latency is full candidate generation through the packaged async
service: input admission, Core ML prediction(s), iterative beam decoding,
sequence validation, cancellation checks, and main-queue completion. A single
Core ML forward pass is never reported as consumer latency.

Required production evidence:

- p50, p95, and p99 are each below 50 ms;
- at least one Apple Silicon packaged-app measurement;
- `secureFieldInferenceCount=0`;
- `measurementKind=full-candidate-generation`;
- Core ML configuration uses `.all`;
- each runtime role has a fresh compute-plan record;
- every Apple Silicon runtime role has supported and preferred Neural Engine
  operations;
- the report binds `artifactSetSha256`.

Intel fallback evidence is useful but optional. It cannot support a Neural
Engine claim.

## Immutable qualification and promotion

Promotion is deliberately two-stage:

1. Train/export a candidate whose manifest says `productionEligible=false`.
2. Package that exact candidate with
   `LEKH_NEURAL_PACKAGE_MODE=candidate-promotion`.
3. Run `node scripts/benchmark-neural-native-service.mjs
   --promotion-evidence`; the report must be
   `passed-candidate-promotion-evidence`.
4. Evaluate the exact exported predictions with
   `node scripts/evaluate-neural-open-vocab-model.mjs --production`.
5. Evaluate each candidate on the exact official benchmark with
   `npm run neural:evaluate:official -- --predictions <path>`. The export
   report must already bind those prediction and benchmark bytes.
6. Create one candidate-specification JSON dossier per export, then run
   `node scripts/check-neural-model-selection.mjs --production
   --candidate-spec <baseline.json> --candidate-spec <challenger.json>`.
7. Run `npm run neural:promote:candidate --` with the candidate, export,
   evaluation, benchmark, and `--selection-report` inputs.
8. The promoter verifies every live byte again, stages one complete directory,
   writes measured metrics/performance without invention, and atomically swaps
   it into `models/macos/LekhNeuralTransliterator.production`.
9. Package the promoted directory with
   `npm run package:macos:imk:neural:production`.
10. Rerun `node scripts/benchmark-neural-native-service.mjs --production` and
   production runtime conformance against the promoted package.

Candidate files are never edited in place. A failure before or after the atomic
swap restores the previous production directory and removes staging debris.
The promotion receipt binds the candidate specification, selection receipt and
selection ID, official benchmark manifest and predictions, candidate manifest,
checkpoint, export report, gold predictions and corpus, dataset, evaluation,
packaged benchmark, vocabulary, artifacts, and resulting production manifest.

No script may temporarily mark a candidate production-eligible to obtain
benchmark evidence. No status-only report is sufficient.

## Native runtime

The IMK loader:

- reads canonical manifest and vocabulary names;
- resolves the selected runtime layout from the manifest;
- verifies model sizes and directory hashes;
- validates exact Core ML feature names, shapes, and data types;
- runs known-answer semantic attestation;
- remains unavailable while attestation is pending;
- performs inference on a dedicated serial queue;
- enforces latest-request-wins and explicit cancellation;
- uses a 45 ms internal decode budget;
- blocks deterministic exact and protected Latin inputs;
- returns no candidates for secure fields.

The split attention path runs the encoder once and the decoder step
incrementally for each beam-search step.

## Packaging policy

Ordinary v1 scripts explicitly set `LEKH_PACKAGE_NEURAL_MODEL=0`; therefore the
neural tail remains absent from the normal release until a separate promoted
neural release is intentionally built.

Candidate packaging requires:

```sh
LEKH_NEURAL_ARTIFACT_ROOT=/repository/relative/candidate \
  npm run package:macos:imk:neural:candidate
```

Production packaging uses:

```sh
npm run package:macos:imk:neural:production
```

The packager resolves the manifest first, copies every role, verifies the
source and packaged artifact-set identities, copies vocabulary, and writes the
manifest last. Experimental typing flags are forbidden for a promoted
production model.

## Proof commands

Contract and data:

```sh
npm run check:neural-contract
npm run check:neural-gold:production
npm run check:neural-open-vocab-data:production
```

Individual production checks:

```sh
node scripts/check-neural-training-contract.mjs --production
node scripts/evaluate-neural-open-vocab-model.mjs --production --predictions <candidate>/gold-predictions.jsonl
node scripts/evaluate-neural-official-benchmark.mjs --predictions <candidate>/official-benchmark-predictions.jsonl --report <candidate-report>.json
node scripts/check-neural-model-selection.mjs --production --candidate-spec <baseline.json> --candidate-spec <challenger.json>
node scripts/benchmark-neural-coreml-device.mjs --production --measurements reports/neural-native-service-e2e-production-report.json
node scripts/check-neural-native-integration.mjs --production
node scripts/prepare-neural-training-run.mjs --production
node scripts/check-neural-production-promotion.mjs --production
node scripts/check-neural-sota-worldclass.mjs --production
```

Aggregates:

```sh
npm run check:neural-phase3-6
npm run check:neural-phase3-9
npm run check:neural-phase0-10
```

Passing a development aggregate proves only that the harness and available
candidate evidence are coherent. Production readiness requires the production
commands, an immutable promotion receipt, a fresh packaged production
benchmark, and zero failures.
