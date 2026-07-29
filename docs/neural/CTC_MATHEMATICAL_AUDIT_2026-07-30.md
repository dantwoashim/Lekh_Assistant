# Transformer-CTC mathematical audit — 2026-07-30

## Scope

This pass reviewed the active `lekh-open-vocab-ctc-transformer-v2`
architecture, weighted loss, alignment bounds, padding mask, Python prefix
beam, native Swift prefix beam, and post-export evaluation. It deliberately
did not alter either authenticated remote-training source file:

- `scripts/train-open-vocab-ctc-transformer.py`
- `scripts/lib/neural_ctc_transformer.py`

Changing either file before importing the durable epoch-6 recovery would
invalidate the remote bundle identity and discard useful completed GPU work.

## Primary-source contract

PyTorch's CTC contract requires the blank class to be present in the output
dimension but absent from targets. Targets must fit the input time dimension.
With `reduction="mean"`, PyTorch divides each sequence loss by its target
length before taking the batch mean. `zero_infinity=False` leaves impossible
alignments visible instead of silently replacing them:

- [PyTorch CTCLoss](https://docs.pytorch.org/docs/stable/generated/torch.nn.CTCLoss.html)
- [PyTorch Embedding](https://docs.pytorch.org/docs/stable/generated/torch.nn.Embedding.html)
- [PyTorch reproducibility](https://docs.pytorch.org/docs/stable/notes/randomness.html)

The active trainer uses `reduction="none"` and then computes a row-weighted
mean of raw per-sequence negative log likelihood. This is a valid CTC
objective, but it is not target-length-normalized: longer targets can carry
more gradient mass than equally weighted shorter targets.

The locked alignment audit measures this exposure rather than guessing:

- train target scalar length: mean `9.66379154`, p50 `9`, p99 `18`, max `20`;
- train repeat-aware required steps: mean `9.69284841`, max `21`;
- all inputs use exactly `32` output time steps;
- no selected train, development, test, official, or locked-gold target
  overflows the CTC alignment window.

The current loss policy is therefore not an invalid alignment bug. Restarting
training without candidate evidence would trade a known, improving epoch-6
state for an unmeasured hypothesis. The official benchmark now reports
top-1/top-3 accuracy independently for target lengths `1–7`, `8–13`, and
`14+`. These diagnostics do not invent a new promotion threshold; they expose
any length-specific regression before the aggregate parity gate can hide it.

## Exact decoder oracle

An independent brute-force oracle enumerated every CTC path for 1,200 random
matrices:

- class counts: `2–4`;
- time steps: `1–5`;
- exact log-domain path aggregation;
- deterministic lexical tie ordering;
- beam capacity large enough to retain every possible prefix.

Finite sequence ranking had **zero mismatches**. The oracle did find one
fail-closed defect: beam bookkeeping retained prefixes whose blank and
non-blank scores were both negative infinity. Those prefixes sorted after all
finite prefixes, but could be returned if a caller requested more candidates
than had any legal CTC path. The stress oracle observed 28,960 such extra
zero-probability outputs because it intentionally requested the complete
candidate inventory.

The native Swift decoder now has its own independent exhaustive oracle rather
than relying only on five shared examples. For 96 deterministic matrices it:

- varies class count from `2–4` and time steps from `1–4`;
- enumerates every complete class path (`4^4 = 256` at the largest case);
- performs the standard merge-repeats-then-remove-blank collapse;
- sums the scores of every path mapping to the same sequence;
- compares the entire finite sequence ranking, including lexical tie order;
- uses beam width `64`, which retains all at-most-61 prefixes in this bounded
  state space, so the comparison is exact rather than an approximation.

All 96 matrices matched. The oracle aggregates raw-logit path sums because
each full path contains exactly one value from every time step; the omitted
per-time-step log-softmax normalizers are therefore the same constant for
every complete path and cannot change sequence ranking.

This matches the original CTC definition: a label's probability is the sum of
all paths collapsing to it, repeated adjacent labels collapse, and a blank is
required to express two consecutive copies of the same label:

- [Graves et al., original CTC paper](https://www.cs.toronto.edu/~graves/icml_2006.pdf)
- [PyTorch CTCLoss contract](https://docs.pytorch.org/docs/stable/generated/torch.nn.CTCLoss.html)

## Native Core ML tensor-layout audit

Core ML output arrays are not required to use tightly packed row-major
storage. Apple defines each `MLMultiArray.strides` entry as the number of
memory locations spanning that dimension, and its multidimensional subscript
accepts one index per dimension:

- [Apple `MLMultiArray.strides`](https://developer.apple.com/documentation/coreml/mlmultiarray/strides)
- [Apple multidimensional `MLMultiArray` subscript](https://developer.apple.com/documentation/coreml/mlmultiarray/subscript%28_%3A%29-3d9el)

The active CTC runtime already reads `[batch, time, class]` logits through that
multidimensional subscript rather than assuming `time * classCount + class`.
Its native model fixture returns a deliberately non-contiguous Float16 array
with gaps between both time rows and adjacent class values; the expected
blank-separated repeated candidate is recovered correctly. No production CTC
stride fix was required.

## Resolution without recovery loss

Three boundaries now enforce the same finite-path rule:

1. The native Swift runtime discards every final prefix whose accumulated
   score is not finite.
2. The local Core ML export wrapper filters decoded token sequences unless
   their repeat-aware required time is no greater than the logit time
   dimension. It records `ctc-finite-path-only-v1` in export evidence.
3. Rare-scalar prediction generation applies the same rule before writing
   evidence.

The exporter wraps the authenticated trainer in memory; it does not edit its
bytes. After the authenticated result is imported, the shared Python beam
implementation should receive the same direct finite-score filter so future
training bundles no longer need the compatibility wrapper.

## Padding and masking result

The custom initializer gives the embedding padding row a nonzero fixed value,
even though a newly constructed PyTorch embedding normally starts its
`padding_idx` row at zero. This does not affect current model outputs:

- padding positions are excluded as attention keys in every encoder layer;
- output queries never consume a padded source value;
- the padding row receives no gradient.

Changing initialization now would alter the authenticated model definition
without correcting an observable computation. It remains intentionally
unchanged until the recovered candidate has been imported and measured.

## Verification

The low-heat verification set for this increment is:

```text
7 remote Core ML exporter tests passed
14 rare-scalar generator tests passed
10 official benchmark/evaluator tests passed
17 promotion and live-receipt tests passed
1 closed finite-path policy contract test passed
13 shared Transformer/CTC tests passed, including a 96-matrix permanent oracle
native Swift LekhInputMethodUnitProbe passed, including a separate 96-matrix
exhaustive CTC path oracle
1,200 exact brute-force CTC oracle matrices passed finite ranking
```

No local model training, Core ML conversion, or full-corpus scan ran during
this audit.
