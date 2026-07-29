#!/usr/bin/env python3
"""Tests for identity-preserving remote notebook refreshes."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).with_name("refresh-neural-remote-notebook.py")
SPEC = importlib.util.spec_from_file_location("lekh_notebook_refresh", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load notebook refresh script: {SCRIPT}")
REFRESH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REFRESH)


class ResumeNotebookRefreshTests(unittest.TestCase):
    def test_refresh_preserves_bundle_and_original_verifier_identity(
        self,
    ) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-resume-notebook-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            archive = root / "bundle.tar.gz"
            archive.write_bytes(b"authenticated-bundle")
            source = root / "source.ipynb"
            verifier = "VALUE = 1\n"
            source_document = {
                "nbformat": 4,
                "nbformat_minor": 5,
                "cells": [
                    {
                        "cell_type": "code",
                        "metadata": {},
                        "execution_count": None,
                        "outputs": [],
                        "source": [
                            f"VERIFIER_MODULE_SOURCE = {verifier!r}\n"
                        ],
                    }
                ],
                "metadata": {},
            }
            source.write_text(
                json.dumps(source_document),
                encoding="utf-8",
            )
            report = root / "bundle-report.json"
            report.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "status": "passed-closed-archive-build",
                        "archive": str(archive),
                        "archiveBytes": archive.stat().st_size,
                        "archiveSha256": REFRESH.sha256_file(archive),
                        "bundleId": "a" * 64,
                        "modelId": "fixture-model",
                        "trainingConfig":
                            "data/neural/training/fixture.json",
                        "notebook": str(source),
                        "notebookBytes": source.stat().st_size,
                        "notebookSha256": REFRESH.sha256_file(source),
                    }
                ),
                encoding="utf-8",
            )
            output = root / "resume.ipynb"
            first = REFRESH.refresh_notebook(
                report_path=report,
                source_notebook=None,
                archive=None,
                output=output,
            )
            second = REFRESH.refresh_notebook(
                report_path=report,
                source_notebook=None,
                archive=None,
                output=output,
            )
            self.assertEqual(first, second)
            self.assertEqual(first["bundleId"], "a" * 64)
            self.assertEqual(
                first["archiveSha256"],
                hashlib.sha256(b"authenticated-bundle").hexdigest(),
            )
            self.assertEqual(
                first["verifierSourceSha256"],
                hashlib.sha256(verifier.encode("utf-8")).hexdigest(),
            )
            rendered = json.loads(output.read_text(encoding="utf-8"))
            all_source = "\n".join(
                "".join(cell["source"])
                for cell in rendered["cells"]
            )
            self.assertIn("verified-drive-recovery", all_source)
            self.assertIn("observed-recoverable-pointer", all_source)

            source.write_text(
                source.read_text(encoding="utf-8") + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                REFRESH.ResumeNotebookError,
                "differs from its report",
            ):
                REFRESH.refresh_notebook(
                    report_path=report,
                    source_notebook=None,
                    archive=None,
                    output=root / "stale.ipynb",
                )

    def test_refresh_rejects_duplicate_verifier(self) -> None:
        with self.assertRaisesRegex(
            REFRESH.ResumeNotebookError,
            "exactly one",
        ):
            REFRESH.embedded_verifier_source(
                {
                    "nbformat": 4,
                    "cells": [
                        {
                            "cell_type": "code",
                            "source": [
                                "VERIFIER_MODULE_SOURCE = 'one'\n",
                                "VERIFIER_MODULE_SOURCE = 'two'\n",
                            ],
                        }
                    ],
                }
            )


if __name__ == "__main__":
    unittest.main()
