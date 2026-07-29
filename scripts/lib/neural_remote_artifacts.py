#!/usr/bin/env python3
"""Closed-inventory archives for split-host neural training.

The module intentionally depends only on the Python standard library so the
same verifier can run before any third-party package is installed in Colab.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterable


SHA256_LENGTH = 64
CHUNK_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILES = 96
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_FILENAME_COMPONENT_BYTES = 180

SAFE_FILENAME_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
SAFE_ROLE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

BUNDLE_KIND = "lekh-neural-remote-training-bundle-v1"
RESULT_KIND = "lekh-neural-remote-training-result-v1"

ARCHIVE_POLICIES = {
    BUNDLE_KIND: {
        "prefix": "lekh-neural-remote",
        "manifest": "NEURAL_REMOTE_BUNDLE_MANIFEST.json",
        "identity": "bundleId",
    },
    RESULT_KIND: {
        "prefix": "lekh-neural-result",
        "manifest": "NEURAL_REMOTE_RESULT_MANIFEST.json",
        "identity": "resultId",
    },
}

SUPPORTED_CONFIGS = {
    "data/neural/training/open-vocab-seq2seq-v1.config.json",
    "data/neural/training/open-vocab-bigru-attention-v1.config.json",
}

BUNDLE_RUNTIME_FILES = (
    (
        "scripts/train-open-vocab-seq2seq-transliterator.py",
        "trainer",
    ),
    (
        "scripts/check-neural-open-vocab-toolchain.py",
        "toolchain-verifier",
    ),
    (
        "scripts/run-neural-remote-training.py",
        "remote-runner",
    ),
    (
        "scripts/verify-neural-remote-training-bundle.py",
        "bundle-verifier",
    ),
    (
        "scripts/lib/neural_remote_artifacts.py",
        "archive-contract",
    ),
    (
        "requirements/neural-open-vocab.lock",
        "python-requirements",
    ),
    (
        "requirements/neural-open-vocab-cu118.lock",
        "cuda-python-requirements",
    ),
)


class NeuralRemoteArtifactError(RuntimeError):
    """Raised when an archive or its source inventory fails closed."""


@dataclass(frozen=True)
class ArchiveFile:
    source: Path
    archive_path: str
    role: str
    expected_sha256: str | None = None
    expected_bytes: int | None = None


class DigestingReader:
    """A minimal non-seekable reader that records exact bytes consumed."""

    def __init__(self, handle: BinaryIO):
        self.handle = handle
        self.digest = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size: int = -1) -> bytes:
        value = self.handle.read(size)
        self.digest.update(value)
        self.bytes_read += len(value)
        return value

    def hexdigest(self) -> str:
        return self.digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open_regular_binary(path) as handle:
        metadata_before = os.fstat(handle.fileno())
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
        metadata_after = os.fstat(handle.fileno())
    metadata_path = path.lstat()
    if (
        metadata_after.st_dev != metadata_before.st_dev
        or metadata_after.st_ino != metadata_before.st_ino
        or metadata_after.st_size != metadata_before.st_size
        or metadata_after.st_mtime_ns != metadata_before.st_mtime_ns
        or metadata_path.st_dev != metadata_before.st_dev
        or metadata_path.st_ino != metadata_before.st_ino
        or metadata_path.st_size != metadata_before.st_size
        or metadata_path.st_mtime_ns != metadata_before.st_mtime_ns
    ):
        raise NeuralRemoteArtifactError(
            f"Regular file changed while hashing: {path}"
        )
    return digest.hexdigest()


def is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == SHA256_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def safe_relative_path(value: str, label: str = "path") -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise NeuralRemoteArtifactError(f"{label} is not a portable path.")
    parsed = PurePosixPath(value)
    if parsed.is_absolute() or any(
        component in {"", ".", ".."} for component in parsed.parts
    ):
        raise NeuralRemoteArtifactError(f"{label} escapes its archive root.")
    normalized = parsed.as_posix()
    if normalized != value or len(normalized.encode("utf-8")) > 240:
        raise NeuralRemoteArtifactError(f"{label} is non-canonical or too long.")
    return normalized


def safe_filename_component(value: str, label: str = "filename") -> str:
    if (
        not isinstance(value, str)
        or not SAFE_FILENAME_COMPONENT.fullmatch(value)
        or len(value.encode("utf-8")) > MAX_FILENAME_COMPONENT_BYTES
        or value in {".", ".."}
    ):
        raise NeuralRemoteArtifactError(
            f"{label} is not a safe portable filename component."
        )
    return value


def contained_regular_file(root: Path, relative_path: str) -> Path:
    relative = safe_relative_path(relative_path)
    requested_root = root.absolute()
    try:
        root_metadata = requested_root.lstat()
    except FileNotFoundError as error:
        raise NeuralRemoteArtifactError(
            f"Required file root is missing: {requested_root}"
        ) from error
    if (
        stat.S_ISLNK(root_metadata.st_mode)
        or not stat.S_ISDIR(root_metadata.st_mode)
    ):
        raise NeuralRemoteArtifactError(
            f"Required file root is unsafe: {requested_root}"
        )
    resolved_root = requested_root.resolve(strict=True)
    candidate = resolved_root.joinpath(*PurePosixPath(relative).parts)
    try:
        metadata = candidate.lstat()
    except FileNotFoundError as error:
        raise NeuralRemoteArtifactError(
            f"Required bundle input is missing: {relative}"
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise NeuralRemoteArtifactError(
            f"Bundle input is not a regular non-symlink file: {relative}"
        )
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(resolved_root):
        raise NeuralRemoteArtifactError(
            f"Bundle input escapes the repository: {relative}"
        )
    return resolved


def open_regular_binary(path: Path) -> BinaryIO:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise NeuralRemoteArtifactError(f"Missing regular file: {path}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise NeuralRemoteArtifactError(
            f"Refusing non-regular or symbolic-link file: {path}"
        )
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_dev != metadata.st_dev
        or opened.st_ino != metadata.st_ino
    ):
        os.close(descriptor)
        raise NeuralRemoteArtifactError(
            f"Regular file changed before it could be opened: {path}"
        )
    return os.fdopen(descriptor, "rb")


def read_json_object(path: Path, maximum_bytes: int = MAX_MANIFEST_BYTES) -> dict[str, Any]:
    with open_regular_binary(path) as handle:
        payload = handle.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise NeuralRemoteArtifactError(f"JSON artifact is too large: {path}")
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise NeuralRemoteArtifactError(f"Invalid UTF-8 JSON: {path}") from error
    if not isinstance(parsed, dict):
        raise NeuralRemoteArtifactError(f"JSON artifact must be an object: {path}")
    return parsed


def collect_training_bundle(
    repo_root: Path,
    config_relative_path: str,
) -> tuple[dict[str, Any], list[ArchiveFile]]:
    root = repo_root.resolve(strict=True)
    config_relative = safe_relative_path(
        config_relative_path,
        "training config path",
    )
    if config_relative not in SUPPORTED_CONFIGS:
        raise NeuralRemoteArtifactError(
            f"Unsupported remote training config: {config_relative}"
        )
    config_path = contained_regular_file(root, config_relative)
    config = read_json_object(config_path)
    model_id = config.get("modelId")
    if not isinstance(model_id, str) or not model_id:
        raise NeuralRemoteArtifactError("Training config lacks modelId.")

    files: dict[str, ArchiveFile] = {}

    def add(
        relative_path: str,
        role: str,
        *,
        expected_sha256: str | None = None,
        expected_bytes: int | None = None,
    ) -> None:
        relative = safe_relative_path(relative_path)
        if relative in files:
            raise NeuralRemoteArtifactError(
                f"Duplicate remote bundle path: {relative}"
            )
        if expected_sha256 is not None and not is_sha256(expected_sha256):
            raise NeuralRemoteArtifactError(
                f"Invalid expected digest for {relative}."
            )
        if expected_bytes is not None and (
            type(expected_bytes) is not int or expected_bytes < 1
        ):
            raise NeuralRemoteArtifactError(
                f"Invalid expected byte count for {relative}."
            )
        files[relative] = ArchiveFile(
            source=contained_regular_file(root, relative),
            archive_path=relative,
            role=role,
            expected_sha256=expected_sha256,
            expected_bytes=expected_bytes,
        )

    for relative, role in BUNDLE_RUNTIME_FILES:
        add(relative, role)
    add(config_relative, "training-config")

    training = config.get("training")
    evaluation = config.get("evaluation")
    if not isinstance(training, dict) or not isinstance(evaluation, dict):
        raise NeuralRemoteArtifactError(
            "Training config lacks training/evaluation sections."
        )
    dataset_relative = safe_relative_path(
        training.get("datasetManifest"),
        "dataset manifest path",
    )
    gold_relative = safe_relative_path(
        evaluation.get("goldManifest"),
        "gold manifest path",
    )
    official_relative = safe_relative_path(
        evaluation.get("officialBenchmarkManifest"),
        "official benchmark manifest path",
    )

    dataset_path = contained_regular_file(root, dataset_relative)
    dataset = read_json_object(dataset_path)
    add(dataset_relative, "dataset-manifest")
    for split in ("train", "dev", "test"):
        try:
            split_path = dataset["splitFiles"][split]
            split_sha256 = dataset["sha256"][split]
            split_bytes = dataset["bytes"][split]
        except (KeyError, TypeError) as error:
            raise NeuralRemoteArtifactError(
                f"Dataset manifest lacks {split} inventory."
            ) from error
        add(
            split_path,
            f"dataset-{split}",
            expected_sha256=split_sha256,
            expected_bytes=split_bytes,
        )

    gold_path = contained_regular_file(root, gold_relative)
    gold = read_json_object(gold_path)
    add(gold_relative, "gold-manifest")
    add_manifest_suites(add, gold, "gold-suite")

    official_path = contained_regular_file(root, official_relative)
    official = read_json_object(official_path)
    add(official_relative, "official-benchmark-manifest")
    add_manifest_suites(add, official, "official-benchmark-suite")

    dataset_identity = dataset.get("datasetContentSha256")
    gold_identity = gold.get("corpusSha256")
    official_identity = official.get("corpusSha256")
    if not all(
        is_sha256(value)
        for value in (dataset_identity, gold_identity, official_identity)
    ):
        raise NeuralRemoteArtifactError(
            "Dataset/gold/benchmark corpus identity is invalid."
        )

    manifest_base = {
        "schemaVersion": 1,
        "modelId": model_id,
        "trainingConfig": config_relative,
        "datasetManifest": dataset_relative,
        "datasetContentSha256": dataset_identity,
        "goldManifest": gold_relative,
        "goldCorpusSha256": gold_identity,
        "officialBenchmarkManifest": official_relative,
        "officialBenchmarkCorpusSha256": official_identity,
        "trainingProtocol": {
            "device": "cuda",
            "skipTrain": False,
            "skipCoreML": True,
            "deterministicAlgorithms": True,
            "cublasWorkspaceConfig": ":4096:8",
        },
    }
    return manifest_base, sorted(
        files.values(),
        key=lambda item: item.archive_path,
    )


def add_manifest_suites(
    add: Any,
    manifest: dict[str, Any],
    role: str,
) -> None:
    suites = manifest.get("suites")
    if not isinstance(suites, list) or not suites:
        raise NeuralRemoteArtifactError(f"{role} manifest has no suites.")
    for suite in suites:
        if not isinstance(suite, dict):
            raise NeuralRemoteArtifactError(f"{role} inventory is invalid.")
        add(
            suite.get("path"),
            role,
            expected_sha256=suite.get("sha256"),
        )


def manifest_identity(manifest: dict[str, Any], identity_field: str) -> str:
    unsigned = dict(manifest)
    unsigned.pop(identity_field, None)
    return sha256_bytes(canonical_json_bytes(unsigned))


def build_closed_archive(
    *,
    source_root: Path,
    output_dir: Path,
    artifact_kind: str,
    filename_stem: str,
    manifest_base: dict[str, Any],
    files: Iterable[ArchiveFile],
    compression_level: int = 1,
) -> dict[str, Any]:
    policy = archive_policy(artifact_kind)
    if type(compression_level) is not int or not 0 <= compression_level <= 9:
        raise NeuralRemoteArtifactError("Gzip compression level must be 0-9.")
    filename_stem = safe_filename_component(
        filename_stem,
        "archive filename stem",
    )
    if (
        not isinstance(manifest_base, dict)
        or manifest_base.get("schemaVersion") != 1
    ):
        raise NeuralRemoteArtifactError(
            "Archive manifest base must use schemaVersion 1."
        )
    reserved_manifest_fields = {
        "artifactKind",
        "archivePrefix",
        "compression",
        "files",
        policy["identity"],
    }
    if reserved_manifest_fields.intersection(manifest_base):
        raise NeuralRemoteArtifactError(
            "Archive manifest base contains a reserved contract field."
        )

    requested_root = source_root.absolute()
    root_metadata = requested_root.lstat()
    if (
        stat.S_ISLNK(root_metadata.st_mode)
        or not stat.S_ISDIR(root_metadata.st_mode)
    ):
        raise NeuralRemoteArtifactError(
            f"Archive source root is unsafe: {requested_root}"
        )
    root = requested_root.resolve(strict=True)
    requested_output_dir = output_dir.absolute()
    if requested_output_dir.is_symlink():
        raise NeuralRemoteArtifactError(
            f"Archive output directory is unsafe: {requested_output_dir}"
        )
    requested_output_dir.mkdir(parents=True, exist_ok=True)
    destination_dir = requested_output_dir.resolve(strict=True)
    if not destination_dir.is_dir():
        raise NeuralRemoteArtifactError(
            f"Archive output directory is unsafe: {destination_dir}"
        )
    specs = sorted(files, key=lambda item: item.archive_path)
    if not specs or len(specs) > MAX_FILES:
        raise NeuralRemoteArtifactError("Archive file inventory is empty or too large.")
    if len({item.archive_path for item in specs}) != len(specs):
        raise NeuralRemoteArtifactError("Archive file inventory contains duplicates.")

    staging = destination_dir / (
        f".{filename_stem}.staging.{os.getpid()}.{uuid.uuid4().hex}.tar.gz"
    )
    entries: list[dict[str, Any]] = []
    total_bytes = 0
    manifest: dict[str, Any] | None = None
    manifest_bytes: bytes | None = None
    try:
        with staging.open("xb") as raw:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                compresslevel=compression_level,
                fileobj=raw,
                mtime=0,
            ) as compressed:
                with tarfile.open(
                    fileobj=compressed,
                    mode="w|",
                    format=tarfile.USTAR_FORMAT,
                ) as archive:
                    for spec in specs:
                        relative = safe_relative_path(
                            spec.archive_path,
                            "archive member path",
                        )
                        if (
                            not isinstance(spec.role, str)
                            or not SAFE_ROLE.fullmatch(spec.role)
                            or len(spec.role) > 80
                        ):
                            raise NeuralRemoteArtifactError(
                                f"Archive member role is invalid: {relative}"
                            )
                        requested_source = spec.source.absolute()
                        requested_metadata = requested_source.lstat()
                        if stat.S_ISLNK(requested_metadata.st_mode):
                            raise NeuralRemoteArtifactError(
                                f"Archive source is a symbolic link: {relative}"
                            )
                        source = requested_source.resolve(strict=True)
                        if not source.is_relative_to(root):
                            raise NeuralRemoteArtifactError(
                                f"Archive source escapes its root: {source}"
                            )
                        metadata_before = source.lstat()
                        if (
                            stat.S_ISLNK(metadata_before.st_mode)
                            or not stat.S_ISREG(metadata_before.st_mode)
                            or metadata_before.st_size < 1
                            or metadata_before.st_size > MAX_MEMBER_BYTES
                        ):
                            raise NeuralRemoteArtifactError(
                                f"Archive source is unsafe: {relative}"
                            )
                        member = regular_tar_info(
                            f"{policy['prefix']}/{relative}",
                            metadata_before.st_size,
                        )
                        with open_regular_binary(source) as handle:
                            digesting = DigestingReader(handle)
                            archive.addfile(member, digesting)
                        metadata_after = source.lstat()
                        if (
                            digesting.bytes_read != metadata_before.st_size
                            or metadata_after.st_dev != metadata_before.st_dev
                            or metadata_after.st_ino != metadata_before.st_ino
                            or metadata_after.st_size != metadata_before.st_size
                            or metadata_after.st_mtime_ns
                                != metadata_before.st_mtime_ns
                        ):
                            raise NeuralRemoteArtifactError(
                                f"Archive source changed while reading: {relative}"
                            )
                        observed_sha256 = digesting.hexdigest()
                        if (
                            spec.expected_sha256 is not None
                            and observed_sha256 != spec.expected_sha256
                        ):
                            raise NeuralRemoteArtifactError(
                                f"Archive source digest is stale: {relative}"
                            )
                        if (
                            spec.expected_bytes is not None
                            and metadata_before.st_size != spec.expected_bytes
                        ):
                            raise NeuralRemoteArtifactError(
                                f"Archive source byte count is stale: {relative}"
                            )
                        total_bytes += metadata_before.st_size
                        if total_bytes > MAX_TOTAL_BYTES:
                            raise NeuralRemoteArtifactError(
                                "Archive exceeds the uncompressed safety limit."
                            )
                        entries.append(
                            {
                                "path": relative,
                                "role": spec.role,
                                "sha256": observed_sha256,
                                "bytes": metadata_before.st_size,
                            }
                        )

                    unsigned_manifest = {
                        **manifest_base,
                        "artifactKind": artifact_kind,
                        "archivePrefix": policy["prefix"],
                        "compression": "tar-gzip-deterministic-v1",
                        "files": entries,
                    }
                    identity = manifest_identity(
                        unsigned_manifest,
                        policy["identity"],
                    )
                    manifest = {
                        **unsigned_manifest,
                        policy["identity"]: identity,
                    }
                    manifest_bytes = canonical_json_bytes(manifest) + b"\n"
                    archive.addfile(
                        regular_tar_info(
                            f"{policy['prefix']}/{policy['manifest']}",
                            len(manifest_bytes),
                        ),
                        BytesReader(manifest_bytes),
                    )
            raw.flush()
            os.fsync(raw.fileno())

        if manifest is None or manifest_bytes is None:
            raise NeuralRemoteArtifactError("Archive manifest was not created.")
        identity = manifest[policy["identity"]]
        target = destination_dir / (
            f"{filename_stem}-{identity[:16]}.tar.gz"
        )
        archive_sha256 = sha256_file(staging)
        if target.exists() or target.is_symlink():
            if (
                target.is_symlink()
                or not target.is_file()
                or sha256_file(target) != archive_sha256
            ):
                raise NeuralRemoteArtifactError(
                    f"Archive target already exists with different bytes: {target}"
                )
            staging.unlink()
        else:
            os.replace(staging, target)
        return {
            "schemaVersion": 1,
            "status": "passed-closed-archive-build",
            "artifactKind": artifact_kind,
            policy["identity"]: identity,
            "archive": str(target),
            "archiveSha256": archive_sha256,
            "archiveBytes": target.stat().st_size,
            "manifestSha256": sha256_bytes(manifest_bytes),
            "uncompressedInputBytes": total_bytes,
            "fileCount": len(entries),
            "manifest": manifest,
        }
    except BaseException:
        staging.unlink(missing_ok=True)
        raise


class BytesReader:
    def __init__(self, value: bytes):
        self.value = value
        self.offset = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = len(self.value) - self.offset
        start = self.offset
        self.offset = min(len(self.value), self.offset + size)
        return self.value[start:self.offset]


def regular_tar_info(name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = 0o644
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.type = tarfile.REGTYPE
    return info


def verify_closed_archive(
    archive_path: Path,
    *,
    expected_kind: str,
    expected_archive_sha256: str | None = None,
    extract_to: Path | None = None,
) -> dict[str, Any]:
    policy = archive_policy(expected_kind)
    requested_archive = archive_path.absolute()
    metadata = requested_archive.lstat()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or not 1 <= metadata.st_size <= MAX_ARCHIVE_BYTES
    ):
        raise NeuralRemoteArtifactError("Remote archive is unsafe or too large.")
    archive = requested_archive.resolve(strict=True)
    if (
        expected_archive_sha256 is not None
        and not is_sha256(expected_archive_sha256)
    ):
        raise NeuralRemoteArtifactError("Expected archive SHA-256 is invalid.")

    staging: Path | None = None
    destination: Path | None = None
    if extract_to is not None:
        destination = extract_to.resolve()
        if destination.exists() or destination.is_symlink():
            raise NeuralRemoteArtifactError(
                f"Extraction destination already exists: {destination}"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(
            tempfile.mkdtemp(
                prefix=f".{destination.name}.staging.",
                dir=destination.parent,
            )
        )
        os.chmod(staging, 0o700)

    observed: list[dict[str, Any]] = []
    manifest: dict[str, Any] | None = None
    manifest_payload: bytes | None = None
    total_bytes = 0
    try:
        with open_regular_binary(archive) as raw:
            archive_reader = DigestingReader(raw)
            with tarfile.open(fileobj=archive_reader, mode="r|gz") as tar:
                saw_manifest = False
                for member in tar:
                    validate_tar_member_metadata(member)
                    expected_prefix = f"{policy['prefix']}/"
                    if not member.name.startswith(expected_prefix):
                        raise NeuralRemoteArtifactError(
                            f"Archive member has the wrong root: {member.name}"
                        )
                    relative = safe_relative_path(
                        member.name[len(expected_prefix):],
                        "archive member path",
                    )
                    stream = tar.extractfile(member)
                    if stream is None:
                        raise NeuralRemoteArtifactError(
                            f"Archive member cannot be read: {relative}"
                        )
                    if relative == policy["manifest"]:
                        if saw_manifest:
                            raise NeuralRemoteArtifactError(
                                "Archive contains duplicate manifests."
                            )
                        saw_manifest = True
                        manifest_payload = stream.read(MAX_MANIFEST_BYTES + 1)
                        if (
                            len(manifest_payload) > MAX_MANIFEST_BYTES
                            or len(manifest_payload) != member.size
                        ):
                            raise NeuralRemoteArtifactError(
                                "Archive manifest is truncated or too large."
                            )
                        try:
                            parsed = json.loads(
                                manifest_payload.decode("utf-8")
                            )
                        except (
                            UnicodeDecodeError,
                            json.JSONDecodeError,
                        ) as error:
                            raise NeuralRemoteArtifactError(
                                "Archive manifest is invalid JSON."
                            ) from error
                        if not isinstance(parsed, dict):
                            raise NeuralRemoteArtifactError(
                                "Archive manifest must be an object."
                            )
                        manifest = parsed
                        continue
                    if saw_manifest:
                        raise NeuralRemoteArtifactError(
                            "Archive contains members after its closing manifest."
                        )
                    if len(observed) >= MAX_FILES:
                        raise NeuralRemoteArtifactError(
                            "Archive contains too many files."
                        )
                    if not 1 <= member.size <= MAX_MEMBER_BYTES:
                        raise NeuralRemoteArtifactError(
                            f"Archive member size is unsafe: {relative}"
                        )
                    total_bytes += member.size
                    if total_bytes > MAX_TOTAL_BYTES:
                        raise NeuralRemoteArtifactError(
                            "Archive exceeds the uncompressed safety limit."
                        )
                    digest = hashlib.sha256()
                    written = 0
                    output: BinaryIO | None = None
                    try:
                        if staging is not None:
                            output_path = safe_extraction_path(staging, relative)
                            output_path.parent.mkdir(
                                parents=True,
                                exist_ok=True,
                            )
                            descriptor = os.open(
                                output_path,
                                os.O_WRONLY
                                | os.O_CREAT
                                | os.O_EXCL
                                | getattr(os, "O_NOFOLLOW", 0),
                                0o600,
                            )
                            output = os.fdopen(descriptor, "wb")
                        while True:
                            chunk = stream.read(CHUNK_BYTES)
                            if not chunk:
                                break
                            written += len(chunk)
                            if written > member.size:
                                raise NeuralRemoteArtifactError(
                                    f"Archive member exceeds declared size: {relative}"
                                )
                            digest.update(chunk)
                            if output is not None:
                                output.write(chunk)
                        if written != member.size:
                            raise NeuralRemoteArtifactError(
                                f"Archive member is truncated: {relative}"
                            )
                        if output is not None:
                            output.flush()
                            os.fsync(output.fileno())
                            os.fchmod(output.fileno(), 0o644)
                    finally:
                        if output is not None:
                            output.close()
                    observed.append(
                        {
                            "path": relative,
                            "sha256": digest.hexdigest(),
                            "bytes": written,
                        }
                    )
            for _chunk in iter(
                lambda: archive_reader.read(CHUNK_BYTES),
                b"",
            ):
                pass
        archive_sha256 = archive_reader.hexdigest()
        metadata_after = archive.lstat()
        if (
            archive_reader.bytes_read != metadata.st_size
            or metadata_after.st_dev != metadata.st_dev
            or metadata_after.st_ino != metadata.st_ino
            or metadata_after.st_size != metadata.st_size
            or metadata_after.st_mtime_ns != metadata.st_mtime_ns
        ):
            raise NeuralRemoteArtifactError(
                "Remote archive changed while it was being verified."
            )
        if (
            expected_archive_sha256 is not None
            and archive_sha256 != expected_archive_sha256
        ):
            raise NeuralRemoteArtifactError(
                "Remote archive SHA-256 does not match the trusted value."
            )
        if manifest is None or manifest_payload is None:
            raise NeuralRemoteArtifactError("Archive closing manifest is missing.")
        validate_closed_manifest(
            manifest,
            expected_kind=expected_kind,
            observed=observed,
        )
        if staging is not None and destination is not None:
            manifest_path = staging / policy["manifest"]
            descriptor = os.open(
                manifest_path,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            with os.fdopen(descriptor, "wb") as output:
                output.write(manifest_payload)
                output.flush()
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), 0o644)
            os.replace(staging, destination)
            staging = None
        return {
            "schemaVersion": 1,
            "status": "passed-closed-archive-verification",
            "artifactKind": expected_kind,
            policy["identity"]: manifest[policy["identity"]],
            "archive": str(archive),
            "archiveSha256": archive_sha256,
            "archiveBytes": metadata.st_size,
            "manifestSha256": sha256_bytes(manifest_payload),
            "fileCount": len(observed),
            "uncompressedInputBytes": total_bytes,
            "extractedTo": str(destination) if destination is not None else None,
            "manifest": manifest,
        }
    finally:
        if staging is not None and staging.exists():
            shutil.rmtree(staging)


def validate_closed_manifest(
    manifest: dict[str, Any],
    *,
    expected_kind: str,
    observed: list[dict[str, Any]],
) -> None:
    policy = archive_policy(expected_kind)
    identity_field = policy["identity"]
    if manifest.get("schemaVersion") != 1:
        raise NeuralRemoteArtifactError("Archive manifest schema is unsupported.")
    if manifest.get("artifactKind") != expected_kind:
        raise NeuralRemoteArtifactError("Archive manifest kind is incorrect.")
    if manifest.get("archivePrefix") != policy["prefix"]:
        raise NeuralRemoteArtifactError("Archive prefix attestation is incorrect.")
    if manifest.get("compression") != "tar-gzip-deterministic-v1":
        raise NeuralRemoteArtifactError("Archive compression contract is invalid.")
    identity = manifest.get(identity_field)
    if not is_sha256(identity) or identity != manifest_identity(
        manifest,
        identity_field,
    ):
        raise NeuralRemoteArtifactError("Archive manifest identity is invalid.")
    declared = manifest.get("files")
    if not isinstance(declared, list) or not declared:
        raise NeuralRemoteArtifactError("Archive manifest file inventory is empty.")
    if any(not isinstance(entry, dict) for entry in declared):
        raise NeuralRemoteArtifactError(
            "Archive manifest file entry schema is invalid."
        )
    if declared != sorted(declared, key=lambda item: item.get("path", "")):
        raise NeuralRemoteArtifactError("Archive manifest inventory is not sorted.")
    declared_without_roles: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in declared:
        if set(entry) != {
            "path",
            "role",
            "sha256",
            "bytes",
        }:
            raise NeuralRemoteArtifactError(
                "Archive manifest file entry schema is invalid."
            )
        path = safe_relative_path(entry["path"], "manifest file path")
        if path in seen:
            raise NeuralRemoteArtifactError(
                "Archive manifest contains duplicate paths."
            )
        seen.add(path)
        if (
            not isinstance(entry["role"], str)
            or not entry["role"]
            or not is_sha256(entry["sha256"])
            or type(entry["bytes"]) is not int
            or not 1 <= entry["bytes"] <= MAX_MEMBER_BYTES
        ):
            raise NeuralRemoteArtifactError(
                f"Archive manifest evidence is invalid: {path}"
            )
        declared_without_roles.append(
            {
                "path": path,
                "sha256": entry["sha256"],
                "bytes": entry["bytes"],
            }
        )
    if declared_without_roles != observed:
        raise NeuralRemoteArtifactError(
            "Archive bytes do not match the closed manifest inventory."
        )


def validate_tar_member_metadata(member: tarfile.TarInfo) -> None:
    if (
        not member.isreg()
        or member.mode != 0o644
        or member.uid != 0
        or member.gid != 0
        or member.uname not in {"", None}
        or member.gname not in {"", None}
        or member.mtime != 0
        or member.linkname
        or member.pax_headers
    ):
        raise NeuralRemoteArtifactError(
            f"Archive member metadata is unsafe: {member.name}"
        )


def safe_extraction_path(staging: Path, relative: str) -> Path:
    target = staging.joinpath(*PurePosixPath(relative).parts)
    if not target.resolve().is_relative_to(staging.resolve()):
        raise NeuralRemoteArtifactError(
            f"Extraction member escapes staging: {relative}"
        )
    return target


def verify_extracted_tree(
    root: Path,
    *,
    expected_kind: str,
    allowed_output_prefixes: Iterable[str] = (),
) -> dict[str, Any]:
    policy = archive_policy(expected_kind)
    requested_root = root.absolute()
    root_metadata = requested_root.lstat()
    if (
        stat.S_ISLNK(root_metadata.st_mode)
        or not stat.S_ISDIR(root_metadata.st_mode)
    ):
        raise NeuralRemoteArtifactError(
            f"Extracted tree root is unsafe: {requested_root}"
        )
    extracted_root = requested_root.resolve(strict=True)
    manifest_path = contained_regular_file(
        extracted_root,
        policy["manifest"],
    )
    manifest = read_json_object(manifest_path)
    declared = manifest.get("files")
    if not isinstance(declared, list):
        raise NeuralRemoteArtifactError("Extracted manifest inventory is invalid.")
    observed = []
    for entry in declared:
        if not isinstance(entry, dict):
            raise NeuralRemoteArtifactError(
                "Extracted manifest entry is invalid."
            )
        relative = safe_relative_path(entry.get("path"), "manifest file path")
        path = contained_regular_file(extracted_root, relative)
        size = path.stat().st_size
        observed.append(
            {
                "path": relative,
                "sha256": sha256_file(path),
                "bytes": size,
            }
        )
    validate_closed_manifest(
        manifest,
        expected_kind=expected_kind,
        observed=observed,
    )

    allowed_prefixes = tuple(
        safe_relative_path(value, "allowed output prefix").rstrip("/") + "/"
        for value in allowed_output_prefixes
    )
    declared_paths = {
        entry["path"] for entry in declared
    } | {policy["manifest"]}
    for current, directories, filenames in os.walk(
        extracted_root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current)
        for name in [*directories, *filenames]:
            child = current_path / name
            metadata = child.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                raise NeuralRemoteArtifactError(
                    f"Extracted tree contains a symbolic link: {child}"
                )
            if not (
                stat.S_ISDIR(metadata.st_mode)
                or stat.S_ISREG(metadata.st_mode)
            ):
                raise NeuralRemoteArtifactError(
                    f"Extracted tree contains a special file: {child}"
                )
        for filename in filenames:
            path = current_path / filename
            relative = path.relative_to(extracted_root).as_posix()
            if relative in declared_paths:
                continue
            if any(relative.startswith(prefix) for prefix in allowed_prefixes):
                continue
            raise NeuralRemoteArtifactError(
                f"Extracted tree contains an unlisted file: {relative}"
            )
    return manifest


def archive_policy(artifact_kind: str) -> dict[str, str]:
    try:
        return ARCHIVE_POLICIES[artifact_kind]
    except KeyError as error:
        raise NeuralRemoteArtifactError(
            f"Unsupported closed archive kind: {artifact_kind}"
        ) from error
