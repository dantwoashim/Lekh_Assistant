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
        self.precision = SimpleNamespace(
            FLOAT16=object(),
            FLOAT32=object(),
        )
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


class FakeCTCTrainer(FakeTrainer):
    def ctc_prefix_beam_search(
        self,
        _logits: object,
        *_args: object,
        **_kwargs: object,
    ) -> list[list[int]]:
        return [[1], [1, 1]]

    @staticmethod
    def ctc_required_time_steps(token_ids: list[int]) -> int:
        return len(token_ids) + sum(
            left == right
            for left, right in zip(token_ids, token_ids[1:])
        )


class RemoteCoreMLExporterTests(unittest.TestCase):
    def test_default_targets_active_ctc_candidate(self) -> None:
        self.assertEqual(
            EXPORTER.DEFAULT_CONFIG,
            EXPORTER.CTC_TRANSFORMER_CONFIG,
        )

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

    def test_ctc_policy_locks_one_fp16_conversion(self) -> None:
        policy, expected_calls = (
            EXPORTER.coreml_precision_contract_for_config(
                EXPORTER.CTC_TRANSFORMER_CONFIG
            )
        )
        self.assertEqual(
            expected_calls,
            EXPORTER.EXPECTED_CTC_CONVERSION_CALLS,
        )
        trainer = FakeTrainer()
        with EXPORTER.enforce_coreml_compute_precision_policy(
            trainer,
            precision_policy=policy,
        ) as state:
            result = trainer.export_coreml(object(), object(), object())

        self.assertEqual(state, {"conversionCalls": 2})
        self.assertTrue(
            all(
                call["compute_precision"]
                    is trainer.ct.precision.FLOAT16
                for call in trainer.ct.calls
            )
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "exactly 1 locked conversion",
        ):
            EXPORTER.validate_coreml_compute_precision_evidence(
                {"coremlExport": result},
                state,
                precision_policy=policy,
                expected_conversion_calls=expected_calls,
            )

        single_call_trainer = FakeTrainer()

        def export_once(*_args: object) -> dict[str, object]:
            single_call_trainer.ct.convert(object())
            return {"status": "passed"}

        single_call_trainer.export_coreml = export_once
        with EXPORTER.enforce_coreml_compute_precision_policy(
            single_call_trainer,
            precision_policy=policy,
        ) as single_state:
            single_result = single_call_trainer.export_coreml(
                object(),
                object(),
                object(),
            )
        EXPORTER.validate_coreml_compute_precision_evidence(
            {"coremlExport": single_result},
            single_state,
            precision_policy=policy,
            expected_conversion_calls=expected_calls,
        )

    def test_ctc_export_filters_sequences_without_a_finite_path(self) -> None:
        trainer = FakeCTCTrainer()
        original_decoder = trainer.ctc_prefix_beam_search
        original_export = trainer.export_coreml

        with EXPORTER.enforce_ctc_finite_path_decoder(trainer) as state:
            candidates = trainer.ctc_prefix_beam_search(
                SimpleNamespace(shape=(2, 2))
            )
            export = trainer.export_coreml(
                object(),
                object(),
                object(),
            )

        self.assertEqual(candidates, [[1]])
        self.assertEqual(
            state,
            {"decodeCalls": 1, "filteredSequences": 1},
        )
        self.assertEqual(
            export["finitePathDecoderPolicy"],
            EXPORTER.CTC_FINITE_PATH_DECODER_POLICY,
        )
        self.assert_same_bound_method(
            trainer.ctc_prefix_beam_search,
            original_decoder,
        )
        self.assert_same_bound_method(trainer.export_coreml, original_export)
        EXPORTER.validate_ctc_finite_path_decoder_evidence(
            {"coremlExport": export},
            state,
        )

    def test_ctc_export_requires_decoder_policy_and_execution(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "record"):
            EXPORTER.validate_ctc_finite_path_decoder_evidence(
                {"coremlExport": {"status": "passed"}},
                {"decodeCalls": 1, "filteredSequences": 0},
            )
        with self.assertRaisesRegex(RuntimeError, "exercise"):
            EXPORTER.validate_ctc_finite_path_decoder_evidence(
                {
                    "coremlExport": {
                        "status": "passed",
                        "finitePathDecoderPolicy":
                            EXPORTER.CTC_FINITE_PATH_DECODER_POLICY,
                    }
                },
                {"decodeCalls": 0, "filteredSequences": 0},
            )


if __name__ == "__main__":
    unittest.main()
