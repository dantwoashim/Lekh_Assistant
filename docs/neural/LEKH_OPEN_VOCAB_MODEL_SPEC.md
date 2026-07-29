# Lekh open-vocabulary neural tail contract

Status: implementation contract for candidate qualification and production
promotion. The deterministic engine remains the first-line product path. A
neural model is an optional, local candidate tail and is never a replacement
for deterministic typing or its safety rules.

Current architecture-specific research:
[Transformer-CTC and Core ML production review, 2026-07-29](TRANSFORMER_CTC_COREML_RESEARCH_REVIEW_2026-07-29.md).
The latest executable mathematical review is
[Transformer-CTC mathematical audit, 2026-07-30](CTC_MATHEMATICAL_AUDIT_2026-07-30.md).

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

Three closed manifest branches are supported:

1. `lekh-open-vocab-seq2seq-v1`
   (`single-seq2seq-v1` after normalization):
   `LekhNeuralTransliterator.mlmodelc`.
2. `lekh-open-vocab-bigru-attention-v1`
   (`split-attention-incremental-v1`):
   `LekhNeuralTransliteratorEncoder.mlmodelc` and
   `LekhNeuralTransliteratorDecoderStep.mlmodelc`.
3. `lekh-open-vocab-ctc-transformer-v2`
   (`single-transformer-ctc-v1`):
   `LekhNeuralTransliterator.mlmodelc`.

The split and Transformer-CTC branches record their exact tensor I/O contracts
and export-only `.mlpackage` identities. The packages are provenance artifacts;
the app ships only compiled runtime models, vocabulary, and manifest.

`scripts/lib/neural-artifact-descriptor.mjs` is the single normalization
boundary. It verifies every source path, byte count, digest, role, canonical
bundle name, and vocabulary identity. It produces `artifactSetSha256`, a stable
digest over model ID, runtime contract, vocabulary digest, tensor-contract
digest, and the sorted compiled role inventory. Absolute paths and timestamps
are deliberately excluded.

The JSON Schema at
`data/neural/schema/lekh-neural-manifest.schema.json` is closed and
discriminated. A baseline manifest cannot contain explicit tensor/runtime
fields; a split manifest must contain exactly `encoder` and `decoderStep`; a
Transformer-CTC manifest must contain one fixed-shape model, `inputIds`
`[1,32]`, and `logits` `[1,32,outputClasses]`. All branches use schemaVersion 2
and distinct 32-hex `trainingRunId` and `exportRunId` values.

## Token and decoder contract

- tokenization: `unicode-scalar-character`;
- output grammar: `devanagari-word-sequence-v1`;
- legacy decoder: bounded autoregressive beam search, width 2–8, with 31
  decoder steps over a 32-scalar output bound so the complete final EOS
  transition is reachable;
- Transformer-CTC decoder: deterministic CTC prefix beam search, width 8, blank
  class 0 named exactly `<ctc-blank>`, 32 output time steps, and at most four
  candidates;
- score: accumulated log-softmax; the legacy decoder applies its locked length
  normalization, while CTC prefix probabilities merge blank and repeated-label
  paths before ranking;
- whitespace, Latin, malformed combining sequences, danda, unreachable EOS,
  and invalid special-token transitions are rejected.

The legacy JavaScript/Python and Swift paths share
`contracts/neural-decoder/v2/lekh-neural-decoder.v2.json`. The Transformer-CTC
Python and Swift decoders have exact state-machine parity tests. Both runtime
families validate the same scalar grammar before exposing a candidate.

The language-model rescorer is explicitly absent:
`{"enabled":false,"source":"none","weight":0}`. `contextWindowWords` is 0.

## Data lineage

The canonical dataset is
`data/generated/neural-open-vocab/manifest.json`. Its content identity covers
the exact train/dev/test files. Production reconstruction is read-only and must
be byte-stable:

```sh
npm run check:neural-open-vocab-data:production
npm run neural:open-vocab:audit
npm run check:neural-audit-evidence
```

The audit reads the dataset once and publishes two independently scoped
reports. `open-vocab-data-quality-v1.json` covers integrity, provenance,
balance, Unicode structure, and leakage. Its base-plus-mark vocabulary
diagnostics are conservative historical observations, not active CTC OOV
claims. `ctc-transformer-v2-alignment-v1.json` is authoritative for the active
model: it binds the exact dataset/config/evaluation hashes, the 31-scalar input
content capacity plus EOS, all 32 output time steps, repeated-label blank
separation, the shared Devanagari validator, train-vocabulary coverage, and
positive gold/official-benchmark representability. The production contract
rejects either report when its bound bytes or zero-incompatibility results are
stale.

The same check binds `ctc-rare-output-scalar-probes-v1.json` to the exact
sparse train-vocabulary tail and source rows retained by the CTC audit. These
silver-derived probes measure class reachability but are not accuracy gold.
`ऱ` and `ॠ`, which are absent from the current Unicode CLDR Nepali main
exemplar, receive a separate zero-unaccepted-top-1-emission policy on the
locked gold and official benchmark predictions.

After a candidate is exported, the post-export generator reloads the exact
checkpoint, re-runs compiled Core ML parity, and decodes only the 11 frozen
probe inputs. The evaluator then binds those predictions to the candidate's
existing 47-row gold predictions and 4,085-row official predictions:

```sh
npm run neural:open-vocab:rare-scalar:generate
npm run neural:open-vocab:rare-scalar:evaluate
```

The resulting `rare-scalar-evaluation.json` is a production gate. Sparse
silver exact matches remain diagnostic warnings; they never inflate reported
accuracy. Missing rows, unsafe outputs, artifact drift, or any unaccepted
top-1 `ऱ`/`ॠ` emission on a locked suite fail closed.
Promotion and live receipt verification independently recompute the pure
rare-scalar evaluation from the frozen probe contract, exact probe predictions,
47 locked gold rows, and 4,085 official benchmark rows; a report's precomputed
pass status is never trusted.

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

Canonical publication uses the exact fail-closed toolchain checked by
`scripts/check-neural-open-vocab-toolchain.py`: Python 3.11, NumPy 1.26.4,
Core ML Tools 9.0, PyTorch 2.7.0 on the macOS export host, and
PyTorch 2.7.0+cu118 on the remote CUDA training host. A stale environment is
not accepted. `requirements/neural-open-vocab.lock` pins the macOS conversion
closure and `requirements/neural-open-vocab-cu118.lock` pins the remote
training closure. Expensive training runs on the pinned CUDA host; the Mac
performs only checkpoint import, Core ML conversion, exact parity validation,
and device benchmarking.

Vocabulary construction uses train rows only. Normalized inputs may not cross
train/dev/test. Candidate artifacts are written only under their immutable
`data/generated/neural-open-vocab-model/<modelId>` root; promotion alone may
write the production directory. Gold and official-benchmark prediction
generation run through the exact exported compiled Core ML artifact; each
decoder invocation receives only the row input, never its acceptable outputs.

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
  operations as compatibility evidence;
- a live Instruments capture contains both the Core ML Instrument and Neural
  Engine Instrument;
- the Core ML compute lane is process-scoped and correlated with Neural Engine
  hardware activity inside the exact prediction intervals;
- every runtime role is resolved to the exact compiled SHA-256 and has observed
  Neural Engine compute, not merely anticipated support;
- the report binds `artifactSetSha256`.

Intel fallback evidence is useful but optional. It cannot support a Neural
Engine claim. `MLComputePlan` is anticipated device usage and cannot support
that claim by itself. The authoritative runtime contract is implemented in
`scripts/lib/neural-runtime-placement-evidence.mjs`; capture instructions are
in `docs/neural/NEURAL_ENGINE_RUNTIME_PLACEMENT.md`.

## Immutable qualification and promotion

Promotion is deliberately two-stage:

1. Train/export a candidate whose manifest says `productionEligible=false`.
2. Package that exact candidate with
   `LEKH_NEURAL_PACKAGE_MODE=candidate-promotion`.
3. Run `node scripts/benchmark-neural-native-service.mjs
   --placement-capture` under Instruments, normalize and validate the trace,
   then run `node scripts/benchmark-neural-native-service.mjs
   --promotion-evidence --runtime-placement-evidence <evidence.json>`; the
   report must be
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
   evaluation, benchmark, and `--selection-report` inputs. Transformer-CTC
   promotion also requires
   `--rare-scalar-report <candidate>/rare-scalar-evaluation.json`.
8. The promoter verifies every live byte again, stages one complete directory,
   writes measured metrics/performance without invention, and atomically swaps
   it into `models/macos/LekhNeuralTransliterator.production`.
9. Package the promoted directory with
   `npm run package:macos:imk:neural:production`.
10. Rerun `node scripts/benchmark-neural-native-service.mjs --production` and
   production runtime conformance against the promoted package.

Candidate files are never edited in place. A failure before or after the atomic
swap restores the previous production directory and removes staging debris.
Every promotion/receipt evidence read rejects symbolic links in every path
component and revalidates the live pathname against the opened inode version
after hashing.
The promotion receipt binds the candidate specification, selection receipt and
selection ID, official benchmark manifest and predictions, candidate manifest,
checkpoint, export report, gold predictions and corpus, dataset, evaluation,
packaged benchmark, vocabulary, artifacts, and resulting production manifest.
For Transformer-CTC it additionally retains and re-verifies the rare-scalar
evaluation, prediction-generation attestation, exact probe predictions, frozen
probe contract, and CTC alignment audit.

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
npm run neural:open-vocab:audit
npm run check:neural-audit-evidence
```

Individual production checks:

```sh
node scripts/check-neural-training-contract.mjs --production \
  --config <winner-config> --candidate-root <winner-root>
node scripts/evaluate-neural-open-vocab-model.mjs --production --predictions <candidate>/gold-predictions.jsonl
node scripts/evaluate-neural-official-benchmark.mjs --predictions <candidate>/official-benchmark-predictions.jsonl --report <candidate-report>.json
node scripts/check-neural-model-selection.mjs --production --candidate-spec <baseline.json> --candidate-spec <challenger.json>
node scripts/benchmark-neural-coreml-device.mjs --production --measurements reports/neural-native-service-e2e-production-report.json
node scripts/check-neural-native-integration.mjs --production
node scripts/prepare-neural-training-run.mjs --production \
  --config <winner-config> --candidate-root <winner-root>
node scripts/check-neural-production-promotion.mjs --production
node scripts/check-neural-sota-worldclass.mjs --production
```

Development aggregates:

```sh
npm run check:neural-phase3-6
npm run check:neural-phase3-9
npm run check:neural-phase0-10
```

Final production re-verification runs against the exact winner retained by the
atomic promotion receipt. It derives the winner config, candidate root,
predictions, export report, selection report, and both candidate
specifications from that verified receipt; it never silently falls back to the
baseline model. Observed Neural Engine placement evidence for the exact
packaged workload is mandatory:

```sh
npm run check:neural-phase0-10:production -- \
  --runtime-placement-evidence \
  reports/neural-runtime-placement-evidence.json
```

The bounded production aliases use the same receipt-derived context:

```sh
npm run check:neural-phase3-6:production -- \
  --runtime-placement-evidence \
  reports/neural-runtime-placement-evidence.json
npm run check:neural-phase3-9:production -- \
  --runtime-placement-evidence \
  reports/neural-runtime-placement-evidence.json
```

Passing a development aggregate proves only that the harness and available
candidate evidence are coherent. Production readiness requires the production
commands, an immutable promotion receipt, a fresh packaged production
benchmark, and zero failures.
