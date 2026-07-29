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
import stat
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Iterable


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


def validate_export_binding(
    *,
    trainer: ModuleType,
    trainer_args: argparse.Namespace,
    export_report: dict[str, Any],
    contract: dict[str, Any],
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
        "export report": sha256_file(required_paths["export report"]),
        "contract": sha256_file(required_paths["contract"]),
        "dataset manifest": sha256_file(
            required_paths["dataset manifest"]
        ),
        "checkpoint": sha256_file(required_paths["checkpoint"]),
        "training report": sha256_file(required_paths["training report"]),
        "manifest": sha256_file(required_paths["manifest"]),
        "vocabulary": sha256_file(required_paths["vocabulary"]),
        "compiled model": trainer.directory_sha256(
            required_paths["compiled model"]
        ),
        "Core ML package": trainer.directory_sha256(
            required_paths["Core ML package"]
        ),
    }
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
    export_report = read_json_object(export_report_path, "export report")
    contract = read_json_object(contract_path, "rare-scalar contract")
    file_hashes = validate_export_binding(
        trainer=trainer,
        trainer_args=trainer_args,
        export_report=export_report,
        contract=contract,
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
            lambda text: trainer.decode_compiled_ctc_candidates(
                backend,
                text,
                checkpoint,
                trainer_args,
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

        current_hashes = validate_export_binding(
            trainer=trainer,
            trainer_args=trainer_args,
            export_report=read_json_object(
                export_report_path,
                "export report",
            ),
            contract=read_json_object(
                contract_path,
                "rare-scalar contract",
            ),
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


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    path = canonical_path(path, label)
    metadata = path.stat()
    if metadata.st_size <= 0 or metadata.st_size > MAX_JSON_BYTES:
        raise RareScalarGenerationError(
            f"{label} size is outside the accepted evidence bound."
        )
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RareScalarGenerationError(
            f"{label} is not strict UTF-8 JSON."
        ) from error
    if not isinstance(value, dict):
        raise RareScalarGenerationError(f"{label} must be a JSON object.")
    return value


def canonical_path(
    value: Path,
    label: str,
    *,
    expect_directory: bool = False,
) -> Path:
    path = value if value.is_absolute() else ROOT / value
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
    resolved = path.resolve()
    ensure_within(ROOT, resolved, label)
    return resolved


def safe_output_path(value: Path, parent: Path, label: str) -> Path:
    path = (value if value.is_absolute() else ROOT / value).resolve()
    ensure_within(parent, path, label)
    if path.exists() and path.is_symlink():
        raise RareScalarGenerationError(f"{label} must not be a symlink.")
    if not path.parent.is_dir() or path.parent.is_symlink():
        raise RareScalarGenerationError(
            f"{label} parent must be a real existing directory."
        )
    return path


def ensure_within(parent: Path, child: Path, label: str) -> None:
    try:
        child.relative_to(parent.resolve())
    except ValueError as error:
        raise RareScalarGenerationError(
            f"{label} escapes its trusted parent."
        ) from error


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(path: Path, contents: bytes) -> None:
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except BaseException:
        try:
            os.close(file_descriptor)
        except OSError:
            pass
        temporary.unlink(missing_ok=True)
        raise


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
