#!/usr/bin/env python3
"""Tests for the active remote-training bundle compatibility lock."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name(
    "check-neural-active-bundle-compatibility.py"
)
SPEC = importlib.util.spec_from_file_location(
    "lekh_active_bundle_compatibility",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load active-bundle checker: {SCRIPT}")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def fixture_manifest(authored: bytes, generated: bytes) -> dict[str, object]:
    files = [
        {
            "bytes": len(generated),
            "path": "data/generated/fixture.jsonl",
            "role": "dataset-train",
            "sha256": digest(generated),
        },
        {
            "bytes": len(authored),
            "path": "data/neural/training/fixture.json",
            "role": "training-config",
            "sha256": digest(authored),
        },
    ]
    return {
        "schemaVersion": 1,
        "status": "recoverable-incomplete-remote-training",
        "modelId": "fixture-model",
        "trainingConfig": "data/neural/training/fixture.json",
        "bundle": {
            "bundleId": "a" * 64,
            "archiveName": "fixture.tar.gz",
            "archiveSha256": "b" * 64,
            "archiveBytes": 100,
            "manifestSha256": "c" * 64,
            "fileCount": len(files),
            "uncompressedInputBytes": sum(item["bytes"] for item in files),
            "datasetContentSha256": "d" * 64,
            "goldCorpusSha256": "e" * 64,
            "officialBenchmarkCorpusSha256": "f" * 64,
        },
        "recovery": {
            "provider": "google-colab",
            "status": "complete-epoch-recovery-generation",
            "completedEpoch": 6,
            "generation": "epoch-000006-" + "1" * 16,
            "recoveryId": "1" * 64,
            "trainingRunId": "2" * 32,
            "createdByExportRunId": "3" * 32,
            "stateFile": ".training-recovery." + "3" * 32 + ".6.pt",
            "stateSha256": "4" * 64,
            "stateBytes": 10,
            "downloadArchiveSha256": "5" * 64,
            "downloadArchiveBytes": 9,
        },
        "files": files,
    }


class ActiveBundleCompatibilityTests(unittest.TestCase):
    def test_exact_files_pass_and_drift_fails(self) -> None:
        authored = b"authenticated-config"
        generated = b"authenticated-generated-data"
        with tempfile.TemporaryDirectory(
            prefix="lekh-active-bundle-"
        ) as directory:
            root = Path(directory)
            authored_path = root / "data/neural/training/fixture.json"
            generated_path = root / "data/generated/fixture.jsonl"
            authored_path.parent.mkdir(parents=True)
            generated_path.parent.mkdir(parents=True)
            authored_path.write_bytes(authored)
            generated_path.write_bytes(generated)
            manifest_path = root / "active.json"
            manifest_path.write_text(
                json.dumps(fixture_manifest(authored, generated)),
                encoding="utf-8",
            )
            result = CHECK.verify_active_bundle_compatibility(
                repo_root=root,
                manifest_path=manifest_path,
                archive_path=None,
                require_complete=True,
            )
            self.assertTrue(result["completeSourceInventory"])
            self.assertEqual(result["verifiedFileCount"], 2)

            authored_path.write_bytes(b"drifted-config")
            with self.assertRaisesRegex(
                CHECK.NeuralRemoteArtifactError,
                "drifted",
            ):
                CHECK.verify_active_bundle_compatibility(
                    repo_root=root,
                    manifest_path=manifest_path,
                    archive_path=None,
                    require_complete=True,
                )

    def test_clean_checkout_may_omit_only_generated_inputs(self) -> None:
        authored = b"authenticated-config"
        generated = b"authenticated-generated-data"
        with tempfile.TemporaryDirectory(
            prefix="lekh-active-bundle-"
        ) as directory:
            root = Path(directory)
            authored_path = root / "data/neural/training/fixture.json"
            authored_path.parent.mkdir(parents=True)
            authored_path.write_bytes(authored)
            manifest_path = root / "active.json"
            manifest_path.write_text(
                json.dumps(fixture_manifest(authored, generated)),
                encoding="utf-8",
            )
            result = CHECK.verify_active_bundle_compatibility(
                repo_root=root,
                manifest_path=manifest_path,
                archive_path=None,
                require_complete=False,
            )
            self.assertFalse(result["completeSourceInventory"])
            self.assertEqual(result["missingGeneratedFileCount"], 1)
            with self.assertRaisesRegex(
                CHECK.NeuralRemoteArtifactError,
                "missing",
            ):
                CHECK.verify_active_bundle_compatibility(
                    repo_root=root,
                    manifest_path=manifest_path,
                    archive_path=None,
                    require_complete=True,
                )

    def test_symbolic_link_and_duplicate_inventory_fail_closed(self) -> None:
        authored = b"authenticated-config"
        generated = b"authenticated-generated-data"
        with tempfile.TemporaryDirectory(
            prefix="lekh-active-bundle-"
        ) as directory:
            root = Path(directory)
            authored_path = root / "data/neural/training/fixture.json"
            generated_path = root / "data/generated/fixture.jsonl"
            authored_path.parent.mkdir(parents=True)
            generated_path.parent.mkdir(parents=True)
            authored_path.write_bytes(authored)
            generated_path.symlink_to(authored_path)
            manifest = fixture_manifest(authored, generated)
            manifest_path = root / "active.json"
            manifest_path.write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            with self.assertRaises(CHECK.NeuralRemoteArtifactError):
                CHECK.verify_active_bundle_compatibility(
                    repo_root=root,
                    manifest_path=manifest_path,
                    archive_path=None,
                    require_complete=True,
                )

            manifest["files"].append(dict(manifest["files"][0]))
            manifest["files"].sort(key=lambda entry: entry["path"])
            manifest["bundle"]["fileCount"] += 1
            manifest["bundle"]["uncompressedInputBytes"] += len(generated)
            manifest_path.write_text(
                json.dumps(manifest),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                CHECK.NeuralRemoteArtifactError,
                "repeats",
            ):
                CHECK.load_active_manifest(manifest_path)


if __name__ == "__main__":
    unittest.main()
