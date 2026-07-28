# Neural Production Readiness Checkpoint — 2026-07-28

This is the current neural-readiness checkpoint. It supersedes the 2026-07-25
checkpoint.

The conclusion remains deliberately strict: **no Lekh neural model is
production-ready yet**. The deterministic engine remains the shipping default,
and neural typing remains experimental, off by default, and absent from normal
v1 packages.

## What this iteration closed

### Executable vocabulary semantics

Phase 4 no longer treats a correctly hashed vocabulary file as sufficient. It
now independently validates the state consumed by the Swift runtime:

- exact closed schema and schema version;
- canonical model, tokenization, config, manifest, and dataset identities;
- contiguous inverse token maps with unique tokens;
- exact PAD, SOS, EOS, and UNK identities;
- lowercase ASCII-only input lexical scalars;
- one-scalar Devanagari-or-joiner output lexical tokens;
- decoder width, step bound, output validator, Latin rejection, and whitespace
  rejection;
- train/dev/test split digests and native fail-safe policy;
- strict UTF-8 decoding before JSON or JSONL parsing.

Malformed UTF-8, altered inverse maps, duplicate tokens, invalid token classes,
and self-consistent forged bindings now fail adversarial tests.

### Independently derived split tensor contract

The attention candidate's Core ML interface is now derived from the canonical
config and runtime vocabulary instead of trusting a report that describes its
own outputs. The verifier reconstructs every encoder and decoder-step feature
name, shape, role, and data type, including:

- bidirectional encoder width (`hiddenDim × 2`);
- decoder layer, beam, hidden, attention, and vocabulary dimensions;
- exact `INT32` token inputs and `FLOAT16` state/logit tensors.

A manifest and export report cannot pass by agreeing with the same forged
tensor shapes.

### Exact final-package chain

Production packaging now:

1. live-reopens and verifies the Phase 9 promotion receipt;
2. applies the closed neural package-mode policy;
3. copies only the resolved artifact roles, vocabulary, manifest, and exact
   production receipt;
4. writes final packaged-neural evidence from the copied bytes;
5. re-verifies those bytes before signing, after signing, and after atomic
   publication;
6. restores the previous published bundle if post-publication verification
   fails.

The previous receipt-schema mismatch was also fixed: the promoter emits the
canonical v2 receipt, and the final verifier now requires that exact version.

### Honest Neural Engine evidence

The earlier compute-plan interpretation was too strong. Apple distinguishes a
compute unit that can support an operation from the unit that actually executed
it. `MLComputePlan` is therefore retained as compatibility evidence only and
can never authorize a Neural Engine execution claim.

A new runtime-placement contract binds a live Core ML + Neural Engine
Instruments capture to the exact manifest, vocabulary, artifact-set digest,
compiled role hashes, workload, process, prediction intervals, and observed
hardware activity. The model selector, promoter, live receipt verifier,
runtime-conformance gate, packaged benchmark, and final readiness gate all
revalidate that identity.

The workload binding is now executable rather than descriptive. The native
probe and JavaScript validator share one closed schedule: the ordered tokens
`prashasan`, `nagarikta`, `mantralaya`, `sambidhan`, and `paryatan`, one
five-request warm-up pass, and eight measured passes (40 requests). The
canonical schedule SHA-256 is
`a7748ab8af3e7dd3fd555e82d9d509e9f5780279bb4c8bc43b1dc812ee8473ea`.
A trace summary with a substituted corpus, reordered tokens, missing request,
or shortened per-token sample stream now fails before it can authorize a
Neural Engine claim.

The capture procedure and allowed claim language are documented in
[NEURAL_ENGINE_RUNTIME_PLACEMENT.md](NEURAL_ENGINE_RUNTIME_PLACEMENT.md).

### Current supported conversion toolchain

Apple released Core ML Tools 9.0 after the repository's 8.3 pin. Apple also
recommends using the latest converter because conversion passes continue to
improve. An isolated compatibility run exercised Lekh's baseline and split
attention training, TorchScript conversion, ML Program export, compilation,
known-answer parity, and complete pipeline tests with:

- Python 3.11;
- PyTorch 2.7.0, the newest line explicitly supported by Core ML Tools 9.0;
- NumPy 1.26.4;
- Core ML Tools 9.0.

All 33 tests passed. These versions and their complete 18-distribution runtime
closure are now exact setup pins, and a new fail-closed toolchain check prevents
an old or partially drifted virtual environment from silently publishing a
candidate.

PyTorch 2.7 removed the earlier process crash in a direct two-layer GRU MPS
stress test. It did **not** provide bitwise deterministic training on this Mac:
two identical seeded attention runs produced the same final loss but different
state hashes (`51be4b…` versus `c466f6…`) even with deterministic algorithms
enabled. Canonical publication training therefore remains on CPU.

Primary references:

- [Core ML Tools 9.0 release](https://github.com/apple/coremltools/releases/tag/9.0)
- [Apple Core ML Tools conversion FAQ](https://apple.github.io/coremltools/docs-guides/source/faqs.html)
- [Apple target conversion formats](https://apple.github.io/coremltools/docs-guides/source/target-conversion-formats.html)
- [PyTorch releases](https://github.com/pytorch/pytorch/releases)
- [Optimize your Core ML usage (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10027/)
- [Xcode command-line tool reference](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)
- [Apple Developer membership comparison](https://developer.apple.com/support/compare-memberships/)

Core AI, introduced at WWDC26, is not a drop-in reason to raise Lekh's macOS 13
deployment floor. The current ML Program design remains the compatible
production path for supported Lekh Macs.

### Canonical dataset reconstruction

The production read-only reconstruction gate initially rejected the local
generated corpus. Its manifest predated the final scalar-sequence validator
fix, so its split bytes were stale even though the source files were unchanged.
Training was not started against those bytes.

The corpus was regenerated from the current locked builder, source registry,
private Aksharantar import, gold release, schema, and validator, then
reconstructed again in read-only production mode. The second pass was
byte-identical and passed:

- total rows: 1,048,532;
- train/dev/test: 871,498 / 87,371 / 89,663;
- dataset content SHA-256:
  `15909aac528fa0f2fb590e62981b0a0035422aa2673f9de4c7bc47ba2e778599`.

## Verification completed

```text
npm exec -- vitest run scripts/**/*neural*.test.mjs scripts/*neural*.test.mjs
Result: 26 files passed; 190 tests passed.

PYTHONPATH=.tmp/coremltools9-overlay \
  .tmp/neural-seq2seq-venv/bin/python \
  scripts/train-open-vocab-seq2seq-transliterator.test.py
Result: 33 tests passed with Core ML Tools 9.0 and PyTorch 2.3.1.

PYTHONPATH=.tmp/coremltools9-overlay:.tmp/torch27-overlay \
  .tmp/neural-seq2seq-venv/bin/python \
  scripts/train-open-vocab-seq2seq-transliterator.test.py
Result: 33 tests passed with Core ML Tools 9.0 and PyTorch 2.7.0.

swift build --package-path native/macos-imk/skeleton \
  --target LekhInputMethodBehaviorProbe
Result: passed.

npm run check:neural-contract
npm run format:check
npm run lint
git diff --check
Result: passed.

npm run neural:open-vocab:test
Result: 4 toolchain tests and 33 training/export tests passed under the pinned
Python 3.11 / PyTorch 2.7.0 / NumPy 1.26.4 / Core ML Tools 9.0 environment.

npm test
Result: 105 files passed, 1 skipped; 936 tests passed, 1 skipped.

npm run test:native-swift
Result: native candidate, delimiter, four-mode, neural admission, decoder, and
manifest-identity contracts passed.

npm run neural:open-vocab:dataset
npm run check:neural-open-vocab-data:production
Result: current corpus regenerated; 1,048,532 rows; read-only deterministic
production reconstruction passed.
```

The skipped JavaScript test is the repository's pre-existing conditional test,
not a failure introduced by this checkpoint.

## Current machine truth

- Apple Silicon: Apple M4, 16 GiB memory.
- macOS: 26.2.
- Active developer directory: Command Line Tools only.
- Full Xcode/Instruments: absent.
- Free disk during this checkpoint: approximately 20 GiB.
- Canonical neural environment: Python 3.11.15, PyTorch 2.7.0, NumPy 1.26.4,
  Core ML Tools 9.0.
- Canonical open-vocabulary dataset: present; approximately 597 MiB across
  train/dev/test.

Full Xcode is free and does not require the $99 Apple Developer Program.
However, the present disk margin is unsafe for installing and expanding the
current Xcode distribution. This is the blocker for an honest runtime-placement
trace, not Developer ID authentication.

## Remaining production blockers

1. A fresh full canonical attention training run has not completed under the
   current trainer, config, dataset, and toolchain identities.
2. No current candidate has completed exact Core ML export, compiled-runtime
   known-answer parity, locked gold evaluation, the 4,085-row official
   benchmark, and deterministic two-candidate selection.
3. No exact candidate has passed packaged full-candidate latency, secure-field,
   cancellation, runtime-conformance, and promotion evidence end to end.
4. No valid live Core ML + Neural Engine Instruments trace exists for the exact
   packaged roles.
5. The runtime-placement JSON contract is closed and exact, but a raw
   `.trace`/export normalizer cannot be proven against the current Xcode format
   until full Xcode and a real sample trace are available. A manually authored
   JSON record is not sufficient production proof.
6. Phase 4 has broad adversarial component coverage, but its final positive
   fixture must still be exercised with the genuine full-run evidence graph.

These are evidence gaps, not paperwork. None may be converted into a claim.

## Next execution order

1. Complete the deterministic full attention training run.
2. Export and compile its exact ML Programs; run source-versus-Core-ML
   known-answer parity.
3. Generate and evaluate locked gold and official benchmark predictions.
4. Train/export the required second distinct candidate and run deterministic
   selection.
5. Package the selected candidate and collect exact full-candidate performance.
6. Free sufficient disk, install free Xcode, capture and normalize the live
   Core ML + Neural Engine trace.
7. Promote, package, reopen, rehash, and rerun every production gate.

Until all seven steps produce passing evidence, the neural model remains
experimental.
