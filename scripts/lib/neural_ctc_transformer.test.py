#!/usr/bin/env python3
"""Executable unit tests for the shared Transformer-CTC contract."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import numpy as np
import torch

from neural_ctc_transformer import (
    CTCTransformer,
    CTCTransformerDimensions,
    ctc_greedy_token_ids,
    ctc_prefix_beam_search,
    ctc_required_time_steps,
    validate_ctc_input_ids,
)

ROOT = Path(__file__).resolve().parents[2]


class DimensionsTests(unittest.TestCase):
    def test_production_shape_stays_inside_parameter_envelope(self) -> None:
        dimensions = CTCTransformerDimensions(
            input_vocab_size=31,
            output_class_count=70,
        )
        model = CTCTransformer(dimensions)
        parameter_count = sum(parameter.numel() for parameter in model.parameters())
        self.assertGreaterEqual(parameter_count, 1_000_000)
        self.assertLessEqual(parameter_count, 5_000_000)

    def test_invalid_attention_partition_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "divide evenly"):
            CTCTransformerDimensions(
                input_vocab_size=31,
                output_class_count=70,
                model_dimension=255,
            ).validate()


class ModelTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(42)
        self.dimensions = CTCTransformerDimensions(
            input_vocab_size=31,
            output_class_count=70,
            max_input_length=8,
            output_time_steps=12,
            model_dimension=32,
            attention_heads=4,
            feed_forward_dimension=64,
            encoder_layers=2,
            dropout=0,
        )
        self.model = CTCTransformer(self.dimensions).eval()

    def test_forward_has_exact_fixed_shape(self) -> None:
        inputs = torch.zeros((3, 8), dtype=torch.int32)
        inputs[:, :3] = torch.tensor([4, 5, 2], dtype=torch.int32)
        with torch.no_grad():
            logits = self.model(inputs)
        self.assertEqual(tuple(logits.shape), (3, 12, 70))
        self.assertTrue(torch.isfinite(logits).all())

    def test_torchscript_trace_preserves_logits(self) -> None:
        inputs = torch.zeros((1, 8), dtype=torch.int32)
        inputs[0, :4] = torch.tensor([4, 5, 6, 2], dtype=torch.int32)
        traced = torch.jit.trace(self.model, inputs)
        with torch.no_grad():
            expected = self.model(inputs)
            observed = traced(inputs)
        self.assertTrue(torch.equal(expected, observed))

    def test_wrong_input_width_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "wrong fixed length"):
            validate_ctc_input_ids(
                torch.zeros((1, 7), dtype=torch.int32),
                self.dimensions,
            )


class CTCDecoderTests(unittest.TestCase):
    @staticmethod
    def logits(rows: list[list[float]]) -> np.ndarray:
        return np.asarray(rows, dtype=np.float32)

    def test_required_steps_accounts_for_adjacent_repeats(self) -> None:
        self.assertEqual(ctc_required_time_steps([1, 2, 3]), 3)
        self.assertEqual(ctc_required_time_steps([1, 1, 2, 2]), 6)
        with self.assertRaisesRegex(ValueError, "positive lexical"):
            ctc_required_time_steps([1, 0, 2])

    def test_greedy_collapse_preserves_repeat_separated_by_blank(self) -> None:
        logits = self.logits([
            [0, 8, 0],
            [0, 9, 0],
            [9, 0, 0],
            [0, 8, 0],
            [9, 0, 0],
            [0, 0, 8],
        ])
        self.assertEqual(ctc_greedy_token_ids(logits), [1, 1, 2])

    def test_prefix_beam_returns_stable_ranked_candidates(self) -> None:
        logits = self.logits([
            [0, 6, 5],
            [6, 0, 0],
            [0, 5, 6],
        ])
        candidates = ctc_prefix_beam_search(
            logits,
            beam_width=8,
            maximum_candidates=4,
        )
        self.assertEqual(candidates[0], [1, 2])
        self.assertEqual(len(candidates), len({tuple(value) for value in candidates}))

    def test_prefix_beam_matches_shared_python_swift_cases(self) -> None:
        fixture_path = (
            ROOT
            / "contracts"
            / "neural-decoder"
            / "v2"
            / "lekh-neural-decoder.v2.json"
        )
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(fixture["ctcCases"]), 5)
        for case in fixture["ctcCases"]:
            observed = ctc_prefix_beam_search(
                np.asarray(case["logits"], dtype=np.float64),
                blank_id=case["blankTokenId"],
                beam_width=case["beamWidth"],
                maximum_candidates=case["maximumCandidates"],
            )
            self.assertEqual(
                observed,
                case["expectedTokenIds"],
                case["id"],
            )

    def test_prefix_and_termination_guards_are_enforced(self) -> None:
        logits = self.logits([
            [0, 7, 6],
            [7, 0, 0],
            [0, 6, 7],
        ])
        candidates = ctc_prefix_beam_search(
            logits,
            beam_width=8,
            maximum_candidates=4,
            prefix_permitted=lambda prefix, token: token != 2 or bool(prefix),
            sequence_permitted=lambda prefix: prefix[-1] == 2,
        )
        self.assertTrue(candidates)
        self.assertTrue(all(candidate[-1] == 2 for candidate in candidates))
        self.assertTrue(all(candidate[0] != 2 for candidate in candidates))

    def test_non_finite_logits_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "finite"):
            ctc_prefix_beam_search(
                np.asarray([[0.0, np.nan]], dtype=np.float32),
                beam_width=4,
                maximum_candidates=1,
            )


if __name__ == "__main__":
    unittest.main()
