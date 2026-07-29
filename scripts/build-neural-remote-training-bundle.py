#!/usr/bin/env python3
"""Build a deterministic, closed-inventory Lekh CUDA training bundle."""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    BUNDLE_KIND,
    NeuralRemoteArtifactError,
    build_closed_archive,
    canonical_json_bytes,
    collect_training_bundle,
    sha256_bytes,
)
from scripts.lib.neural_remote_notebook import (  # noqa: E402
    build_colab_notebook,
    notebook_bytes,
)


DEFAULT_CONFIG = (
    "data/neural/training/open-vocab-bigru-attention-v1.config.json"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Package the exact trainer, config, generated dataset, locked "
            "gold suites, and official benchmark for remote CUDA training."
        )
    )
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / ".tmp/neural-remote-training",
    )
    parser.add_argument(
        "--compression-level",
        type=int,
        default=1,
        help="Single-threaded deterministic gzip level (default: 1).",
    )
    parser.add_argument(
        "--inventory-only",
        action="store_true",
        help="Validate references and report the planned files without hashing.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest_base, files = collect_training_bundle(ROOT, args.config)
        if args.inventory_only:
            print(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "status": "passed-neural-remote-bundle-inventory",
                        "artifactKind": BUNDLE_KIND,
                        "modelId": manifest_base["modelId"],
                        "config": manifest_base["trainingConfig"],
                        "fileCount": len(files),
                        "declaredBytes": sum(
                            item.source.stat().st_size for item in files
                        ),
                        "files": [
                            {
                                "path": item.archive_path,
                                "role": item.role,
                                "bytes": item.source.stat().st_size,
                            }
                            for item in files
                        ],
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0

        model_id = manifest_base["modelId"]
        report = build_closed_archive(
            source_root=ROOT,
            output_dir=args.output_dir,
            artifact_kind=BUNDLE_KIND,
            filename_stem=f"lekh-neural-{model_id}-cuda-training",
            manifest_base=manifest_base,
            files=files,
            compression_level=args.compression_level,
        )
        archive_path = Path(report["archive"])
        base_name = archive_path.name.removesuffix(".tar.gz")
        verifier_source = (
            ROOT / "scripts/lib/neural_remote_artifacts.py"
        ).read_text(encoding="utf-8")
        notebook = build_colab_notebook(
            report,
            verifier_module_source=verifier_source,
        )
        notebook_payload = notebook_bytes(notebook)
        notebook_path = archive_path.with_name(
            f"{base_name}-Colab.ipynb"
        )
        write_bytes_once(notebook_path, notebook_payload)
        report_path = archive_path.with_name(
            f"{base_name}.bundle-report.json"
        )
        sidecar = {
            key: value
            for key, value in report.items()
            if key != "manifest"
        }
        sidecar.update({
            "modelId": report["manifest"]["modelId"],
            "trainingConfig": report["manifest"]["trainingConfig"],
            "datasetContentSha256": report["manifest"][
                "datasetContentSha256"
            ],
            "goldCorpusSha256": report["manifest"]["goldCorpusSha256"],
            "officialBenchmarkCorpusSha256": report["manifest"][
                "officialBenchmarkCorpusSha256"
            ],
            "notebook": str(notebook_path),
            "notebookSha256": sha256_bytes(notebook_payload),
            "notebookBytes": len(notebook_payload),
        })
        write_json_once(report_path, sidecar)
        report["bundleReport"] = str(report_path)
        report["notebook"] = str(notebook_path)
        report["notebookSha256"] = sidecar["notebookSha256"]
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (NeuralRemoteArtifactError, OSError) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-remote-bundle-build",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


def write_json_once(path: Path, value: dict[str, object]) -> None:
    payload = canonical_json_bytes(value) + b"\n"
    write_bytes_once(path, payload)


def write_bytes_once(path: Path, payload: bytes) -> None:
    if path.exists() or path.is_symlink():
        if (
            path.is_symlink()
            or not path.is_file()
            or path.read_bytes() != payload
        ):
            raise NeuralRemoteArtifactError(
                f"Bundle report target already exists with different bytes: {path}"
            )
        return
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


if __name__ == "__main__":
    raise SystemExit(main())
