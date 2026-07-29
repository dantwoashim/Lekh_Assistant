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

    bootstrap_cell = f"""
from google.colab import drive, files
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sys
import uuid

{constants_source}
VERIFIER_MODULE_SOURCE = {verifier_module_source!r}

def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def verify_expected_archive(path, label):
    if path.is_symlink():
        raise RuntimeError(f"{{label}} must not be a symbolic link.")
    if not path.exists() or not path.is_file():
        raise RuntimeError(f"{{label}} is not a regular file.")
    if path.stat().st_size != EXPECTED_ARCHIVE_BYTES:
        raise RuntimeError(f"{{label}} byte count is wrong.")
    observed = file_sha256(path)
    if observed != EXPECTED_ARCHIVE_SHA256:
        raise RuntimeError(f"{{label}} SHA-256 is wrong.")
    return observed

def copy_verified(source, target, label):
    staging = target.with_name(
        f".{{target.name}}.staging.{{uuid.uuid4().hex}}"
    )
    try:
        if staging.exists() or staging.is_symlink():
            raise RuntimeError(f"{{label}} staging path unexpectedly exists.")
        shutil.copyfile(source, staging)
        verify_expected_archive(staging, f"{{label}} staging copy")
        os.replace(staging, target)
        verify_expected_archive(target, label)
    finally:
        if staging.exists() and not staging.is_symlink():
            staging.unlink()

drive.mount("/content/drive")
persistent_base = Path("/content/drive/MyDrive/Lekh-Neural-Training")
persistent_base.mkdir(parents=True, exist_ok=True)
if persistent_base.is_symlink() or not persistent_base.is_dir():
    raise RuntimeError("Durable training root is not a safe directory.")

archive = Path("/content") / EXPECTED_ARCHIVE_NAME
drive_archive = persistent_base / EXPECTED_ARCHIVE_NAME
if archive.exists() or archive.is_symlink():
    verify_expected_archive(archive, "Existing session archive")
    archive_source = "verified-session-cache"
elif drive_archive.exists() or drive_archive.is_symlink():
    verify_expected_archive(drive_archive, "Durable Drive archive")
    copy_verified(
        drive_archive,
        archive,
        "Restored session archive",
    )
    archive_source = "verified-drive-recovery"
else:
    uploaded = files.upload()
    if set(uploaded) != {{EXPECTED_ARCHIVE_NAME}}:
        raise RuntimeError(
            f"Upload exactly {{EXPECTED_ARCHIVE_NAME}}; "
            f"observed {{sorted(uploaded)}}"
        )
    payload = uploaded[EXPECTED_ARCHIVE_NAME]
    if len(payload) != EXPECTED_ARCHIVE_BYTES:
        raise RuntimeError("Uploaded archive byte count is wrong.")
    staging = archive.with_name(
        f".{{archive.name}}.staging.{{uuid.uuid4().hex}}"
    )
    try:
        with staging.open("xb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        verify_expected_archive(staging, "Uploaded staging archive")
        os.replace(staging, archive)
    finally:
        if staging.exists() and not staging.is_symlink():
            staging.unlink()
    verify_expected_archive(archive, "Uploaded archive")
    archive_source = "verified-browser-upload"

if drive_archive.exists() or drive_archive.is_symlink():
    verify_expected_archive(drive_archive, "Durable Drive archive")
else:
    copy_verified(
        archive,
        drive_archive,
        "Durable Drive archive",
    )

bootstrap = Path("/content/lekh-neural-bootstrap")
bootstrap.mkdir(mode=0o700, exist_ok=True)
if bootstrap.is_symlink() or not bootstrap.is_dir():
    raise RuntimeError("Verifier bootstrap root is not a safe directory.")
module_path = bootstrap / "neural_remote_artifacts.py"
verifier_payload = VERIFIER_MODULE_SOURCE.encode("utf-8")
if module_path.exists() or module_path.is_symlink():
    if (
        module_path.is_symlink()
        or not module_path.is_file()
        or module_path.read_bytes() != verifier_payload
    ):
        raise RuntimeError("Existing verifier module differs from this notebook.")
else:
    with module_path.open("xb") as output:
        output.write(verifier_payload)
        output.flush()
        os.fsync(output.fileno())
spec = importlib.util.spec_from_file_location(
    "neural_remote_artifacts",
    module_path,
)
if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load the embedded archive verifier.")
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
    "status": "passed-drive-first-closed-inventory-verification",
    "bundleId": EXPECTED_BUNDLE_ID,
    "modelId": EXPECTED_MODEL_ID,
    "archiveSha256": EXPECTED_ARCHIVE_SHA256,
    "archiveSource": archive_source,
    "durableArchive": str(drive_archive),
}}, indent=2))
""".strip()

    status_cell = """
def read_optional_pointer(path, label):
    if path.is_symlink():
        raise RuntimeError(f"{label} must not be a symbolic link.")
    if not path.exists():
        return None
    if not path.is_file():
        raise RuntimeError(f"{label} is not a regular file.")
    if not 1 <= path.stat().st_size <= 64 * 1024:
        raise RuntimeError(f"{label} is empty or unexpectedly large.")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must contain one JSON object.")
    return value

remote_root = (
    persistent_base
    / "lekh-neural-remote"
    / EXPECTED_BUNDLE_ID
    / EXPECTED_MODEL_ID
)
recovery_root = (
    remote_root
    / "recovery"
    / EXPECTED_BUNDLE_ID
    / EXPECTED_MODEL_ID
)
result_root = remote_root / "results"
recovery_pointer = read_optional_pointer(
    recovery_root / "LATEST.json",
    "Recovery pointer",
)
result_pointer = read_optional_pointer(
    result_root / "LATEST_RESULT.json",
    "Result pointer",
)

status = {
    "schemaVersion": 1,
    "bundleId": EXPECTED_BUNDLE_ID,
    "modelId": EXPECTED_MODEL_ID,
    "recovery": None,
    "result": None,
    "note": (
        "This is a lightweight status view. The runner authenticates the "
        "complete recovery generation before resuming."
    ),
}
if recovery_pointer is not None:
    generation = recovery_pointer.get("generation")
    recovery_id = recovery_pointer.get("recoveryId")
    completed_epoch = recovery_pointer.get("completedEpoch")
    if (
        set(recovery_pointer) != {
            "schemaVersion",
            "bundleId",
            "modelId",
            "generation",
            "recoveryId",
            "completedEpoch",
        }
        or recovery_pointer.get("schemaVersion") != 1
        or recovery_pointer.get("bundleId") != EXPECTED_BUNDLE_ID
        or recovery_pointer.get("modelId") != EXPECTED_MODEL_ID
        or not isinstance(generation, str)
        or re.fullmatch(r"epoch-[0-9]{6}-[0-9a-f]{16}", generation) is None
        or not isinstance(recovery_id, str)
        or re.fullmatch(r"[0-9a-f]{64}", recovery_id) is None
        or type(completed_epoch) is not int
        or completed_epoch < 1
    ):
        raise RuntimeError("Recovery pointer identity is malformed or stale.")
    status["recovery"] = {
        "status": "observed-recoverable-pointer",
        "completedEpoch": completed_epoch,
        "generation": generation,
        "recoveryId": recovery_id,
    }
if result_pointer is not None:
    archive_name = result_pointer.get("archive")
    archive_sha256 = result_pointer.get("archiveSha256")
    archive_bytes = result_pointer.get("archiveBytes")
    training_run_id = result_pointer.get("trainingRunId")
    result_id = result_pointer.get("resultId")
    if (
        set(result_pointer) != {
            "schemaVersion",
            "status",
            "bundleId",
            "modelId",
            "trainingRunId",
            "resultId",
            "archive",
            "archiveSha256",
            "archiveBytes",
        }
        or result_pointer.get("schemaVersion") != 1
        or result_pointer.get("status") != "complete-neural-remote-result"
        or result_pointer.get("bundleId") != EXPECTED_BUNDLE_ID
        or result_pointer.get("modelId") != EXPECTED_MODEL_ID
        or not isinstance(training_run_id, str)
        or re.fullmatch(r"[0-9a-f]{32}", training_run_id) is None
        or not isinstance(result_id, str)
        or re.fullmatch(r"[0-9a-f]{64}", result_id) is None
        or not isinstance(archive_name, str)
        or Path(archive_name).name != archive_name
        or re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,179}[.]tar[.]gz",
            archive_name,
        ) is None
        or not isinstance(archive_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", archive_sha256) is None
        or type(archive_bytes) is not int
        or archive_bytes < 1
    ):
        raise RuntimeError("Result pointer identity is malformed or stale.")
    status["result"] = {
        "status": "observed-complete-result-pointer",
        "archive": archive_name,
        "archiveSha256": archive_sha256,
        "archiveBytes": archive_bytes,
    }
print(json.dumps(status, indent=2))
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

system_nvidia_smi = shutil.which("nvidia-smi")
if system_nvidia_smi is None:
    raise RuntimeError(
        "No NVIDIA GPU runtime is attached. Use Runtime → Change runtime "
        "type → GPU, or wait for the free GPU quota to reset."
    )
gpu_preflight = subprocess.run(
    [
        system_nvidia_smi,
        "--query-gpu=name",
        "--format=csv,noheader",
    ],
    check=False,
    capture_output=True,
    text=True,
)
if gpu_preflight.returncode != 0 or not gpu_preflight.stdout.strip():
    raise RuntimeError(
        "The NVIDIA GPU runtime is not usable: "
        f"{{gpu_preflight.stderr.strip()}}"
    )
print(json.dumps({{
    "status": "passed-early-gpu-preflight",
    "devices": gpu_preflight.stdout.strip().splitlines(),
}}, indent=2))

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
import json
import re

result_root = (
    persistent_base
    / "lekh-neural-remote"
    / EXPECTED_BUNDLE_ID
    / EXPECTED_MODEL_ID
    / "results"
)
latest_path = result_root / "LATEST_RESULT.json"
if (
    latest_path.is_symlink()
    or not latest_path.is_file()
    or not 1 <= latest_path.stat().st_size <= 64 * 1024
):
    raise RuntimeError("Remote result pointer is missing or unsafe.")
latest = json.loads(latest_path.read_text(encoding="utf-8"))
if not isinstance(latest, dict):
    raise RuntimeError("Remote result pointer must contain one JSON object.")
archive_name = latest.get("archive")
if (
    set(latest) != {
        "schemaVersion",
        "status",
        "bundleId",
        "modelId",
        "trainingRunId",
        "resultId",
        "archive",
        "archiveSha256",
        "archiveBytes",
    }
    or latest.get("schemaVersion") != 1
    or latest.get("status") != "complete-neural-remote-result"
    or latest.get("bundleId") != EXPECTED_BUNDLE_ID
    or latest.get("modelId") != EXPECTED_MODEL_ID
    or not isinstance(latest.get("trainingRunId"), str)
    or re.fullmatch(r"[0-9a-f]{32}", latest["trainingRunId"]) is None
    or not isinstance(latest.get("resultId"), str)
    or re.fullmatch(r"[0-9a-f]{64}", latest["resultId"]) is None
    or not isinstance(archive_name, str)
    or Path(archive_name).name != archive_name
    or re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._-]{0,179}[.]tar[.]gz",
        archive_name,
    ) is None
    or not isinstance(latest.get("archiveSha256"), str)
    or re.fullmatch(r"[0-9a-f]{64}", latest["archiveSha256"]) is None
    or type(latest.get("archiveBytes")) is not int
    or latest["archiveBytes"] < 1
):
    raise RuntimeError("Remote result pointer identity is malformed or stale.")
result_archive = result_root / archive_name
if result_archive.is_symlink() or not result_archive.is_file():
    raise RuntimeError("Remote result archive is missing or unsafe.")
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
                "## 1. Mount Drive and authenticate the exact bundle\n\n"
                f"Expected bundle: `{archive_name}`  \n"
                f"SHA-256: `{bundle_report['archiveSha256']}`\n\n"
                "The cell first reuses an exact local runtime copy, then an "
                "exact durable Drive copy. It asks for a browser upload only "
                "when neither exists. Every path is checked by byte count and "
                "SHA-256 before extraction."
            ),
            code_cell(bootstrap_cell),
            markdown_cell(
                "## 2. Inspect durable progress\n\n"
                "This lightweight cell reports the observed completed epoch "
                "or final-result pointer without requiring a GPU. It does not "
                "replace the runner's full authenticated recovery check."
            ),
            code_cell(status_cell),
            markdown_cell(
                "## 3. Verify GPU and install the pinned Python toolchain\n\n"
                "The first check fails immediately on a CPU-only runtime, "
                "before downloading the training toolchain."
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
