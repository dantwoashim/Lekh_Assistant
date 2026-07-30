#!/usr/bin/env python3
"""Tests for the exact seed-43 remote-candidate profile."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from neural_remote_candidate_profile import (
    ACTIVE_BUNDLE_REPORT_CONTRACT,
    CANONICAL_PROFILE,
    CHALLENGER_SEED,
    CTC_CONFIG,
    CTC_MODEL_ID,
    CandidateProfileError,
    SEED_43_PROFILE,
    SEED_43_PROFILE_ID,
    candidate_override_argv,
    candidate_relative_path,
    require_profile_bundle_identity,
    resolve_candidate_profile,
    validate_profiled_trainer_args,
)


def fixture_args(root: Path) -> SimpleNamespace:
    canonical = candidate_relative_path(CANONICAL_PROFILE, CTC_MODEL_ID)
    challenger = candidate_relative_path(SEED_43_PROFILE, CTC_MODEL_ID)
    configured_artifacts = {
        "outDir": canonical,
        "compiledModel": (
            canonical + "/LekhNeuralTransliterator.mlmodelc"
        ),
        "manifest": (
            canonical + "/LekhNeuralTransliterator.manifest.json"
        ),
        "vocabMetadata": (
            canonical + "/LekhNeuralTransliterator.vocab.json"
        ),
    }
    effective_artifacts = {
        field: value.replace(canonical, challenger, 1)
        for field, value in configured_artifacts.items()
    }
    artifact_overrides = {
        field: {
            "configured": configured_artifacts[field],
            "effective": effective_artifacts[field],
            "source": (
                "command-line"
                if field == "outDir"
                else "derived"
            ),
        }
        for field in configured_artifacts
    }
    return SimpleNamespace(
        model_id=CTC_MODEL_ID,
        config=root / CTC_CONFIG,
        seed=CHALLENGER_SEED,
        out_dir=root / challenger,
        configured_training_config={"trainingRun": {"seed": 42}},
        effective_training_config={
            "trainingRun": {"seed": CHALLENGER_SEED}
        },
        training_overrides={
            "trainingRun.seed": {
                "configured": 42,
                "effective": CHALLENGER_SEED,
                "source": "command-line",
            }
        },
        configured_artifact_inputs=configured_artifacts,
        effective_artifact_inputs=effective_artifacts,
        artifact_overrides=artifact_overrides,
    )


class CandidateProfileTests(unittest.TestCase):
    def test_profile_is_exact_and_additive(self) -> None:
        profile = resolve_candidate_profile(SEED_43_PROFILE_ID)
        self.assertIs(profile, SEED_43_PROFILE)
        self.assertEqual(
            candidate_relative_path(profile, CTC_MODEL_ID),
            (
                "data/generated/neural-open-vocab-model/"
                "lekh-open-vocab-ctc-transformer-v2--seed-43"
            ),
        )
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-profile-",
        ) as directory:
            root = Path(directory)
            argv = candidate_override_argv(
                profile,
                root=root,
                model_id=CTC_MODEL_ID,
            )
            self.assertEqual(argv[-2:], ["--seed", "43"])
            self.assertTrue(argv[1].endswith("--seed-43"))
            validate_profiled_trainer_args(
                profile,
                fixture_args(root),
                root=root,
            )

    def test_bundle_identity_and_profile_names_fail_closed(self) -> None:
        require_profile_bundle_identity(
            SEED_43_PROFILE,
            dict(ACTIVE_BUNDLE_REPORT_CONTRACT),
        )
        mismatched = dict(ACTIVE_BUNDLE_REPORT_CONTRACT)
        mismatched["bundleId"] = "f" * 64
        with self.assertRaisesRegex(
            CandidateProfileError,
            "bundleId",
        ):
            require_profile_bundle_identity(
                SEED_43_PROFILE,
                mismatched,
            )
        with self.assertRaisesRegex(
            CandidateProfileError,
            "Unsupported",
        ):
            resolve_candidate_profile("seed-44")

    def test_seed_path_and_override_drift_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-seed-43-profile-drift-",
        ) as directory:
            root = Path(directory)
            for field, replacement in (
                ("seed", 42),
                ("out_dir", root / "candidate-1"),
                ("training_overrides", {}),
                ("artifact_overrides", {}),
            ):
                args = fixture_args(root)
                setattr(args, field, replacement)
                with self.subTest(field=field), self.assertRaises(
                    CandidateProfileError
                ):
                    validate_profiled_trainer_args(
                        SEED_43_PROFILE,
                        args,
                        root=root,
                    )


if __name__ == "__main__":
    unittest.main()
