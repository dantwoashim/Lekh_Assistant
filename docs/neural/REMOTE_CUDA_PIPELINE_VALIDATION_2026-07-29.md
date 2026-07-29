# Remote CUDA Pipeline Validation — 2026-07-29

Status: the historical BiGRU remote pipeline completed and selected epoch 6.
The active Transformer-CTC run is separately recoverable through completed
epoch 6, but it has not completed training or published a result archive.
Downstream Core ML qualification is therefore not claimed.

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
- generated-notebook and executable status-cell tests: 2 passed;
- identity-preserving notebook-refresh tests: 2 passed;
- remote runner and epoch-recovery tests: 4 passed;
- authenticated result-import tests: 6 passed;
- remote Core ML export-policy tests: 4 passed;
- exact toolchain-profile tests: 7 passed;
- historical seq2seq/attention trainer and Core ML tests: 35 passed;
- shared CTC model and decoder tests: 11 passed;
- CTC trainer, recovery, and Core ML tests: 16 passed;
- CTC dataset/alignment and freshness audit tests: 9 passed;
- complete 34-file JavaScript neural regression: 228 passed.

The Core ML suite requires access to the macOS system temporary compilation
directory. Its first sandbox-restricted invocation could not compile there;
the same 35-test suite passed with that operating-system access enabled. This
was a test-environment restriction, not a model failure.

## Historical BiGRU bundle

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

## Historical BiGRU full-data convergence

The authenticated historical BiGRU bundle trained on 871,498 training rows and
evaluated weighted token loss on a deterministic 50,000-row development
sample. Every completed epoch was mirrored to a content-addressed Google Drive
recovery generation before the next epoch began.

| Epoch | Train weighted token cross-entropy | Dev weighted token cross-entropy | New best |
| ---: | ---: | ---: | :---: |
| 1 | 0.6067337539886959 | 0.5436883617562777 | yes |
| 2 | 0.5331557697183177 | 0.5368210108606992 | yes |
| 3 | 0.5277216783035201 | 0.5357946361827629 | yes |
| 4 | 0.5256181777612219 | 0.5309705800881553 | yes |
| 5 | 0.5249657409127177 | 0.5312725297926045 | no |
| 6 | 0.5245722266277952 | 0.5300000711148710 | yes |
| 7 | 0.5243433629436943 | 0.5316954591914761 | no |
| 8 | 0.5240649510841241 | 0.5305953818535466 | no |

The configured two-epoch patience stopped training after epoch 8 and retained
epoch 6 as the best held-out-loss state. At the last observation, the remote
runner was executing its deterministic 800-row CPU beam-search evaluation
before checkpoint and result-archive publication. These loss values and early
stopping behavior do not by themselves establish transliteration accuracy.

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

- that the authenticated CUDA result archive has completed publication and
  local import;
- that it meets the frozen gold or official benchmark thresholds;
- that its exported Core ML artifacts meet packaged p99 latency;
- that the exact packaged workload executed on the Apple Neural Engine.

Those claims require the authenticated result archive, local Core ML export,
quality reports, packaged device benchmark, and Instruments placement trace.

## Active Transformer-CTC run

The successor bundle
`lekh-open-vocab-ctc-transformer-v2` independently passed archive SHA-256,
closed-inventory extraction, the exact Python 3.11.15 / PyTorch 2.7.0+cu118
toolchain check, Drive persistence, and Tesla T4 discovery. Its first full-data
attempt failed before epoch one when strict deterministic execution reached
CUDA CTC backward:

```text
RuntimeError: ctc_loss_backward_gpu does not have a deterministic implementation
```

This is an upstream capability boundary, not a data or model-shape failure.
PyTorch explicitly lists differentiating CUDA `CTCLoss` among the operations
that error under `torch.use_deterministic_algorithms(True)` and notes that CUDA
CTC may otherwise select a nondeterministic algorithm:
[deterministic algorithms](https://docs.pytorch.org/docs/2.9/generated/torch.use_deterministic_algorithms.html),
[CTCLoss](https://docs.pytorch.org/docs/stable/generated/torch.nn.modules.loss.CTCLoss.html).

The training contract now keeps the Transformer forward and parameter updates
on CUDA but moves the small `[time, batch, class]` log-probability tensor across
a differentiable device-copy boundary for CPU CTC loss and backward. A live T4
probe under strict deterministic mode produced a finite loss, finite gradients,
and a CUDA-resident source gradient.

That policy was subsequently packaged as a new immutable bundle; the earlier
statement that it still needed rebuilding is no longer current:

| Evidence | Active CTC value |
| --- | --- |
| Model | `lekh-open-vocab-ctc-transformer-v2` |
| File count | 26 |
| Uncompressed input bytes | 625,668,859 |
| Archive bytes | 99,316,415 |
| Bundle ID | `abc8ecfb2bfbcf3201cc2ad741b8c7ca98714882d25e93a0c38b900b3f136296` |
| Archive SHA-256 | `b5968bad47dbeda072e213ee9e649ba5d14645f62e938a4524fae977d6684628` |
| Manifest SHA-256 | `d6df5e38ec525ceb17c9001f1cd26ce06f7c6987a1bd90b620341d1b16026df7` |
| Original notebook SHA-256 | `a2b6551d8f14bd921dc8b4a404739a3e4330ea4532e61deb4c3db5459e5f8575` |

The durable Drive pointer observed after the last available T4 session was:

| Recovery evidence | Value |
| --- | --- |
| Completed epoch | 6 |
| Generation | `epoch-000006-ebcb07a2530ae38a` |
| Recovery ID | `ebcb07a2530ae38ad5c3846e58b17318fec63e6bbe0ddccb4bdfcc0420330afc` |
| State bytes | 76,648,555 |
| State SHA-256 | `020cd22d76f8b102b752e85504836c720bff73e758d8932ce992b5620525651d` |
| Training run ID | `f4bcc9d75eca4fe78a6cb928063a2d2b` |

No `LATEST_RESULT.json` existed at that observation. Epoch 6 is a durable
training recovery, not a completed or production-qualified model. The free
Colab account then refused another GPU backend because of its usage limit.
Google explicitly states that free accelerator availability and usage limits
are dynamic and not guaranteed:
[Colab FAQ](https://research.google.com/colaboratory/faq.html).

## Identity-preserving resume notebook

The tracked
[`LEKH_CTC_TRANSFORMER_V2_RESUME_ABC8ECFB.ipynb`](./LEKH_CTC_TRANSFORMER_V2_RESUME_ABC8ECFB.ipynb)
is bound to the same archive, bundle ID, and verifier source as the original
notebook. Its SHA-256 is
`d92cf7c25c6c43e078de55339fbf48b335f5d2fc1ce5be36d380d6e4ee56442e`.
It changes orchestration only:

- mounts Drive before requesting a browser upload;
- restores the exact 99 MB archive from Drive after checking size and SHA-256;
- displays the observed completed epoch dynamically instead of relying on a
  hard-coded progress message;
- refuses a CPU-only runtime before installing the pinned training toolchain;
- leaves full generation authentication to the bundled runner before resume.

The notebook was generated from the original authenticated sidecar by
`scripts/refresh-neural-remote-notebook.py`. The refresher verifies the original
archive and notebook digests, extracts exactly one literal embedded verifier,
refuses to overwrite the authenticated source, and writes the new notebook
atomically. This preserves the epoch-6 recovery identity while removing the
manual re-upload and stale-status failure modes.

When a free GPU becomes available, run notebook sections 1–4. The runner will
authenticate the complete epoch-6 generation, restore the model, optimizer,
data-order generator, CPU and CUDA RNG states, best checkpoint, and
early-stopping state, then continue from epoch 7. Section 5 becomes valid only
after training publishes `LATEST_RESULT.json`.
