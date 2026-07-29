#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
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
