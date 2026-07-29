# Core ML conversion parity audit — 2026-07-30

## Decision

The active Transformer-CTC export remains a fixed-shape Float16 ML Program
eligible for Core ML's default CPU, GPU, and Neural Engine partitioning. The
conversion itself was already fail-closed, but its numerical proof covered
only one synthetic input. Production export now replays the existing
all-logit PyTorch-versus-compiled-Core-ML comparison across five deterministic
cases at every artifact-validation boundary.

This is an export-boundary change only. It does not alter either authenticated
remote-training source file, the checkpoint, the dataset, or the durable
epoch-6 recovery identity.

## Primary-source findings

Apple's Core ML guidance makes four relevant points:

1. After conversion, predictions from the converted model should be compared
   with predictions from the source model.
2. Float16 is the normal ML Program precision and permits execution across
   CPU, GPU, and Neural Engine, but conversion accuracy must be checked for the
   model's actual use case.
3. The typed-execution workflow recommends evaluating a **set of input
   examples**, not one input, with a metric suitable for the model.
4. Core ML prediction requires macOS, so this proof belongs in the short local
   export phase rather than CUDA training.

Primary sources:

- [Core ML model prediction](https://apple.github.io/coremltools/docs-guides/source/model-prediction.html)
- [Typed execution workflow](https://apple.github.io/coremltools/docs-guides/source/typed-execution-example.html)
- [Typed execution](https://apple.github.io/coremltools/docs-guides/source/typed-execution.html)
- [Convert models to ML Programs](https://apple.github.io/coremltools/docs-guides/source/convert-to-ml-program.html)
- [Core ML model input and output types](https://apple.github.io/coremltools/docs-guides/source/model-input-and-output-types.html)

## Previous evidence

The trainer already performed a strong element-wise check:

- source: the exact checkpoint reloaded into the PyTorch model;
- target: the exact compiled `.mlmodelc` artifact;
- compared value: every logit in `[1, 32, classCount]`;
- rule: NumPy `allclose`;
- relative tolerance: `0.005`;
- absolute tolerance: `0.005`;
- phases: staged artifact, published artifact, and a third independent
  published-artifact load.

The weakness was input diversity. Every phase used the same six-token lexical
prefix followed by EOS and padding.

## Representative suite

`ctc-representative-logit-parity-v1` retains the same source model, compiled
backend, tensor-level comparison, and tolerances, but exercises:

| Case | Content length | Boundary covered |
|---|---:|---|
| `lexical-prefix-baseline` | 6 | compatibility with the original attestation |
| `minimum-admitted-length` | 3 | shortest runtime-admitted token |
| `typical-nepal` | 5 | ordinary Romanized Nepali input |
| `repeated-scalar` | 8 | repeated input embeddings and padding mask |
| `maximum-content-length` | 31 | EOS in the final tensor position, no padding, all `a–z` |

For each case the report records the fixed input SHA-256 and maximum absolute
logit error. A suite identity hashes the ordered case IDs, lengths, and input
digests. The exporter requires:

- five unique input tensors;
- identical suite identity across all three validation loads;
- 15 total source/compiled comparisons;
- exact closed policy evidence;
- internally consistent aggregate error;
- the baseline digest to match the trainer's original known-answer field.

Evaluation, official comparison, artifact-contract validation, atomic
promotion, and live promotion-receipt verification all reject a
Transformer-CTC report without this evidence.

## Precision and placement boundary

The parity suite proves that the compiled Float16 program remains numerically
consistent with its Float32 PyTorch checkpoint for the representative input
boundaries. It does **not** prove which hardware unit executed an operation.
Observed Neural Engine placement still requires the separate artifact-bound
runtime trace; a compute plan or successful Float16 conversion is not an
execution claim.

## Execution status

The contract and replay logic are testable without running Core ML conversion.
The real five-case suite will execute automatically when the authenticated CTC
CUDA result is imported and the local macOS export runs. Until that artifact
exists, numerical errors and model quality remain unmeasured rather than
inferred.

Low-heat verification for the implementation:

```text
9 split-host Core ML exporter tests passed
42 focused parity, evaluator, promotion, receipt, and source-contract tests passed
neural production source contract passed with zero failures and zero warnings
Python compilation and git whitespace validation passed
authenticated CTC trainer and shared model source remained byte-for-byte untouched
```

No local training, Core ML conversion, model benchmark, or full-dataset scan
was run for this audit.
