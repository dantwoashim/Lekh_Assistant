# CTC Transformer Recovery Checkpoint

Date: 2026-07-30

Status: authenticated, recoverable, incomplete training. This is progress
evidence, not model-quality or production-readiness evidence.

## Exact recovery identity

- model: `lekh-open-vocab-ctc-transformer-v2`
- bundle:
  `abc8ecfb2bfbcf3201cc2ad741b8c7ca98714882d25e93a0c38b900b3f136296`
- training run: `f4bcc9d75eca4fe78a6cb928063a2d2b`
- recovery generation: `epoch-000006-ebcb07a2530ae38a`
- recovery:
  `ebcb07a2530ae38ad5c3846e58b17318fec63e6bbe0ddccb4bdfcc0420330afc`
- state SHA-256:
  `020cd22d76f8b102b752e85504836c720bff73e758d8932ce992b5620525651d`
- trainer SHA-256:
  `7a6739f5d72eb3e280cadaa520aa5ea163aee91818ee0149189fb782f364a2c2`
- dataset content SHA-256:
  `15909aac528fa0f2fb590e62981b0a0035422aa2673f9de4c7bc47ba2e778599`

The checkpoint reports the pinned Python 3.11.15 / PyTorch 2.7.0+cu118 /
CUDA 11.8 toolchain on one Tesla T4, deterministic algorithms enabled, and the
exact isolated 871,498-row training selection plus 99,920 training-only alias
augmentations. The official 4,085-row benchmark has zero input overlap with
the selected train and development rows.

## Training trajectory

The recovery state was opened with PyTorch's tensor-only
`weights_only=True` loader after its outer archive and state digests were
verified.

| Epoch | Train weighted CTC loss | Development weighted CTC loss | Global step | New best |
| ---: | ---: | ---: | ---: | :---: |
| 1 | 8.833918 | 3.055659 | 3,795 | yes |
| 2 | 3.042367 | 2.144759 | 7,590 | yes |
| 3 | 2.423704 | 1.839909 | 11,385 | yes |
| 4 | 2.080021 | 1.665085 | 15,180 | yes |
| 5 | 1.931153 | 1.603938 | 18,975 | yes |
| 6 | 1.787017 | 1.546572 | 22,770 | yes |

- best epoch: 6
- epochs without improvement: 0
- stopped early: no
- recorded training duration: 5,441.402 seconds
- observed average: approximately 15 minutes 7 seconds per epoch

The losses are finite and the development loss improved at every completed
epoch. That proves the optimization run was still converging when Colab quota
stopped it. It does **not** establish transliteration accuracy: CTC loss cannot
substitute for exported Core ML predictions, locked-gold accuracy, the
official benchmark, safety checks, or packaged latency.

At the observed T4 rate, resuming the remaining maximum 24 epochs would take
about six hours; a fresh maximum 30-epoch run would take about seven hours
34 minutes. Early stopping may shorten either estimate. Kaggle hardware,
storage, and quota availability can change the wall-clock result, so these are
planning estimates rather than promises.

## Next admissible actions

1. Resume this exact recovery only on a compatible Colab runtime after its
   quota resets.
2. Otherwise, use the authenticated Kaggle notebook for a fresh epoch-zero
   run; never import this T4 recovery across providers.
3. Import only a complete closed result archive, export the exact checkpoint
   to Core ML on macOS, and run unchanged quality and runtime gates.
