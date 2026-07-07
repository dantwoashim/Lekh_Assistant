# Neural Transliteration Model Plan

## Decision

Do not ship a downloaded general model as the keyboard's neural transliterator.

The production artifact must follow the frozen Phase 0 open-vocabulary contract in `docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md`. It must be a small Nepali-specific Core ML sequence model:

- artifact: `models/macos/LekhNeuralTransliterator.mlmodelc`
- manifest: `models/macos/LekhNeuralTransliterator.manifest.json`
- selected artifact id: `lekh-open-vocab-seq2seq-v1`
- runtime: Core ML only
- parameter budget: 1M-5M
- compiled size budget: 16 MB maximum
- hot-path budget: p99 <= 3 ms for neural inference
- placement: tail reranker only, after deterministic FST, dictionary, binary lexicon, and user lexicon
- privacy: local-only inference; no network inference; no raw text telemetry

The current repo has a rejected closed-vocabulary baseline under `models/rejected/closed-vocabulary-baseline/` and production readiness gates. That baseline is useful only as research evidence. Public launch requires an open-vocabulary seq2seq model, real on-device latency measurement, and human-gold evaluation.

## Student Model Build

Build the current compiled Core ML student:

```bash
npm run neural:student:setup
npm run neural:student:build
```

Outputs for the rejected research baseline:

- `models/rejected/closed-vocabulary-baseline/LekhNeuralTransliterator.mlmodelc`
- `models/rejected/closed-vocabulary-baseline/LekhNeuralTransliterator.rejected.manifest.json`
- `data/generated/coreml-student/LekhNeuralTransliterator.mlmodel`
- `reports/coreml-student-transliterator-report.json`

Current student architecture:

- model family: hashed character n-gram centroid classifier
- input: `features`, a 384-dimensional FNV-1a hashed Romanized n-gram vector
- outputs: `candidate` and `classProbability`
- class count: 8,192 Devanagari labels
- parameter count: 3,153,920
- role: neural tail candidate source after deterministic FST, dictionary, binary lexicon, and user lexicon

This baseline is intentionally compact and local. It is not the final 1-5M parameter production model; that remains a separate open-vocabulary distillation/training milestone using the downloaded teacher model and a human-rated held-out set.

## Teacher Model Download

The public AI4Bharat IndicXlit Roman-to-Indic checkpoint can be downloaded locally as a teacher/regression oracle:

```bash
npm run neural:teacher:download
```

This writes the archive, extracted files, and manifest under ignored local paths:

- `data/generated/neural-teacher-models/ai4bharat-indicxlit/v1.0/`
- `reports/neural-teacher-download-report.json`

The downloader records byte count, SHA256, and source metadata. These files are intentionally not committed and must never be copied into `models/macos` or a release bundle. The production keyboard still requires a small signed Core ML student model.

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
npm run neural:source:syubraj
npm run check:neural-contract
npm run check:neural-gold
npm run check:neural-open-vocab-data
npm run check:neural-model-selection
```

Run the full neural readiness gate:

```bash
npm run neural:student:build
npm run neural:dataset
npm run neural:open-vocab:dataset
npm run check:neural-phase0-10
npm run check:neural-transliteration
```

Before any production claim, the gold row-count gate must also pass:

```bash
npm run check:neural-gold:production
npm run check:neural-open-vocab-data:production
```

These are expected to fail until real reviewed rows and required licensed/public local imports replace the Phase 1 contract seeds and local silver-only dataset.

Phase 3-9 are now executable repo gates:

```bash
npm run neural:phase3:distillation
npm run neural:phase4:training-contract
npm run neural:phase5:evaluate
npm run neural:phase5:benchmark
npm run neural:phase6:native-integration
npm run neural:phase7:review-intake
npm run neural:phase8:training-run
npm run neural:phase9:promotion
npm run neural:phase10:sota
```

In dev, Phase 3-10 prove the distillation/training/evaluation/benchmark/native/review/promotion/SOTA guard machinery is complete. They do not claim a production neural model exists. Production remains blocked until the required reviewed data imports, real model predictions, two-device Core ML measurements, trained checkpoint, and verified production manifest are present.

For production:

```bash
npm run check:neural-phase0-10:production
node scripts/check-neural-model-selection.mjs --production
node scripts/check-neural-transliteration-readiness.mjs --production
```

## Required Manifest

`models/macos/LekhNeuralTransliterator.manifest.json` must validate against `data/neural/schema/lekh-neural-manifest.schema.json` and include at least:

```json
{
  "schemaVersion": 1,
  "selectedArtifact": "lekh-open-vocab-seq2seq-v1",
  "runtime": "CoreML",
  "localOnly": true,
  "neuralTailOnly": true,
  "productionEligible": true,
  "architecture": "gru-encoder-decoder-seq2seq",
  "openVocabulary": true,
  "tokenization": "unicode-grapheme-character",
  "decoder": "beam-search",
  "beamSearch": {
    "enabled": true,
    "beamWidth": 4,
    "maxOutputGraphemes": 32
  },
  "languageModelRescorer": {
    "enabled": true,
    "source": "runtime-next-context-pack",
    "weight": 0.12
  },
  "contextWindowWords": 2,
  "parameterCount": 2500000,
  "modelBytes": 12000000,
  "trainingSources": [
    "syubraj-roman2nepali-transliteration",
    "human-reviewed-lekh-gold-v1",
    "lekh-chat-conventions-v1",
    "lekh-name-lexicon-v1"
  ],
  "datasetReports": [
    "reports/neural-open-vocab-dataset-report.json"
  ],
  "evaluationReports": [
    "reports/neural-open-vocab-evaluation.json"
  ],
  "benchmarkReports": [
    "reports/neural-coreml-device-benchmark.json"
  ],
  "metrics": {
    "tailTop1Accuracy": 0.88,
    "tailTop3Accuracy": 0.96,
    "chatConventionTop1Accuracy": 0.92,
    "chatConventionTop3Accuracy": 0.98,
    "namesTop3Accuracy": 0.9,
    "protectedFalseConversionRate": 0,
    "singleTokenPhraseExpansionRate": 0,
    "secureFieldInferenceCount": 0
  },
  "performance": {
    "p50Ms": 0.8,
    "p95Ms": 1.7,
    "p99Ms": 2.6,
    "targetP99Ms": 3,
    "measuredOnDevice": true,
    "devices": [
      {
        "name": "Apple Silicon benchmark Mac",
        "macOS": "26",
        "architecture": "arm64",
        "p99Ms": 2.2
      },
      {
        "name": "Intel benchmark Mac",
        "macOS": "15",
        "architecture": "x86_64",
        "p99Ms": 2.9
      }
    ]
  },
  "requiredCases": {
    "vato": "बाटो",
    "bato": "बाटो",
    "baato": "बाटो",
    "chha": "छ",
    "cha": "छ",
    "xa": "छ",
    "xaina": "छैन"
  },
  "sha256": {
    "compiledModel": "0000000000000000000000000000000000000000000000000000000000000000",
    "sourceCheckpoint": "0000000000000000000000000000000000000000000000000000000000000000",
    "trainingDatasetManifest": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "limitations": [
    "Neural candidates are tail suggestions only.",
    "Neural candidates are never auto-committed.",
    "No inference runs in secure fields."
  ]
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
- the packaged app has measured native p99 neural-candidate latency on Apple Silicon and Intel hardware
- top-word and chat-convention accuracy is validated against a human-gold set, not only generated splits

## Why This Is The Right Cut

An input method is latency-sensitive. A huge seq2seq model may look impressive in a notebook, but it can make the keyboard feel broken. The production keyboard should use deterministic rules, binary lexicon ranking, and user memory for the common path, then use a tiny Core ML model for tail spellings that rules and dictionary data miss.
