#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check-neural-open-vocab-toolchain.py")
SPEC = importlib.util.spec_from_file_location("neural_toolchain_check", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class NeuralToolchainContractTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
