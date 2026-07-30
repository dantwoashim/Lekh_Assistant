#!/usr/bin/env python3
"""Small offline tests for the epoch-six preliminary quality preview."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("preview-neural-epoch6-quality.py")
SPEC = importlib.util.spec_from_file_location(
    "lekh_preview_neural_epoch6_quality",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load preview evaluator: {SCRIPT}")
PREVIEW = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PREVIEW
SPEC.loader.exec_module(PREVIEW)


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def build_recovery_fixture(root: Path) -> tuple[Path, object]:
    generation = "epoch-000001-0000000000000000"
    state_name = ".training-recovery." + ("b" * 32) + ".1.pt"
    state = b"tensor-only-recovery-fixture"
    pointer = {
        "schemaVersion": 3,
        "status": "recoverable-incomplete-training",
        "updatedAt": "2026-07-30T00:00:00Z",
        "stateFile": state_name,
        "stateSha256": sha256(state),
        "stateBytes": len(state),
        "modelId": PREVIEW.MODEL_ID,
        "trainingRunId": "a" * 32,
        "createdByExportRunId": "b" * 32,
        "completedEpoch": 1,
        "identitySha256": "c" * 64,
    }
    pointer_bytes = (
        json.dumps(pointer, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    unsigned = {
        "schemaVersion": 1,
        "status": "complete-epoch-recovery-generation",
        "bundleId": "d" * 64,
        "modelId": PREVIEW.MODEL_ID,
        "trainingConfig": PREVIEW.CONFIG_PATH,
        "trainingRunId": "a" * 32,
        "createdByExportRunId": "b" * 32,
        "completedEpoch": 1,
        "files": [
            {
                "bytes": len(pointer_bytes),
                "name": ".training-recovery.json",
                "role": "recovery-pointer",
                "sha256": sha256(pointer_bytes),
            },
            {
                "bytes": len(state),
                "name": state_name,
                "role": "recovery-state",
                "sha256": sha256(state),
            },
        ],
    }
    recovery_id = sha256(PREVIEW.canonical_json_bytes(unsigned))
    manifest = {**unsigned, "recoveryId": recovery_id}
    archive = root / "recovery.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        output.writestr(
            f"{generation}/.training-recovery.json",
            pointer_bytes,
        )
        output.writestr(
            f"{generation}/RECOVERY_MANIFEST.json",
            PREVIEW.canonical_json_bytes(manifest),
        )
        output.writestr(f"{generation}/{state_name}", state)
    payload = archive.read_bytes()
    policy = PREVIEW.RecoveryPolicy(
        archive_sha256=sha256(payload),
        archive_bytes=len(payload),
        generation=generation,
        recovery_id=recovery_id,
        bundle_id="d" * 64,
        training_run_id="a" * 32,
        export_run_id="b" * 32,
        completed_epoch=1,
        pointer_name=".training-recovery.json",
        pointer_sha256=sha256(pointer_bytes),
        pointer_bytes=len(pointer_bytes),
        state_name=state_name,
        state_sha256=sha256(state),
        state_bytes=len(state),
    )
    return archive, policy


class EpochSixPreviewTests(unittest.TestCase):
    def test_recovery_zip_requires_outer_and_inner_identity_chain(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-epoch6-preview-zip-",
        ) as directory:
            root = Path(directory)
            archive, policy = build_recovery_fixture(root)
            destination = root / "state.pt"
            pointer, evidence = PREVIEW.verify_recovery_zip(
                archive,
                policy,
                destination,
            )
            self.assertEqual(pointer["trainingRunId"], "a" * 32)
            self.assertEqual(
                evidence["stateSha256"],
                policy.state_sha256,
            )
            self.assertEqual(
                destination.read_bytes(),
                b"tensor-only-recovery-fixture",
            )

            wrong_policy = PREVIEW.RecoveryPolicy(
                **{
                    **policy.__dict__,
                    "archive_sha256": "0" * 64,
                }
            )
            with self.assertRaisesRegex(PREVIEW.PreviewError, "SHA-256"):
                PREVIEW.verify_recovery_zip(
                    archive,
                    wrong_policy,
                    root / "rejected.pt",
                )

    def test_vocab_is_reconstructed_from_exact_tiny_split(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-epoch6-preview-vocab-",
        ) as directory:
            train = Path(directory) / "train.jsonl"
            payload = b"".join([
                json.dumps(
                    {"input": "abc", "target": "क"},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8") + b"\n",
                json.dumps(
                    {"input": "bh", "target": "भा"},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8") + b"\n",
            ])
            train.write_bytes(payload)
            entry = {
                "path": "fixture/train.jsonl",
                "sha256": sha256(payload),
                "bytes": len(payload),
                "rows": 2,
            }
            config = {
                "trainingRun": {"maximumTrainRows": 10},
                "training": {
                    "augmentation": {
                        "aliases": [
                            {"from": "bh", "to": "v"},
                            {"from": "chh", "to": "x"},
                        ]
                    }
                },
            }
            input_vocab, output_vocab, evidence = (
                PREVIEW.reconstruct_training_vocabs(
                    train,
                    entry,
                    config,
                )
            )
            self.assertEqual(
                list(input_vocab),
                ["<pad>", "</s>", "<unk>", "a", "b", "c", "h", "v", "x"],
            )
            self.assertEqual(
                list(output_vocab),
                ["<ctc-blank>", "क", "भ", "ा"],
            )
            self.assertEqual(evidence["rows"], 2)
            self.assertEqual(evidence["sha256"], sha256(payload))

    def test_sample_is_exact_stratified_deterministic_and_order_free(
        self,
    ) -> None:
        rows = [
            {
                "id": f"{bucket}-{index:03d}",
                "benchmarkBucket": bucket,
            }
            for bucket in PREVIEW.BUCKETS
            for index in range(30)
        ]
        first = PREVIEW.stratified_sample(rows)
        second = PREVIEW.stratified_sample(list(reversed(rows)))
        self.assertEqual(
            [row["id"] for row in first],
            [row["id"] for row in second],
        )
        self.assertEqual(len(first), 64)
        self.assertEqual(
            {
                bucket: sum(
                    row["benchmarkBucket"] == bucket
                    for row in first
                )
                for bucket in PREVIEW.BUCKETS
            },
            {
                "native-frequent": 22,
                "indian-name": 21,
                "foreign-name": 21,
            },
        )
        with self.assertRaisesRegex(PREVIEW.PreviewError, r"\[1, 64\]"):
            PREVIEW.stratified_sample(rows, 65)

    def test_source_keeps_preview_bounded_and_non_promotional(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("weights_only=True", source)
        self.assertIn("torch.set_num_threads(1)", source)
        self.assertIn("torch.set_num_interop_threads(1)", source)
        self.assertIn("MAX_SAMPLE_ROWS = 64", source)
        self.assertIn("MAX_PREVIEW_SECONDS = 45.0", source)
        self.assertIn('"promotionEvidence": False', source)
        self.assertIn(PREVIEW.PRELIMINARY_LABEL, source)
        self.assertNotIn("coremltools.convert", source)
        self.assertNotIn("optimizer.step", source)


if __name__ == "__main__":
    unittest.main()
