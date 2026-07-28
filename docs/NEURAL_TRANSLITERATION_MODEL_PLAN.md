# Neural Transliteration Model Plan

Status: active production execution guide.

The normative contract is
[`docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md`](neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md).
If this guide and the normative contract ever differ, the normative contract
and executable validators win.

## Product decision

Lekh does not ship a downloaded general-purpose transliteration model. It
trains and exports a compact, Nepali-specific, open-vocabulary Core ML model.
The neural path is a local-only tail candidate source:

1. deterministic FST;
2. dictionary and binary lexicon;
3. user lexicon;
4. neural tail candidates.

The deterministic path remains usable when the model is absent or rejected.
Neural output is never auto-committed, never runs in secure fields, and never
leaves the Mac.

## Qualified candidate families

No candidate is called the winner until the immutable selection report says
so.

| Candidate | Architecture | Runtime contract |
| --- | --- | --- |
| `lekh-open-vocab-seq2seq-v1` | GRU encoder-decoder baseline | `single-seq2seq-v1` |
| `lekh-open-vocab-bigru-attention-v1` | bidirectional GRU with additive attention | `split-attention-incremental-v1` |

Both candidates must satisfy the same frozen product envelope:

- 1–5 million parameters;
- no more than 16,777,216 compiled runtime bytes;
- Unicode-scalar input/output tokenization;
- bounded beam search;
- full candidate-generation p99 below 50 ms;
- exact safety-suite coverage;
- local Core ML execution;
- observed Neural Engine placement for the exact packaged workload before any
  Neural Engine claim.

The rejected hashed closed-vocabulary research baseline under
`models/rejected/closed-vocabulary-baseline/` is not a production candidate.

## Data and evaluation

The executable configs bind:

- the canonical generated dataset manifest at
  `data/generated/neural-open-vocab/manifest.json`;
- at least one million cleaned rows from
  `ai4bharat-aksharantar-nepali`;
- connected input/target split isolation with held-out precedence;
- the locked repository gold manifest;
- the locked Aksharantar Nepali official benchmark;
- zero training contribution from the blocked same-lineage mirrors.

IndicXlit may be downloaded and measured as a teacher/reference. Its weights
are never packaged. Official benchmark rows are evaluation-only and must not
enter training, development, distillation, vocabulary construction, or
reranking.

## Candidate build

Create and verify the pinned environment:

```sh
npm run neural:open-vocab:setup
npm run neural:open-vocab:verify-toolchain
```

Train either allowlisted candidate:

```sh
npm run neural:open-vocab:train -- \
  --config data/neural/training/open-vocab-seq2seq-v1.config.json

npm run neural:open-vocab:train -- \
  --config data/neural/training/open-vocab-bigru-attention-v1.config.json
```

The trainer atomically snapshots model, optimizer, data-loader, and Torch RNG
state after every completed epoch. Re-running the same command resumes only
when the trainer, config, dataset, gold suites, official benchmark, runtime,
vocabularies, and sampled rows still match exactly. Use
`--restart-training` only when intentionally discarding an incompatible or
corrupt recovery; it cannot be combined with `--skip-train`.

Each successful run produces one immutable candidate root containing the
checkpoint, training report, Core ML packages, compiled runtime artifacts,
vocabulary, candidate manifest, export report, locked-gold predictions, and
official-benchmark predictions. Training, export, and prediction evidence share
one run identity graph.

## Candidate qualification and selection

For each candidate:

```sh
node scripts/check-neural-training-contract.mjs --production \
  --config <candidate-config> \
  --candidate-root <candidate-root>

node scripts/evaluate-neural-open-vocab-model.mjs --production \
  --predictions <candidate-root>/gold-predictions.jsonl

node scripts/evaluate-neural-official-benchmark.mjs \
  --predictions <candidate-root>/official-benchmark-predictions.jsonl \
  --report <candidate-official-report>.json
```

Package the unpromoted candidate and capture full-service performance:

```sh
LEKH_NEURAL_ARTIFACT_ROOT=<candidate-root> \
  npm run package:macos:imk:neural:candidate

node scripts/benchmark-neural-native-service.mjs \
  --promotion-evidence \
  --runtime-placement-evidence \
    reports/neural-runtime-placement-evidence.json \
  --report <candidate-packaged-benchmark>.json
```

Create one six-field candidate specification per candidate and run the frozen
selector:

```sh
node scripts/check-neural-model-selection.mjs --production \
  --candidate-spec <baseline-specification.json> \
  --candidate-spec <attention-specification.json>
```

Selection compares only fully bound evidence on the same dataset, gold corpus,
official benchmark, and runtime contract. It does not accept manually copied
metrics.

## Atomic promotion

Promote only the selection winner:

```sh
npm run neural:promote:candidate -- \
  --candidate-dir <winner-root> \
  --evaluation-report <winner-evaluation.json> \
  --benchmark-report <winner-packaged-benchmark.json> \
  --selection-report <selection-report.json>
```

The promoter reopens and rehashes the complete evidence graph, derives the
production manifest from measured evidence, stages a closed-world directory,
and atomically replaces
`models/macos/LekhNeuralTransliterator.production`. Never hand-edit a candidate
or production manifest to make a gate pass.

Package and measure the promoted artifact:

```sh
npm run package:macos:imk:neural:production

node scripts/benchmark-neural-native-service.mjs --production \
  --runtime-placement-evidence \
    reports/neural-runtime-placement-evidence.json
```

## Final production proof

The final aggregate derives the selected config, candidate root, prediction
files, export report, selection report, and both candidate specifications from
the verified atomic promotion receipt. It cannot silently evaluate the
baseline when attention won.

```sh
npm run check:neural-phase0-10:production -- \
  --runtime-placement-evidence \
    reports/neural-runtime-placement-evidence.json
```

This re-verification reruns all executable production gates, continues far
enough to report every failing gate, and emits
`reports/neural-production-reverification-report.json`.

Passing development aggregates proves only that the harness is coherent:

```sh
npm run check:neural-phase3-6
npm run check:neural-phase3-9
npm run check:neural-phase0-10
```

## Failure strategy

Do not lower a locked gate.

1. If the correct answer is already in the beam, evaluate an immutable,
   digest-bound unigram reranker with identical Python and Swift behavior.
2. If the correct answer is absent, expand only from the already licensed
   canonical training source, preserve official-test isolation, and retrain.
3. If recurrent candidates remain below the reference floor, distill into a
   compact fixed-shape transformer that still satisfies the Core ML size,
   latency, safety, and placement contracts.
4. Re-run the full selection and promotion chain. No partial result receives a
   production claim.

## Release truth

A compiled model is not production evidence by itself. “Production ready”
means the selected artifact, retained evidence, packaged native runtime,
observed placement, latency, quality, safety, promotion receipt, and final
re-verification all identify the same artifact bytes and all pass.
