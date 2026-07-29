#!/usr/bin/env python3
"""Fail closed when neural publication runs under an unpinned Python toolchain."""

from __future__ import annotations

import argparse
import json
import platform
import sys
from importlib import import_module, metadata


EXPECTED_PYTHON = (3, 11)
LOCAL_COREML_PROFILE = "local-coreml"
REMOTE_CUDA_PROFILE = "linux-cuda-cu118"
REMOTE_PYTHON_VERSION = "3.11.15"
REMOTE_TORCH_VERSION = "2.7.0+cu118"
REMOTE_CUDA_VERSION = "11.8"
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
    profile: str = LOCAL_COREML_PROFILE,
) -> list[str]:
    failures: list[str] = []
    expected_distributions = distributions_for_profile(profile)
    if python_version != EXPECTED_PYTHON:
        failures.append(
            "Python must be exactly the pinned 3.11 major/minor line; "
            f"observed {python_version[0]}.{python_version[1]}."
        )
    for package, expected in expected_distributions.items():
        observed = package_versions.get(package)
        if observed != expected:
            failures.append(
                f"{package} must be exactly {expected}; observed "
                f"{observed or 'missing'}."
            )
    return failures


def distributions_for_profile(profile: str) -> dict[str, str]:
    expected = dict(EXPECTED_DISTRIBUTIONS)
    if profile == LOCAL_COREML_PROFILE:
        return expected
    if profile == REMOTE_CUDA_PROFILE:
        expected["torch"] = REMOTE_TORCH_VERSION
        return expected
    raise ValueError(f"Unsupported neural toolchain profile: {profile}")


def installed_versions(
    expected_distributions: dict[str, str],
) -> dict[str, str]:
    versions = {
        package: metadata.version(package)
        for package in expected_distributions
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


def validate_runtime_profile(profile: str) -> list[str]:
    torch_module = import_module("torch")
    if profile == LOCAL_COREML_PROFILE:
        return []
    if profile != REMOTE_CUDA_PROFILE:
        return [f"Unsupported neural toolchain profile: {profile}"]
    failures = []
    if platform.system() != "Linux":
        failures.append(
            "The remote CUDA toolchain profile requires Linux."
        )
    if platform.python_version() != REMOTE_PYTHON_VERSION:
        failures.append(
            "The remote CUDA toolchain requires Python "
            f"{REMOTE_PYTHON_VERSION}; observed "
            f"{platform.python_version()}."
        )
    if getattr(torch_module.version, "cuda", None) != REMOTE_CUDA_VERSION:
        failures.append(
            "The remote CUDA toolchain requires the pinned CUDA "
            f"{REMOTE_CUDA_VERSION} runtime; observed "
            f"{getattr(torch_module.version, 'cuda', None) or 'missing'}."
        )
    return failures


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile",
        choices=(LOCAL_COREML_PROFILE, REMOTE_CUDA_PROFILE),
        default=LOCAL_COREML_PROFILE,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    expected_distributions = distributions_for_profile(args.profile)
    try:
        versions = installed_versions(expected_distributions)
        failures = validate_toolchain(
            python_version=(sys.version_info.major, sys.version_info.minor),
            package_versions=versions,
            profile=args.profile,
        )
        failures.extend(validate_runtime_profile(args.profile))
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
        "profile": args.profile,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": versions,
        "expected": {
            "python": ".".join(str(value) for value in EXPECTED_PYTHON),
            "packages": expected_distributions,
        },
        "failures": failures,
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
