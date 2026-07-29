#!/usr/bin/env python3
"""Generate sparse-output probes from the exact compiled Transformer-CTC artifact.

This is intentionally a post-export tool. It imports the authenticated trainer
without modifying it, reloads the immutable checkpoint, re-runs the compiled
Core ML known-answer parity check, and then decodes only the frozen rare-scalar
probe inputs. It never trains or updates model weights.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import secrets
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Any, BinaryIO, Callable, Iterable, Iterator


ROOT = Path(__file__).resolve().parents[1]
TRAINER_PATH = ROOT / "scripts" / "train-open-vocab-ctc-transformer.py"
DEFAULT_CONFIG = (
    ROOT
    / "data"
    / "neural"
    / "training"
    / "open-vocab-ctc-transformer-v2.config.json"
)
DEFAULT_CANDIDATE_DIR = (
    ROOT
    / "data"
    / "generated"
    / "neural-open-vocab-model"
    / "lekh-open-vocab-ctc-transformer-v2"
)
DEFAULT_CONTRACT = (
    ROOT
    / "data"
    / "neural"
    / "eval"
    / "ctc-rare-output-scalar-probes-v1.json"
)
MODEL_ID = "lekh-open-vocab-ctc-transformer-v2"
RUNTIME_MODEL_CONTRACT = "single-transformer-ctc-v1"
PREDICTIONS_NAME = "rare-scalar-predictions.jsonl"
GENERATION_REPORT_NAME = "rare-scalar-prediction-report.json"
RUN_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
ROMAN_INPUT_PATTERN = re.compile(r"^[a-z]+$")
MAX_JSON_BYTES = 16 * 1024 * 1024
CTC_FINITE_PATH_DECODER_POLICY = {
    "schemaVersion": 1,
    "policyId": "ctc-finite-path-only-v1",
    "rule": "repeat-aware-required-time-steps<=logit-time-steps",
    "purpose": "exclude-zero-probability-prefixes",
}


class RareScalarGenerationError(RuntimeError):
    """Raised when post-export rare-scalar evidence cannot be trusted."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--candidate-dir",
        type=Path,
        default=DEFAULT_CANDIDATE_DIR,
    )
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--export-report", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    return parser.parse_args(argv)


def build_prediction_rows(
    contract: dict[str, Any],
    decode: Callable[[str], Iterable[str]],
) -> list[dict[str, Any]]:
    """Decode the closed probe inventory in contract order."""

    if (
        contract.get("schemaVersion") != 1
        or contract.get("contentIdentity")
        != "lekh-neural-ctc-rare-output-scalar-probes-v1"
        or contract.get("status") != "frozen-dataset-derived-diagnostic"
    ):
        raise RareScalarGenerationError(
            "Rare-scalar contract identity or frozen status is invalid."
        )
    scalars = contract.get("scalars")
    if not isinstance(scalars, list) or not scalars:
        raise RareScalarGenerationError(
            "Rare-scalar contract contains no scalar inventory."
        )

    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for scalar_record in scalars:
        if not isinstance(scalar_record, dict):
            raise RareScalarGenerationError(
                "Rare-scalar contract contains a non-object scalar record."
            )
        scalar = scalar_record.get("scalar")
        probes = scalar_record.get("probes")
        if (
            not isinstance(scalar, str)
            or len(scalar) == 0
            or not isinstance(probes, list)
            or not probes
        ):
            raise RareScalarGenerationError(
                "Rare-scalar contract contains an invalid scalar record."
            )
        for probe in probes:
            if not isinstance(probe, dict):
                raise RareScalarGenerationError(
                    "Rare-scalar contract contains a non-object probe."
                )
            probe_id = probe.get("id")
            input_text = probe.get("input")
            target = probe.get("target")
            if (
                not isinstance(probe_id, str)
                or not probe_id
                or probe_id in seen_ids
                or not isinstance(input_text, str)
                or ROMAN_INPUT_PATTERN.fullmatch(input_text) is None
                or not isinstance(target, str)
                or scalar not in target
            ):
                raise RareScalarGenerationError(
                    "Rare-scalar contract probe identity or text is invalid."
                )
            seen_ids.add(probe_id)
            candidates = list(decode(input_text))
            if (
                len(candidates) > 4
                or any(
                    not isinstance(candidate, str) or not candidate
                    for candidate in candidates
                )
                or len(set(candidates)) != len(candidates)
            ):
                raise RareScalarGenerationError(
                    f"Compiled decoder returned invalid candidates for {probe_id}."
                )
            rows.append(
                {
                    "id": probe_id,
                    "input": input_text,
                    "candidates": candidates,
                }
            )
    if not rows:
        raise RareScalarGenerationError(
            "Rare-scalar contract produced no prediction rows."
        )
    return rows


def finite_path_candidates(
    candidates: Iterable[str],
    output_time_steps: int,
) -> list[str]:
    """Retain only candidate strings with at least one legal CTC path."""
    if type(output_time_steps) is not int or output_time_steps < 1:
        raise RareScalarGenerationError(
            "CTC output time steps must be a positive integer."
        )
    filtered: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, str) or not candidate:
            raise RareScalarGenerationError(
                "Compiled decoder returned an invalid candidate."
            )
        scalars = list(candidate)
        required_steps = len(scalars) + sum(
            left == right
            for left, right in zip(scalars, scalars[1:])
        )
        if required_steps <= output_time_steps:
            filtered.append(candidate)
    return filtered


def validate_export_binding(
    *,
    trainer: ModuleType,
    trainer_args: argparse.Namespace,
    export_report: dict[str, Any],
    contract: dict[str, Any],
    parsed_json_hashes: dict[str, str],
    paths: dict[str, Path],
) -> dict[str, str]:
    """Fail closed unless every input is the exact exported CTC candidate."""

    required_paths = {
        name: canonical_path(path, name, expect_directory=name in {
            "candidate directory",
            "compiled model",
            "Core ML package",
        })
        for name, path in paths.items()
    }
    candidate_dir = required_paths["candidate directory"]
    candidate_members = {
        "export report",
        "checkpoint",
        "training report",
        "manifest",
        "vocabulary",
        "compiled model",
        "Core ML package",
    }
    for name in candidate_members:
        path = required_paths[name]
        ensure_within(candidate_dir, path, name)

    if (
        export_report.get("status")
        != "passed-open-vocab-ctc-transformer-candidate"
        or export_report.get("modelId") != MODEL_ID
        or export_report.get("runtimeModelContract")
        != RUNTIME_MODEL_CONTRACT
        or export_report.get("productionEligible") is not False
        or export_report.get("coremlExport", {}).get("status") != "passed"
        or export_report.get("coremlExport", {}).get(
            "finitePathDecoderPolicy"
        ) != CTC_FINITE_PATH_DECODER_POLICY
        or export_report.get("runtimeArtifactContractIssues") != []
    ):
        raise RareScalarGenerationError(
            "Rare-scalar generation requires a passed immutable CTC candidate."
        )
    training_run_id = export_report.get("trainingRunId")
    export_run_id = export_report.get("exportRunId")
    if (
        not isinstance(training_run_id, str)
        or RUN_ID_PATTERN.fullmatch(training_run_id) is None
        or not isinstance(export_run_id, str)
        or RUN_ID_PATTERN.fullmatch(export_run_id) is None
        or training_run_id == export_run_id
    ):
        raise RareScalarGenerationError(
            "Candidate training/export run identities are invalid."
        )

    declared_paths = {
        "checkpoint": export_report.get("checkpoint"),
        "training report": export_report.get("trainingReport"),
        "manifest": export_report.get("manifest"),
        "compiled model": export_report.get("compiledModel"),
        "Core ML package": export_report.get("mlpackage"),
    }
    for name, declared in declared_paths.items():
        if not isinstance(declared, str) or not declared:
            raise RareScalarGenerationError(
                f"Candidate export report lacks {name}."
            )
        if (ROOT / declared).resolve() != required_paths[name]:
            raise RareScalarGenerationError(
                f"Candidate export report {name} path is stale."
            )

    file_hashes = {
        "export report": sha256_file(
            required_paths["export report"],
            "export report",
        ),
        "contract": sha256_file(
            required_paths["contract"],
            "rare-scalar contract",
        ),
        "dataset manifest": sha256_file(
            required_paths["dataset manifest"],
            "dataset manifest",
        ),
        "checkpoint": sha256_file(
            required_paths["checkpoint"],
            "checkpoint",
        ),
        "training report": sha256_file(
            required_paths["training report"],
            "training report",
        ),
        "manifest": sha256_file(
            required_paths["manifest"],
            "candidate manifest",
        ),
        "vocabulary": sha256_file(
            required_paths["vocabulary"],
            "candidate vocabulary",
        ),
        "compiled model": trainer.directory_sha256(
            required_paths["compiled model"]
        ),
        "Core ML package": trainer.directory_sha256(
            required_paths["Core ML package"]
        ),
    }
    if any(
        parsed_json_hashes.get(name) != file_hashes[name]
        for name in ("export report", "contract")
    ):
        raise RareScalarGenerationError(
            "Parsed rare-scalar JSON changed before artifact binding."
        )
    expected_hashes = {
        "checkpoint": export_report.get("checkpointSha256"),
        "training report": export_report.get("trainingReportSha256"),
        "manifest": export_report.get("manifestSha256"),
        "compiled model": export_report.get("compiledModelSha256"),
        "Core ML package": export_report.get("mlpackageSha256"),
    }
    for name, expected in expected_hashes.items():
        if (
            not isinstance(expected, str)
            or SHA256_PATTERN.fullmatch(expected) is None
            or file_hashes[name] != expected
        ):
            raise RareScalarGenerationError(
                f"Candidate {name} bytes do not match the export report."
            )
    contract_dataset = contract.get("dataset", {})
    checkpoint_dataset_sha = contract_dataset.get("manifestSha256")
    snapshot_dataset = export_report.get("runInputSnapshot", {}).get(
        "dataset",
        {},
    )
    if (
        contract_dataset.get("manifest")
        != portable(required_paths["dataset manifest"])
        or checkpoint_dataset_sha != file_hashes["dataset manifest"]
        or checkpoint_dataset_sha != snapshot_dataset.get("manifestSha256")
        or portable(required_paths["dataset manifest"])
        != trainer_args.training_config["training"]["datasetManifest"]
    ):
        raise RareScalarGenerationError(
            "Rare-scalar contract does not bind the exported training dataset."
        )
    return file_hashes


def run(arguments: argparse.Namespace) -> dict[str, Any]:
    candidate_dir = canonical_path(
        arguments.candidate_dir,
        "candidate directory",
        expect_directory=True,
    )
    config_path = canonical_path(arguments.config, "training config")
    contract_path = canonical_path(arguments.contract, "contract")
    export_report_path = canonical_path(
        arguments.export_report or candidate_dir / "export-report.json",
        "export report",
    )
    output_path = safe_output_path(
        arguments.output or candidate_dir / PREDICTIONS_NAME,
        candidate_dir,
        "rare-scalar predictions",
    )
    report_path = safe_output_path(
        arguments.report or candidate_dir / GENERATION_REPORT_NAME,
        candidate_dir,
        "rare-scalar generation report",
    )
    if output_path == report_path:
        raise RareScalarGenerationError(
            "Prediction and generation-report paths must differ."
        )
    validate_output_destinations(
        candidate_dir,
        output_path,
        report_path,
    )

    trainer = load_trainer()
    trainer_args = trainer.parse_args(
        [
            "--config",
            str(config_path),
            "--out-dir",
            str(candidate_dir),
            "--skip-train",
        ]
    )
    paths = {
        "candidate directory": candidate_dir,
        "export report": export_report_path,
        "contract": contract_path,
        "dataset manifest": trainer_args.dataset_manifest,
        "checkpoint": trainer.checkpoint_path(trainer_args),
        "training report": trainer.training_report_path(trainer_args),
        "manifest": trainer_args.manifest,
        "vocabulary": trainer_args.vocab_metadata,
        "compiled model": trainer_args.compiled_model,
        "Core ML package": trainer.mlpackage_path(trainer_args),
    }
    export_report, export_report_sha256 = read_json_evidence(
        export_report_path,
        "export report",
    )
    contract, contract_sha256 = read_json_evidence(
        contract_path,
        "rare-scalar contract",
    )
    file_hashes = validate_export_binding(
        trainer=trainer,
        trainer_args=trainer_args,
        export_report=export_report,
        contract=contract,
        parsed_json_hashes={
            "export report": export_report_sha256,
            "contract": contract_sha256,
        },
        paths=paths,
    )
    initial_hashes = dict(file_hashes)

    try:
        loaded = trainer.load_checkpoint(trainer_args)
        checkpoint = loaded["checkpoint"]
        if (
            checkpoint.get("datasetManifestSha256")
            != contract["dataset"]["manifestSha256"]
            or checkpoint.get("trainingRunId")
            != export_report["trainingRunId"]
            or checkpoint.get("vocabMetadataSha256")
            != file_hashes["vocabulary"]
        ):
            raise RareScalarGenerationError(
                "Checkpoint identity does not match rare-scalar/export evidence."
            )
        backend, coreml_validation = (
            trainer.load_verified_compiled_ctc_coreml(
                loaded["model"],
                checkpoint,
                trainer_args,
                package_path=paths["Core ML package"],
                compiled_path=paths["compiled model"],
                expected_package_sha256=file_hashes["Core ML package"],
                expected_compiled_sha256=file_hashes["compiled model"],
            )
        )
        rows = build_prediction_rows(
            contract,
            lambda text: finite_path_candidates(
                trainer.decode_compiled_ctc_candidates(
                    backend,
                    text,
                    checkpoint,
                    trainer_args,
                ),
                trainer_args.output_time_steps,
            ),
        )
        predictions_bytes = "".join(
            json.dumps(
                row,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
            for row in rows
        ).encode("utf-8")
        atomic_write(output_path, predictions_bytes)
        predictions_sha256 = sha256_file(output_path)

        current_export_report, current_export_report_sha256 = (
            read_json_evidence(
                export_report_path,
                "export report",
            )
        )
        current_contract, current_contract_sha256 = read_json_evidence(
            contract_path,
            "rare-scalar contract",
        )
        current_hashes = validate_export_binding(
            trainer=trainer,
            trainer_args=trainer_args,
            export_report=current_export_report,
            contract=current_contract,
            parsed_json_hashes={
                "export report": current_export_report_sha256,
                "contract": current_contract_sha256,
            },
            paths=paths,
        )
        if current_hashes != initial_hashes:
            raise RareScalarGenerationError(
                "Candidate evidence changed during rare-scalar inference."
            )

        report = {
            "schemaVersion": 1,
            "status": "passed-neural-rare-scalar-prediction-generation",
            "modelId": MODEL_ID,
            "trainingRunId": export_report["trainingRunId"],
            "exportRunId": export_report["exportRunId"],
            "productionEligible": False,
            "predictionsBackend": "coreml-compiled-transformer-ctc",
            "finitePathDecoderPolicy": CTC_FINITE_PATH_DECODER_POLICY,
            "contract": {
                "path": portable(contract_path),
                "sha256": file_hashes["contract"],
                "datasetManifestSha256": contract["dataset"][
                    "manifestSha256"
                ],
                "datasetContentSha256": contract["dataset"]["contentSha256"],
                "ctcAuditSha256": contract["ctcAudit"]["sha256"],
            },
            "candidate": {
                "exportReport": portable(export_report_path),
                "exportReportSha256": file_hashes["export report"],
                "manifest": portable(paths["manifest"]),
                "manifestSha256": file_hashes["manifest"],
                "checkpoint": portable(paths["checkpoint"]),
                "checkpointSha256": file_hashes["checkpoint"],
                "vocabulary": portable(paths["vocabulary"]),
                "vocabularySha256": file_hashes["vocabulary"],
                "mlpackage": portable(paths["Core ML package"]),
                "mlpackageSha256": file_hashes["Core ML package"],
                "compiledModel": portable(paths["compiled model"]),
                "compiledModelSha256": file_hashes["compiled model"],
            },
            "coremlValidation": coreml_validation,
            "predictions": {
                "path": portable(output_path),
                "sha256": predictions_sha256,
                "rows": len(rows),
            },
        }
        atomic_write(
            report_path,
            (
                json.dumps(report, ensure_ascii=False, indent=2)
                + "\n"
            ).encode("utf-8"),
        )
        return {
            "status": report["status"],
            "report": portable(report_path),
            "predictions": portable(output_path),
            "predictionRows": len(rows),
            "predictionsSha256": predictions_sha256,
            "compiledModelSha256": file_hashes["compiled model"],
        }
    finally:
        trainer.cleanup_run_input_snapshot(trainer_args)


def load_trainer() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "lekh_ctc_trainer_for_rare_scalar_evidence",
        TRAINER_PATH,
    )
    if spec is None or spec.loader is None:
        raise RareScalarGenerationError(
            "Unable to import the authenticated CTC trainer."
        )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def read_json_evidence(
    path: Path,
    label: str,
) -> tuple[dict[str, Any], str]:
    with open_stable_regular_binary(path, label) as handle:
        metadata = os.fstat(handle.fileno())
        if metadata.st_size <= 0 or metadata.st_size > MAX_JSON_BYTES:
            raise RareScalarGenerationError(
                f"{label} size is outside the accepted evidence bound."
            )
        payload = handle.read(MAX_JSON_BYTES + 1)
    if len(payload) > MAX_JSON_BYTES:
        raise RareScalarGenerationError(
            f"{label} size is outside the accepted evidence bound."
        )
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RareScalarGenerationError(
            f"{label} is not strict UTF-8 JSON."
        ) from error
    if not isinstance(value, dict):
        raise RareScalarGenerationError(f"{label} must be a JSON object.")
    return value, hashlib.sha256(payload).hexdigest()


def canonical_path(
    value: Path,
    label: str,
    *,
    expect_directory: bool = False,
) -> Path:
    raw_path = value if value.is_absolute() else ROOT / value
    path = Path(os.path.abspath(os.fspath(raw_path)))
    ensure_within(ROOT, path, label)
    ensure_real_directory_chain(ROOT, path.parent, label)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise RareScalarGenerationError(f"{label} is missing: {path}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise RareScalarGenerationError(f"{label} must not be a symlink.")
    if expect_directory:
        if not stat.S_ISDIR(metadata.st_mode):
            raise RareScalarGenerationError(f"{label} must be a directory.")
    elif not stat.S_ISREG(metadata.st_mode):
        raise RareScalarGenerationError(f"{label} must be a regular file.")
    return path


def safe_output_path(value: Path, parent: Path, label: str) -> Path:
    trusted_parent = parent.resolve()
    raw_path = value if value.is_absolute() else ROOT / value
    path = Path(os.path.abspath(os.fspath(raw_path)))
    ensure_within(trusted_parent, path, label)
    ensure_real_directory_chain(trusted_parent, path.parent, label)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        metadata = None
    except OSError as error:
        raise RareScalarGenerationError(
            f"{label} destination cannot be inspected."
        ) from error
    if metadata is not None and stat.S_ISLNK(metadata.st_mode):
        raise RareScalarGenerationError(f"{label} must not be a symlink.")
    if metadata is not None and not stat.S_ISREG(metadata.st_mode):
        raise RareScalarGenerationError(
            f"{label} must be absent or a regular file."
        )
    return path


def ensure_real_directory_chain(
    trusted_parent: Path,
    directory: Path,
    label: str,
) -> None:
    try:
        relative_directory = directory.relative_to(trusted_parent)
    except ValueError as error:
        raise RareScalarGenerationError(
            f"{label} parent escapes its trusted directory."
        ) from error
    current = trusted_parent
    for component in relative_directory.parts:
        current /= component
        try:
            metadata = current.lstat()
        except OSError as error:
            raise RareScalarGenerationError(
                f"{label} parent must be a real existing directory."
            ) from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(
            metadata.st_mode
        ):
            raise RareScalarGenerationError(
                f"{label} parent must not contain symlinks."
            )


def ensure_within(parent: Path, child: Path, label: str) -> None:
    try:
        child.relative_to(parent.resolve())
    except ValueError as error:
        raise RareScalarGenerationError(
            f"{label} escapes its trusted parent."
        ) from error


def validate_output_destinations(
    candidate_dir: Path,
    output_path: Path,
    report_path: Path,
) -> None:
    destinations = (
        (
            "rare-scalar predictions",
            output_path,
            candidate_dir / PREDICTIONS_NAME,
            candidate_dir / GENERATION_REPORT_NAME,
        ),
        (
            "rare-scalar generation report",
            report_path,
            candidate_dir / GENERATION_REPORT_NAME,
            candidate_dir / PREDICTIONS_NAME,
        ),
    )
    for label, path, canonical, other_canonical in destinations:
        if path.parent != candidate_dir:
            raise RareScalarGenerationError(
                f"{label} must be a direct candidate-directory child."
            )
        if path == other_canonical:
            raise RareScalarGenerationError(
                f"{label} must not use the other evidence filename."
            )
        if path.exists() and path != canonical:
            raise RareScalarGenerationError(
                f"{label} must not overwrite an existing candidate file."
            )


@contextmanager
def open_stable_regular_binary(
    path: Path,
    label: str,
) -> Iterator[BinaryIO]:
    path = canonical_path(path, label)
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    file_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    directory_descriptor: int | None = None
    file_descriptor: int | None = None
    handle: BinaryIO | None = None
    try:
        parent_before = path.parent.lstat()
        directory_descriptor = os.open(path.parent, directory_flags)
        parent_opened = os.fstat(directory_descriptor)
        if (
            not stat.S_ISDIR(parent_before.st_mode)
            or not stat.S_ISDIR(parent_opened.st_mode)
            or directory_identity(parent_before)
            != directory_identity(parent_opened)
        ):
            raise RareScalarGenerationError(
                f"{label} parent changed before it could be opened."
            )
        file_before = os.stat(
            path.name,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
        if (
            stat.S_ISLNK(file_before.st_mode)
            or not stat.S_ISREG(file_before.st_mode)
        ):
            raise RareScalarGenerationError(
                f"{label} must be a regular non-symlink file."
            )
        file_descriptor = os.open(
            path.name,
            file_flags,
            dir_fd=directory_descriptor,
        )
        file_opened = os.fstat(file_descriptor)
        if file_version(file_before) != file_version(file_opened):
            raise RareScalarGenerationError(
                f"{label} changed before it could be opened."
            )
        handle = os.fdopen(file_descriptor, "rb")
        file_descriptor = None
        yield handle

        file_after = os.fstat(handle.fileno())
        file_current = os.stat(
            path.name,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
        parent_after = os.fstat(directory_descriptor)
        parent_current = path.parent.lstat()
        if (
            file_version(file_opened) != file_version(file_after)
            or file_version(file_opened) != file_version(file_current)
            or directory_identity(parent_opened)
            != directory_identity(parent_after)
            or directory_identity(parent_opened)
            != directory_identity(parent_current)
        ):
            raise RareScalarGenerationError(
                f"{label} changed while it was read."
            )
    except OSError as error:
        raise RareScalarGenerationError(
            f"{label} could not be read as stable evidence."
        ) from error
    finally:
        if handle is not None:
            handle.close()
        if file_descriptor is not None:
            os.close(file_descriptor)
        if directory_descriptor is not None:
            os.close(directory_descriptor)


def directory_identity(metadata: os.stat_result) -> tuple[int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
    )


def file_version(
    metadata: os.stat_result,
) -> tuple[int, int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        stat.S_IFMT(metadata.st_mode),
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def sha256_file(path: Path, label: str = "evidence file") -> str:
    digest = hashlib.sha256()
    with open_stable_regular_binary(path, label) as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, contents: bytes) -> None:
    directory_flags = os.O_RDONLY
    directory_flags |= getattr(os, "O_DIRECTORY", 0)
    directory_flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_descriptor = os.open(path.parent, directory_flags)
    except OSError as error:
        raise RareScalarGenerationError(
            "Evidence output parent cannot be opened safely."
        ) from error
    temporary_name: str | None = None
    file_descriptor: int | None = None
    try:
        opened_parent = os.fstat(directory_descriptor)
        current_parent = os.stat(path.parent, follow_symlinks=False)
        if (
            not stat.S_ISDIR(opened_parent.st_mode)
            or opened_parent.st_dev != current_parent.st_dev
            or opened_parent.st_ino != current_parent.st_ino
        ):
            raise RareScalarGenerationError(
                "Evidence output parent changed during publication."
            )
        validate_atomic_destination(
            directory_descriptor,
            path.name,
        )
        for _attempt in range(32):
            candidate = (
                f".{path.name}.{secrets.token_hex(16)}.tmp"
            )
            try:
                file_descriptor = os.open(
                    candidate,
                    os.O_WRONLY
                    | os.O_CREAT
                    | os.O_EXCL
                    | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                    dir_fd=directory_descriptor,
                )
            except FileExistsError:
                continue
            temporary_name = candidate
            break
        if temporary_name is None:
            raise RareScalarGenerationError(
                "Unable to allocate a unique evidence staging file."
            )
        os.fchmod(file_descriptor, 0o600)
        handle = os.fdopen(file_descriptor, "wb")
        file_descriptor = None
        with handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        validate_atomic_destination(
            directory_descriptor,
            path.name,
        )
        os.replace(
            temporary_name,
            path.name,
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
        temporary_name = None
        os.fsync(directory_descriptor)
    except OSError as error:
        raise RareScalarGenerationError(
            "Evidence output could not be published atomically."
        ) from error
    finally:
        if file_descriptor is not None:
            try:
                os.close(file_descriptor)
            except OSError:
                pass
        if temporary_name is not None:
            try:
                os.unlink(
                    temporary_name,
                    dir_fd=directory_descriptor,
                )
            except OSError:
                pass
        try:
            os.close(directory_descriptor)
        except OSError:
            pass


def validate_atomic_destination(
    directory_descriptor: int,
    name: str,
) -> None:
    if not name or name in {".", ".."} or "/" in name:
        raise RareScalarGenerationError(
            "Evidence output filename is invalid."
        )
    try:
        metadata = os.stat(
            name,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        return
    if stat.S_ISLNK(metadata.st_mode):
        raise RareScalarGenerationError(
            "Evidence output destination must not be a symlink."
        )
    if not stat.S_ISREG(metadata.st_mode):
        raise RareScalarGenerationError(
            "Evidence output destination must be absent or a regular file."
        )


def portable(path: Path) -> str:
    ensure_within(ROOT, path.resolve(), "reported path")
    return path.resolve().relative_to(ROOT).as_posix()


def main() -> None:
    try:
        result = run(parse_args())
    except RareScalarGenerationError as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
