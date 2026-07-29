#!/usr/bin/env python3
"""Perform the short macOS Core ML export for a verified CUDA checkpoint."""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    SUPPORTED_CONFIGS,
    NeuralRemoteArtifactError,
    safe_relative_path,
)


DEFAULT_CONFIG = (
    "data/neural/training/open-vocab-bigru-attention-v1.config.json"
)


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
        trainer = import_trainer()
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


def import_trainer() -> Any:
    path = ROOT / "scripts/train-open-vocab-seq2seq-transliterator.py"
    specification = importlib.util.spec_from_file_location(
        "lekh_remote_coreml_export_trainer",
        path,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the neural trainer.")
    trainer = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(trainer)
    return trainer


if __name__ == "__main__":
    raise SystemExit(main())
