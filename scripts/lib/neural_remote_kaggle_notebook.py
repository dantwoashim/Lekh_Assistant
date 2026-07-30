#!/usr/bin/env python3
"""Generate a checksum-pinned Kaggle CUDA training notebook."""

from __future__ import annotations

import json
import re
from pathlib import Path, PurePosixPath
from typing import Any


UV_VERSION = "0.11.8"
PYTHON_VERSION = "3.11.15"
TORCH_REQUIREMENT = "torch==2.7.0+cu118"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu118"
KAGGLE_INPUT_ROOT = "/kaggle/input"
KAGGLE_WORKING_SCOPE = "/kaggle/working/Lekh-Neural-Training-Kaggle"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$")


class KaggleNotebookError(ValueError):
    """The trusted bundle cannot be represented by a Kaggle notebook."""


def build_kaggle_notebook(
    bundle_report: dict[str, Any],
    *,
    verifier_module_source: str,
) -> dict[str, Any]:
    """Return a deterministic notebook bound to one authenticated bundle."""

    constants = _validated_constants(bundle_report, verifier_module_source)
    constants_source = "\n".join(
        f"{name} = {value!r}" for name, value in constants.items()
    )

    bootstrap_cell = f"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys

{constants_source}
VERIFIER_MODULE_SOURCE = {verifier_module_source!r}

INPUT_ROOT = Path({KAGGLE_INPUT_ROOT!r})
WORKING_SCOPE = Path({KAGGLE_WORKING_SCOPE!r})
BUNDLE_ROOT = WORKING_SCOPE / "bundle"
PERSISTENT_BASE = WORKING_SCOPE / "persistent"
OUTPUT_ROOT = WORKING_SCOPE / "output"
BOOTSTRAP_ROOT = WORKING_SCOPE / "bootstrap"

def regular_file_sha256(path):
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"Refusing an unsafe archive candidate: {{path}}")
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_dev != metadata.st_dev
            or opened.st_ino != metadata.st_ino
        ):
            raise RuntimeError(
                f"Archive candidate changed before it was opened: {{path}}"
            )
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        after_open = os.fstat(descriptor)
        after_path = path.lstat()
        identity = (
            "st_dev",
            "st_ino",
            "st_size",
            "st_mtime_ns",
        )
        if any(
            getattr(after_open, field) != getattr(opened, field)
            or getattr(after_path, field) != getattr(opened, field)
            for field in identity
        ):
            raise RuntimeError(
                f"Archive candidate changed while it was hashed: {{path}}"
            )
        return digest.hexdigest()
    finally:
        os.close(descriptor)

def discover_exact_archive(input_root):
    requested_root = input_root.absolute()
    try:
        root_metadata = requested_root.lstat()
    except FileNotFoundError as error:
        raise RuntimeError(
            "Kaggle input is missing. Add the exact training archive as input."
        ) from error
    if (
        stat.S_ISLNK(root_metadata.st_mode)
        or not stat.S_ISDIR(root_metadata.st_mode)
    ):
        raise RuntimeError("Kaggle input root is not a safe directory.")
    resolved_root = requested_root.resolve(strict=True)
    candidates = []
    pending = [requested_root]
    while pending:
        current = pending.pop()
        with os.scandir(current) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            path = Path(entry.path)
            metadata = path.lstat()
            if entry.name == EXPECTED_ARCHIVE_NAME:
                candidates.append(path)
            if stat.S_ISDIR(metadata.st_mode):
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(resolved_root):
                    raise RuntimeError(
                        f"Kaggle input directory escapes its root: {{path}}"
                    )
                pending.append(path)
    if len(candidates) != 1:
        raise RuntimeError(
            "Expected exactly one checksum-pinned training archive under "
            f"{{requested_root}}; observed {{len(candidates)}} copies named "
            f"{{EXPECTED_ARCHIVE_NAME}}."
        )
    archive = candidates[0]
    metadata = archive.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(
            "The discovered training archive is not a regular non-symlink file."
        )
    if not archive.resolve(strict=True).is_relative_to(resolved_root):
        raise RuntimeError("The discovered training archive escapes Kaggle input.")
    if metadata.st_size != EXPECTED_ARCHIVE_BYTES:
        raise RuntimeError(
            "The discovered training archive has the wrong byte count."
        )
    observed_sha256 = regular_file_sha256(archive)
    if observed_sha256 != EXPECTED_ARCHIVE_SHA256:
        raise RuntimeError(
            "The discovered training archive has the wrong SHA-256."
        )
    return archive

def ensure_safe_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"Unsafe Kaggle working directory: {{path}}")
    return path.resolve(strict=True)

ensure_safe_directory(WORKING_SCOPE)
ensure_safe_directory(BOOTSTRAP_ROOT)
module_path = BOOTSTRAP_ROOT / "neural_remote_artifacts.py"
verifier_payload = VERIFIER_MODULE_SOURCE.encode("utf-8")
if module_path.exists() or module_path.is_symlink():
    if (
        module_path.is_symlink()
        or not module_path.is_file()
        or module_path.read_bytes() != verifier_payload
    ):
        raise RuntimeError(
            "Existing Kaggle verifier differs from the authenticated notebook."
        )
else:
    descriptor = os.open(
        module_path,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(descriptor, "wb") as output:
        output.write(verifier_payload)
        output.flush()
        os.fsync(output.fileno())

spec = importlib.util.spec_from_file_location(
    "neural_remote_artifacts",
    module_path,
)
if spec is None or spec.loader is None:
    raise RuntimeError("Unable to load the authenticated archive verifier.")
remote_artifacts = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = remote_artifacts
try:
    spec.loader.exec_module(remote_artifacts)
except Exception:
    sys.modules.pop(spec.name, None)
    raise

archive = discover_exact_archive(INPUT_ROOT)
if BUNDLE_ROOT.exists() or BUNDLE_ROOT.is_symlink():
    if BUNDLE_ROOT.is_symlink() or not BUNDLE_ROOT.is_dir():
        raise RuntimeError("Existing Kaggle bundle extraction is unsafe.")
    archive_verification = remote_artifacts.verify_closed_archive(
        archive,
        expected_kind=remote_artifacts.BUNDLE_KIND,
        expected_archive_sha256=EXPECTED_ARCHIVE_SHA256,
    )
else:
    archive_verification = remote_artifacts.verify_closed_archive(
        archive,
        expected_kind=remote_artifacts.BUNDLE_KIND,
        expected_archive_sha256=EXPECTED_ARCHIVE_SHA256,
        extract_to=BUNDLE_ROOT,
    )
manifest = remote_artifacts.verify_extracted_tree(
    BUNDLE_ROOT,
    expected_kind=remote_artifacts.BUNDLE_KIND,
    allowed_output_prefixes=(EXPECTED_CANDIDATE_PREFIX,),
)
if (
    archive_verification.get("archiveBytes") != EXPECTED_ARCHIVE_BYTES
    or archive_verification.get("bundleId") != EXPECTED_BUNDLE_ID
    or manifest.get("bundleId") != EXPECTED_BUNDLE_ID
    or manifest.get("modelId") != EXPECTED_MODEL_ID
    or manifest.get("trainingConfig") != EXPECTED_CONFIG
):
    raise RuntimeError("Verified Kaggle bundle identity is unexpected.")

ensure_safe_directory(PERSISTENT_BASE)
ensure_safe_directory(OUTPUT_ROOT)
print(json.dumps({{
    "schemaVersion": 1,
    "status": "passed-kaggle-closed-bundle-verification",
    "bundleId": EXPECTED_BUNDLE_ID,
    "modelId": EXPECTED_MODEL_ID,
    "archive": EXPECTED_ARCHIVE_NAME,
    "archiveSha256": EXPECTED_ARCHIVE_SHA256,
    "workingScope": str(WORKING_SCOPE),
}}, indent=2, sort_keys=True))
""".strip()

    setup_cell = f"""
from pathlib import Path
import json
import os
import shutil
import stat
import subprocess
import sys

UV_VERSION = {UV_VERSION!r}
PINNED_PYTHON = {PYTHON_VERSION!r}
REMOTE_TORCH = {TORCH_REQUIREMENT!r}
PYTORCH_INDEX = {PYTORCH_INDEX!r}
VENV = WORKING_SCOPE / "venv-py31115"
UV_PYTHON_ROOT = WORKING_SCOPE / "uv-python"

for name, value in {{
    "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
    "PYTHONHASHSEED": "42",
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONUNBUFFERED": "1",
    "UV_PYTHON_INSTALL_DIR": str(UV_PYTHON_ROOT),
}}.items():
    os.environ[name] = value
ensure_safe_directory(UV_PYTHON_ROOT)

def verified_managed_python(candidate, managed_python_root, label):
    try:
        metadata = candidate.lstat()
    except FileNotFoundError as error:
        raise RuntimeError(
            f"{{label}} is missing."
        ) from error
    if not (
        stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
    ):
        raise RuntimeError(
            f"{{label}} has an unsafe file type."
        )
    trusted_root = managed_python_root.resolve(strict=True)
    resolved = candidate.resolve(strict=True)
    resolved_metadata = resolved.lstat()
    if (
        not resolved.is_relative_to(trusted_root)
        or stat.S_ISLNK(resolved_metadata.st_mode)
        or not stat.S_ISREG(resolved_metadata.st_mode)
    ):
        raise RuntimeError(
            f"{{label}} escapes its managed root."
        )
    return candidate

def verified_venv_python(venv, managed_python_root):
    return verified_managed_python(
        venv / "bin/python",
        managed_python_root,
        "Pinned Kaggle Python executable",
    )

system_nvidia_smi = shutil.which("nvidia-smi")
if system_nvidia_smi is None:
    raise RuntimeError(
        "No NVIDIA GPU is attached. Enable a GPU accelerator in notebook "
        "settings before running this cell."
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
        "The NVIDIA GPU runtime is unusable: "
        f"{{gpu_preflight.stderr.strip()}}"
    )
print(json.dumps({{
    "status": "passed-kaggle-early-gpu-preflight",
    "devices": gpu_preflight.stdout.strip().splitlines(),
}}, indent=2, sort_keys=True))

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
uv_version = subprocess.run(
    [uv, "--version"],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
if uv_version != f"uv {{UV_VERSION}}":
    raise RuntimeError(
        f"uv must be exactly {{UV_VERSION}}; observed {{uv_version}}."
    )
subprocess.run(
    [uv, "python", "install", PINNED_PYTHON],
    check=True,
)
managed_python_result = subprocess.run(
    [
        uv,
        "python",
        "find",
        "--managed-python",
        PINNED_PYTHON,
    ],
    check=True,
    capture_output=True,
    text=True,
)
managed_python_text = managed_python_result.stdout.strip()
if not managed_python_text:
    raise RuntimeError("uv did not report its pinned managed Python.")
managed_python = verified_managed_python(
    Path(managed_python_text),
    UV_PYTHON_ROOT,
    "uv-managed Python executable",
)
if VENV.exists() or VENV.is_symlink():
    if VENV.is_symlink() or not VENV.is_dir():
        raise RuntimeError("Existing Kaggle Python environment is unsafe.")
else:
    subprocess.run(
        [
            uv,
            "venv",
            "--seed",
            "--python",
            str(managed_python),
            str(VENV),
        ],
        check=True,
    )

python = verified_venv_python(VENV, UV_PYTHON_ROOT)
lock_path = BUNDLE_ROOT / "requirements/neural-open-vocab.lock"
cuda_lock_path = (
    BUNDLE_ROOT / "requirements/neural-open-vocab-cu118.lock"
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
subprocess.run([str(python), "-m", "pip", "check"], check=True)
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
        f"Python must be exactly {{PINNED_PYTHON}}; "
        f"observed {{python_version}}."
    )
toolchain = subprocess.run(
    [
        str(python),
        str(BUNDLE_ROOT / "scripts/check-neural-open-vocab-toolchain.py"),
        "--profile",
        "linux-cuda-cu118",
    ],
    cwd=BUNDLE_ROOT,
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
            "'torch':torch.__version__,'cuda':torch.version.cuda}},"
            "sort_keys=True))"
        ),
    ],
    check=True,
    capture_output=True,
    text=True,
)
cuda_report = json.loads(cuda.stdout)
if cuda_report.get("available") is not True:
    raise RuntimeError("CUDA is unavailable in this Kaggle runtime.")
if (
    cuda_report.get("torch") != "2.7.0+cu118"
    or cuda_report.get("cuda") != "11.8"
):
    raise RuntimeError(
        f"CUDA toolchain drifted from the pinned cu118 profile: "
        f"{{cuda_report}}"
    )
print(json.dumps(cuda_report, indent=2, sort_keys=True))
""".strip()

    run_cell = """
import json
import os
import subprocess

RUN_MARKER = WORKING_SCOPE / "KAGGLE_PROVIDER_STATE.json"
expected_marker = {
    "schemaVersion": 1,
    "status": "initialized-kaggle-provider-local-training",
    "bundleId": EXPECTED_BUNDLE_ID,
    "modelId": EXPECTED_MODEL_ID,
    "storagePolicy": "kaggle-working-only-v1",
}
if RUN_MARKER.exists() or RUN_MARKER.is_symlink():
    if (
        RUN_MARKER.is_symlink()
        or not RUN_MARKER.is_file()
        or not 1 <= RUN_MARKER.stat().st_size <= 64 * 1024
    ):
        raise RuntimeError("Kaggle provider-local run marker is unsafe.")
    observed_marker = json.loads(
        RUN_MARKER.read_text(encoding="utf-8")
    )
    if observed_marker != expected_marker:
        raise RuntimeError(
            "Kaggle provider-local run marker is malformed or stale."
        )
    first_provider_invocation = False
else:
    marker_payload = (
        json.dumps(
            expected_marker,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\\n"
    ).encode("utf-8")
    descriptor = os.open(
        RUN_MARKER,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(descriptor, "wb") as output:
        output.write(marker_payload)
        output.flush()
        os.fsync(output.fileno())
    first_provider_invocation = True

training_environment = os.environ.copy()
training_environment["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
training_environment["PYTHONHASHSEED"] = "42"
training_environment["PYTHONDONTWRITEBYTECODE"] = "1"
training_environment["PYTHONUNBUFFERED"] = "1"
command = [
    str(python),
    "-u",
    "-B",
    str(BUNDLE_ROOT / "scripts/run-neural-remote-training.py"),
    "--config",
    EXPECTED_CONFIG,
    "--persistent-dir",
    str(PERSISTENT_BASE),
]
if first_provider_invocation:
    command.append("--restart-training")
print(json.dumps({
    "schemaVersion": 1,
    "status": (
        "starting-kaggle-fresh-training"
        if first_provider_invocation
        else "resuming-kaggle-provider-local-training"
    ),
    "restartTraining": first_provider_invocation,
    "externalRecoveryImported": False,
}, indent=2, sort_keys=True))
subprocess.run(
    command,
    cwd=BUNDLE_ROOT,
    env=training_environment,
    check=True,
)
""".strip()

    result_cell = """
from pathlib import Path
import json
import os
import re
import shutil
import uuid

def validate_result_pointer(value):
    if not isinstance(value, dict):
        raise RuntimeError(
            "Kaggle result pointer must contain one JSON object."
        )
    archive_name = value.get("archive")
    if (
        set(value) != {
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
        or value.get("schemaVersion") != 1
        or value.get("status") != "complete-neural-remote-result"
        or value.get("bundleId") != EXPECTED_BUNDLE_ID
        or value.get("modelId") != EXPECTED_MODEL_ID
        or not isinstance(value.get("trainingRunId"), str)
        or re.fullmatch(r"[0-9a-f]{32}", value["trainingRunId"]) is None
        or not isinstance(value.get("resultId"), str)
        or re.fullmatch(r"[0-9a-f]{64}", value["resultId"]) is None
        or not isinstance(archive_name, str)
        or Path(archive_name).name != archive_name
        or re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,179}[.]tar[.]gz",
            archive_name,
        ) is None
        or not isinstance(value.get("archiveSha256"), str)
        or re.fullmatch(
            r"[0-9a-f]{64}",
            value["archiveSha256"],
        ) is None
        or type(value.get("archiveBytes")) is not int
        or value["archiveBytes"] < 1
    ):
        raise RuntimeError(
            "Kaggle result pointer identity is malformed or stale."
        )
    return value

def read_result_pointer(path):
    if (
        path.is_symlink()
        or not path.is_file()
        or not 1 <= path.stat().st_size <= 64 * 1024
    ):
        raise RuntimeError("Kaggle result pointer is missing or unsafe.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("Kaggle result pointer is invalid JSON.") from error
    return validate_result_pointer(value)

def verify_result_archive(path, pointer):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("Kaggle result archive is missing or unsafe.")
    if path.stat().st_size != pointer["archiveBytes"]:
        raise RuntimeError("Kaggle result archive byte count is stale.")
    if regular_file_sha256(path) != pointer["archiveSha256"]:
        raise RuntimeError("Kaggle result archive SHA-256 is stale.")
    verification = remote_artifacts.verify_closed_archive(
        path,
        expected_kind=remote_artifacts.RESULT_KIND,
        expected_archive_sha256=pointer["archiveSha256"],
    )
    manifest = verification.get("manifest")
    if (
        verification.get("archiveBytes") != pointer["archiveBytes"]
        or verification.get("resultId") != pointer["resultId"]
        or not isinstance(manifest, dict)
        or manifest.get("resultId") != pointer["resultId"]
        or manifest.get("bundleId") != EXPECTED_BUNDLE_ID
        or manifest.get("modelId") != EXPECTED_MODEL_ID
        or manifest.get("trainingConfig") != EXPECTED_CONFIG
        or manifest.get("trainingRunId") != pointer["trainingRunId"]
    ):
        raise RuntimeError(
            "Kaggle result archive identity differs from its pointer."
        )
    return verification

def copy_verified_result(source, target, pointer):
    if target.exists() or target.is_symlink():
        verify_result_archive(target, pointer)
        return
    staging = target.with_name(
        f".{target.name}.staging.{uuid.uuid4().hex}"
    )
    try:
        if staging.exists() or staging.is_symlink():
            raise RuntimeError(
                "Kaggle result staging path unexpectedly exists."
            )
        shutil.copyfile(source, staging, follow_symlinks=False)
        verify_result_archive(staging, pointer)
        os.replace(staging, target)
        verify_result_archive(target, pointer)
    finally:
        if staging.exists() or staging.is_symlink():
            staging.unlink()

def write_pointer_once(path, value):
    payload = (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\\n"
    ).encode("utf-8")
    if path.exists() or path.is_symlink():
        if (
            path.is_symlink()
            or not path.is_file()
            or path.read_bytes() != payload
        ):
            raise RuntimeError(
                "Kaggle output pointer already has different bytes."
            )
        return
    descriptor = os.open(
        path,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(descriptor, "wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())

result_root = (
    PERSISTENT_BASE
    / "lekh-neural-remote"
    / EXPECTED_BUNDLE_ID
    / EXPECTED_MODEL_ID
    / "results"
)
latest = read_result_pointer(result_root / "LATEST_RESULT.json")
source_archive = result_root / latest["archive"]
verify_result_archive(source_archive, latest)
ensure_safe_directory(OUTPUT_ROOT)
output_archive = OUTPUT_ROOT / latest["archive"]
copy_verified_result(source_archive, output_archive, latest)
write_pointer_once(OUTPUT_ROOT / "LATEST_RESULT.json", latest)
published_pointer = read_result_pointer(
    OUTPUT_ROOT / "LATEST_RESULT.json"
)
if published_pointer != latest:
    raise RuntimeError("Published Kaggle result pointer changed unexpectedly.")
published_verification = verify_result_archive(
    output_archive,
    published_pointer,
)
print(json.dumps({
    "schemaVersion": 1,
    "status": "passed-kaggle-result-publication",
    "bundleId": EXPECTED_BUNDLE_ID,
    "modelId": EXPECTED_MODEL_ID,
    "resultId": latest["resultId"],
    "archive": latest["archive"],
    "archiveSha256": latest["archiveSha256"],
    "archiveBytes": latest["archiveBytes"],
    "manifestSha256": published_verification["manifestSha256"],
    "kaggleOutput": str(OUTPUT_ROOT),
}, indent=2, sort_keys=True))
""".strip()

    archive_name = constants["EXPECTED_ARCHIVE_NAME"]
    archive_sha256 = constants["EXPECTED_ARCHIVE_SHA256"]
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kaggle": {
                "accelerator": "gpu",
                "dataSources": [],
                "isGpuEnabled": True,
                "isInternetEnabled": True,
                "language": "python",
                "sourceType": "notebook",
            },
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
        },
        "cells": [
            markdown_cell(
                "# Lekh Neural CUDA Training — Kaggle fallback\n\n"
                "This notebook starts a new, checksum-pinned training run on "
                "a Kaggle GPU. It never imports recovery from another "
                "provider. Re-running the training cell in this notebook may "
                "resume only state created inside its dedicated Kaggle "
                "working scope.\n\n"
                "**Before running:** enable **GPU** and **Internet** in "
                "Notebook options, then add the exact archive below as a "
                "private notebook input."
            ),
            markdown_cell(
                "## 1. Authenticate the one allowed input\n\n"
                f"Archive: `{archive_name}`  \n"
                f"SHA-256: `{archive_sha256}`\n\n"
                "The next cell requires exactly one file with this name "
                "anywhere under Kaggle input. It rejects duplicates, symbolic "
                "links, the wrong byte count, the wrong digest, unsafe tar "
                "metadata, and any file not declared by the closed manifest."
            ),
            code_cell(bootstrap_cell),
            markdown_cell(
                "## 2. Install and verify the exact CUDA toolchain\n\n"
                "This creates an isolated Python 3.11.15 environment and "
                "requires the authenticated dependency locks, PyTorch "
                "2.7.0+cu118, CUDA 11.8, and the repository toolchain check."
            ),
            code_cell(setup_cell),
            markdown_cell(
                "## 3. Start fresh, then resume only Kaggle-local state\n\n"
                "The first invocation always passes `--restart-training`. "
                "Later invocations omit it and allow the authenticated runner "
                "to resume only its own provider-local recovery generations."
            ),
            code_cell(run_cell),
            markdown_cell(
                "## 4. Verify and publish the training result\n\n"
                "The final cell authenticates both the strict result pointer "
                "and the complete closed result archive, then copies identical "
                "verified bytes into the dedicated Kaggle output folder."
            ),
            code_cell(result_cell),
        ],
    }


def _validated_constants(
    bundle_report: dict[str, Any],
    verifier_module_source: str,
) -> dict[str, Any]:
    if not isinstance(bundle_report, dict):
        raise KaggleNotebookError("Bundle report must be one object.")
    try:
        archive_value = bundle_report["archive"]
        archive_bytes = bundle_report["archiveBytes"]
        archive_sha256 = bundle_report["archiveSha256"]
        bundle_id = bundle_report["bundleId"]
        manifest = bundle_report["manifest"]
        model_id = manifest["modelId"]
        training_config = manifest["trainingConfig"]
    except (KeyError, TypeError) as error:
        raise KaggleNotebookError(
            "Bundle report lacks required notebook identity fields."
        ) from error
    if not isinstance(archive_value, str) or not archive_value:
        raise KaggleNotebookError("Bundle archive path is invalid.")
    archive_name = Path(archive_value).name
    if (
        SAFE_COMPONENT.fullmatch(archive_name) is None
        or not archive_name.endswith(".tar.gz")
    ):
        raise KaggleNotebookError("Bundle archive name is unsafe.")
    if type(archive_bytes) is not int or archive_bytes < 1:
        raise KaggleNotebookError("Bundle archive byte count is invalid.")
    if (
        not isinstance(archive_sha256, str)
        or SHA256.fullmatch(archive_sha256) is None
        or not isinstance(bundle_id, str)
        or SHA256.fullmatch(bundle_id) is None
    ):
        raise KaggleNotebookError(
            "Bundle archive or identity digest is invalid."
        )
    if (
        not isinstance(model_id, str)
        or SAFE_COMPONENT.fullmatch(model_id) is None
    ):
        raise KaggleNotebookError("Bundle modelId is unsafe.")
    if not isinstance(training_config, str):
        raise KaggleNotebookError("Bundle training config is invalid.")
    parsed_config = PurePosixPath(training_config)
    if (
        parsed_config.is_absolute()
        or parsed_config.as_posix() != training_config
        or any(part in {"", ".", ".."} for part in parsed_config.parts)
    ):
        raise KaggleNotebookError(
            "Bundle training config is not a safe relative path."
        )
    if (
        not isinstance(verifier_module_source, str)
        or not verifier_module_source.strip()
    ):
        raise KaggleNotebookError("Authenticated verifier source is empty.")
    try:
        compile(
            verifier_module_source,
            "authenticated-neural-archive-verifier",
            "exec",
        )
    except SyntaxError as error:
        raise KaggleNotebookError(
            "Authenticated verifier source is invalid Python."
        ) from error
    candidate_prefix = (
        "data/generated/neural-open-vocab-model/" + model_id
    )
    return {
        "EXPECTED_ARCHIVE_NAME": archive_name,
        "EXPECTED_ARCHIVE_SHA256": archive_sha256,
        "EXPECTED_ARCHIVE_BYTES": archive_bytes,
        "EXPECTED_BUNDLE_ID": bundle_id,
        "EXPECTED_MODEL_ID": model_id,
        "EXPECTED_CONFIG": training_config,
        "EXPECTED_CANDIDATE_PREFIX": candidate_prefix,
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
