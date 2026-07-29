#!/usr/bin/env python3
"""Perform the short macOS Core ML export for a verified CUDA checkpoint."""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    BIGRU_ATTENTION_CONFIG,
    CTC_TRANSFORMER_CONFIG,
    SUPPORTED_CONFIGS,
    NeuralRemoteArtifactError,
    contained_regular_file,
    safe_relative_path,
    trainer_path_for_config,
)


DEFAULT_CONFIG = (
    "data/neural/training/open-vocab-bigru-attention-v1.config.json"
)
EXPECTED_SPLIT_CONVERSION_CALLS = 2
EXPECTED_CTC_CONVERSION_CALLS = 1
COREML_COMPUTE_PRECISION_POLICY = {
    "schemaVersion": 1,
    "policyId": "full-fp32-internal-fp16-boundary-v1",
    "coremltoolsComputePrecision": "FLOAT32",
    "tensorBoundaryPrecision": "FLOAT16",
    "neuralEngineEligible": False,
    "purpose": "locked-parity-baseline",
}
CTC_COREML_COMPUTE_PRECISION_POLICY = {
    "schemaVersion": 1,
    "policyId": "single-ctc-fp16-internal-boundary-v1",
    "coremltoolsComputePrecision": "FLOAT16",
    "tensorBoundaryPrecision": "FLOAT16",
    "neuralEngineEligible": True,
    "purpose": "ane-eligible-production-candidate",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Load a canonical CUDA-trained checkpoint on CPU, convert it to "
            "Core ML, compile the exact artifacts, run parity checks, generate "
            "gold/official predictions, and record local device measurements."
        )
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if platform.system() != "Darwin":
            raise RuntimeError("Core ML export must run on macOS.")
        config_relative = safe_relative_path(
            args.config,
            "training config path",
        )
        if config_relative not in SUPPORTED_CONFIGS:
            raise NeuralRemoteArtifactError(
                f"Unsupported remote export config: {config_relative}"
            )
        verify_toolchain()
        trainer = import_trainer(config_relative)
        precision_policy, expected_conversion_calls = (
            coreml_precision_contract_for_config(config_relative)
        )
        trainer_args = trainer.parse_args(
            [
                "--config",
                str(ROOT / config_relative),
                "--training-device",
                "cpu",
                "--skip-train",
            ],
            {},
        )
        with enforce_coreml_compute_precision_policy(
            trainer,
            precision_policy=precision_policy,
        ) as precision_state:
            with trainer.exclusive_run_lock(trainer_args):
                training_report = trainer.read_json(
                    trainer.training_report_path(trainer_args)
                )
                if training_report.get("trainingExecutionModes") != {
                    "skipTrain": False,
                    "skipCoreML": True,
                    "trainingDevice": "cuda",
                }:
                    raise RuntimeError(
                        "Canonical checkpoint is not a completed remote CUDA candidate."
                    )
                try:
                    trainer.ensure_run_input_snapshot(trainer_args)
                    export_report = trainer.run_pipeline(trainer_args)
                finally:
                    trainer.cleanup_run_input_snapshot(trainer_args)
        validate_coreml_compute_precision_evidence(
            export_report,
            precision_state,
            precision_policy=precision_policy,
            expected_conversion_calls=expected_conversion_calls,
        )
        if (
            export_report.get("executionTopology")
                != "split-host-train-then-macos-export-v1"
            or export_report.get("coremlExport", {}).get("status")
                != "passed"
            or export_report.get("runtimeArtifactContractIssues") != []
        ):
            raise RuntimeError(
                "Split-host Core ML export did not satisfy its exact contract."
            )
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "passed-neural-remote-coreml-export",
                    "modelId": export_report["modelId"],
                    "trainingRunId": export_report["trainingRunId"],
                    "exportRunId": export_report["exportRunId"],
                    "executionTopology": export_report[
                        "executionTopology"
                    ],
                    "checkpointSha256": export_report["checkpointSha256"],
                    "computePrecisionPolicy": export_report[
                        "coremlExport"
                    ]["computePrecisionPolicy"],
                    "manifest": export_report["manifest"],
                    "manifestSha256": export_report["manifestSha256"],
                    "measurements": export_report["measurements"],
                    "measurementsSha256": export_report[
                        "measurementsSha256"
                    ],
                    "predictions": export_report["predictions"],
                    "predictionsSha256": export_report[
                        "predictionsSha256"
                    ],
                    "productionEligible": export_report[
                        "productionEligible"
                    ],
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    except (
        RuntimeError,
        NeuralRemoteArtifactError,
        OSError,
        subprocess.SubprocessError,
        SystemExit,
    ) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-remote-coreml-export",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


def verify_toolchain() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/check-neural-open-vocab-toolchain.py"),
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "Pinned neural toolchain verification failed: "
            + (completed.stderr.strip() or completed.stdout.strip())
        )


def import_trainer(
    config_relative: str = BIGRU_ATTENTION_CONFIG,
) -> Any:
    trainer_relative = trainer_path_for_config(config_relative)
    path = contained_regular_file(ROOT, trainer_relative)
    specification = importlib.util.spec_from_file_location(
        "lekh_remote_coreml_export_trainer",
        path,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the neural trainer.")
    trainer = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = trainer
    try:
        specification.loader.exec_module(trainer)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return trainer


def coreml_precision_contract_for_config(
    config_relative: str,
) -> tuple[dict[str, Any], int]:
    if config_relative == CTC_TRANSFORMER_CONFIG:
        return (
            dict(CTC_COREML_COMPUTE_PRECISION_POLICY),
            EXPECTED_CTC_CONVERSION_CALLS,
        )
    if config_relative in SUPPORTED_CONFIGS:
        return (
            dict(COREML_COMPUTE_PRECISION_POLICY),
            EXPECTED_SPLIT_CONVERSION_CALLS,
        )
    raise NeuralRemoteArtifactError(
        f"Unsupported remote export config: {config_relative}"
    )


@contextmanager
def enforce_coreml_compute_precision_policy(
    trainer: Any,
    *,
    precision_policy: dict[str, Any] | None = None,
) -> Iterator[dict[str, int]]:
    """Apply an explicit export-only precision policy without mutating trainer bytes."""
    policy = dict(
        COREML_COMPUTE_PRECISION_POLICY
        if precision_policy is None
        else precision_policy
    )
    if trainer.ct is None:
        raise RuntimeError("Core ML conversion is unavailable.")
    precision_name = policy.get("coremltoolsComputePrecision")
    precision = getattr(trainer.ct.precision, precision_name, None)
    if precision is None:
        raise RuntimeError(
            f"Core ML precision policy is unavailable: {precision_name}"
        )
    original_convert = trainer.ct.convert
    original_export_coreml = trainer.export_coreml
    state = {"conversionCalls": 0}

    def convert_with_locked_precision(
        *conversion_args: Any,
        **conversion_kwargs: Any,
    ) -> Any:
        if "compute_precision" in conversion_kwargs:
            raise RuntimeError(
                "Core ML conversion attempted to override the locked precision policy."
            )
        locked_kwargs = dict(conversion_kwargs)
        locked_kwargs["compute_precision"] = precision
        converted = original_convert(*conversion_args, **locked_kwargs)
        state["conversionCalls"] += 1
        return converted

    def export_coreml_with_precision_evidence(
        *export_args: Any,
        **export_kwargs: Any,
    ) -> dict[str, Any]:
        result = original_export_coreml(*export_args, **export_kwargs)
        if not isinstance(result, dict):
            raise RuntimeError("Core ML export returned invalid evidence.")
        if "computePrecisionPolicy" in result:
            raise RuntimeError(
                "Core ML export attempted to replace precision-policy evidence."
            )
        return {
            **result,
            "computePrecisionPolicy": dict(policy),
        }

    trainer.ct.convert = convert_with_locked_precision
    trainer.export_coreml = export_coreml_with_precision_evidence
    try:
        yield state
    finally:
        trainer.export_coreml = original_export_coreml
        trainer.ct.convert = original_convert


def validate_coreml_compute_precision_evidence(
    export_report: dict[str, Any],
    precision_state: dict[str, int],
    *,
    precision_policy: dict[str, Any] | None = None,
    expected_conversion_calls: int = EXPECTED_SPLIT_CONVERSION_CALLS,
) -> None:
    policy = (
        COREML_COMPUTE_PRECISION_POLICY
        if precision_policy is None
        else precision_policy
    )
    coreml_export = export_report.get("coremlExport")
    if (
        not isinstance(coreml_export, dict)
        or coreml_export.get("computePrecisionPolicy")
            != policy
    ):
        raise RuntimeError(
            "Core ML export did not record the locked precision policy."
        )
    if (
        coreml_export.get("status") == "passed"
        and precision_state.get("conversionCalls")
            != expected_conversion_calls
    ):
        if expected_conversion_calls == EXPECTED_SPLIT_CONVERSION_CALLS:
            expectation = "exactly the encoder and decoder-step conversions"
        else:
            expectation = (
                f"exactly {expected_conversion_calls} locked conversion call(s)"
            )
        raise RuntimeError(
            "Core ML export did not apply the locked precision policy to "
            f"{expectation}."
        )


if __name__ == "__main__":
    raise SystemExit(main())
