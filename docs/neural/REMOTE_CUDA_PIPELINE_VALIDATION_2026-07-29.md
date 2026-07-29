# Remote CUDA Pipeline Validation — 2026-07-29

Status: local pipeline passed; full external CUDA training not yet executed.

## Verified locally

The following commands passed:

```sh
npm run neural:remote:test

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
- remote epoch recovery tests: 3 passed;
- remote result importer tests: 4 passed;
- toolchain-profile tests: 5 passed;
- full trainer/Core ML contract tests: 35 passed.
- JavaScript neural training-contract tests: 28 passed.

The first sandboxed trainer invocation could not use the macOS system temporary
compilation directory. The same suite passed outside that filesystem
restriction; this was an execution-sandbox limitation, not a product failure.

## Built and independently reverified bundle

| Evidence | Value |
| --- | --- |
| Model | `lekh-open-vocab-bigru-attention-v1` |
| File count | 23 |
| Uncompressed input bytes | 625,509,116 |
| Archive bytes | 99,275,078 |
| Bundle ID | `ea05fb76597e7617f163222888b21e65dde90f64d02fce2c9eb242e55e86d73c` |
| Archive SHA-256 | `9f465f01aa791fe4f0304ed49fcd7b8f269132abbfb37f842e2e88c8c81b2d27` |
| Manifest SHA-256 | `ef0e3cb8d2d1e10c70632a6168b315548629d945f3e982632d8ae9404ce72f27` |
| Notebook SHA-256 | `e7d47fed628bdd50bf2839045a438391a0e26559efe8f8403c736d742e994661` |
| Dataset identity | `15909aac528fa0f2fb590e62981b0a0035422aa2673f9de4c7bc47ba2e778599` |

The repository verifier authenticated and atomically extracted all 23 files.
The verifier carried inside that extraction then independently reopened the
original archive and reproduced the same archive, bundle, manifest, dataset,
gold-corpus, and official-benchmark identities.

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
- Python, PyTorch, CUDA, and deterministic-runtime profile drift.

## Remaining external evidence

This report does not claim:

- that the full 1,000,000-row candidate has trained successfully on CUDA;
- that a free Colab GPU is currently available;
- that the candidate meets frozen gold or official benchmark thresholds;
- that exported Core ML artifacts meet packaged p99 latency;
- that the exact packaged workload executed on the Apple Neural Engine.

Those claims require the authenticated result archive, local Core ML export,
quality reports, packaged device benchmark, and Instruments placement trace.
