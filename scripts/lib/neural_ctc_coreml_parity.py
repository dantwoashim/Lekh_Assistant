"""Closed representative parity contract for Transformer-CTC Core ML export."""

from __future__ import annotations

import hashlib
import json
import math
from contextlib import contextmanager
from typing import Any, Iterator


CTC_COREML_PARITY_POLICY = {
    "schemaVersion": 1,
    "policyId": "ctc-representative-logit-parity-v1",
    "sourceBackend": "pytorch-fp32-checkpoint",
    "targetBackend": "compiled-coreml-fp16-mlprogram",
    "comparison": "all-logits-numpy-allclose",
    "caseIds": [
        "lexical-prefix-baseline",
        "minimum-admitted-length",
        "typical-nepal",
        "repeated-scalar",
        "maximum-content-length",
    ],
    "purpose": "verify-conversion-across-runtime-input-boundaries",
}
EXPECTED_CTC_PARITY_VALIDATION_CALLS = 3
_PARITY_TOLERANCE = 5e-3
_SHA256_ALPHABET = frozenset("0123456789abcdef")


def _representative_inputs(
    trainer: Any,
    checkpoint: dict[str, Any],
    args: Any,
) -> list[dict[str, Any]]:
    input_vocab = checkpoint.get("inputVocab")
    maximum_content_length = getattr(args, "max_input_len", 0) - 1
    if (
        not isinstance(input_vocab, dict)
        or maximum_content_length < 8
        or any(
            token not in input_vocab
            for token in "abcdefghijklmnopqrstuvwxyz"
        )
    ):
        raise RuntimeError(
            "CTC parity suite requires the production lowercase vocabulary "
            "and at least eight content positions."
        )

    texts = [
        ("minimum-admitted-length", "abc"),
        ("typical-nepal", "nepal"),
        ("repeated-scalar", "a" * 8),
        (
            "maximum-content-length",
            "".join(
                chr(ord("a") + index % 26)
                for index in range(maximum_content_length)
            ),
        ),
    ]
    cases: list[dict[str, Any]] = []
    for case_id, text in texts:
        encoded = trainer.encode_input(
            text,
            input_vocab,
            args.max_input_len,
        )
        input_ids = trainer.np.asarray(
            [encoded],
            dtype=trainer.np.int32,
        )
        if input_ids.shape != (1, args.max_input_len):
            raise RuntimeError(
                f"CTC parity case {case_id} violates the fixed input shape."
            )
        cases.append({
            "caseId": case_id,
            "contentLength": len(text),
            "inputIds": input_ids,
        })
    return cases


def _case_evidence(
    case_id: str,
    content_length: int,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    digest = evidence.get("knownAnswerInputSha256")
    maximum_error = evidence.get("maximumAbsoluteLogitError")
    if (
        not _is_sha256(digest)
        or isinstance(maximum_error, bool)
        or not isinstance(maximum_error, (int, float))
        or not math.isfinite(float(maximum_error))
        or float(maximum_error) < 0
    ):
        raise RuntimeError(
            f"CTC parity case {case_id} returned invalid evidence."
        )
    return {
        "caseId": case_id,
        "contentLength": content_length,
        "inputSha256": digest,
        "maximumAbsoluteLogitError": float(maximum_error),
    }


def _identity_sha256(cases: list[dict[str, Any]]) -> str:
    identity = [
        {
            "caseId": case["caseId"],
            "contentLength": case["contentLength"],
            "inputSha256": case["inputSha256"],
        }
        for case in cases
    ]
    encoded = json.dumps(
        identity,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@contextmanager
def enforce_ctc_representative_coreml_parity(
    trainer: Any,
) -> Iterator[dict[str, Any]]:
    """Replay the trainer's all-logit validator on fixed input boundaries."""
    original_validator = trainer.validate_ctc_coreml_known_answer
    original_input_builder = trainer.ctc_known_answer_input
    original_export_coreml = trainer.export_coreml
    state: dict[str, Any] = {
        "validationCalls": 0,
        "caseEvaluations": 0,
        "caseIdentitySha256": None,
    }

    def validate_representative_inputs(
        backend: Any,
        pytorch_model: Any,
        checkpoint: dict[str, Any],
        args: Any,
    ) -> dict[str, Any]:
        baseline = original_validator(
            backend,
            pytorch_model,
            checkpoint,
            args,
        )
        cases = [
            _case_evidence(
                "lexical-prefix-baseline",
                min(6, args.max_input_len - 1),
                baseline,
            )
        ]
        relative_tolerance = baseline.get("relativeTolerance")
        absolute_tolerance = baseline.get("absoluteTolerance")

        for case in _representative_inputs(trainer, checkpoint, args):
            fixed_input = case["inputIds"]

            def fixed_input_builder(
                _checkpoint: dict[str, Any],
                _args: Any,
                *,
                value: Any = fixed_input,
            ) -> Any:
                return value

            trainer.ctc_known_answer_input = fixed_input_builder
            try:
                evidence = original_validator(
                    backend,
                    pytorch_model,
                    checkpoint,
                    args,
                )
            finally:
                trainer.ctc_known_answer_input = original_input_builder
            if (
                evidence.get("relativeTolerance") != relative_tolerance
                or evidence.get("absoluteTolerance") != absolute_tolerance
            ):
                raise RuntimeError(
                    "CTC parity cases used inconsistent numeric tolerances."
                )
            cases.append(
                _case_evidence(
                    case["caseId"],
                    case["contentLength"],
                    evidence,
                )
            )

        if (
            [case["caseId"] for case in cases]
                != CTC_COREML_PARITY_POLICY["caseIds"]
            or len({case["inputSha256"] for case in cases}) != len(cases)
        ):
            raise RuntimeError(
                "CTC parity suite did not exercise its exact unique cases."
            )
        identity_sha256 = _identity_sha256(cases)
        prior_identity = state["caseIdentitySha256"]
        if prior_identity is not None and prior_identity != identity_sha256:
            raise RuntimeError(
                "CTC parity input identity changed across artifact checks."
            )
        state["validationCalls"] += 1
        state["caseEvaluations"] += len(cases)
        state["caseIdentitySha256"] = identity_sha256
        return {
            **baseline,
            "representativeParitySuite": {
                "schemaVersion": 1,
                "status": "passed",
                "policyId": CTC_COREML_PARITY_POLICY["policyId"],
                "caseCount": len(cases),
                "caseIdentitySha256": identity_sha256,
                "maximumAbsoluteLogitError": max(
                    case["maximumAbsoluteLogitError"]
                    for case in cases
                ),
                "relativeTolerance": relative_tolerance,
                "absoluteTolerance": absolute_tolerance,
                "cases": cases,
            },
        }

    def export_coreml_with_parity_policy(
        *export_args: Any,
        **export_kwargs: Any,
    ) -> dict[str, Any]:
        result = original_export_coreml(*export_args, **export_kwargs)
        if not isinstance(result, dict):
            raise RuntimeError("Core ML export returned invalid evidence.")
        if "representativeParityPolicy" in result:
            raise RuntimeError(
                "Core ML export attempted to replace parity-policy evidence."
            )
        return {
            **result,
            "representativeParityPolicy": json.loads(
                json.dumps(CTC_COREML_PARITY_POLICY)
            ),
        }

    trainer.validate_ctc_coreml_known_answer = (
        validate_representative_inputs
    )
    trainer.export_coreml = export_coreml_with_parity_policy
    try:
        yield state
    finally:
        trainer.export_coreml = original_export_coreml
        trainer.validate_ctc_coreml_known_answer = original_validator
        trainer.ctc_known_answer_input = original_input_builder


def _valid_suite(
    suite: Any,
    *,
    maximum_input_length: int,
) -> bool:
    if not isinstance(suite, dict):
        return False
    expected_keys = {
        "absoluteTolerance",
        "caseCount",
        "caseIdentitySha256",
        "cases",
        "maximumAbsoluteLogitError",
        "policyId",
        "relativeTolerance",
        "schemaVersion",
        "status",
    }
    cases = suite.get("cases")
    expected_lengths = [
        min(6, maximum_input_length - 1),
        3,
        5,
        8,
        maximum_input_length - 1,
    ]
    if (
        set(suite) != expected_keys
        or suite.get("schemaVersion") != 1
        or suite.get("status") != "passed"
        or suite.get("policyId") != CTC_COREML_PARITY_POLICY["policyId"]
        or suite.get("caseCount") != len(CTC_COREML_PARITY_POLICY["caseIds"])
        or suite.get("relativeTolerance") != _PARITY_TOLERANCE
        or suite.get("absoluteTolerance") != _PARITY_TOLERANCE
        or not isinstance(cases, list)
        or len(cases) != len(expected_lengths)
    ):
        return False

    case_keys = {
        "caseId",
        "contentLength",
        "inputSha256",
        "maximumAbsoluteLogitError",
    }
    for case, case_id, content_length in zip(
        cases,
        CTC_COREML_PARITY_POLICY["caseIds"],
        expected_lengths,
    ):
        maximum_error = (
            case.get("maximumAbsoluteLogitError")
            if isinstance(case, dict)
            else None
        )
        digest = case.get("inputSha256") if isinstance(case, dict) else None
        if (
            not isinstance(case, dict)
            or set(case) != case_keys
            or case.get("caseId") != case_id
            or case.get("contentLength") != content_length
            or not _is_sha256(digest)
            or isinstance(maximum_error, bool)
            or not isinstance(maximum_error, (int, float))
            or not math.isfinite(float(maximum_error))
            or float(maximum_error) < 0
        ):
            return False
    errors = [
        float(case["maximumAbsoluteLogitError"])
        for case in cases
    ]
    return (
        len({case["inputSha256"] for case in cases}) == len(cases)
        and suite.get("caseIdentitySha256") == _identity_sha256(cases)
        and suite.get("maximumAbsoluteLogitError") == max(errors)
    )


def validate_ctc_representative_parity_evidence(
    export_report: dict[str, Any],
    parity_state: dict[str, Any] | None,
) -> None:
    coreml_export = export_report.get("coremlExport")
    input_shape = (
        coreml_export.get("tensorContract", {})
        .get("inputIds", {})
        .get("shape")
        if isinstance(coreml_export, dict)
        else None
    )
    maximum_input_length = (
        input_shape[1]
        if (
            isinstance(input_shape, list)
            and len(input_shape) == 2
            and input_shape[0] == 1
            and type(input_shape[1]) is int
        )
        else 0
    )
    prepublication = (
        coreml_export.get("prePublicationValidation")
        if isinstance(coreml_export, dict)
        else None
    )
    artifact = (
        coreml_export.get("artifactValidation")
        if isinstance(coreml_export, dict)
        else None
    )
    suites = [
        evidence.get("representativeParitySuite")
        if isinstance(evidence, dict)
        else None
        for evidence in (prepublication, artifact)
    ]
    if (
        not isinstance(coreml_export, dict)
        or coreml_export.get("representativeParityPolicy")
            != CTC_COREML_PARITY_POLICY
        or maximum_input_length < 9
        or not all(
            _valid_suite(
                suite,
                maximum_input_length=maximum_input_length,
            )
            for suite in suites
        )
        or suites[0]["caseIdentitySha256"]
            != suites[1]["caseIdentitySha256"]
        or any(
            evidence.get("status") != "passed"
            or evidence.get("knownAnswerInputSha256")
                != suite["cases"][0]["inputSha256"]
            or evidence.get("maximumAbsoluteLogitError")
                != suite["cases"][0]["maximumAbsoluteLogitError"]
            or evidence.get("relativeTolerance")
                != suite["relativeTolerance"]
            or evidence.get("absoluteTolerance")
                != suite["absoluteTolerance"]
            for evidence, suite in zip(
                (prepublication, artifact),
                suites,
            )
        )
    ):
        raise RuntimeError(
            "CTC export lacks exact representative Core ML parity evidence."
        )
    if (
        not isinstance(parity_state, dict)
        or parity_state.get("validationCalls")
            != EXPECTED_CTC_PARITY_VALIDATION_CALLS
        or parity_state.get("caseEvaluations")
            != (
                EXPECTED_CTC_PARITY_VALIDATION_CALLS
                * len(CTC_COREML_PARITY_POLICY["caseIds"])
            )
        or parity_state.get("caseIdentitySha256")
            != suites[0]["caseIdentitySha256"]
    ):
        raise RuntimeError(
            "CTC export did not replay the representative parity suite at "
            "every exact-artifact validation boundary."
        )


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and set(value) <= _SHA256_ALPHABET
    )
