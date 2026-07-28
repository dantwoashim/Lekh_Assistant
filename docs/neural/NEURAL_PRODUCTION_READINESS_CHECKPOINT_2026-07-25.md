# Neural Production Readiness Checkpoint — 2026-07-25

> Superseded by the
> [2026-07-28 checkpoint](NEURAL_PRODUCTION_READINESS_CHECKPOINT_2026-07-28.md).
> This file is retained as an immutable historical record.

This checkpoint records the current implementation, research conclusions,
verified evidence, and unresolved findings for the Lekh neural transliterator.
It is intentionally honest: the neural model is **not yet production-ready**.
The deterministic engine remains the default product path.

## Current evidence

Two controlled architecture screens have completed from the same 250,000-row
training / 25,000-row development sample, for three epochs:

| Candidate | Parameters | Development loss | 800-row top-1 | 800-row top-3 |
|---|---:|---:|---:|---:|
| GRU encoder-decoder baseline | 1,359,779 | 0.637650 | 0.45750 | 0.73000 |
| Bidirectional GRU + additive attention | 3,152,835 | 0.553645 | 0.51875 | 0.77500 |

The attention candidate is the provisional leader, but these screens are not
promotion evidence. They were deliberately exported without Core ML, predate
the latest trainer/config identities, and were not scored by the complete
official benchmark and packaged-runtime gates.

The locked external comparison reference currently records:

- overall top-1/top-3: `0.668543 / 0.832313`
- native-frequent top-1/top-3: `0.804015 / 0.915392`
- Indian-name top-1/top-3: `0.551020 / 0.768707`
- foreign-name top-1/top-3: `0.490820 / 0.711138`

No candidate is selected until its exact compiled Core ML bytes pass the
repository gold evaluation, the 4,085-row official benchmark, packaged
full-candidate latency evidence, and deterministic selection.

## Implemented in this checkpoint

### Architecture-neutral qualification

- Phase 4 now resolves either the single-model baseline or the split
  encoder/decoder-step attention layout from an allowlisted canonical config.
- Candidate manifests must remain immutable and
  `productionEligible=false`; only the promotion phase may construct a
  production manifest.
- Training, export, checkpoint, vocabulary, dataset, gold, official benchmark,
  predictions, compiled bundles, and run IDs are joined into one evidence
  graph.
- The official benchmark manifest is pinned by canonical path and SHA-256, its
  suite bytes are rehashed, and exact prediction coverage is required.
- Production qualification rehashes the complete train/dev/test split bytes
  and independently scans train and dev for normalized-input overlap with the
  official benchmark.
- Split-attention compiled models and `.mlpackage` directories must resolve to
  their exact role-specific candidate paths; a manifest cannot redirect them
  to unrelated in-repository artifacts.
- Gold suite IDs are injected exactly as the Python producer does, preserving
  legitimate cross-suite duplicate assertions.
- Phase 4 distinguishes structural prediction coverage from model quality:
  model-outcome failures remain Phase 5 concerns instead of being mislabeled
  as missing/corrupt prediction evidence.

### Promotion and packaging evidence

- A live Phase 9 promotion-receipt verifier now reopens and rehashes the
  promoted bundle and every retained input instead of trusting an old report.
- The receipt schema consistently treats vocabulary as a retained regular
  file and model/package artifacts as directories, fixing the previous
  impossible positive verification path.
- Promotion IDs are reconstructed from the same inventory used by the
  promoter for both baseline and split-attention candidates.
- The verifier derives the production manifest from the retained candidate,
  evaluation metrics, packaged performance evidence, and report paths; edited
  metrics or performance cannot pass merely by updating a manifest hash.
- Package-mode policy now closes the experimental/production mode matrix and
  binds model/runtime branch, run IDs, vocabulary, exact artifact roles,
  canonical roots, hashes, byte counts, and Phase 9 receipt identity.
- Final packaged-neural evidence is a closed contract over the bytes that
  actually remain in the published app after copying/signing, including the
  production promotion receipt when and only when the model is
  production-eligible.

## Latest adversarial findings

Resolved:

1. Phase 4 was baseline-only and inspected old production paths instead of
   immutable candidate paths.
2. A valid Phase 9 receipt could never pass: vocabulary was inspected as a
   directory, and the verifier reconstructed the promotion ID from a different
   artifact set than the producer.
3. Split-attention manifests could redirect role artifacts to arbitrary
   in-repository paths when all report fields were rewritten consistently.
4. Gold predictions for compatible duplicate inputs failed because JavaScript
   qualification omitted the producer-added `suiteId`.
5. Official benchmark isolation was previously a self-reported zero rather
   than an independent production scan.
6. Package mode and final published-byte evidence were open enough to accept
   incomplete or redirected artifact inventories.

Still open and therefore release-blocking:

1. Phase 4 hashes the vocabulary but does not yet enforce its full semantic
   native-runtime contract: special-token IDs, inverse contiguous token maps,
   Unicode-scalar token validity, decoder limits, dataset bindings, and native
   runtime policy must be validated directly.
2. `package-macos-imk-dev.mjs` does not yet consume the new package-mode and
   final-byte contracts or invoke live Phase 9 verification in production
   mode.
3. Phase 4 needs complete positive baseline and split-attention fixtures plus
   adversarial vocabulary, split-artifact, isolation-scan, symlink, malformed
   UTF-8, and concurrent-mutation tests.
4. Fresh canonical training runs have not completed under the latest trainer
   and config hashes. The controlled screens are stale by design.
5. The selected candidate has not yet been exported, evaluated, packaged, and
   benchmarked end-to-end on its exact final Core ML bytes.
6. Actual Neural Engine placement has not been proven. Requesting an eligible
   compute-unit set is not evidence that every operation ran on the Neural
   Engine.

## Research conclusions

### Core ML deployment choice

ML Programs are the correct representation for this project: Apple recommends
the format, it is available from macOS 12, and FP16 is the default conversion
precision. Lekh targets macOS 13, so the current `mlprogram`/FP16 direction is
compatible with the supported OS floor.

Apple's stateful-model facility starts at macOS 15. Raising the app floor from
macOS 13 merely to use implicit recurrent state would be an unjustified
compatibility regression. The split attention encoder/decoder-step design
therefore remains explicitly stateless at the Core ML boundary, with recurrent
state passed through tensors.

`ComputeUnit.ALL` makes the Neural Engine available, while `CPU_AND_NE`
excludes the GPU and is available on macOS 13+. Neither setting alone proves
Neural Engine execution. Promotion must retain measured compute-placement and
packaged end-to-end latency evidence from the exact candidate.

Primary sources:

- [Apple: Stateful Models](https://apple.github.io/coremltools/docs-guides/source/stateful-models.html)
- [Apple: Core ML target conversion formats](https://apple.github.io/coremltools/docs-guides/source/target-conversion-formats.html)
- [Apple: Convert Models to ML Programs](https://apple.github.io/coremltools/docs-guides/source/convert-to-ml-program.html)
- [Apple: Core ML model APIs and compute units](https://apple.github.io/coremltools/source/coremltools.models.html)

### Model and benchmark direction

Aksharantar is the correct public comparison foundation because it covers
Indic transliteration at scale and explicitly separates native-origin,
foreign-origin, frequent, and other evaluation buckets. Its official test data
must remain evaluation-only and absent from train/dev; that invariant is now
both trainer-enforced and independently production-verified.

Character-level Transformers remain a legitimate challenger: published work
shows that a properly tuned Transformer can outperform recurrent baselines on
transliteration and other character-level transduction tasks, with batch size
being particularly important. That result justifies a later compact
Transformer screen; it does not justify replacing the better measured
attention candidate without Core ML size, accuracy, and latency evidence.

Primary sources:

- [Aksharantar paper (ACL Anthology)](https://aclanthology.org/2023.findings-emnlp.4/)
- [Applying the Transformer to Character-level Transduction](https://aclanthology.org/2021.eacl-main.163/)

## Verification run at this checkpoint

```text
node --check scripts/lib/neural-training-artifact-contract.mjs
node --check scripts/lib/neural-production-promotion-receipt.mjs
npx vitest run \
  scripts/check-neural-training-contract.test.mjs \
  scripts/lib/neural-training-contract.test.mjs \
  scripts/lib/neural-artifact-descriptor.test.mjs \
  scripts/lib/neural-package-mode-policy.test.mjs \
  scripts/lib/neural-final-package-evidence.test.mjs \
  scripts/promote-neural-candidate.test.mjs

Result: 6 test files passed; 53 tests passed.

npm run lint

Result: TypeScript no-emit build, privacy check, and engine no-DOM check passed.
```

## Exact next action

Implement and adversarially test semantic vocabulary verification in Phase 4,
then wire live promotion and final published-byte evidence into the macOS
packager. Only after those contracts are green should fresh canonical model
training begin, because changing trainer/config bytes after training
invalidates the candidate by design.
