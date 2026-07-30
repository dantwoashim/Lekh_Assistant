#!/usr/bin/env python3
"""Tests for fail-closed remote training bundle selection."""

from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name(
    "build-neural-remote-training-bundle.py"
)
SPEC = importlib.util.spec_from_file_location(
    "lekh_build_neural_remote_training_bundle",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load bundle builder: {SCRIPT}")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)

CTC_CONFIG = (
    "data/neural/training/open-vocab-ctc-transformer-v2.config.json"
)


class RemoteTrainingBundleSelectionTests(unittest.TestCase):
    def test_config_is_required(self) -> None:
        with (
            patch.object(sys, "argv", [str(SCRIPT)]),
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as raised,
        ):
            BUILDER.parse_args()
        self.assertEqual(raised.exception.code, 2)

    def test_explicit_ctc_config_is_preserved(self) -> None:
        with patch.object(
            sys,
            "argv",
            [str(SCRIPT), "--config", CTC_CONFIG, "--inventory-only"],
        ):
            args = BUILDER.parse_args()
        self.assertEqual(args.config, CTC_CONFIG)
        self.assertTrue(args.inventory_only)


if __name__ == "__main__":
    unittest.main()
