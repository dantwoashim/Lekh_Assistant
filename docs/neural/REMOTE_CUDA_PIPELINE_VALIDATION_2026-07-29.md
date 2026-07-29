# Remote CUDA Pipeline Validation — 2026-07-29

Status: live Colab/Tesla T4 launch verified; full training completion is not
yet claimed.

## Local verification

The following focused suites passed:

```sh
npm run neural:remote:test

.tmp/neural-seq2seq-venv/bin/python \
  scripts/check-neural-open-vocab-toolchain.py

.tmp/neural-seq2seq-venv/bin/python \
  scripts/check-neural-open-vocab-toolchain.test.py

.tmp/neural-seq2seq-venv/bin/python \
  scripts/train-open-vocab-seq2seq-transliterator.test.py

node node_modules/vitest/vitest.mjs run \
  scripts/check-neural-training-contract.test.mjs \
  scripts/lib/neural-training-contract.test.mjs
```

Observed results:

- closed-archive and inventory tests: 6 passed;
- generated-notebook tests: 1 passed;
- remote runner and epoch-recovery tests: 4 passed;
- authenticated result-import tests: 5 passed;
- exact toolchain-profile tests: 7 passed;
- trainer and Core ML contract/parity tests: 35 passed;
- JavaScript neural training-contract tests: 28 passed.

The Core ML suite requires access to the macOS system temporary compilation
directory. Its first sandbox-restricted invocation could not compile there;
the same 35-test suite passed with that operating-system access enabled. This
was a test-environment restriction, not a model failure.

## Authenticated bundle under training

| Evidence | Value |
| --- | --- |
| Model | `lekh-open-vocab-bigru-attention-v1` |
| File count | 24 |
| Uncompressed input bytes | 625,510,773 |
| Archive bytes | 99,275,788 |
| Bundle ID | `7c5cb7901a7fab8d2dd9b2d6674a3e551f0a5009e07575a15cc75ec7d616ae3d` |
| Archive SHA-256 | `7bbae443d4168c502dfce7a1d52109a1891bfc2a90d748408b1b26499296dbf9` |
| Manifest SHA-256 | `268f03a18358dfb63bb66ccde86b2b53be2b4a32cd41f3bfb657f051946e56e4` |
| Notebook SHA-256 | `a06dc3d07a38479dba3cb8a9ab5c4d7b9327dc93623afec1c645428479d2432e` |
| Dataset identity | `15909aac528fa0f2fb590e62981b0a0035422aa2673f9de4c7bc47ba2e778599` |

Two independent local builds reproduced the dataset identity and deterministic
archive contract. The final bundle was then reopened by the standalone
verifier, which authenticated and atomically extracted all 24 declared files.
Running its bundled launcher without `-B` produced no `__pycache__` mutation,
and the closed archive still verified afterward.

## Live Colab preflight

The final bundle passed these checks in a fresh Google Colab GPU runtime:

| Check | Observed |
| --- | --- |
| Accelerator | Tesla T4 |
| Python | 3.11.15 |
| Platform | Linux x86_64 |
| PyTorch | 2.7.0+cu118 |
| CUDA runtime | 11.8 |
| Exact package inventory | passed, zero drift |
| `pip check` | passed |
| Uploaded archive SHA-256 | matched |
| Closed archive extraction | passed, 24 files |
| Google Drive archive copy | matched SHA-256 |
| Deterministic cuBLAS `bmm` probe | passed |
| Real attention-trainer smoke | passed, 1 epoch; 512 train and 128 dev rows |
| Training process | launched under the T4 runtime |

The durable archive, process log, epoch recovery generations, and eventual
result archive live under `MyDrive/Lekh-Neural-Training`. The repository does
not contain or record the Google account identity.

## Preflight defects found and resolved

The live exercise caught four defects before a costly full-data epoch was
allowed to run:

1. The original CUDA install pinned only the top-level PyTorch wheel while
   using `--no-deps`. The workflow now carries
   `requirements/neural-open-vocab-cu118.lock`, which pins PyTorch, Triton, and
   all eleven required CUDA runtime distributions from the official cu118
   index. `pip check` and the runtime verifier enforce the complete closure.
2. Colab currently starts notebook cells under Python 3.12. The standard-library
   bootstrap module is now registered in `sys.modules` before execution, while
   model training remains pinned to Python 3.11.15.
3. Importing a bundled module initially created an unlisted
   `__pycache__/*.pyc` file and correctly tripped the closed-world verifier.
   The launcher now disables bytecode writes before any bundled import, and
   the notebook also launches it with `-B` and
   `PYTHONDONTWRITEBYTECODE=1`.
4. The initial deterministic CUDA contract used
   `CUBLAS_WORKSPACE_CONFIG=:4096:2`, which is a workspace layout but is not
   one of PyTorch's accepted deterministic cuBLAS settings. The complete
   contract now uses `:4096:8` everywhere. A direct T4 `torch.bmm` probe and a
   real one-epoch attention-model training run both passed before the final
   archive was built. NVIDIA documents `:16:8` and `:4096:8` as the
   reproducible workspace choices in its
   [cuBLAS results-reproducibility guidance](https://docs.nvidia.com/cuda/cublas/index.html#results-reproducibility).

No full-data training epoch was lost to these defects.

## Adversarial cases covered

Automated tests reject:

- archive path traversal, unsafe tar metadata, and symbolic-link members;
- symbolic-link archive aliases, source files, and extracted roots;
- stale outer/file digests, malformed manifests, and extra extracted files;
- unsafe filename stems and reserved manifest fields;
- duplicate result roles and manifest-listed file smuggling;
- architecture-size substitution before model allocation;
- checkpoint/vocabulary mismatch and oversized checkpoints;
- forged or malformed run identities and training-only topology;
- conflicting local recovery state and interrupted/corrupt recovery pointers;
- canonicalized dependency-name collisions;
- Python, PyTorch, CUDA, Triton, NVIDIA-package, and deterministic-runtime
  drift.

## Evidence still required

This report does not claim:

- that the full 1,000,000-row candidate has completed CUDA training;
- that it meets the frozen gold or official benchmark thresholds;
- that its exported Core ML artifacts meet packaged p99 latency;
- that the exact packaged workload executed on the Apple Neural Engine.

Those claims require the authenticated result archive, local Core ML export,
quality reports, packaged device benchmark, and Instruments placement trace.
