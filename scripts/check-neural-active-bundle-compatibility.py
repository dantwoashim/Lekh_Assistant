#!/usr/bin/env python3
"""Fail closed when the active remote-training bundle drifts from the repo."""

from __future__ import annotations

import argparse
import json
import re
import stat
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    BUNDLE_KIND,
    NeuralRemoteArtifactError,
    contained_regular_file,
    is_sha256,
    read_json_object,
    safe_relative_path,
    sha256_file,
    verify_closed_archive,
)


DEFAULT_MANIFEST = (
    ROOT / "data/neural/training/active-remote-run.v1.json"
)
GENERATED_PREFIX = "data/generated/"
RUN_IDENTIFIER = re.compile(r"^[0-9a-f]{32}$")
RECOVERY_GENERATION = re.compile(r"^epoch-([0-9]{6})-([0-9a-f]{16})$")
RECOVERY_STATE = re.compile(
    r"^[.]training-recovery[.][0-9a-f]{32}[.][1-9][0-9]*[.]pt$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify that the active recoverable training run still matches "
            "the exact trainer, dependencies, config, data, and evaluation "
            "bytes authenticated by its bundle."
        )
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        "--archive",
        type=Path,
        help="Also authenticate the original closed bundle archive.",
    )
    parser.add_argument(
        "--require-complete",
        action="store_true",
        help=(
            "Require generated dataset files to exist. Without this flag, "
            "clean source checkouts may omit them, but any present generated "
            "file is still verified."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = verify_active_bundle_compatibility(
            repo_root=ROOT,
            manifest_path=args.manifest,
            archive_path=args.archive,
            require_complete=args.require_complete,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (
        NeuralRemoteArtifactError,
        FileNotFoundError,
        OSError,
        TypeError,
        ValueError,
    ) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-active-bundle-compatibility",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


def verify_active_bundle_compatibility(
    *,
    repo_root: Path,
    manifest_path: Path,
    archive_path: Path | None,
    require_complete: bool,
) -> dict[str, Any]:
    root = repo_root.resolve(strict=True)
    active = load_active_manifest(manifest_path)
    verified_files: list[str] = []
    missing_generated: list[str] = []
    verified_bytes = 0

    for entry in active["files"]:
        relative = entry["path"]
        requested = root.joinpath(*Path(relative).parts)
        if not requested.exists():
            if (
                not require_complete
                and relative.startswith(GENERATED_PREFIX)
            ):
                missing_generated.append(relative)
                continue
            raise NeuralRemoteArtifactError(
                f"Active bundle input is missing: {relative}"
            )
        path = contained_regular_file(root, relative)
        observed_bytes = path.stat().st_size
        if (
            observed_bytes != entry["bytes"]
            or sha256_file(path) != entry["sha256"]
        ):
            raise NeuralRemoteArtifactError(
                f"Active bundle input drifted: {relative}"
            )
        verified_files.append(relative)
        verified_bytes += observed_bytes

    archive_verified = False
    if archive_path is not None:
        archive_verified = verify_active_archive(active, archive_path)

    return {
        "schemaVersion": 1,
        "status": "passed-neural-active-bundle-compatibility",
        "modelId": active["modelId"],
        "bundleId": active["bundle"]["bundleId"],
        "completedEpoch": active["recovery"]["completedEpoch"],
        "recoveryId": active["recovery"]["recoveryId"],
        "verifiedFileCount": len(verified_files),
        "verifiedBytes": verified_bytes,
        "missingGeneratedFileCount": len(missing_generated),
        "missingGeneratedFiles": missing_generated,
        "completeSourceInventory": not missing_generated,
        "archiveVerified": archive_verified,
    }


def load_active_manifest(path: Path) -> dict[str, Any]:
    requested = path.absolute()
    metadata = requested.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise NeuralRemoteArtifactError(
            "Active remote-run manifest must be a regular non-symlink file."
        )
    active = read_json_object(requested)
    if set(active) != {
        "schemaVersion",
        "status",
        "modelId",
        "trainingConfig",
        "bundle",
        "recovery",
        "files",
    }:
        raise NeuralRemoteArtifactError(
            "Active remote-run manifest has an unsupported schema."
        )
    if (
        active["schemaVersion"] != 1
        or active["status"] != "recoverable-incomplete-remote-training"
        or not isinstance(active["modelId"], str)
        or not active["modelId"]
    ):
        raise NeuralRemoteArtifactError(
            "Active remote-run identity is invalid."
        )
    active["trainingConfig"] = safe_relative_path(
        active["trainingConfig"],
        "active training config",
    )
    validate_bundle(active["bundle"], active)
    validate_recovery(active["recovery"], active)
    validate_files(active["files"], active)
    return active


def validate_bundle(bundle: Any, active: dict[str, Any]) -> None:
    required = {
        "bundleId",
        "archiveName",
        "archiveSha256",
        "archiveBytes",
        "manifestSha256",
        "fileCount",
        "uncompressedInputBytes",
        "datasetContentSha256",
        "goldCorpusSha256",
        "officialBenchmarkCorpusSha256",
    }
    if not isinstance(bundle, dict) or set(bundle) != required:
        raise NeuralRemoteArtifactError(
            "Active bundle identity has an unsupported schema."
        )
    digest_fields = (
        "bundleId",
        "archiveSha256",
        "manifestSha256",
        "datasetContentSha256",
        "goldCorpusSha256",
        "officialBenchmarkCorpusSha256",
    )
    if not all(is_sha256(bundle.get(field)) for field in digest_fields):
        raise NeuralRemoteArtifactError("Active bundle digest is invalid.")
    archive_name = bundle.get("archiveName")
    if (
        not isinstance(archive_name, str)
        or Path(archive_name).name != archive_name
        or not archive_name.endswith(".tar.gz")
        or not 1 <= len(archive_name.encode("utf-8")) <= 180
        or type(bundle.get("archiveBytes")) is not int
        or bundle["archiveBytes"] < 1
        or type(bundle.get("fileCount")) is not int
        or bundle["fileCount"] < 1
        or type(bundle.get("uncompressedInputBytes")) is not int
        or bundle["uncompressedInputBytes"] < 1
    ):
        raise NeuralRemoteArtifactError("Active bundle metadata is invalid.")
    if not isinstance(active.get("files"), list):
        raise NeuralRemoteArtifactError("Active bundle files are invalid.")


def validate_recovery(recovery: Any, active: dict[str, Any]) -> None:
    required = {
        "provider",
        "status",
        "completedEpoch",
        "generation",
        "recoveryId",
        "trainingRunId",
        "createdByExportRunId",
        "stateFile",
        "stateSha256",
        "stateBytes",
        "downloadArchiveSha256",
        "downloadArchiveBytes",
    }
    if not isinstance(recovery, dict) or set(recovery) != required:
        raise NeuralRemoteArtifactError(
            "Active recovery identity has an unsupported schema."
        )
    completed_epoch = recovery.get("completedEpoch")
    generation = recovery.get("generation")
    generation_match = (
        RECOVERY_GENERATION.fullmatch(generation)
        if isinstance(generation, str)
        else None
    )
    if (
        recovery.get("provider") != "google-colab"
        or recovery.get("status") != "complete-epoch-recovery-generation"
        or type(completed_epoch) is not int
        or completed_epoch < 1
        or generation_match is None
        or int(generation_match.group(1)) != completed_epoch
        or not is_sha256(recovery.get("recoveryId"))
        or generation_match.group(2)
            != recovery["recoveryId"][:16]
        or RUN_IDENTIFIER.fullmatch(
            str(recovery.get("trainingRunId", ""))
        ) is None
        or RUN_IDENTIFIER.fullmatch(
            str(recovery.get("createdByExportRunId", ""))
        ) is None
        or RECOVERY_STATE.fullmatch(
            str(recovery.get("stateFile", ""))
        ) is None
        or not is_sha256(recovery.get("stateSha256"))
        or type(recovery.get("stateBytes")) is not int
        or recovery["stateBytes"] < 1
        or not is_sha256(recovery.get("downloadArchiveSha256"))
        or type(recovery.get("downloadArchiveBytes")) is not int
        or recovery["downloadArchiveBytes"] < 1
    ):
        raise NeuralRemoteArtifactError("Active recovery identity is invalid.")


def validate_files(files: Any, active: dict[str, Any]) -> None:
    if not isinstance(files, list) or not files:
        raise NeuralRemoteArtifactError("Active bundle file inventory is empty.")
    if files != sorted(files, key=lambda entry: entry.get("path", "")):
        raise NeuralRemoteArtifactError(
            "Active bundle file inventory is not sorted."
        )
    paths: set[str] = set()
    training_config_found = False
    total_bytes = 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {
            "bytes",
            "path",
            "role",
            "sha256",
        }:
            raise NeuralRemoteArtifactError(
                "Active bundle file entry has an unsupported schema."
            )
        relative = safe_relative_path(
            entry["path"],
            "active bundle file path",
        )
        if relative in paths:
            raise NeuralRemoteArtifactError(
                f"Active bundle repeats a file: {relative}"
            )
        paths.add(relative)
        if (
            not isinstance(entry["role"], str)
            or not entry["role"]
            or not is_sha256(entry["sha256"])
            or type(entry["bytes"]) is not int
            or entry["bytes"] < 1
        ):
            raise NeuralRemoteArtifactError(
                f"Active bundle file evidence is invalid: {relative}"
            )
        total_bytes += entry["bytes"]
        if (
            relative == active["trainingConfig"]
            and entry["role"] == "training-config"
        ):
            training_config_found = True
    bundle = active["bundle"]
    if (
        not training_config_found
        or bundle["fileCount"] != len(files)
        or bundle["uncompressedInputBytes"] != total_bytes
    ):
        raise NeuralRemoteArtifactError(
            "Active bundle file inventory totals are invalid."
        )


def verify_active_archive(
    active: dict[str, Any],
    archive_path: Path,
) -> bool:
    bundle = active["bundle"]
    requested = archive_path.absolute()
    if requested.name != bundle["archiveName"]:
        raise NeuralRemoteArtifactError(
            "Active bundle archive filename is wrong."
        )
    verification = verify_closed_archive(
        requested,
        expected_kind=BUNDLE_KIND,
        expected_archive_sha256=bundle["archiveSha256"],
    )
    manifest = verification["manifest"]
    if (
        verification["archiveBytes"] != bundle["archiveBytes"]
        or verification["manifestSha256"] != bundle["manifestSha256"]
        or verification["bundleId"] != bundle["bundleId"]
        or manifest.get("modelId") != active["modelId"]
        or manifest.get("trainingConfig") != active["trainingConfig"]
        or manifest.get("datasetContentSha256")
            != bundle["datasetContentSha256"]
        or manifest.get("goldCorpusSha256")
            != bundle["goldCorpusSha256"]
        or manifest.get("officialBenchmarkCorpusSha256")
            != bundle["officialBenchmarkCorpusSha256"]
        or manifest.get("files") != active["files"]
    ):
        raise NeuralRemoteArtifactError(
            "Active archive differs from the committed run identity."
        )
    return True


if __name__ == "__main__":
    raise SystemExit(main())
