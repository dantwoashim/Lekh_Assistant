#!/usr/bin/env python3
"""Exact remote-candidate profiles that do not mutate training inputs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CANONICAL_PROFILE_ID = "canonical"
SEED_43_PROFILE_ID = "seed-43-challenger-v1"
CHALLENGER_SEED = 43
CONFIGURED_SEED = 42
CHALLENGER_SUFFIX = "--seed-43"
CTC_MODEL_ID = "lekh-open-vocab-ctc-transformer-v2"
CTC_CONFIG = (
    "data/neural/training/open-vocab-ctc-transformer-v2.config.json"
)
CTC_TRAINER = "scripts/train-open-vocab-ctc-transformer.py"
GENERATED_CANDIDATE_PARENT = (
    "data/generated/neural-open-vocab-model"
)
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$")

ACTIVE_BUNDLE_REPORT_CONTRACT: dict[str, Any] = {
    "archiveBytes": 99_316_415,
    "archiveSha256": (
        "b5968bad47dbeda072e213ee9e649ba5d14645f62e938a4524fae977d6684628"
    ),
    "bundleId": (
        "abc8ecfb2bfbcf3201cc2ad741b8c7ca98714882d25e93a0c38b900b3f136296"
    ),
    "datasetContentSha256": (
        "15909aac528fa0f2fb590e62981b0a0035422aa2673f9de4c7bc47ba2e778599"
    ),
    "goldCorpusSha256": (
        "d0cb6cef6df9f54b2adb25b4251ef24f4c93679a1c48005a50a0ac6c6519952b"
    ),
    "manifestSha256": (
        "d6df5e38ec525ceb17c9001f1cd26ce06f7c6987a1bd90b620341d1b16026df7"
    ),
    "modelId": CTC_MODEL_ID,
    "officialBenchmarkCorpusSha256": (
        "149d44c4e8832b91908c4bccfb67e60abcdf8ed99a1d873dc60ef7d0a130744a"
    ),
    "trainerPath": CTC_TRAINER,
    "trainingConfig": CTC_CONFIG,
}


class CandidateProfileError(ValueError):
    """A remote candidate does not satisfy its exact immutable profile."""


@dataclass(frozen=True)
class CandidateProfile:
    profile_id: str
    candidate_suffix: str
    seed: int | None
    exact_active_bundle: bool


CANONICAL_PROFILE = CandidateProfile(
    profile_id=CANONICAL_PROFILE_ID,
    candidate_suffix="",
    seed=None,
    exact_active_bundle=False,
)
SEED_43_PROFILE = CandidateProfile(
    profile_id=SEED_43_PROFILE_ID,
    candidate_suffix=CHALLENGER_SUFFIX,
    seed=CHALLENGER_SEED,
    exact_active_bundle=True,
)
PROFILES = {
    CANONICAL_PROFILE.profile_id: CANONICAL_PROFILE,
    SEED_43_PROFILE.profile_id: SEED_43_PROFILE,
}


def resolve_candidate_profile(value: str) -> CandidateProfile:
    try:
        return PROFILES[value]
    except (KeyError, TypeError) as error:
        raise CandidateProfileError(
            "Unsupported remote candidate profile. Expected exactly one of: "
            + ", ".join(sorted(PROFILES))
        ) from error


def require_profile_bundle_identity(
    profile: CandidateProfile,
    report: dict[str, Any],
) -> None:
    """Bind the challenger to the one already-authenticated active bundle."""

    if not profile.exact_active_bundle:
        return
    if not isinstance(report, dict):
        raise CandidateProfileError(
            "Seed-43 challenger bundle report must be one object."
        )
    mismatched = [
        field
        for field, expected in ACTIVE_BUNDLE_REPORT_CONTRACT.items()
        if report.get(field) != expected
    ]
    if mismatched:
        raise CandidateProfileError(
            "Seed-43 challenger bundle identity differs at: "
            + ", ".join(sorted(mismatched))
        )


def candidate_relative_path(
    profile: CandidateProfile,
    model_id: str,
) -> str:
    if (
        not isinstance(model_id, str)
        or SAFE_COMPONENT.fullmatch(model_id) is None
    ):
        raise CandidateProfileError("Remote candidate modelId is unsafe.")
    if profile is SEED_43_PROFILE and model_id != CTC_MODEL_ID:
        raise CandidateProfileError(
            "Seed-43 challenger supports only the active CTC modelId."
        )
    candidate_name = model_id + profile.candidate_suffix
    if SAFE_COMPONENT.fullmatch(candidate_name) is None:
        raise CandidateProfileError(
            "Remote candidate profile produces an unsafe directory."
        )
    return f"{GENERATED_CANDIDATE_PARENT}/{candidate_name}"


def candidate_override_argv(
    profile: CandidateProfile,
    *,
    root: Path,
    model_id: str,
) -> list[str]:
    if profile is CANONICAL_PROFILE:
        return []
    if profile is not SEED_43_PROFILE:
        raise CandidateProfileError("Unknown remote candidate profile.")
    return [
        "--out-dir",
        str(root / candidate_relative_path(profile, model_id)),
        "--seed",
        str(CHALLENGER_SEED),
    ]


def validate_profiled_trainer_args(
    profile: CandidateProfile,
    args: Any,
    *,
    root: Path,
) -> None:
    """Fail closed unless parsed args record only the seed-43 profile."""

    if profile is CANONICAL_PROFILE:
        return
    if profile is not SEED_43_PROFILE:
        raise CandidateProfileError("Unknown remote candidate profile.")

    candidate_relative = candidate_relative_path(profile, CTC_MODEL_ID)
    canonical_relative = candidate_relative_path(
        CANONICAL_PROFILE,
        CTC_MODEL_ID,
    )
    candidate_root = (root / candidate_relative).resolve()
    expected_config = (root / CTC_CONFIG).resolve()
    configured_artifacts = getattr(
        args,
        "configured_artifact_inputs",
        None,
    )
    effective_artifacts = getattr(
        args,
        "effective_artifact_inputs",
        None,
    )
    configured_training = getattr(
        args,
        "configured_training_config",
        None,
    )
    effective_training = getattr(
        args,
        "effective_training_config",
        None,
    )
    if (
        getattr(args, "model_id", None) != CTC_MODEL_ID
        or Path(getattr(args, "config", "")).resolve()
            != expected_config
        or getattr(args, "seed", None) != CHALLENGER_SEED
        or Path(getattr(args, "out_dir", "")).resolve()
            != candidate_root
        or not isinstance(configured_training, dict)
        or configured_training.get("trainingRun", {}).get("seed")
            != CONFIGURED_SEED
        or not isinstance(effective_training, dict)
        or effective_training.get("trainingRun", {}).get("seed")
            != CHALLENGER_SEED
    ):
        raise CandidateProfileError(
            "Parsed trainer args do not match the seed-43 challenger."
        )

    expected_training_overrides = {
        "trainingRun.seed": {
            "configured": CONFIGURED_SEED,
            "effective": CHALLENGER_SEED,
            "source": "command-line",
        }
    }
    if getattr(args, "training_overrides", None) != (
        expected_training_overrides
    ):
        raise CandidateProfileError(
            "Seed-43 challenger contains unexpected training overrides."
        )

    stems = {
        "outDir": "",
        "compiledModel": "/LekhNeuralTransliterator.mlmodelc",
        "manifest": "/LekhNeuralTransliterator.manifest.json",
        "vocabMetadata": "/LekhNeuralTransliterator.vocab.json",
    }
    if not isinstance(configured_artifacts, dict) or not isinstance(
        effective_artifacts,
        dict,
    ):
        raise CandidateProfileError(
            "Seed-43 challenger artifact bindings are missing."
        )
    expected_artifact_overrides: dict[str, dict[str, str]] = {}
    for field, suffix in stems.items():
        configured = canonical_relative + suffix
        effective = candidate_relative + suffix
        if (
            configured_artifacts.get(field) != configured
            or effective_artifacts.get(field) != effective
        ):
            raise CandidateProfileError(
                "Seed-43 challenger artifact roots are not exact."
            )
        expected_artifact_overrides[field] = {
            "configured": configured,
            "effective": effective,
            "source": (
                "command-line"
                if field == "outDir"
                else "derived"
            ),
        }
    if getattr(args, "artifact_overrides", None) != (
        expected_artifact_overrides
    ):
        raise CandidateProfileError(
            "Seed-43 challenger contains unexpected artifact overrides."
        )

