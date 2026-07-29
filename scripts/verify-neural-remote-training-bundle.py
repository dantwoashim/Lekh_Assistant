#!/usr/bin/env python3
"""Verify and optionally extract a closed Lekh remote-training archive."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.lib.neural_remote_artifacts import (  # noqa: E402
    BUNDLE_KIND,
    NeuralRemoteArtifactError,
    verify_closed_archive,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify the outer SHA-256, deterministic tar metadata, safe paths, "
            "and every file in a closed Lekh CUDA-training bundle."
        )
    )
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--expected-sha256",
        help="Trusted archive SHA-256 emitted by the local bundle builder.",
    )
    parser.add_argument(
        "--extract-to",
        type=Path,
        help="Atomically publish a verified extraction at this new path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = verify_closed_archive(
            args.archive,
            expected_kind=BUNDLE_KIND,
            expected_archive_sha256=args.expected_sha256,
            extract_to=args.extract_to,
        )
    except (NeuralRemoteArtifactError, OSError) as error:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "failed-neural-remote-bundle-verification",
                    "error": str(error),
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
