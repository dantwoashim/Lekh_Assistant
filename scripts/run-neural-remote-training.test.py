#!/usr/bin/env python3
"""Focused durability tests for the remote CUDA runner."""

from __future__ import annotations

import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).with_name("run-neural-remote-training.py")
SPEC = importlib.util.spec_from_file_location("lekh_remote_runner", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load remote runner: {SCRIPT}")
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


STATE_PATTERN = re.compile(
    r"^\.training-recovery\.[a-f0-9]{32}\.[1-9][0-9]*\.pt$"
)


class FakeTrainer:
    @staticmethod
    def training_recovery_metadata_path(args: SimpleNamespace) -> Path:
        return args.out_dir / ".training-recovery.json"

    @staticmethod
    def training_recovery_state_files(
        args: SimpleNamespace,
    ) -> list[Path]:
        if not args.out_dir.exists():
            return []
        return sorted(
            path
            for path in args.out_dir.iterdir()
            if STATE_PATTERN.fullmatch(path.name)
        )


class RemoteRunnerRecoveryTests(unittest.TestCase):
    def test_completed_report_requires_exact_remote_cuda_profile(
        self,
    ) -> None:
        report = {
            "status": "passed-training-checkpoint",
            "trainingComplete": True,
            "modelId": "fixture-model",
            "trainingExecutionModes": {
                "skipTrain": False,
                "skipCoreML": True,
                "trainingDevice": "cuda",
            },
            "runInputSnapshot": {
                "runtime": {
                    "trainingDevice": "cuda",
                    "deterministicAlgorithms": True,
                    "python": RUNNER.REMOTE_PYTHON_VERSION,
                    "torch": RUNNER.REMOTE_TORCH_VERSION,
                    "numpy": "1.26.4",
                    "coremltools": "9.0",
                    "machine": "x86_64",
                    "cuda": {
                        "available": True,
                        "runtimeVersion": RUNNER.REMOTE_CUDA_VERSION,
                        "cublasWorkspaceConfig": ":4096:2",
                        "cudnnBenchmark": False,
                        "cudnnDeterministic": True,
                    },
                }
            },
        }
        RUNNER.validate_completed_training_report(
            report,
            bundle_id="a" * 64,
            model_id="fixture-model",
        )
        report["runInputSnapshot"]["runtime"]["torch"] = "2.7.0"
        with self.assertRaisesRegex(
            RUNNER.NeuralRemoteArtifactError,
            "deterministic evidence",
        ):
            RUNNER.validate_completed_training_report(
                report,
                bundle_id="a" * 64,
                model_id="fixture-model",
            )

    def test_epoch_recovery_is_mirrored_restored_and_pointer_repaired(
        self,
    ) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-recovery-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            args = SimpleNamespace(out_dir=root / "candidate")
            args.out_dir.mkdir()
            recovery_root = root / "persistent"
            bundle_id = "a" * 64
            model_id = "fixture-model"
            config = "data/neural/training/fixture.json"
            state = write_recovery(
                args.out_dir,
                epoch=1,
                training_run_id="b" * 32,
                export_run_id="c" * 32,
                payload=b"recovery-state-one",
            )
            RUNNER.mirror_recovery(
                FakeTrainer,
                args,
                recovery_root,
                state,
                {"epoch": 1},
                bundle_id=bundle_id,
                model_id=model_id,
                config_relative=config,
            )
            pointer = json.loads(
                (recovery_root / RUNNER.RECOVERY_POINTER).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(pointer["completedEpoch"], 1)
            self.assertEqual(len(list(recovery_root.glob("epoch-*"))), 1)

            state.unlink()
            FakeTrainer.training_recovery_metadata_path(args).unlink()
            (recovery_root / RUNNER.RECOVERY_POINTER).write_text(
                "{interrupted-pointer",
                encoding="utf-8",
            )
            restored = RUNNER.restore_latest_recovery(
                FakeTrainer,
                args,
                recovery_root,
                bundle_id=bundle_id,
                model_id=model_id,
                config_relative=config,
            )
            self.assertEqual(restored["completedEpoch"], 1)
            self.assertEqual(state.read_bytes(), b"recovery-state-one")
            repaired = json.loads(
                (recovery_root / RUNNER.RECOVERY_POINTER).read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                repaired["generation"],
                next(recovery_root.glob("epoch-*")).name,
            )

    def test_conflicting_local_recovery_fails_closed(self) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-recovery-conflict-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            args = SimpleNamespace(out_dir=root / "candidate")
            args.out_dir.mkdir()
            recovery_root = root / "persistent"
            state = write_recovery(
                args.out_dir,
                epoch=1,
                training_run_id="d" * 32,
                export_run_id="e" * 32,
                payload=b"trusted-state",
            )
            RUNNER.mirror_recovery(
                FakeTrainer,
                args,
                recovery_root,
                state,
                {"epoch": 1},
                bundle_id="f" * 64,
                model_id="fixture-model",
                config_relative="data/neural/training/fixture.json",
            )
            state.write_bytes(b"conflicting-local-state")
            with self.assertRaisesRegex(
                RUNNER.NeuralRemoteArtifactError,
                "different bytes",
            ):
                RUNNER.restore_latest_recovery(
                    FakeTrainer,
                    args,
                    recovery_root,
                    bundle_id="f" * 64,
                    model_id="fixture-model",
                    config_relative="data/neural/training/fixture.json",
                )


def write_recovery(
    candidate: Path,
    *,
    epoch: int,
    training_run_id: str,
    export_run_id: str,
    payload: bytes,
) -> Path:
    state = candidate / (
        f".training-recovery.{export_run_id}.{epoch}.pt"
    )
    state.write_bytes(payload)
    metadata = {
        "schemaVersion": 2,
        "status": "recoverable-incomplete-training",
        "updatedAt": "2026-07-28T00:00:00Z",
        "stateFile": state.name,
        "stateSha256": RUNNER.sha256_file(state),
        "stateBytes": len(payload),
        "modelId": "fixture-model",
        "trainingRunId": training_run_id,
        "createdByExportRunId": export_run_id,
        "completedEpoch": epoch,
        "identitySha256": "1" * 64,
    }
    (candidate / ".training-recovery.json").write_text(
        json.dumps(metadata),
        encoding="utf-8",
    )
    return state


if __name__ == "__main__":
    unittest.main()
