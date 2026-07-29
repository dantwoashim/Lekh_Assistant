#!/usr/bin/env python3
"""Adversarial unit tests for the remote CUDA result importer."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).with_name(
    "import-neural-remote-training-result.py"
)
SPEC = importlib.util.spec_from_file_location(
    "lekh_remote_result_importer",
    SCRIPT,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load remote importer: {SCRIPT}")
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class FakeTrainer:
    @staticmethod
    def checkpoint_runtime_config(
        _args: SimpleNamespace,
    ) -> dict[str, object]:
        return {
            "model_id": "fixture-model",
            "embedding_dim": 8,
        }


class RemoteResultImporterTests(unittest.TestCase):
    def test_remote_package_inventory_is_exact_and_duplicate_safe(self) -> None:
        expected = IMPORTER.expected_remote_package_versions()
        self.assertEqual(expected["torch"], IMPORTER.REMOTE_TORCH_VERSION)
        self.assertEqual(expected["triton"], "3.3.0")
        self.assertEqual(expected["nvidia-cudnn-cu11"], "9.1.0.70")
        self.assertEqual(
            IMPORTER.normalize_observed_package_versions(
                {
                    "Torch": IMPORTER.REMOTE_TORCH_VERSION,
                    "nvidia_cudnn_cu11": "9.1.0.70",
                }
            ),
            {
                "torch": IMPORTER.REMOTE_TORCH_VERSION,
                "nvidia-cudnn-cu11": "9.1.0.70",
            },
        )
        with self.assertRaisesRegex(
            IMPORTER.NeuralRemoteArtifactError,
            "canonical duplicates",
        ):
            IMPORTER.normalize_observed_package_versions(
                {"Jinja2": "3.1.6", "jinja2": "3.1.6"}
            )

    def test_result_roles_are_unique_exact_and_closed(self) -> None:
        expected = {
            "checkpoint": "candidate/checkpoint.pt",
            "training-report": "candidate/training-report.json",
            "vocabulary": "candidate/vocab.json",
        }
        files = [
            {"role": role, "path": path}
            for role, path in expected.items()
        ]
        observed = IMPORTER.validate_result_role_inventory(
            files,
            expected_roles=expected,
            optional_role="training-only-export-report",
            optional_path="candidate/export-report.json",
        )
        self.assertEqual(observed, expected)

        with self.assertRaisesRegex(
            IMPORTER.NeuralRemoteArtifactError,
            "duplicate artifact role",
        ):
            IMPORTER.validate_result_role_inventory(
                [
                    *files,
                    {
                        "role": "checkpoint",
                        "path": "candidate/smuggled.bin",
                    },
                ],
                expected_roles=expected,
                optional_role="training-only-export-report",
                optional_path="candidate/export-report.json",
            )

        with self.assertRaisesRegex(
            IMPORTER.NeuralRemoteArtifactError,
            "unexpected artifact roles",
        ):
            IMPORTER.validate_result_role_inventory(
                [
                    *files,
                    {
                        "role": "untrusted-extra",
                        "path": "candidate/extra.bin",
                    },
                ],
                expected_roles=expected,
                optional_role="training-only-export-report",
                optional_path="candidate/export-report.json",
            )

    def test_checkpoint_preflight_rejects_architecture_and_vocab_drift(
        self,
    ) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-import-preflight-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            vocabulary = root / "fixture.vocab.json"
            vocabulary.write_text(
                json.dumps(
                    {
                        "input": {"idsByToken": {"<pad>": 0, "a": 1}},
                        "output": {"idsByToken": {"<pad>": 0, "अ": 1}},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            args = SimpleNamespace(
                vocab_metadata=Path("/canonical/fixture.vocab.json")
            )
            valid = {
                "config": FakeTrainer.checkpoint_runtime_config(args),
                "inputVocab": {"<pad>": 0, "a": 1},
                "outputVocab": {"<pad>": 0, "अ": 1},
            }
            IMPORTER.preflight_checkpoint_payload(
                valid,
                trainer=FakeTrainer,
                trainer_args=args,
                vocabulary_path=args.vocab_metadata,
                imported_vocabulary_path=vocabulary,
            )

            malicious_architecture = {
                **valid,
                "config": {
                    "model_id": "fixture-model",
                    "embedding_dim": 1_000_000_000,
                },
            }
            with self.assertRaisesRegex(
                IMPORTER.NeuralRemoteArtifactError,
                "architecture differs",
            ):
                IMPORTER.preflight_checkpoint_payload(
                    malicious_architecture,
                    trainer=FakeTrainer,
                    trainer_args=args,
                    vocabulary_path=args.vocab_metadata,
                    imported_vocabulary_path=vocabulary,
                )

            malicious_vocabulary = {
                **valid,
                "inputVocab": {"<pad>": 0, "smuggled": 1},
            }
            with self.assertRaisesRegex(
                IMPORTER.NeuralRemoteArtifactError,
                "vocabulary differs",
            ):
                IMPORTER.preflight_checkpoint_payload(
                    malicious_vocabulary,
                    trainer=FakeTrainer,
                    trainer_args=args,
                    vocabulary_path=args.vocab_metadata,
                    imported_vocabulary_path=vocabulary,
                )

    def test_bundle_report_symlink_and_bad_run_ids_fail_closed(self) -> None:
        temporary_root = ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-remote-import-report-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            report_path = root / "bundle-report.json"
            report_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "status": "passed-closed-archive-build",
                        "artifactKind": IMPORTER.BUNDLE_KIND,
                        "bundleId": "a" * 64,
                        "archiveSha256": "b" * 64,
                        "modelId": "fixture-model",
                        "trainingConfig": (
                            "data/neural/training/"
                            "open-vocab-bigru-attention-v1.config.json"
                        ),
                        "datasetContentSha256": "c" * 64,
                        "goldCorpusSha256": "d" * 64,
                        "officialBenchmarkCorpusSha256": "e" * 64,
                    }
                ),
                encoding="utf-8",
            )
            alias = root / "bundle-report-alias.json"
            alias.symlink_to(report_path)
            with self.assertRaisesRegex(
                IMPORTER.NeuralRemoteArtifactError,
                "non-symlink",
            ):
                IMPORTER.read_bundle_report(alias)

        self.assertTrue(IMPORTER.valid_run_identifier("f" * 32))
        self.assertFalse(IMPORTER.valid_run_identifier("g" * 32))
        self.assertFalse(IMPORTER.valid_run_identifier("../not-a-run"))

    def test_training_only_export_report_contract_is_exact(self) -> None:
        training_modes = {
            "skipTrain": False,
            "skipCoreML": True,
            "trainingDevice": "cuda",
        }
        report = {"trainingExecutionModes": training_modes}
        manifest = {
            "modelId": "fixture-model",
            "trainingRunId": "a" * 32,
            "checkpointSha256": "b" * 64,
        }
        export_report = {
            "status": "passed-training-candidate-coreml-export-skipped",
            "modelId": manifest["modelId"],
            "trainingRunId": manifest["trainingRunId"],
            "checkpointSha256": manifest["checkpointSha256"],
            "trainingExecutionModes": training_modes,
            "executionModes": training_modes,
            "executionTopology": "training-only-no-coreml-v1",
            "artifactOverrides": {},
            "productionEligible": False,
        }
        IMPORTER.validate_training_only_export_report(
            export_report,
            report=report,
            manifest=manifest,
        )
        export_report["executionTopology"] = "forged-topology"
        with self.assertRaisesRegex(
            IMPORTER.NeuralRemoteArtifactError,
            "export report is invalid",
        ):
            IMPORTER.validate_training_only_export_report(
                export_report,
                report=report,
                manifest=manifest,
            )


if __name__ == "__main__":
    unittest.main()
