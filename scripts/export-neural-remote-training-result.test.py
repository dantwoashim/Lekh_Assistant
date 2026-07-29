#!/usr/bin/env python3
"""Regression tests for the split-host Core ML export wrapper."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
EXPORTER_PATH = ROOT / "scripts/export-neural-remote-training-result.py"
SPECIFICATION = importlib.util.spec_from_file_location(
    "lekh_remote_coreml_exporter_test_subject",
    EXPORTER_PATH,
)
if SPECIFICATION is None or SPECIFICATION.loader is None:
    raise RuntimeError("Unable to load the remote Core ML exporter.")
EXPORTER = importlib.util.module_from_spec(SPECIFICATION)
SPECIFICATION.loader.exec_module(EXPORTER)


class FakeCoreMLTools:
    def __init__(self) -> None:
        self.precision = SimpleNamespace(FLOAT32=object())
        self.calls: list[dict[str, object]] = []

    def convert(self, _model: object, **kwargs: object) -> object:
        self.calls.append(kwargs)
        return object()


class FakeTrainer:
    def __init__(self, *, caller_precision: object | None = None) -> None:
        self.ct = FakeCoreMLTools()
        self.caller_precision = caller_precision

    def export_coreml(
        self,
        _model: object,
        _checkpoint: object,
        _args: object,
    ) -> dict[str, object]:
        encoder_kwargs = {}
        if self.caller_precision is not None:
            encoder_kwargs["compute_precision"] = self.caller_precision
        self.ct.convert(object(), **encoder_kwargs)
        self.ct.convert(object())
        return {"status": "passed"}


class RemoteCoreMLExporterTests(unittest.TestCase):
    def assert_same_bound_method(
        self,
        observed: object,
        expected: object,
    ) -> None:
        self.assertIs(observed.__self__, expected.__self__)
        self.assertIs(observed.__func__, expected.__func__)

    def test_policy_is_applied_recorded_and_restored(self) -> None:
        trainer = FakeTrainer()
        original_convert = trainer.ct.convert
        original_export = trainer.export_coreml

        with EXPORTER.enforce_coreml_compute_precision_policy(
            trainer
        ) as state:
            result = trainer.export_coreml(object(), object(), object())

        self.assertEqual(
            state,
            {"conversionCalls": EXPORTER.EXPECTED_SPLIT_CONVERSION_CALLS},
        )
        self.assertEqual(
            result["computePrecisionPolicy"],
            EXPORTER.COREML_COMPUTE_PRECISION_POLICY,
        )
        self.assertEqual(len(trainer.ct.calls), 2)
        self.assertTrue(
            all(
                call["compute_precision"]
                    is trainer.ct.precision.FLOAT32
                for call in trainer.ct.calls
            )
        )
        self.assert_same_bound_method(trainer.ct.convert, original_convert)
        self.assert_same_bound_method(trainer.export_coreml, original_export)
        EXPORTER.validate_coreml_compute_precision_evidence(
            {"coremlExport": result},
            state,
        )

    def test_caller_cannot_override_locked_precision(self) -> None:
        trainer = FakeTrainer(caller_precision=object())
        original_convert = trainer.ct.convert
        original_export = trainer.export_coreml

        with self.assertRaisesRegex(
            RuntimeError,
            "override the locked precision policy",
        ):
            with EXPORTER.enforce_coreml_compute_precision_policy(trainer):
                trainer.export_coreml(object(), object(), object())

        self.assert_same_bound_method(trainer.ct.convert, original_convert)
        self.assert_same_bound_method(trainer.export_coreml, original_export)

    def test_success_requires_two_bound_conversions(self) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "exactly the encoder and decoder-step conversions",
        ):
            EXPORTER.validate_coreml_compute_precision_evidence(
                {
                    "coremlExport": {
                        "status": "passed",
                        "computePrecisionPolicy": dict(
                            EXPORTER.COREML_COMPUTE_PRECISION_POLICY
                        ),
                    }
                },
                {"conversionCalls": 1},
            )


if __name__ == "__main__":
    unittest.main()
