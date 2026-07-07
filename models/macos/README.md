# macOS Production Neural Slot

No neural model is currently connected to or packaged by the macOS input method.

The existing closed-vocabulary linear-softmax experiment is rejected research evidence. Its manifest is stored under:

`models/rejected/closed-vocabulary-baseline/`

The compiled baseline directory remains only for reproducibility and is not a shipping input. Production packaging hard-disables neural copying.

A future production model must be open-vocabulary, use sequence decoding with beam search, include provenance and held-out evaluation, and run asynchronously outside the deterministic per-keystroke path. Both production neural gates must pass before an invocation path may be added.
