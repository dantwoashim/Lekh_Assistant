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
JavaScript neural suite:               219 passed
Python CTC and remote pipeline suite:   55 passed
Swift native semantic probe:           passed
Production contract checker:           passed, zero warnings
```

The final model quality, Core ML parity, packaged p99 latency, and observed
Neural Engine placement remain intentionally unclaimed until the remote
checkpoint is complete and imported.
