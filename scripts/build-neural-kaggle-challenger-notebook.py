#!/usr/bin/env python3
"""Build the exact seed-43 challenger notebook from the active CTC bundle."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

BASE_PATH = Path(__file__).with_name("build-neural-kaggle-notebook.py")
BASE_SPEC = importlib.util.spec_from_file_location(
    "lekh_base_kaggle_notebook_builder",
    BASE_PATH,
)
if BASE_SPEC is None or BASE_SPEC.loader is None:
    raise RuntimeError(f"Unable to load base Kaggle builder: {BASE_PATH}")
BASE = importlib.util.module_from_spec(BASE_SPEC)
BASE_SPEC.loader.exec_module(BASE)

from scripts.lib.neural_remote_candidate_profile import (  # noqa: E402
    CHALLENGER_SEED,
    CTC_MODEL_ID,
    CandidateProfileError,
    SEED_43_PROFILE,
    candidate_relative_path,
    require_profile_bundle_identity,
)
from scripts.lib.neural_remote_kaggle_challenger_notebook import (  # noqa: E402
    build_kaggle_challenger_notebook,
    notebook_bytes,
)


CHALLENGER_SUPPORT_PATHS = frozenset({
    "package.json",
    "scripts/build-neural-kaggle-challenger-notebook.py",
    "scripts/build-neural-kaggle-challenger-notebook.test.py",
    "scripts/export-neural-remote-training-result.py",
    "scripts/import-neural-remote-training-result.py",
    "scripts/lib/neural_remote_candidate_profile.py",
    "scripts/lib/neural_remote_candidate_profile.test.py",
    "scripts/lib/neural_remote_kaggle_challenger_notebook.py",
    "scripts/lib/neural_remote_kaggle_challenger_notebook.test.py",
    "scripts/neural-remote-seed-43-integration.test.py",
    "docs/neural/CTC_SEED_43_CHALLENGER_RUNBOOK.md",
})


class ChallengerNotebookBuildError(RuntimeError):
    """The authenticated active bundle cannot produce the challenger."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Authenticate the exact active CTC bundle and render a fresh "
            "seed-43 Kaggle challenger with isolated output and recovery."
        )
    )
    parser.add_argument("--bundle-report", type=Path, required=True)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--source-notebook", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def assert_frozen_inventory_disjoint(
    manifest: dict[str, Any],
) -> None:
    files = manifest.get("files")
    if not isinstance(files, list):
        raise ChallengerNotebookBuildError(
            "Authenticated bundle file inventory is missing."
        )
    frozen_paths: set[str] = set()
    for entry in files:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
        ):
            raise ChallengerNotebookBuildError(
                "Authenticated bundle file inventory is malformed."
            )
        frozen_paths.add(entry["path"])
    overlap = sorted(frozen_paths.intersection(CHALLENGER_SUPPORT_PATHS))
    if overlap:
        raise ChallengerNotebookBuildError(
            "Challenger support overlaps authenticated bundle files: "
            + ", ".join(overlap)
        )


def build_notebook(
    *,
    report_path: Path,
    archive: Path | None,
    source_notebook: Path | None,
    output: Path,
) -> dict[str, Any]:
    report = BASE.read_json_object(
        report_path,
        "Trusted active bundle report",
    )
    require_profile_bundle_identity(SEED_43_PROFILE, report)
    resolved_archive = archive or Path(str(report.get("archive", "")))
    resolved_source = source_notebook or Path(
        str(report.get("notebook", ""))
    )
    notebook_report, verifier_source, verification = (
        BASE.validate_trusted_inputs(
            report,
            archive=resolved_archive,
            source_notebook=resolved_source,
        )
    )
    manifest = verification.get("manifest")
    if not isinstance(manifest, dict):
        raise ChallengerNotebookBuildError(
            "Authenticated closed bundle returned no manifest."
        )
    assert_frozen_inventory_disjoint(manifest)
    payload = notebook_bytes(
        build_kaggle_challenger_notebook(
            notebook_report,
            verifier_module_source=verifier_source,
        )
    )
    BASE.write_bytes_once(output, payload)
    return {
        "schemaVersion": 1,
        "status": "passed-neural-kaggle-challenger-notebook-build",
        "bundleId": notebook_report["bundleId"],
        "archive": notebook_report["archive"],
        "archiveSha256": notebook_report["archiveSha256"],
        "manifestSha256": verification["manifestSha256"],
        "modelId": CTC_MODEL_ID,
        "candidateProfile": SEED_43_PROFILE.profile_id,
        "candidatePrefix": candidate_relative_path(
            SEED_43_PROFILE,
            CTC_MODEL_ID,
        ),
        "configuredSeed": 42,
        "effectiveSeed": CHALLENGER_SEED,
        "sourceNotebook": resolved_source.name,
        "sourceNotebookSha256": report["notebookSha256"],
        "verifierSourceSha256": BASE.sha256_bytes(
            verifier_source.encode("utf-8")
        ),
        "output": output.name,
        "outputSha256": BASE.sha256_bytes(payload),
        "outputBytes": len(payload),
    }


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
                BASE.canonical_json_bytes(result) + b"\n"
            ).decode("utf-8"),
            end="",
        )
        return 0
    except (
        ChallengerNotebookBuildError,
        CandidateProfileError,
        BASE.KaggleNotebookBuildError,
        BASE.NeuralRemoteArtifactError,
        OSError,
        ValueError,
    ) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": (
                        "failed-neural-kaggle-challenger-notebook-build"
                    ),
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
