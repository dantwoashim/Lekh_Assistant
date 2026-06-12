# macOS Neural Model Slot

This directory is intentionally empty until a real production Core ML transliteration model is trained, evaluated, and compiled.

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
