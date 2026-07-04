# macOS Neural Model Slot

This directory contains the compiled baseline Core ML transliteration tail model.

Required production files:

- `LekhNeuralTransliterator.mlmodelc`
- `LekhNeuralTransliterator.manifest.json`

The package scripts copy `LekhNeuralTransliterator.mlmodelc` into the IMK bundle only when it exists. Production neural readiness is blocked unless:

```bash
npm run check:neural-transliteration
node scripts/check-neural-model-selection.mjs --production
node scripts/check-neural-transliteration-readiness.mjs --production
```

all pass.

Do not place large Hugging Face checkpoints here. The shipping artifact must be a small local Core ML student model, not a research/teacher model.

Rebuild the current student:

```bash
npm run neural:student:setup
npm run neural:student:build
```

The current compiled baseline is a 384-feature hashed character n-gram classifier with 8,192 Devanagari output labels. It is **not** an open-vocabulary neural transliterator and must never be presented as the production SOTA model. It is allowed only as a local, confidence-gated tail candidate source after the deterministic FST, dictionary, binary lexicon, and user lexicon.

Production requires a different artifact:

- `selectedArtifact`: `lekh-open-vocab-seq2seq-v1`
- architecture: tiny GRU encoder-decoder or tiny Transformer encoder-decoder
- tokenization: BPE/unigram subword or character sequence decoder
- decoding: beam search
- ranking: previous 1-2 word context plus language-model rescoring
- behavior: confidence-gated fallback to deterministic candidates
- validation: measured packaged-app p99 latency on Apple Silicon and Intel

The production gates intentionally fail if the compiled model graph is only `inner_product + softmax`, if the manifest declares `openVocabulary=false`, or if latency was not measured on device.

To download the current offline teacher model for distillation and regression testing, run:

```bash
npm run neural:teacher:download
```

That command stores AI4Bharat IndicXlit under ignored `data/generated/` paths and records a manifest. It does not make the app production-neural-ready.
