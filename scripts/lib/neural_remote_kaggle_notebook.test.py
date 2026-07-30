#!/usr/bin/env python3
"""Offline tests for the checksum-pinned Kaggle notebook generator."""

from __future__ import annotations

import ast
import hashlib
import io
import json
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from neural_remote_kaggle_notebook import (
    KaggleNotebookError,
    build_kaggle_notebook,
    notebook_bytes,
)


ARCHIVE_NAME = "lekh-neural-fixture-cuda-training-aabbccdd.tar.gz"
ARCHIVE_PAYLOAD = b"checksum-pinned-training-bundle"
ARCHIVE_SHA256 = hashlib.sha256(ARCHIVE_PAYLOAD).hexdigest()
BUNDLE_ID = "b" * 64
MODEL_ID = "lekh-fixture-model"
CONFIG = "data/neural/training/fixture.json"


def fixture_report() -> dict[str, object]:
    return {
        "archive": f"/private/tmp/{ARCHIVE_NAME}",
        "archiveSha256": ARCHIVE_SHA256,
        "archiveBytes": len(ARCHIVE_PAYLOAD),
        "bundleId": BUNDLE_ID,
        "manifest": {
            "modelId": MODEL_ID,
            "trainingConfig": CONFIG,
        },
    }


def all_source(notebook: dict[str, object]) -> str:
    return "\n".join(
        "".join(cell["source"])
        for cell in notebook["cells"]
    )


def selected_functions(
    source: str,
    names: set[str],
    scope: dict[str, object],
) -> dict[str, object]:
    module = ast.parse(source)
    selected = ast.Module(
        body=[
            statement
            for statement in module.body
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
            and statement.name in names
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(selected)
    exec(compile(selected, "selected-notebook-functions", "exec"), scope)
    return scope


class KaggleNotebookTests(unittest.TestCase):
    def test_notebook_is_deterministic_provider_isolated_and_compilable(
        self,
    ) -> None:
        first = build_kaggle_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        second = build_kaggle_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        payload = notebook_bytes(first)
        self.assertEqual(payload, notebook_bytes(second))
        parsed = json.loads(payload)
        self.assertEqual(parsed["nbformat"], 4)
        self.assertTrue(parsed["metadata"]["kaggle"]["isGpuEnabled"])
        source = all_source(parsed)
        self.assertIn("/kaggle/input", source)
        self.assertIn(
            "/kaggle/working/Lekh-Neural-Training-Kaggle",
            source,
        )
        self.assertIn("discover_exact_archive", source)
        self.assertIn("observed {len(candidates)} copies", source)
        self.assertIn("EXPECTED_ARCHIVE_BYTES", source)
        self.assertIn("EXPECTED_ARCHIVE_SHA256", source)
        self.assertIn("verify_closed_archive", source)
        self.assertIn("verify_extracted_tree", source)
        self.assertIn("RESULT_KIND", source)
        self.assertIn("validate_result_pointer", source)
        self.assertIn("verify_result_archive", source)
        self.assertIn("passed-kaggle-result-publication", source)
        self.assertIn("KAGGLE_PROVIDER_STATE.json", source)
        self.assertIn("--restart-training", source)
        self.assertIn("externalRecoveryImported", source)
        self.assertIn("kaggle-working-only-v1", source)
        self.assertIn("3.11.15", source)
        self.assertIn("torch==2.7.0+cu118", source)
        self.assertIn("UV_PYTHON_INSTALL_DIR", source)
        self.assertIn("verified_venv_python", source)
        self.assertIn("--managed-python", source)
        self.assertIn("https://download.pytorch.org/whl/cu118", source)
        self.assertIn("linux-cuda-cu118", source)
        self.assertIn("CUBLAS_WORKSPACE_CONFIG", source)
        self.assertIn("PYTHONHASHSEED", source)
        self.assertIn("PYTHONDONTWRITEBYTECODE", source)
        self.assertIn("PYTHONUNBUFFERED", source)
        self.assertNotIn("/private/tmp", source)
        lowered = source.casefold()
        for forbidden in (
            "google.colab",
            "/content",
            "drive.mount",
            "mydrive",
            "files.upload",
            "files.download",
        ):
            self.assertNotIn(forbidden, lowered)
        for index, cell in enumerate(parsed["cells"]):
            if cell["cell_type"] == "code":
                compile(
                    "".join(cell["source"]),
                    f"kaggle-notebook-cell-{index}",
                    "exec",
                )

    def test_archive_discovery_rejects_duplicates_symlinks_and_bad_bytes(
        self,
    ) -> None:
        notebook = build_kaggle_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        bootstrap = "".join(notebook["cells"][2]["source"])
        scope = selected_functions(
            bootstrap,
            {"regular_file_sha256", "discover_exact_archive"},
            {
                "Path": Path,
                "hashlib": hashlib,
                "os": os,
                "stat": stat,
                "EXPECTED_ARCHIVE_NAME": ARCHIVE_NAME,
                "EXPECTED_ARCHIVE_BYTES": len(ARCHIVE_PAYLOAD),
                "EXPECTED_ARCHIVE_SHA256": ARCHIVE_SHA256,
            },
        )
        discover = scope["discover_exact_archive"]
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-discovery-",
        ) as directory:
            root = Path(directory)
            dataset = root / "dataset"
            dataset.mkdir()
            archive = dataset / ARCHIVE_NAME
            archive.write_bytes(ARCHIVE_PAYLOAD)
            self.assertEqual(discover(root), archive)

            duplicate_root = root / "duplicate"
            duplicate_root.mkdir()
            (duplicate_root / ARCHIVE_NAME).write_bytes(ARCHIVE_PAYLOAD)
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                discover(root)
            (duplicate_root / ARCHIVE_NAME).unlink()

            archive.write_bytes(b"x" * len(ARCHIVE_PAYLOAD))
            with self.assertRaisesRegex(RuntimeError, "wrong SHA-256"):
                discover(root)
            archive.write_bytes(b"wrong-size")
            with self.assertRaisesRegex(RuntimeError, "wrong byte count"):
                discover(root)
            archive.unlink()
            archive.symlink_to(root / "missing-archive")
            with self.assertRaisesRegex(RuntimeError, "non-symlink"):
                discover(root)

    def test_first_invocation_restarts_then_only_resumes_local_state(
        self,
    ) -> None:
        notebook = build_kaggle_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        run_source = "".join(notebook["cells"][6]["source"])
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-run-policy-",
        ) as directory:
            working = Path(directory)
            scope = {
                "WORKING_SCOPE": working,
                "EXPECTED_BUNDLE_ID": BUNDLE_ID,
                "EXPECTED_MODEL_ID": MODEL_ID,
                "EXPECTED_CONFIG": CONFIG,
                "python": working / "python",
                "BUNDLE_ROOT": working / "bundle",
                "PERSISTENT_BASE": working / "persistent",
            }
            with (
                patch("subprocess.run") as run,
                redirect_stdout(io.StringIO()) as output,
            ):
                exec(run_source, scope)
                first_command = run.call_args.args[0]
                exec(run_source, scope)
                second_command = run.call_args.args[0]
            self.assertIn("--restart-training", first_command)
            self.assertNotIn("--restart-training", second_command)
            reports = [
                json.loads(chunk)
                for chunk in output.getvalue().split("}\n")
                if chunk.strip()
                for chunk in [chunk + "}"]
            ]
            self.assertTrue(reports[0]["restartTraining"])
            self.assertFalse(reports[1]["restartTraining"])
            self.assertFalse(reports[0]["externalRecoveryImported"])
            marker = json.loads(
                (
                    working / "KAGGLE_PROVIDER_STATE.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(
                marker["storagePolicy"],
                "kaggle-working-only-v1",
            )

    def test_venv_python_allows_managed_symlink_and_rejects_escape(
        self,
    ) -> None:
        notebook = build_kaggle_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        setup_source = "".join(notebook["cells"][4]["source"])
        scope = selected_functions(
            setup_source,
            {"verified_managed_python", "verified_venv_python"},
            {"stat": stat},
        )
        verify_python = scope["verified_venv_python"]
        with tempfile.TemporaryDirectory(
            prefix="lekh-kaggle-python-",
        ) as directory:
            root = Path(directory)
            managed = root / "uv-python"
            managed_python = (
                managed
                / "cpython-3.11.15-linux-x86_64-gnu"
                / "bin"
                / "python3.11"
            )
            managed_python.parent.mkdir(parents=True)
            managed_python.write_bytes(b"managed-python")
            venv = root / "venv"
            (venv / "bin").mkdir(parents=True)
            candidate = venv / "bin/python"
            candidate.symlink_to(managed_python)
            self.assertEqual(
                verify_python(venv, managed),
                candidate,
            )

            candidate.unlink()
            outside = root / "outside-python"
            outside.write_bytes(b"outside")
            candidate.symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                verify_python(venv, managed)

    def test_result_pointer_rejects_extra_fields(self) -> None:
        notebook = build_kaggle_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        result_source = "".join(notebook["cells"][8]["source"])
        scope = selected_functions(
            result_source,
            {"validate_result_pointer"},
            {
                "Path": Path,
                "re": __import__("re"),
                "EXPECTED_BUNDLE_ID": BUNDLE_ID,
                "EXPECTED_MODEL_ID": MODEL_ID,
            },
        )
        pointer = {
            "schemaVersion": 1,
            "status": "complete-neural-remote-result",
            "bundleId": BUNDLE_ID,
            "modelId": MODEL_ID,
            "trainingRunId": "c" * 32,
            "resultId": "d" * 64,
            "archive": "lekh-result.tar.gz",
            "archiveSha256": "e" * 64,
            "archiveBytes": 123,
        }
        self.assertEqual(scope["validate_result_pointer"](pointer), pointer)
        with self.assertRaisesRegex(RuntimeError, "malformed or stale"):
            scope["validate_result_pointer"]({**pointer, "extra": True})

    def test_invalid_bundle_identity_fails_before_rendering(self) -> None:
        report = fixture_report()
        report["bundleId"] = "not-a-digest"
        with self.assertRaisesRegex(
            KaggleNotebookError,
            "digest is invalid",
        ):
            build_kaggle_notebook(
                report,
                verifier_module_source="VALUE = 1\n",
            )


if __name__ == "__main__":
    unittest.main()
