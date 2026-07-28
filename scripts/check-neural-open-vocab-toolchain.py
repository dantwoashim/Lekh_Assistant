#!/usr/bin/env python3
"""Fail closed when neural publication runs under an unpinned Python toolchain."""

from __future__ import annotations

import json
import platform
import sys
from importlib import import_module, metadata


EXPECTED_PYTHON = (3, 11)
EXPECTED_DISTRIBUTIONS = {
    "attrs": "26.1.0",
    "cattrs": "26.1.0",
    "coremltools": "9.0",
    "filelock": "3.29.6",
    "fsspec": "2026.6.0",
    "Jinja2": "3.1.6",
    "MarkupSafe": "3.0.3",
    "mpmath": "1.3.0",
    "networkx": "3.6.1",
    "numpy": "1.26.4",
    "packaging": "26.2",
    "protobuf": "7.35.1",
    "pyaml": "26.7.0",
    "PyYAML": "6.0.3",
    "sympy": "1.14.0",
    "torch": "2.7.0",
    "tqdm": "4.68.4",
    "typing_extensions": "4.16.0",
}
RUNTIME_MODULES = ("coremltools", "numpy", "torch")


def validate_toolchain(
    *,
    python_version: tuple[int, int],
    package_versions: dict[str, str],
) -> list[str]:
    failures: list[str] = []
    if python_version != EXPECTED_PYTHON:
        failures.append(
            "Python must be exactly the pinned 3.11 major/minor line; "
            f"observed {python_version[0]}.{python_version[1]}."
        )
    for package, expected in EXPECTED_DISTRIBUTIONS.items():
        observed = package_versions.get(package)
        if observed != expected:
            failures.append(
                f"{package} must be exactly {expected}; observed "
                f"{observed or 'missing'}."
            )
    return failures


def installed_versions() -> dict[str, str]:
    versions = {
        package: metadata.version(package)
        for package in EXPECTED_DISTRIBUTIONS
    }
    for package in RUNTIME_MODULES:
        module = import_module(package)
        runtime_version = getattr(module, "__version__", None)
        if runtime_version != versions[package]:
            raise RuntimeError(
                f"{package} distribution/runtime version mismatch: "
                f"{versions[package]} versus {runtime_version or 'missing'}."
            )
    return versions


def main() -> int:
    try:
        versions = installed_versions()
        failures = validate_toolchain(
            python_version=(sys.version_info.major, sys.version_info.minor),
            package_versions=versions,
        )
    except Exception as error:  # pragma: no cover - exercised by the CLI
        versions = {}
        failures = [f"Neural toolchain import failed: {error}"]

    report = {
        "schemaVersion": 1,
        "status": (
            "passed-neural-open-vocab-toolchain"
            if not failures
            else "failed-neural-open-vocab-toolchain"
        ),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": versions,
        "expected": {
            "python": ".".join(str(value) for value in EXPECTED_PYTHON),
            "packages": EXPECTED_DISTRIBUTIONS,
        },
        "failures": failures,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
