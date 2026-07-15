# macOS Neural Model Slot

The current `models/macos/LekhNeuralTransliterator.mlmodelc` is an open-vocabulary GRU encoder-decoder candidate exported from:

`scripts/train-open-vocab-seq2seq-transliterator.py`

Its manifest is:

`models/macos/LekhNeuralTransliterator.manifest.json`

This is a real, locally loadable Core ML export, but it is not a production model. The native input method can package and invoke it only when the bundle carries the explicit experimental override. That path is an asynchronous candidate tail; it is never the deterministic per-keystroke path and is never an auto-commit authority.

`LekhNeuralCandidateService` now treats the model, manifest, and vocabulary as one indivisible artifact. Before even experimental inference it verifies:

- the exact supported manifest/vocabulary schema and frozen artifact identity;
- local-only, async-only, secure-field-denial, fail-open, and neural-tail-only runtime policies;
- the SHA-256 digest and byte count of the complete compiled `.mlmodelc` tree;
- the SHA-256 digest of the exact vocabulary JSON bytes;
- vocabulary bijections, special-token IDs, decoder agreement, and dataset-manifest identity;
- exact Core ML inputs `inputIds: int32[1,32]` and `decoderInputIds: int32[1,31]`;
- exact Core ML output `logits: float16[1,31,1052]`.

For a future production artifact, `productionEligible: true` is only one input to the gate. The runtime also requires the production quality floors, reviewed-source provenance, packaged-app arm64 and x86_64 device evidence, zero secure-field inference, and zero phrase expansion. It then runs the required known-answer suite on the neural queue. Production inference stays disabled until that semantic attestation passes.

Current production blockers are intentional:

- private human-reviewed Phase 7 sources are absent;
- manifest tail top-1 is `0.47` (required: `>= 0.88`) and names top-3 is `0` (required: `>= 0.90`);
- benchmark evidence is local arm64 model timing, not packaged-app arm64 plus x86_64 evidence;
- the manifest claims `runtime-next-context-pack` rescoring, but the native neural handoff currently supplies only the active token and appends the result as an unranked tail;
- native host-matrix cancellation, secure-transition, and end-to-end candidate-quality evidence is incomplete;
- `productionEligible` remains `false`.

The old closed-vocabulary linear-softmax experiment remains quarantined under:

`models/rejected/closed-vocabulary-baseline/`

Production packaging must continue to hard-disable neural copying until `npm run check:neural-phase0-10:production` passes without blockers. Developer ID signing, notarization, and a signed release bundle remain separate mandatory release gates; runtime hashing does not replace code signing.
