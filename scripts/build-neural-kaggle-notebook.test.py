#!/usr/bin/env python3
"""Offline tests for the authenticated Kaggle notebook builder."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("build-neural-kaggle-notebook.py")
SPEC = importlib.util.spec_from_file_location(
    "lekh_build_neural_kaggle_notebook",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load Kaggle notebook builder: {SCRIPT}")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


BUNDLE_ID = "a" * 64
ARCHIVE_PAYLOAD = b"authenticated-kaggle-fixture"
ARCHIVE_SHA256 = hashlib.sha256(ARCHIVE_PAYLOAD).hexdigest()
MODEL_ID = "lekh-fixture-model"
CONFIG = "data/neural/training/open-vocab-ctc-transformer-v2.config.json"
TRAINER = "scripts/train-open-vocab-ctc-transformer.py"
VERIFIER = "VALUE = 1\n"
VERIFIER_SHA256 = hashlib.sha256(VERIFIER.encode("utf-8")).hexdigest()
MANIFEST_SHA256 = "b" * 64
DATASET_SHA256 = "c" * 64
GOLD_SHA256 = "d" * 64
OFFICIAL_SHA256 = "e" * 64


def source_notebook_bytes(
    verifier_assignments: tuple[str, ...] = (VERIFIER,),
) -> bytes:
    lines = [
        f"VERIFIER_MODULE_SOURCE = {value!r}\n"
        for value in verifier_assignments
    ]
    return json.dumps(
        {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {},
            "cells": [
                {
                    "cell_type": "code",
                    "execution_count": None,
                    "metadata": {},
                    "outputs": [],
                    "source": lines,
                }
            ],
        },
        sort_keys=True,
    ).encode("utf-8")


def fixture_manifest() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "artifactKind": BUILDER.BUNDLE_KIND,
        "bundleId": BUNDLE_ID,
        "modelId": MODEL_ID,
        "trainingConfig": CONFIG,
        "trainerPath": TRAINER,
        "datasetContentSha256": DATASET_SHA256,
        "goldCorpusSha256": GOLD_SHA256,
        "officialBenchmarkCorpusSha256": OFFICIAL_SHA256,
        "files": [
            {
                "path": BUILDER.VERIFIER_PATH,
                "role": "archive-contract",
                "sha256": VERIFIER_SHA256,
                "bytes": len(VERIFIER.encode("utf-8")),
            }
        ],
    }


def fixture_verification(archive: Path) -> dict[str, object]:
    payload = archive.read_bytes()
    observed = hashlib.sha256(payload).hexdigest()
    if observed != ARCHIVE_SHA256:
        raise BUILDER.NeuralRemoteArtifactError(
            "Remote archive SHA-256 does not match the trusted value."
        )
    return {
        "schemaVersion": 1,
        "status": "passed-closed-archive-verification",
        "artifactKind": BUILDER.BUNDLE_KIND,
        "bundleId": BUNDLE_ID,
        "archive": str(archive),
        "archiveSha256": observed,
        "archiveBytes": len(payload),
        "manifestSha256": MANIFEST_SHA256,
        "manifest": fixture_manifest(),
    }


def write_fixture(root: Path) -> tuple[Path, Path, Path]:
    archive = root / "lekh-fixture-cuda-training-aaaaaaaa.tar.gz"
    archive.write_bytes(ARCHIVE_PAYLOAD)
    source = root / "source.ipynb"
    source_payload = source_notebook_bytes()
    source.write_bytes(source_payload)
    report = root / "bundle-report.json"
    report.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "status": "passed-closed-archive-build",
                "artifactKind": BUILDER.BUNDLE_KIND,
                "archive": str(archive),
                "archiveBytes": len(ARCHIVE_PAYLOAD),
                "archiveSha256": ARCHIVE_SHA256,
                "bundleId": BUNDLE_ID,
                "datasetContentSha256": DATASET_SHA256,
                "goldCorpusSha256": GOLD_SHA256,
                "manifestSha256": MANIFEST_SHA256,
                "modelId": MODEL_ID,
                "notebook": str(source),
                "notebookBytes": len(source_payload),
                "notebookSha256": hashlib.sha256(
                    source_payload
                ).hexdigest(),
                "officialBenchmarkCorpusSha256": OFFICIAL_SHA256,
                "trainerPath": TRAINER,
                "trainingConfig": CONFIG,
            }
        ),
        encoding="utf-8",
    )
    return report, archive, source


class KaggleNotebookBuildTests(unittest.TestCase):
    def test_build_authenticates_archive_report_notebook_and_verifier(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-builder-",
        ) as directory:
            root = Path(directory)
            report, archive, _source = write_fixture(root)
            output = root / "Kaggle.ipynb"

            def verify(
                path: Path,
                *,
                expected_kind: str,
                expected_archive_sha256: str,
            ) -> dict[str, object]:
                self.assertEqual(path, archive.absolute())
                self.assertEqual(expected_kind, BUILDER.BUNDLE_KIND)
                self.assertEqual(
                    expected_archive_sha256,
                    ARCHIVE_SHA256,
                )
                return fixture_verification(path)

            with patch.object(
                BUILDER,
                "verify_closed_archive",
                side_effect=verify,
            ):
                first = BUILDER.build_notebook(
                    report_path=report,
                    archive=None,
                    source_notebook=None,
                    output=output,
                )
                second = BUILDER.build_notebook(
                    report_path=report,
                    archive=None,
                    source_notebook=None,
                    output=output,
                )
            self.assertEqual(first, second)
            self.assertEqual(first["bundleId"], BUNDLE_ID)
            self.assertEqual(first["archiveSha256"], ARCHIVE_SHA256)
            self.assertEqual(
                first["verifierSourceSha256"],
                VERIFIER_SHA256,
            )
            payload = output.read_bytes()
            self.assertEqual(
                first["outputSha256"],
                hashlib.sha256(payload).hexdigest(),
            )
            rendered = json.loads(payload)
            source = "\n".join(
                "".join(cell["source"])
                for cell in rendered["cells"]
            )
            self.assertIn(ARCHIVE_SHA256, source)
            self.assertIn(BUNDLE_ID, source)
            self.assertIn("VERIFIER_MODULE_SOURCE = 'VALUE = 1", source)
            self.assertNotIn(str(root), source)
            self.assertNotIn(str(archive), source)

    def test_same_length_archive_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-builder-tamper-",
        ) as directory:
            root = Path(directory)
            report, archive, _source = write_fixture(root)
            archive.write_bytes(b"x" * len(ARCHIVE_PAYLOAD))
            with (
                patch.object(
                    BUILDER,
                    "verify_closed_archive",
                    side_effect=lambda path, **_kwargs:
                        fixture_verification(path),
                ),
                self.assertRaisesRegex(
                    BUILDER.NeuralRemoteArtifactError,
                    "SHA-256",
                ),
            ):
                BUILDER.build_notebook(
                    report_path=report,
                    archive=None,
                    source_notebook=None,
                    output=root / "rejected.ipynb",
                )

    def test_source_notebook_tampering_and_duplicate_verifier_fail(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-builder-source-",
        ) as directory:
            root = Path(directory)
            report, archive, source = write_fixture(root)
            source.write_bytes(source.read_bytes() + b"\n")
            with (
                patch.object(
                    BUILDER,
                    "verify_closed_archive",
                    return_value=fixture_verification(archive),
                ),
                self.assertRaisesRegex(
                    BUILDER.KaggleNotebookBuildError,
                    "differs from its report",
                ),
            ):
                BUILDER.build_notebook(
                    report_path=report,
                    archive=None,
                    source_notebook=None,
                    output=root / "rejected.ipynb",
                )
        with self.assertRaisesRegex(
            BUILDER.KaggleNotebookBuildError,
            "exactly one",
        ):
            BUILDER.embedded_verifier_source(
                json.loads(
                    source_notebook_bytes(
                        ("VALUE = 1\n", "VALUE = 2\n")
                    )
                )
            )

    def test_verifier_must_match_closed_bundle_inventory(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-builder-verifier-",
        ) as directory:
            root = Path(directory)
            report, archive, _source = write_fixture(root)
            verification = fixture_verification(archive)
            verification["manifest"] = {
                **fixture_manifest(),
                "files": [
                    {
                        "path": BUILDER.VERIFIER_PATH,
                        "role": "archive-contract",
                        "sha256": "f" * 64,
                        "bytes": len(VERIFIER),
                    }
                ],
            }
            with (
                patch.object(
                    BUILDER,
                    "verify_closed_archive",
                    return_value=verification,
                ),
                self.assertRaisesRegex(
                    BUILDER.KaggleNotebookBuildError,
                    "authenticated by the closed training bundle",
                ),
            ):
                BUILDER.build_notebook(
                    report_path=report,
                    archive=None,
                    source_notebook=None,
                    output=root / "rejected.ipynb",
                )


if __name__ == "__main__":
    unittest.main()
