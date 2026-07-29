#!/usr/bin/env python3
"""Generate a bundle-specific, checksum-pinned Google Colab notebook."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


UV_VERSION = "0.11.8"
PYTHON_VERSION = "3.11.15"


def build_colab_notebook(
    bundle_report: dict[str, Any],
    *,
    verifier_module_source: str,
) -> dict[str, Any]:
    manifest = bundle_report["manifest"]
    archive_name = Path(bundle_report["archive"]).name
    constants = {
        "EXPECTED_ARCHIVE_NAME": archive_name,
        "EXPECTED_ARCHIVE_SHA256": bundle_report["archiveSha256"],
        "EXPECTED_ARCHIVE_BYTES": bundle_report["archiveBytes"],
        "EXPECTED_BUNDLE_ID": bundle_report["bundleId"],
        "EXPECTED_MODEL_ID": manifest["modelId"],
        "EXPECTED_CONFIG": manifest["trainingConfig"],
        "EXPECTED_CANDIDATE_PREFIX": (
            "data/generated/neural-open-vocab-model/"
            f"{manifest['modelId']}"
        ),
    }
    constants_source = "\n".join(
        f"{name} = {value!r}" for name, value in constants.items()
    )

    verify_cell = f"""
from google.colab import files
from pathlib import Path
import hashlib
import importlib.util
import json
import sys

{constants_source}
VERIFIER_MODULE_SOURCE = {verifier_module_source!r}

def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

archive = Path("/content") / EXPECTED_ARCHIVE_NAME
if archive.is_symlink():
    raise RuntimeError("Existing archive path must not be a symbolic link.")
if archive.exists():
    if not archive.is_file():
        raise RuntimeError("Existing archive path is not a regular file.")
    print(f"Reusing existing session archive: {{archive.name}}")
else:
    uploaded = files.upload()
    if EXPECTED_ARCHIVE_NAME not in uploaded:
        raise RuntimeError(
            f"Upload exactly {{EXPECTED_ARCHIVE_NAME}}; "
            f"observed {{sorted(uploaded)}}"
        )
    archive.write_bytes(uploaded[EXPECTED_ARCHIVE_NAME])
if archive.stat().st_size != EXPECTED_ARCHIVE_BYTES:
    raise RuntimeError("Uploaded archive byte count is wrong.")
observed_sha256 = file_sha256(archive)
if observed_sha256 != EXPECTED_ARCHIVE_SHA256:
    raise RuntimeError("Uploaded archive SHA-256 is wrong.")

bootstrap = Path("/content/lekh-neural-bootstrap")
bootstrap.mkdir(mode=0o700, exist_ok=True)
module_path = bootstrap / "neural_remote_artifacts.py"
module_path.write_text(VERIFIER_MODULE_SOURCE, encoding="utf-8")
spec = importlib.util.spec_from_file_location(
    "neural_remote_artifacts",
    module_path,
)
remote_artifacts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = remote_artifacts
try:
    spec.loader.exec_module(remote_artifacts)
except Exception:
    sys.modules.pop(spec.name, None)
    raise

bundle_root = Path("/content/lekh-neural-remote")
if bundle_root.exists():
    manifest = remote_artifacts.verify_extracted_tree(
        bundle_root,
        expected_kind=remote_artifacts.BUNDLE_KIND,
        allowed_output_prefixes=(EXPECTED_CANDIDATE_PREFIX,),
    )
    if manifest["bundleId"] != EXPECTED_BUNDLE_ID:
        raise RuntimeError("Existing extraction belongs to another bundle.")
else:
    verification = remote_artifacts.verify_closed_archive(
        archive,
        expected_kind=remote_artifacts.BUNDLE_KIND,
        expected_archive_sha256=EXPECTED_ARCHIVE_SHA256,
        extract_to=bundle_root,
    )
    if verification["bundleId"] != EXPECTED_BUNDLE_ID:
        raise RuntimeError("Verified archive has an unexpected bundleId.")

print(json.dumps({{
    "status": "passed-upload-and-closed-inventory-verification",
    "bundleId": EXPECTED_BUNDLE_ID,
    "modelId": EXPECTED_MODEL_ID,
    "archiveSha256": EXPECTED_ARCHIVE_SHA256,
}}, indent=2))
""".strip()

    drive_cell = """
from google.colab import drive
from pathlib import Path
import hashlib
import shutil

drive.mount("/content/drive")
persistent_base = Path("/content/drive/MyDrive/Lekh-Neural-Training")
persistent_base.mkdir(parents=True, exist_ok=True)
drive_archive = persistent_base / EXPECTED_ARCHIVE_NAME
if drive_archive.exists():
    if (
        drive_archive.stat().st_size != EXPECTED_ARCHIVE_BYTES
        or file_sha256(drive_archive) != EXPECTED_ARCHIVE_SHA256
    ):
        raise RuntimeError("Drive already contains a different archive with this name.")
else:
    shutil.copy2(archive, drive_archive)
    if (
        drive_archive.stat().st_size != EXPECTED_ARCHIVE_BYTES
        or file_sha256(drive_archive) != EXPECTED_ARCHIVE_SHA256
    ):
        raise RuntimeError("Drive archive copy failed post-write verification.")
print(f"Durable recovery root: {persistent_base}")
""".strip()

    setup_cell = f"""
from pathlib import Path
import json
import shutil
import subprocess
import sys

UV_VERSION = {UV_VERSION!r}
PINNED_PYTHON = {PYTHON_VERSION!r}
REMOTE_TORCH = "torch==2.7.0+cu118"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu118"
venv = Path("/content/lekh-neural-venv-py31115")

subprocess.run(
    [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        f"uv=={{UV_VERSION}}",
    ],
    check=True,
)
uv = shutil.which("uv")
if uv is None:
    raise RuntimeError("Pinned uv executable was not installed.")
subprocess.run([uv, "python", "install", PINNED_PYTHON], check=True)
if not venv.exists():
    subprocess.run(
        [
            uv,
            "venv",
            "--seed",
            "--python",
            PINNED_PYTHON,
            str(venv),
        ],
        check=True,
    )

python = venv / "bin/python"
lock_path = bundle_root / "requirements/neural-open-vocab.lock"
cuda_lock_path = (
    bundle_root / "requirements/neural-open-vocab-cu118.lock"
)
locked_requirements = [
    line.strip()
    for line in lock_path.read_text(encoding="utf-8").splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
torch_requirements = [
    value for value in locked_requirements
    if value.startswith("torch==")
]
if torch_requirements != ["torch==2.7.0"]:
    raise RuntimeError(
        f"Unexpected base torch lock: {{torch_requirements}}"
    )
non_torch_requirements = [
    value for value in locked_requirements
    if not value.startswith("torch==")
]
cuda_requirements = [
    line.strip()
    for line in cuda_lock_path.read_text(encoding="utf-8").splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]
cuda_torch_requirements = [
    value for value in cuda_requirements
    if value.startswith("torch==")
]
if cuda_torch_requirements != [REMOTE_TORCH]:
    raise RuntimeError(
        f"Unexpected CUDA torch lock: {{cuda_torch_requirements}}"
    )
subprocess.run(
    [
        uv,
        "pip",
        "install",
        "--python",
        str(python),
        "--no-deps",
        *non_torch_requirements,
    ],
    check=True,
)
subprocess.run(
    [
        uv,
        "pip",
        "install",
        "--python",
        str(python),
        "--no-deps",
        "--index-url",
        PYTORCH_INDEX,
        *cuda_requirements,
    ],
    check=True,
)
subprocess.run(
    [str(python), "-m", "pip", "check"],
    check=True,
)
python_version = subprocess.run(
    [
        str(python),
        "-c",
        "import platform; print(platform.python_version())",
    ],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
if python_version != PINNED_PYTHON:
    raise RuntimeError(
        f"Remote Python must be {{PINNED_PYTHON}}; observed {{python_version}}."
    )
toolchain = subprocess.run(
    [
        str(python),
        str(bundle_root / "scripts/check-neural-open-vocab-toolchain.py"),
        "--profile",
        "linux-cuda-cu118",
    ],
    cwd=bundle_root,
    check=True,
    capture_output=True,
    text=True,
)
print(toolchain.stdout)
cuda = subprocess.run(
    [
        str(python),
        "-c",
        (
            "import json, torch; "
            "print(json.dumps({{'available':torch.cuda.is_available(),"
            "'device':torch.cuda.get_device_name(0) if "
            "torch.cuda.is_available() else None,"
            "'torch':torch.__version__,'cuda':torch.version.cuda}},indent=2))"
        ),
    ],
    check=True,
    capture_output=True,
    text=True,
)
cuda_report = json.loads(cuda.stdout)
if cuda_report["available"] is not True:
    raise RuntimeError(
        "CUDA is unavailable. In Colab choose Runtime → Change runtime type → GPU."
    )
if (
    cuda_report["torch"] != "2.7.0+cu118"
    or cuda_report["cuda"] != "11.8"
):
    raise RuntimeError(
        f"CUDA runtime drifted from the pinned cu118 profile: {{cuda_report}}"
    )
print(json.dumps(cuda_report, indent=2))
""".strip()

    run_cell = """
import os
import subprocess

training_environment = os.environ.copy()
training_environment["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
training_environment["PYTHONHASHSEED"] = "42"
training_environment["PYTHONDONTWRITEBYTECODE"] = "1"
training_environment["PYTHONUNBUFFERED"] = "1"
subprocess.run(
    [
        str(python),
        "-u",
        "-B",
        str(bundle_root / "scripts/run-neural-remote-training.py"),
        "--config",
        EXPECTED_CONFIG,
        "--persistent-dir",
        str(persistent_base),
    ],
    cwd=bundle_root,
    env=training_environment,
    check=True,
)
""".strip()

    result_cell = """
from google.colab import files
from pathlib import Path
import hashlib
import json

result_root = (
    persistent_base
    / "lekh-neural-remote"
    / EXPECTED_BUNDLE_ID
    / EXPECTED_MODEL_ID
    / "results"
)
latest = json.loads(
    (result_root / "LATEST_RESULT.json").read_text(encoding="utf-8")
)
result_archive = result_root / latest["archive"]
if result_archive.stat().st_size != latest["archiveBytes"]:
    raise RuntimeError("Remote result archive byte count is stale.")
if file_sha256(result_archive) != latest["archiveSha256"]:
    raise RuntimeError("Remote result archive SHA-256 is stale.")
print(json.dumps(latest, indent=2))
files.download(str(result_archive))
""".strip()

    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "accelerator": "GPU",
            "colab": {
                "name": (
                    f"Lekh Neural CUDA Training — {manifest['modelId']}"
                ),
                "provenance": [],
            },
            "kernelspec": {
                "display_name": "Python 3",
                "name": "python3",
            },
            "language_info": {"name": "python"},
        },
        "cells": [
            markdown_cell(
                "# Lekh Neural CUDA Training\n\n"
                "This notebook trains one checksum-pinned Lekh candidate on "
                "a Colab GPU. The Mac does no PyTorch training. Every completed "
                "epoch is mirrored to your private Google Drive folder, and "
                "the returned checkpoint remains unpromoted until macOS Core "
                "ML conversion, parity, quality, and device gates pass.\n\n"
                "**Before running:** choose **Runtime → Change runtime type → "
                "GPU**. Free Colab GPU availability and runtime duration are "
                "not guaranteed."
            ),
            markdown_cell(
                "## 1. Upload and authenticate the exact local bundle\n\n"
                f"Expected bundle: `{archive_name}`  \n"
                f"SHA-256: `{bundle_report['archiveSha256']}`\n\n"
                "Either run the next cell and use **Choose Files**, or upload "
                "the exact archive through Colab's **Files** pane first. The "
                "cell reuses `/content/<archive-name>` only after checking "
                "its byte count and SHA-256."
            ),
            code_cell(verify_cell),
            markdown_cell(
                "## 2. Mount Drive for crash-safe epoch recovery\n\n"
                "The notebook creates `MyDrive/Lekh-Neural-Training`. Do not "
                "rename or modify its contents while training."
            ),
            code_cell(drive_cell),
            markdown_cell(
                "## 3. Install and verify the pinned Python toolchain"
            ),
            code_cell(setup_cell),
            markdown_cell(
                "## 4. Train or resume\n\n"
                "Re-running this cell resumes the newest fully mirrored epoch "
                "when the runtime fingerprint is compatible. If Colab assigns "
                "different CUDA hardware, the trainer fails closed instead of "
                "pretending the continuation is bit-reproducible."
            ),
            code_cell(run_cell),
            markdown_cell(
                "## 5. Download the authenticated training result\n\n"
                "This result contains only the checkpoint, vocabulary, and "
                "training evidence. Core ML conversion remains a separate "
                "short macOS operation."
            ),
            code_cell(result_cell),
        ],
    }


def code_cell(source: str) -> dict[str, Any]:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": source.splitlines(keepends=True),
    }


def markdown_cell(source: str) -> dict[str, Any]:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": source.splitlines(keepends=True),
    }


def notebook_bytes(notebook: dict[str, Any]) -> bytes:
    return (
        json.dumps(
            notebook,
            ensure_ascii=False,
            sort_keys=True,
            indent=1,
        ).encode("utf-8")
        + b"\n"
    )
