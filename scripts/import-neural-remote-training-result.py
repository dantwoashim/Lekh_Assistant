#!/usr/bin/env python3
"""Verify a CUDA result archive and optionally publish its candidate on macOS."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import torch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    BUNDLE_KIND,
    RESULT_KIND,
    NeuralRemoteArtifactError,
    contained_regular_file,
    is_sha256,
    read_json_object,
    safe_filename_component,
    safe_relative_path,
    sha256_file,
    trainer_path_for_config,
    verify_closed_archive,
    verify_extracted_tree,
)

MAX_REMOTE_CHECKPOINT_BYTES = 128 * 1024 * 1024
CANONICAL_CANDIDATE_PARENT = (
    "data/generated/neural-open-vocab-model"
)
REMOTE_TOOLCHAIN_PROFILE = "linux-cuda-cu118"
REMOTE_PYTHON_VERSION = "3.11.15"
REMOTE_TORCH_VERSION = "2.7.0+cu118"
REMOTE_CUDA_VERSION = "11.8"
REQUIREMENT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def normalize_distribution_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_exact_requirement_versions(path: Path) -> dict[str, str]:
    versions: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, version = line.partition("==")
        if (
            not separator
            or not REQUIREMENT_NAME.fullmatch(name)
            or not version
            or "==" in version
        ):
            raise NeuralRemoteArtifactError(
                f"Remote dependency lock is not exact: {path}"
            )
        normalized = normalize_distribution_name(name)
        if normalized in versions:
            raise NeuralRemoteArtifactError(
                f"Remote dependency lock repeats {normalized}: {path}"
            )
        versions[normalized] = version
    return versions


def expected_remote_package_versions() -> dict[str, str]:
    local = read_exact_requirement_versions(
        ROOT / "requirements/neural-open-vocab.lock"
    )
    cuda = read_exact_requirement_versions(
        ROOT / "requirements/neural-open-vocab-cu118.lock"
    )
    if local.pop("torch", None) != "2.7.0":
        raise NeuralRemoteArtifactError(
            "Local neural dependency lock has unexpected torch pin."
        )
    if cuda.get("torch") != REMOTE_TORCH_VERSION:
        raise NeuralRemoteArtifactError(
            "CUDA neural dependency lock has unexpected torch pin."
        )
    overlap = set(local).intersection(cuda)
    if overlap:
        raise NeuralRemoteArtifactError(
            "Local and CUDA dependency locks overlap outside torch: "
            f"{sorted(overlap)}"
        )
    return {**local, **cuda}


def normalize_observed_package_versions(
    packages: Any,
) -> dict[str, str]:
    if not isinstance(packages, dict):
        raise NeuralRemoteArtifactError(
            "Remote toolchain package inventory is not an object."
        )
    normalized: dict[str, str] = {}
    for name, version in packages.items():
        if (
            not isinstance(name, str)
            or not REQUIREMENT_NAME.fullmatch(name)
            or not isinstance(version, str)
            or not version
        ):
            raise NeuralRemoteArtifactError(
                "Remote toolchain package inventory is malformed."
            )
        canonical = normalize_distribution_name(name)
        if canonical in normalized:
            raise NeuralRemoteArtifactError(
                "Remote toolchain package inventory has canonical duplicates."
            )
        normalized[canonical] = version
    return normalized


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify a closed CUDA result, safe-load its checkpoint, bind it "
            "to current trainer/config/data/gold bytes, and optionally publish "
            "the candidate for the short local Core ML export phase."
        )
    )
    parser.add_argument("archive", type=Path)
    parser.add_argument("--bundle-report", type=Path, required=True)
    parser.add_argument("--expected-result-sha256")
    parser.add_argument(
        "--staging-root",
        type=Path,
        default=ROOT / ".tmp/neural-remote-imports",
    )
    parser.add_argument("--publish", action="store_true")
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help=(
            "Move an existing canonical candidate into a recoverable .tmp "
            "backup before publishing the verified CUDA result."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        bundle_report = read_bundle_report(args.bundle_report)
        verification = verify_closed_archive(
            args.archive,
            expected_kind=RESULT_KIND,
            expected_archive_sha256=args.expected_result_sha256,
        )
        manifest = verification["manifest"]
        if manifest.get("bundleId") != bundle_report["bundleId"]:
            raise NeuralRemoteArtifactError(
                "Result bundleId differs from the trusted local bundle report."
            )
        result_id = verification["resultId"]
        staging_root = prepare_staging_root(args.staging_root)
        extracted = staging_root / result_id
        if extracted.exists():
            existing_manifest = read_json_object(
                contained_regular_file(
                    extracted,
                    "NEURAL_REMOTE_RESULT_MANIFEST.json",
                )
            )
            if existing_manifest.get("resultId") != result_id:
                raise NeuralRemoteArtifactError(
                    "Existing import staging has another result identity."
                )
        else:
            verify_closed_archive(
                args.archive,
                expected_kind=RESULT_KIND,
                expected_archive_sha256=verification["archiveSha256"],
                extract_to=extracted,
            )
        evidence = validate_extracted_result(
            extracted,
            manifest,
            bundle_report,
        )
        publication = {
            "published": False,
            "candidateRoot": None,
            "backup": None,
        }
        if args.publish:
            publication = publish_candidate(
                extracted,
                evidence["candidateRelative"],
                replace_existing=args.replace_existing,
            )
        report = {
            "schemaVersion": 1,
            "status": "passed-neural-remote-result-import",
            "bundleId": bundle_report["bundleId"],
            "resultId": result_id,
            "modelId": manifest["modelId"],
            "trainingRunId": manifest["trainingRunId"],
            "resultArchive": str(Path(args.archive).resolve()),
            "resultArchiveSha256": verification["archiveSha256"],
            "stagedAt": str(extracted),
            **publication,
            "nextCommand": (
                (
                    ".tmp/neural-seq2seq-venv/bin/python "
                    "scripts/export-neural-remote-training-result.py "
                    f"--config {manifest['trainingConfig']}"
                )
                if publication["published"]
                else (
                    "Re-run this importer with --publish after reviewing the "
                    "verified result."
                )
            ),
        }
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (NeuralRemoteArtifactError, OSError, SystemExit) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-remote-result-import",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


def read_bundle_report(path: Path) -> dict[str, Any]:
    requested = path.absolute()
    metadata = requested.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise NeuralRemoteArtifactError(
            "Trusted local bundle report must be a regular non-symlink file."
        )
    report = read_json_object(requested)
    if (
        report.get("schemaVersion") != 1
        or report.get("status") != "passed-closed-archive-build"
        or report.get("artifactKind") != BUNDLE_KIND
        or not is_sha256(report.get("bundleId"))
        or not is_sha256(report.get("archiveSha256"))
        or not isinstance(report.get("modelId"), str)
        or not report["modelId"]
        or not is_sha256(report.get("datasetContentSha256"))
        or not is_sha256(report.get("goldCorpusSha256"))
        or not is_sha256(report.get("officialBenchmarkCorpusSha256"))
    ):
        raise NeuralRemoteArtifactError(
            "Trusted local bundle report is invalid."
        )
    config_relative = safe_relative_path(
        report.get("trainingConfig"),
        "bundle report training config",
    )
    expected_trainer = trainer_path_for_config(config_relative)
    observed_trainer = report.get("trainerPath")
    if (
        observed_trainer is not None
        and observed_trainer != expected_trainer
    ):
        raise NeuralRemoteArtifactError(
            "Trusted bundle report trainer differs from its config."
        )
    return {
        **report,
        "trainerPath": expected_trainer,
    }


def prepare_staging_root(requested: Path) -> Path:
    requested.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = requested.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise NeuralRemoteArtifactError(
            f"Import staging root is unsafe: {requested}"
        )
    resolved = requested.resolve(strict=True)
    if not resolved.is_relative_to(ROOT.resolve(strict=True)):
        raise NeuralRemoteArtifactError(
            "Import staging must remain inside the repository."
        )
    return resolved


def validate_extracted_result(
    extracted: Path,
    manifest: dict[str, Any],
    bundle_report: dict[str, Any],
) -> dict[str, Any]:
    extracted_manifest = verify_extracted_tree(
        extracted,
        expected_kind=RESULT_KIND,
    )
    if extracted_manifest.get("resultId") != manifest.get("resultId"):
        raise NeuralRemoteArtifactError(
            "Extracted result identity differs from the verified archive."
        )
    manifest = extracted_manifest
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("artifactKind") != RESULT_KIND
        or manifest.get("bundleId") != bundle_report["bundleId"]
        or manifest.get("modelId") != bundle_report["modelId"]
        or manifest.get("trainingConfig")
            != bundle_report["trainingConfig"]
        or not valid_run_identifier(manifest.get("trainingRunId"))
        or not is_sha256(manifest.get("checkpointSha256"))
        or not isinstance(manifest.get("trainingRuntime"), dict)
        or not isinstance(manifest.get("toolchain"), dict)
    ):
        raise NeuralRemoteArtifactError("Remote result manifest is invalid.")
    config_relative = safe_relative_path(
        manifest.get("trainingConfig"),
        "result training config",
    )
    expected_trainer = trainer_path_for_config(config_relative)
    manifest_trainer = manifest.get("trainerPath")
    if (
        bundle_report.get("trainerPath") != expected_trainer
        or (
            manifest_trainer is not None
            and manifest_trainer != expected_trainer
        )
    ):
        raise NeuralRemoteArtifactError(
            "Remote result trainer differs from its authenticated config."
        )
    trainer = import_trainer(
        expected_trainer,
        config_relative=config_relative,
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
    if trainer_args.model_id != manifest["modelId"]:
        raise NeuralRemoteArtifactError(
            "Remote result modelId differs from the local config."
        )
    candidate_relative = trainer_args.out_dir.relative_to(ROOT).as_posix()
    expected_roles = {
        "checkpoint": (
            trainer.checkpoint_path(trainer_args)
            .relative_to(ROOT)
            .as_posix()
        ),
        "training-report": (
            trainer.training_report_path(trainer_args)
            .relative_to(ROOT)
            .as_posix()
        ),
        "vocabulary": trainer_args.vocab_metadata
            .relative_to(ROOT)
            .as_posix(),
    }
    optional_role = "training-only-export-report"
    files = manifest.get("files")
    expected_export = (
        trainer.export_report_path(trainer_args)
        .relative_to(ROOT)
        .as_posix()
    )
    role_paths = validate_result_role_inventory(
        files,
        expected_roles=expected_roles,
        optional_role=optional_role,
        optional_path=expected_export,
    )

    checkpoint_path = contained_regular_file(
        extracted,
        expected_roles["checkpoint"],
    )
    training_report_path = contained_regular_file(
        extracted,
        expected_roles["training-report"],
    )
    vocabulary_path = contained_regular_file(
        extracted,
        expected_roles["vocabulary"],
    )
    report = read_json_object(training_report_path)
    validate_training_report(
        report,
        manifest=manifest,
        trainer=trainer,
        trainer_args=trainer_args,
        checkpoint_path=checkpoint_path,
        vocabulary_path=vocabulary_path,
    )
    validate_checkpoint(
        checkpoint_path,
        report,
        trainer=trainer,
        trainer_args=trainer_args,
        vocabulary_path=vocabulary_path,
    )
    if optional_role in role_paths:
        validate_training_only_export_report(
            read_json_object(
                contained_regular_file(
                    extracted,
                    role_paths[optional_role],
                )
            ),
            report=report,
            manifest=manifest,
        )
    local_snapshot = trainer.capture_run_input_snapshot(
        trainer_args,
        freeze_dataset=False,
    )
    if not trainer.run_input_snapshots_share_immutable_inputs(
        report["runInputSnapshot"],
        local_snapshot,
    ):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint inputs differ from current trainer/config/data/gold."
        )
    return {
        "candidateRelative": candidate_relative,
        "checkpointSha256": report["checkpointSha256"],
    }


def import_trainer(
    trainer_relative: str,
    *,
    config_relative: str,
) -> Any:
    expected = trainer_path_for_config(config_relative)
    if trainer_relative != expected:
        raise NeuralRemoteArtifactError(
            "Trainer path differs from the authenticated result config."
        )
    path = contained_regular_file(
        ROOT,
        trainer_relative,
    )
    specification = importlib.util.spec_from_file_location(
        "lekh_remote_result_import_trainer",
        path,
    )
    if specification is None or specification.loader is None:
        raise NeuralRemoteArtifactError("Unable to load the neural trainer.")
    trainer = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = trainer
    try:
        specification.loader.exec_module(trainer)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return trainer


def validate_result_role_inventory(
    files: Any,
    *,
    expected_roles: dict[str, str],
    optional_role: str,
    optional_path: str,
) -> dict[str, str]:
    if not isinstance(files, list):
        raise NeuralRemoteArtifactError(
            "Remote result file inventory is invalid."
        )
    role_paths: dict[str, str] = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise NeuralRemoteArtifactError(
                "Remote result file inventory is invalid."
            )
        role = entry.get("role")
        path = entry.get("path")
        if not isinstance(role, str) or not isinstance(path, str):
            raise NeuralRemoteArtifactError(
                "Remote result role/path evidence is invalid."
            )
        if role in role_paths:
            raise NeuralRemoteArtifactError(
                f"Remote result contains duplicate artifact role: {role}"
            )
        role_paths[role] = path
    accepted_roles = (
        set(expected_roles),
        {*expected_roles, optional_role},
    )
    if set(role_paths) not in accepted_roles:
        raise NeuralRemoteArtifactError(
            "Remote result contains unexpected artifact roles."
        )
    if any(
        role_paths.get(role) != path
        for role, path in expected_roles.items()
    ):
        raise NeuralRemoteArtifactError(
            "Remote result uses non-canonical candidate paths."
        )
    if (
        optional_role in role_paths
        and role_paths[optional_role] != optional_path
    ):
        raise NeuralRemoteArtifactError(
            "Remote training-only export report path is non-canonical."
        )
    return role_paths


def validate_training_report(
    report: dict[str, Any],
    *,
    manifest: dict[str, Any],
    trainer: Any,
    trainer_args: Any,
    checkpoint_path: Path,
    vocabulary_path: Path,
) -> None:
    snapshot = report.get("runInputSnapshot")
    runtime = (
        snapshot.get("runtime", {})
        if isinstance(snapshot, dict)
        else {}
    )
    cuda_value = runtime.get("cuda") if isinstance(runtime, dict) else None
    cuda = cuda_value if isinstance(cuda_value, dict) else {}
    toolchain = manifest.get("toolchain")
    packages = (
        toolchain.get("packages", {})
        if isinstance(toolchain, dict)
        else {}
    )
    observed_packages = normalize_observed_package_versions(packages)
    expected_packages = expected_remote_package_versions()
    runtime_python = runtime.get("python")
    trainer_sha256 = sha256_file(Path(trainer.__file__).resolve(strict=True))
    if (
        report.get("status") != "passed-training-checkpoint"
        or report.get("trainingComplete") is not True
        or report.get("modelId") != manifest["modelId"]
        or report.get("trainingRunId") != manifest["trainingRunId"]
        or report.get("trainingExecutionModes") != {
            "skipTrain": False,
            "skipCoreML": True,
            "trainingDevice": "cuda",
        }
        or report.get("trainerSha256") != trainer_sha256
        or report.get("checkpointSha256") != sha256_file(checkpoint_path)
        or report.get("checkpointSha256")
            != manifest.get("checkpointSha256")
        or report.get("vocabMetadataSha256")
            != sha256_file(vocabulary_path)
        or manifest.get("trainingRuntime") != runtime
        or toolchain.get("status")
            != "passed-neural-open-vocab-toolchain"
        or toolchain.get("profile") != REMOTE_TOOLCHAIN_PROFILE
        or toolchain.get("python")
            != runtime.get("python")
        or observed_packages != expected_packages
        or packages.get("torch")
            != runtime.get("torch")
        or packages.get("numpy")
            != runtime.get("numpy")
        or packages.get("coremltools") != runtime.get("coremltools")
        or runtime.get("trainingDevice") != "cuda"
        or runtime.get("deterministicAlgorithms") is not True
        or runtime_python != REMOTE_PYTHON_VERSION
        or runtime.get("torch") != REMOTE_TORCH_VERSION
        or runtime.get("numpy") != "1.26.4"
        or runtime.get("coremltools") != "9.0"
        or runtime.get("machine") != "x86_64"
        or cuda.get("available") is not True
        or cuda.get("runtimeVersion") != REMOTE_CUDA_VERSION
        or cuda.get("cublasWorkspaceConfig") != ":4096:8"
        or cuda.get("cudnnBenchmark") is not False
        or cuda.get("cudnnDeterministic") is not True
        or report.get("trainingContractSha256")
            != trainer_args.training_contract_sha256
        or report.get("effectiveTrainingConfigSha256")
            != trainer_args.effective_training_config_sha256
        or report.get("effectiveArtifactInputsSha256")
            != trainer_args.effective_artifact_inputs_sha256
        or report.get("artifactOverrides") != {}
    ):
        raise NeuralRemoteArtifactError(
            "Remote training report fails deterministic CUDA provenance."
        )


def validate_checkpoint(
    checkpoint_path: Path,
    report: dict[str, Any],
    *,
    trainer: Any,
    trainer_args: Any,
    vocabulary_path: Path,
) -> None:
    checkpoint_bytes = checkpoint_path.stat().st_size
    if not 1 <= checkpoint_bytes <= MAX_REMOTE_CHECKPOINT_BYTES:
        raise NeuralRemoteArtifactError(
            "Remote checkpoint exceeds the safe import size limit."
        )
    try:
        with trainer.open_regular_binary(
            checkpoint_path,
            "remote checkpoint",
        ) as handle:
            checkpoint = torch.load(
                handle,
                map_location="cpu",
                weights_only=True,
            )
    except Exception as error:
        raise NeuralRemoteArtifactError(
            "Remote checkpoint failed safe tensor-only loading."
        ) from error
    preflight_checkpoint_payload(
        checkpoint,
        trainer=trainer,
        trainer_args=trainer_args,
        vocabulary_path=trainer_args.vocab_metadata,
        imported_vocabulary_path=vocabulary_path,
    )
    if (
        not isinstance(checkpoint, dict)
        or checkpoint.get("modelId") != report.get("modelId")
        or checkpoint.get("trainingRunId") != report.get("trainingRunId")
        or checkpoint.get("trainerSha256") != report.get("trainerSha256")
        or checkpoint.get("runInputSnapshot")
            != report.get("runInputSnapshot")
        or checkpoint.get("vocabMetadataSha256")
            != report.get("vocabMetadataSha256")
    ):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint and training report provenance differ."
        )
    for field in (
        "trainingRunId",
        "trainingContractSha256",
        "configuredTrainingConfig",
        "effectiveTrainingConfig",
        "effectiveTrainingConfigCanonicalJson",
        "effectiveTrainingConfigSha256",
        "trainingOverrides",
        "configuredArtifactInputs",
        "effectiveArtifactInputs",
        "effectiveArtifactInputsCanonicalJson",
        "effectiveArtifactInputsSha256",
        "artifactOverrides",
        "runInputSnapshot",
        "trainerSha256",
        "vocabMetadataSha256",
        "sampledRowDigests",
    ):
        if report.get(field) != checkpoint.get(field):
            raise NeuralRemoteArtifactError(
                f"Remote report/checkpoint provenance differs: {field}"
            )
    if (
        checkpoint.get("trainingContractSha256")
            != trainer_args.training_contract_sha256
        or checkpoint.get("configuredTrainingConfig")
            != trainer_args.configured_training_config
        or checkpoint.get("effectiveTrainingConfig")
            != trainer_args.effective_training_config
        or checkpoint.get("effectiveTrainingConfigCanonicalJson")
            != trainer.canonical_json_text(
                checkpoint.get("effectiveTrainingConfig")
            )
        or checkpoint.get("effectiveTrainingConfigSha256")
            != trainer.sha256_text(
                checkpoint.get("effectiveTrainingConfigCanonicalJson")
            )
        or checkpoint.get("trainingOverrides")
            != trainer_args.training_overrides
        or checkpoint.get("configuredArtifactInputs")
            != trainer_args.configured_artifact_inputs
        or checkpoint.get("effectiveArtifactInputs")
            != trainer_args.effective_artifact_inputs
        or checkpoint.get("effectiveArtifactInputsCanonicalJson")
            != trainer.canonical_json_text(
                checkpoint.get("effectiveArtifactInputs")
            )
        or checkpoint.get("effectiveArtifactInputsSha256")
            != trainer.sha256_text(
                checkpoint.get("effectiveArtifactInputsCanonicalJson")
            )
        or checkpoint.get("artifactOverrides")
            != trainer_args.artifact_overrides
    ):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint differs from the effective local contract."
        )
    model = trainer.load_model_from_checkpoint_payload(checkpoint)
    validate_checkpoint_runtime_bindings_with_imported_vocabulary(
        trainer,
        trainer_args,
        checkpoint,
        model,
        vocabulary_path,
    )
    parameter_count = sum(
        parameter.numel() for parameter in model.parameters()
    )
    if parameter_count != report.get("parameterCount"):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint parameter count is stale."
        )


def validate_checkpoint_runtime_bindings_with_imported_vocabulary(
    trainer: Any,
    trainer_args: Any,
    checkpoint: dict[str, Any],
    model: Any,
    vocabulary_path: Path,
) -> None:
    imported_args = copy.copy(trainer_args)
    imported_args.vocab_metadata = vocabulary_path
    trainer.validate_checkpoint_runtime_bindings(
        imported_args,
        checkpoint,
        model,
    )


def preflight_checkpoint_payload(
    checkpoint: Any,
    *,
    trainer: Any,
    trainer_args: Any,
    vocabulary_path: Path,
    imported_vocabulary_path: Path,
) -> None:
    if not isinstance(checkpoint, dict):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint payload must be an object."
        )
    if checkpoint.get("config") != trainer.checkpoint_runtime_config(
        trainer_args
    ):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint architecture differs from the local config."
        )
    input_vocab = checkpoint.get("inputVocab")
    output_vocab = checkpoint.get("outputVocab")
    if not isinstance(input_vocab, dict) or not isinstance(output_vocab, dict):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint vocabulary payload is invalid."
        )
    imported_vocabulary = read_json_object(imported_vocabulary_path)
    imported_input = imported_vocabulary.get("input")
    imported_output = imported_vocabulary.get("output")
    if (
        not isinstance(imported_input, dict)
        or not isinstance(imported_output, dict)
        or imported_input.get("idsByToken") != input_vocab
        or imported_output.get("idsByToken") != output_vocab
        or imported_vocabulary_path.name != vocabulary_path.name
    ):
        raise NeuralRemoteArtifactError(
            "Remote checkpoint vocabulary differs from its metadata."
        )


def validate_training_only_export_report(
    export_report: dict[str, Any],
    *,
    report: dict[str, Any],
    manifest: dict[str, Any],
) -> None:
    if (
        export_report.get("status")
            != "passed-training-candidate-coreml-export-skipped"
        or export_report.get("modelId") != manifest["modelId"]
        or export_report.get("trainingRunId")
            != manifest["trainingRunId"]
        or export_report.get("checkpointSha256")
            != manifest["checkpointSha256"]
        or export_report.get("trainingExecutionModes")
            != report.get("trainingExecutionModes")
        or export_report.get("executionModes") != {
            "skipTrain": False,
            "skipCoreML": True,
            "trainingDevice": "cuda",
        }
        or export_report.get("executionTopology")
            != "training-only-no-coreml-v1"
        or export_report.get("artifactOverrides") != {}
        or export_report.get("productionEligible") is not False
    ):
        raise NeuralRemoteArtifactError(
            "Remote training-only export report is invalid."
        )


def valid_run_identifier(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 32
        and all(character in "0123456789abcdef" for character in value)
    )


def publish_candidate(
    extracted: Path,
    candidate_relative: str,
    *,
    replace_existing: bool,
) -> dict[str, Any]:
    candidate_relative = safe_relative_path(
        candidate_relative,
        "candidate publication path",
    )
    parsed = PurePosixPath(candidate_relative)
    parent = PurePosixPath(CANONICAL_CANDIDATE_PARENT)
    if (
        parsed.parent != parent
        or safe_filename_component(parsed.name, "candidate model id")
            != parsed.name
    ):
        raise NeuralRemoteArtifactError(
            "Candidate publication path is not a canonical model directory."
        )
    source = extracted.joinpath(*parsed.parts)
    source_metadata = source.lstat()
    if (
        stat.S_ISLNK(source_metadata.st_mode)
        or not stat.S_ISDIR(source_metadata.st_mode)
    ):
        raise NeuralRemoteArtifactError(
            "Verified result lacks a safe candidate directory."
        )
    target = ROOT.joinpath(*parsed.parts)
    canonical_parent = (
        ROOT / CANONICAL_CANDIDATE_PARENT
    ).resolve(strict=True)
    if target.resolve().parent != canonical_parent:
        raise NeuralRemoteArtifactError(
            "Candidate publication target escapes its canonical parent."
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir():
            raise NeuralRemoteArtifactError(
                f"Canonical candidate target is unsafe: {target}"
            )
        if not replace_existing:
            raise NeuralRemoteArtifactError(
                "Canonical candidate already exists; pass --replace-existing "
                "to preserve it in a recoverable backup."
            )
        backup_root = ROOT / ".tmp/neural-remote-imports/backups"
        backup_root.mkdir(parents=True, exist_ok=True)
        backup = backup_root / (
            f"{target.name}.{uuid.uuid4().hex}.backup"
        )
        os.replace(target, backup)
    try:
        os.replace(source, target)
    except BaseException:
        if backup is not None and not target.exists() and backup.exists():
            os.replace(backup, target)
        raise
    return {
        "published": True,
        "candidateRoot": str(target),
        "backup": str(backup) if backup is not None else None,
    }


if __name__ == "__main__":
    raise SystemExit(main())
