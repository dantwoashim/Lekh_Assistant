#!/usr/bin/env python3
"""Train and export Lekh's open-vocabulary character seq2seq transliterator.

This script intentionally creates a real encoder/decoder checkpoint and a Core ML
graph candidate. It does not mark the model production-eligible unless the
separate production review, evaluation, benchmark, and native integration gates
prove that claim.
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import io
import json
import math
import os
import platform
import random
import re
import shutil
import stat
import subprocess
import sys
import time
import unicodedata
import uuid
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

try:
    import coremltools as ct
except Exception as error:  # pragma: no cover - dependency/environment guard.
    ct = None
    COREML_IMPORT_ERROR = error
else:
    COREML_IMPORT_ERROR = None


ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "lekh-open-vocab-seq2seq-v1"
VOCAB_METADATA_PATH = ROOT / "models/macos/LekhNeuralTransliterator.vocab.json"
GOLD_MANIFEST_PATH = ROOT / "data/neural/gold/manifest.v2.json"
CONFIG_PATH = ROOT / "data/neural/training/open-vocab-seq2seq-v1.config.json"

PAD = "<pad>"
SOS = "<s>"
EOS = "</s>"
UNK = "<unk>"
SPECIAL = [PAD, SOS, EOS, UNK]

REQUIRED_CASES = {
    "vato": "बाटो",
    "bato": "बाटो",
    "baato": "बाटो",
    "chha": "छ",
    "cha": "छ",
    "xa": "छ",
    "xaina": "छैन",
}

RUN_IDENTIFIER_PATTERN = re.compile(r"^[a-f0-9]{32}$")
MAX_COMPILED_MODEL_BYTES = 16 * 1024 * 1024
MAX_COMPILED_MODEL_FILES = 10_000
COREML_PARITY_RTOL = 5e-3
COREML_PARITY_ATOL = 5e-3


def checkpoint_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "checkpoint.pt"


def training_report_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "training-report.json"


def export_report_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "export-report.json"


def predictions_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "gold-predictions.jsonl"


def measurements_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "coreml-device-measurements.json"


def mlpackage_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "LekhNeuralTransliterator.mlpackage"


def parse_args(argv: list[str] | None = None, environment: dict[str, str] | None = None) -> argparse.Namespace:
    argv = list(sys.argv[1:] if argv is None else argv)
    environment = dict(os.environ if environment is None else environment)

    config_parser = argparse.ArgumentParser(add_help=False)
    config_parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    config_args, _ = config_parser.parse_known_args(argv)
    config_path = config_args.config.resolve()
    if not config_path.is_file():
        raise SystemExit(f"Missing training config: {config_path}")
    config = read_json(config_path)
    validate_executable_config(config)

    architecture = config["architecture"]
    decoder = config["decoder"]
    training = config["training"]
    training_run = config["trainingRun"]
    early_stopping = training_run["earlyStopping"]
    encoder_layers = int(architecture["encoderLayers"])
    decoder_layers = int(architecture["decoderLayers"])
    if encoder_layers != decoder_layers:
        raise SystemExit("The current GRU implementation requires matching encoderLayers and decoderLayers.")

    parser = argparse.ArgumentParser(description=__doc__, parents=[config_parser])
    parser.add_argument("--dataset-manifest", type=Path, default=ROOT / training["datasetManifest"])
    parser.add_argument("--gold-manifest", type=Path, default=GOLD_MANIFEST_PATH)
    parser.add_argument("--out-dir", type=Path, default=(ROOT / config["export"]["sourceCheckpoint"]).parent)
    parser.add_argument("--compiled-model", type=Path, default=ROOT / config["export"]["compiledModel"])
    parser.add_argument("--manifest", type=Path, default=ROOT / config["export"]["manifest"])
    parser.add_argument("--vocab-metadata", type=Path, default=VOCAB_METADATA_PATH)
    add_configurable_argument(parser, "--max-train-rows", int, training_run["maximumTrainRows"], "LEKH_NEURAL_MAX_TRAIN_ROWS", environment)
    add_configurable_argument(parser, "--max-dev-rows", int, training_run["maximumDevRows"], "LEKH_NEURAL_MAX_DEV_ROWS", environment)
    add_configurable_argument(parser, "--epochs", int, training_run["maximumEpochs"], "LEKH_NEURAL_EPOCHS", environment)
    add_configurable_argument(parser, "--batch-size", int, training_run["batchSize"], "LEKH_NEURAL_BATCH_SIZE", environment)
    add_configurable_argument(parser, "--embedding-dim", int, architecture["embeddingDim"], "LEKH_NEURAL_EMBEDDING_DIM", environment)
    add_configurable_argument(parser, "--hidden-dim", int, architecture["hiddenDim"], "LEKH_NEURAL_HIDDEN_DIM", environment)
    add_configurable_argument(parser, "--layers", int, encoder_layers, "LEKH_NEURAL_LAYERS", environment)
    add_configurable_argument(parser, "--dropout", float, architecture["dropout"], "LEKH_NEURAL_DROPOUT", environment)
    add_configurable_argument(parser, "--max-input-len", int, decoder["maxInputGraphemes"], "LEKH_NEURAL_MAX_INPUT_LEN", environment)
    add_configurable_argument(parser, "--max-output-len", int, decoder["maxOutputGraphemes"], "LEKH_NEURAL_MAX_OUTPUT_LEN", environment)
    add_configurable_argument(parser, "--beam-width", int, decoder["beamWidth"], "LEKH_NEURAL_BEAM_WIDTH", environment)
    add_configurable_argument(parser, "--maximum-candidates", int, decoder["maximumCandidates"], "LEKH_NEURAL_MAXIMUM_CANDIDATES", environment)
    add_configurable_argument(parser, "--learning-rate", float, training_run["learningRate"], "LEKH_NEURAL_LEARNING_RATE", environment)
    add_configurable_argument(parser, "--label-smoothing", float, training_run["labelSmoothing"], "LEKH_NEURAL_LABEL_SMOOTHING", environment)
    add_configurable_argument(parser, "--gradient-clip-norm", float, training_run["gradientClipNorm"], "LEKH_NEURAL_GRADIENT_CLIP_NORM", environment)
    add_configurable_argument(parser, "--early-stopping-patience", int, early_stopping["patienceEpochs"], "LEKH_NEURAL_EARLY_STOPPING_PATIENCE", environment)
    add_configurable_argument(parser, "--early-stopping-min-delta", float, early_stopping["minimumDelta"], "LEKH_NEURAL_EARLY_STOPPING_MIN_DELTA", environment)
    add_configurable_argument(parser, "--seed", int, training_run["seed"], "LEKH_NEURAL_SEED", environment)
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--skip-coreml", action="store_true")
    args = parser.parse_args(argv)
    validate_effective_args(args, early_stopping)
    validate_output_paths(args)
    args.training_config = config
    args.training_contract_sha256 = sha256_file(config_path)
    args.config = config_path
    args.early_stopping_enabled = bool(early_stopping["enabled"])
    args.early_stopping_metric = str(early_stopping["metric"])
    args.restore_best_weights = bool(early_stopping["restoreBestWeights"])
    args.configured_training_config = configured_training_config(config)
    args.effective_training_config = effective_training_config(args, config)
    args.effective_training_config_canonical_json = canonical_json_text(args.effective_training_config)
    args.effective_training_config_sha256 = sha256_text(args.effective_training_config_canonical_json)
    args.training_overrides = collect_training_overrides(
        argv,
        environment,
        args.configured_training_config,
        args.effective_training_config,
    )
    args.configured_artifact_inputs = configured_artifact_inputs(config_path, config)
    args.effective_artifact_inputs = effective_artifact_inputs(args)
    args.effective_artifact_inputs_canonical_json = canonical_json_text(args.effective_artifact_inputs)
    args.effective_artifact_inputs_sha256 = sha256_text(args.effective_artifact_inputs_canonical_json)
    args.artifact_overrides = collect_artifact_overrides(
        argv,
        args.configured_artifact_inputs,
        args.effective_artifact_inputs,
    )
    args.execution_modes = {"skipTrain": bool(args.skip_train), "skipCoreML": bool(args.skip_coreml)}
    args.training_run_id = None
    args.export_run_id = uuid.uuid4().hex
    return args


def add_configurable_argument(
    parser: argparse.ArgumentParser,
    option: str,
    cast: type[int] | type[float],
    configured: Any,
    environment_name: str,
    environment: dict[str, str],
) -> None:
    default = cast(environment[environment_name]) if environment_name in environment else cast(configured)
    parser.add_argument(option, type=cast, default=default)


def validate_executable_config(config: dict[str, Any]) -> None:
    if config.get("schemaVersion") != 2 or config.get("implementationContractVersion") != 1:
        raise SystemExit("Training config must use schemaVersion 2 and implementationContractVersion 1.")
    if config.get("modelId") != MODEL_ID:
        raise SystemExit(f"Training config modelId must be {MODEL_ID}.")
    architecture = config.get("architecture") or {}
    if architecture.get("family") != "gru-encoder-decoder-seq2seq":
        raise SystemExit("Only the executable GRU encoder-decoder seq2seq architecture is supported.")
    if architecture.get("attention") != "none":
        raise SystemExit("Attention is not implemented; the executable training config must declare attention=none.")
    context = config.get("context") or {}
    if int(context.get("previousWords", -1)) != 0 or (context.get("languageModelRescorer") or {}).get("enabled") is not False:
        raise SystemExit("Context rescoring is not implemented; the executable config must keep it disabled.")
    if config.get("training", {}).get("loss") != "weighted-label-smoothed-sequence-cross-entropy":
        raise SystemExit("Training config must declare the implemented weighted label-smoothed loss.")
    expected_sampling_policy = {
        "type": "deterministic-source-stratified-sampling",
        "version": 1,
        "sourceQuotaWeight": "square-root-of-source-row-count",
        "sourceMultipliers": {},
        "pinnedSources": [
            "lekh-phase1-contract-seed-v1",
            "human-reviewed-lekh-gold-v1",
            "lekh-chat-conventions-v1",
            "lekh-name-lexicon-v1",
        ],
    }
    if config.get("training", {}).get("samplingPolicy") != expected_sampling_policy:
        raise SystemExit("Training config samplingPolicy must match the executable deterministic source-stratified policy.")
    expected_export = {
        "sourceCheckpoint": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/checkpoint.pt",
        "intermediateMLPackage": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.mlpackage",
        "compiledModel": "models/macos/LekhNeuralTransliterator.mlmodelc",
        "manifest": "models/macos/LekhNeuralTransliterator.manifest.json",
    }
    for field, expected in expected_export.items():
        if config.get("export", {}).get(field) != expected:
            raise SystemExit(f"Training config export.{field} must equal {expected}.")
    if config.get("artifact", {}).get("compiledModel") != expected_export["compiledModel"]:
        raise SystemExit("Training config artifact.compiledModel must match export.compiledModel.")
    if config.get("artifact", {}).get("manifest") != expected_export["manifest"]:
        raise SystemExit("Training config artifact.manifest must match export.manifest.")


def validate_effective_args(args: argparse.Namespace, early_stopping: dict[str, Any]) -> None:
    positive_integer_fields = {
        "max_train_rows": args.max_train_rows,
        "max_dev_rows": args.max_dev_rows,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "embedding_dim": args.embedding_dim,
        "hidden_dim": args.hidden_dim,
        "layers": args.layers,
        "max_input_len": args.max_input_len,
        "max_output_len": args.max_output_len,
        "beam_width": args.beam_width,
        "maximum_candidates": args.maximum_candidates,
        "early_stopping_patience": args.early_stopping_patience,
    }
    invalid = [name for name, value in positive_integer_fields.items() if int(value) <= 0]
    if invalid:
        raise SystemExit(f"Training arguments must be positive integers: {', '.join(invalid)}")
    numeric_fields = {
        "dropout": args.dropout,
        "label_smoothing": args.label_smoothing,
        "learning_rate": args.learning_rate,
        "gradient_clip_norm": args.gradient_clip_norm,
        "early_stopping_min_delta": args.early_stopping_min_delta,
    }
    non_finite = [name for name, value in numeric_fields.items() if not math.isfinite(float(value))]
    if non_finite:
        raise SystemExit(f"Training arguments must be finite: {', '.join(non_finite)}")
    if not 0 <= args.dropout < 1:
        raise SystemExit("dropout must be in [0, 1).")
    if not 0 <= args.label_smoothing < 1:
        raise SystemExit("label-smoothing must be in [0, 1).")
    if args.learning_rate <= 0 or args.gradient_clip_norm <= 0 or args.early_stopping_min_delta < 0:
        raise SystemExit("learning-rate and gradient-clip-norm must be positive; early-stopping-min-delta cannot be negative.")
    if args.max_input_len < 2 or args.max_output_len < 2:
        raise SystemExit("Input and output lengths must reserve space for end-of-sequence tokens.")
    if not 2 <= args.beam_width <= 8:
        raise SystemExit("beam-width must be in [2, 8].")
    if not 1 <= args.maximum_candidates <= 8:
        raise SystemExit("maximum-candidates must be in [1, 8].")
    if args.maximum_candidates != args.beam_width:
        raise SystemExit("The native decoder contract requires maximum-candidates to equal beam-width.")
    if early_stopping.get("enabled") is not True or early_stopping.get("restoreBestWeights") is not True:
        raise SystemExit("This training contract requires enabled early stopping with best-weight restoration.")


def validate_output_paths(args: argparse.Namespace) -> None:
    temporary_root = ROOT / ".tmp"
    generated_root = ROOT / "data/generated/neural-open-vocab-model"
    model_root = ROOT / "models/macos"
    require_safe_output_path(args.out_dir, [generated_root, temporary_root], "output directory", directory=True)
    require_safe_output_path(args.compiled_model, [model_root, temporary_root], "compiled model", suffix=".mlmodelc", directory=True)
    require_safe_output_path(args.manifest, [model_root, temporary_root], "runtime manifest", suffix=".json")
    require_safe_output_path(args.vocab_metadata, [model_root, temporary_root], "vocabulary metadata", suffix=".json")


def require_safe_output_path(
    path: Path,
    allowed_roots: list[Path],
    label: str,
    *,
    suffix: str | None = None,
    directory: bool = False,
) -> None:
    resolved = path.resolve()
    resolved_roots = [root.resolve() for root in allowed_roots]
    if any(resolved == root for root in resolved_roots):
        raise SystemExit(f"Refusing to use broad {label} path: {resolved}")
    if not any(is_relative_to(resolved, root) for root in resolved_roots):
        raise SystemExit(f"{label.capitalize()} must remain under an approved repository artifact directory: {resolved}")
    if suffix and not resolved.name.endswith(suffix):
        raise SystemExit(f"{label.capitalize()} must end with {suffix}: {resolved}")
    wrong_existing_type = path.exists() and (not path.is_dir() if directory else not path.is_file())
    if path.is_symlink() or wrong_existing_type:
        raise SystemExit(f"Refusing unsafe {label} path: {path}")


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def configured_training_config(config: dict[str, Any]) -> dict[str, Any]:
    architecture = config["architecture"]
    decoder = config["decoder"]
    training_run = config["trainingRun"]
    early_stopping = training_run["earlyStopping"]
    return {
        "architecture": {
            "family": architecture["family"],
            "encoderLayers": int(architecture["encoderLayers"]),
            "decoderLayers": int(architecture["decoderLayers"]),
            "embeddingDim": int(architecture["embeddingDim"]),
            "hiddenDim": int(architecture["hiddenDim"]),
            "attention": architecture["attention"],
            "dropout": float(architecture["dropout"]),
        },
        "decoder": {
            "type": decoder["type"],
            "beamWidth": int(decoder["beamWidth"]),
            "maxInputGraphemes": int(decoder["maxInputGraphemes"]),
            "maxOutputGraphemes": int(decoder["maxOutputGraphemes"]),
            "maximumCandidates": int(decoder["maximumCandidates"]),
        },
        "trainingRun": {
            "seed": int(training_run["seed"]),
            "maximumTrainRows": int(training_run["maximumTrainRows"]),
            "maximumDevRows": int(training_run["maximumDevRows"]),
            "maximumEpochs": int(training_run["maximumEpochs"]),
            "batchSize": int(training_run["batchSize"]),
            "learningRate": float(training_run["learningRate"]),
            "labelSmoothing": float(training_run["labelSmoothing"]),
            "gradientClipNorm": float(training_run["gradientClipNorm"]),
            "earlyStopping": {
                "enabled": bool(early_stopping["enabled"]),
                "metric": early_stopping["metric"],
                "patienceEpochs": int(early_stopping["patienceEpochs"]),
                "minimumDelta": float(early_stopping["minimumDelta"]),
                "restoreBestWeights": bool(early_stopping["restoreBestWeights"]),
            },
        },
    }


def effective_training_config(args: argparse.Namespace, config: dict[str, Any]) -> dict[str, Any]:
    effective = copy.deepcopy(configured_training_config(config))
    architecture = effective["architecture"]
    architecture.update({
        "encoderLayers": args.layers,
        "decoderLayers": args.layers,
        "embeddingDim": args.embedding_dim,
        "hiddenDim": args.hidden_dim,
        "dropout": args.dropout,
    })
    decoder = effective["decoder"]
    decoder.update({
        "beamWidth": args.beam_width,
        "maxInputGraphemes": args.max_input_len,
        "maxOutputGraphemes": args.max_output_len,
        "maximumCandidates": args.maximum_candidates,
    })
    training_run = effective["trainingRun"]
    training_run.update({
        "seed": args.seed,
        "maximumTrainRows": args.max_train_rows,
        "maximumDevRows": args.max_dev_rows,
        "maximumEpochs": args.epochs,
        "batchSize": args.batch_size,
        "learningRate": args.learning_rate,
        "labelSmoothing": args.label_smoothing,
        "gradientClipNorm": args.gradient_clip_norm,
    })
    training_run["earlyStopping"].update({
        "patienceEpochs": args.early_stopping_patience,
        "minimumDelta": args.early_stopping_min_delta,
    })
    return effective


def configured_artifact_inputs(config_path: Path, config: dict[str, Any]) -> dict[str, Any]:
    checkpoint = ROOT / config["export"]["sourceCheckpoint"]
    return {
        "trainingConfig": artifact_path_value(config_path),
        "datasetManifest": artifact_path_value(ROOT / config["training"]["datasetManifest"]),
        "goldManifest": artifact_path_value(GOLD_MANIFEST_PATH),
        "outDir": artifact_path_value(checkpoint.parent),
        "compiledModel": artifact_path_value(ROOT / config["export"]["compiledModel"]),
        "manifest": artifact_path_value(ROOT / config["export"]["manifest"]),
        "vocabMetadata": artifact_path_value(VOCAB_METADATA_PATH),
    }


def effective_artifact_inputs(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "trainingConfig": artifact_path_value(args.config),
        "datasetManifest": artifact_path_value(args.dataset_manifest),
        "goldManifest": artifact_path_value(args.gold_manifest),
        "outDir": artifact_path_value(args.out_dir),
        "compiledModel": artifact_path_value(args.compiled_model),
        "manifest": artifact_path_value(args.manifest),
        "vocabMetadata": artifact_path_value(args.vocab_metadata),
    }


def collect_artifact_overrides(
    argv: list[str],
    configured: dict[str, Any],
    effective: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    options = {
        "datasetManifest": "--dataset-manifest",
        "goldManifest": "--gold-manifest",
        "outDir": "--out-dir",
        "compiledModel": "--compiled-model",
        "manifest": "--manifest",
        "vocabMetadata": "--vocab-metadata",
    }
    overrides: dict[str, dict[str, Any]] = {}
    for field, option in options.items():
        if configured[field] == effective[field]:
            continue
        overrides[field] = {
            "configured": configured[field],
            "effective": effective[field],
            "source": "command-line" if option_present(argv, option) else "derived",
        }
    return overrides


def artifact_path_value(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return str(resolved)


def collect_training_overrides(
    argv: list[str],
    environment: dict[str, str],
    configured: dict[str, Any],
    effective: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    bindings = {
        "architecture.encoderLayers": ("--layers", "LEKH_NEURAL_LAYERS"),
        "architecture.decoderLayers": ("--layers", "LEKH_NEURAL_LAYERS"),
        "architecture.embeddingDim": ("--embedding-dim", "LEKH_NEURAL_EMBEDDING_DIM"),
        "architecture.hiddenDim": ("--hidden-dim", "LEKH_NEURAL_HIDDEN_DIM"),
        "architecture.dropout": ("--dropout", "LEKH_NEURAL_DROPOUT"),
        "decoder.beamWidth": ("--beam-width", "LEKH_NEURAL_BEAM_WIDTH"),
        "decoder.maxInputGraphemes": ("--max-input-len", "LEKH_NEURAL_MAX_INPUT_LEN"),
        "decoder.maxOutputGraphemes": ("--max-output-len", "LEKH_NEURAL_MAX_OUTPUT_LEN"),
        "decoder.maximumCandidates": ("--maximum-candidates", "LEKH_NEURAL_MAXIMUM_CANDIDATES"),
        "trainingRun.seed": ("--seed", "LEKH_NEURAL_SEED"),
        "trainingRun.maximumTrainRows": ("--max-train-rows", "LEKH_NEURAL_MAX_TRAIN_ROWS"),
        "trainingRun.maximumDevRows": ("--max-dev-rows", "LEKH_NEURAL_MAX_DEV_ROWS"),
        "trainingRun.maximumEpochs": ("--epochs", "LEKH_NEURAL_EPOCHS"),
        "trainingRun.batchSize": ("--batch-size", "LEKH_NEURAL_BATCH_SIZE"),
        "trainingRun.learningRate": ("--learning-rate", "LEKH_NEURAL_LEARNING_RATE"),
        "trainingRun.labelSmoothing": ("--label-smoothing", "LEKH_NEURAL_LABEL_SMOOTHING"),
        "trainingRun.gradientClipNorm": ("--gradient-clip-norm", "LEKH_NEURAL_GRADIENT_CLIP_NORM"),
        "trainingRun.earlyStopping.patienceEpochs": ("--early-stopping-patience", "LEKH_NEURAL_EARLY_STOPPING_PATIENCE"),
        "trainingRun.earlyStopping.minimumDelta": ("--early-stopping-min-delta", "LEKH_NEURAL_EARLY_STOPPING_MIN_DELTA"),
    }
    overrides: dict[str, dict[str, Any]] = {}
    for dotted_path, (option, environment_name) in bindings.items():
        source = None
        if option_present(argv, option):
            source = "command-line"
        elif environment_name in environment:
            source = f"environment:{environment_name}"
        if source:
            configured_value = nested_value(configured, dotted_path)
            effective_value = nested_value(effective, dotted_path)
            if configured_value == effective_value:
                continue
            overrides[dotted_path] = {
                "configured": configured_value,
                "effective": effective_value,
                "source": source,
            }
    return overrides


def option_present(argv: list[str], option: str) -> bool:
    return any(argument == option or argument.startswith(f"{option}=") for argument in argv)


def nested_value(payload: dict[str, Any], dotted_path: str) -> Any:
    value: Any = payload
    for component in dotted_path.split("."):
        value = value[component]
    return value


def rel(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(ROOT))
    except ValueError:
        return str(resolved)


def nfc(value: str) -> str:
    return unicodedata.normalize("NFC", str(value or "").strip())


def normalize_input(value: str) -> str:
    return " ".join(nfc(value).lower().split())


def graphemes(value: str) -> list[str]:
    # Nepali matras/virama/anusvara bind to the previous base code point.
    output: list[str] = []
    for char in nfc(value):
        if output and ("\u093c" <= char <= "\u094d" or "\u0951" <= char <= "\u0957" or char in "ँंः"):
            output[-1] += char
        else:
            output.append(char)
    return output


def require_repo_regular_file(path: Path, label: str = "artifact") -> Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise SystemExit(f"Missing {label}: {path}") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"Refusing non-regular or symbolic-link {label}: {path}")
    resolved = path.resolve(strict=True)
    if not is_relative_to(resolved, ROOT.resolve()):
        raise SystemExit(f"{label.capitalize()} must remain inside the repository: {resolved}")
    return resolved


def open_regular_binary(path: Path, label: str = "artifact"):
    resolved = require_repo_regular_file(path, label)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(resolved, flags)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        raise SystemExit(f"Refusing non-regular {label}: {resolved}")
    return os.fdopen(descriptor, "rb")


def read_json(path: Path) -> dict[str, Any]:
    with open_regular_binary(path, "JSON artifact") as handle:
        payload = handle.read(16 * 1024 * 1024 + 1)
    if len(payload) > 16 * 1024 * 1024:
        raise SystemExit(f"JSON artifact exceeds the 16 MiB safety limit: {path}")
    try:
        parsed = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Invalid UTF-8 JSON artifact: {path}") from error
    if not isinstance(parsed, dict):
        raise SystemExit(f"JSON artifact must contain an object: {path}")
    return parsed


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open_regular_binary(path) as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_text(canonical_json_text(value))


def canonical_json_text(value: Any) -> str:
    return json.dumps(canonical_json_value(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonical_json_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [canonical_json_value(child) for child in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def secure_directory_files(
    path: Path,
    *,
    require_repo_containment: bool = True,
    maximum_files: int = MAX_COMPILED_MODEL_FILES,
    maximum_bytes: int = MAX_COMPILED_MODEL_BYTES,
) -> tuple[Path, list[tuple[str, Path, int]]]:
    try:
        root_metadata = path.lstat()
    except FileNotFoundError as error:
        raise SystemExit(f"Missing directory artifact: {path}") from error
    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        raise SystemExit(f"Refusing non-directory or symbolic-link artifact: {path}")
    resolved_root = path.resolve(strict=True)
    if require_repo_containment and not is_relative_to(resolved_root, ROOT.resolve()):
        raise SystemExit(f"Directory artifact must remain inside the repository: {resolved_root}")

    files: list[tuple[str, Path, int]] = []
    total_bytes = 0
    pending: list[tuple[Path, Path]] = [(resolved_root, Path())]
    while pending:
        current, relative_parent = pending.pop()
        with os.scandir(current) as entries:
            for entry in entries:
                metadata = entry.stat(follow_symlinks=False)
                relative_path = relative_parent / entry.name
                entry_path = Path(entry.path)
                if stat.S_ISLNK(metadata.st_mode):
                    raise SystemExit(f"Directory artifact contains a symbolic link: {relative_path}")
                if stat.S_ISDIR(metadata.st_mode):
                    pending.append((entry_path, relative_path))
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    raise SystemExit(f"Directory artifact contains a special file: {relative_path}")
                total_bytes += metadata.st_size
                files.append((relative_path.as_posix(), entry_path, metadata.st_size))
                if len(files) > maximum_files:
                    raise SystemExit(f"Directory artifact exceeds the {maximum_files}-file safety limit: {path}")
                if total_bytes > maximum_bytes:
                    raise SystemExit(f"Directory artifact exceeds the {maximum_bytes}-byte safety limit: {path}")
    if not files:
        raise SystemExit(f"Directory artifact contains no regular files: {path}")
    return resolved_root, sorted(files, key=lambda item: item[0])


def directory_sha256(path: Path) -> str:
    _, files = secure_directory_files(path)
    digest = hashlib.sha256()
    for relative_path, file, _ in files:
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        with open_regular_binary(file, "compiled-model member") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def directory_bytes(path: Path) -> int:
    _, files = secure_directory_files(path)
    return sum(size for _, _, size in files)


def staging_sibling(path: Path, label: str) -> Path:
    nonce = f"{os.getpid()}.{time.time_ns()}"
    suffix = "".join(path.suffixes)
    stem = path.name[:-len(suffix)] if suffix else path.name
    return path.with_name(f".{stem}.{label}.{nonce}{suffix}")


def is_run_identifier(value: Any) -> bool:
    return isinstance(value, str) and RUN_IDENTIFIER_PATTERN.fullmatch(value) is not None


@contextmanager
def exclusive_run_lock(args: argparse.Namespace) -> Iterator[Path]:
    """Serialize the complete checkpoint/export publication transaction."""
    args.out_dir.mkdir(parents=True, exist_ok=True)
    lock_path = args.out_dir / ".training-export.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise SystemExit(f"Unable to open the neural publication lock safely: {lock_path}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f"Neural publication lock is not a regular file: {lock_path}")
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SystemExit(
                f"Another neural training/export run owns the publication lock: {lock_path}"
            ) from error

        def record(status_value: str) -> None:
            payload = json.dumps({
                "schemaVersion": 1,
                "status": status_value,
                "pid": os.getpid(),
                "exportRunId": args.export_run_id,
                "trainingRunId": args.training_run_id,
                "updatedAt": iso_now(),
            }, ensure_ascii=False, sort_keys=True).encode("utf-8") + b"\n"
            os.lseek(descriptor, 0, os.SEEK_SET)
            os.ftruncate(descriptor, 0)
            os.write(descriptor, payload)
            os.fsync(descriptor)

        record("running")
        try:
            yield lock_path
        except BaseException:
            record("failed")
            raise
        else:
            record("completed")
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def publish_directory(staging: Path, target: Path) -> None:
    if staging.is_symlink() or not staging.is_dir():
        raise RuntimeError(f"Staged artifact is not a safe directory: {staging}")
    if staging.resolve().parent != target.resolve().parent:
        raise RuntimeError("Staged and target artifact directories must share a parent filesystem.")
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise RuntimeError(f"Refusing to replace unsafe artifact target: {target}")
    backup = staging_sibling(target, "backup")
    if backup.exists() or backup.is_symlink():
        raise RuntimeError(f"Artifact backup path unexpectedly exists: {backup}")
    moved_existing = False
    try:
        if target.exists():
            target.rename(backup)
            moved_existing = True
        os.replace(staging, target)
    except Exception:
        if moved_existing and not target.exists() and backup.exists():
            os.replace(backup, target)
        raise
    if moved_existing:
        safe_remove_sibling_directory(backup, target.parent)


def safe_remove_sibling_directory(path: Path, approved_parent: Path) -> None:
    if not path.exists():
        return
    if path.is_symlink() or not path.is_dir() or path.resolve().parent != approved_parent.resolve():
        raise RuntimeError(f"Refusing recursive removal outside the approved artifact parent: {path}")
    shutil.rmtree(path)


def load_rows(
    dataset_manifest_path: Path,
    max_train_rows: int,
    max_dev_rows: int,
    seed: int,
    max_input_len: int,
    max_output_len: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    manifest = read_json(dataset_manifest_path)
    split_paths = verify_dataset_split_artifacts(manifest)
    train_path = split_paths["train"]
    dev_path = split_paths["dev"]
    test_path = split_paths["test"]
    split_inputs = {
        "train": load_split_inputs(train_path),
        "dev": load_split_inputs(dev_path),
        "test": load_split_inputs(test_path),
    }
    for left, right in (("train", "dev"), ("train", "test"), ("dev", "test")):
        overlap = split_inputs[left] & split_inputs[right]
        if overlap:
            example = sorted(overlap)[0]
            raise SystemExit(f"Dataset input leakage between {left} and {right}: {example}")
    train_all = load_split(train_path, "train", max_input_len, max_output_len)
    dev_all = load_split(dev_path, "dev", max_input_len, max_output_len)
    train = deterministic_source_sample(train_all, max_train_rows, seed, "train")
    dev = deterministic_source_sample(dev_all, max_dev_rows, seed + 1, "dev")
    return train, dev, manifest


def verify_dataset_split_artifacts(manifest: dict[str, Any]) -> dict[str, Path]:
    if manifest.get("schemaVersion") != 2 or not manifest.get("datasetContentSha256"):
        raise SystemExit("Training requires a schema-v2 dataset manifest with a stable content identity.")
    paths: dict[str, Path] = {}
    verified_rows = 0
    for split in ("train", "dev", "test"):
        recorded_path = manifest.get("splitFiles", {}).get(split)
        if not isinstance(recorded_path, str) or not recorded_path:
            raise SystemExit(f"Dataset manifest is missing splitFiles.{split}.")
        path = Path(recorded_path)
        if not path.is_absolute():
            path = ROOT / path
        if not path.is_file():
            raise SystemExit(f"Dataset split is missing: {path}")
        observed = inspect_jsonl_artifact(path)
        expected_sha = manifest.get("sha256", {}).get(split)
        expected_rows = manifest.get("counts", {}).get(split)
        expected_bytes = manifest.get("bytes", {}).get(split)
        if observed["sha256"] != expected_sha:
            raise SystemExit(f"Dataset split {split} SHA-256 does not match its manifest.")
        if observed["rows"] != expected_rows:
            raise SystemExit(f"Dataset split {split} row count does not match its manifest.")
        if observed["bytes"] != expected_bytes:
            raise SystemExit(f"Dataset split {split} byte count does not match its manifest.")
        verified_rows += int(observed["rows"])
        paths[split] = path
    if verified_rows != manifest.get("totalRows"):
        raise SystemExit("Dataset split row counts do not sum to manifest.totalRows.")
    return paths


def inspect_jsonl_artifact(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    byte_count = 0
    row_count = 0
    partial_line = b""
    with open_regular_binary(path, "JSONL artifact") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            byte_count += len(chunk)
            complete_lines = (partial_line + chunk).split(b"\n")
            partial_line = complete_lines.pop()
            row_count += sum(1 for line in complete_lines if line.strip())
    if partial_line.strip():
        row_count += 1
    return {"sha256": digest.hexdigest(), "bytes": byte_count, "rows": row_count}


def load_split_inputs(path: Path) -> set[str]:
    inputs: set[str] = set()
    with open_regular_binary(path, "dataset split") as binary_handle, io.TextIOWrapper(binary_handle, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            value = normalize_input(row.get("input", ""))
            if value:
                inputs.add(value)
    return inputs


def load_split(path: Path, split: str, max_input_len: int, max_output_len: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    with open_regular_binary(path, f"dataset {split} split") as binary_handle, io.TextIOWrapper(binary_handle, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("action") != "produce-candidate":
                continue
            source_ids = row.get("sourceIds") or []
            identifier = str(row.get("id") or "")
            normalized_input = normalize_input(row.get("input", ""))
            target = nfc(row.get("target", ""))
            if not identifier:
                raise SystemExit(f"Dataset {split} row is missing an id.")
            if identifier in seen_ids:
                raise SystemExit(f"Dataset {split} contains duplicate id: {identifier}")
            seen_ids.add(identifier)
            if not normalized_input:
                raise SystemExit(f"Dataset {split} row {identifier} has an empty normalized input.")
            if not all("a" <= char <= "z" for char in normalized_input):
                raise SystemExit(f"Dataset {split} row {identifier} contains input tokens unsupported by the native runtime.")
            if len(normalized_input) > max_input_len - 1:
                raise SystemExit(f"Dataset {split} row {identifier} exceeds the configured input length.")
            if not target or any(ch.isspace() for ch in target) or contains_ascii_latin(target):
                raise SystemExit(f"Dataset {split} row {identifier} has an invalid token target.")
            if not valid_native_output(target):
                raise SystemExit(f"Dataset {split} row {identifier} contains output scalars unsupported by the native runtime.")
            if len(graphemes(target)) > max_output_len - 2:
                raise SystemExit(f"Dataset {split} row {identifier} exceeds the configured output length.")
            weight = float(row.get("weight", 1.0))
            if not math.isfinite(weight) or weight <= 0:
                raise SystemExit(f"Dataset {split} row {identifier} has an invalid training weight.")
            rows.append({
                "id": identifier,
                "input": normalized_input,
                "target": target,
                "acceptable": row.get("acceptable") or [target],
                "sourceIds": source_ids,
                "weight": weight,
            })
    return rows


def contains_ascii_latin(value: str) -> bool:
    return any("A" <= char <= "Z" or "a" <= char <= "z" for char in value)


def valid_native_output(value: str) -> bool:
    return all(0x0900 <= ord(char) <= 0x097F or ord(char) in (0x200C, 0x200D) for char in value)


def deterministic_source_sample(rows: list[dict[str, Any]], limit: int, seed: int, split: str) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    if len(rows) <= limit:
        return rows

    pinned: list[dict[str, Any]] = []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        source = primary_source(row)
        if any(is_pinned_source(str(source_id)) for source_id in row.get("sourceIds") or []):
            pinned.append(row)
            continue
        grouped.setdefault(source, []).append(row)

    selected: list[dict[str, Any]] = stable_row_order(pinned, seed, split)[:limit]
    remaining = limit - len(selected)
    if remaining <= 0:
        return selected

    weighted_sources = []
    for source, source_rows in grouped.items():
        weighted_sources.append((source, math.sqrt(len(source_rows))))
    total_weight = sum(weight for _, weight in weighted_sources) or 1.0

    selected_ids = {row["id"] for row in selected}
    for source, source_weight in weighted_sources:
        quota = min(len(grouped[source]), max(1, int(remaining * source_weight / total_weight)))
        for row in stable_row_order(grouped[source], seed, f"{split}:{source}")[:quota]:
            if len(selected) >= limit:
                return selected
            if row["id"] in selected_ids:
                continue
            selected.append(row)
            selected_ids.add(row["id"])

    leftovers = [row for source_rows in grouped.values() for row in source_rows if row["id"] not in selected_ids]
    for row in stable_row_order(leftovers, seed, f"{split}:fill"):
        if len(selected) >= limit:
            break
        selected.append(row)
    return selected


def stable_row_order(rows: list[dict[str, Any]], seed: int, namespace: str) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda row: hashlib.sha256(f"{seed}:{namespace}:{row['id']}".encode("utf-8")).hexdigest())


def primary_source(row: dict[str, Any]) -> str:
    source_ids = sorted(str(source_id) for source_id in row.get("sourceIds") or ["unknown"])
    return source_ids[0]


def is_pinned_source(source: str) -> bool:
    return source in {
        "lekh-phase1-contract-seed-v1",
        "human-reviewed-lekh-gold-v1",
        "lekh-chat-conventions-v1",
        "lekh-name-lexicon-v1",
    }


def source_summary(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for row in rows:
        for source_id in row.get("sourceIds") or ["unknown"]:
            counts[str(source_id)] += 1
    return dict(sorted(counts.items()))


def source_weight_mass(rows: list[dict[str, Any]]) -> dict[str, float]:
    totals: Counter[str] = Counter()
    for row in rows:
        weight = float(row.get("weight", 1.0))
        for source_id in row.get("sourceIds") or ["unknown"]:
            totals[str(source_id)] += weight
    return {source: float(total) for source, total in sorted(totals.items())}


def build_vocab(rows: list[dict[str, Any]], side: str) -> dict[str, int]:
    counter: Counter[str] = Counter()
    for row in rows:
        tokens = list(normalize_input(row["input"])) if side == "input" else graphemes(row["target"])
        counter.update(tokens)
    vocab = {token: index for index, token in enumerate(SPECIAL)}
    for token, _ in counter.most_common():
        if token not in vocab:
            vocab[token] = len(vocab)
    return vocab


class TransliterationDataset(Dataset):
    def __init__(self, rows: list[dict[str, Any]], input_vocab: dict[str, int], output_vocab: dict[str, int], max_input_len: int, max_output_len: int):
        self.rows = rows
        self.input_vocab = input_vocab
        self.output_vocab = output_vocab
        self.max_input_len = max_input_len
        self.max_output_len = max_output_len

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        row = self.rows[index]
        src = encode(list(normalize_input(row["input"])), self.input_vocab, self.max_input_len, add_sos=False)
        tgt = encode(graphemes(row["target"]), self.output_vocab, self.max_output_len, add_sos=True)
        dec_in = tgt[:-1]
        dec_out = tgt[1:]
        weight = torch.tensor(float(row.get("weight", 1.0)), dtype=torch.float32)
        return torch.tensor(src, dtype=torch.long), torch.tensor(dec_in, dtype=torch.long), torch.tensor(dec_out, dtype=torch.long), weight


def encode(tokens: list[str], vocab: dict[str, int], max_len: int, add_sos: bool) -> list[int]:
    prefix = [vocab[SOS]] if add_sos else []
    content_capacity = max_len - len(prefix) - 1
    if content_capacity < 0:
        raise ValueError("max_len must reserve room for sequence boundaries")
    if len(tokens) > content_capacity:
        raise ValueError(f"Token sequence length {len(tokens)} exceeds capacity {content_capacity}")
    ids = prefix
    ids.extend(vocab.get(token, vocab[UNK]) for token in tokens)
    ids.append(vocab[EOS])
    ids.extend([vocab[PAD]] * (max_len - len(ids)))
    return ids


class PaddedInvariantEncoder(nn.Module):
    def __init__(self, embedding_dim: int, hidden_dim: int, layers: int, dropout: float):
        super().__init__()
        self.layers = nn.ModuleList([
            nn.GRU(embedding_dim if layer == 0 else hidden_dim, hidden_dim, num_layers=1, batch_first=True)
            for layer in range(layers)
        ])
        self.dropout = nn.Dropout(dropout)

    def forward(self, embedded: torch.Tensor, input_ids: torch.Tensor) -> torch.Tensor:
        eos_positions = input_ids.eq(SPECIAL.index(EOS)).to(torch.int64).argmax(dim=1)
        output = embedded
        hidden_states = []
        for index, layer in enumerate(self.layers):
            output, _ = layer(output)
            gather_index = eos_positions.view(-1, 1, 1).expand(-1, 1, output.shape[-1])
            hidden_states.append(output.gather(1, gather_index).transpose(0, 1))
            if index + 1 < len(self.layers):
                output = self.dropout(output)
        return torch.cat(hidden_states, dim=0)


class Seq2Seq(nn.Module):
    def __init__(self, input_vocab_size: int, output_vocab_size: int, embedding_dim: int, hidden_dim: int, layers: int, dropout: float):
        super().__init__()
        self.input_embedding = nn.Embedding(input_vocab_size, embedding_dim, padding_idx=0)
        self.output_embedding = nn.Embedding(output_vocab_size, embedding_dim, padding_idx=0)
        self.encoder = PaddedInvariantEncoder(embedding_dim, hidden_dim, layers, dropout)
        self.decoder = nn.GRU(embedding_dim, hidden_dim, num_layers=layers, batch_first=True, dropout=dropout if layers > 1 else 0)
        self.projection = nn.Linear(hidden_dim, output_vocab_size)

    def encode_hidden(self, input_ids: torch.Tensor) -> torch.Tensor:
        return self.encoder(self.input_embedding(input_ids), input_ids)

    def forward(self, input_ids: torch.Tensor, decoder_input_ids: torch.Tensor) -> torch.Tensor:
        hidden = self.encode_hidden(input_ids)
        decoded, _ = self.decoder(self.output_embedding(decoder_input_ids), hidden)
        return self.projection(decoded)


class CoreMLWrapper(nn.Module):
    def __init__(self, model: Seq2Seq):
        super().__init__()
        self.model = model

    def forward(self, input_ids: torch.Tensor, decoder_input_ids: torch.Tensor) -> torch.Tensor:
        return self.model(input_ids.long(), decoder_input_ids.long())


def device_for_training() -> torch.device:
    # PyTorch's MPS GRU backend has crashed process-wide for this two-layer
    # sequence model on supported Apple Silicon hosts. Training is an offline
    # publication step, so prefer deterministic, portable CPU execution. The
    # exported Core ML model still uses Core ML compute units at inference time.
    return torch.device("cpu")


def weighted_token_cross_entropy(
    logits: torch.Tensor,
    targets: torch.Tensor,
    weights: torch.Tensor,
    loss_fn: nn.CrossEntropyLoss,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    token_loss = loss_fn(logits.reshape(-1, logits.shape[-1]), targets.reshape(-1)).reshape(targets.shape)
    weighted_mask = targets.ne(0).to(token_loss.dtype) * weights.unsqueeze(1)
    numerator = (token_loss * weighted_mask).sum()
    denominator = weighted_mask.sum().clamp(min=1)
    return numerator / denominator, numerator.detach(), denominator.detach()


@torch.no_grad()
def evaluate_weighted_token_loss(
    model: Seq2Seq,
    loader: DataLoader,
    device: torch.device,
    loss_fn: nn.CrossEntropyLoss,
) -> float:
    model.eval()
    numerator = 0.0
    denominator = 0.0
    for src, dec_in, dec_out, weights in loader:
        src = src.to(device)
        dec_in = dec_in.to(device)
        dec_out = dec_out.to(device)
        weights = weights.to(device)
        logits = model(src, dec_in)
        _, batch_numerator, batch_denominator = weighted_token_cross_entropy(logits, dec_out, weights, loss_fn)
        numerator += float(batch_numerator.cpu())
        denominator += float(batch_denominator.cpu())
    value = numerator / max(denominator, 1.0)
    if not math.isfinite(value):
        raise SystemExit("Dev weighted token cross-entropy became non-finite.")
    return value


def sampled_rows_sha256(rows: list[dict[str, Any]]) -> str:
    records = [json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for row in stable_row_order(rows, 0, "sample-digest")]
    return sha256_text("\n".join(records))


def checkpoint_runtime_config(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "embedding_dim": args.embedding_dim,
        "hidden_dim": args.hidden_dim,
        "layers": args.layers,
        "dropout": args.dropout,
        "max_input_len": args.max_input_len,
        "max_output_len": args.max_output_len,
        "beam_width": args.beam_width,
        "maximum_candidates": args.maximum_candidates,
    }


def train_model(args: argparse.Namespace) -> dict[str, Any]:
    if args.training_run_id is None:
        args.training_run_id = uuid.uuid4().hex
    if not is_run_identifier(args.training_run_id):
        raise SystemExit("Training run identity must be a 32-character lowercase hexadecimal value.")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    train_rows, dev_rows, dataset_manifest = load_rows(
        args.dataset_manifest,
        args.max_train_rows,
        args.max_dev_rows,
        args.seed,
        args.max_input_len,
        args.max_output_len,
    )
    if not train_rows:
        raise SystemExit("Training selection is empty.")
    if args.early_stopping_enabled and not dev_rows:
        raise SystemExit("Early stopping requires a non-empty dev selection.")
    input_vocab = build_vocab(train_rows, "input")
    output_vocab = build_vocab(train_rows, "output")
    model = Seq2Seq(len(input_vocab), len(output_vocab), args.embedding_dim, args.hidden_dim, args.layers, args.dropout)
    device = device_for_training()
    model.to(device)

    training_generator = torch.Generator()
    training_generator.manual_seed(args.seed)
    train_loader = DataLoader(
        TransliterationDataset(train_rows, input_vocab, output_vocab, args.max_input_len, args.max_output_len),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
        generator=training_generator,
    )
    dev_loader = DataLoader(
        TransliterationDataset(dev_rows, input_vocab, output_vocab, args.max_input_len, args.max_output_len),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    loss_fn = nn.CrossEntropyLoss(ignore_index=0, reduction="none", label_smoothing=args.label_smoothing)
    losses: list[float] = []
    epoch_metrics: list[dict[str, Any]] = []
    best_state: dict[str, torch.Tensor] | None = None
    best_dev_loss = math.inf
    best_epoch = 0
    epochs_without_improvement = 0
    stopped_early = False
    started = time.perf_counter()
    for epoch in range(args.epochs):
        model.train()
        epoch_numerator = 0.0
        epoch_denominator = 0.0
        for src, dec_in, dec_out, weights in train_loader:
            src = src.to(device)
            dec_in = dec_in.to(device)
            dec_out = dec_out.to(device)
            weights = weights.to(device)
            logits = model(src, dec_in)
            loss, batch_numerator, batch_denominator = weighted_token_cross_entropy(logits, dec_out, weights, loss_fn)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip_norm)
            optimizer.step()
            epoch_numerator += float(batch_numerator.cpu())
            epoch_denominator += float(batch_denominator.cpu())
        train_loss = epoch_numerator / max(epoch_denominator, 1.0)
        if not math.isfinite(train_loss):
            raise SystemExit("Train weighted token cross-entropy became non-finite.")
        dev_loss = evaluate_weighted_token_loss(model, dev_loader, device, loss_fn)
        losses.append(train_loss)
        improved = dev_loss < best_dev_loss - args.early_stopping_min_delta
        if improved:
            best_dev_loss = dev_loss
            best_epoch = epoch + 1
            best_state = {name: value.detach().cpu().clone() for name, value in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
        epoch_result = {
            "epoch": epoch + 1,
            "trainWeightedTokenCrossEntropy": train_loss,
            "devWeightedTokenCrossEntropy": dev_loss,
            "best": improved,
        }
        epoch_metrics.append(epoch_result)
        print(json.dumps(epoch_result, ensure_ascii=False), flush=True)
        if args.early_stopping_enabled and epochs_without_improvement >= args.early_stopping_patience:
            stopped_early = True
            break

    if best_state is None:
        raise SystemExit("Training completed without a finite best dev checkpoint.")
    if args.restore_best_weights:
        model.load_state_dict(best_state)

    evaluation = evaluate_model(model, dev_rows, input_vocab, output_vocab, args, device)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    write_vocab_metadata(input_vocab, output_vocab, args, dataset_manifest)
    train_sample_sha256 = sampled_rows_sha256(train_rows)
    dev_sample_sha256 = sampled_rows_sha256(dev_rows)
    checkpoint = {
        "modelId": MODEL_ID,
        "trainingRunId": args.training_run_id,
        "stateDict": model.cpu().state_dict(),
        "inputVocab": input_vocab,
        "outputVocab": output_vocab,
        "config": checkpoint_runtime_config(args),
        "trainingContractSha256": args.training_contract_sha256,
        "configuredTrainingConfig": args.configured_training_config,
        "effectiveTrainingConfig": args.effective_training_config,
        "effectiveTrainingConfigCanonicalJson": args.effective_training_config_canonical_json,
        "effectiveTrainingConfigSha256": args.effective_training_config_sha256,
        "trainingOverrides": args.training_overrides,
        "configuredArtifactInputs": args.configured_artifact_inputs,
        "effectiveArtifactInputs": args.effective_artifact_inputs,
        "effectiveArtifactInputsCanonicalJson": args.effective_artifact_inputs_canonical_json,
        "effectiveArtifactInputsSha256": args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "trainerSha256": sha256_file(Path(__file__)),
        "vocabMetadataSha256": sha256_file(args.vocab_metadata),
        "datasetManifestSha256": sha256_file(args.dataset_manifest),
        "datasetContentSha256": dataset_manifest.get("datasetContentSha256", ""),
        "datasetSplitSha256": dataset_manifest.get("sha256", {}),
        "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
        "trainingRows": len(train_rows),
        "devRows": len(dev_rows),
        "trainingSourceCounts": source_summary(train_rows),
        "devSourceCounts": source_summary(dev_rows),
        "trainingSourceWeightMass": source_weight_mass(train_rows),
        "devSourceWeightMass": source_weight_mass(dev_rows),
        "losses": losses,
        "epochMetrics": epoch_metrics,
        "bestEpoch": best_epoch,
        "bestDevWeightedTokenCrossEntropy": best_dev_loss,
        "stoppedEarly": stopped_early,
        "sampledRowDigests": {"train": train_sample_sha256, "dev": dev_sample_sha256},
        "evaluation": evaluation,
    }
    checkpoint_target = checkpoint_path(args)
    checkpoint_staging = staging_sibling(checkpoint_target, "staging")
    try:
        with checkpoint_staging.open("xb") as handle:
            torch.save(checkpoint, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(checkpoint_staging, checkpoint_target)
    finally:
        checkpoint_staging.unlink(missing_ok=True)
    checkpoint_sha256 = sha256_file(checkpoint_target)
    report = {
        "generatedAt": iso_now(),
        "command": "python scripts/train-open-vocab-seq2seq-transliterator.py",
        "status": "passed-training-checkpoint",
        "modelId": MODEL_ID,
        "trainingRunId": args.training_run_id,
        "trainingComplete": True,
        "trainingExecutionModes": args.execution_modes,
        "durationMs": round((time.perf_counter() - started) * 1000),
        "device": str(device),
        "trainingConfig": rel(args.config),
        "trainingContractSha256": args.training_contract_sha256,
        "configuredTrainingConfig": args.configured_training_config,
        "effectiveTrainingConfig": args.effective_training_config,
        "effectiveTrainingConfigCanonicalJson": args.effective_training_config_canonical_json,
        "effectiveTrainingConfigSha256": args.effective_training_config_sha256,
        "trainingOverrides": args.training_overrides,
        "configuredArtifactInputs": args.configured_artifact_inputs,
        "effectiveArtifactInputs": args.effective_artifact_inputs,
        "effectiveArtifactInputsCanonicalJson": args.effective_artifact_inputs_canonical_json,
        "effectiveArtifactInputsSha256": args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "trainerSha256": checkpoint["trainerSha256"],
        "vocabMetadataSha256": checkpoint["vocabMetadataSha256"],
        "inputDatasetManifest": rel(args.dataset_manifest),
        "inputDatasetManifestSha256": checkpoint["datasetManifestSha256"],
        "inputDatasetContentSha256": checkpoint["datasetContentSha256"],
        "inputDatasetSplitSha256": checkpoint["datasetSplitSha256"],
        "checkpoint": rel(checkpoint_path(args)),
        "checkpointSha256": checkpoint_sha256,
        "parameterCount": checkpoint["parameterCount"],
        "trainingRows": len(train_rows),
        "devRows": len(dev_rows),
        "trainingSourceCounts": checkpoint["trainingSourceCounts"],
        "devSourceCounts": checkpoint["devSourceCounts"],
        "trainingSourceWeightMass": checkpoint["trainingSourceWeightMass"],
        "devSourceWeightMass": checkpoint["devSourceWeightMass"],
        "trainingSampleIdSha256": sha256_text("\n".join(sorted(row["id"] for row in train_rows))),
        "devSampleIdSha256": sha256_text("\n".join(sorted(row["id"] for row in dev_rows))),
        "sampledRowDigests": checkpoint["sampledRowDigests"],
        "samplingPolicy": {
            **args.training_config["training"]["samplingPolicy"],
            "seed": args.seed,
            "maxTrainRows": args.max_train_rows,
            "maxDevRows": args.max_dev_rows,
        },
        "vocabMetadata": rel(args.vocab_metadata),
        "losses": losses,
        "epochMetrics": epoch_metrics,
        "bestEpoch": best_epoch,
        "bestDevWeightedTokenCrossEntropy": best_dev_loss,
        "stoppedEarly": stopped_early,
        "earlyStopping": {
            "enabled": args.early_stopping_enabled,
            "metric": args.early_stopping_metric,
            "patienceEpochs": args.early_stopping_patience,
            "minimumDelta": args.early_stopping_min_delta,
            "restoreBestWeights": args.restore_best_weights,
            "bestEpoch": best_epoch,
            "bestDevWeightedTokenCrossEntropy": best_dev_loss,
            "stoppedEarly": stopped_early,
            "epochsCompleted": len(epoch_metrics),
        },
        "evaluation": evaluation,
        "datasetRows": dataset_manifest.get("totalRows"),
        "productionEligible": False,
        "productionBlockers": production_blockers(),
    }
    write_json(training_report_path(args), report)
    return {"model": model.cpu(), "checkpoint": checkpoint, "report": report}


def load_checkpoint(args: argparse.Namespace) -> dict[str, Any]:
    current_checkpoint_path = checkpoint_path(args)
    current_report_path = training_report_path(args)
    if not current_checkpoint_path.exists():
        raise SystemExit(f"Missing checkpoint: {current_checkpoint_path}. Run training first.")
    if not current_report_path.exists():
        raise SystemExit(f"Missing training report: {current_report_path}. Historical provenance cannot be reconstructed.")
    report = read_json(current_report_path)
    if report.get("checkpointSha256") != sha256_file(current_checkpoint_path):
        raise SystemExit("Training report checkpointSha256 does not match the checkpoint bytes.")
    try:
        with open_regular_binary(current_checkpoint_path, "checkpoint") as handle:
            checkpoint = torch.load(handle, map_location="cpu", weights_only=True)
    except Exception as error:
        raise SystemExit("Checkpoint failed safe tensor-only loading; refusing untrusted pickle content.") from error
    if not is_run_identifier(checkpoint.get("trainingRunId")):
        raise SystemExit("Checkpoint is missing a valid trainingRunId.")
    args.training_run_id = checkpoint["trainingRunId"]
    for field in ("datasetSplitSha256", "datasetManifestSha256", "datasetContentSha256"):
        if not checkpoint.get(field):
            raise SystemExit(f"Checkpoint is missing historical provenance field: {field}")
    for field in (
        "trainingRunId",
        "trainingContractSha256",
        "configuredTrainingConfig",
        "effectiveTrainingConfig",
        "effectiveTrainingConfigCanonicalJson",
        "effectiveTrainingConfigSha256",
        "trainingOverrides",
        "configuredArtifactInputs",
        "effectiveArtifactInputs",
        "effectiveArtifactInputsCanonicalJson",
        "effectiveArtifactInputsSha256",
        "artifactOverrides",
        "trainerSha256",
        "vocabMetadataSha256",
        "sampledRowDigests",
    ):
        if field not in checkpoint:
            raise SystemExit(f"Checkpoint is missing executable training provenance field: {field}")
    if checkpoint["trainingContractSha256"] != args.training_contract_sha256:
        raise SystemExit("Checkpoint training contract does not match the current config bytes; retraining is required.")
    if checkpoint["configuredTrainingConfig"] != args.configured_training_config:
        raise SystemExit("Checkpoint configured training snapshot does not match the current config; retraining is required.")
    if checkpoint["effectiveTrainingConfig"] != args.effective_training_config:
        raise SystemExit("Checkpoint effective training config does not match this invocation; rerun with the original overrides or retrain.")
    if checkpoint["effectiveTrainingConfigCanonicalJson"] != canonical_json_text(checkpoint["effectiveTrainingConfig"]):
        raise SystemExit("Checkpoint effective training config canonical JSON is invalid.")
    if checkpoint["effectiveTrainingConfigSha256"] != sha256_text(checkpoint["effectiveTrainingConfigCanonicalJson"]):
        raise SystemExit("Checkpoint effective training config digest is invalid.")
    if checkpoint["trainingOverrides"] != args.training_overrides:
        raise SystemExit("Checkpoint training overrides do not match this invocation.")
    if checkpoint["configuredArtifactInputs"] != args.configured_artifact_inputs:
        raise SystemExit("Checkpoint configured artifact inputs do not match the current training contract.")
    if checkpoint["effectiveArtifactInputs"] != args.effective_artifact_inputs:
        raise SystemExit("Checkpoint effective artifact inputs do not match this invocation.")
    if checkpoint["effectiveArtifactInputsCanonicalJson"] != canonical_json_text(checkpoint["effectiveArtifactInputs"]):
        raise SystemExit("Checkpoint effective artifact input canonical JSON is invalid.")
    if checkpoint["effectiveArtifactInputsSha256"] != sha256_text(checkpoint["effectiveArtifactInputsCanonicalJson"]):
        raise SystemExit("Checkpoint effective artifact input digest is invalid.")
    if checkpoint["artifactOverrides"] != args.artifact_overrides:
        raise SystemExit("Checkpoint artifact overrides do not match this invocation.")
    if checkpoint["trainerSha256"] != sha256_file(Path(__file__)):
        raise SystemExit("Checkpoint trainerSha256 does not match the current trainer implementation.")
    if not args.vocab_metadata.is_file():
        raise SystemExit("Checkpoint vocabulary metadata is missing; historical provenance cannot be backfilled from current inputs.")
    if checkpoint["vocabMetadataSha256"] != sha256_file(args.vocab_metadata):
        raise SystemExit("Checkpoint vocabulary metadata digest does not match the current vocabulary artifact.")
    model = Seq2Seq(
        len(checkpoint["inputVocab"]),
        len(checkpoint["outputVocab"]),
        checkpoint["config"]["embedding_dim"],
        checkpoint["config"]["hidden_dim"],
        checkpoint["config"]["layers"],
        checkpoint["config"]["dropout"],
    )
    model.load_state_dict(checkpoint["stateDict"])
    model.eval()
    validate_checkpoint_runtime_bindings(args, checkpoint, model)
    for field in (
        "trainingRunId",
        "trainingContractSha256",
        "configuredTrainingConfig",
        "effectiveTrainingConfig",
        "effectiveTrainingConfigCanonicalJson",
        "effectiveTrainingConfigSha256",
        "trainingOverrides",
        "configuredArtifactInputs",
        "effectiveArtifactInputs",
        "effectiveArtifactInputsCanonicalJson",
        "effectiveArtifactInputsSha256",
        "artifactOverrides",
        "trainerSha256",
        "vocabMetadataSha256",
        "sampledRowDigests",
    ):
        if report.get(field) != checkpoint.get(field):
            raise SystemExit(f"Training report {field} does not match checkpoint provenance.")
    if report.get("inputDatasetSplitSha256") != checkpoint.get("datasetSplitSha256"):
        raise SystemExit("Training report split provenance does not match checkpoint provenance.")
    if report.get("inputDatasetManifestSha256") != checkpoint.get("datasetManifestSha256"):
        raise SystemExit("Training report manifest provenance does not match checkpoint provenance.")
    if report.get("inputDatasetContentSha256") != checkpoint.get("datasetContentSha256"):
        raise SystemExit("Training report stable dataset identity does not match checkpoint provenance.")
    for field in (
        "parameterCount",
        "trainingRows",
        "devRows",
        "trainingSourceCounts",
        "devSourceCounts",
        "trainingSourceWeightMass",
        "devSourceWeightMass",
    ):
        if report.get(field) != checkpoint.get(field):
            raise SystemExit(f"Training report {field} does not match checkpoint metadata.")
    return {"model": model, "checkpoint": checkpoint, "report": report}


def validate_checkpoint_runtime_bindings(
    args: argparse.Namespace,
    checkpoint: dict[str, Any],
    model: Seq2Seq,
) -> None:
    if checkpoint.get("config") != checkpoint_runtime_config(args):
        raise SystemExit("Checkpoint runtime dimensions do not match the effective training config.")
    observed_parameter_count = sum(parameter.numel() for parameter in model.parameters())
    if checkpoint.get("parameterCount") != observed_parameter_count:
        raise SystemExit("Checkpoint parameterCount does not match the loaded state dictionary.")
    if not args.vocab_metadata.is_file():
        raise SystemExit("Checkpoint vocabulary metadata is missing.")
    vocab = read_json(args.vocab_metadata)
    expected_input_tokens = tokens_by_id(checkpoint["inputVocab"])
    expected_output_tokens = tokens_by_id(checkpoint["outputVocab"])
    if vocab.get("modelId") != checkpoint.get("modelId"):
        raise SystemExit("Vocabulary modelId does not match the checkpoint.")
    if vocab.get("input", {}).get("tokensById") != expected_input_tokens or vocab.get("input", {}).get("idsByToken") != checkpoint["inputVocab"]:
        raise SystemExit("Input vocabulary metadata does not match the checkpoint vocabulary.")
    if vocab.get("output", {}).get("tokensById") != expected_output_tokens or vocab.get("output", {}).get("idsByToken") != checkpoint["outputVocab"]:
        raise SystemExit("Output vocabulary metadata does not match the checkpoint vocabulary.")
    if vocab.get("input", {}).get("maxLength") != checkpoint["config"]["max_input_len"]:
        raise SystemExit("Vocabulary input maxLength does not match the checkpoint.")
    if vocab.get("output", {}).get("maxLength") != checkpoint["config"]["max_output_len"]:
        raise SystemExit("Vocabulary output maxLength does not match the checkpoint.")
    if vocab.get("decoder", {}).get("beamWidth") != checkpoint["config"]["beam_width"]:
        raise SystemExit("Vocabulary beam width does not match the checkpoint.")
    if vocab.get("dataset", {}).get("manifestSha256") != checkpoint.get("datasetManifestSha256"):
        raise SystemExit("Vocabulary dataset manifest digest does not match the checkpoint.")
    if vocab.get("dataset", {}).get("splitSha256") != checkpoint.get("datasetSplitSha256"):
        raise SystemExit("Vocabulary dataset split digests do not match the checkpoint.")


@torch.no_grad()
def decode_candidates(
    model: Seq2Seq,
    text: str,
    input_vocab: dict[str, int],
    output_vocab: dict[str, int],
    max_input_len: int,
    max_output_len: int,
    beam_width: int = 4,
    maximum_candidates: int = 8,
) -> list[str]:
    normalized = normalize_input(text)
    if not normalized or any(
        token not in input_vocab or input_vocab[token] == input_vocab[UNK]
        for token in normalized
    ):
        return []
    src_ids = encode(list(normalized), input_vocab, max_input_len, add_sos=False)
    src = torch.tensor([src_ids], dtype=torch.long)
    model.eval().to("cpu")

    def predict(prefix: list[int], step: int) -> np.ndarray:
        decoder_ids = padded_decoder_ids(prefix, output_vocab, max_output_len)
        logits = model(src, torch.tensor([decoder_ids], dtype=torch.long)).detach().cpu().numpy()
        return validated_logit_vector(logits, step, len(output_vocab), "PyTorch diagnostic decoder")

    token_sequences = beam_search_token_ids(
        predict,
        input_grapheme_count=len(normalized),
        max_output_len=max_output_len,
        beam_width=beam_width,
        maximum_candidates=maximum_candidates,
        pad_id=output_vocab[PAD],
        sos_id=output_vocab[SOS],
        eos_id=output_vocab[EOS],
        unk_id=output_vocab[UNK],
        vocab_size=len(output_vocab),
    )
    return decode_token_sequences(token_sequences, output_vocab, maximum_candidates)


def decoder_max_steps(input_grapheme_count: int, max_output_len: int) -> int:
    return max(0, min(max_output_len - 1, input_grapheme_count + 8))


def padded_decoder_ids(prefix: list[int], output_vocab: dict[str, int], max_output_len: int) -> list[int]:
    decoder_length = max_output_len - 1
    if not prefix or len(prefix) > decoder_length:
        raise SystemExit("Decoder prefix is outside the frozen runtime length contract.")
    return prefix + [output_vocab[PAD]] * (decoder_length - len(prefix))


def validated_logit_vector(logits: Any, step: int, vocab_size: int, label: str) -> np.ndarray:
    values = np.asarray(logits)
    if values.ndim != 3 or values.shape[0] != 1:
        raise SystemExit(f"{label} returned logits with invalid rank/leading dimension: {values.shape}")
    if values.shape[2] != vocab_size or not 0 <= step < values.shape[1]:
        raise SystemExit(f"{label} returned logits with an incompatible shape: {values.shape}")
    if values.dtype.kind != "f" or not np.isfinite(values).all():
        raise SystemExit(f"{label} returned non-floating or non-finite logits.")
    return values[0, step, :].astype(np.float64, copy=False)


def log_softmax_numpy(logits: np.ndarray) -> np.ndarray:
    maximum = float(np.max(logits))
    shifted = logits - maximum
    normalizer = maximum + math.log(float(np.exp(shifted).sum()))
    return logits - normalizer


def beam_rank_key(item: tuple[list[int], float]) -> tuple[float, tuple[int, ...]]:
    ids, score = item
    return (-score / max(len(ids), 1), tuple(ids))


def beam_search_token_ids(
    predict: Callable[[list[int], int], np.ndarray],
    *,
    input_grapheme_count: int,
    max_output_len: int,
    beam_width: int,
    maximum_candidates: int,
    pad_id: int,
    sos_id: int,
    eos_id: int,
    unk_id: int,
    vocab_size: int,
) -> list[list[int]]:
    if beam_width < 1 or maximum_candidates < 1 or vocab_size < 1:
        raise SystemExit("Decoder contract values must be positive.")
    beams: list[tuple[list[int], float]] = [([sos_id], 0.0)]
    completed: list[tuple[list[int], float]] = []
    invalid_ids = {pad_id, sos_id, unk_id}
    for _ in range(decoder_max_steps(input_grapheme_count, max_output_len)):
        next_beams: list[tuple[list[int], float]] = []
        for ids, score in beams:
            if ids[-1] == eos_id:
                completed.append((ids, score))
                continue
            step = len(ids) - 1
            logits = np.asarray(predict(ids, step), dtype=np.float64)
            if logits.shape != (vocab_size,) or not np.isfinite(logits).all():
                raise SystemExit("Decoder backend returned an invalid vocabulary logit vector.")
            log_probabilities = log_softmax_numpy(logits)
            eligible = [token_id for token_id in range(vocab_size) if token_id not in invalid_ids]
            eligible.sort(key=lambda token_id: (-float(log_probabilities[token_id]), token_id))
            for token_id in eligible[:beam_width]:
                next_beams.append((ids + [token_id], score + float(log_probabilities[token_id])))
        if not next_beams:
            break
        beams = sorted(next_beams, key=beam_rank_key)[:beam_width]
    ranked = sorted(completed + beams, key=beam_rank_key)
    unique: list[list[int]] = []
    seen: set[tuple[int, ...]] = set()
    for ids, _ in ranked:
        identity = tuple(ids)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(ids)
        if len(unique) >= maximum_candidates:
            break
    return unique


def decode_token_sequences(
    sequences: list[list[int]],
    output_vocab: dict[str, int],
    maximum_candidates: int,
) -> list[str]:
    reverse_output = {index: token for token, index in output_vocab.items()}
    candidates: list[str] = []
    for ids in sequences:
        tokens: list[str] = []
        for token_id in ids:
            token = reverse_output.get(token_id, "")
            if token in (PAD, SOS, UNK):
                continue
            if token == EOS:
                break
            tokens.append(token)
        candidate = "".join(tokens)
        if (
            candidate
            and not any(character.isspace() for character in candidate)
            and not contains_ascii_latin(candidate)
            and candidate not in candidates
        ):
            candidates.append(candidate)
        if len(candidates) >= maximum_candidates:
            break
    return candidates


def evaluate_model(model: Seq2Seq, rows: list[dict[str, Any]], input_vocab: dict[str, int], output_vocab: dict[str, int], args: argparse.Namespace, device: torch.device) -> dict[str, Any]:
    model.eval().to("cpu")
    sample = rows[: min(len(rows), 800)]
    top1 = 0
    top3 = 0
    for row in sample:
        predictions = decode_candidates(
            model,
            row["input"],
            input_vocab,
            output_vocab,
            args.max_input_len,
            args.max_output_len,
            beam_width=args.beam_width,
            maximum_candidates=args.maximum_candidates,
        )
        acceptable = set(row.get("acceptable") or [row["target"]])
        if predictions[:1] and predictions[0] in acceptable:
            top1 += 1
        if any(candidate in acceptable for candidate in predictions[:3]):
            top3 += 1
    model.to(device)
    return {
        "sampleRows": len(sample),
        "sampleTop1Accuracy": round(top1 / max(len(sample), 1), 6),
        "sampleTop3Accuracy": round(top3 / max(len(sample), 1), 6),
    }


class CompiledCoreMLBackend:
    def __init__(self, model: Any, expected_shape: tuple[int, int, int], compiled_sha256: str):
        self.model = model
        self.expected_shape = expected_shape
        self.compiled_sha256 = compiled_sha256

    def predict(self, input_ids: np.ndarray, decoder_ids: np.ndarray) -> np.ndarray:
        result = self.model.predict({"inputIds": input_ids, "decoderInputIds": decoder_ids})
        if not isinstance(result, dict) or set(result) != {"logits"}:
            raise SystemExit("Compiled Core ML inference must return exactly one output named logits.")
        logits = np.asarray(result["logits"])
        if logits.shape != self.expected_shape:
            raise SystemExit(
                f"Compiled Core ML logits shape {logits.shape} does not match {self.expected_shape}."
            )
        if logits.dtype.kind != "f" or not np.isfinite(logits).all():
            raise SystemExit("Compiled Core ML inference returned non-floating or non-finite logits.")
        return logits


def validate_coreml_feature_contract(coreml_model: Any, checkpoint: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    specification = coreml_model.get_spec()
    inputs = {feature.name: feature for feature in specification.description.input}
    outputs = {feature.name: feature for feature in specification.description.output}
    if set(inputs) != {"inputIds", "decoderInputIds"} or set(outputs) != {"logits"}:
        raise SystemExit("Compiled Core ML feature names do not match the native runtime contract.")
    int32_type = ct.proto.FeatureTypes_pb2.ArrayFeatureType.INT32
    float16_type = ct.proto.FeatureTypes_pb2.ArrayFeatureType.FLOAT16
    expected_input_shapes = {
        "inputIds": [1, args.max_input_len],
        "decoderInputIds": [1, args.max_output_len - 1],
    }
    for name, expected_shape in expected_input_shapes.items():
        feature = inputs[name].type.multiArrayType
        if list(feature.shape) != expected_shape or feature.dataType != int32_type:
            raise SystemExit(f"Compiled Core ML input {name} does not match the required INT32 shape {expected_shape}.")
    expected_output_shape = [1, args.max_output_len - 1, len(checkpoint["outputVocab"])]
    output = outputs["logits"].type.multiArrayType
    if list(output.shape) != expected_output_shape or output.dataType != float16_type:
        raise SystemExit(
            f"Compiled Core ML output logits must be FLOAT16 with shape {expected_output_shape}."
        )
    return {
        "inputIds": {"shape": expected_input_shapes["inputIds"], "dataType": "INT32"},
        "decoderInputIds": {"shape": expected_input_shapes["decoderInputIds"], "dataType": "INT32"},
        "logits": {"shape": expected_output_shape, "dataType": "FLOAT16"},
    }


def known_answer_tensors(checkpoint: dict[str, Any], args: argparse.Namespace) -> tuple[np.ndarray, np.ndarray]:
    input_vocab = checkpoint["inputVocab"]
    output_vocab = checkpoint["outputVocab"]
    input_tokens = [
        token_id for token, token_id in sorted(input_vocab.items(), key=lambda item: item[1])
        if token not in SPECIAL
    ]
    output_tokens = [
        token_id for token, token_id in sorted(output_vocab.items(), key=lambda item: item[1])
        if token not in SPECIAL
    ]
    if not input_tokens or not output_tokens:
        raise SystemExit("Compiled Core ML attestation requires non-special input and output vocabulary tokens.")
    input_prefix = input_tokens[: min(3, args.max_input_len - 1)] + [input_vocab[EOS]]
    input_ids = np.asarray(
        [input_prefix + [input_vocab[PAD]] * (args.max_input_len - len(input_prefix))],
        dtype=np.int32,
    )
    decoder_prefix = [output_vocab[SOS], output_tokens[0]]
    decoder_length = args.max_output_len - 1
    decoder_ids = np.asarray(
        [decoder_prefix + [output_vocab[PAD]] * (decoder_length - len(decoder_prefix))],
        dtype=np.int32,
    )
    return input_ids, decoder_ids


def load_verified_compiled_coreml(
    pytorch_model: Seq2Seq,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
    expected_compiled_sha256: str,
    expected_mlpackage_sha256: str,
) -> tuple[CompiledCoreMLBackend, dict[str, Any]]:
    if ct is None:
        raise SystemExit(f"Core ML validation is unavailable: {COREML_IMPORT_ERROR}")
    observed_sha256 = directory_sha256(args.compiled_model)
    if observed_sha256 != expected_compiled_sha256:
        raise SystemExit("Compiled Core ML bytes changed before exact-artifact validation.")
    observed_mlpackage_sha256 = directory_sha256(mlpackage_path(args))
    if observed_mlpackage_sha256 != expected_mlpackage_sha256:
        raise SystemExit("Core ML package bytes changed before exact-artifact validation.")
    try:
        package_model = ct.models.MLModel(str(mlpackage_path(args)))
        coreml_model = ct.models.CompiledMLModel(str(args.compiled_model))
    except Exception as error:
        raise SystemExit("Unable to load the exact published compiled Core ML model.") from error
    io_contract = validate_coreml_feature_contract(package_model, checkpoint, args)
    expected_shape = (1, args.max_output_len - 1, len(checkpoint["outputVocab"]))
    backend = CompiledCoreMLBackend(coreml_model, expected_shape, observed_sha256)
    parity_evidence = validate_coreml_known_answer(backend, pytorch_model, checkpoint, args)
    return backend, {
        "status": "passed",
        "compiledModelSha256": observed_sha256,
        "mlpackageSha256": observed_mlpackage_sha256,
        "ioContract": io_contract,
        **parity_evidence,
    }


def validate_coreml_known_answer(
    backend: CompiledCoreMLBackend,
    pytorch_model: Seq2Seq,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    input_ids, decoder_ids = known_answer_tensors(checkpoint, args)
    with torch.no_grad():
        expected = CoreMLWrapper(pytorch_model.eval().to("cpu"))(
            torch.from_numpy(input_ids),
            torch.from_numpy(decoder_ids),
        ).detach().cpu().numpy()
    observed = backend.predict(input_ids, decoder_ids)
    if not np.allclose(observed, expected, rtol=COREML_PARITY_RTOL, atol=COREML_PARITY_ATOL):
        maximum_error = float(np.max(np.abs(observed.astype(np.float64) - expected.astype(np.float64))))
        raise SystemExit(
            f"Exact compiled Core ML logits diverge from the bound checkpoint; max error={maximum_error}."
        )
    known_answer_sha256 = hashlib.sha256(input_ids.tobytes() + decoder_ids.tobytes()).hexdigest()
    return {
        "knownAnswerInputSha256": known_answer_sha256,
        "maximumAbsoluteLogitError": float(
            np.max(np.abs(observed.astype(np.float64) - expected.astype(np.float64)))
        ),
        "relativeTolerance": COREML_PARITY_RTOL,
        "absoluteTolerance": COREML_PARITY_ATOL,
    }


def gold_corpus_sha256(suites: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for suite in suites:
        for value, terminator in (
            (suite.get("id"), b"\0"),
            (suite.get("path"), b"\0"),
            (suite.get("sha256"), b"\0"),
            (suite.get("rows"), b"\n"),
        ):
            digest.update(str(value).encode("utf-8"))
            digest.update(terminator)
    return digest.hexdigest()


def load_verified_gold_rows(args: argparse.Namespace) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    require_repo_regular_file(args.gold_manifest, "gold manifest")
    manifest = read_json(args.gold_manifest)
    suites = manifest.get("suites")
    if manifest.get("schemaVersion") != 2 or not isinstance(suites, list) or not suites:
        raise SystemExit("Gold prediction evidence requires a non-empty schema-v2 gold manifest.")
    if manifest.get("corpusSha256") != gold_corpus_sha256(suites):
        raise SystemExit("Gold manifest corpusSha256 does not match its ordered suite inventory.")
    rows: list[dict[str, Any]] = []
    suite_evidence: list[dict[str, Any]] = []
    seen_suite_ids: set[str] = set()
    seen_row_ids: set[str] = set()
    for suite in suites:
        suite_id = suite.get("id")
        recorded_path = suite.get("path")
        expected_sha256 = suite.get("sha256")
        expected_rows = suite.get("rows")
        if not isinstance(suite_id, str) or not suite_id or suite_id in seen_suite_ids:
            raise SystemExit("Gold manifest suite IDs must be unique non-empty strings.")
        seen_suite_ids.add(suite_id)
        if not isinstance(recorded_path, str) or not recorded_path or Path(recorded_path).is_absolute():
            raise SystemExit(f"Gold suite {suite_id} must use a canonical repository-relative path.")
        normalized_path = Path(recorded_path).as_posix()
        if normalized_path != recorded_path or ".." in Path(recorded_path).parts:
            raise SystemExit(f"Gold suite {suite_id} path is not canonical: {recorded_path}")
        suite_path = ROOT / recorded_path
        require_repo_regular_file(suite_path, f"gold suite {suite_id}")
        observed = inspect_jsonl_artifact(suite_path)
        if observed["sha256"] != expected_sha256:
            raise SystemExit(f"Gold suite {suite_id} SHA-256 does not match the manifest.")
        if observed["rows"] != expected_rows:
            raise SystemExit(f"Gold suite {suite_id} row count does not match the manifest.")
        with open_regular_binary(suite_path, f"gold suite {suite_id}") as handle:
            try:
                lines = handle.read().decode("utf-8").splitlines()
            except UnicodeDecodeError as error:
                raise SystemExit(f"Gold suite {suite_id} is not valid UTF-8.") from error
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"Gold suite {suite_id}:{line_number} is invalid JSON.") from error
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not isinstance(row.get("input"), str):
                raise SystemExit(f"Gold suite {suite_id}:{line_number} has an invalid evidence row.")
            if row["id"] in seen_row_ids:
                raise SystemExit(f"Gold corpus contains duplicate row ID: {row['id']}")
            seen_row_ids.add(row["id"])
            rows.append({**row, "suiteId": suite_id})
        suite_evidence.append({
            "id": suite_id,
            "path": recorded_path,
            "sha256": observed["sha256"],
            "rows": observed["rows"],
        })
    return rows, {
        "goldManifest": rel(args.gold_manifest),
        "goldManifestSha256": sha256_file(args.gold_manifest),
        "goldCorpusSha256": manifest["corpusSha256"],
        "goldSuites": suite_evidence,
        "goldRows": len(rows),
    }


def decode_coreml_candidates(
    backend: CompiledCoreMLBackend,
    text: str,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> list[str]:
    input_vocab = checkpoint["inputVocab"]
    output_vocab = checkpoint["outputVocab"]
    normalized = normalize_input(text)
    if not normalized or any(
        token not in input_vocab or input_vocab[token] == input_vocab[UNK]
        for token in normalized
    ):
        return []
    encoded = encode(list(normalized), input_vocab, args.max_input_len, add_sos=False)
    input_ids = np.asarray([encoded], dtype=np.int32)

    def predict(prefix: list[int], step: int) -> np.ndarray:
        decoder_ids = np.asarray(
            [padded_decoder_ids(prefix, output_vocab, args.max_output_len)],
            dtype=np.int32,
        )
        logits = backend.predict(input_ids, decoder_ids)
        return validated_logit_vector(logits, step, len(output_vocab), "compiled Core ML decoder")

    token_sequences = beam_search_token_ids(
        predict,
        input_grapheme_count=len(normalized),
        max_output_len=args.max_output_len,
        beam_width=args.beam_width,
        maximum_candidates=args.maximum_candidates,
        pad_id=output_vocab[PAD],
        sos_id=output_vocab[SOS],
        eos_id=output_vocab[EOS],
        unk_id=output_vocab[UNK],
        vocab_size=len(output_vocab),
    )
    return decode_token_sequences(token_sequences, output_vocab, args.maximum_candidates)


def write_gold_predictions(
    backend: CompiledCoreMLBackend,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    rows, gold_evidence = load_verified_gold_rows(args)
    output_path = predictions_path(args)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    staging = staging_sibling(output_path, "staging")
    try:
        with staging.open("x", encoding="utf-8") as handle:
            for row in rows:
                candidates = decode_coreml_candidates(backend, row["input"], checkpoint, args)
                handle.write(json.dumps({"id": row["id"], "input": row["input"], "candidates": candidates[:args.maximum_candidates]}, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staging, output_path)
    finally:
        staging.unlink(missing_ok=True)
    _, verified_again = load_verified_gold_rows(args)
    if verified_again != gold_evidence:
        raise SystemExit("Gold corpus changed during exact-artifact prediction generation.")
    if directory_sha256(args.compiled_model) != backend.compiled_sha256:
        raise SystemExit("Compiled Core ML bytes changed during gold prediction generation.")
    return {
        "backend": "coreml-compiled-model",
        "compiledModel": rel(args.compiled_model),
        "compiledModelSha256": backend.compiled_sha256,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        **gold_evidence,
        "predictions": rel(output_path),
        "predictionsSha256": sha256_file(output_path),
    }


def export_coreml(model: Seq2Seq, checkpoint: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_coreml:
        return {"status": "skipped", "trainingRunId": args.training_run_id, "exportRunId": args.export_run_id}
    if ct is None:
        return {
            "status": "failed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "error": f"coremltools import failed: {COREML_IMPORT_ERROR}",
        }
    model.eval()
    wrapper = CoreMLWrapper(model).eval()
    example_input = torch.zeros((1, args.max_input_len), dtype=torch.int32)
    example_input[0, 0] = 4
    example_input[0, 1] = SPECIAL.index(EOS)
    example_decoder = torch.zeros((1, args.max_output_len - 1), dtype=torch.int32)
    example_decoder[0, 0] = SPECIAL.index(SOS)
    package_target = mlpackage_path(args)
    package_staging = staging_sibling(package_target, "staging")
    compiled_staging = staging_sibling(args.compiled_model, "staging")
    coremltools_output = staging_sibling(args.out_dir / "LekhNeuralTransliterator.coremltools.mlmodelc", "compile")
    xcode_output = staging_sibling(args.out_dir / "coreml-compiled", "compile")
    try:
        traced = torch.jit.trace(wrapper, (example_input, example_decoder))
        mlmodel = ct.convert(
            traced,
            convert_to="mlprogram",
            minimum_deployment_target=ct.target.macOS13,
            inputs=[
                ct.TensorType(name="inputIds", shape=example_input.shape, dtype=np.int32),
                ct.TensorType(name="decoderInputIds", shape=example_decoder.shape, dtype=np.int32),
            ],
            outputs=[ct.TensorType(name="logits")],
        )
        package_target.parent.mkdir(parents=True, exist_ok=True)
        mlmodel.save(str(package_staging))
        compiled = ct.models.MLModel(str(package_staging)).get_compiled_model_path()
        if not compiled or not Path(compiled).exists():
            compiled = compile_mlpackage_with_coremltools(package_staging, coremltools_output)
        if not compiled or not Path(compiled).exists():
            compiled = compile_mlpackage_with_xcode(package_staging, xcode_output)
        if not compiled or not Path(compiled).exists():
            return {"status": "failed", "error": "Core ML compilation returned no compiled path."}
        compiled_source = normalize_compiled_model_path(Path(compiled))
        secure_directory_files(compiled_source, require_repo_containment=False)
        shutil.copytree(compiled_source, compiled_staging)
        secure_directory_files(package_staging)
        secure_directory_files(compiled_staging)
        publish_directory(package_staging, package_target)
        publish_directory(compiled_staging, args.compiled_model)
        return {
            "status": "passed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "mlpackage": rel(package_target),
            "mlpackageSha256": directory_sha256(package_target),
            "compiledModel": rel(args.compiled_model),
            "compiledBytes": directory_bytes(args.compiled_model),
            "compiledSha256": directory_sha256(args.compiled_model),
        }
    except Exception as error:  # pragma: no cover - environment-dependent.
        return {"status": "failed", "error": repr(error)}
    finally:
        for temporary in (package_staging, compiled_staging, coremltools_output, xcode_output):
            try:
                safe_remove_sibling_directory(temporary, temporary.parent)
            except Exception:
                pass


def compile_mlpackage_with_coremltools(package_path: Path, output_dir: Path) -> Path | None:
    try:
        if output_dir.exists() or output_dir.is_symlink():
            return None
        output_dir.parent.mkdir(parents=True, exist_ok=True)
        compiled = ct.models.utils.compile_model(str(package_path), str(output_dir))
        return Path(compiled) if compiled else None
    except Exception:
        return None


def normalize_compiled_model_path(path: Path) -> Path:
    if path.name.endswith(".mlmodelc") and (
        (path / "Manifest.json").exists()
        or (path / "model.mil").exists()
        or (path / "model.espresso.net").exists()
    ):
        return path
    children = [child for child in path.iterdir() if child.is_dir() and child.name.endswith(".mlmodelc")]
    if len(children) == 1:
        return children[0]
    return path


def compile_mlpackage_with_xcode(package_path: Path, output_dir: Path) -> Path | None:
    output_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["xcrun", "coremlcompiler", "compile", str(package_path), str(output_dir)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        return None
    candidates = sorted(output_dir.glob("*.mlmodelc"))
    return candidates[0] if candidates else None


def benchmark_coreml(
    args: argparse.Namespace,
    backend: CompiledCoreMLBackend,
    checkpoint: dict[str, Any],
) -> dict[str, Any]:
    arch = platform.machine()
    mapped = "arm64" if arch == "arm64" else "x86_64" if arch in {"x86_64", "amd64"} else arch
    result = {
        "name": "local-mac",
        "macOS": platform.mac_ver()[0] or "unknown",
        "architecture": mapped,
        "packagedApp": False,
        "secureFieldInferenceCount": -1,
        "p50Ms": None,
        "p95Ms": None,
        "p99Ms": None,
    }
    output_path = measurements_path(args)
    try:
        result["artifact"] = rel(args.compiled_model)
        input_ids, decoder_ids = known_answer_tensors(checkpoint, args)
        for _ in range(10):
            backend.predict(input_ids, decoder_ids)
        durations = []
        for _ in range(120):
            started = time.perf_counter()
            backend.predict(input_ids, decoder_ids)
            durations.append((time.perf_counter() - started) * 1000)
        result["p50Ms"] = round(float(np.percentile(durations, 50)), 6)
        result["p95Ms"] = round(float(np.percentile(durations, 95)), 6)
        result["p99Ms"] = round(float(np.percentile(durations, 99)), 6)
    except Exception as error:
        result["error"] = repr(error)
    if directory_sha256(args.compiled_model) != backend.compiled_sha256:
        result["error"] = "Compiled Core ML bytes changed during benchmark execution."
    write_json(output_path, {"generatedAt": iso_now(), "devices": [result]})
    return result


def valid_benchmark_result(result: dict[str, Any], args: argparse.Namespace) -> bool:
    required = {
        "name", "macOS", "architecture", "packagedApp", "secureFieldInferenceCount",
        "p50Ms", "p95Ms", "p99Ms", "artifact",
    }
    return (
        set(result) == required
        and all(isinstance(result.get(key), (int, float)) and math.isfinite(float(result[key])) and result[key] >= 0
                for key in ("p50Ms", "p95Ms", "p99Ms"))
        and isinstance(result.get("artifact"), str)
        and result["artifact"] == rel(args.compiled_model)
    )


def write_vocab_metadata(input_vocab: dict[str, int], output_vocab: dict[str, int], args: argparse.Namespace, dataset_manifest: dict[str, Any]) -> None:
    input_by_id = tokens_by_id(input_vocab)
    output_by_id = tokens_by_id(output_vocab)
    payload = {
        "schemaVersion": 1,
        "modelId": MODEL_ID,
        "generatedAt": iso_now(),
        "tokenization": "unicode-grapheme-character",
        "input": {
            "maxLength": args.max_input_len,
            "tokensById": input_by_id,
            "idsByToken": input_vocab,
            "padId": input_vocab[PAD],
            "sosId": input_vocab[SOS],
            "eosId": input_vocab[EOS],
            "unkId": input_vocab[UNK],
        },
        "output": {
            "maxLength": args.max_output_len,
            "tokensById": output_by_id,
            "idsByToken": output_vocab,
            "padId": output_vocab[PAD],
            "sosId": output_vocab[SOS],
            "eosId": output_vocab[EOS],
            "unkId": output_vocab[UNK],
        },
        "decoder": {
            "type": "beam-search",
            "beamWidth": args.beam_width,
            "rejectWhitespaceCandidates": True,
            "rejectLatinCandidates": True,
        },
        "dataset": {
            "manifest": rel(args.dataset_manifest),
            "manifestSha256": sha256_file(args.dataset_manifest) if args.dataset_manifest.exists() else "",
            "splitSha256": dataset_manifest.get("sha256", {}),
        },
        "nativeRuntimePolicy": {
            "asyncOnly": True,
            "neverInvokeInSecureFields": True,
            "failOpenRawTypingOnError": True,
            "neuralTailOnly": True,
        },
    }
    write_json(args.vocab_metadata, payload)


def tokens_by_id(vocab: dict[str, int]) -> list[str]:
    tokens = [""] * len(vocab)
    for token, index in vocab.items():
        tokens[index] = token
    return tokens


def write_manifest(args: argparse.Namespace, checkpoint: dict[str, Any], training_report: dict[str, Any], coreml: dict[str, Any], benchmark: dict[str, Any]) -> dict[str, Any]:
    if coreml.get("status") != "passed":
        raise SystemExit("Refusing to write a runtime manifest without a successful Core ML export.")
    if not is_run_identifier(args.training_run_id) or not is_run_identifier(args.export_run_id):
        raise SystemExit("Refusing to publish a runtime manifest without valid training/export run identities.")
    if args.training_run_id == args.export_run_id:
        raise SystemExit("Refusing to reuse the training run identity as the export run identity.")
    if (
        checkpoint.get("trainingRunId") != args.training_run_id
        or training_report.get("trainingRunId") != args.training_run_id
        or coreml.get("trainingRunId") != args.training_run_id
        or coreml.get("exportRunId") != args.export_run_id
    ):
        raise SystemExit("Refusing to publish a runtime manifest across mixed training/export runs.")
    checkpoint_sha256 = sha256_file(checkpoint_path(args))
    if training_report.get("checkpointSha256") != checkpoint_sha256:
        raise SystemExit("Refusing to publish a runtime manifest for a stale checkpoint report.")
    model_bytes = directory_bytes(args.compiled_model) if args.compiled_model.exists() else 0
    compiled_sha = directory_sha256(args.compiled_model) if args.compiled_model.exists() else ""
    if not compiled_sha or compiled_sha != coreml.get("compiledSha256"):
        raise SystemExit("Refusing to write a runtime manifest for stale or mismatched compiled-model bytes.")
    artifact_validation = coreml.get("artifactValidation") or {}
    if (
        artifact_validation.get("status") != "passed"
        or artifact_validation.get("compiledModelSha256") != compiled_sha
        or artifact_validation.get("mlpackageSha256") != coreml.get("mlpackageSha256")
        or directory_sha256(mlpackage_path(args)) != coreml.get("mlpackageSha256")
    ):
        raise SystemExit("Refusing to publish a runtime manifest without exact compiled-model attestation.")
    contract_issues = runtime_artifact_contract_issues(args, checkpoint, model_bytes)
    if contract_issues:
        raise SystemExit(f"Refusing to write an invalid native runtime artifact: {'; '.join(contract_issues)}")
    production_eligible = False
    context = args.training_config["context"]
    configured_rescorer = context["languageModelRescorer"]
    training_sources = sorted(
        source for source, count in checkpoint.get("trainingSourceCounts", {}).items()
        if int(count) > 0
    )
    manifest = {
        "schemaVersion": 2,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "selectedArtifact": MODEL_ID,
        "runtime": "CoreML",
        "localOnly": True,
        "neuralTailOnly": True,
        "productionEligible": production_eligible,
        "architecture": args.effective_training_config["architecture"]["family"],
        "openVocabulary": True,
        "tokenization": "unicode-grapheme-character",
        "decoder": "beam-search",
        "beamSearch": {"enabled": True, "beamWidth": args.beam_width, "maxOutputGraphemes": args.max_output_len},
        "languageModelRescorer": {
            "enabled": bool(configured_rescorer["enabled"]),
            "source": str(configured_rescorer["source"]),
            "weight": float(configured_rescorer["weight"]),
        },
        "contextWindowWords": int(context["previousWords"]),
        "parameterCount": int(checkpoint["parameterCount"]),
        "modelBytes": model_bytes,
        "trainingSources": training_sources,
        "datasetReports": ["reports/neural-open-vocab-dataset-report.json"],
        "evaluationReports": ["reports/neural-open-vocab-evaluation.json"],
        "benchmarkReports": ["reports/neural-coreml-device-benchmark.json"],
        "metrics": {
            "tailTop1Accuracy": -1,
            "tailTop3Accuracy": -1,
            "chatConventionTop1Accuracy": -1,
            "chatConventionTop3Accuracy": -1,
            "namesTop3Accuracy": -1,
            "protectedFalseConversionRate": -1,
            "singleTokenPhraseExpansionRate": -1,
            "secureFieldInferenceCount": -1,
        },
        "performance": {
            "p50Ms": benchmark.get("p50Ms") if benchmark.get("p50Ms") is not None else 999,
            "p95Ms": benchmark.get("p95Ms") if benchmark.get("p95Ms") is not None else 999,
            "p99Ms": benchmark.get("p99Ms") if benchmark.get("p99Ms") is not None else 999,
            "targetP99Ms": 3,
            "measuredOnDevice": benchmark.get("p99Ms") is not None,
            "devices": [benchmark],
        },
        "requiredCases": REQUIRED_CASES,
        "sha256": {
            "compiledModel": compiled_sha or "0" * 64,
            "sourceCheckpoint": checkpoint_sha256,
            "trainingDatasetManifest": checkpoint["datasetManifestSha256"],
            "vocabMetadata": checkpoint.get("vocabMetadataSha256", "0" * 64),
        },
        "limitations": production_blockers(),
    }
    write_json(args.manifest, manifest)
    return manifest


def runtime_artifact_contract_issues(
    args: argparse.Namespace,
    checkpoint: dict[str, Any],
    model_bytes: int,
) -> list[str]:
    architecture = args.training_config["architecture"]
    issues = []
    parameter_count = int(checkpoint.get("parameterCount", 0))
    if not int(architecture["minimumParameterCount"]) <= parameter_count <= int(architecture["maximumParameterCount"]):
        issues.append("parameter count is outside the native 1M-5M contract")
    if not 1 <= model_bytes <= int(architecture["maximumCompiledBytes"]):
        issues.append("compiled model size is outside the native 1-16MB contract")
    if not 4 <= args.max_input_len <= 128:
        issues.append("input length is outside the native 4-128 contract")
    if not 8 <= args.max_output_len <= 48:
        issues.append("output length is outside the native 8-48 contract")
    return issues


def production_blockers() -> list[str]:
    return [
        "Context language-model rescoring is disabled and not implemented in this candidate.",
        "Teacher distillation is disabled and no content-addressed distillation run evidence exists.",
        "Not production-eligible until private human-reviewed Phase 7 sources meet required row counts.",
        "Not production-eligible until evaluation is run from exported Core ML predictions on production gold.",
        "Not production-eligible until packaged-app Core ML latency is measured on both arm64 and x86_64 Macs.",
        "Native async Core ML tail integration exists but remains experimental until packaged host-matrix cancellation, secure-transition, end-to-end latency, and candidate-quality evidence passes.",
    ]


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = staging_sibling(path, "staging")
    try:
        with staging.open("x", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def run_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_train:
        loaded = load_checkpoint(args)
    else:
        loaded = train_model(args)
    model: Seq2Seq = loaded["model"]
    checkpoint: dict[str, Any] = loaded["checkpoint"]
    training_report: dict[str, Any] = loaded["report"]
    if args.training_run_id == args.export_run_id:
        raise SystemExit("Training and export publication identities must be distinct.")
    coreml = export_coreml(model, checkpoint, args)
    export_succeeded = coreml.get("status") == "passed"
    prediction_evidence: dict[str, Any] | None = None
    if export_succeeded:
        backend, artifact_validation = load_verified_compiled_coreml(
            model,
            checkpoint,
            args,
            str(coreml["compiledSha256"]),
            str(coreml["mlpackageSha256"]),
        )
        coreml = {**coreml, "artifactValidation": artifact_validation}
        prediction_evidence = write_gold_predictions(backend, checkpoint, args)
        benchmark = benchmark_coreml(args, backend, checkpoint)
    else:
        benchmark = {
            "status": "skipped",
            "reason": "Core ML export did not produce a verified compiled artifact.",
        }
    benchmark_succeeded = export_succeeded and valid_benchmark_result(benchmark, args)
    runtime_contract_issues = runtime_artifact_contract_issues(
        args,
        checkpoint,
        directory_bytes(args.compiled_model) if export_succeeded else 0,
    )
    publishable = benchmark_succeeded and prediction_evidence is not None and not runtime_contract_issues
    manifest = write_manifest(args, checkpoint, training_report, coreml, benchmark) if publishable else None
    if publishable:
        export_status = "passed-open-vocab-seq2seq-candidate"
    elif args.skip_coreml:
        export_status = "passed-training-candidate-coreml-export-skipped"
    elif export_succeeded:
        export_status = "failed-runtime-artifact-contract" if runtime_contract_issues else "failed-coreml-benchmark"
    else:
        export_status = "failed-coreml-export"

    checkpoint_sha256 = sha256_file(checkpoint_path(args))
    training_report_sha256 = sha256_file(training_report_path(args))
    if checkpoint.get("trainingRunId") != args.training_run_id or training_report.get("trainingRunId") != args.training_run_id:
        raise SystemExit("Training run identity changed before export-report publication.")
    if training_report.get("checkpointSha256") != checkpoint_sha256:
        raise SystemExit("Checkpoint bytes changed before export-report publication.")
    compiled_sha256 = directory_sha256(args.compiled_model) if export_succeeded else None
    if export_succeeded and compiled_sha256 != coreml.get("compiledSha256"):
        raise SystemExit("Compiled Core ML bytes changed before export-report publication.")
    mlpackage_sha256 = directory_sha256(mlpackage_path(args)) if export_succeeded else None
    if export_succeeded and mlpackage_sha256 != coreml.get("mlpackageSha256"):
        raise SystemExit("Core ML package bytes changed before export-report publication.")
    if prediction_evidence:
        if prediction_evidence.get("predictionsSha256") != sha256_file(predictions_path(args)):
            raise SystemExit("Gold prediction bytes changed before export-report publication.")
        _, current_gold_evidence = load_verified_gold_rows(args)
        expected_gold_evidence = {
            key: prediction_evidence[key]
            for key in ("goldManifest", "goldManifestSha256", "goldCorpusSha256", "goldSuites", "goldRows")
        }
        if current_gold_evidence != expected_gold_evidence:
            raise SystemExit("Gold evaluation evidence changed before export-report publication.")

    export_report: dict[str, Any] = {
        "generatedAt": iso_now(),
        "status": export_status,
        "modelId": MODEL_ID,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "executionModes": args.execution_modes,
        "trainingContractSha256": args.training_contract_sha256,
        "effectiveTrainingConfigSha256": args.effective_training_config_sha256,
        "effectiveArtifactInputsSha256": args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "runtimeArtifactContractIssues": runtime_contract_issues,
        "checkpoint": rel(checkpoint_path(args)),
        "checkpointSha256": checkpoint_sha256,
        "trainingReport": rel(training_report_path(args)),
        "trainingReportSha256": training_report_sha256,
        "coremlExport": coreml,
        "predictions": prediction_evidence.get("predictions") if prediction_evidence else None,
        "predictionsSha256": prediction_evidence.get("predictionsSha256") if prediction_evidence else None,
        "predictionsBackend": prediction_evidence.get("backend") if prediction_evidence else None,
        "goldManifest": prediction_evidence.get("goldManifest") if prediction_evidence else None,
        "goldManifestSha256": prediction_evidence.get("goldManifestSha256") if prediction_evidence else None,
        "goldCorpusSha256": prediction_evidence.get("goldCorpusSha256") if prediction_evidence else None,
        "goldSuites": prediction_evidence.get("goldSuites") if prediction_evidence else None,
        "goldRows": prediction_evidence.get("goldRows") if prediction_evidence else None,
        "measurements": rel(measurements_path(args)) if export_succeeded else None,
        "measurementsSha256": sha256_file(measurements_path(args)) if export_succeeded else None,
        "compiledModel": rel(args.compiled_model) if export_succeeded else None,
        "compiledModelSha256": compiled_sha256,
        "mlpackage": rel(mlpackage_path(args)) if export_succeeded else None,
        "mlpackageSha256": mlpackage_sha256,
        "manifest": rel(args.manifest) if manifest else None,
        "manifestSha256": sha256_file(args.manifest) if manifest else None,
        "productionEligible": bool(manifest and manifest["productionEligible"]),
        "productionBlockers": production_blockers(),
    }
    write_json(export_report_path(args), export_report)

    print(json.dumps({
        "status": export_status,
        "checkpoint": export_report["checkpoint"],
        "trainingReport": export_report["trainingReport"],
        "exportReport": rel(export_report_path(args)),
        "compiledModel": export_report["compiledModel"],
        "manifest": export_report["manifest"],
        "predictions": export_report["predictions"],
        "measurements": export_report["measurements"],
        "coremlExport": coreml.get("status"),
        "productionEligible": export_report["productionEligible"],
        "productionBlockers": export_report["productionBlockers"],
    }, ensure_ascii=False, indent=2))
    if not publishable and not args.skip_coreml:
        raise SystemExit(1)
    return export_report


def main() -> None:
    args = parse_args()
    with exclusive_run_lock(args):
        run_pipeline(args)


if __name__ == "__main__":
    main()
