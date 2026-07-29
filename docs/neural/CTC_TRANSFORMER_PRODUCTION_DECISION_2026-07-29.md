# CTC Transformer Production Decision

Status: implementation decision, not a production-readiness claim.

Date: 2026-07-29

## Decision

The next Lekh neural candidate will be a fixed-shape Transformer encoder with
Connectionist Temporal Classification (CTC), exported as one Float16 Core ML
ML Program. The current bidirectional-GRU attention candidate remains preserved
as a fully measured challenger, but it is rejected for production promotion.

This decision is based on measured quality, parity, size, and latency—not on
architecture preference.

## Rejected GRU candidate

The authenticated CUDA run completed eight epochs and restored its best
checkpoint from epoch six. The run used 871,498 training rows and a
deterministic 50,000-row development sample.

The exact compiled candidate required Float32 internal Core ML computation to
pass the locked `rtol=0.005`, `atol=0.005` parity contract. Its Float16 tensor
boundaries remained intact, but Float32 internal execution made the artifact
ineligible for a Neural Engine claim.

| Measurement | Result | Required floor |
| --- | ---: | ---: |
| Official overall top-1 | 0.585067 | 0.648543 |
| Official overall top-3 | 0.760098 | 0.812313 |
| Native frequent top-1 | 0.730880 | 0.784015 |
| Indian-name top-1 | 0.435374 | 0.521020 |
| Foreign-name top-1 | 0.427173 | 0.460820 |
| Local unpackaged p99 | 94.121 ms | less than 50 ms |
| Compiled bytes | 12,758,187 | at most 16,777,216 |
| Core ML internal precision | Float32 | Float16 for Neural Engine eligibility |

Four-candidate rank analysis found the expected answer at rank one for 2,390
of 4,085 official rows, rank two for 505, rank three for 210, rank four for
173, and absent for 807. Even a perfect reranker over the existing four
candidates could reach only 0.802448 top-4 coverage, below the required
0.812313 top-3 floor. Reranking alone therefore cannot qualify this candidate.

## Architecture probes

Both probes used the same locked Core ML parity tolerance and default Float16
ML Program conversion on the development Mac. These are architecture
feasibility measurements, not trained-model quality evidence.

| Probe | Parameters | Package bytes | Float16 parity | Combined p99 |
| --- | ---: | ---: | --- | ---: |
| 6+6 autoregressive Transformer, beam width 4 | 11,120,197 | 22,302,268 | pass | 169.943 ms |
| 6-layer Transformer encoder + CTC greedy decode | 4,781,638 | 9,581,241 | pass | 2.361 ms |

The autoregressive Transformer is rejected: it exceeds both the parameter and
compiled-size product envelope and repeats Core ML prediction for every output
step. The CTC probe is approximately forty times faster than the measured GRU
candidate at p99 and stays inside both size envelopes.

The exact shared implementation was then probed independently after it replaced
the exploratory code. It contains 4,781,382 parameters, converts to a 9,582,018
byte default-Float16 ML Program, passes locked parity with a maximum absolute
logit error of 0.001281381, and measures 4.597 ms combined p99 over 240 local
unpackaged predictions. The p99 tail is slightly wider than the exploratory
probe but remains more than ten times below the 50 ms product ceiling.

Core ML conversion eligibility does not prove observed Neural Engine
placement. A live, artifact-bound Instruments trace remains required before
the product says that the model ran on the Neural Engine.

## Frozen v2 architecture

The implementation contract is:

- model id: `lekh-open-vocab-ctc-transformer-v2`;
- one fixed-shape Core ML model and one prediction per input token;
- Unicode-scalar Roman input and Devanagari output;
- maximum input length: 32 scalar positions;
- CTC output time steps: 32 fixed learned query positions;
- model dimension: 256;
- attention heads: 4;
- feed-forward dimension: 1,024;
- encoder layers: 6;
- expected parameter range: 4–5 million;
- blank id: 0;
- lexical Devanagari output ids start at 1;
- no autoregressive SOS or EOS classes;
- weighted CTC loss;
- deterministic host-side CTC prefix beam, width 8 for search and at most 4
  returned candidates;
- the existing Devanagari prefix/termination grammar applied during host
  decoding;
- default Float16 Core ML conversion with unchanged parity tolerances;
- macOS 13 deployment floor;
- `.all` Core ML compute units in the packaged runtime;
- neural inference remains an opt-in tail behind deterministic suggestions.

All current training targets fit the CTC alignment contract. Across the
871,498-row training selection, 50,000-row development selection, and locked
test corpus, the longest target has 20 Unicode scalars and the largest
repeat-aware CTC requirement is 21 time steps. The fixed 32-step contract
therefore avoids dropping acronym and letter-name expansions.

## Data and training policy

The first run will use the existing isolated 871,498-row selection so the
architecture comparison remains meaningful. If it misses the locked quality
floors, the next run may use the full 2,397,414 available Aksharantar training
rows, while preserving the current connected-split and official-test
isolation.

Training-row-only chat augmentation may add deterministic Roman aliases such
as `chh → x` and `bh → v`. An augmented input is forbidden if it collides with
any locked gold, development, test, or official-benchmark input. Augmentation
provenance, source counts, weight mass, and exact row digests must be retained
in the checkpoint.

No locked gold or official benchmark row may contribute to training,
augmentation, vocabulary construction, distillation, or reranking. If
distillation is later required, IndicXlit may be used only as an offline
teacher over training-derived inputs; its weights must never ship.

## Promotion sequence

1. Implement and unit-test the new trainer without modifying the preserved GRU
   trainer bytes.
2. Bind the new trainer and its imported utility-module digest into the remote
   bundle and checkpoint provenance.
3. Run a deterministic CPU smoke train and verify exact resume behavior.
4. Convert the smoke checkpoint to default-Float16 Core ML and pass PyTorch /
   Core ML logit parity.
5. Run authenticated CUDA training, import the closed result, and export on
   macOS.
6. Evaluate locked gold and all 4,085 official rows.
7. Package the exact candidate and measure full-service p99.
8. Capture artifact-bound Core ML and Neural Engine Instruments evidence.
9. Promote only if every existing quality, safety, size, latency, and placement
   gate passes without changing its threshold.

## Primary references

- [Aksharantar: Towards building open transliteration tools for the next billion users](https://aclanthology.org/2023.findings-emnlp.4/)
- [AI4Bharat IndicXlit reference implementation](https://github.com/AI4Bharat/IndicXlit)
- [Transliteration of Judeo-Arabic Texts into Arabic Script Using Recurrent Neural Networks](https://arxiv.org/abs/2004.11405)
- [Applying the Transformer to Character-level Transduction](https://arxiv.org/abs/2005.10213)
- [PyTorch CTCLoss](https://docs.pytorch.org/docs/stable/generated/torch.nn.modules.loss.CTCLoss.html)
- [Core ML ML Program conversion and default Float16 behavior](https://apple.github.io/coremltools/docs-guides/source/convert-to-ml-program.html)
- [Core ML typed execution](https://apple.github.io/coremltools/docs-guides/source/typed-execution.html)
- [Apple Neural Engine Transformer guidance](https://machinelearning.apple.com/research/neural-engine-transformers)
