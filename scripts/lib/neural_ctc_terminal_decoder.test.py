#!/usr/bin/env python3
"""Regression and exhaustive-oracle tests for terminal-safe CTC decoding."""

from __future__ import annotations

import itertools
import math
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_ctc_terminal_decoder import (  # noqa: E402
    CTC_FINITE_PATH_DECODER_POLICY,
    install_terminal_safe_ctc_decoder,
    new_ctc_decoder_audit_state,
    terminal_safe_ctc_prefix_beam_search,
)


class TerminalSafeCTCDecoderTests(unittest.TestCase):
    def test_python_and_javascript_policy_literals_match(self) -> None:
        javascript = (
            ROOT
            / "scripts"
            / "lib"
            / "neural-ctc-finite-path-contract.mjs"
        ).read_text(encoding="utf-8")
        self.assertIn(
            f"schemaVersion: "
            f"{CTC_FINITE_PATH_DECODER_POLICY['schemaVersion']}",
            javascript,
        )
        for key in (
            "policyId",
            "finitePathRule",
            "finalPruneRule",
            "purpose",
        ):
            self.assertIn(key, javascript)
            self.assertIn(
                f'"{CTC_FINITE_PATH_DECODER_POLICY[key]}"',
                javascript,
            )

    def test_final_ineligible_prefix_cannot_consume_beam_slot(
        self,
    ) -> None:
        audit = new_ctc_decoder_audit_state()
        observed = terminal_safe_ctc_prefix_beam_search(
            np.asarray([[-4.0, 2.0, 9.0]], dtype=np.float64),
            blank_id=0,
            beam_width=1,
            maximum_candidates=1,
            sequence_permitted=lambda prefix: prefix == (1,),
            audit_state=audit,
        )
        self.assertEqual(observed, [[1]])
        self.assertEqual(audit["decodeCalls"], 1)
        self.assertEqual(audit["finalEligibilityChecks"], 2)
        self.assertEqual(audit["finalIneligiblePrefixes"], 1)

    def test_incomplete_prefix_remains_live_before_final_step(
        self,
    ) -> None:
        observed = terminal_safe_ctc_prefix_beam_search(
            np.asarray([
                [-8.0, 9.0, 1.0],
                [-8.0, 1.0, 9.0],
            ], dtype=np.float64),
            blank_id=0,
            beam_width=1,
            maximum_candidates=1,
            sequence_permitted=lambda prefix: prefix == (1, 2),
        )
        self.assertEqual(observed, [[1, 2]])

    def test_final_eligibility_scan_stops_at_beam_width(self) -> None:
        audit = new_ctc_decoder_audit_state()
        logits = np.asarray([
            [-100.0] + [
                float(100 - token_id)
                for token_id in range(1, 101)
            ]
        ], dtype=np.float64)
        observed = terminal_safe_ctc_prefix_beam_search(
            logits,
            blank_id=0,
            beam_width=8,
            maximum_candidates=4,
            sequence_permitted=lambda _prefix: True,
            audit_state=audit,
        )
        self.assertEqual(len(observed), 4)
        self.assertEqual(audit["finalEligibilityChecks"], 8)

    def test_constrained_ranking_matches_exhaustive_path_oracle(
        self,
    ) -> None:
        random = np.random.default_rng(20260730)
        checked = 0
        for class_count in range(2, 5):
            for time_steps in range(1, 5):
                for _case in range(8):
                    logits = random.normal(
                        size=(time_steps, class_count)
                    ).astype(np.float64)
                    scores: dict[tuple[int, ...], float] = {}
                    for path in itertools.product(
                        range(class_count),
                        repeat=time_steps,
                    ):
                        sequence = collapse_ctc_path(path)
                        if (
                            not sequence
                            or sequence[-1] % 2 != 1
                        ):
                            continue
                        score = sum(
                            float(logits[index, token])
                            for index, token in enumerate(path)
                        )
                        scores[sequence] = log_add(
                            scores.get(sequence, -math.inf),
                            score,
                        )
                    expected = [
                        list(sequence)
                        for sequence, _score in sorted(
                            scores.items(),
                            key=lambda item: (-item[1], item[0]),
                        )
                    ]
                    observed = terminal_safe_ctc_prefix_beam_search(
                        logits,
                        blank_id=0,
                        beam_width=class_count ** time_steps,
                        maximum_candidates=max(1, len(expected)),
                        sequence_permitted=(
                            lambda prefix: prefix[-1] % 2 == 1
                        ),
                    )
                    self.assertEqual(observed, expected)
                    checked += 1
        self.assertEqual(checked, 96)

    def test_installation_restores_original_decoder(self) -> None:
        class Owner:
            @staticmethod
            def ctc_prefix_beam_search(
                _logits: object,
                **_kwargs: object,
            ) -> list[list[int]]:
                return [[99]]

        owner = Owner()
        original = owner.ctc_prefix_beam_search
        with install_terminal_safe_ctc_decoder(owner):
            self.assertEqual(
                owner.ctc_prefix_beam_search(
                    np.asarray([[0.0, 1.0]], dtype=np.float64),
                    beam_width=2,
                    maximum_candidates=1,
                ),
                [[1]],
            )
        self.assertIs(owner.ctc_prefix_beam_search, original)

    def test_invalid_or_nonfinite_inputs_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "finite"):
            terminal_safe_ctc_prefix_beam_search(
                np.asarray([[0.0, np.nan]], dtype=np.float64),
                beam_width=2,
                maximum_candidates=1,
            )
        with self.assertRaisesRegex(ValueError, "beam width"):
            terminal_safe_ctc_prefix_beam_search(
                np.asarray([[0.0, 1.0]], dtype=np.float64),
                beam_width=0,
                maximum_candidates=1,
            )


def collapse_ctc_path(path: tuple[int, ...]) -> tuple[int, ...]:
    output: list[int] = []
    previous: int | None = None
    for token_id in path:
        if token_id != previous and token_id != 0:
            output.append(token_id)
        previous = token_id
    return tuple(output)


def log_add(left: float, right: float) -> float:
    if left == -math.inf:
        return right
    if right == -math.inf:
        return left
    maximum = max(left, right)
    return maximum + math.log(
        math.exp(left - maximum) + math.exp(right - maximum)
    )


if __name__ == "__main__":
    unittest.main()
