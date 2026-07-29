# Core ML and Transliteration Production Research Review

Date: 2026-07-28

Status: applied to the active neural production program

## Decision summary

The active candidate design remains technically sound:

- keep the deployment target at macOS 13;
- export ML Program artifacts, not the maintenance-mode neural-network format;
- keep Float16 model tensors and explicit incremental decoder state;
- load the packaged model with all compute units available;
- treat `MLComputePlan` as anticipated placement only;
- require separately captured runtime placement evidence before claiming Neural
  Engine execution;
- evaluate the uncompressed Float16 candidates first;
- test 8-bit palettization only as a separately measured challenger if the
  winner misses its size or latency gate;
- do not adopt Core ML stateful models because they require macOS 15 and would
  violate Lekh's macOS 13 product floor.

No active trainer, config, dataset, gold suite, or official benchmark byte was
changed as a result of this review.

## Core ML findings

### Model representation

Apple's Core ML Tools documentation describes ML Program as the recommended
format and states that major performance improvements target it, while the
older neural-network format is in maintenance mode. ML Program is supported on
macOS 12 and newer. Lekh explicitly exports `mlprogram` for macOS 13, so its
representation and deployment target are aligned with that guidance.

Core ML Tools uses Float16 weights and intermediate tensors by default for ML
Program conversion. macOS 13 also supports Float16 multi-array inputs and
outputs. Lekh's split attention contract uses Int32 token IDs and Float16
encoder context, hidden state, and logits, avoiding an accidental Float32
runtime contract.

Sources:

- [Convert Models to ML Programs](https://apple.github.io/coremltools/docs-guides/source/convert-to-ml-program.html)
- [Source and Conversion Formats](https://apple.github.io/coremltools/docs-guides/source/target-conversion-formats.html)
- [New Conversion Options](https://apple.github.io/coremltools/docs-guides/source/new-conversion-options.html)

### Incremental state and compatibility

Core ML stateful-model conversion is available only from macOS 15. Adopting it
would unnecessarily exclude macOS 13 and 14. Lekh's explicit encoder outputs
and decoder hidden-state tensors therefore remain the correct compatibility
design. They are closed, shape-checked runtime inputs rather than implicit
mutable model state.

Source:

- [Stateful Models](https://apple.github.io/coremltools/docs-guides/source/stateful-models.html)

### Compute-unit eligibility is not placement proof

Core ML's default/all compute-unit configuration permits CPU, GPU, and Neural
Engine execution. It does not promise that every operation, or even any
operation, actually executes on the Neural Engine.

Apple's `MLComputePlan` exposes supported and preferred devices and estimated
operation cost. Apple's own description calls these anticipated compute
devices. Lekh therefore preserves two separate evidence classes:

1. compute-plan compatibility and preferred-device evidence; and
2. observed runtime-placement evidence captured from the exact packaged
   workload.

The final gate must not substitute the first for the second.

Sources:

- [Model Prediction and Compute Units](https://apple.github.io/coremltools/docs-guides/source/model-prediction.html)
- [MLComputePlanDeviceUsage](https://developer.apple.com/documentation/coreml/mlcomputeplandeviceusage)
- [Deploy machine learning and AI models on-device with Core ML](https://developer.apple.com/videos/play/wwdc2024/10161/)

### Compression is an experiment, not an assumption

Apple documents 8-bit weight-only quantization and palettization for ML Program
models from macOS 13. Apple also recommends measuring the actual model on the
actual hardware because decompression and compute-device behavior vary by
model, OS, and hardware.

The current candidates are already constrained to 1–5 million parameters and
at most 16 MiB of compiled runtime artifacts. Compression is therefore not a
prerequisite. If an otherwise qualified winner misses size or latency:

1. preserve the uncompressed artifact and evaluation evidence;
2. create a distinct 8-bit candidate;
3. regenerate compiled-artifact, exact-output, quality, packaged-latency, and
   runtime-placement evidence;
4. accept it only if every frozen quality and safety gate still passes and it
   materially improves the failed device metric.

No unmeasured compression claim is acceptable.

Sources:

- [Core ML optimization overview](https://apple.github.io/coremltools/docs-guides/source/opt-overview.html)
- [Optimization feature availability](https://apple.github.io/coremltools/docs-guides/source/opt-whats-new.html)
- [Palettization performance](https://apple.github.io/coremltools/docs-guides/source/opt-palettization-perf.html)

## Transliteration findings

AI4Bharat reports IndicXlit as an approximately 11-million-parameter
multilingual Transformer trained on Aksharantar. Its published unreranked
Nepali Top-1 results are 80.17% for native/frequent words, 55.45% for Indian
names, and 49.14% for foreign names.

Lekh's committed reproduction uses the exact pinned IndicXlit v1 release and a
locked, de-duplicated 4,085-input Nepali benchmark. The measured results closely
track the published protocol:

| Bucket | Published Top-1 | Lekh reproduction Top-1 |
|---|---:|---:|
| Native/frequent | 0.8017 | 0.804015 |
| Indian names | 0.5545 | 0.551020 |
| Foreign names | 0.4914 | 0.490820 |
| Overall | — | 0.668543 |
| Overall Top-3 | — | 0.832313 |

The production policy requires each small Lekh candidate to remain within 0.02
overall/native and 0.03 on each name slice of that exact unreranked reference.
This is difficult but evidence-based. It must not be relaxed merely because a
candidate is smaller.

Sources:

- [AI4Bharat IndicXlit repository](https://github.com/AI4Bharat/IndicXlit)
- [Aksharantar paper](https://aclanthology.org/2023.findings-emnlp.4/)
- [AI4Bharat transliteration program](https://ai4bharat.iitm.ac.in/areas/xlit/)

## Local verification

The review also checked the active repository implementation:

```sh
rg -n "minimum_deployment_target|convert_to|FLOAT16|ComputeUnit|MLComputePlan" \
  scripts native/macos-imk

xcode-select -p
xcrun --find coremlcompiler
xcrun --find xctrace
```

Observed locally:

- selected developer directory:
  `/Library/Developer/CommandLineTools`;
- `coremlcompiler`: unavailable in Command Line Tools;
- `xctrace`: unavailable in Command Line Tools;
- Python/Core ML compilation and exact-artifact prediction tests: passing;
- full Xcode remains required to capture the final Instruments runtime trace.

Xcode is free and does not require a paid Apple Developer ID. Developer ID
signing and notarization remain unrelated to local Core ML compilation,
profiling, and Neural Engine evidence.

## Review conclusion

The full-data attention contract should continue unchanged, but sustained
PyTorch training should execute on the pinned remote CUDA profile rather than
on a thermally constrained Mac. The Mac retains the separate Core ML export,
parity, packaged benchmark, and runtime-placement phases. This changes the
training host, not the candidate architecture, dataset, seed, evidence, or
promotion thresholds.

The resulting candidate must be evaluated before introducing compression, a
larger architecture, distillation, or a higher operating-system floor. If it
fails quality, the next justified iteration is model-quality work against the
same locked benchmark; if it fails device metrics, the next justified
iteration is measured artifact optimization. Neither failure may be hidden by
weakening the gate.

The executable workflow and its local validation evidence are recorded in:

- [Remote CUDA training and macOS export](REMOTE_CUDA_TRAINING_AND_MACOS_EXPORT.md)
- [Remote CUDA pipeline validation, 2026-07-29](REMOTE_CUDA_PIPELINE_VALIDATION_2026-07-29.md)
