#!/usr/bin/env python3
"""Generate the exact fresh seed-43 Kaggle challenger notebook."""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path
from typing import Any

from scripts.lib.neural_remote_candidate_profile import (
    ACTIVE_BUNDLE_REPORT_CONTRACT,
    CANONICAL_PROFILE,
    CHALLENGER_SEED,
    CHALLENGER_SUFFIX,
    CONFIGURED_SEED,
    CTC_CONFIG,
    CTC_MODEL_ID,
    CTC_TRAINER,
    SEED_43_PROFILE,
    SEED_43_PROFILE_ID,
    candidate_relative_path,
)
from scripts.lib.neural_remote_kaggle_notebook import (
    KAGGLE_WORKING_SCOPE,
    KaggleNotebookError,
    build_kaggle_notebook,
    notebook_bytes,
)


CHALLENGER_WORKING_SCOPE = KAGGLE_WORKING_SCOPE + CHALLENGER_SUFFIX
CANONICAL_CANDIDATE_PREFIX = candidate_relative_path(
    CANONICAL_PROFILE,
    CTC_MODEL_ID,
)
CHALLENGER_CANDIDATE_PREFIX = candidate_relative_path(
    SEED_43_PROFILE,
    CTC_MODEL_ID,
)
CHALLENGER_MARKER = "KAGGLE_SEED_43_PROVIDER_STATE.json"


def build_kaggle_challenger_notebook(
    bundle_report: dict[str, Any],
    *,
    verifier_module_source: str,
) -> dict[str, Any]:
    """Return a deterministic notebook isolated from candidate one."""

    _validate_challenger_bundle_report(bundle_report)
    notebook = copy.deepcopy(
        build_kaggle_notebook(
            bundle_report,
            verifier_module_source=verifier_module_source,
        )
    )
    cells = notebook.get("cells")
    if (
        not isinstance(cells, list)
        or len(cells) != 9
        or [cell.get("cell_type") for cell in cells]
            != [
                "markdown",
                "markdown",
                "code",
                "markdown",
                "code",
                "markdown",
                "code",
                "markdown",
                "code",
            ]
    ):
        raise KaggleNotebookError(
            "Base Kaggle notebook layout changed; challenger generation "
            "refuses an unreviewed transformation."
        )

    bootstrap = _cell_source(cells[2])
    bootstrap = _replace_once(
        bootstrap,
        f"WORKING_SCOPE = Path({KAGGLE_WORKING_SCOPE!r})",
        f"WORKING_SCOPE = Path({CHALLENGER_WORKING_SCOPE!r})",
        "Kaggle working scope",
    )
    bootstrap = _replace_once(
        bootstrap,
        (
            "EXPECTED_CANDIDATE_PREFIX = "
            f"{CANONICAL_CANDIDATE_PREFIX!r}"
        ),
        "\n".join(
            [
                (
                    "EXPECTED_CANDIDATE_PREFIX = "
                    f"{CHALLENGER_CANDIDATE_PREFIX!r}"
                ),
                (
                    "EXPECTED_CONFIGURED_CANDIDATE_PREFIX = "
                    f"{CANONICAL_CANDIDATE_PREFIX!r}"
                ),
                f"EXPECTED_CHALLENGER_SEED = {CHALLENGER_SEED!r}",
                f"EXPECTED_CONFIGURED_SEED = {CONFIGURED_SEED!r}",
                f"EXPECTED_CANDIDATE_PROFILE = {SEED_43_PROFILE_ID!r}",
                (
                    "EXPECTED_REMOTE_RUNNER = "
                    "'scripts/run-neural-remote-training.py'"
                ),
                f"EXPECTED_TRAINER = {CTC_TRAINER!r}",
            ]
        ),
        "candidate output prefix",
    )
    _set_cell_source(cells[2], bootstrap)

    cells[0]["source"] = (
        "# Lekh Neural CUDA Training — seed-43 challenger\n\n"
        "This notebook trains the required second CTC candidate from the "
        "same checksum-pinned inputs as candidate one. Its only training "
        "change is seed 43. Candidate files, recovery, marker, and results "
        "stay under an isolated sibling scope ending `--seed-43`.\n"
    ).splitlines(keepends=True)
    cells[5]["source"] = (
        "## 3. Start the isolated seed-43 challenger\n\n"
        "The first invocation must pass `--restart-training`. Later "
        "invocations may resume only seed-43 recovery inside this notebook's "
        "dedicated working scope. Candidate-one output is an explicit "
        "fail-closed condition.\n"
    ).splitlines(keepends=True)
    verifier_sha256 = hashlib.sha256(
        verifier_module_source.encode("utf-8")
    ).hexdigest()
    wrapper_source = _challenger_wrapper_source(verifier_sha256)
    _set_cell_source(cells[6], _challenger_run_cell(wrapper_source))

    result_source = _cell_source(cells[8])
    result_source = _replace_once(
        result_source,
        "    return verification\n\ndef copy_verified_result",
        """
    files = manifest.get("files")
    expected_prefix = EXPECTED_CANDIDATE_PREFIX + "/"
    if (
        not isinstance(files, list)
        or not 3 <= len(files) <= 4
        or any(
            not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
            or not entry["path"].startswith(expected_prefix)
            for entry in files
        )
    ):
        raise RuntimeError(
            "Kaggle challenger result escaped its seed-43 candidate root."
        )
    return verification

def copy_verified_result""".strip(
            "\n"
        ),
        "result candidate-root validation",
    )
    _set_cell_source(cells[8], result_source)
    return notebook


def _challenger_run_cell(wrapper_source: str) -> str:
    wrapper_sha256 = hashlib.sha256(
        wrapper_source.encode("utf-8")
    ).hexdigest()
    return f"""
from pathlib import Path
import hashlib
import os
import stat
import subprocess

CHALLENGER_WRAPPER_SOURCE = {wrapper_source!r}
EXPECTED_CHALLENGER_WRAPPER_SHA256 = {wrapper_sha256!r}
CHALLENGER_WRAPPER_PATH = (
    BOOTSTRAP_ROOT / "run_seed_43_challenger.py"
)

def regular_file_sha256(path):
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"Unsafe seed-43 wrapper file: {{path}}")
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
                "Seed-43 wrapper changed before it was opened."
            )
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(descriptor)

def write_exact_wrapper(path, source):
    payload = source.encode("utf-8")
    if path.exists() or path.is_symlink():
        if (
            path.is_symlink()
            or not path.is_file()
            or path.read_bytes() != payload
        ):
            raise RuntimeError(
                "Existing seed-43 wrapper differs from notebook bytes."
            )
    else:
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
    observed = regular_file_sha256(path)
    if observed != EXPECTED_CHALLENGER_WRAPPER_SHA256:
        raise RuntimeError("Seed-43 wrapper digest is stale.")

write_exact_wrapper(
    CHALLENGER_WRAPPER_PATH,
    CHALLENGER_WRAPPER_SOURCE,
)
training_environment = os.environ.copy()
training_environment["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
training_environment["PYTHONHASHSEED"] = "43"
training_environment["PYTHONDONTWRITEBYTECODE"] = "1"
training_environment["PYTHONUNBUFFERED"] = "1"
command = [
    str(python),
    "-u",
    "-B",
    str(CHALLENGER_WRAPPER_PATH),
]
subprocess.run(
    command,
    cwd=BUNDLE_ROOT,
    env=training_environment,
    check=True,
)
""".strip()


def _challenger_wrapper_source(verifier_sha256: str) -> str:
    return f"""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import stat
import sys

WORKING_SCOPE = Path({CHALLENGER_WORKING_SCOPE!r})
BUNDLE_ROOT = WORKING_SCOPE / "bundle"
PERSISTENT_BASE = WORKING_SCOPE / "persistent"
BOOTSTRAP_ROOT = WORKING_SCOPE / "bootstrap"
EXPECTED_BUNDLE_ID = {ACTIVE_BUNDLE_REPORT_CONTRACT["bundleId"]!r}
EXPECTED_MODEL_ID = {CTC_MODEL_ID!r}
EXPECTED_CONFIG = {CTC_CONFIG!r}
EXPECTED_CANDIDATE_PREFIX = {CHALLENGER_CANDIDATE_PREFIX!r}
EXPECTED_CONFIGURED_CANDIDATE_PREFIX = {CANONICAL_CANDIDATE_PREFIX!r}
EXPECTED_CHALLENGER_SEED = {CHALLENGER_SEED!r}
EXPECTED_CONFIGURED_SEED = {CONFIGURED_SEED!r}
EXPECTED_CANDIDATE_PROFILE = {SEED_43_PROFILE_ID!r}
EXPECTED_REMOTE_RUNNER = "scripts/run-neural-remote-training.py"
EXPECTED_TRAINER = {CTC_TRAINER!r}
EXPECTED_VERIFIER_SHA256 = {verifier_sha256!r}
RUN_MARKER = WORKING_SCOPE / {CHALLENGER_MARKER!r}

def regular_file_sha256(path):
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"Unsafe authenticated verifier: {{path}}")
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(descriptor)

def load_authenticated_verifier():
    path = BOOTSTRAP_ROOT / "neural_remote_artifacts.py"
    if regular_file_sha256(path) != EXPECTED_VERIFIER_SHA256:
        raise RuntimeError("Authenticated verifier digest is stale.")
    specification = importlib.util.spec_from_file_location(
        "lekh_seed_43_archive_verifier",
        path,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the authenticated verifier.")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return module

def require_candidate_isolation():
    configured = BUNDLE_ROOT / EXPECTED_CONFIGURED_CANDIDATE_PREFIX
    challenger = BUNDLE_ROOT / EXPECTED_CANDIDATE_PREFIX
    if (
        configured.parent != challenger.parent
        or challenger.name != configured.name + {CHALLENGER_SUFFIX!r}
        or not str(WORKING_SCOPE).endswith({CHALLENGER_SUFFIX!r})
    ):
        raise RuntimeError("Seed-43 challenger roots are not exact siblings.")
    if configured.exists() or configured.is_symlink():
        raise RuntimeError(
            "Candidate-one state exists in the challenger bundle tree."
        )
    return challenger

def initialize_challenger_invocation(candidate_root):
    expected_marker = {{
        "schemaVersion": 1,
        "status": "initialized-kaggle-seed-43-training",
        "bundleId": EXPECTED_BUNDLE_ID,
        "modelId": EXPECTED_MODEL_ID,
        "candidateProfile": EXPECTED_CANDIDATE_PROFILE,
        "candidatePrefix": EXPECTED_CANDIDATE_PREFIX,
        "configuredSeed": EXPECTED_CONFIGURED_SEED,
        "effectiveSeed": EXPECTED_CHALLENGER_SEED,
        "storagePolicy": "kaggle-seed-43-only-v1",
    }}
    if RUN_MARKER.exists() or RUN_MARKER.is_symlink():
        if (
            RUN_MARKER.is_symlink()
            or not RUN_MARKER.is_file()
            or not 1 <= RUN_MARKER.stat().st_size <= 64 * 1024
        ):
            raise RuntimeError("Kaggle seed-43 run marker is unsafe.")
        observed = json.loads(RUN_MARKER.read_text(encoding="utf-8"))
        if observed != expected_marker:
            raise RuntimeError(
                "Kaggle seed-43 run marker is malformed or stale."
            )
        return False
    if candidate_root.exists() or candidate_root.is_symlink():
        raise RuntimeError(
            "Seed-43 candidate exists without its exact run marker."
        )
    if any(PERSISTENT_BASE.iterdir()):
        raise RuntimeError(
            "Seed-43 persistent scope is nonempty without its run marker."
        )
    payload = (
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
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())
    return True

def challenger_training_argv(first_invocation):
    argv = [
        "--config",
        str(BUNDLE_ROOT / EXPECTED_CONFIG),
        "--out-dir",
        str(BUNDLE_ROOT / EXPECTED_CANDIDATE_PREFIX),
        "--seed",
        str(EXPECTED_CHALLENGER_SEED),
        "--training-device",
        "cuda",
        "--skip-coreml",
    ]
    if first_invocation:
        argv.append("--restart-training")
    return argv

def expected_artifact_overrides():
    stems = {{
        "outDir": "",
        "compiledModel": "/LekhNeuralTransliterator.mlmodelc",
        "manifest": "/LekhNeuralTransliterator.manifest.json",
        "vocabMetadata": "/LekhNeuralTransliterator.vocab.json",
    }}
    return {{
        field: {{
            "configured": EXPECTED_CONFIGURED_CANDIDATE_PREFIX + suffix,
            "effective": EXPECTED_CANDIDATE_PREFIX + suffix,
            "source": "command-line" if field == "outDir" else "derived",
        }}
        for field, suffix in stems.items()
    }}

def validate_challenger_trainer_args(args, first_invocation):
    expected_training_overrides = {{
        "trainingRun.seed": {{
            "configured": EXPECTED_CONFIGURED_SEED,
            "effective": EXPECTED_CHALLENGER_SEED,
            "source": "command-line",
        }}
    }}
    if (
        args.model_id != EXPECTED_MODEL_ID
        or args.config.resolve()
            != (BUNDLE_ROOT / EXPECTED_CONFIG).resolve()
        or args.out_dir.resolve()
            != (BUNDLE_ROOT / EXPECTED_CANDIDATE_PREFIX).resolve()
        or args.seed != EXPECTED_CHALLENGER_SEED
        or args.restart_training is not first_invocation
        or args.training_overrides != expected_training_overrides
        or args.artifact_overrides != expected_artifact_overrides()
        or args.execution_modes != {{
            "skipTrain": False,
            "skipCoreML": True,
            "trainingDevice": "cuda",
        }}
    ):
        raise RuntimeError(
            "Parsed trainer args violate the exact seed-43 profile."
        )

def load_authenticated_remote_runner():
    runner_path = remote_artifacts.contained_regular_file(
        BUNDLE_ROOT,
        EXPECTED_REMOTE_RUNNER,
    )
    specification = importlib.util.spec_from_file_location(
        "lekh_seed_43_remote_runner",
        runner_path,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the authenticated remote runner.")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    if module.ROOT.resolve() != BUNDLE_ROOT.resolve():
        raise RuntimeError("Authenticated remote runner resolved another root.")
    return module

sys.dont_write_bytecode = True
remote_artifacts = load_authenticated_verifier()
candidate_root = require_candidate_isolation()
first_invocation = initialize_challenger_invocation(candidate_root)
verified_manifest = remote_artifacts.verify_extracted_tree(
    BUNDLE_ROOT,
    expected_kind=remote_artifacts.BUNDLE_KIND,
    allowed_output_prefixes=(EXPECTED_CANDIDATE_PREFIX,),
)
runner = load_authenticated_remote_runner()
bundle_manifest = runner.read_json_object(
    runner.contained_regular_file(
        BUNDLE_ROOT,
        "NEURAL_REMOTE_BUNDLE_MANIFEST.json",
    )
)
if bundle_manifest != verified_manifest:
    raise RuntimeError("Authenticated bundle manifest changed before training.")
persistent_dir = runner.prepare_persistent_directory(
    PERSISTENT_BASE,
    EXPECTED_BUNDLE_ID,
    EXPECTED_MODEL_ID,
)
toolchain = runner.verify_toolchain()
trainer = runner.import_trainer(
    EXPECTED_TRAINER,
    config_relative=EXPECTED_CONFIG,
)
trainer_args = trainer.parse_args(
    challenger_training_argv(first_invocation),
    {{}},
)
validate_challenger_trainer_args(trainer_args, first_invocation)
recovery_root = (
    persistent_dir
    / "recovery"
    / EXPECTED_BUNDLE_ID
    / EXPECTED_MODEL_ID
    / "seed-43"
)

with trainer.exclusive_run_lock(trainer_args):
    runner.cleanup_orphaned_input_snapshots(trainer_args.out_dir)
    existing_complete = runner.complete_training_artifacts_exist(
        trainer,
        trainer_args,
    )
    if (
        existing_complete
        and not trainer.training_recovery_state_files(trainer_args)
        and not trainer.training_recovery_metadata_path(
            trainer_args
        ).exists()
    ):
        loaded = trainer.load_checkpoint(trainer_args)
        training_report = loaded["report"]
    else:
        if not first_invocation:
            runner.restore_latest_recovery(
                trainer,
                trainer_args,
                recovery_root,
                bundle_id=EXPECTED_BUNDLE_ID,
                model_id=EXPECTED_MODEL_ID,
                config_relative=EXPECTED_CONFIG,
            )
        trainer_args.training_epoch_hook = (
            lambda epoch_result, state_path: runner.mirror_recovery(
                trainer,
                trainer_args,
                recovery_root,
                state_path,
                epoch_result,
                bundle_id=EXPECTED_BUNDLE_ID,
                model_id=EXPECTED_MODEL_ID,
                config_relative=EXPECTED_CONFIG,
            )
        )
        try:
            export_report = trainer.run_pipeline(trainer_args)
        finally:
            trainer.cleanup_run_input_snapshot(trainer_args)
        if export_report.get("status") != (
            "passed-training-candidate-coreml-export-skipped"
        ):
            raise RuntimeError(
                "Seed-43 CUDA run did not publish a complete candidate."
            )
        training_report = runner.read_json_object(
            trainer.training_report_path(trainer_args)
        )

runner.validate_completed_training_report(
    training_report,
    bundle_id=EXPECTED_BUNDLE_ID,
    model_id=EXPECTED_MODEL_ID,
)
if (
    training_report.get("configuredTrainingConfig", {{}})
        .get("trainingRun", {{}}).get("seed")
        != EXPECTED_CONFIGURED_SEED
    or training_report.get("effectiveTrainingConfig", {{}})
        .get("trainingRun", {{}}).get("seed")
        != EXPECTED_CHALLENGER_SEED
    or training_report.get("trainingOverrides") != {{
        "trainingRun.seed": {{
            "configured": EXPECTED_CONFIGURED_SEED,
            "effective": EXPECTED_CHALLENGER_SEED,
            "source": "command-line",
        }}
    }}
    or training_report.get("artifactOverrides")
        != expected_artifact_overrides()
    or not str(training_report.get("checkpoint", "")).startswith(
        EXPECTED_CANDIDATE_PREFIX + "/"
    )
):
    raise RuntimeError(
        "Completed report lost the exact seed-43 candidate identity."
    )

result = runner.publish_result_archive(
    trainer,
    trainer_args,
    persistent_dir,
    bundle_manifest=bundle_manifest,
    toolchain=toolchain,
    compression_level=1,
)
print(json.dumps({{
    **result,
    "candidateProfile": EXPECTED_CANDIDATE_PROFILE,
    "candidatePrefix": EXPECTED_CANDIDATE_PREFIX,
    "configuredSeed": EXPECTED_CONFIGURED_SEED,
    "effectiveSeed": EXPECTED_CHALLENGER_SEED,
    "restartTraining": first_invocation,
    "externalRecoveryImported": False,
}}, indent=2, sort_keys=True))
""".strip()


def _validate_challenger_bundle_report(
    report: dict[str, Any],
) -> None:
    if not isinstance(report, dict):
        raise KaggleNotebookError("Challenger bundle report is not an object.")
    manifest = report.get("manifest")
    observed = {
        "archiveBytes": report.get("archiveBytes"),
        "archiveSha256": report.get("archiveSha256"),
        "bundleId": report.get("bundleId"),
        "modelId": (
            manifest.get("modelId")
            if isinstance(manifest, dict)
            else None
        ),
        "trainingConfig": (
            manifest.get("trainingConfig")
            if isinstance(manifest, dict)
            else None
        ),
    }
    expected = {
        field: ACTIVE_BUNDLE_REPORT_CONTRACT[field]
        for field in observed
    }
    if observed != expected:
        raise KaggleNotebookError(
            "Challenger notebook supports only the exact active CTC bundle."
        )


def _cell_source(cell: dict[str, Any]) -> str:
    source = cell.get("source")
    if not isinstance(source, list) or not all(
        isinstance(line, str) for line in source
    ):
        raise KaggleNotebookError("Notebook cell source is malformed.")
    return "".join(source)


def _set_cell_source(cell: dict[str, Any], source: str) -> None:
    cell["source"] = source.splitlines(keepends=True)


def _replace_once(
    source: str,
    old: str,
    new: str,
    label: str,
) -> str:
    if source.count(old) != 1:
        raise KaggleNotebookError(
            f"Base notebook {label} binding changed unexpectedly."
        )
    return source.replace(old, new, 1)


__all__ = [
    "CHALLENGER_CANDIDATE_PREFIX",
    "CHALLENGER_WORKING_SCOPE",
    "build_kaggle_challenger_notebook",
    "notebook_bytes",
]
