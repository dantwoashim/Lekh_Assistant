# CTC seed-43 challenger runbook

This is the finite second-candidate path for the active Transformer-CTC
bundle. It changes exactly one training value: seed `42` becomes `43`.
The model ID remains `lekh-open-vocab-ctc-transformer-v2`.

The challenger is not a replacement for candidate one:

- candidate one:
  `data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2`
- challenger:
  `data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2--seed-43`
- Kaggle working scope:
  `/kaggle/working/Lekh-Neural-Training-Kaggle--seed-43`
- first training invocation: `--restart-training`
- later recovery: only the challenger working scope and its `seed-43`
  recovery namespace

The notebook refuses candidate-one output inside its extracted tree. The
trainer also records the exact seed override and four derived output-path
overrides in the checkpoint and training report. Import and export reject
anything else.

The Kaggle notebook kernel never imports the trainer or PyTorch. It writes an
exact checksum-pinned challenger wrapper under its protected bootstrap
directory, then launches that wrapper with the verified Python 3.11.15 venv
using `-u -B`. The subprocess environment pins
`PYTHONHASHSEED=43`, `CUBLAS_WORKSPACE_CONFIG=:4096:8`,
`PYTHONDONTWRITEBYTECODE=1`, and `PYTHONUNBUFFERED=1`. The authenticated
runner, trainer, and PyTorch 2.7.0+cu118 load only inside that subprocess.

## Frozen active bundle

- bundle ID:
  `abc8ecfb2bfbcf3201cc2ad741b8c7ca98714882d25e93a0c38b900b3f136296`
- archive SHA-256:
  `b5968bad47dbeda072e213ee9e649ba5d14645f62e938a4524fae977d6684628`
- manifest SHA-256:
  `d6df5e38ec525ceb17c9001f1cd26ce06f7c6987a1bd90b620341d1b16026df7`
- archive bytes: `99,316,415`

The manifest authenticates these 26 repository inputs:

1. `data/generated/neural-open-vocab/dev.jsonl`
2. `data/generated/neural-open-vocab/manifest.json`
3. `data/generated/neural-open-vocab/test.jsonl`
4. `data/generated/neural-open-vocab/train.jsonl`
5. `data/neural/benchmarks/aksharantar-nepali-test-v1/foreign-names.jsonl`
6. `data/neural/benchmarks/aksharantar-nepali-test-v1/indian-names.jsonl`
7. `data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json`
8. `data/neural/benchmarks/aksharantar-nepali-test-v1/native-frequent.jsonl`
9. `data/neural/gold/adversarial-neural-tail-gold.v1.jsonl`
10. `data/neural/gold/ambiguity-gold.v1.jsonl`
11. `data/neural/gold/chat-convention-token-only-gold.v2.jsonl`
12. `data/neural/gold/manifest.v3.json`
13. `data/neural/gold/names-gold.v1.jsonl`
14. `data/neural/gold/non-nepali-pass-through-gold.v1.jsonl`
15. `data/neural/gold/protected-token-gold.v1.jsonl`
16. `data/neural/gold/romanized-nepali-token-gold.v1.jsonl`
17. `data/neural/training/open-vocab-ctc-transformer-v2.config.json`
18. `requirements/neural-open-vocab-cu118.lock`
19. `requirements/neural-open-vocab.lock`
20. `scripts/check-neural-open-vocab-toolchain.py`
21. `scripts/lib/neural_ctc_transformer.py`
22. `scripts/lib/neural_remote_artifacts.py`
23. `scripts/run-neural-remote-training.py`
24. `scripts/train-open-vocab-ctc-transformer.py`
25. `scripts/train-open-vocab-seq2seq-transliterator.py`
26. `scripts/verify-neural-remote-training-bundle.py`

The challenger implementation is additive and outside this inventory. The
builder checks this boundary again before rendering. Do not edit or rebuild
the active archive for the challenger.

## Build the notebook

Use the exact active report, archive, and original authenticated Colab
notebook. Keep the generated notebook outside the iCloud-synced repository
working tree:

```bash
python3.11 scripts/build-neural-kaggle-challenger-notebook.py \
  --bundle-report .tmp/neural-remote-training-ctc-deterministic/lekh-neural-lekh-open-vocab-ctc-transformer-v2-cuda-training-abc8ecfb2bfbcf32.bundle-report.json \
  --archive .tmp/neural-remote-training-ctc-deterministic/lekh-neural-lekh-open-vocab-ctc-transformer-v2-cuda-training-abc8ecfb2bfbcf32.tar.gz \
  --source-notebook .tmp/neural-remote-training-ctc-deterministic/lekh-neural-lekh-open-vocab-ctc-transformer-v2-cuda-training-abc8ecfb2bfbcf32-Colab.ipynb \
  --output /private/tmp/Lekh-CTC-Seed-43-Kaggle.ipynb
```

The builder verifies the report, archive, source notebook, embedded archive
verifier, closed manifest, exact active identity, and frozen-inventory
separation before writing deterministic notebook bytes.

## Run on Kaggle

1. Create a private Kaggle notebook from
   `/private/tmp/Lekh-CTC-Seed-43-Kaggle.ipynb`.
2. Add the exact active `tar.gz` as its only matching private input.
3. Enable GPU and Internet, then run the cells in order.
4. Download the result archive and `LATEST_RESULT.json` from the notebook's
   dedicated output folder.

Do not add candidate-one recovery files. The first invocation starts fresh.
Re-running the training cell may resume only recovery produced inside this
seed-43 notebook.

## Import beside candidate one

```bash
.tmp/neural-seq2seq-venv/bin/python \
  scripts/import-neural-remote-training-result.py \
  /path/to/lekh-neural-lekh-open-vocab-ctc-transformer-v2-RESULT-cuda-result.tar.gz \
  --bundle-report .tmp/neural-remote-training-ctc-deterministic/lekh-neural-lekh-open-vocab-ctc-transformer-v2-cuda-training-abc8ecfb2bfbcf32.bundle-report.json \
  --expected-result-sha256 RESULT_SHA256 \
  --candidate-profile seed-43-challenger-v1 \
  --publish
```

This publishes only the sibling `--seed-43` root. It does not replace the
canonical candidate-one directory.

## Export on macOS

```bash
.tmp/neural-seq2seq-venv/bin/python \
  scripts/export-neural-remote-training-result.py \
  --config data/neural/training/open-vocab-ctc-transformer-v2.config.json \
  --candidate-profile seed-43-challenger-v1
```

The exporter reconstructs the exact seed and sibling-path overrides before
loading the checkpoint. A candidate trained with seed 42, stored in the
canonical root, or carrying unrecorded overrides fails closed.

## Short verification

These checks do not train or convert a model:

```bash
python3.11 scripts/lib/neural_remote_candidate_profile.test.py
python3.11 scripts/lib/neural_remote_kaggle_challenger_notebook.test.py
python3.11 scripts/build-neural-kaggle-challenger-notebook.test.py
.tmp/neural-seq2seq-venv/bin/python \
  scripts/neural-remote-seed-43-integration.test.py
```

Passing scaffolding tests prove identity, isolation, deterministic notebook
generation, and import/export contract wiring. They do not claim a trained
challenger or model-quality result.
