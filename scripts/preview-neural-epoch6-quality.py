#!/usr/bin/env python3
"""Read-only, bounded quality preview for the authenticated epoch-six recovery.

This diagnostic is deliberately not a release or promotion evaluator. It
authenticates the pinned recovery ZIP, reconstructs the exact training
vocabularies from the recovery-bound repository inputs, and can score at most
64 deterministically stratified official-benchmark rows with one CPU thread.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import stat
import sys
import tempfile
import time
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterable


ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "lekh-open-vocab-ctc-transformer-v2"
CONFIG_PATH = (
    "data/neural/training/open-vocab-ctc-transformer-v2.config.json"
)
TRAINER_PATH = "scripts/train-open-vocab-ctc-transformer.py"
LEGACY_TRAINER_PATH = "scripts/train-open-vocab-seq2seq-transliterator.py"
SHARED_MODEL_PATH = "scripts/lib/neural_ctc_transformer.py"
TERMINAL_DECODER_PATH = "scripts/lib/neural_ctc_terminal_decoder.py"
PRELIMINARY_LABEL = "PRELIMINARY — NOT PROMOTION EVIDENCE"
SAMPLE_POLICY = "epoch6-official-benchmark-equal-strata-sha256-v1"
BUCKETS = ("native-frequent", "indian-name", "foreign-name")
INPUT_SPECIAL = ("<pad>", "</s>", "<unk>")
CTC_BLANK = "<ctc-blank>"
MAX_SAMPLE_ROWS = 64
MAX_PREVIEW_SECONDS = 45.0
MAX_RECOVERY_BYTES = 512 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


class PreviewError(RuntimeError):
    """Fail-closed input, identity, or bounded-execution error."""


@dataclass(frozen=True)
class RecoveryPolicy:
    archive_sha256: str
    archive_bytes: int
    generation: str
    recovery_id: str
    bundle_id: str
    training_run_id: str
    export_run_id: str
    completed_epoch: int
    pointer_name: str
    pointer_sha256: str
    pointer_bytes: int
    state_name: str
    state_sha256: str
    state_bytes: int

    @property
    def pointer_member(self) -> str:
        return f"{self.generation}/{self.pointer_name}"

    @property
    def manifest_member(self) -> str:
        return f"{self.generation}/RECOVERY_MANIFEST.json"

    @property
    def state_member(self) -> str:
        return f"{self.generation}/{self.state_name}"


EPOCH6_POLICY = RecoveryPolicy(
    archive_sha256=(
        "13a37d8d31e2854b4b372fbd4a0bed390c2403a96740f092c22645d1131cc5ab"
    ),
    archive_bytes=70_390_038,
    generation="epoch-000006-ebcb07a2530ae38a",
    recovery_id=(
        "ebcb07a2530ae38ad5c3846e58b17318fec63e6bbe0ddccb4bdfcc0420330afc"
    ),
    bundle_id=(
        "abc8ecfb2bfbcf3201cc2ad741b8c7ca98714882d25e93a0c38b900b3f136296"
    ),
    training_run_id="f4bcc9d75eca4fe78a6cb928063a2d2b",
    export_run_id="b5ade35206664b0babb8b28f44ee4a0b",
    completed_epoch=6,
    pointer_name=".training-recovery.json",
    pointer_sha256=(
        "6b38fda27da51e81ab1b43ffcc89a70748ae4e1fb79518005f872760aea21d88"
    ),
    pointer_bytes=576,
    state_name=".training-recovery.b5ade35206664b0babb8b28f44ee4a0b.6.pt",
    state_sha256=(
        "020cd22d76f8b102b752e85504836c720bff73e758d8932ce992b5620525651d"
    ),
    state_bytes=76_648_555,
)


def canonical_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: canonical_json_value(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [canonical_json_value(child) for child in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        canonical_json_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json_bytes(value))


def require_sha256(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise PreviewError(f"{label} is not a lowercase SHA-256 digest.")
    return value


def safe_repo_path(relative: Any) -> Path:
    if not isinstance(relative, str) or not relative:
        raise PreviewError("Recovery snapshot contains an invalid path.")
    portable = PurePosixPath(relative)
    if (
        portable.is_absolute()
        or portable.as_posix() != relative
        or ".." in portable.parts
    ):
        raise PreviewError(f"Recovery snapshot path is unsafe: {relative}")
    path = ROOT.joinpath(*portable.parts)
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise PreviewError(
            f"Recovery-bound repository input is missing: {relative}"
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise PreviewError(
            f"Recovery-bound repository input is unsafe: {relative}"
        )
    if not path.resolve().is_relative_to(ROOT.resolve()):
        raise PreviewError(f"Recovery snapshot path escapes the repo: {relative}")
    return path


def inspect_regular_file(
    path: Path,
    *,
    expected_sha256: str,
    expected_bytes: int | None = None,
    count_rows: bool = False,
) -> dict[str, Any]:
    require_sha256(expected_sha256, f"{path} expected digest")
    metadata_before = path.lstat()
    if (
        stat.S_ISLNK(metadata_before.st_mode)
        or not stat.S_ISREG(metadata_before.st_mode)
    ):
        raise PreviewError(f"Input is not a regular file: {path}")
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    partial = b""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
                digest.update(chunk)
                byte_count += len(chunk)
                if count_rows:
                    lines = (partial + chunk).split(b"\n")
                    partial = lines.pop()
                    row_count += sum(bool(line.strip()) for line in lines)
            if count_rows and partial.strip():
                row_count += 1
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    metadata_after = path.lstat()
    if (
        metadata_before.st_dev != metadata_after.st_dev
        or metadata_before.st_ino != metadata_after.st_ino
        or metadata_before.st_size != metadata_after.st_size
        or metadata_before.st_mtime_ns != metadata_after.st_mtime_ns
        or byte_count != metadata_before.st_size
    ):
        raise PreviewError(f"Input changed while it was inspected: {path}")
    if digest.hexdigest() != expected_sha256:
        raise PreviewError(f"Input SHA-256 differs from recovery: {path}")
    if expected_bytes is not None and byte_count != expected_bytes:
        raise PreviewError(f"Input byte count differs from recovery: {path}")
    return {
        "sha256": digest.hexdigest(),
        "bytes": byte_count,
        "rows": row_count if count_rows else None,
    }


def read_json_object(path: Path, *, maximum_bytes: int) -> dict[str, Any]:
    metadata = path.lstat()
    if metadata.st_size < 1 or metadata.st_size > maximum_bytes:
        raise PreviewError(f"JSON object is empty or oversized: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            payload = handle.read(maximum_bytes + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreviewError(f"Invalid UTF-8 JSON object: {path}") from error
    if not isinstance(value, dict):
        raise PreviewError(f"Expected a JSON object: {path}")
    return value


def verify_recovery_zip(
    archive_path: Path,
    policy: RecoveryPolicy,
    state_destination: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    expected_members = {
        policy.pointer_member,
        policy.manifest_member,
        policy.state_member,
    }
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    archive_descriptor = os.open(archive_path, flags)
    archive_sha256 = ""
    archive_bytes = 0
    state_digest = hashlib.sha256()
    state_bytes = 0
    try:
        with os.fdopen(archive_descriptor, "rb") as archive_handle:
            archive_descriptor = -1
            metadata_before = os.fstat(archive_handle.fileno())
            if (
                not stat.S_ISREG(metadata_before.st_mode)
                or metadata_before.st_size != policy.archive_bytes
            ):
                raise PreviewError(
                    "Recovery ZIP is missing, unsafe, or has wrong size."
                )
            archive_digest = hashlib.sha256()
            for chunk in iter(
                lambda: archive_handle.read(CHUNK_BYTES),
                b"",
            ):
                archive_digest.update(chunk)
                archive_bytes += len(chunk)
            archive_sha256 = archive_digest.hexdigest()
            if (
                archive_sha256 != policy.archive_sha256
                or archive_bytes != policy.archive_bytes
            ):
                raise PreviewError("Recovery ZIP SHA-256 or size is stale.")
            archive_handle.seek(0)
            with zipfile.ZipFile(archive_handle, "r") as archive:
                infos = archive.infolist()
                if (
                    len(infos) != 3
                    or {entry.filename for entry in infos} != expected_members
                    or any(
                        entry.is_dir() or entry.flag_bits & 0x1
                        for entry in infos
                    )
                ):
                    raise PreviewError(
                        "Recovery ZIP inventory is not the pinned set."
                    )
                by_name = {entry.filename: entry for entry in infos}
                pointer_info = by_name[policy.pointer_member]
                state_info = by_name[policy.state_member]
                if (
                    pointer_info.file_size != policy.pointer_bytes
                    or state_info.file_size != policy.state_bytes
                    or state_info.file_size > MAX_RECOVERY_BYTES
                ):
                    raise PreviewError("Recovery ZIP member sizes are stale.")
                pointer_bytes = archive.read(pointer_info)
                manifest_bytes = archive.read(policy.manifest_member)
                if sha256_bytes(pointer_bytes) != policy.pointer_sha256:
                    raise PreviewError("Recovery pointer digest is stale.")
                try:
                    pointer = json.loads(pointer_bytes.decode("utf-8"))
                    manifest = json.loads(manifest_bytes.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise PreviewError(
                        "Recovery metadata is invalid UTF-8 JSON."
                    ) from error
                validate_recovery_metadata(pointer, manifest, policy)
                descriptor = os.open(
                    state_destination,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL
                    | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                try:
                    with os.fdopen(descriptor, "wb") as output:
                        descriptor = -1
                        with archive.open(state_info, "r") as source:
                            for chunk in iter(
                                lambda: source.read(CHUNK_BYTES),
                                b"",
                            ):
                                state_digest.update(chunk)
                                state_bytes += len(chunk)
                                output.write(chunk)
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
            metadata_after = os.fstat(archive_handle.fileno())
            if (
                metadata_before.st_dev != metadata_after.st_dev
                or metadata_before.st_ino != metadata_after.st_ino
                or metadata_before.st_size != metadata_after.st_size
                or metadata_before.st_mtime_ns != metadata_after.st_mtime_ns
            ):
                raise PreviewError(
                    "Recovery ZIP changed while it was verified."
                )
    finally:
        if archive_descriptor >= 0:
            os.close(archive_descriptor)
    if (
        state_digest.hexdigest() != policy.state_sha256
        or state_bytes != policy.state_bytes
    ):
        raise PreviewError("Recovery state digest or byte count is stale.")
    return pointer, {
        "archiveSha256": archive_sha256,
        "archiveBytes": archive_bytes,
        "recoveryId": policy.recovery_id,
        "stateSha256": state_digest.hexdigest(),
        "stateBytes": state_bytes,
    }


def validate_recovery_metadata(
    pointer: Any,
    manifest: Any,
    policy: RecoveryPolicy,
) -> None:
    if not isinstance(pointer, dict) or not isinstance(manifest, dict):
        raise PreviewError("Recovery pointer and manifest must be objects.")
    pointer_keys = {
        "completedEpoch",
        "createdByExportRunId",
        "identitySha256",
        "modelId",
        "schemaVersion",
        "stateBytes",
        "stateFile",
        "stateSha256",
        "status",
        "trainingRunId",
        "updatedAt",
    }
    if (
        set(pointer) != pointer_keys
        or pointer.get("schemaVersion") != 3
        or pointer.get("status") != "recoverable-incomplete-training"
        or pointer.get("modelId") != MODEL_ID
        or pointer.get("trainingRunId") != policy.training_run_id
        or pointer.get("createdByExportRunId") != policy.export_run_id
        or pointer.get("completedEpoch") != policy.completed_epoch
        or pointer.get("stateFile") != policy.state_name
        or pointer.get("stateSha256") != policy.state_sha256
        or pointer.get("stateBytes") != policy.state_bytes
    ):
        raise PreviewError("Recovery pointer does not match the pinned identity.")
    manifest_keys = {
        "bundleId",
        "completedEpoch",
        "createdByExportRunId",
        "files",
        "modelId",
        "recoveryId",
        "schemaVersion",
        "status",
        "trainingConfig",
        "trainingRunId",
    }
    unsigned = dict(manifest)
    recovery_id = unsigned.pop("recoveryId", None)
    if (
        set(manifest) != manifest_keys
        or manifest.get("schemaVersion") != 1
        or manifest.get("status") != "complete-epoch-recovery-generation"
        or manifest.get("bundleId") != policy.bundle_id
        or manifest.get("modelId") != MODEL_ID
        or manifest.get("trainingConfig") != CONFIG_PATH
        or manifest.get("trainingRunId") != policy.training_run_id
        or manifest.get("createdByExportRunId") != policy.export_run_id
        or manifest.get("completedEpoch") != policy.completed_epoch
        or recovery_id != policy.recovery_id
        or sha256_bytes(canonical_json_bytes(unsigned)) != policy.recovery_id
    ):
        raise PreviewError("Recovery generation manifest identity is stale.")
    expected_files = [
        {
            "bytes": policy.pointer_bytes,
            "name": policy.pointer_name,
            "role": "recovery-pointer",
            "sha256": policy.pointer_sha256,
        },
        {
            "bytes": policy.state_bytes,
            "name": policy.state_name,
            "role": "recovery-state",
            "sha256": policy.state_sha256,
        },
    ]
    if manifest.get("files") != expected_files:
        raise PreviewError("Recovery generation file inventory is stale.")


def load_recovery_payload(state_path: Path, pointer: dict[str, Any]) -> Any:
    import torch

    try:
        with state_path.open("rb") as handle:
            recovery = torch.load(
                handle,
                map_location="cpu",
                weights_only=True,
            )
    except Exception as error:
        raise PreviewError(
            "Recovery state failed tensor-only loading."
        ) from error
    required = {
        "bestDevWeightedCTCLoss",
        "bestEpoch",
        "bestState",
        "completedEpoch",
        "createdByExportRunId",
        "cudaRngStates",
        "epochMetrics",
        "epochsWithoutImprovement",
        "exportRunIds",
        "globalStep",
        "identity",
        "identitySha256",
        "modelId",
        "modelState",
        "optimizerState",
        "resumeCount",
        "schemaVersion",
        "stoppedEarly",
        "torchRngState",
        "trainLosses",
        "trainingDurationSeconds",
        "trainingGeneratorState",
        "trainingRunId",
    }
    identity = recovery.get("identity") if isinstance(recovery, dict) else None
    best_state = recovery.get("bestState") if isinstance(recovery, dict) else None
    if (
        not isinstance(recovery, dict)
        or set(recovery) != required
        or recovery.get("schemaVersion") != 3
        or recovery.get("modelId") != MODEL_ID
        or recovery.get("trainingRunId") != EPOCH6_POLICY.training_run_id
        or recovery.get("createdByExportRunId") != EPOCH6_POLICY.export_run_id
        or recovery.get("completedEpoch") != EPOCH6_POLICY.completed_epoch
        or not isinstance(identity, dict)
        or recovery.get("identitySha256") != sha256_json(identity)
        or recovery.get("identitySha256") != pointer.get("identitySha256")
        or not isinstance(best_state, dict)
        or not best_state
        or recovery.get("bestEpoch") != EPOCH6_POLICY.completed_epoch
        or not isinstance(recovery.get("bestDevWeightedCTCLoss"), (int, float))
        or not math.isfinite(float(recovery["bestDevWeightedCTCLoss"]))
    ):
        raise PreviewError("Recovery payload identity or best state is invalid.")
    return recovery


def load_python_module(name: str, path: Path) -> Any:
    specification = importlib.util.spec_from_file_location(name, path)
    if specification is None or specification.loader is None:
        raise PreviewError(f"Cannot import authenticated module: {path}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


def verify_snapshot_static_inputs(snapshot: dict[str, Any]) -> dict[str, Any]:
    if snapshot.get("schemaVersion") != 1:
        raise PreviewError("Recovery run-input snapshot schema is unsupported.")
    evidence: dict[str, Any] = {}
    singleton_entries = [
        snapshot.get("trainer"),
        snapshot.get("trainingConfig"),
        *(snapshot.get("trainerDependencies") or []),
    ]
    for entry in singleton_entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256"}:
            raise PreviewError("Recovery source snapshot entry is invalid.")
        path = safe_repo_path(entry["path"])
        evidence[entry["path"]] = inspect_regular_file(
            path,
            expected_sha256=entry["sha256"],
        )
    if snapshot["trainer"]["path"] != TRAINER_PATH:
        raise PreviewError("Recovery trainer path is not the CTC trainer.")
    dependency_paths = {
        entry["path"] for entry in snapshot["trainerDependencies"]
    }
    if dependency_paths != {LEGACY_TRAINER_PATH, SHARED_MODEL_PATH}:
        raise PreviewError("Recovery trainer dependency inventory is stale.")
    return evidence


def verify_declared_jsonl(
    entry: dict[str, Any],
) -> dict[str, Any]:
    if set(entry) != {"path", "sha256", "bytes", "rows"}:
        raise PreviewError("Recovery JSONL snapshot entry is invalid.")
    path = safe_repo_path(entry["path"])
    observed = inspect_regular_file(
        path,
        expected_sha256=entry["sha256"],
        expected_bytes=entry["bytes"],
        count_rows=True,
    )
    if observed["rows"] != entry["rows"]:
        raise PreviewError(f"JSONL row count differs from recovery: {path}")
    return observed


def reconstruct_training_vocabs(
    train_path: Path,
    train_entry: dict[str, Any],
    config: dict[str, Any],
) -> tuple[dict[str, int], dict[str, int], dict[str, Any]]:
    metadata_before = train_path.lstat()
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    input_tokens: set[str] = set()
    output_tokens: set[str] = set()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(train_path, flags)
    try:
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            for line_number, line in enumerate(handle, start=1):
                digest.update(line)
                byte_count += len(line)
                if not line.strip():
                    continue
                row_count += 1
                try:
                    row = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise PreviewError(
                        f"Training row {line_number} is invalid JSON."
                    ) from error
                raw_input = row.get("input") if isinstance(row, dict) else None
                raw_target = row.get("target") if isinstance(row, dict) else None
                normalized_input = " ".join(
                    unicodedata.normalize("NFC", str(raw_input or ""))
                    .lower()
                    .strip()
                    .split()
                )
                normalized_target = unicodedata.normalize(
                    "NFC", str(raw_target or "").strip()
                )
                if (
                    not isinstance(raw_input, str)
                    or raw_input != normalized_input
                    or not raw_input
                    or any(not "a" <= character <= "z"
                           for character in raw_input)
                    or not isinstance(raw_target, str)
                    or raw_target != normalized_target
                    or not raw_target
                ):
                    raise PreviewError(
                        f"Training row {line_number} cannot define CTC vocab."
                    )
                input_tokens.update(raw_input)
                output_tokens.update(raw_target)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    metadata_after = train_path.lstat()
    if (
        metadata_before.st_dev != metadata_after.st_dev
        or metadata_before.st_ino != metadata_after.st_ino
        or metadata_before.st_size != metadata_after.st_size
        or metadata_before.st_mtime_ns != metadata_after.st_mtime_ns
        or digest.hexdigest() != train_entry.get("sha256")
        or byte_count != train_entry.get("bytes")
        or row_count != train_entry.get("rows")
    ):
        raise PreviewError("Training split differs from the recovery snapshot.")
    maximum_rows = config.get("trainingRun", {}).get("maximumTrainRows")
    if type(maximum_rows) is not int or row_count > maximum_rows:
        raise PreviewError(
            "Preview cannot prove the trainer used the complete train split."
        )
    aliases = config.get("training", {}).get("augmentation", {}).get("aliases")
    if not isinstance(aliases, list):
        raise PreviewError("CTC augmentation aliases are unavailable.")
    for alias in aliases:
        source = alias.get("from") if isinstance(alias, dict) else None
        replacement = alias.get("to") if isinstance(alias, dict) else None
        if (
            not isinstance(source, str)
            or not source
            or any(not "a" <= character <= "z" for character in source)
            or not isinstance(replacement, str)
            or not replacement
            or any(not "a" <= character <= "z" for character in replacement)
        ):
            raise PreviewError("CTC augmentation alias can change vocab unsafely.")
        input_tokens.update(replacement)
    input_vocab = {
        token: index
        for index, token in enumerate([*INPUT_SPECIAL, *sorted(input_tokens)])
    }
    output_vocab = {
        token: index
        for index, token in enumerate([CTC_BLANK, *sorted(output_tokens)])
    }
    return input_vocab, output_vocab, {
        "path": train_entry["path"],
        "sha256": digest.hexdigest(),
        "bytes": byte_count,
        "rows": row_count,
    }


def verify_dataset_and_reconstruct_vocabs(
    snapshot: dict[str, Any],
    identity: dict[str, Any],
) -> tuple[dict[str, int], dict[str, int], dict[str, Any]]:
    dataset = snapshot.get("dataset")
    if not isinstance(dataset, dict):
        raise PreviewError("Recovery dataset snapshot is invalid.")
    manifest_path = safe_repo_path(dataset.get("manifest"))
    manifest_evidence = inspect_regular_file(
        manifest_path,
        expected_sha256=dataset.get("manifestSha256"),
    )
    manifest = read_json_object(manifest_path, maximum_bytes=8 * 1024 * 1024)
    if (
        manifest.get("schemaVersion") != 2
        or manifest.get("datasetContentSha256")
        != dataset.get("contentSha256")
        or manifest.get("splitFiles")
        != {
            split: entry.get("path")
            for split, entry in (dataset.get("splits") or {}).items()
        }
    ):
        raise PreviewError("Dataset manifest does not bind the recovery snapshot.")
    config_path = safe_repo_path(snapshot["trainingConfig"]["path"])
    config = read_json_object(config_path, maximum_bytes=8 * 1024 * 1024)
    splits = dataset.get("splits")
    if not isinstance(splits, dict) or set(splits) != {"train", "dev", "test"}:
        raise PreviewError("Recovery dataset split inventory is invalid.")
    input_vocab, output_vocab, train_evidence = reconstruct_training_vocabs(
        safe_repo_path(splits["train"]["path"]),
        splits["train"],
        config,
    )
    split_evidence = {"train": train_evidence}
    for split in ("dev", "test"):
        split_evidence[split] = verify_declared_jsonl(splits[split])
    if (
        sha256_json(input_vocab) != identity.get("inputVocabSha256")
        or sha256_json(output_vocab) != identity.get("outputVocabSha256")
    ):
        raise PreviewError(
            "Reconstructed CTC vocabulary hashes differ from recovery."
        )
    augmentation = identity.get("augmentation")
    if (
        not isinstance(augmentation, dict)
        or augmentation.get("baseRows") != train_evidence["rows"]
        or augmentation.get("combinedRows")
        != augmentation.get("baseRows", 0)
        + augmentation.get("generatedRows", -1)
    ):
        raise PreviewError("Recovery augmentation identity is inconsistent.")
    return input_vocab, output_vocab, {
        "manifest": manifest_evidence,
        "contentSha256": dataset["contentSha256"],
        "splits": split_evidence,
    }


def verify_evaluation_snapshot(
    snapshot: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    for key, manifest_key, suites_key in (
        ("gold", "goldManifest", "goldSuites"),
        ("officialBenchmark", "manifest", "suites"),
    ):
        section = snapshot.get(key)
        if not isinstance(section, dict):
            raise PreviewError(f"Recovery {key} snapshot is invalid.")
        manifest_path = safe_repo_path(section.get(manifest_key))
        expected_manifest_sha = section.get(
            "goldManifestSha256" if key == "gold" else "manifestSha256"
        )
        inspect_regular_file(
            manifest_path,
            expected_sha256=expected_manifest_sha,
        )
        for suite in section.get(suites_key) or []:
            verify_declared_jsonl({
                field: suite[field]
                for field in ("path", "sha256", "rows")
            } | {"bytes": safe_repo_path(suite["path"]).stat().st_size})
    official = snapshot["officialBenchmark"]
    manifest_path = safe_repo_path(official["manifest"])
    manifest = read_json_object(manifest_path, maximum_bytes=8 * 1024 * 1024)
    if (
        manifest.get("schemaVersion") != 2
        or manifest.get("status") != "official-public-benchmark-locked"
        or manifest.get("trainingUse") != "forbidden-evaluation-only"
        or manifest.get("corpusSha256") != official.get("corpusSha256")
    ):
        raise PreviewError("Official benchmark manifest contract is stale.")
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_inputs: set[str] = set()
    declared_suites = manifest.get("suites")
    snapshot_suites = official.get("suites")
    if (
        not isinstance(declared_suites, list)
        or not isinstance(snapshot_suites, list)
        or len(declared_suites) != len(BUCKETS)
        or len(snapshot_suites) != len(BUCKETS)
    ):
        raise PreviewError("Official benchmark suite inventory is invalid.")
    for declared, snapshot_suite in zip(
        declared_suites,
        snapshot_suites,
        strict=True,
    ):
        expected = {
            key: snapshot_suite[key]
            for key in ("id", "path", "sha256", "rows", "benchmarkBucket")
        }
        observed = {
            key: declared[key]
            for key in ("id", "path", "sha256", "rows", "benchmarkBucket")
        }
        if observed != expected or observed["benchmarkBucket"] not in BUCKETS:
            raise PreviewError("Official benchmark suite identity is stale.")
        path = safe_repo_path(declared["path"])
        with path.open("rb") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise PreviewError(
                        f"Official row {line_number} is invalid JSON."
                    ) from error
                normalized = " ".join(
                    unicodedata.normalize("NFC", str(row.get("input") or ""))
                    .lower()
                    .strip()
                    .split()
                )
                acceptable = row.get("acceptable")
                if (
                    not isinstance(row.get("id"), str)
                    or row["id"] in seen_ids
                    or not isinstance(row.get("input"), str)
                    or row["input"] != normalized
                    or normalized in seen_inputs
                    or not isinstance(acceptable, list)
                    or not acceptable
                    or not all(
                        isinstance(value, str)
                        and value
                        and value == unicodedata.normalize("NFC", value)
                        for value in acceptable
                    )
                ):
                    raise PreviewError("Official benchmark row contract is invalid.")
                seen_ids.add(row["id"])
                seen_inputs.add(normalized)
                rows.append({
                    "id": row["id"],
                    "input": row["input"],
                    "acceptable": acceptable,
                    "benchmarkBucket": declared["benchmarkBucket"],
                })
    if len(rows) != official.get("rows"):
        raise PreviewError("Official benchmark total row count is stale.")
    return rows, {
        "manifest": official["manifest"],
        "manifestSha256": official["manifestSha256"],
        "corpusSha256": official["corpusSha256"],
        "rows": len(rows),
    }


def stratified_sample(
    rows: Iterable[dict[str, Any]],
    limit: int = MAX_SAMPLE_ROWS,
) -> list[dict[str, Any]]:
    if type(limit) is not int or not 1 <= limit <= MAX_SAMPLE_ROWS:
        raise PreviewError("Preview sample size must be in [1, 64].")
    grouped = {
        bucket: [
            row for row in rows
            if row.get("benchmarkBucket") == bucket
        ]
        for bucket in BUCKETS
    }
    base, remainder = divmod(limit, len(BUCKETS))
    quotas = {
        bucket: base + (index < remainder)
        for index, bucket in enumerate(BUCKETS)
    }
    selected: list[dict[str, Any]] = []
    for bucket in BUCKETS:
        ranked = sorted(
            grouped[bucket],
            key=lambda row: (
                hashlib.sha256(
                    f"{SAMPLE_POLICY}:{bucket}:{row['id']}".encode("utf-8")
                ).hexdigest(),
                row["id"],
            ),
        )
        if len(ranked) < quotas[bucket]:
            raise PreviewError(f"Official benchmark bucket is too small: {bucket}")
        selected.extend(ranked[:quotas[bucket]])
    if len(selected) != limit:
        raise PreviewError("Stratified sample did not reach its exact size.")
    return selected


def metric_bucket(rows: list[dict[str, Any]]) -> dict[str, Any]:
    count = len(rows)
    top1_hits = sum(bool(row["top1"]) for row in rows)
    top3_hits = sum(bool(row["top3"]) for row in rows)
    return {
        "rows": count,
        "top1Hits": top1_hits,
        "top1Accuracy": top1_hits / count if count else 0.0,
        "top3Hits": top3_hits,
        "top3Accuracy": top3_hits / count if count else 0.0,
    }


def run_preview(
    *,
    model: Any,
    trainer: Any,
    decoder: Any,
    runtime_config: dict[str, Any],
    input_vocab: dict[str, int],
    output_vocab: dict[str, int],
    benchmark_rows: list[dict[str, Any]],
    maximum_seconds: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    import numpy as np
    import torch

    if not 0 < maximum_seconds <= MAX_PREVIEW_SECONDS:
        raise PreviewError("Preview deadline must be in (0, 45] seconds.")
    model.eval().to("cpu")
    sample = stratified_sample(benchmark_rows)
    started = time.monotonic()
    sources = torch.tensor(
        [
            trainer.encode_input(
                row["input"],
                input_vocab,
                int(runtime_config["max_input_len"]),
            )
            for row in sample
        ],
        dtype=torch.int32,
    )
    with torch.inference_mode():
        logits = model(sources).detach().cpu().numpy()
    if (
        logits.shape
        != (
            len(sample),
            int(runtime_config["output_time_steps"]),
            len(output_vocab),
        )
        or not np.isfinite(logits).all()
    ):
        raise PreviewError("Epoch-six model produced invalid CTC logits.")
    if time.monotonic() - started > maximum_seconds:
        raise PreviewError("Preview exceeded its deadline after batch inference.")
    scored: list[dict[str, Any]] = []
    audit_state = decoder.new_ctc_decoder_audit_state()
    with decoder.install_terminal_safe_ctc_decoder(
        trainer,
        audit_state=audit_state,
    ):
        for row, row_logits in zip(sample, logits, strict=True):
            if time.monotonic() - started > maximum_seconds:
                raise PreviewError("Preview exceeded its deadline during decode.")
            candidates = trainer.decode_ctc_logits(
                row_logits,
                output_vocab,
                beam_width=int(runtime_config["beam_width"]),
                maximum_candidates=int(runtime_config["maximum_candidates"]),
            )
            acceptable = set(row["acceptable"])
            scored.append({
                "id": row["id"],
                "benchmarkBucket": row["benchmarkBucket"],
                "top1": bool(candidates[:1] and candidates[0] in acceptable),
                "top3": bool(acceptable.intersection(candidates[:3])),
            })
    elapsed = time.monotonic() - started
    if elapsed > maximum_seconds:
        raise PreviewError("Preview exceeded its deadline.")
    metrics = {
        "overall": metric_bucket(scored),
        "byBucket": {
            bucket: metric_bucket([
                row for row in scored
                if row["benchmarkBucket"] == bucket
            ])
            for bucket in BUCKETS
        },
    }
    sample_ids = [row["id"] for row in sample]
    return metrics, {
        "samplePolicy": SAMPLE_POLICY,
        "sampleRows": len(sample),
        "sampleIdsSha256": sha256_bytes(
            "\n".join(sample_ids).encode("utf-8")
        ),
        "elapsedSeconds": elapsed,
        "torchThreads": torch.get_num_threads(),
        "torchInteropThreads": torch.get_num_interop_threads(),
        "decoderAudit": audit_state,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recovery-zip", type=Path, required=True)
    parser.add_argument(
        "--run-preview",
        action="store_true",
        help="Run the bounded 64-row CPU preview after all verification passes.",
    )
    parser.add_argument(
        "--maximum-seconds",
        type=float,
        default=MAX_PREVIEW_SECONDS,
    )
    return parser.parse_args(argv)


def configure_low_heat_runtime() -> None:
    for name in (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ):
        os.environ[name] = "1"
    import torch

    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    configure_low_heat_runtime()
    import torch

    started = time.monotonic()
    with tempfile.TemporaryDirectory(
        prefix="lekh-epoch6-quality-preview-",
    ) as temporary:
        state_path = Path(temporary) / EPOCH6_POLICY.state_name
        pointer, recovery_evidence = verify_recovery_zip(
            args.recovery_zip.resolve(),
            EPOCH6_POLICY,
            state_path,
        )
        recovery = load_recovery_payload(state_path, pointer)
        identity = recovery["identity"]
        snapshot = identity.get("runInputSnapshot")
        if (
            not isinstance(snapshot, dict)
            or identity.get("schemaVersion") != 3
            or identity.get("modelId") != MODEL_ID
            or identity.get("trainingContractSha256")
            != snapshot.get("trainingConfig", {}).get("sha256")
        ):
            raise PreviewError("Recovery training identity is incomplete.")
        static_evidence = verify_snapshot_static_inputs(snapshot)
        input_vocab, output_vocab, dataset_evidence = (
            verify_dataset_and_reconstruct_vocabs(snapshot, identity)
        )
        benchmark_rows, benchmark_evidence = verify_evaluation_snapshot(
            snapshot
        )
        trainer = load_python_module(
            "lekh_epoch6_authenticated_ctc_trainer",
            safe_repo_path(TRAINER_PATH),
        )
        trainer_args = trainer.parse_args([], environment={})
        reconstructed_runtime = trainer.checkpoint_runtime_config(trainer_args)
        if (
            trainer_args.training_contract_sha256
            != identity.get("trainingContractSha256")
            or trainer_args.effective_training_config_sha256
            != identity.get("effectiveTrainingConfigSha256")
            or trainer_args.effective_artifact_inputs_sha256
            != identity.get("effectiveArtifactInputsSha256")
            or reconstructed_runtime != identity.get("runtimeConfig")
        ):
            raise PreviewError(
                "Current authenticated config does not reconstruct recovery runtime."
            )
        model = trainer.build_model_from_runtime_config(
            len(input_vocab),
            len(output_vocab),
            reconstructed_runtime,
        )
        if set(model.state_dict()) != set(recovery["bestState"]):
            raise PreviewError("Recovery bestState inventory is incompatible.")
        try:
            model.load_state_dict(recovery["bestState"], strict=True)
        except (RuntimeError, TypeError, ValueError) as error:
            raise PreviewError(
                "Recovery bestState does not bind the reconstructed model."
            ) from error
        decoder_path = safe_repo_path(TERMINAL_DECODER_PATH)
        with decoder_path.open("rb") as decoder_handle:
            decoder_sha256 = hashlib.sha256(
                decoder_handle.read()
            ).hexdigest()
        decoder = load_python_module(
            "lekh_epoch6_terminal_safe_ctc_decoder",
            decoder_path,
        )
        inspect_regular_file(
            decoder_path,
            expected_sha256=decoder_sha256,
        )
        metrics = None
        execution = {
            "mode": "verification-only",
            "sampleRows": 0,
            "elapsedSeconds": 0.0,
            "torchThreads": torch.get_num_threads(),
            "torchInteropThreads": torch.get_num_interop_threads(),
        }
        if args.run_preview:
            metrics, execution = run_preview(
                model=model,
                trainer=trainer,
                decoder=decoder,
                runtime_config=reconstructed_runtime,
                input_vocab=input_vocab,
                output_vocab=output_vocab,
                benchmark_rows=benchmark_rows,
                maximum_seconds=args.maximum_seconds,
            )
            execution["mode"] = "bounded-cpu-preview"
        report = {
            "schemaVersion": 1,
            "status": (
                "preliminary-epoch6-quality-preview"
                if args.run_preview
                else "verified-epoch6-preview-inputs"
            ),
            "label": PRELIMINARY_LABEL,
            "productionEligible": False,
            "promotionEvidence": False,
            "completedEpoch": recovery["completedEpoch"],
            "bestEpoch": recovery["bestEpoch"],
            "metrics": metrics,
            "execution": execution,
            "provenance": {
                **recovery_evidence,
                "bundleId": EPOCH6_POLICY.bundle_id,
                "trainingRunId": recovery["trainingRunId"],
                "recoveryIdentitySha256": recovery["identitySha256"],
                "trainingConfigSha256": identity["trainingContractSha256"],
                "inputVocabSha256": sha256_json(input_vocab),
                "outputVocabSha256": sha256_json(output_vocab),
                "inputVocabSize": len(input_vocab),
                "outputVocabSize": len(output_vocab),
                "dataset": dataset_evidence,
                "officialBenchmark": benchmark_evidence,
                "authenticatedSources": static_evidence,
                "previewDecoder": {
                    "path": TERMINAL_DECODER_PATH,
                    "sha256": decoder_sha256,
                    "recoveryBound": False,
                    "policy": decoder.CTC_FINITE_PATH_DECODER_POLICY,
                },
            },
            "verificationSeconds": time.monotonic() - started,
            "limitations": [
                "Epoch six is an incomplete recovery from a still-converging run.",
                "At most 64 of 4,085 official rows are sampled.",
                "This runs PyTorch bestState on CPU, not exported Core ML.",
                "The terminal-safe decoder is current compatibility code, not a recovery-bound training input.",
                "No Core ML parity, device latency, memory, packaging, or promotion gate is measured.",
                "Public benchmark labels are not new Lekh human adjudication.",
            ],
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PreviewError as error:
        print(json.dumps({
            "status": "failed-closed-epoch6-quality-preview",
            "label": PRELIMINARY_LABEL,
            "error": str(error),
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)
