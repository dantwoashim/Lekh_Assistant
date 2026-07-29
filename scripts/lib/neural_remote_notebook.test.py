#!/usr/bin/env python3
"""Tests for the checksum-pinned Colab notebook generator."""

from __future__ import annotations

import io
import json
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from neural_remote_notebook import build_colab_notebook, notebook_bytes


class NeuralRemoteNotebookTests(unittest.TestCase):
    def test_notebook_is_valid_deterministic_and_bundle_specific(self) -> None:
        report = {
            "archive": "/private/tmp/lekh-fixture.tar.gz",
            "archiveSha256": "a" * 64,
            "archiveBytes": 1234,
            "bundleId": "b" * 64,
            "manifest": {
                "modelId": "lekh-fixture-model",
                "trainingConfig": "data/neural/training/fixture.json",
            },
        }
        first = build_colab_notebook(
            report,
            verifier_module_source="VALUE = 1\n",
        )
        second = build_colab_notebook(
            report,
            verifier_module_source="VALUE = 1\n",
        )
        payload = notebook_bytes(first)
        self.assertEqual(payload, notebook_bytes(second))
        parsed = json.loads(payload)
        self.assertEqual(parsed["nbformat"], 4)
        self.assertEqual(parsed["metadata"]["accelerator"], "GPU")
        self.assertNotIn("/private/tmp", payload.decode("utf-8"))
        source = "\n".join(
            "".join(cell["source"])
            for cell in parsed["cells"]
        )
        self.assertIn("a" * 64, source)
        self.assertIn("b" * 64, source)
        self.assertIn("CUBLAS_WORKSPACE_CONFIG", source)
        self.assertIn("PYTHONDONTWRITEBYTECODE", source)
        self.assertIn("PYTHONUNBUFFERED", source)
        self.assertIn('str(python),\n        "-u",\n        "-B"', source)
        self.assertIn("Lekh-Neural-Training", source)
        self.assertIn("0.11.8", source)
        self.assertIn("3.11.15", source)
        self.assertIn("torch==2.7.0+cu118", source)
        self.assertIn("linux-cuda-cu118", source)
        self.assertIn("download.pytorch.org/whl/cu118", source)
        self.assertIn("neural-open-vocab-cu118.lock", source)
        self.assertIn('"pip", "check"', source)
        self.assertIn("verified-session-cache", source)
        self.assertIn("verified-drive-recovery", source)
        self.assertIn("verify_expected_archive", source)
        self.assertIn("copy_verified", source)
        self.assertIn("Durable Drive archive", source)
        self.assertLess(source.index("drive.mount"), source.index("files.upload"))
        self.assertIn("archive.exists() or archive.is_symlink()", source)
        self.assertIn("sys.modules[spec.name] = remote_artifacts", source)
        self.assertIn('module_path.open("xb")', source)
        self.assertIn("Existing verifier module differs", source)
        self.assertIn("observed-recoverable-pointer", source)
        self.assertIn("observed-complete-result-pointer", source)
        self.assertIn("The runner authenticates the ", source)
        self.assertIn("complete recovery generation before resuming.", source)
        self.assertIn(
            "Remote result pointer identity is malformed or stale.",
            source,
        )
        self.assertIn(
            "Remote result archive is missing or unsafe.",
            source,
        )
        self.assertIn("system_nvidia_smi", source)
        self.assertIn("passed-early-gpu-preflight", source)
        self.assertLess(
            source.index("system_nvidia_smi"),
            source.index('"pip",\n        "install"'),
        )
        for index, cell in enumerate(parsed["cells"]):
            if cell["cell_type"] != "code":
                continue
            compile(
                "".join(cell["source"]),
                f"notebook-cell-{index}",
                "exec",
            )

    def test_status_cell_reports_exact_pointers_and_rejects_schema_drift(
        self,
    ) -> None:
        bundle_id = "b" * 64
        model_id = "lekh-fixture-model"
        notebook = build_colab_notebook(
            {
                "archive": "/private/tmp/lekh-fixture.tar.gz",
                "archiveSha256": "a" * 64,
                "archiveBytes": 1234,
                "bundleId": bundle_id,
                "manifest": {
                    "modelId": model_id,
                    "trainingConfig": "data/neural/training/fixture.json",
                },
            },
            verifier_module_source="VALUE = 1\n",
        )
        status_source = "".join(notebook["cells"][4]["source"])
        with tempfile.TemporaryDirectory(
            prefix="lekh-notebook-status-",
        ) as directory:
            persistent_base = Path(directory)
            remote_root = (
                persistent_base
                / "lekh-neural-remote"
                / bundle_id
                / model_id
            )
            recovery_root = (
                remote_root
                / "recovery"
                / bundle_id
                / model_id
            )
            result_root = remote_root / "results"
            recovery_root.mkdir(parents=True)
            result_root.mkdir()
            recovery_pointer = {
                "schemaVersion": 1,
                "bundleId": bundle_id,
                "modelId": model_id,
                "generation": "epoch-000006-" + "c" * 16,
                "recoveryId": "c" * 64,
                "completedEpoch": 6,
            }
            (recovery_root / "LATEST.json").write_text(
                json.dumps(recovery_pointer),
                encoding="utf-8",
            )
            (result_root / "LATEST_RESULT.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "status": "complete-neural-remote-result",
                        "bundleId": bundle_id,
                        "modelId": model_id,
                        "trainingRunId": "d" * 32,
                        "resultId": "e" * 64,
                        "archive": "lekh-neural-fixture-result.tar.gz",
                        "archiveSha256": "f" * 64,
                        "archiveBytes": 123,
                    }
                ),
                encoding="utf-8",
            )
            output = io.StringIO()
            scope = {
                "Path": Path,
                "json": json,
                "re": re,
                "persistent_base": persistent_base,
                "EXPECTED_BUNDLE_ID": bundle_id,
                "EXPECTED_MODEL_ID": model_id,
            }
            with redirect_stdout(output):
                exec(status_source, scope)
            observed = json.loads(output.getvalue())
            self.assertEqual(
                observed["recovery"]["completedEpoch"],
                6,
            )
            self.assertEqual(
                observed["result"]["archiveBytes"],
                123,
            )

            recovery_pointer["unexpected"] = True
            (recovery_root / "LATEST.json").write_text(
                json.dumps(recovery_pointer),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "malformed or stale",
            ):
                exec(status_source, scope)


if __name__ == "__main__":
    unittest.main()
