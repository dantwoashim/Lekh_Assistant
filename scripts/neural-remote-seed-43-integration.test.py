#!/usr/bin/env python3
"""Focused import/export integration tests for the seed-43 challenger."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_script(name: str, filename: str):
    path = ROOT / "scripts" / filename
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"Unable to load test subject: {path}")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


IMPORTER = load_script(
    "lekh_seed_43_importer_test_subject",
    "import-neural-remote-training-result.py",
)
EXPORTER = load_script(
    "lekh_seed_43_exporter_test_subject",
    "export-neural-remote-training-result.py",
)


class Seed43ImportExportIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile = IMPORTER.resolve_candidate_profile(
            IMPORTER.SEED_43_PROFILE_ID
        )
        cls.trainer = IMPORTER.import_trainer(
            IMPORTER.CTC_TRAINER,
            config_relative=IMPORTER.CTC_CONFIG,
        )
        cls.trainer_args = cls.trainer.parse_args(
            [
                "--config",
                str(ROOT / IMPORTER.CTC_CONFIG),
                *IMPORTER.candidate_override_argv(
                    cls.profile,
                    root=ROOT,
                    model_id=IMPORTER.CTC_MODEL_ID,
                ),
                "--training-device",
                "cpu",
                "--skip-train",
            ],
            {},
        )

    def test_real_trainer_records_only_seed_and_sibling_path_overrides(
        self,
    ) -> None:
        IMPORTER.validate_profiled_trainer_args(
            self.profile,
            self.trainer_args,
            root=ROOT,
        )
        self.assertEqual(
            self.trainer_args.training_overrides,
            {
                "trainingRun.seed": {
                    "configured": 42,
                    "effective": 43,
                    "source": "command-line",
                }
            },
        )
        self.assertEqual(
            set(self.trainer_args.artifact_overrides),
            {
                "outDir",
                "compiledModel",
                "manifest",
                "vocabMetadata",
            },
        )
        self.assertTrue(
            str(self.trainer_args.out_dir).endswith("--seed-43")
        )

    def test_importer_accepts_only_the_recorded_challenger_overrides(
        self,
    ) -> None:
        modes = {
            "skipTrain": False,
            "skipCoreML": True,
            "trainingDevice": "cuda",
        }
        report = {"trainingExecutionModes": modes}
        manifest = {
            "modelId": IMPORTER.CTC_MODEL_ID,
            "trainingRunId": "a" * 32,
            "checkpointSha256": "b" * 64,
        }
        export_report = {
            "status": "passed-training-candidate-coreml-export-skipped",
            "modelId": manifest["modelId"],
            "trainingRunId": manifest["trainingRunId"],
            "checkpointSha256": manifest["checkpointSha256"],
            "trainingExecutionModes": modes,
            "executionModes": modes,
            "executionTopology": "training-only-no-coreml-v1",
            "artifactOverrides": self.trainer_args.artifact_overrides,
            "productionEligible": False,
        }
        IMPORTER.validate_training_only_export_report(
            export_report,
            report=report,
            manifest=manifest,
            expected_artifact_overrides=(
                self.trainer_args.artifact_overrides
            ),
        )
        export_report["artifactOverrides"] = {}
        with self.assertRaisesRegex(
            IMPORTER.NeuralRemoteArtifactError,
            "export report is invalid",
        ):
            IMPORTER.validate_training_only_export_report(
                export_report,
                report=report,
                manifest=manifest,
                expected_artifact_overrides=(
                    self.trainer_args.artifact_overrides
                ),
            )

    def test_exporter_uses_the_same_finite_profile_contract(self) -> None:
        exporter_profile = EXPORTER.resolve_candidate_profile(
            EXPORTER.SEED_43_PROFILE_ID
        )
        argv = EXPORTER.candidate_override_argv(
            exporter_profile,
            root=ROOT,
            model_id=EXPORTER.CTC_MODEL_ID,
        )
        self.assertEqual(argv[-2:], ["--seed", "43"])
        self.assertTrue(argv[1].endswith("--seed-43"))
        EXPORTER.validate_profiled_trainer_args(
            exporter_profile,
            self.trainer_args,
            root=ROOT,
        )


if __name__ == "__main__":
    unittest.main()
