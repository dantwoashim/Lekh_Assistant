# macOS Neural Model Slot

The current `models/macos/LekhNeuralTransliterator.mlmodelc` is an open-vocabulary GRU encoder-decoder candidate exported from:

`scripts/train-open-vocab-seq2seq-transliterator.py`

Its manifest is:

`models/macos/LekhNeuralTransliterator.manifest.json`

This candidate is real Core ML export evidence, but it is not production eligible yet. It remains disconnected from and un-packaged by the macOS input method until the production gates pass.

Current production blockers are intentional:

- private human-reviewed Phase 7 sources are absent;
- seed-gold accuracy is below production floors;
- benchmark evidence is local arm64 model timing, not packaged-app arm64 plus x86_64 evidence;
- native async Core ML tail integration is not implemented;
- `productionEligible` remains `false`.

The old closed-vocabulary linear-softmax experiment remains quarantined under:

`models/rejected/closed-vocabulary-baseline/`

Production packaging must continue to hard-disable neural copying until `npm run check:neural-phase0-10:production` passes without blockers.
