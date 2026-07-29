#!/usr/bin/env python3
"""Tests for the checksum-pinned Colab notebook generator."""

from __future__ import annotations

import json
import unittest

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
        self.assertIn('str(python),\n        "-B"', source)
        self.assertIn("Lekh-Neural-Training", source)
        self.assertIn("0.11.8", source)
        self.assertIn("3.11.15", source)
        self.assertIn("torch==2.7.0+cu118", source)
        self.assertIn("linux-cuda-cu118", source)
        self.assertIn("download.pytorch.org/whl/cu118", source)
        self.assertIn("neural-open-vocab-cu118.lock", source)
        self.assertIn('"pip", "check"', source)
        self.assertIn("Reusing existing session archive", source)
        self.assertIn("archive.is_symlink()", source)
        self.assertIn("sys.modules[spec.name] = remote_artifacts", source)
        self.assertIn("post-write verification", source)
        for index, cell in enumerate(parsed["cells"]):
            if cell["cell_type"] != "code":
                continue
            compile(
                "".join(cell["source"]),
                f"notebook-cell-{index}",
                "exec",
            )


if __name__ == "__main__":
    unittest.main()
