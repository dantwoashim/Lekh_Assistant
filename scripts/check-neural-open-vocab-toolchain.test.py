#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import re
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-neural-open-vocab-toolchain.py")
ROOT = SCRIPT.parent.parent
SPEC = importlib.util.spec_from_file_location("neural_toolchain_check", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


def normalized_versions(values: dict[str, str]) -> dict[str, str]:
    return {
        re.sub(r"[-_.]+", "-", name).lower(): version
        for name, version in values.items()
    }


def read_exact_lock(path: Path) -> dict[str, str]:
    result = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, version = line.partition("==")
        if not separator or not name or not version:
            raise AssertionError(f"Non-exact requirement in {path}: {line}")
        result[re.sub(r"[-_.]+", "-", name).lower()] = version
    return result


class NeuralToolchainContractTests(unittest.TestCase):
    def test_toolchain_profiles_exactly_match_committed_locks(self) -> None:
        local_lock = read_exact_lock(
            ROOT / "requirements/neural-open-vocab.lock"
        )
        cuda_lock = read_exact_lock(
            ROOT / "requirements/neural-open-vocab-cu118.lock"
        )
        self.assertEqual(
            local_lock,
            normalized_versions(CHECK.EXPECTED_DISTRIBUTIONS),
        )
        self.assertEqual(
            cuda_lock,
            normalized_versions(
                {
                    "torch": CHECK.REMOTE_TORCH_VERSION,
                    **CHECK.REMOTE_CUDA_DISTRIBUTIONS,
                }
            ),
        )

    def test_exact_pinned_versions_pass(self) -> None:
        self.assertEqual(
            CHECK.validate_toolchain(
                python_version=CHECK.EXPECTED_PYTHON,
                package_versions=dict(CHECK.EXPECTED_DISTRIBUTIONS),
            ),
            [],
        )

    def test_python_drift_fails(self) -> None:
        failures = CHECK.validate_toolchain(
            python_version=(3, 12),
            package_versions=dict(CHECK.EXPECTED_DISTRIBUTIONS),
        )
        self.assertTrue(any("Python must be exactly" in item for item in failures))

    def test_each_package_drift_fails(self) -> None:
        for package in CHECK.EXPECTED_DISTRIBUTIONS:
            with self.subTest(package=package):
                versions = dict(CHECK.EXPECTED_DISTRIBUTIONS)
                versions[package] = "0.0.0"
                failures = CHECK.validate_toolchain(
                    python_version=CHECK.EXPECTED_PYTHON,
                    package_versions=versions,
                )
                self.assertTrue(any(package in item for item in failures))

    def test_missing_package_fails(self) -> None:
        versions = dict(CHECK.EXPECTED_DISTRIBUTIONS)
        versions.pop("torch")
        failures = CHECK.validate_toolchain(
            python_version=CHECK.EXPECTED_PYTHON,
            package_versions=versions,
        )
        self.assertTrue(any("torch" in item and "missing" in item for item in failures))

    def test_remote_cuda_profile_requires_exact_cu118_wheel(self) -> None:
        versions = CHECK.distributions_for_profile(
            CHECK.REMOTE_CUDA_PROFILE
        )
        self.assertEqual(
            versions["torch"],
            CHECK.REMOTE_TORCH_VERSION,
        )
        self.assertEqual(
            CHECK.validate_toolchain(
                python_version=CHECK.EXPECTED_PYTHON,
                package_versions=versions,
                profile=CHECK.REMOTE_CUDA_PROFILE,
            ),
            [],
        )
        versions["torch"] = "2.7.0"
        failures = CHECK.validate_toolchain(
            python_version=CHECK.EXPECTED_PYTHON,
            package_versions=versions,
            profile=CHECK.REMOTE_CUDA_PROFILE,
        )
        self.assertTrue(
            any(CHECK.REMOTE_TORCH_VERSION in item for item in failures)
        )

    def test_remote_cuda_profile_requires_complete_runtime_closure(self) -> None:
        versions = CHECK.distributions_for_profile(
            CHECK.REMOTE_CUDA_PROFILE
        )
        self.assertEqual(
            {
                package: versions[package]
                for package in CHECK.REMOTE_CUDA_DISTRIBUTIONS
            },
            CHECK.REMOTE_CUDA_DISTRIBUTIONS,
        )
        for package in CHECK.REMOTE_CUDA_DISTRIBUTIONS:
            with self.subTest(package=package):
                drifted = dict(versions)
                drifted.pop(package)
                failures = CHECK.validate_toolchain(
                    python_version=CHECK.EXPECTED_PYTHON,
                    package_versions=drifted,
                    profile=CHECK.REMOTE_CUDA_PROFILE,
                )
                self.assertTrue(
                    any(
                        package in item and "missing" in item
                        for item in failures
                    )
                )


if __name__ == "__main__":
    unittest.main()
