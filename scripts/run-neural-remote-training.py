#!/usr/bin/env python3
"""Run a verified Lekh training bundle on CUDA with durable epoch recovery."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any


# The extracted bundle is a closed, authenticated tree. Importing a bundled
# module must never mutate that tree by creating __pycache__ files before the
# inventory verifier runs.
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    ArchiveFile,
    BUNDLE_KIND,
    RESULT_KIND,
    NeuralRemoteArtifactError,
    build_closed_archive,
    canonical_json_bytes,
    contained_regular_file,
    is_sha256,
    open_regular_binary,
    read_json_object,
    safe_filename_component,
    safe_relative_path,
    sha256_bytes,
    sha256_file,
    verify_extracted_tree,
)


DEFAULT_CONFIG = (
    "data/neural/training/open-vocab-bigru-attention-v1.config.json"
)
RECOVERY_MANIFEST = "RECOVERY_MANIFEST.json"
RECOVERY_POINTER = "LATEST.json"
MAX_RECOVERY_BYTES = 512 * 1024 * 1024
REMOTE_PYTHON_VERSION = "3.11.15"
REMOTE_TORCH_VERSION = "2.7.0+cu118"
REMOTE_CUDA_VERSION = "11.8"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify immutable bundle inputs, train with deterministic CUDA, "
            "mirror each epoch to persistent storage, and publish a small "
            "closed result archive for macOS Core ML export."
        )
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--persistent-dir", type=Path, required=True)
    parser.add_argument(
        "--restart-training",
        action="store_true",
        help="Ignore durable/local recovery and begin a new training run.",
    )
    parser.add_argument(
        "--result-compression-level",
        type=int,
        default=1,
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config_relative = safe_relative_path(
            args.config,
            "training config path",
        )
        bundle_manifest = read_json_object(
            contained_regular_file(
                ROOT,
                "NEURAL_REMOTE_BUNDLE_MANIFEST.json",
            )
        )
        bundle_id = bundle_manifest.get("bundleId")
        if (
            bundle_manifest.get("artifactKind") != BUNDLE_KIND
            or not is_sha256(bundle_id)
            or bundle_manifest.get("trainingConfig") != config_relative
        ):
            raise NeuralRemoteArtifactError(
                "Extracted bundle identity/config binding is invalid."
            )
        config = read_json_object(
            contained_regular_file(ROOT, config_relative)
        )
        model_id = config.get("modelId")
        if (
            not isinstance(model_id, str)
            or model_id != bundle_manifest.get("modelId")
        ):
            raise NeuralRemoteArtifactError(
                "Bundle modelId differs from its training config."
            )
        safe_filename_component(model_id, "bundle modelId")
        candidate_relative = candidate_root_relative(config)
        verify_extracted_tree(
            ROOT,
            expected_kind=BUNDLE_KIND,
            allowed_output_prefixes=(candidate_relative,),
        )
        persistent_dir = prepare_persistent_directory(
            args.persistent_dir,
            bundle_id,
            model_id,
        )
        toolchain = verify_toolchain()
        trainer = import_trainer()
        training_argv = [
            "--config",
            str(ROOT / config_relative),
            "--training-device",
            "cuda",
            "--skip-coreml",
        ]
        if args.restart_training:
            training_argv.append("--restart-training")
        trainer_args = trainer.parse_args(training_argv, {})
        if trainer_args.model_id != model_id:
            raise NeuralRemoteArtifactError(
                "Trainer resolved a model different from the bundle."
            )
        recovery_root = (
            persistent_dir
            / "recovery"
            / bundle_id
            / model_id
        )

        with trainer.exclusive_run_lock(trainer_args):
            cleanup_orphaned_input_snapshots(trainer_args.out_dir)
            existing_complete = complete_training_artifacts_exist(
                trainer,
                trainer_args,
            )
            if existing_complete and not trainer.training_recovery_state_files(
                trainer_args
            ) and not trainer.training_recovery_metadata_path(
                trainer_args
            ).exists():
                loaded = trainer.load_checkpoint(trainer_args)
                training_report = loaded["report"]
            else:
                if not args.restart_training:
                    restore_latest_recovery(
                        trainer,
                        trainer_args,
                        recovery_root,
                        bundle_id=bundle_id,
                        model_id=model_id,
                        config_relative=config_relative,
                    )
                trainer_args.training_epoch_hook = (
                    lambda epoch_result, state_path: mirror_recovery(
                        trainer,
                        trainer_args,
                        recovery_root,
                        state_path,
                        epoch_result,
                        bundle_id=bundle_id,
                        model_id=model_id,
                        config_relative=config_relative,
                    )
                )
                try:
                    export_report = trainer.run_pipeline(trainer_args)
                finally:
                    trainer.cleanup_run_input_snapshot(trainer_args)
                if export_report.get("status") != (
                    "passed-training-candidate-coreml-export-skipped"
                ):
                    raise NeuralRemoteArtifactError(
                        "CUDA run did not publish a complete training-only candidate."
                    )
                training_report = read_json_object(
                    trainer.training_report_path(trainer_args)
                )

        validate_completed_training_report(
            training_report,
            bundle_id=bundle_id,
            model_id=model_id,
        )
        result = publish_result_archive(
            trainer,
            trainer_args,
            persistent_dir,
            bundle_manifest=bundle_manifest,
            toolchain=toolchain,
            compression_level=args.result_compression_level,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (
        NeuralRemoteArtifactError,
        OSError,
        subprocess.SubprocessError,
        SystemExit,
    ) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-remote-training",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


def candidate_root_relative(config: dict[str, Any]) -> str:
    try:
        checkpoint = config["export"]["sourceCheckpoint"]
    except (KeyError, TypeError) as error:
        raise NeuralRemoteArtifactError(
            "Training config lacks export.sourceCheckpoint."
        ) from error
    checkpoint_relative = safe_relative_path(
        checkpoint,
        "source checkpoint path",
    )
    return str(Path(checkpoint_relative).parent.as_posix())


def prepare_persistent_directory(
    requested: Path,
    bundle_id: str,
    model_id: str,
) -> Path:
    if not is_sha256(bundle_id):
        raise NeuralRemoteArtifactError(
            "Persistent recovery bundle identity is invalid."
        )
    safe_filename_component(model_id, "persistent modelId")
    requested.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = requested.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise NeuralRemoteArtifactError(
            f"Persistent recovery path is unsafe: {requested}"
        )
    resolved = requested.resolve(strict=True)
    if resolved.is_relative_to(ROOT.resolve(strict=True)):
        raise NeuralRemoteArtifactError(
            "Persistent recovery must be outside the disposable bundle tree."
        )
    scope = resolved / "lekh-neural-remote" / bundle_id / model_id
    scope.mkdir(parents=True, exist_ok=True, mode=0o700)
    if scope.is_symlink() or not scope.is_dir():
        raise NeuralRemoteArtifactError(
            f"Persistent recovery scope is unsafe: {scope}"
        )
    return scope


def verify_toolchain() -> dict[str, Any]:
    checker = contained_regular_file(
        ROOT,
        "scripts/check-neural-open-vocab-toolchain.py",
    )
    completed = subprocess.run(
        [
            sys.executable,
            str(checker),
            "--profile",
            "linux-cuda-cu118",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if completed.returncode != 0:
        raise NeuralRemoteArtifactError(
            "Pinned neural toolchain verification failed: "
            + (completed.stderr.strip() or completed.stdout.strip())
        )
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise NeuralRemoteArtifactError(
            "Toolchain verifier returned invalid JSON."
        ) from error
    if (
        not isinstance(report, dict)
        or report.get("status")
            != "passed-neural-open-vocab-toolchain"
        or report.get("profile") != "linux-cuda-cu118"
    ):
        raise NeuralRemoteArtifactError(
            "Pinned neural toolchain did not pass."
        )
    return report


def import_trainer() -> Any:
    trainer_path = contained_regular_file(
        ROOT,
        "scripts/train-open-vocab-seq2seq-transliterator.py",
    )
    specification = importlib.util.spec_from_file_location(
        "lekh_remote_cuda_trainer",
        trainer_path,
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


def cleanup_orphaned_input_snapshots(candidate_root: Path) -> None:
    if not candidate_root.exists():
        return
    for child in candidate_root.iterdir():
        if not child.name.startswith(".run-input-snapshot."):
            continue
        metadata = child.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise NeuralRemoteArtifactError(
                f"Unsafe orphaned run-input snapshot: {child}"
            )
        shutil.rmtree(child)


def complete_training_artifacts_exist(trainer: Any, args: Any) -> bool:
    paths = (
        trainer.checkpoint_path(args),
        trainer.training_report_path(args),
        args.vocab_metadata,
    )
    if any(path.is_symlink() for path in paths):
        raise NeuralRemoteArtifactError(
            "Candidate contains a symbolic-link final training artifact."
        )
    present = [path.exists() for path in paths]
    if any(present) and not all(present):
        raise NeuralRemoteArtifactError(
            "Candidate contains a partial final training publication."
        )
    return all(present)


def mirror_recovery(
    trainer: Any,
    args: Any,
    recovery_root: Path,
    state_path: Path,
    epoch_result: dict[str, Any],
    *,
    bundle_id: str,
    model_id: str,
    config_relative: str,
) -> None:
    metadata_path = trainer.training_recovery_metadata_path(args)
    metadata = read_json_object(metadata_path)
    state_name = state_path.name
    completed_epoch = epoch_result.get("epoch")
    if (
        not isinstance(completed_epoch, int)
        or completed_epoch < 1
        or metadata.get("completedEpoch") != completed_epoch
        or metadata.get("stateFile") != state_name
        or metadata.get("stateSha256") != sha256_file(state_path)
        or metadata.get("stateBytes") != state_path.stat().st_size
        or not 1 <= state_path.stat().st_size <= MAX_RECOVERY_BYTES
    ):
        raise NeuralRemoteArtifactError(
            "Trainer recovery state is incomplete or stale before mirroring."
        )
    recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if recovery_root.is_symlink() or not recovery_root.is_dir():
        raise NeuralRemoteArtifactError(
            f"Persistent recovery root is unsafe: {recovery_root}"
        )

    entries = []
    for source, name, role in (
        (metadata_path, metadata_path.name, "recovery-pointer"),
        (state_path, state_name, "recovery-state"),
    ):
        entries.append(
            {
                "name": name,
                "role": role,
                "sha256": sha256_file(source),
                "bytes": source.stat().st_size,
            }
        )
    unsigned = {
        "schemaVersion": 1,
        "status": "complete-epoch-recovery-generation",
        "bundleId": bundle_id,
        "modelId": model_id,
        "trainingConfig": config_relative,
        "trainingRunId": metadata.get("trainingRunId"),
        "createdByExportRunId": metadata.get("createdByExportRunId"),
        "completedEpoch": completed_epoch,
        "files": entries,
    }
    recovery_id = sha256_bytes(canonical_json_bytes(unsigned))
    manifest = {**unsigned, "recoveryId": recovery_id}
    generation_name = f"epoch-{completed_epoch:06d}-{recovery_id[:16]}"
    target = recovery_root / generation_name
    if target.exists() or target.is_symlink():
        validated = validate_recovery_generation(
            target,
            bundle_id=bundle_id,
            model_id=model_id,
            config_relative=config_relative,
        )
        if validated.get("recoveryId") != recovery_id:
            raise NeuralRemoteArtifactError(
                "Persistent recovery generation identity collision."
            )
    else:
        staging = Path(
            tempfile.mkdtemp(
                prefix=f".{generation_name}.staging.",
                dir=recovery_root,
            )
        )
        os.chmod(staging, 0o700)
        try:
            for source, name, _role in (
                (metadata_path, metadata_path.name, "recovery-pointer"),
                (state_path, state_name, "recovery-state"),
            ):
                copy_regular_file(source, staging / name)
            write_json_new(staging / RECOVERY_MANIFEST, manifest)
            os.replace(staging, target)
            staging = None
        finally:
            if staging is not None and staging.exists():
                shutil.rmtree(staging)

    pointer = {
        "schemaVersion": 1,
        "bundleId": bundle_id,
        "modelId": model_id,
        "generation": generation_name,
        "recoveryId": recovery_id,
        "completedEpoch": completed_epoch,
    }
    write_json_atomic(recovery_root / RECOVERY_POINTER, pointer)
    prune_old_recovery_generations(
        recovery_root,
        keep={generation_name},
        maximum_retained=2,
    )


def restore_latest_recovery(
    trainer: Any,
    args: Any,
    recovery_root: Path,
    *,
    bundle_id: str,
    model_id: str,
    config_relative: str,
) -> dict[str, Any] | None:
    if not recovery_root.exists():
        return None
    if recovery_root.is_symlink() or not recovery_root.is_dir():
        raise NeuralRemoteArtifactError(
            f"Persistent recovery root is unsafe: {recovery_root}"
        )
    candidates: list[tuple[int, Path, dict[str, Any]]] = []
    for child in recovery_root.iterdir():
        if not child.name.startswith("epoch-"):
            continue
        if child.is_symlink() or not child.is_dir():
            raise NeuralRemoteArtifactError(
                f"Persistent recovery generation is unsafe: {child}"
            )
        manifest = validate_recovery_generation(
            child,
            bundle_id=bundle_id,
            model_id=model_id,
            config_relative=config_relative,
        )
        candidates.append((manifest["completedEpoch"], child, manifest))
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1].name))
    _epoch, generation, manifest = candidates[-1]
    pointer_path = recovery_root / RECOVERY_POINTER
    if pointer_path.exists():
        try:
            pointer = read_json_object(pointer_path)
        except NeuralRemoteArtifactError:
            pointer = {}
        if (
            pointer.get("schemaVersion") != 1
            or pointer.get("bundleId") != bundle_id
            or pointer.get("modelId") != model_id
            or pointer.get("generation") != generation.name
            or pointer.get("recoveryId") != manifest["recoveryId"]
            or pointer.get("completedEpoch")
                != manifest["completedEpoch"]
        ):
            write_json_atomic(
                pointer_path,
                {
                    "schemaVersion": 1,
                    "bundleId": bundle_id,
                    "modelId": model_id,
                    "generation": generation.name,
                    "recoveryId": manifest["recoveryId"],
                    "completedEpoch": manifest["completedEpoch"],
                },
            )
    else:
        write_json_atomic(
            pointer_path,
            {
                "schemaVersion": 1,
                "bundleId": bundle_id,
                "modelId": model_id,
                "generation": generation.name,
                "recoveryId": manifest["recoveryId"],
                "completedEpoch": manifest["completedEpoch"],
            },
        )

    state_entry = next(
        entry
        for entry in manifest["files"]
        if entry["role"] == "recovery-state"
    )
    metadata_entry = next(
        entry
        for entry in manifest["files"]
        if entry["role"] == "recovery-pointer"
    )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    target_state = args.out_dir / state_entry["name"]
    target_metadata = trainer.training_recovery_metadata_path(args)
    existing_states = trainer.training_recovery_state_files(args)
    if existing_states and existing_states != [target_state]:
        raise NeuralRemoteArtifactError(
            "Local and persistent recovery generations conflict."
        )
    copy_if_missing_or_identical(
        generation / state_entry["name"],
        target_state,
        state_entry,
    )
    copy_if_missing_or_identical(
        generation / metadata_entry["name"],
        target_metadata,
        metadata_entry,
    )
    return manifest


def validate_recovery_generation(
    generation: Path,
    *,
    bundle_id: str,
    model_id: str,
    config_relative: str,
) -> dict[str, Any]:
    generation_metadata = generation.lstat()
    if (
        stat.S_ISLNK(generation_metadata.st_mode)
        or not stat.S_ISDIR(generation_metadata.st_mode)
    ):
        raise NeuralRemoteArtifactError(
            f"Persistent recovery generation is unsafe: {generation}"
        )
    manifest_path = generation / RECOVERY_MANIFEST
    manifest = read_json_object(manifest_path)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("status")
            != "complete-epoch-recovery-generation"
        or manifest.get("bundleId") != bundle_id
        or manifest.get("modelId") != model_id
        or manifest.get("trainingConfig") != config_relative
        or not isinstance(manifest.get("completedEpoch"), int)
        or manifest["completedEpoch"] < 1
        or not is_sha256(manifest.get("recoveryId"))
    ):
        raise NeuralRemoteArtifactError(
            f"Persistent recovery manifest is invalid: {generation}"
        )
    unsigned = dict(manifest)
    unsigned.pop("recoveryId", None)
    if sha256_bytes(canonical_json_bytes(unsigned)) != manifest["recoveryId"]:
        raise NeuralRemoteArtifactError(
            f"Persistent recovery identity is stale: {generation}"
        )
    files = manifest.get("files")
    if (
        not isinstance(files, list)
        or len(files) != 2
        or {entry.get("role") for entry in files if isinstance(entry, dict)}
            != {"recovery-pointer", "recovery-state"}
    ):
        raise NeuralRemoteArtifactError(
            f"Persistent recovery inventory is invalid: {generation}"
        )
    expected_names = {RECOVERY_MANIFEST}
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {
            "name",
            "role",
            "sha256",
            "bytes",
        }:
            raise NeuralRemoteArtifactError(
                f"Persistent recovery entry is invalid: {generation}"
            )
        name = safe_relative_path(entry["name"], "recovery filename")
        if "/" in name:
            raise NeuralRemoteArtifactError(
                "Persistent recovery files must be direct children."
            )
        source = generation / name
        source_metadata = source.lstat()
        if (
            stat.S_ISLNK(source_metadata.st_mode)
            or not stat.S_ISREG(source_metadata.st_mode)
            or not is_sha256(entry["sha256"])
            or not isinstance(entry["bytes"], int)
            or not 1 <= entry["bytes"] <= MAX_RECOVERY_BYTES
            or source_metadata.st_size != entry["bytes"]
            or sha256_file(source) != entry["sha256"]
        ):
            raise NeuralRemoteArtifactError(
                f"Persistent recovery bytes are stale: {source}"
            )
        expected_names.add(name)
    actual_names = set()
    for child in generation.iterdir():
        metadata = child.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise NeuralRemoteArtifactError(
                f"Persistent recovery contains an unsafe entry: {child}"
            )
        actual_names.add(child.name)
    if actual_names != expected_names:
        raise NeuralRemoteArtifactError(
            f"Persistent recovery has unlisted files: {generation}"
        )
    return manifest


def prune_old_recovery_generations(
    recovery_root: Path,
    *,
    keep: set[str],
    maximum_retained: int,
) -> None:
    generations = sorted(
        (
            child
            for child in recovery_root.iterdir()
            if child.name.startswith("epoch-")
            and child.is_dir()
            and not child.is_symlink()
        ),
        key=lambda child: child.name,
        reverse=True,
    )
    retained_names = set(keep)
    for generation in generations:
        if generation.name in retained_names:
            continue
        if len(retained_names) < maximum_retained:
            retained_names.add(generation.name)
            continue
        shutil.rmtree(generation)


def copy_if_missing_or_identical(
    source: Path,
    target: Path,
    evidence: dict[str, Any],
) -> None:
    if target.exists() or target.is_symlink():
        if (
            target.is_symlink()
            or not target.is_file()
            or target.stat().st_size != evidence["bytes"]
            or sha256_file(target) != evidence["sha256"]
        ):
            raise NeuralRemoteArtifactError(
                f"Recovery target exists with different bytes: {target}"
            )
        return
    copy_regular_file(source, target)


def copy_regular_file(source: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise NeuralRemoteArtifactError(
            f"Refusing to overwrite recovery target: {target}"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.with_name(
        f".{target.name}.staging.{os.getpid()}.{uuid.uuid4().hex}"
    )
    try:
        with (
            open_regular_binary(source) as input_handle,
            staging.open("xb") as output,
        ):
            shutil.copyfileobj(input_handle, output, length=1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(staging, 0o600)
        os.replace(staging, target)
    finally:
        staging.unlink(missing_ok=True)


def write_json_new(path: Path, value: dict[str, Any]) -> None:
    payload = canonical_json_bytes(value) + b"\n"
    with path.open("xb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(path, 0o600)


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    payload = canonical_json_bytes(value) + b"\n"
    staging = path.with_name(
        f".{path.name}.staging.{os.getpid()}.{uuid.uuid4().hex}"
    )
    try:
        with staging.open("xb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(staging, 0o600)
        os.replace(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def validate_completed_training_report(
    report: dict[str, Any],
    *,
    bundle_id: str,
    model_id: str,
) -> None:
    snapshot = report.get("runInputSnapshot")
    runtime = (
        snapshot.get("runtime", {})
        if isinstance(snapshot, dict)
        else {}
    )
    cuda_value = runtime.get("cuda") if isinstance(runtime, dict) else None
    cuda = cuda_value if isinstance(cuda_value, dict) else {}
    if (
        report.get("status") != "passed-training-checkpoint"
        or report.get("trainingComplete") is not True
        or report.get("modelId") != model_id
        or report.get("trainingExecutionModes") != {
            "skipTrain": False,
            "skipCoreML": True,
            "trainingDevice": "cuda",
        }
        or runtime.get("trainingDevice") != "cuda"
        or runtime.get("deterministicAlgorithms") is not True
        or runtime.get("python") != REMOTE_PYTHON_VERSION
        or runtime.get("torch") != REMOTE_TORCH_VERSION
        or runtime.get("numpy") != "1.26.4"
        or runtime.get("coremltools") != "9.0"
        or runtime.get("machine") != "x86_64"
        or cuda.get("available") is not True
        or cuda.get("runtimeVersion") != REMOTE_CUDA_VERSION
        or cuda.get("cublasWorkspaceConfig") != ":4096:8"
        or cuda.get("cudnnBenchmark") is not False
        or cuda.get("cudnnDeterministic") is not True
        or not is_sha256(bundle_id)
    ):
        raise NeuralRemoteArtifactError(
            "Completed CUDA training report lacks required deterministic evidence."
        )


def publish_result_archive(
    trainer: Any,
    args: Any,
    persistent_dir: Path,
    *,
    bundle_manifest: dict[str, Any],
    toolchain: dict[str, Any],
    compression_level: int,
) -> dict[str, Any]:
    checkpoint = trainer.checkpoint_path(args)
    training_report_path = trainer.training_report_path(args)
    report = read_json_object(training_report_path)
    training_run_id = report.get("trainingRunId")
    if (
        not isinstance(training_run_id, str)
        or len(training_run_id) != 32
    ):
        raise NeuralRemoteArtifactError(
            "Completed training report has an invalid run identity."
        )
    candidates = [
        ArchiveFile(
            source=checkpoint,
            archive_path=checkpoint.relative_to(ROOT).as_posix(),
            role="checkpoint",
            expected_sha256=report.get("checkpointSha256"),
        ),
        ArchiveFile(
            source=training_report_path,
            archive_path=training_report_path.relative_to(ROOT).as_posix(),
            role="training-report",
        ),
        ArchiveFile(
            source=args.vocab_metadata,
            archive_path=args.vocab_metadata.relative_to(ROOT).as_posix(),
            role="vocabulary",
            expected_sha256=report.get("vocabMetadataSha256"),
        ),
    ]
    export_report = trainer.export_report_path(args)
    if export_report.is_file() and not export_report.is_symlink():
        candidates.append(
            ArchiveFile(
                source=export_report,
                archive_path=export_report.relative_to(ROOT).as_posix(),
                role="training-only-export-report",
            )
        )
    manifest_base = {
        "schemaVersion": 1,
        "bundleId": bundle_manifest["bundleId"],
        "modelId": args.model_id,
        "trainingConfig": bundle_manifest["trainingConfig"],
        "trainingRunId": training_run_id,
        "checkpointSha256": report["checkpointSha256"],
        "trainingRuntime": report["runInputSnapshot"]["runtime"],
        "toolchain": toolchain,
    }
    results_dir = persistent_dir / "results"
    results_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    archive_report = build_closed_archive(
        source_root=ROOT,
        output_dir=results_dir,
        artifact_kind=RESULT_KIND,
        filename_stem=(
            f"lekh-neural-{args.model_id}-{training_run_id}-cuda-result"
        ),
        manifest_base=manifest_base,
        files=candidates,
        compression_level=compression_level,
    )
    pointer = {
        "schemaVersion": 1,
        "status": "complete-neural-remote-result",
        "bundleId": bundle_manifest["bundleId"],
        "modelId": args.model_id,
        "trainingRunId": training_run_id,
        "resultId": archive_report["resultId"],
        "archive": Path(archive_report["archive"]).name,
        "archiveSha256": archive_report["archiveSha256"],
        "archiveBytes": archive_report["archiveBytes"],
    }
    write_json_atomic(results_dir / "LATEST_RESULT.json", pointer)
    return {
        **pointer,
        "status": "passed-neural-remote-training",
        "archive": archive_report["archive"],
        "manifestSha256": archive_report["manifestSha256"],
    }


if __name__ == "__main__":
    raise SystemExit(main())
