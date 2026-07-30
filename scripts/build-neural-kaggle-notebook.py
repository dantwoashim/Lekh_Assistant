#!/usr/bin/env python3
"""Build a Kaggle notebook from an exact trusted remote-training bundle."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    BUNDLE_KIND,
    NeuralRemoteArtifactError,
    canonical_json_bytes,
    safe_relative_path,
    trainer_path_for_config,
    verify_closed_archive,
)
from scripts.lib.neural_remote_kaggle_notebook import (  # noqa: E402
    build_kaggle_notebook,
    notebook_bytes,
)


SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERIFIER_PATH = "scripts/lib/neural_remote_artifacts.py"
MAX_JSON_BYTES = 4 * 1024 * 1024


class KaggleNotebookBuildError(RuntimeError):
    """Trusted sidecars cannot produce the requested Kaggle notebook."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Authenticate an existing exact CUDA bundle and its trusted "
            "bundle report, then create a deterministic fresh-run Kaggle "
            "notebook with no cross-provider recovery import."
        )
    )
    parser.add_argument("--bundle-report", type=Path, required=True)
    parser.add_argument(
        "--archive",
        type=Path,
        help="Override the archive path recorded in the trusted report.",
    )
    parser.add_argument(
        "--source-notebook",
        type=Path,
        help=(
            "Override the original notebook path recorded in the report. "
            "Its exact report-pinned bytes supply the authenticated verifier."
        ),
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def read_regular_bytes(
    path: Path,
    label: str,
    *,
    maximum_bytes: int | None = None,
) -> bytes:
    requested = path.absolute()
    try:
        metadata = requested.lstat()
    except FileNotFoundError as error:
        raise KaggleNotebookBuildError(f"{label} is missing: {path}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise KaggleNotebookBuildError(
            f"{label} must be a regular non-symlink file: {path}"
        )
    if maximum_bytes is not None and metadata.st_size > maximum_bytes:
        raise KaggleNotebookBuildError(f"{label} is unexpectedly large.")
    descriptor = os.open(
        requested,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != metadata.st_dev
            or opened.st_ino != metadata.st_ino
        ):
            raise KaggleNotebookBuildError(
                f"{label} changed before it could be opened."
            )
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            payload = source.read()
        after_open = os.fstat(descriptor)
        after_path = requested.lstat()
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
        if any(
            getattr(after_open, field) != getattr(opened, field)
            or getattr(after_path, field) != getattr(opened, field)
            for field in fields
        ):
            raise KaggleNotebookBuildError(
                f"{label} changed while it was read."
            )
        return payload
    finally:
        os.close(descriptor)


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    payload = read_regular_bytes(
        path,
        label,
        maximum_bytes=MAX_JSON_BYTES,
    )
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KaggleNotebookBuildError(
            f"{label} is not valid UTF-8 JSON."
        ) from error
    if not isinstance(value, dict):
        raise KaggleNotebookBuildError(f"{label} must contain one object.")
    return value


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        raise KaggleNotebookBuildError(
            f"{label} must be a lowercase SHA-256."
        )
    return value


def embedded_verifier_source(notebook: dict[str, Any]) -> str:
    if notebook.get("nbformat") != 4 or not isinstance(
        notebook.get("cells"),
        list,
    ):
        raise KaggleNotebookBuildError(
            "Authenticated source notebook structure is unsupported."
        )
    assignments: list[str] = []
    for index, cell in enumerate(notebook["cells"]):
        if (
            not isinstance(cell, dict)
            or cell.get("cell_type") != "code"
            or not isinstance(cell.get("source"), list)
            or not all(isinstance(line, str) for line in cell["source"])
        ):
            continue
        source = "".join(cell["source"])
        try:
            module = ast.parse(source, filename=f"notebook-cell-{index}")
        except SyntaxError as error:
            raise KaggleNotebookBuildError(
                f"Authenticated source notebook cell {index} is invalid."
            ) from error
        for statement in module.body:
            if (
                isinstance(statement, ast.Assign)
                and len(statement.targets) == 1
                and isinstance(statement.targets[0], ast.Name)
                and statement.targets[0].id == "VERIFIER_MODULE_SOURCE"
            ):
                try:
                    value = ast.literal_eval(statement.value)
                except (ValueError, TypeError, SyntaxError) as error:
                    raise KaggleNotebookBuildError(
                        "Embedded verifier must be one string literal."
                    ) from error
                if not isinstance(value, str) or not value.strip():
                    raise KaggleNotebookBuildError(
                        "Embedded verifier source is empty."
                    )
                assignments.append(value)
    if len(assignments) != 1:
        raise KaggleNotebookBuildError(
            "Authenticated source notebook must contain exactly one "
            "embedded verifier."
        )
    return assignments[0]


def validate_trusted_inputs(
    report: dict[str, Any],
    *,
    archive: Path,
    source_notebook: Path,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    required = {
        "archive",
        "archiveBytes",
        "archiveSha256",
        "artifactKind",
        "bundleId",
        "datasetContentSha256",
        "goldCorpusSha256",
        "manifestSha256",
        "modelId",
        "notebook",
        "notebookBytes",
        "notebookSha256",
        "officialBenchmarkCorpusSha256",
        "schemaVersion",
        "status",
        "trainerPath",
        "trainingConfig",
    }
    if not required.issubset(report):
        raise KaggleNotebookBuildError(
            "Trusted bundle report lacks required identity fields."
        )
    if (
        report.get("schemaVersion") != 1
        or report.get("status") != "passed-closed-archive-build"
        or report.get("artifactKind") != BUNDLE_KIND
        or type(report.get("archiveBytes")) is not int
        or report["archiveBytes"] < 1
        or type(report.get("notebookBytes")) is not int
        or report["notebookBytes"] < 1
        or not isinstance(report.get("modelId"), str)
        or not report["modelId"]
    ):
        raise KaggleNotebookBuildError(
            "Trusted bundle report identity fields are malformed."
        )
    archive_sha256 = require_sha256(
        report["archiveSha256"],
        "Bundle archive digest",
    )
    notebook_sha256 = require_sha256(
        report["notebookSha256"],
        "Authenticated notebook digest",
    )
    bundle_id = require_sha256(report["bundleId"], "Bundle identity")
    manifest_sha256 = require_sha256(
        report["manifestSha256"],
        "Bundle manifest digest",
    )
    for field in (
        "datasetContentSha256",
        "goldCorpusSha256",
        "officialBenchmarkCorpusSha256",
    ):
        require_sha256(report[field], f"Bundle report {field}")
    training_config = safe_relative_path(
        report.get("trainingConfig"),
        "bundle report training config",
    )
    expected_trainer = trainer_path_for_config(training_config)
    if report.get("trainerPath") != expected_trainer:
        raise KaggleNotebookBuildError(
            "Trusted report trainer differs from its training config."
        )

    archive_payload_metadata = archive.absolute().lstat()
    if (
        stat.S_ISLNK(archive_payload_metadata.st_mode)
        or not stat.S_ISREG(archive_payload_metadata.st_mode)
        or archive_payload_metadata.st_size != report["archiveBytes"]
    ):
        raise KaggleNotebookBuildError(
            "Bundle archive is unsafe or differs in byte count from its report."
        )
    verification = verify_closed_archive(
        archive.absolute(),
        expected_kind=BUNDLE_KIND,
        expected_archive_sha256=archive_sha256,
    )
    manifest = verification.get("manifest")
    if not isinstance(manifest, dict):
        raise KaggleNotebookBuildError(
            "Closed bundle verification returned no manifest."
        )
    if (
        verification.get("archiveBytes") != report["archiveBytes"]
        or verification.get("bundleId") != bundle_id
        or verification.get("manifestSha256") != manifest_sha256
        or manifest.get("bundleId") != bundle_id
        or manifest.get("modelId") != report["modelId"]
        or manifest.get("trainingConfig") != training_config
        or manifest.get("trainerPath") != expected_trainer
        or manifest.get("datasetContentSha256")
            != report["datasetContentSha256"]
        or manifest.get("goldCorpusSha256")
            != report["goldCorpusSha256"]
        or manifest.get("officialBenchmarkCorpusSha256")
            != report["officialBenchmarkCorpusSha256"]
    ):
        raise KaggleNotebookBuildError(
            "Closed bundle identity differs from its trusted report."
        )

    source_bytes = read_regular_bytes(
        source_notebook,
        "Authenticated source notebook",
        maximum_bytes=MAX_JSON_BYTES,
    )
    if (
        len(source_bytes) != report["notebookBytes"]
        or sha256_bytes(source_bytes) != notebook_sha256
    ):
        raise KaggleNotebookBuildError(
            "Authenticated source notebook differs from its report."
        )
    try:
        source_document = json.loads(source_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KaggleNotebookBuildError(
            "Authenticated source notebook is invalid JSON."
        ) from error
    if not isinstance(source_document, dict):
        raise KaggleNotebookBuildError(
            "Authenticated source notebook must be one object."
        )
    verifier_source = embedded_verifier_source(source_document)
    verifier_payload = verifier_source.encode("utf-8")
    verifier_entries = [
        entry
        for entry in manifest.get("files", [])
        if isinstance(entry, dict) and entry.get("path") == VERIFIER_PATH
    ]
    if (
        len(verifier_entries) != 1
        or verifier_entries[0].get("sha256")
            != sha256_bytes(verifier_payload)
        or verifier_entries[0].get("bytes") != len(verifier_payload)
    ):
        raise KaggleNotebookBuildError(
            "Embedded verifier differs from the verifier authenticated by "
            "the closed training bundle."
        )
    notebook_report = {
        "archive": archive.name,
        "archiveBytes": report["archiveBytes"],
        "archiveSha256": archive_sha256,
        "bundleId": bundle_id,
        "manifest": {
            "modelId": report["modelId"],
            "trainingConfig": training_config,
        },
    }
    return notebook_report, verifier_source, verification


def write_bytes_once(path: Path, payload: bytes) -> None:
    if path.is_symlink():
        raise KaggleNotebookBuildError(
            f"Kaggle notebook target is a symbolic link: {path}"
        )
    if path.exists():
        if not path.is_file() or path.read_bytes() != payload:
            raise KaggleNotebookBuildError(
                "Kaggle notebook target already contains different bytes."
            )
        return
    parent = path.parent.absolute()
    if not parent.is_dir() or parent.is_symlink():
        raise KaggleNotebookBuildError(
            f"Kaggle notebook parent is unsafe: {parent}"
        )
    staging = path.with_name(
        f".{path.name}.staging.{os.getpid()}.{uuid.uuid4().hex}"
    )
    try:
        descriptor = os.open(
            staging,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def build_notebook(
    *,
    report_path: Path,
    archive: Path | None,
    source_notebook: Path | None,
    output: Path,
) -> dict[str, Any]:
    report = read_json_object(report_path, "Trusted bundle report")
    resolved_archive = archive or Path(str(report.get("archive", "")))
    resolved_source = source_notebook or Path(str(report.get("notebook", "")))
    notebook_report, verifier_source, verification = validate_trusted_inputs(
        report,
        archive=resolved_archive,
        source_notebook=resolved_source,
    )
    payload = notebook_bytes(
        build_kaggle_notebook(
            notebook_report,
            verifier_module_source=verifier_source,
        )
    )
    write_bytes_once(output, payload)
    result = {
        "schemaVersion": 1,
        "status": "passed-neural-kaggle-notebook-build",
        "bundleId": notebook_report["bundleId"],
        "archive": notebook_report["archive"],
        "archiveSha256": notebook_report["archiveSha256"],
        "manifestSha256": verification["manifestSha256"],
        "sourceNotebook": resolved_source.name,
        "sourceNotebookSha256": report["notebookSha256"],
        "verifierSourceSha256": sha256_bytes(
            verifier_source.encode("utf-8")
        ),
        "output": output.name,
        "outputSha256": sha256_bytes(payload),
        "outputBytes": len(payload),
    }
    return result


def main() -> int:
    args = parse_args()
    try:
        result = build_notebook(
            report_path=args.bundle_report,
            archive=args.archive,
            source_notebook=args.source_notebook,
            output=args.output,
        )
        print(
            (
                canonical_json_bytes(result)
                + b"\n"
            ).decode("utf-8"),
            end="",
        )
        return 0
    except (
        KaggleNotebookBuildError,
        NeuralRemoteArtifactError,
        OSError,
        ValueError,
    ) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-kaggle-notebook-build",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
