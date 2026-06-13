# macOS Neural Model Slot

This directory contains the compiled baseline Core ML transliteration student.

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

The current compiled baseline is a 384-feature hashed character n-gram classifier with 8,192 Devanagari output labels. It is a local neural tail candidate source, not the final transformer-quality model.

To download the current offline teacher model for distillation and regression testing, run:

```bash
npm run neural:teacher:download
```

That command stores AI4Bharat IndicXlit under ignored `data/generated/` paths and records a manifest. It does not make the app production-neural-ready.
