#!/usr/bin/env python3
"""Refresh Colab UX without changing an authenticated training bundle."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_notebook import (  # noqa: E402
    build_colab_notebook,
    notebook_bytes,
)


SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ResumeNotebookError(RuntimeError):
    """The source sidecars cannot safely produce a refreshed notebook."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build an updated Drive-first Colab notebook while preserving the "
            "bundle archive, bundle identity, and verifier embedded in an "
            "authenticated original notebook."
        )
    )
    parser.add_argument("--bundle-report", type=Path, required=True)
    parser.add_argument("--source-notebook", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_regular_bytes(path: Path, label: str) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise ResumeNotebookError(f"{label} is not a regular file: {path}")
    return path.read_bytes()


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    payload = read_regular_bytes(path, label)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ResumeNotebookError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ResumeNotebookError(f"{label} must contain one JSON object.")
    return value


def require_digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        raise ResumeNotebookError(f"{label} must be a lowercase SHA-256.")
    return value


def embedded_verifier_source(notebook: dict[str, Any]) -> str:
    if notebook.get("nbformat") != 4 or not isinstance(
        notebook.get("cells"),
        list,
    ):
        raise ResumeNotebookError("Source notebook structure is unsupported.")
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
            raise ResumeNotebookError(
                f"Source notebook code cell {index} is invalid Python."
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
                    raise ResumeNotebookError(
                        "Embedded verifier assignment is not a string literal."
                    ) from error
                if not isinstance(value, str) or not value.strip():
                    raise ResumeNotebookError(
                        "Embedded verifier source is empty or not text."
                    )
                assignments.append(value)
    if len(assignments) != 1:
        raise ResumeNotebookError(
            "Source notebook must contain exactly one embedded verifier."
        )
    return assignments[0]


def validate_sidecars(
    report: dict[str, Any],
    *,
    archive: Path,
    source_notebook: Path,
) -> dict[str, Any]:
    required = {
        "archive",
        "archiveBytes",
        "archiveSha256",
        "bundleId",
        "modelId",
        "notebook",
        "notebookBytes",
        "notebookSha256",
        "schemaVersion",
        "status",
        "trainingConfig",
    }
    if not required.issubset(report):
        raise ResumeNotebookError("Bundle report lacks required identity fields.")
    if (
        report["schemaVersion"] != 1
        or report["status"] != "passed-closed-archive-build"
        or type(report["archiveBytes"]) is not int
        or report["archiveBytes"] < 1
        or type(report["notebookBytes"]) is not int
        or report["notebookBytes"] < 1
        or not isinstance(report["archive"], str)
        or not report["archive"]
        or not isinstance(report["modelId"], str)
        or not report["modelId"]
        or not isinstance(report["notebook"], str)
        or not report["notebook"]
        or not isinstance(report["trainingConfig"], str)
        or not report["trainingConfig"]
    ):
        raise ResumeNotebookError("Bundle report identity fields are malformed.")
    archive_sha256 = require_digest(
        report["archiveSha256"],
        "Bundle archive digest",
    )
    bundle_id = require_digest(report["bundleId"], "Bundle identity")
    notebook_sha256 = require_digest(
        report["notebookSha256"],
        "Source notebook digest",
    )
    if archive.is_symlink() or not archive.is_file():
        raise ResumeNotebookError(
            f"Bundle archive is not a regular file: {archive}"
        )
    source_bytes = read_regular_bytes(source_notebook, "Source notebook")
    if (
        archive.stat().st_size != report["archiveBytes"]
        or sha256_file(archive) != archive_sha256
    ):
        raise ResumeNotebookError("Bundle archive differs from its report.")
    if (
        len(source_bytes) != report["notebookBytes"]
        or hashlib.sha256(source_bytes).hexdigest() != notebook_sha256
    ):
        raise ResumeNotebookError("Source notebook differs from its report.")
    return {
        "archive": str(archive),
        "archiveBytes": report["archiveBytes"],
        "archiveSha256": archive_sha256,
        "bundleId": bundle_id,
        "manifest": {
            "modelId": report["modelId"],
            "trainingConfig": report["trainingConfig"],
        },
    }


def write_bytes_once(path: Path, payload: bytes) -> None:
    if path.is_symlink():
        raise ResumeNotebookError(
            f"Refreshed notebook target is a symbolic link: {path}"
        )
    if path.exists():
        if not path.is_file() or path.read_bytes() != payload:
            raise ResumeNotebookError(
                f"Refreshed notebook target already has different bytes: {path}"
            )
        return
    if not path.parent.is_dir() or path.parent.is_symlink():
        raise ResumeNotebookError(
            f"Refreshed notebook parent is unsafe: {path.parent}"
        )
    staging = path.with_name(
        f".{path.name}.staging.{os.getpid()}.{uuid.uuid4().hex}"
    )
    try:
        with staging.open("xb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def refresh_notebook(
    *,
    report_path: Path,
    source_notebook: Path | None,
    archive: Path | None,
    output: Path,
) -> dict[str, Any]:
    report = read_json_object(report_path, "Bundle report")
    resolved_source = source_notebook or Path(str(report.get("notebook", "")))
    resolved_archive = archive or Path(str(report.get("archive", "")))
    if output == resolved_source:
        raise ResumeNotebookError(
            "Refreshed notebook must not overwrite its authenticated source."
        )
    bundle_report = validate_sidecars(
        report,
        archive=resolved_archive,
        source_notebook=resolved_source,
    )
    source_document = read_json_object(
        resolved_source,
        "Source notebook",
    )
    verifier_source = embedded_verifier_source(source_document)
    refreshed = notebook_bytes(
        build_colab_notebook(
            bundle_report,
            verifier_module_source=verifier_source,
        )
    )
    write_bytes_once(output, refreshed)
    return {
        "schemaVersion": 1,
        "status": "passed-neural-resume-notebook-refresh",
        "bundleId": bundle_report["bundleId"],
        "archiveSha256": bundle_report["archiveSha256"],
        "sourceNotebook": str(resolved_source),
        "sourceNotebookSha256": report["notebookSha256"],
        "output": str(output),
        "outputSha256": hashlib.sha256(refreshed).hexdigest(),
        "outputBytes": len(refreshed),
        "verifierSourceSha256": hashlib.sha256(
            verifier_source.encode("utf-8")
        ).hexdigest(),
    }


def main() -> int:
    args = parse_args()
    try:
        result = refresh_notebook(
            report_path=args.bundle_report,
            source_notebook=args.source_notebook,
            archive=args.archive,
            output=args.output,
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ResumeNotebookError) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-resume-notebook-refresh",
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
