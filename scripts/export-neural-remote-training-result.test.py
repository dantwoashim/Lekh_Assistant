#!/usr/bin/env python3
"""Regression tests for the split-host Core ML export wrapper."""

from __future__ import annotations

import hashlib
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np


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
from scripts.lib.neural_ctc_coreml_parity import (  # noqa: E402
    EXPECTED_CTC_PARITY_VALIDATION_CALLS,
)


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


class FakeParityTrainer(FakeCTCTrainer):
    np = np
    INPUT_SPECIAL = ["<pad>", "</s>", "<unk>"]
    PAD = "<pad>"
    EOS = "</s>"

    @staticmethod
    def encode_input(
        text: str,
        vocabulary: dict[str, int],
        maximum_length: int,
    ) -> list[int]:
        values = [vocabulary[token] for token in text]
        values.append(vocabulary["</s>"])
        return values + [vocabulary["<pad>"]] * (
            maximum_length - len(values)
        )

    def ctc_known_answer_input(
        self,
        checkpoint: dict[str, object],
        args: object,
    ) -> np.ndarray:
        vocabulary = checkpoint["inputVocab"]
        assert isinstance(vocabulary, dict)
        lexical_ids = [
            token_id
            for token, token_id in sorted(
                vocabulary.items(),
                key=lambda item: item[1],
            )
            if token not in self.INPUT_SPECIAL
        ]
        prefix = lexical_ids[:6] + [vocabulary[self.EOS]]
        return np.asarray(
            [
                prefix
                + [vocabulary[self.PAD]]
                * (args.max_input_len - len(prefix))
            ],
            dtype=np.int32,
        )

    def validate_ctc_coreml_known_answer(
        self,
        _backend: object,
        _pytorch_model: object,
        checkpoint: dict[str, object],
        args: object,
    ) -> dict[str, object]:
        values = self.ctc_known_answer_input(checkpoint, args)
        return {
            "knownAnswerInputSha256": hashlib.sha256(
                values.tobytes()
            ).hexdigest(),
            "maximumAbsoluteLogitError":
                float(int(values.sum()) % 5 + 1) / 10_000,
            "relativeTolerance": 5e-3,
            "absoluteTolerance": 5e-3,
        }


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

    def test_ctc_export_installs_terminal_safe_finite_decoder(self) -> None:
        trainer = FakeCTCTrainer()
        original_decoder = trainer.ctc_prefix_beam_search
        original_export = trainer.export_coreml

        with EXPORTER.enforce_ctc_finite_path_decoder(trainer) as state:
            candidates = trainer.ctc_prefix_beam_search(
                np.asarray([[-4.0, 2.0, 9.0]], dtype=np.float64),
                blank_id=0,
                beam_width=1,
                maximum_candidates=1,
                sequence_permitted=lambda prefix: prefix == (1,),
            )
            export = trainer.export_coreml(
                object(),
                object(),
                object(),
            )

        self.assertEqual(candidates, [[1]])
        self.assertEqual(state["decodeCalls"], 1)
        self.assertEqual(state["finalEligibilityChecks"], 2)
        self.assertEqual(state["finalIneligiblePrefixes"], 1)
        self.assertEqual(state["nonFinitePrefixesPruned"], 0)
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
        exercised = EXPORTER.new_ctc_decoder_audit_state()
        exercised["decodeCalls"] = 1
        exercised["finalEligibilityChecks"] = 1
        with self.assertRaisesRegex(RuntimeError, "record"):
            EXPORTER.validate_ctc_finite_path_decoder_evidence(
                {"coremlExport": {"status": "passed"}},
                exercised,
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
                EXPORTER.new_ctc_decoder_audit_state(),
            )

    def test_ctc_export_replays_exact_representative_parity_suite(
        self,
    ) -> None:
        trainer = FakeParityTrainer()
        original_validator = trainer.validate_ctc_coreml_known_answer
        original_input_builder = trainer.ctc_known_answer_input
        original_export = trainer.export_coreml
        vocabulary = {
            "<pad>": 0,
            "</s>": 1,
            "<unk>": 2,
            **{
                character: index + 3
                for index, character in enumerate(
                    "abcdefghijklmnopqrstuvwxyz"
                )
            },
        }
        checkpoint = {"inputVocab": vocabulary}
        args = SimpleNamespace(max_input_len=32)

        with EXPORTER.enforce_ctc_representative_coreml_parity(
            trainer
        ) as state:
            prepublication = trainer.validate_ctc_coreml_known_answer(
                object(),
                object(),
                checkpoint,
                args,
            )
            artifact = trainer.validate_ctc_coreml_known_answer(
                object(),
                object(),
                checkpoint,
                args,
            )
            export = trainer.export_coreml(
                object(),
                object(),
                object(),
            )
            independent = trainer.validate_ctc_coreml_known_answer(
                object(),
                object(),
                checkpoint,
                args,
            )
            export.update({
                "tensorContract": {
                    "inputIds": {
                        "shape": [1, 32],
                        "dataType": "INT32",
                    },
                },
                "prePublicationValidation": {
                    "status": "passed",
                    **prepublication,
                },
                "artifactValidation": {
                    "status": "passed",
                    **artifact,
                },
            })

        self.assertEqual(
            state["validationCalls"],
            EXPECTED_CTC_PARITY_VALIDATION_CALLS,
        )
        self.assertEqual(state["caseEvaluations"], 15)
        self.assertEqual(
            export["representativeParityPolicy"],
            EXPORTER.CTC_COREML_PARITY_POLICY,
        )
        suite = artifact["representativeParitySuite"]
        self.assertEqual(
            [case["caseId"] for case in suite["cases"]],
            EXPORTER.CTC_COREML_PARITY_POLICY["caseIds"],
        )
        self.assertEqual(
            [case["contentLength"] for case in suite["cases"]],
            [6, 3, 5, 8, 31],
        )
        self.assertEqual(
            independent["representativeParitySuite"][
                "caseIdentitySha256"
            ],
            suite["caseIdentitySha256"],
        )
        EXPORTER.validate_ctc_representative_parity_evidence(
            {"coremlExport": export},
            state,
        )
        self.assert_same_bound_method(
            trainer.validate_ctc_coreml_known_answer,
            original_validator,
        )
        self.assert_same_bound_method(
            trainer.ctc_known_answer_input,
            original_input_builder,
        )
        self.assert_same_bound_method(trainer.export_coreml, original_export)

    def test_ctc_parity_evidence_rejects_missing_boundary_replay(
        self,
    ) -> None:
        suite = {
            "schemaVersion": 1,
            "status": "passed",
            "policyId": EXPORTER.CTC_COREML_PARITY_POLICY["policyId"],
            "caseCount": 0,
            "caseIdentitySha256": "0" * 64,
            "maximumAbsoluteLogitError": 0.0,
            "relativeTolerance": 5e-3,
            "absoluteTolerance": 5e-3,
            "cases": [],
        }
        with self.assertRaisesRegex(
            RuntimeError,
            "lacks exact representative",
        ):
            EXPORTER.validate_ctc_representative_parity_evidence(
                {
                    "coremlExport": {
                        "representativeParityPolicy":
                            EXPORTER.CTC_COREML_PARITY_POLICY,
                        "tensorContract": {
                            "inputIds": {"shape": [1, 32]},
                        },
                        "prePublicationValidation": {
                            "knownAnswerInputSha256": "0" * 64,
                            "representativeParitySuite": suite,
                        },
                        "artifactValidation": {
                            "knownAnswerInputSha256": "0" * 64,
                            "representativeParitySuite": suite,
                        },
                    },
                },
                {
                    "validationCalls": 3,
                    "caseEvaluations": 15,
                    "caseIdentitySha256": "0" * 64,
                },
            )


if __name__ == "__main__":
    unittest.main()
