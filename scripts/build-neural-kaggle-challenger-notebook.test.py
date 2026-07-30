#!/usr/bin/env python3
"""Tiny-fixture tests for the authenticated seed-43 notebook builder."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_candidate_profile import (
    ACTIVE_BUNDLE_REPORT_CONTRACT,
)


SCRIPT = Path(__file__).with_name(
    "build-neural-kaggle-challenger-notebook.py"
)
SPEC = importlib.util.spec_from_file_location(
    "lekh_kaggle_challenger_builder",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load challenger builder: {SCRIPT}")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def report_value() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "status": "passed-closed-archive-build",
        "artifactKind": BUILDER.BASE.BUNDLE_KIND,
        **ACTIVE_BUNDLE_REPORT_CONTRACT,
        "archive": "/unread/tiny-fixture.tar.gz",
        "notebook": "/unread/source.ipynb",
        "notebookBytes": 1,
        "notebookSha256": "9" * 64,
    }


def verification_value() -> dict[str, object]:
    verifier = "VALUE = 1\n"
    return {
        "manifestSha256": (
            ACTIVE_BUNDLE_REPORT_CONTRACT["manifestSha256"]
        ),
        "manifest": {
            "files": [
                {
                    "path": BUILDER.BASE.VERIFIER_PATH,
                    "sha256": BUILDER.BASE.sha256_bytes(
                        verifier.encode("utf-8")
                    ),
                    "bytes": len(verifier.encode("utf-8")),
                }
            ]
        },
    }


class ChallengerNotebookBuilderTests(unittest.TestCase):
    def test_build_is_deterministic_without_large_fixture(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-builder-",
        ) as directory:
            root = Path(directory)
            report = root / "bundle-report.json"
            report.write_text(
                json.dumps(report_value()),
                encoding="utf-8",
            )
            output = root / "Seed-43-Kaggle.ipynb"
            notebook_report = {
                "archive": "active-bundle.tar.gz",
                "archiveBytes": report_value()["archiveBytes"],
                "archiveSha256": report_value()["archiveSha256"],
                "bundleId": report_value()["bundleId"],
                "manifest": {
                    "modelId": report_value()["modelId"],
                    "trainingConfig": report_value()["trainingConfig"],
                },
            }
            authenticated = (
                notebook_report,
                "VALUE = 1\n",
                verification_value(),
            )
            with patch.object(
                BUILDER.BASE,
                "validate_trusted_inputs",
                return_value=authenticated,
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
            self.assertEqual(first["effectiveSeed"], 43)
            self.assertTrue(first["candidatePrefix"].endswith("--seed-43"))
            rendered = json.loads(output.read_text(encoding="utf-8"))
            source = "\n".join(
                "".join(cell["source"])
                for cell in rendered["cells"]
            )
            self.assertIn(report_value()["bundleId"], source)
            self.assertIn(report_value()["archiveSha256"], source)
            self.assertNotIn("/unread/", source)

    def test_frozen_inventory_overlap_is_rejected(self) -> None:
        safe_manifest = {
            "files": [{"path": "scripts/authenticated.py"}]
        }
        BUILDER.assert_frozen_inventory_disjoint(safe_manifest)
        colliding = {
            "files": [
                {
                    "path": (
                        "scripts/lib/"
                        "neural_remote_candidate_profile.py"
                    )
                }
            ]
        }
        with self.assertRaisesRegex(
            BUILDER.ChallengerNotebookBuildError,
            "overlaps",
        ):
            BUILDER.assert_frozen_inventory_disjoint(colliding)

    def test_bundle_identity_drift_is_rejected_before_rendering(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-builder-drift-",
        ) as directory:
            root = Path(directory)
            value = report_value()
            value["bundleId"] = "f" * 64
            report = root / "bundle-report.json"
            report.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(
                BUILDER.CandidateProfileError,
                "bundleId",
            ):
                BUILDER.build_notebook(
                    report_path=report,
                    archive=None,
                    source_notebook=None,
                    output=root / "rejected.ipynb",
                )


if __name__ == "__main__":
    unittest.main()
