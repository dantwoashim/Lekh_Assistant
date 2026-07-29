# Remote CUDA Training and macOS Core ML Export

Status: production-candidate workflow.

This workflow moves sustained PyTorch training off the Mac without changing
the model, dataset, seed, training contract, or qualification gates. A
checksum-pinned Google Colab notebook trains on an exact CUDA 11.8 toolchain.
The Mac performs only bundle construction, authenticated result import, and
the shorter Core ML conversion and parity phase.

No Apple Developer ID is required. A paid Developer ID is relevant to public
signing and notarization, not to Colab training or local Core ML conversion.
Full Xcode is still required later for Instruments-based Neural Engine
placement evidence.

## Why this keeps the Mac cool

The 625 MB uncompressed training inventory is packaged once into an
approximately 99 MB archive. All epoch-sized forward passes, backpropagation,
optimizer steps, and CUDA tensor work happen in Colab. The Mac later loads the
returned checkpoint on CPU and performs a bounded Core ML export.

Each completed epoch is mirrored to
`MyDrive/Lekh-Neural-Training`. A disconnected Colab runtime therefore resumes
from the newest authenticated epoch instead of repeating completed work. Only
the two newest recovery generations are retained.

## Exact execution profiles

| Phase | Python | PyTorch | Accelerator |
| --- | --- | --- | --- |
| Remote training | 3.11.15 | 2.7.0+cu118 | CUDA 11.8 |
| macOS export | 3.11.x | 2.7.0 | Core ML |

The remote notebook installs the exact non-PyTorch packages from
`requirements/neural-open-vocab.lock`, then installs the complete CUDA closure
from `requirements/neural-open-vocab-cu118.lock` using the official PyTorch
CUDA 11.8 index. The CUDA lock pins PyTorch, Triton, and all eleven NVIDIA
runtime distributions required by that wheel. The notebook runs `pip check`;
the remote verifier then rejects any Python patch, package version, CUDA
runtime, PyTorch local version tag, architecture, or deterministic-runtime
drift.

PyTorch publishes CUDA 11.8 as an official 2.7.0 wheel target:
[PyTorch previous versions](https://pytorch.org/get-started/previous-versions/).
Colab documents that free GPU types and runtime availability are not
guaranteed:
[Colab FAQ](https://research.google.com/colaboratory/faq.html).

## 1. Build the authenticated bundle

From the repository root:

```sh
npm run neural:remote:test

npm run neural:remote:bundle -- \
  --output-dir .tmp/neural-remote-training
```

The builder emits three write-once files:

- `*.tar.gz`: exact trainer, verifier, config, dataset, gold suites, benchmark,
  base dependency lock, and CUDA dependency lock;
- `*-Colab.ipynb`: bundle-specific notebook with the archive name, byte count,
  SHA-256, and bundle identity embedded;
- `*.bundle-report.json`: trusted local sidecar used when importing the result.

Do not rename, edit, or separately recompress the archive. The notebook accepts
only the exact emitted bytes.

## 2. Train in Colab

1. Sign into the intended Google account and open Colab.
2. Upload the generated `*-Colab.ipynb`.
3. Choose **Runtime → Change runtime type → GPU**.
4. Run the cells in order.
5. When the first code cell asks for a file, upload the matching `*.tar.gz`.
6. Approve the Google Drive mount for the same account.
7. Let the training cell finish or resume it after a disconnect.
8. Run the final cell to download the authenticated `*-cuda-result-*.tar.gz`.

The Drive mount gives that Colab runtime access to the selected Drive. The
workflow writes under `MyDrive/Lekh-Neural-Training`; it does not intentionally
read unrelated Drive content. The bundle contains the repository training
dataset and evaluation suites, so choose the Google account deliberately.

The training subprocess runs with `-B`, `PYTHONDONTWRITEBYTECODE=1`,
`PYTHONHASHSEED=42`, and `CUBLAS_WORKSPACE_CONFIG=:4096:8`. This prevents Python
imports from mutating the authenticated extraction and preserves the
deterministic CUDA contract. Linux warnings that Core ML proxy modules are
unavailable are expected during the training-only phase; Core ML conversion
occurs later on macOS.

## 3. Verify and stage the remote result

Use the result archive SHA-256 printed by the final Colab cell:

```sh
npm run neural:remote:import -- \
  <cuda-result.tar.gz> \
  --bundle-report <bundle-report.json> \
  --expected-result-sha256 <sha256>
```

The first import is review-only. It verifies the outer archive digest, closed
inventory, bundle identity, exact local trainer/config/data/gold snapshot,
CUDA provenance, safe tensor-only checkpoint loading, architecture dimensions,
vocabulary bytes, and report/checkpoint identity.

Publish only after that command passes:

```sh
npm run neural:remote:import -- \
  <cuda-result.tar.gz> \
  --bundle-report <bundle-report.json> \
  --expected-result-sha256 <sha256> \
  --publish
```

If the canonical candidate already exists, publication refuses to overwrite it.
Passing `--replace-existing` moves the old candidate to a recoverable
`.tmp/neural-remote-imports/backups/` directory before the atomic replacement.

## 4. Export and qualify on the Mac

```sh
npm run neural:remote:export
```

The default is deliberately bound to the active
`data/neural/training/open-vocab-ctc-transformer-v2.config.json` candidate.
Historical candidates require an explicit `--config`; they can never become
the implicit export target.

The export command requires a completed CUDA training report, loads the
checkpoint on CPU, converts the single Transformer-CTC model to a Neural
Engine-eligible Core ML ML Program under the locked FP16 policy, compiles the
exact artifact, runs PyTorch/Core ML parity, generates locked-gold and
official-benchmark predictions, and records local measurements.

The candidate remains unpromoted until all normal quality, safety, packaged
latency, and runtime-placement gates pass. Core ML compute-unit eligibility is
not Neural Engine placement proof.

## Failure and recovery rules

- Wrong archive or modified bytes: upload verification stops before extraction.
- Missing GPU, incomplete CUDA dependency closure, or wrong CUDA wheel:
  toolchain verification stops before training.
- Runtime disconnect: rerun the notebook; the newest valid Drive epoch is
  restored.
- Different GPU/runtime fingerprint: resume fails closed; use a compatible
  runtime or explicitly restart.
- Corrupt result or forged metadata: local import refuses publication.
- Core ML parity or quality failure: keep the deterministic product path and
  reject the neural candidate.

The free Colab service remains an availability dependency, not a release
guarantee. Training success is not production readiness; the returned candidate
must still pass the Mac-side evidence gates.
