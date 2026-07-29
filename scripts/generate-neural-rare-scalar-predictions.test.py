#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


SCRIPT = (
    Path(__file__).resolve().parent
    / "generate-neural-rare-scalar-predictions.py"
)
SPEC = importlib.util.spec_from_file_location(
    "generate_neural_rare_scalar_predictions",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load rare-scalar prediction generator.")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class RareScalarPredictionGeneratorTests(unittest.TestCase):
    def test_builds_closed_predictions_in_contract_order(self) -> None:
        contract = fixture_contract()
        mapping = {
            "orbit": ["ऑर्बिट", "ओर्बिट"],
            "rra": [],
            "lla": ["ळ"],
            "rr": ["ऋ"],
        }
        rows = MODULE.build_prediction_rows(
            contract,
            lambda text: mapping[text],
        )
        self.assertEqual(
            rows,
            [
                {
                    "id": "probe-o",
                    "input": "orbit",
                    "candidates": ["ऑर्बिट", "ओर्बिट"],
                },
                {
                    "id": "probe-rra",
                    "input": "rra",
                    "candidates": [],
                },
                {
                    "id": "probe-lla",
                    "input": "lla",
                    "candidates": ["ळ"],
                },
                {
                    "id": "probe-rr",
                    "input": "rr",
                    "candidates": ["ऋ"],
                },
            ],
        )

    def test_rejects_duplicate_probe_identity(self) -> None:
        contract = fixture_contract()
        contract["scalars"][1]["probes"][0]["id"] = "probe-o"
        with self.assertRaisesRegex(
            MODULE.RareScalarGenerationError,
            "identity or text",
        ):
            MODULE.build_prediction_rows(contract, lambda _text: [])

    def test_rejects_invalid_decoder_candidates(self) -> None:
        contract = fixture_contract()
        with self.assertRaisesRegex(
            MODULE.RareScalarGenerationError,
            "invalid candidates",
        ):
            MODULE.build_prediction_rows(
                contract,
                lambda _text: ["क", "क"],
            )

    def test_rejects_output_symlink_to_sibling_file(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-output-",
        ) as directory:
            parent = Path(directory).resolve()
            target = parent / "protected.json"
            target.write_text("unchanged\n", encoding="utf-8")
            link = parent / "predictions.jsonl"
            link.symlink_to(target)

            with self.assertRaisesRegex(
                MODULE.RareScalarGenerationError,
                "must not be a symlink",
            ):
                MODULE.safe_output_path(
                    link,
                    parent,
                    "rare-scalar predictions",
                )
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                "unchanged\n",
            )

    def test_rejects_symlinked_output_parent_component(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-parent-",
        ) as directory:
            parent = Path(directory).resolve()
            real_directory = parent / "real"
            real_directory.mkdir()
            alias = parent / "alias"
            alias.symlink_to(real_directory, target_is_directory=True)

            with self.assertRaisesRegex(
                MODULE.RareScalarGenerationError,
                "parent must not contain symlinks",
            ):
                MODULE.safe_output_path(
                    alias / "predictions.jsonl",
                    parent,
                    "rare-scalar predictions",
                )

    def test_atomic_write_replaces_only_regular_destination(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-atomic-",
        ) as directory:
            parent = Path(directory).resolve()
            output = MODULE.safe_output_path(
                parent / "predictions.jsonl",
                parent,
                "rare-scalar predictions",
            )
            output.write_bytes(b"old\n")

            MODULE.atomic_write(output, b"new\n")

            self.assertEqual(output.read_bytes(), b"new\n")
            self.assertEqual(
                os.stat(output).st_mode & 0o777,
                0o600,
            )
            self.assertEqual(
                list(parent.glob(".predictions.jsonl.*.tmp")),
                [],
            )

    def test_atomic_write_refuses_symlink_destination_directly(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-atomic-link-",
        ) as directory:
            parent = Path(directory).resolve()
            target = parent / "protected.json"
            target.write_text("unchanged\n", encoding="utf-8")
            link = parent / "predictions.jsonl"
            link.symlink_to(target)

            with self.assertRaisesRegex(
                MODULE.RareScalarGenerationError,
                "destination must not be a symlink",
            ):
                MODULE.atomic_write(link, b"malicious\n")
            self.assertEqual(
                target.read_text(encoding="utf-8"),
                "unchanged\n",
            )

    def test_rejects_output_nested_in_candidate_artifact(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-destination-",
        ) as directory:
            candidate = Path(directory).resolve()
            compiled = candidate / "Candidate.mlmodelc"
            compiled.mkdir()
            output = compiled / "predictions.jsonl"
            report = candidate / MODULE.GENERATION_REPORT_NAME

            with self.assertRaisesRegex(
                MODULE.RareScalarGenerationError,
                "direct candidate-directory child",
            ):
                MODULE.validate_output_destinations(
                    candidate,
                    output,
                    report,
                )

    def test_rejects_overwriting_existing_candidate_input(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-collision-",
        ) as directory:
            candidate = Path(directory).resolve()
            checkpoint = candidate / "checkpoint.pt"
            checkpoint.write_bytes(b"checkpoint")
            report = candidate / MODULE.GENERATION_REPORT_NAME

            with self.assertRaisesRegex(
                MODULE.RareScalarGenerationError,
                "must not overwrite an existing candidate file",
            ):
                MODULE.validate_output_destinations(
                    candidate,
                    checkpoint,
                    report,
                )

    def test_allows_canonical_evidence_rerun(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-rare-rerun-",
        ) as directory:
            candidate = Path(directory).resolve()
            output = candidate / MODULE.PREDICTIONS_NAME
            report = candidate / MODULE.GENERATION_REPORT_NAME
            output.write_bytes(b"old predictions\n")
            report.write_bytes(b"old report\n")

            MODULE.validate_output_destinations(
                candidate,
                output,
                report,
            )


def fixture_contract() -> dict[str, Any]:
    rows = [
        ("ऑ", "probe-o", "orbit", "ऑर्बिट"),
        ("ऱ", "probe-rra", "rra", "ऱ"),
        ("ळ", "probe-lla", "lla", "ळ"),
        ("ॠ", "probe-rr", "rr", "ॠ"),
    ]
    return {
        "schemaVersion": 1,
        "contentIdentity":
            "lekh-neural-ctc-rare-output-scalar-probes-v1",
        "status": "frozen-dataset-derived-diagnostic",
        "scalars": [
            {
                "scalar": scalar,
                "probes": [
                    {
                        "id": probe_id,
                        "input": input_text,
                        "target": target,
                    }
                ],
            }
            for scalar, probe_id, input_text, target in rows
        ],
    }


if __name__ == "__main__":
    unittest.main()
