#!/usr/bin/env python3
"""Offline tests for the exact seed-43 Kaggle challenger."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_candidate_profile import (
    ACTIVE_BUNDLE_REPORT_CONTRACT,
    CTC_CONFIG,
    CTC_MODEL_ID,
)
from scripts.lib.neural_remote_kaggle_challenger_notebook import (
    CHALLENGER_CANDIDATE_PREFIX,
    CHALLENGER_WORKING_SCOPE,
    build_kaggle_challenger_notebook,
    notebook_bytes,
)
from scripts.lib.neural_remote_kaggle_notebook import KaggleNotebookError


def fixture_report() -> dict[str, object]:
    return {
        "archive": "active-bundle.tar.gz",
        "archiveBytes": ACTIVE_BUNDLE_REPORT_CONTRACT["archiveBytes"],
        "archiveSha256": ACTIVE_BUNDLE_REPORT_CONTRACT["archiveSha256"],
        "bundleId": ACTIVE_BUNDLE_REPORT_CONTRACT["bundleId"],
        "manifest": {
            "modelId": CTC_MODEL_ID,
            "trainingConfig": CTC_CONFIG,
        },
    }


def all_source(notebook: dict[str, object]) -> str:
    return "\n".join(
        "".join(cell["source"])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
    )


def selected_functions(
    source: str,
    names: set[str],
    globals_: dict[str, object],
) -> dict[str, object]:
    module = ast.parse(source)
    selected = [
        node
        for node in module.body
        if isinstance(node, ast.FunctionDef) and node.name in names
    ]
    compiled = compile(
        ast.Module(body=selected, type_ignores=[]),
        "selected-seed-43-functions",
        "exec",
    )
    scope = dict(globals_)
    exec(compiled, scope)
    return scope


def embedded_wrapper_source(run_source: str) -> str:
    module = ast.parse(run_source)
    values = []
    for statement in module.body:
        if (
            isinstance(statement, ast.Assign)
            and len(statement.targets) == 1
            and isinstance(statement.targets[0], ast.Name)
            and statement.targets[0].id
                == "CHALLENGER_WRAPPER_SOURCE"
        ):
            values.append(ast.literal_eval(statement.value))
    if len(values) != 1 or not isinstance(values[0], str):
        raise AssertionError("Expected one embedded challenger wrapper.")
    return values[0]


class KaggleChallengerNotebookTests(unittest.TestCase):
    def test_notebook_is_deterministic_isolated_and_compilable(self) -> None:
        first = build_kaggle_challenger_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        second = build_kaggle_challenger_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        self.assertEqual(notebook_bytes(first), notebook_bytes(second))
        source = all_source(first)
        self.assertIn(CHALLENGER_WORKING_SCOPE, source)
        self.assertIn(CHALLENGER_CANDIDATE_PREFIX, source)
        self.assertIn('"--seed",', source)
        self.assertIn("EXPECTED_CHALLENGER_SEED", source)
        self.assertIn("--restart-training", source)
        self.assertIn("externalRecoveryImported", source)
        self.assertIn("Candidate-one state exists", source)
        self.assertIn("seed-43", source)
        self.assertIn(
            "result escaped its seed-43 candidate root",
            source,
        )
        for index, cell in enumerate(first["cells"]):
            if cell["cell_type"] == "code":
                cell_source = "".join(cell["source"])
                compile(
                    cell_source,
                    f"seed-43-kaggle-cell-{index}",
                    "exec",
                )
                if index == 6:
                    compile(
                        embedded_wrapper_source(cell_source),
                        "seed-43-pinned-python-wrapper",
                        "exec",
                    )

    def test_first_invocation_restarts_and_later_uses_only_own_scope(
        self,
    ) -> None:
        notebook = build_kaggle_challenger_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        run_source = embedded_wrapper_source(
            "".join(notebook["cells"][6]["source"])
        )
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-run-policy-",
        ) as directory:
            root = Path(directory)
            working = root / "working--seed-43"
            bundle = working / "bundle"
            persistent = working / "persistent"
            bundle.mkdir(parents=True)
            persistent.mkdir()
            marker = working / "KAGGLE_SEED_43_PROVIDER_STATE.json"
            globals_ = {
                "BUNDLE_ROOT": bundle,
                "WORKING_SCOPE": working,
                "PERSISTENT_BASE": persistent,
                "RUN_MARKER": marker,
                "EXPECTED_BUNDLE_ID": (
                    ACTIVE_BUNDLE_REPORT_CONTRACT["bundleId"]
                ),
                "EXPECTED_MODEL_ID": CTC_MODEL_ID,
                "EXPECTED_CONFIG": CTC_CONFIG,
                "EXPECTED_CANDIDATE_PROFILE": (
                    "seed-43-challenger-v1"
                ),
                "EXPECTED_CANDIDATE_PREFIX": (
                    CHALLENGER_CANDIDATE_PREFIX
                ),
                "EXPECTED_CONFIGURED_CANDIDATE_PREFIX": (
                    "data/generated/neural-open-vocab-model/"
                    + CTC_MODEL_ID
                ),
                "EXPECTED_CONFIGURED_SEED": 42,
                "EXPECTED_CHALLENGER_SEED": 43,
                "Path": Path,
                "json": json,
                "os": os,
            }
            scope = selected_functions(
                run_source,
                {
                    "require_candidate_isolation",
                    "initialize_challenger_invocation",
                    "challenger_training_argv",
                },
                globals_,
            )
            candidate = scope["require_candidate_isolation"]()
            first = scope["initialize_challenger_invocation"](candidate)
            first_argv = scope["challenger_training_argv"](first)
            second = scope["initialize_challenger_invocation"](candidate)
            second_argv = scope["challenger_training_argv"](second)
            self.assertTrue(first)
            self.assertFalse(second)
            self.assertIn("--restart-training", first_argv)
            self.assertNotIn("--restart-training", second_argv)
            seed_index = first_argv.index("--seed")
            self.assertEqual(
                first_argv[seed_index:seed_index + 2],
                ["--seed", "43"],
            )
            self.assertTrue(
                first_argv[first_argv.index("--out-dir") + 1].endswith(
                    "--seed-43"
                )
            )
            marker_payload = json.loads(
                marker.read_text(encoding="utf-8")
            )
            self.assertEqual(marker_payload["effectiveSeed"], 43)
            self.assertEqual(
                marker_payload["storagePolicy"],
                "kaggle-seed-43-only-v1",
            )

    def test_candidate_one_state_and_identity_drift_fail_closed(self) -> None:
        report = fixture_report()
        report["bundleId"] = "f" * 64
        with self.assertRaisesRegex(
            KaggleNotebookError,
            "exact active",
        ):
            build_kaggle_challenger_notebook(
                report,
                verifier_module_source="VALUE = 1\n",
            )

        notebook = build_kaggle_challenger_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        run_source = embedded_wrapper_source(
            "".join(notebook["cells"][6]["source"])
        )
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-collision-",
        ) as directory:
            root = Path(directory)
            bundle = root / "bundle"
            canonical = (
                bundle
                / "data/generated/neural-open-vocab-model"
                / CTC_MODEL_ID
            )
            canonical.mkdir(parents=True)
            scope = selected_functions(
                run_source,
                {"require_candidate_isolation"},
                {
                    "BUNDLE_ROOT": bundle,
                    "WORKING_SCOPE": root / "working--seed-43",
                    "EXPECTED_CONFIGURED_CANDIDATE_PREFIX": (
                        "data/generated/neural-open-vocab-model/"
                        + CTC_MODEL_ID
                    ),
                    "EXPECTED_CANDIDATE_PREFIX": (
                        CHALLENGER_CANDIDATE_PREFIX
                    ),
                },
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "Candidate-one state",
            ):
                scope["require_candidate_isolation"]()

    def test_training_executes_only_in_pinned_python_subprocess(self) -> None:
        notebook = build_kaggle_challenger_notebook(
            fixture_report(),
            verifier_module_source="VALUE = 1\n",
        )
        host_source = "".join(notebook["cells"][6]["source"])
        host_module = ast.parse(host_source)
        host_imports = {
            alias.name
            for node in ast.walk(host_module)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertNotIn("torch", host_imports)
        self.assertNotIn("importlib.util", host_imports)
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-pinned-subprocess-",
        ) as directory:
            root = Path(directory)
            bootstrap = root / "bootstrap"
            bundle = root / "bundle"
            bootstrap.mkdir()
            bundle.mkdir()
            pinned_python = root / "venv" / "bin" / "python"
            pinned_python.parent.mkdir(parents=True)
            pinned_python.write_bytes(b"pinned-python")
            scope = {
                "BOOTSTRAP_ROOT": bootstrap,
                "BUNDLE_ROOT": bundle,
                "WORKING_SCOPE": root,
                "python": pinned_python,
            }
            with patch("subprocess.run") as run:
                exec(host_source, scope)
            command = run.call_args.args[0]
            self.assertEqual(
                command[:3],
                [str(pinned_python), "-u", "-B"],
            )
            self.assertEqual(run.call_args.kwargs["cwd"], bundle)
            environment = run.call_args.kwargs["env"]
            self.assertEqual(environment["PYTHONHASHSEED"], "43")
            self.assertEqual(
                environment["CUBLAS_WORKSPACE_CONFIG"],
                ":4096:8",
            )
            self.assertEqual(
                environment["PYTHONDONTWRITEBYTECODE"],
                "1",
            )
            wrapper_path = Path(command[3])
            self.assertEqual(wrapper_path.parent, bootstrap)
            self.assertEqual(
                wrapper_path.read_text(encoding="utf-8"),
                embedded_wrapper_source(host_source),
            )
            self.assertNotIn(
                "load_authenticated_remote_runner",
                scope,
            )
            self.assertNotIn("trainer", scope)


if __name__ == "__main__":
    unittest.main()
