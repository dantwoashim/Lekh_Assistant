# Neural Transliteration Model Plan

## Decision

Do not ship a downloaded general model as the keyboard's neural transliterator.

The production artifact must be a small Nepali-specific Core ML student model:

- artifact: `models/macos/LekhNeuralTransliterator.mlmodelc`
- manifest: `models/macos/LekhNeuralTransliterator.manifest.json`
- selected artifact id: `lekh-small-coreml-student-v1`
- runtime: Core ML only
- parameter budget: 1M-5M
- compiled size budget: 16 MB maximum
- hot-path budget: p99 <= 3 ms for neural inference
- placement: tail reranker only, after deterministic FST, dictionary, binary lexicon, and user lexicon
- privacy: local-only inference; no network inference; no raw text telemetry

The current repo has the native Core ML loading hook and the production readiness gate. It does not contain a trained production neural model yet, so production neural readiness remains blocked until the compiled model and manifest are present.

## Upstream Selection

| Source | Role | Decision | Why |
| --- | --- | --- | --- |
| `syubraj/roman2nepali-transliteration` | primary training pairs | selected after local import/provenance review | MIT-labeled Hugging Face dataset, 2.4M Romanized/Nepali rows, train/validation split |
| `Saugatkafley/Nepali-Roman-Transliteration` | source cross-check | selected for provenance/dedup review | MIT-labeled source dataset behind the syubraj mirror |
| `ai4bharat/Aksharantar` | benchmark and augmentation | selected pending license review | large Indic transliteration benchmark including Nepali |
| `AI4Bharat/IndicXlit` | teacher and regression oracle | teacher-only, not shipping | strong public transliteration model, but about 11M params and not a compiled Core ML app artifact |
| `nirajan111/nepali-transliteration` | comparison only | rejected for shipping | mT5-sized model, page reports 400 MB; too large for an IME hot path |
| `Dakshina` | methodology reference | not selected for Nepali direct training | excellent South Asian romanization reference, but published language list does not include Nepali |

Run the source gate:

```bash
npm run check:neural-model-selection
```

Run the full neural readiness gate:

```bash
npm run neural:dataset
npm run check:neural-transliteration
```

For production:

```bash
node scripts/check-neural-model-selection.mjs --production
node scripts/check-neural-transliteration-readiness.mjs --production
```

## Required Manifest

`models/macos/LekhNeuralTransliterator.manifest.json` must include at least:

```json
{
  "selectedArtifact": "lekh-small-coreml-student-v1",
  "runtime": "CoreML",
  "localOnly": true,
  "neuralTailOnly": true,
  "parameterCount": 2500000,
  "trainingSources": [
    "syubraj-roman2nepali-transliteration"
  ],
  "metrics": {
    "tailTop1Accuracy": 0.82,
    "chatConventionTop1Accuracy": 0.9
  },
  "performance": {
    "p99Ms": 3
  },
  "requiredCases": {
    "vato": "बाटो",
    "bato": "बाटो",
    "baato": "बाटो",
    "chha": "छ",
    "cha": "छ",
    "xa": "छ",
    "xaina": "छैन"
  }
}
```

## Training Contract

The student model must be trained and evaluated outside the IMK hot path, then compiled to Core ML.

Minimum training requirements:

- normalize every row to NFC
- split by stable hash so train/dev/test do not leak duplicates
- include chat-spelling cases such as `xa`, `xaina`, `xau`, `vato`, `baato`
- preserve ambiguous outputs as multiple candidates, not a forced single truth
- evaluate native-origin, foreign-origin, frequent, rare, name, and chat-convention buckets separately
- reject unsafe/protected tokens before model training
- keep raw upstream data under ignored `data/generated/` or another non-committed research directory

Minimum release requirements:

- deterministic FST remains correct when the model is absent
- keyboard package works and does not freeze when the model is missing or fails to load
- the model is loaded only from the signed bundle or the verified per-user model directory
- no text leaves the Mac for inference or telemetry
- production packaging fails unless the compiled model, manifest, metrics, and source gate pass

## Why This Is The Right Cut

An input method is latency-sensitive. A huge seq2seq model may look impressive in a notebook, but it can make the keyboard feel broken. The production keyboard should use deterministic rules, binary lexicon ranking, and user memory for the common path, then use a tiny Core ML model for tail spellings that rules and dictionary data miss.
