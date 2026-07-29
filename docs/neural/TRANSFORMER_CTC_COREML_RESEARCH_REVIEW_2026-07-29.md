# Transformer-CTC and Core ML Production Review

Date: 2026-07-29

Status: applied to the active `lekh-open-vocab-ctc-transformer-v2` candidate

## Decision

The fixed-shape Transformer-CTC architecture remains the active candidate.
The retained autoregressive and split-attention formats remain closed,
supported compatibility branches, but they are not substitutes for evaluating
the current CTC checkpoint.

The production sequence is:

1. finish the deterministic CUDA training run;
2. export the exact checkpoint to an uncompressed Float16 ML Program;
3. prove PyTorch, Core ML, and native Swift decoder parity;
4. measure full-candidate latency and observed runtime placement;
5. promote only if the frozen gold and official-benchmark gates pass.

Compression is not applied before this baseline is measured.

## Core ML conversion findings

Apple recommends ML Program for current performance work. ML Programs use
Float16 compute by default, and a fixed PyTorch input shape allows stronger
conversion and runtime optimization than a dynamic shape. The CTC export
already follows that guidance:

- deployment target: macOS 13;
- representation: `mlprogram`;
- input: `inputIds`, Int32, `[1,32]`;
- output: `logits`, Float16, `[1,32,classCount]`;
- one compiled forward pass for the complete CTC lattice.

The runtime loads the compiled model with all compute units available.
`MLComputePlan` is retained as anticipated-device evidence only. It cannot
replace the separate Instruments/runtime-placement capture required before an
explicit Neural Engine execution claim.

The packaged single-forward benchmark previously encoded the legacy
`decoderInputIds` tensor unconditionally. It is now descriptor-driven:

- CTC accepts only `inputIds`;
- retained seq2seq accepts `inputIds` plus `decoderInputIds`;
- every feature name, data type, and shape is checked against the selected
  runtime contract before timing;
- split-attention artifacts fail closed and direct callers to the full native
  service benchmark.

Sources:

- [Core ML model input and output types](https://apple.github.io/coremltools/docs-guides/source/model-input-and-output-types.html)
- [Convert models to ML Programs](https://apple.github.io/coremltools/docs-guides/source/convert-to-ml-program.html)
- [Core ML compute-plan utilities](https://apple.github.io/coremltools/docs-guides/source/mlmodel-utilities.html)
- [Typed execution](https://apple.github.io/coremltools/docs-guides/source/typed-execution.html)

## CTC correctness findings

PyTorch's CTC contract requires the blank class to be part of the class
dimension but absent from target sequences. The time dimension must be long
enough for the target and any repeated adjacent labels. The trainer enforces
those conditions before training:

- blank class ID is exactly `0`;
- target IDs are positive lexical class IDs;
- `ctc_required_time_steps()` counts the extra blank separation required by
  repeated adjacent labels;
- rows that cannot align within 32 time steps fail the dataset contract;
- `zero_infinity=False` keeps an impossible alignment visible as a hard
  failure instead of silently zeroing its loss;
- CTC loss and deterministic reduction run on CPU while gradients flow back
  to the CUDA Transformer.

The canonical serialized blank token is now exactly `<ctc-blank>` in all three
implementations: Python training/export, JavaScript artifact validation, and
Swift runtime loading. The review found and removed an older JavaScript-only
`<blank>` spelling that would have rejected a correctly trained artifact.
Production-contract checks now pin all three source implementations to the
same spelling, and a regression test rejects the old alias.

Source:

- [PyTorch CTCLoss](https://docs.pytorch.org/docs/stable/generated/torch.nn.modules.loss.CTCLoss.html)

## Exact dataset and alignment findings

The active dataset now has a streaming CTC-specific representation audit. It
uses the executable tensor dimensions and shared Devanagari sequence validator
rather than the retired recurrent decoder's token assumptions. The audit is
bound to:

- dataset manifest SHA-256
  `0ebe69836574c52582babe443385bdfcc4aed01fbbeea9d92110a0ce4784e041`;
- dataset content SHA-256
  `15909aac528fa0f2fb590e62981b0a0035422aa2673f9de4c7bc47ba2e778599`;
- 1,048,532 exact rows: 871,498 train, 87,371 dev, and 89,663 test;
- active CTC config SHA-256
  `2cafefef4d741712ca435291eb38fdc100e12072ccb2c07b0d69746d6392e7cd`.

Measured results:

- all 26 lowercase Roman input scalars occur in train;
- all 65 train output scalars cover every primary dev/test target;
- maximum dataset input content is 28 scalars versus capacity 31 plus EOS;
- maximum primary output is 20 scalars;
- maximum required CTC alignment is 21 time steps versus capacity 32;
- 30,067 rows contain adjacent repeated output scalars, requiring 30,391
  explicit blank-separation boundaries; every alignment still fits;
- zero dataset rows have invalid input, invalid Devanagari structure, unseen
  held-out primary output scalars, alignment overflow, or no representable
  target;
- all 4,085 positive official-benchmark rows and all 34 positive locked-gold
  rows have at least one representable target;
- the 13 negative locked-gold rows remain excluded from positive-target
  representability by their fail-closed expected action.

Four train output scalars occur five times or fewer: `ऑ` (4), `ऱ` (1), `ळ`
(1), and `ॠ` (2). Unicode CLDR 48's current Nepali main exemplar includes
`ऑ` and `ळ`, but not `ऱ` or `ॠ`. The latter two rows are therefore recorded as
a silver-data quality risk, not silently declared correct. Rebuilding the
dataset now would invalidate the authenticated epoch-6 recovery, so the
current candidate must instead undergo explicit rare-class prediction
inspection after import; no quality claim is based on representation alone.
[Unicode CLDR 48 Nepali locale summary](https://www.unicode.org/cldr/charts/48/summary/ne.html)

The older `output-tokenization-analysis-v1.json` is retained only as the
historical design comparison that selected Unicode scalars. It is explicitly
marked non-production evidence and superseded by
`ctc-transformer-v2-alignment-v1.json`. The general data-quality report's
base-plus-mark vocabulary warnings are likewise not CTC OOV findings.

Proof commands:

```sh
npm run neural:open-vocab:audit
npm run check:neural-audit-evidence
npm run check:neural-contract
```

## Compression decision

Apple documents useful latency and memory improvements from palettization,
quantization, and pruning, but also states that results vary by model, compute
unit, OS, and hardware. The current model is already capped at 16 MiB and must
first establish its uncompressed quality and placement baseline.

If the Float16 candidate passes quality but misses size or latency, a compressed
artifact may be evaluated as a separate challenger. It must receive a new
artifact identity and repeat parity, gold quality, official comparison,
packaged latency, and runtime-placement evidence. No compressed model inherits
the Float16 model's evidence.

Sources:

- [Core ML optimization overview](https://apple.github.io/coremltools/docs-guides/source/opt-overview.html)
- [Core ML optimization workflow](https://apple.github.io/coremltools/docs-guides/source/opt-workflow.html)
- [Palettization performance](https://apple.github.io/coremltools/docs-guides/source/opt-palettization-perf.html)

## Verification completed in this review

```text
JavaScript neural suite:               228 passed across 34 files
Remote artifact/orchestration suite:     24 passed
Pinned open-vocabulary Python suite:     69 passed
CTC dataset/audit subset:                 9 passed (included above)
Swift native semantic probe:           passed
Production contract checker:           passed, zero warnings
```

The final model quality, Core ML parity, packaged p99 latency, and observed
Neural Engine placement remain intentionally unclaimed until the remote
checkpoint is complete and imported.
