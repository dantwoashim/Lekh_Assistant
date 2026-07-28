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
ATTENTION_MODEL_ID = "lekh-open-vocab-bigru-attention-v1"
BASELINE_ARCHITECTURE_FAMILY = "gru-encoder-decoder-seq2seq"
ATTENTION_ARCHITECTURE_FAMILY = "bidirectional-gru-additive-attention-seq2seq"
ADDITIVE_ATTENTION = "bahdanau-additive"
ATTENTION_INCREMENTAL_RUNTIME_CONTRACT = "split-attention-incremental-v1"
OUTPUT_TOKENIZATION = "unicode-scalar-character"
LEGACY_OUTPUT_TOKENIZATION = "unicode-grapheme-character"
OUTPUT_SEQUENCE_VALIDATION = "devanagari-word-sequence-v1"
VOCAB_METADATA_PATH = ROOT / "models/macos/LekhNeuralTransliterator.vocab.json"
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
TRAINING_RECOVERY_SCHEMA_VERSION = 1
TRAINING_RECOVERY_STATE_PATTERN = re.compile(
    r"^\.training-recovery\.[a-f0-9]{32}\.[1-9][0-9]*\.pt$"
)
MAX_TRAINING_RECOVERY_BYTES = 512 * 1024 * 1024


def checkpoint_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "checkpoint.pt"


def training_report_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "training-report.json"


def training_recovery_metadata_path(args: argparse.Namespace) -> Path:
    return args.out_dir / ".training-recovery.json"


def training_recovery_state_path(
    args: argparse.Namespace,
    export_run_id: str,
    completed_epoch: int,
) -> Path:
    if not is_run_identifier(export_run_id) or completed_epoch < 1:
        raise ValueError("Training recovery state requires a valid run id and epoch.")
    return args.out_dir / (
        f".training-recovery.{export_run_id}.{completed_epoch}.pt"
    )


def export_report_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "export-report.json"


def predictions_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "gold-predictions.jsonl"


def official_benchmark_predictions_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "official-benchmark-predictions.jsonl"


def measurements_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "coreml-device-measurements.json"


def mlpackage_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "LekhNeuralTransliterator.mlpackage"


def attention_encoder_mlpackage_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "LekhNeuralTransliteratorEncoder.mlpackage"


def attention_decoder_mlpackage_path(args: argparse.Namespace) -> Path:
    return args.out_dir / "LekhNeuralTransliteratorDecoderStep.mlpackage"


def attention_compiled_model_path(args: argparse.Namespace, role: str) -> Path:
    suffix = "".join(args.compiled_model.suffixes)
    stem = args.compiled_model.name[:-len(suffix)] if suffix else args.compiled_model.name
    role_suffixes = {"encoder": "Encoder", "decoderStep": "DecoderStep"}
    if role not in role_suffixes:
        raise ValueError(f"Unknown attention Core ML artifact role: {role}")
    return args.compiled_model.with_name(f"{stem}{role_suffixes[role]}{suffix}")


def attention_artifact_paths(args: argparse.Namespace) -> dict[str, dict[str, Path]]:
    return {
        "encoder": {
            "mlpackage": attention_encoder_mlpackage_path(args),
            "compiledModel": attention_compiled_model_path(args, "encoder"),
        },
        "decoderStep": {
            "mlpackage": attention_decoder_mlpackage_path(args),
            "compiledModel": attention_compiled_model_path(args, "decoderStep"),
        },
    }


def parse_args(argv: list[str] | None = None, environment: dict[str, str] | None = None) -> argparse.Namespace:
    argv = list(sys.argv[1:] if argv is None else argv)
    environment = dict(os.environ if environment is None else environment)

    config_parser = argparse.ArgumentParser(add_help=False)
    config_parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    config_args, _ = config_parser.parse_known_args(argv)
    config_path = config_args.config.resolve()
    if not config_path.is_file():
        raise SystemExit(f"Missing training config: {config_path}")
    config_bytes = read_regular_bytes(config_path, "training config", maximum_bytes=8 * 1024 * 1024)
    config = parse_json_object_bytes(config_bytes, "training config")
    validate_executable_config(config)

    architecture = config["architecture"]
    decoder = config["decoder"]
    evaluation = config["evaluation"]
    training = config["training"]
    training_run = config["trainingRun"]
    early_stopping = training_run["earlyStopping"]
    encoder_layers = int(architecture["encoderLayers"])
    decoder_layers = int(architecture["decoderLayers"])
    if encoder_layers != decoder_layers:
        raise SystemExit("The current GRU implementation requires matching encoderLayers and decoderLayers.")

    parser = argparse.ArgumentParser(description=__doc__, parents=[config_parser])
    parser.add_argument("--dataset-manifest", type=Path, default=ROOT / training["datasetManifest"])
    parser.add_argument(
        "--gold-manifest",
        type=Path,
        default=ROOT / evaluation["goldManifest"],
    )
    parser.add_argument(
        "--official-benchmark-manifest",
        type=Path,
        default=ROOT / evaluation["officialBenchmarkManifest"],
    )
    parser.add_argument("--out-dir", type=Path, default=(ROOT / config["export"]["sourceCheckpoint"]).parent)
    parser.add_argument("--compiled-model", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--vocab-metadata", type=Path)
    add_configurable_argument(parser, "--max-train-rows", int, training_run["maximumTrainRows"], "LEKH_NEURAL_MAX_TRAIN_ROWS", environment)
    add_configurable_argument(parser, "--max-dev-rows", int, training_run["maximumDevRows"], "LEKH_NEURAL_MAX_DEV_ROWS", environment)
    add_configurable_argument(parser, "--epochs", int, training_run["maximumEpochs"], "LEKH_NEURAL_EPOCHS", environment)
    add_configurable_argument(parser, "--batch-size", int, training_run["batchSize"], "LEKH_NEURAL_BATCH_SIZE", environment)
    add_configurable_argument(parser, "--embedding-dim", int, architecture["embeddingDim"], "LEKH_NEURAL_EMBEDDING_DIM", environment)
    add_configurable_argument(parser, "--hidden-dim", int, architecture["hiddenDim"], "LEKH_NEURAL_HIDDEN_DIM", environment)
    add_configurable_argument(
        parser,
        "--attention-dim",
        int,
        architecture.get("attentionDim", architecture["hiddenDim"]),
        "LEKH_NEURAL_ATTENTION_DIM",
        environment,
    )
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
    parser.add_argument(
        "--restart-training",
        action="store_true",
        help=(
            "Discard a bound incomplete epoch recovery and begin training "
            "again from epoch zero."
        ),
    )
    args = parser.parse_args(argv)
    args.training_config = config
    args.model_id = str(config["modelId"])
    args.architecture_family = str(architecture["family"])
    args.attention_type = str(architecture["attention"])
    candidate_stem = "LekhNeuralTransliterator"
    if args.compiled_model is None:
        args.compiled_model = args.out_dir / f"{candidate_stem}.mlmodelc"
    if args.manifest is None:
        args.manifest = args.out_dir / f"{candidate_stem}.manifest.json"
    if args.vocab_metadata is None:
        args.vocab_metadata = args.out_dir / f"{candidate_stem}.vocab.json"
    validate_effective_args(args, early_stopping)
    validate_output_paths(args)
    args.training_contract_sha256 = hashlib.sha256(config_bytes).hexdigest()
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
    if args.skip_train and args.restart_training:
        raise SystemExit("--skip-train and --restart-training are mutually exclusive.")
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
    architecture = config.get("architecture") or {}
    family = architecture.get("family")
    supported_architectures = {
        BASELINE_ARCHITECTURE_FAMILY: {
            "modelId": MODEL_ID,
            "attention": "none",
            "export": {
                "sourceCheckpoint": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/checkpoint.pt",
                "intermediateMLPackage": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.mlpackage",
                "compiledModel": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.mlmodelc",
                "manifest": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.manifest.json",
                "vocabMetadata": "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.vocab.json",
            },
        },
        ATTENTION_ARCHITECTURE_FAMILY: {
            "modelId": ATTENTION_MODEL_ID,
            "attention": ADDITIVE_ATTENTION,
            "export": {
                "sourceCheckpoint": "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/checkpoint.pt",
                "intermediateMLPackage": "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.mlpackage",
                "compiledModel": "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.mlmodelc",
                "manifest": "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.manifest.json",
                "vocabMetadata": "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.vocab.json",
            },
        },
    }
    binding = supported_architectures.get(family)
    if binding is None:
        raise SystemExit(f"Unsupported executable architecture family: {family!r}.")
    if config.get("modelId") != binding["modelId"]:
        raise SystemExit(f"Training config modelId must be {binding['modelId']} for {family}.")
    if architecture.get("attention") != binding["attention"]:
        raise SystemExit(
            f"Architecture {family} requires attention={binding['attention']}."
        )
    if family == ATTENTION_ARCHITECTURE_FAMILY and int(architecture.get("attentionDim", 0)) <= 0:
        raise SystemExit("The attention challenger requires a positive architecture.attentionDim.")
    context = config.get("context") or {}
    if int(context.get("previousWords", -1)) != 0 or (context.get("languageModelRescorer") or {}).get("enabled") is not False:
        raise SystemExit("Context rescoring is not implemented; the executable config must keep it disabled.")
    if config.get("training", {}).get("loss") != "weighted-label-smoothed-sequence-cross-entropy":
        raise SystemExit("Training config must declare the implemented weighted label-smoothed loss.")
    evaluation = config.get("evaluation") or {}
    if evaluation != {
        "goldManifest": "data/neural/gold/manifest.v3.json",
        "officialBenchmarkManifest": (
            "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
        ),
        "officialBenchmarkTrainingUse": "forbidden-evaluation-only",
    }:
        raise SystemExit(
            "Training config evaluation inputs must bind the locked gold and "
            "official benchmark manifests with evaluation-only use."
        )
    if architecture.get("tokenization") != OUTPUT_TOKENIZATION:
        raise SystemExit(f"Training config must use {OUTPUT_TOKENIZATION} output tokenization.")
    expected_sampling_policy = {
        "type": "deterministic-source-stratified-sampling",
        "version": 1,
        "sourceQuotaWeight": "square-root-of-source-row-count",
        "sourceMultipliers": {},
        "pinnedSources": [
            "manual-ambiguity",
            "manual-chat-tail",
            "manual-name",
            "manual-x-ksha",
            "runtime-names",
        ],
    }
    if config.get("training", {}).get("samplingPolicy") != expected_sampling_policy:
        raise SystemExit("Training config samplingPolicy must match the executable deterministic source-stratified policy.")
    expected_export = binding["export"]
    for field, expected in expected_export.items():
        observed = config.get("export", {}).get(field)
        if field == "vocabMetadata" and observed is None:
            observed = rel(VOCAB_METADATA_PATH)
        if observed != expected:
            raise SystemExit(f"Training config export.{field} must equal {expected}.")
    if config.get("artifact", {}).get("compiledModel") != expected_export["compiledModel"]:
        raise SystemExit("Training config artifact.compiledModel must match export.compiledModel.")
    if config.get("artifact", {}).get("manifest") != expected_export["manifest"]:
        raise SystemExit("Training config artifact.manifest must match export.manifest.")
    artifact_vocab = config.get("artifact", {}).get("vocabMetadata")
    if artifact_vocab is not None and artifact_vocab != expected_export["vocabMetadata"]:
        raise SystemExit("Training config artifact.vocabMetadata must match export.vocabMetadata.")


def validate_effective_args(args: argparse.Namespace, early_stopping: dict[str, Any]) -> None:
    positive_integer_fields = {
        "max_train_rows": args.max_train_rows,
        "max_dev_rows": args.max_dev_rows,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "embedding_dim": args.embedding_dim,
        "hidden_dim": args.hidden_dim,
        "attention_dim": args.attention_dim,
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
    require_safe_output_path(args.out_dir, [generated_root, temporary_root], "output directory", directory=True)
    require_safe_output_path(args.compiled_model, [generated_root, temporary_root], "compiled model", suffix=".mlmodelc", directory=True)
    require_safe_output_path(args.manifest, [generated_root, temporary_root], "runtime manifest", suffix=".json")
    require_safe_output_path(args.vocab_metadata, [generated_root, temporary_root], "vocabulary metadata", suffix=".json")
    if args.model_id == ATTENTION_MODEL_ID:
        baseline_output = ROOT / "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1"
        protected_baseline_paths = {
            "output directory": baseline_output.resolve(),
            "compiled model": (baseline_output / "LekhNeuralTransliterator.mlmodelc").resolve(),
            "runtime manifest": (baseline_output / "LekhNeuralTransliterator.manifest.json").resolve(),
            "vocabulary metadata": (baseline_output / "LekhNeuralTransliterator.vocab.json").resolve(),
        }
        selected_paths = {
            "output directory": args.out_dir.resolve(),
            "compiled model": args.compiled_model.resolve(),
            "runtime manifest": args.manifest.resolve(),
            "vocabulary metadata": args.vocab_metadata.resolve(),
        }
        collisions = [label for label, path in selected_paths.items() if path == protected_baseline_paths[label]]
        if collisions:
            raise SystemExit(
                "Attention challenger outputs cannot replace baseline artifacts: "
                + ", ".join(collisions)
            )
    output_root = args.out_dir.resolve()
    for label, path in (
        ("compiled model", args.compiled_model),
        ("runtime manifest", args.manifest),
        ("vocabulary metadata", args.vocab_metadata),
    ):
        if path.resolve().parent != output_root:
            raise SystemExit(
                f"Candidate {label} must be a direct child of the locked output directory: {path}"
            )
    if len({
        args.compiled_model.resolve(),
        args.manifest.resolve(),
        args.vocab_metadata.resolve(),
    }) != 3:
        raise SystemExit("Candidate compiled model, manifest, and vocabulary paths must be distinct.")


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
            "attentionDim": int(architecture.get("attentionDim", architecture["hiddenDim"])),
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
        "attentionDim": args.attention_dim,
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
    vocab_metadata = ROOT / config["export"].get("vocabMetadata", rel(VOCAB_METADATA_PATH))
    evaluation = config["evaluation"]
    return {
        "trainingConfig": artifact_path_value(config_path),
        "datasetManifest": artifact_path_value(ROOT / config["training"]["datasetManifest"]),
        "goldManifest": artifact_path_value(ROOT / evaluation["goldManifest"]),
        "officialBenchmarkManifest": artifact_path_value(
            ROOT / evaluation["officialBenchmarkManifest"]
        ),
        "outDir": artifact_path_value(checkpoint.parent),
        "compiledModel": artifact_path_value(ROOT / config["export"]["compiledModel"]),
        "manifest": artifact_path_value(ROOT / config["export"]["manifest"]),
        "vocabMetadata": artifact_path_value(vocab_metadata),
    }


def effective_artifact_inputs(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "trainingConfig": artifact_path_value(args.config),
        "datasetManifest": artifact_path_value(args.dataset_manifest),
        "goldManifest": artifact_path_value(args.gold_manifest),
        "officialBenchmarkManifest": artifact_path_value(
            args.official_benchmark_manifest
        ),
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
        "officialBenchmarkManifest": "--official-benchmark-manifest",
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
        "architecture.attentionDim": ("--attention-dim", "LEKH_NEURAL_ATTENTION_DIM"),
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


def output_scalars(value: str) -> list[str]:
    """Tokenize NFC output as exactly one Unicode scalar per lexical token."""
    return list(nfc(value))


def analyze_devanagari_output_sequence(value: str) -> dict[str, Any]:
    """Validate one Devanagari word while preserving legal unfinished prefixes.

    `validPrefix` is suitable for constrained decoding. `terminable` is stricter:
    it also rejects the empty sequence and a trailing ZWJ/ZWNJ whose required
    consonant has not arrived yet. The state machine intentionally validates
    scalar order, not lexical spelling.
    """
    text = str(value or "")
    issue_codes: list[str] = []

    def issue(code: str) -> None:
        if code not in issue_codes:
            issue_codes.append(code)

    if text != unicodedata.normalize("NFC", text):
        issue("not-nfc")

    scalars = list(text)
    base_kind: str | None = None
    dependent_vowel_seen = False
    nukta_seen = False
    after_virama = False
    modifier_seen = False
    syllable_modifier_seen = False
    preceding_mark: str | None = None
    pending_joiner = False

    def reset_unit() -> None:
        nonlocal base_kind, dependent_vowel_seen, nukta_seen
        nonlocal after_virama, modifier_seen, syllable_modifier_seen
        nonlocal preceding_mark, pending_joiner
        base_kind = None
        dependent_vowel_seen = False
        nukta_seen = False
        after_virama = False
        modifier_seen = False
        syllable_modifier_seen = False
        preceding_mark = None
        pending_joiner = False

    for index, scalar in enumerate(scalars):
        code_point = ord(scalar)
        category = unicodedata.category(scalar)
        previous = scalars[index - 1] if index else None
        following = scalars[index + 1] if index + 1 < len(scalars) else None

        if scalar.isspace():
            issue("whitespace")
            reset_unit()
            continue
        if category.startswith("N"):
            issue("digit")
            reset_unit()
            continue
        if category.startswith("P"):
            issue("punctuation")
            reset_unit()
            continue

        if scalar in ("\u200C", "\u200D"):
            if previous != "\u094D":
                issue("joiner-not-after-virama")
            if following is not None and not is_devanagari_consonant(following):
                issue("joiner-not-before-consonant")
            pending_joiner = True
            continue

        if not (0x0900 <= code_point <= 0x097F):
            issue("unsupported-scalar")
            reset_unit()
            continue

        if category.startswith("L"):
            if pending_joiner and not is_devanagari_consonant(scalar):
                issue("joiner-not-before-consonant")
            base_kind = "consonant" if is_devanagari_consonant(scalar) else "other-letter"
            dependent_vowel_seen = False
            nukta_seen = False
            after_virama = False
            modifier_seen = False
            syllable_modifier_seen = False
            preceding_mark = None
            pending_joiner = False
            continue

        if pending_joiner:
            issue("joiner-not-before-consonant")
            pending_joiner = False

        if scalar == "\u093C":
            if base_kind != "consonant" or after_virama or dependent_vowel_seen or modifier_seen:
                issue("orphan-or-misordered-nukta")
            elif nukta_seen:
                issue("duplicate-nukta")
            nukta_seen = True
            preceding_mark = scalar
            continue

        if scalar == "\u094D":
            if base_kind != "consonant" or after_virama:
                issue("virama-without-consonant")
            if dependent_vowel_seen:
                issue("virama-after-dependent-vowel-sign")
            if modifier_seen:
                issue("virama-after-syllable-modifier")
            after_virama = True
            preceding_mark = scalar
            continue

        if is_dependent_vowel_sign(code_point):
            if after_virama:
                issue("dependent-vowel-sign-after-virama")
            if base_kind != "consonant":
                issue("dependent-vowel-sign-without-consonant")
            if dependent_vowel_seen:
                issue("multiple-dependent-vowel-signs")
            if modifier_seen:
                issue("dependent-vowel-sign-after-syllable-modifier")
            dependent_vowel_seen = True
            preceding_mark = scalar
            continue

        if code_point in range(0x0900, 0x0904) or category.startswith("M"):
            if after_virama:
                issue("mark-after-virama")
            elif base_kind is None:
                issue("mark-without-base")
            if preceding_mark == scalar:
                issue("duplicate-mark")
            if code_point in range(0x0900, 0x0904) and syllable_modifier_seen:
                issue("multiple-syllable-modifiers")
            modifier_seen = True
            if code_point in range(0x0900, 0x0904):
                syllable_modifier_seen = True
            preceding_mark = scalar
            continue

        issue("unsupported-devanagari-scalar")
        reset_unit()

    valid_prefix = not issue_codes
    return {
        "validPrefix": valid_prefix,
        "terminable": valid_prefix and bool(scalars) and not pending_joiner,
        "issueCodes": issue_codes,
    }


def is_devanagari_consonant(value: str | None) -> bool:
    if not value or len(value) != 1:
        return False
    code_point = ord(value)
    return (
        0x0915 <= code_point <= 0x0939
        or 0x0958 <= code_point <= 0x095F
        or 0x0978 <= code_point <= 0x097F
    )


def is_dependent_vowel_sign(code_point: int) -> bool:
    return (
        0x093A <= code_point <= 0x093B
        or 0x093E <= code_point <= 0x094C
        or code_point in (0x094E, 0x094F, 0x0962, 0x0963)
        or 0x0955 <= code_point <= 0x0957
    )


def is_valid_output_scalar(value: str) -> bool:
    return (
        len(value) == 1
        and (0x0900 <= ord(value) <= 0x097F or ord(value) in (0x200C, 0x200D))
    )


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


def publish_directories_atomically(publications: list[tuple[Path, Path]]) -> None:
    """Publish a closed set of sibling directory artifacts as one transaction."""
    if not publications:
        raise RuntimeError("Atomic artifact publication requires at least one directory.")
    staging_paths = [staging.resolve() for staging, _ in publications]
    target_paths = [target.resolve() for _, target in publications]
    if len(set(staging_paths)) != len(staging_paths) or len(set(target_paths)) != len(target_paths):
        raise RuntimeError("Atomic artifact publication paths must be unique.")
    if set(staging_paths) & set(target_paths):
        raise RuntimeError("Staged and target artifact paths must not overlap.")

    backups: dict[Path, Path] = {}
    for staging, target in publications:
        if staging.is_symlink() or not staging.is_dir():
            raise RuntimeError(f"Staged artifact is not a safe directory: {staging}")
        if staging.resolve().parent != target.resolve().parent:
            raise RuntimeError("Staged and target artifact directories must share a parent filesystem.")
        if target.is_symlink() or (target.exists() and not target.is_dir()):
            raise RuntimeError(f"Refusing to replace unsafe artifact target: {target}")
        backup = staging_sibling(target, "backup")
        if backup.exists() or backup.is_symlink():
            raise RuntimeError(f"Artifact backup path unexpectedly exists: {backup}")
        backups[target] = backup

    moved_existing: list[Path] = []
    published: list[Path] = []
    try:
        for _, target in publications:
            if target.exists():
                os.replace(target, backups[target])
                moved_existing.append(target)
        for staging, target in publications:
            os.replace(staging, target)
            published.append(target)
    except Exception:
        rollback_errors: list[str] = []
        for target in reversed(published):
            try:
                safe_remove_sibling_directory(target, target.parent)
            except Exception as error:
                rollback_errors.append(f"remove {target}: {error}")
        for target in reversed(moved_existing):
            backup = backups[target]
            try:
                if target.exists() or target.is_symlink():
                    raise RuntimeError(f"rollback target unexpectedly exists: {target}")
                os.replace(backup, target)
            except Exception as error:
                rollback_errors.append(f"restore {target}: {error}")
        if rollback_errors:
            raise RuntimeError(
                "Atomic artifact publication failed and rollback was incomplete: "
                + "; ".join(rollback_errors)
            )
        raise
    for target in moved_existing:
        safe_remove_sibling_directory(backups[target], target.parent)


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
    split_paths: dict[str, Path] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    manifest = read_json(dataset_manifest_path)
    selected_paths = split_paths or verify_dataset_split_artifacts(manifest)
    if set(selected_paths) != {"train", "dev", "test"}:
        raise SystemExit("Training requires one frozen artifact for every dataset split.")
    for split, path in selected_paths.items():
        observed = inspect_jsonl_artifact(path)
        if (
            observed["sha256"] != manifest.get("sha256", {}).get(split)
            or observed["rows"] != manifest.get("counts", {}).get(split)
            or observed["bytes"] != manifest.get("bytes", {}).get(split)
        ):
            raise SystemExit(f"Frozen dataset split {split} does not match its manifest.")
    train_path = selected_paths["train"]
    dev_path = selected_paths["dev"]
    test_path = selected_paths["test"]
    split_identities = {
        "train": load_split_identities(train_path),
        "dev": load_split_identities(dev_path),
        "test": load_split_identities(test_path),
    }
    for left, right in (("train", "dev"), ("train", "test"), ("dev", "test")):
        input_overlap = split_identities[left]["inputs"] & split_identities[right]["inputs"]
        if input_overlap:
            example = sorted(input_overlap)[0]
            raise SystemExit(f"Dataset input leakage between {left} and {right}: {example}")
        target_overlap = split_identities[left]["targets"] & split_identities[right]["targets"]
        if target_overlap:
            example = sorted(target_overlap)[0]
            raise SystemExit(f"Dataset target leakage between {left} and {right}: {example}")
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


def read_regular_bytes(path: Path, label: str, *, maximum_bytes: int) -> bytes:
    with open_regular_binary(path, label) as handle:
        payload = handle.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise SystemExit(f"{label.capitalize()} exceeds the {maximum_bytes}-byte safety limit.")
    return payload


def parse_json_object_bytes(payload: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{label.capitalize()} is not a valid UTF-8 JSON object.") from error
    if not isinstance(value, dict):
        raise SystemExit(f"{label.capitalize()} must be a JSON object.")
    return value


def freeze_verified_dataset_splits(
    args: argparse.Namespace,
    dataset_manifest: dict[str, Any],
    source_paths: dict[str, Path],
) -> dict[str, Path]:
    snapshot_root = args.out_dir / f".run-input-snapshot.{args.export_run_id}"
    if snapshot_root.exists() or snapshot_root.is_symlink():
        raise SystemExit(f"Run-input snapshot path unexpectedly exists: {snapshot_root}")
    snapshot_root.mkdir(parents=True, mode=0o700)
    frozen: dict[str, Path] = {}
    try:
        for split in ("train", "dev", "test"):
            source = source_paths[split]
            target = snapshot_root / f"{split}.jsonl"
            expected_sha256 = dataset_manifest["sha256"][split]
            expected_bytes = int(dataset_manifest["bytes"][split])
            digest = hashlib.sha256()
            byte_count = 0
            with (
                open_regular_binary(source, f"dataset {split} split") as source_handle,
                target.open("xb") as target_handle,
            ):
                for chunk in iter(lambda: source_handle.read(1024 * 1024), b""):
                    digest.update(chunk)
                    byte_count += len(chunk)
                    target_handle.write(chunk)
                target_handle.flush()
                os.fsync(target_handle.fileno())
            if digest.hexdigest() != expected_sha256 or byte_count != expected_bytes:
                raise SystemExit(
                    f"Dataset {split} changed while its immutable run snapshot was being created."
                )
            target.chmod(0o400)
            frozen[split] = target
        return frozen
    except BaseException:
        safe_remove_sibling_directory(snapshot_root, args.out_dir)
        raise


def cleanup_run_input_snapshot(args: argparse.Namespace) -> None:
    snapshot_paths = getattr(args, "run_dataset_split_paths", None)
    if not isinstance(snapshot_paths, dict) or not snapshot_paths:
        return
    roots = {Path(path).parent for path in snapshot_paths.values()}
    if len(roots) != 1:
        raise RuntimeError("Run-input snapshot paths do not share one directory.")
    snapshot_root = roots.pop()
    safe_remove_sibling_directory(snapshot_root, args.out_dir)
    args.run_dataset_split_paths = None


def capture_run_input_snapshot(
    args: argparse.Namespace,
    *,
    freeze_dataset: bool = False,
) -> dict[str, Any]:
    """Capture every mutable source that can influence training or publication."""
    dataset_manifest_bytes = read_regular_bytes(
        args.dataset_manifest,
        "dataset manifest",
        maximum_bytes=8 * 1024 * 1024,
    )
    dataset_manifest = parse_json_object_bytes(dataset_manifest_bytes, "dataset manifest")
    split_paths = verify_dataset_split_artifacts(dataset_manifest)
    evidence_paths = split_paths
    if freeze_dataset:
        frozen_paths = freeze_verified_dataset_splits(args, dataset_manifest, split_paths)
        args.run_dataset_split_paths = frozen_paths
        evidence_paths = frozen_paths
    split_evidence = {
        split: {
            "path": rel(split_paths[split]),
            **inspect_jsonl_artifact(path),
        }
        for split, path in evidence_paths.items()
    }
    _, gold_evidence = load_verified_gold_rows(args)
    official_rows, official_evidence = load_verified_official_benchmark_rows(args)
    official_input_sha256 = official_benchmark_input_sha256(official_rows)
    isolation = getattr(args, "official_benchmark_training_isolation", None)
    expected_isolation_identity = {
        "policy": "official-benchmark-inputs-absent-from-train-and-dev-v1",
        "benchmarkInputSha256": official_input_sha256,
        "comparedSplitSha256": {
            split: split_evidence[split]["sha256"]
            for split in ("train", "dev")
        },
        "overlappingInputCount": 0,
    }
    if isolation is None:
        isolation = verify_official_benchmark_training_isolation(
            official_rows,
            evidence_paths,
            split_evidence,
        )
        args.official_benchmark_training_isolation = isolation
    elif isolation != expected_isolation_identity:
        raise SystemExit(
            "Official benchmark training-isolation evidence changed during this run."
        )
    official_evidence = {
        **official_evidence,
        "trainingIsolation": isolation,
    }
    snapshot = {
        "schemaVersion": 1,
        "trainer": {
            "path": rel(Path(__file__)),
            "sha256": sha256_file(Path(__file__)),
        },
        "trainingConfig": {
            "path": rel(args.config),
            "sha256": hashlib.sha256(read_regular_bytes(
                args.config,
                "training config",
                maximum_bytes=8 * 1024 * 1024,
            )).hexdigest(),
        },
        "dataset": {
            "manifest": rel(args.dataset_manifest),
            "manifestSha256": hashlib.sha256(dataset_manifest_bytes).hexdigest(),
            "contentSha256": dataset_manifest.get("datasetContentSha256"),
            "splits": split_evidence,
        },
        "gold": gold_evidence,
        "officialBenchmark": official_evidence,
        "runtime": {
            "python": platform.python_version(),
            "unicodeDatabase": unicodedata.unidata_version,
            "numpy": np.__version__,
            "torch": str(torch.__version__),
            "coremltools": (
                str(getattr(ct, "__version__"))
                if getattr(ct, "__version__", None) is not None
                else None
            ),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "torchThreads": torch.get_num_threads(),
            "torchInteropThreads": torch.get_num_interop_threads(),
            "deterministicAlgorithms": torch.are_deterministic_algorithms_enabled(),
        },
    }
    if snapshot["trainingConfig"]["sha256"] != args.training_contract_sha256:
        raise SystemExit("Training config changed while the executable arguments were being frozen.")
    if not snapshot["dataset"]["contentSha256"]:
        raise SystemExit("Run input snapshot requires a stable dataset content identity.")
    return snapshot


def ensure_run_input_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    torch.use_deterministic_algorithms(True)
    snapshot = getattr(args, "run_input_snapshot", None)
    if snapshot is None:
        snapshot = capture_run_input_snapshot(args, freeze_dataset=True)
        args.run_input_snapshot = snapshot
    return snapshot


def assert_run_input_snapshot_unchanged(args: argparse.Namespace) -> None:
    expected = ensure_run_input_snapshot(args)
    observed = capture_run_input_snapshot(args)
    if observed != expected:
        raise SystemExit(
            "Trainer, config, dataset, or gold evidence changed during this run; "
            "refusing to publish mixed-provenance artifacts."
        )


def load_split_identities(path: Path) -> dict[str, set[str]]:
    inputs: set[str] = set()
    targets: set[str] = set()
    with open_regular_binary(path, "dataset split") as binary_handle, io.TextIOWrapper(binary_handle, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            value = normalize_input(row.get("input", ""))
            if value:
                inputs.add(value)
            if row.get("action") == "produce-candidate":
                targets.update(normalized_row_targets(row))
    return {"inputs": inputs, "targets": targets}


def load_split_inputs(path: Path) -> set[str]:
    """Compatibility helper retained for callers that only need Roman identities."""
    return load_split_identities(path)["inputs"]


def normalized_row_targets(row: dict[str, Any]) -> list[str]:
    primary = row.get("target")
    acceptable = row.get("acceptable")
    if not isinstance(primary, str):
        raise SystemExit("Dataset candidate target must be a string.")
    if acceptable is None:
        raw_targets = [primary]
    elif not isinstance(acceptable, list) or not all(isinstance(value, str) for value in acceptable):
        raise SystemExit("Dataset acceptable targets must be an array of strings.")
    else:
        raw_targets = [primary, *acceptable]
    output: list[str] = []
    for raw_target in raw_targets:
        target = nfc(raw_target)
        if target and target not in output:
            output.append(target)
    return output


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
            acceptable_targets = normalized_row_targets(row)
            target = acceptable_targets[0] if acceptable_targets else ""
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
            if not target:
                raise SystemExit(f"Dataset {split} row {identifier} has an empty token target.")
            for acceptable_target in acceptable_targets:
                if (
                    any(ch.isspace() for ch in acceptable_target)
                    or contains_ascii_latin(acceptable_target)
                    or not valid_native_output(acceptable_target)
                ):
                    raise SystemExit(
                        f"Dataset {split} row {identifier} contains an invalid acceptable target."
                    )
                if len(output_scalars(acceptable_target)) > max_output_len - 2:
                    raise SystemExit(
                        f"Dataset {split} row {identifier} contains an acceptable target "
                        "that exceeds the configured output length."
                    )
            weight = float(row.get("weight", 1.0))
            if not math.isfinite(weight) or weight <= 0:
                raise SystemExit(f"Dataset {split} row {identifier} has an invalid training weight.")
            rows.append({
                "id": identifier,
                "input": normalized_input,
                "target": target,
                "acceptable": acceptable_targets,
                "sourceIds": source_ids,
                "weight": weight,
            })
    return rows


def contains_ascii_latin(value: str) -> bool:
    return any("A" <= char <= "Z" or "a" <= char <= "z" for char in value)


def valid_native_output(value: str) -> bool:
    return (
        all(is_valid_output_scalar(char) for char in value)
        and analyze_devanagari_output_sequence(value)["terminable"]
    )


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
        "manual-ambiguity",
        "manual-chat-tail",
        "manual-name",
        "manual-x-ksha",
        "runtime-names",
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
        tokens = list(normalize_input(row["input"])) if side == "input" else output_scalars(row["target"])
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
        tgt = encode(output_scalars(row["target"]), self.output_vocab, self.max_output_len, add_sos=True)
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


class BidirectionalPaddedInvariantEncoder(nn.Module):
    """Stacked bidirectional GRU encoder whose recurrent states stop at EOS."""

    def __init__(self, embedding_dim: int, hidden_dim: int, layers: int, dropout: float):
        super().__init__()
        self.forward_layers = nn.ModuleList([
            nn.GRU(embedding_dim if layer == 0 else hidden_dim * 2, hidden_dim, num_layers=1, batch_first=True)
            for layer in range(layers)
        ])
        self.backward_layers = nn.ModuleList([
            nn.GRU(embedding_dim if layer == 0 else hidden_dim * 2, hidden_dim, num_layers=1, batch_first=True)
            for layer in range(layers)
        ])
        self.dropout = nn.Dropout(dropout)

    def forward(
        self,
        embedded: torch.Tensor,
        input_ids: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        eos_positions = input_ids.eq(SPECIAL.index(EOS)).to(torch.int64).argmax(dim=1)
        positions = torch.arange(input_ids.shape[1], device=input_ids.device).view(1, -1)
        valid_mask = positions.le(eos_positions.view(-1, 1))
        expanded_mask = valid_mask.unsqueeze(-1).to(embedded.dtype)
        source_positions = positions.view(1, 1, -1)
        desired_source_positions = eos_positions.view(-1, 1, 1) - positions.view(1, -1, 1)
        reverse_matrix = source_positions.eq(desired_source_positions).to(embedded.dtype)
        eos_selector = input_ids.eq(SPECIAL.index(EOS)).unsqueeze(1).to(embedded.dtype)

        forward_input = embedded * expanded_mask
        backward_input = torch.bmm(reverse_matrix, forward_input)
        encoder_states: list[torch.Tensor] = []
        encoded = forward_input
        for layer_index, (forward_layer, backward_layer) in enumerate(
            zip(self.forward_layers, self.backward_layers)
        ):
            forward_output, _ = forward_layer(forward_input)
            backward_reversed_output, _ = backward_layer(backward_input)
            backward_output = torch.bmm(reverse_matrix, backward_reversed_output)
            encoded = torch.cat((forward_output, backward_output), dim=-1) * expanded_mask

            forward_state = torch.bmm(eos_selector, forward_output).squeeze(1)
            backward_state = torch.bmm(eos_selector, backward_reversed_output).squeeze(1)
            encoder_states.append(torch.cat((forward_state, backward_state), dim=-1))

            if layer_index + 1 < len(self.forward_layers):
                forward_input = self.dropout(encoded) * expanded_mask
                backward_input = torch.bmm(reverse_matrix, forward_input)

        return encoded, torch.stack(encoder_states, dim=0), valid_mask


class AdditiveAttention(nn.Module):
    def __init__(self, encoder_dim: int, decoder_dim: int, attention_dim: int):
        super().__init__()
        self.encoder_projection = nn.Linear(encoder_dim, attention_dim, bias=False)
        self.decoder_projection = nn.Linear(decoder_dim, attention_dim, bias=False)
        self.energy_projection = nn.Linear(attention_dim, 1, bias=False)

    def forward(
        self,
        encoder_outputs: torch.Tensor,
        decoder_outputs: torch.Tensor,
        valid_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        encoder_energy = self.encoder_projection(encoder_outputs).unsqueeze(1)
        decoder_energy = self.decoder_projection(decoder_outputs).unsqueeze(2)
        scores = self.energy_projection(torch.tanh(encoder_energy + decoder_energy)).squeeze(-1)
        mask = valid_mask.unsqueeze(1).to(scores.dtype)
        masked_scores = scores + (mask - 1.0) * 10_000.0
        weights = torch.softmax(masked_scores, dim=-1)
        return torch.bmm(weights, encoder_outputs), weights


class BidirectionalAttentionSeq2Seq(nn.Module):
    """Bidirectional GRU encoder and full-prefix additive-attention decoder."""

    def __init__(
        self,
        input_vocab_size: int,
        output_vocab_size: int,
        embedding_dim: int,
        hidden_dim: int,
        layers: int,
        dropout: float,
        attention_dim: int,
    ):
        super().__init__()
        self.input_embedding = nn.Embedding(input_vocab_size, embedding_dim, padding_idx=0)
        self.output_embedding = nn.Embedding(output_vocab_size, embedding_dim, padding_idx=0)
        self.encoder = BidirectionalPaddedInvariantEncoder(embedding_dim, hidden_dim, layers, dropout)
        self.hidden_bridges = nn.ModuleList([
            nn.Linear(hidden_dim * 2, hidden_dim)
            for _ in range(layers)
        ])
        self.decoder = nn.GRU(
            embedding_dim,
            hidden_dim,
            num_layers=layers,
            batch_first=True,
            dropout=dropout if layers > 1 else 0,
        )
        self.attention = AdditiveAttention(hidden_dim * 2, hidden_dim, attention_dim)
        self.context_fusion = nn.Linear(hidden_dim * 3, hidden_dim)
        self.projection = nn.Linear(hidden_dim, output_vocab_size)

    def encode_context(
        self,
        input_ids: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        encoder_outputs, encoder_states, valid_mask = self.encoder(
            self.input_embedding(input_ids),
            input_ids,
        )
        decoder_states = [
            torch.tanh(bridge(encoder_states[index]))
            for index, bridge in enumerate(self.hidden_bridges)
        ]
        return encoder_outputs, torch.stack(decoder_states, dim=0), valid_mask

    def forward(self, input_ids: torch.Tensor, decoder_input_ids: torch.Tensor) -> torch.Tensor:
        encoder_outputs, decoder_hidden, valid_mask = self.encode_context(input_ids)
        decoder_outputs, _ = self.decoder(self.output_embedding(decoder_input_ids), decoder_hidden)
        context, _ = self.attention(encoder_outputs, decoder_outputs, valid_mask)
        fused = torch.tanh(self.context_fusion(torch.cat((decoder_outputs, context), dim=-1)))
        return self.projection(fused)


def build_model_from_runtime_config(
    input_vocab_size: int,
    output_vocab_size: int,
    runtime_config: dict[str, Any],
) -> nn.Module:
    family = runtime_config.get("architecture_family")
    attention = runtime_config.get("attention")
    common = {
        "input_vocab_size": input_vocab_size,
        "output_vocab_size": output_vocab_size,
        "embedding_dim": int(runtime_config["embedding_dim"]),
        "hidden_dim": int(runtime_config["hidden_dim"]),
        "layers": int(runtime_config["layers"]),
        "dropout": float(runtime_config["dropout"]),
    }
    if family == BASELINE_ARCHITECTURE_FAMILY and attention == "none":
        return Seq2Seq(**common)
    if family == ATTENTION_ARCHITECTURE_FAMILY and attention == ADDITIVE_ATTENTION:
        return BidirectionalAttentionSeq2Seq(
            **common,
            attention_dim=int(runtime_config["attention_dim"]),
        )
    raise SystemExit(
        f"Checkpoint names an unsupported architecture binding: family={family!r}, attention={attention!r}."
    )


def load_model_from_checkpoint_payload(checkpoint: dict[str, Any]) -> nn.Module:
    runtime_config = checkpoint.get("config")
    if not isinstance(runtime_config, dict):
        raise SystemExit("Checkpoint is missing its recorded runtime architecture config.")
    if runtime_config.get("model_id") != checkpoint.get("modelId"):
        raise SystemExit("Checkpoint modelId is inconsistent with its recorded runtime architecture config.")
    input_vocab = checkpoint.get("inputVocab")
    output_vocab = checkpoint.get("outputVocab")
    state_dict = checkpoint.get("stateDict")
    if not isinstance(input_vocab, dict) or not isinstance(output_vocab, dict) or not isinstance(state_dict, dict):
        raise SystemExit("Checkpoint is missing model vocabulary or state-dictionary data.")
    model = build_model_from_runtime_config(len(input_vocab), len(output_vocab), runtime_config)
    try:
        model.load_state_dict(state_dict)
    except RuntimeError as error:
        raise SystemExit("Checkpoint state dictionary does not match its recorded architecture family.") from error
    return model


class CoreMLWrapper(nn.Module):
    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model

    def forward(self, input_ids: torch.Tensor, decoder_input_ids: torch.Tensor) -> torch.Tensor:
        return self.model(input_ids.long(), decoder_input_ids.long())


class CoreMLAttentionEncoderWrapper(nn.Module):
    """Source-only half of the macOS 13 incremental attention contract."""

    def __init__(self, model: BidirectionalAttentionSeq2Seq):
        super().__init__()
        if not isinstance(model, BidirectionalAttentionSeq2Seq):
            raise TypeError("The incremental encoder requires BidirectionalAttentionSeq2Seq.")
        self.model = model

    def forward(
        self,
        input_ids: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        encoder_outputs, initial_decoder_hidden, valid_mask = self.model.encode_context(input_ids.long())
        # The encoder-side attention projection depends only on the source.
        # Export it once so the step model does not repeat this matrix multiply
        # for every beam and every output grapheme.
        encoder_energy = self.model.attention.encoder_projection(encoder_outputs)
        return (
            encoder_outputs,
            encoder_energy,
            valid_mask.to(encoder_outputs.dtype),
            initial_decoder_hidden,
        )


class CoreMLAttentionDecoderStepWrapper(nn.Module):
    """One fixed-width decoder step with explicit recurrent state I/O."""

    def __init__(self, model: BidirectionalAttentionSeq2Seq, beam_width: int):
        super().__init__()
        if not isinstance(model, BidirectionalAttentionSeq2Seq):
            raise TypeError("The incremental decoder requires BidirectionalAttentionSeq2Seq.")
        if beam_width < 1:
            raise ValueError("Incremental decoder beam_width must be positive.")
        self.model = model
        self.beam_width = beam_width

    def forward(
        self,
        decoder_token_ids: torch.Tensor,
        decoder_hidden: torch.Tensor,
        encoder_outputs: torch.Tensor,
        encoder_energy: torch.Tensor,
        valid_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        # Source tensors remain batch-one across the Core ML boundary. Expand
        # them inside the graph so four beam lanes do not copy approximately
        # 50 KiB of invariant attention context on every decoder invocation.
        expanded_outputs = encoder_outputs.expand(self.beam_width, -1, -1)
        expanded_energy = encoder_energy.expand(self.beam_width, -1, -1)
        expanded_mask = valid_mask.expand(self.beam_width, -1)

        decoder_output, next_decoder_hidden = self.model.decoder(
            self.model.output_embedding(decoder_token_ids.long()),
            decoder_hidden,
        )
        decoder_energy = self.model.attention.decoder_projection(decoder_output)
        scores = self.model.attention.energy_projection(
            torch.tanh(expanded_energy + decoder_energy)
        ).squeeze(-1)
        masked_scores = scores + (expanded_mask.to(scores.dtype) - 1.0) * 10_000.0
        weights = torch.softmax(masked_scores, dim=-1)
        context = torch.bmm(weights.unsqueeze(1), expanded_outputs)
        fused = torch.tanh(
            self.model.context_fusion(torch.cat((decoder_output, context), dim=-1))
        )
        step_logits = self.model.projection(fused).squeeze(1)
        return step_logits, next_decoder_hidden


def attention_incremental_tensor_contract(
    model: BidirectionalAttentionSeq2Seq,
    max_input_len: int,
    beam_width: int,
) -> dict[str, dict[str, dict[str, Any]]]:
    """Derive the closed tensor contract from the bound attention model."""
    if not isinstance(model, BidirectionalAttentionSeq2Seq):
        raise TypeError("The incremental tensor contract requires BidirectionalAttentionSeq2Seq.")
    if max_input_len < 2:
        raise ValueError("Incremental encoder max_input_len must reserve a lexical token and EOS.")
    if beam_width < 1:
        raise ValueError("Incremental decoder beam_width must be positive.")

    layers = int(model.decoder.num_layers)
    hidden_dim = int(model.decoder.hidden_size)
    encoder_dim = int(model.attention.encoder_projection.in_features)
    attention_dim = int(model.attention.encoder_projection.out_features)
    output_vocab_size = int(model.projection.out_features)
    return {
        "encoder": {
            "inputs": {
                "inputIds": {"shape": [1, max_input_len], "dataType": "INT32"},
            },
            "outputs": {
                "encoderOutputs": {"shape": [1, max_input_len, encoder_dim], "dataType": "FLOAT16"},
                "encoderEnergy": {"shape": [1, max_input_len, attention_dim], "dataType": "FLOAT16"},
                "validMask": {"shape": [1, max_input_len], "dataType": "FLOAT16"},
                "initialDecoderHidden": {"shape": [layers, 1, hidden_dim], "dataType": "FLOAT16"},
            },
        },
        "decoderStep": {
            "inputs": {
                "decoderTokenIds": {"shape": [beam_width, 1], "dataType": "INT32"},
                "decoderHidden": {"shape": [layers, beam_width, hidden_dim], "dataType": "FLOAT16"},
                "encoderOutputs": {"shape": [1, max_input_len, encoder_dim], "dataType": "FLOAT16"},
                "encoderEnergy": {"shape": [1, max_input_len, attention_dim], "dataType": "FLOAT16"},
                "validMask": {"shape": [1, max_input_len], "dataType": "FLOAT16"},
            },
            "outputs": {
                "stepLogits": {"shape": [beam_width, output_vocab_size], "dataType": "FLOAT16"},
                "nextDecoderHidden": {"shape": [layers, beam_width, hidden_dim], "dataType": "FLOAT16"},
            },
        },
    }


def run_attention_incrementally(
    model: BidirectionalAttentionSeq2Seq,
    input_ids: torch.Tensor,
    decoder_input_ids: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Pure-PyTorch reference rollout for export and runtime parity tests."""
    if not isinstance(model, BidirectionalAttentionSeq2Seq):
        raise TypeError("Incremental rollout requires BidirectionalAttentionSeq2Seq.")
    if input_ids.ndim != 2 or input_ids.shape[0] != 1:
        raise ValueError("Incremental rollout requires one shared source row.")
    if decoder_input_ids.ndim != 2 or decoder_input_ids.shape[0] < 1:
        raise ValueError("Incremental rollout requires at least one decoder lane.")

    beam_width = int(decoder_input_ids.shape[0])
    encoder = CoreMLAttentionEncoderWrapper(model)
    decoder = CoreMLAttentionDecoderStepWrapper(model, beam_width)
    encoder_outputs, encoder_energy, valid_mask, initial_hidden = encoder(input_ids)
    hidden = initial_hidden.expand(-1, beam_width, -1).contiguous()
    steps: list[torch.Tensor] = []
    for index in range(int(decoder_input_ids.shape[1])):
        logits, hidden = decoder(
            decoder_input_ids[:, index : index + 1],
            hidden,
            encoder_outputs,
            encoder_energy,
            valid_mask,
        )
        steps.append(logits.unsqueeze(1))

    if steps:
        return torch.cat(steps, dim=1), hidden
    empty = encoder_outputs.new_empty((beam_width, 0, model.projection.out_features))
    return empty, hidden


def convert_attention_incremental_coreml_for_testing(
    model: BidirectionalAttentionSeq2Seq,
    *,
    max_input_len: int,
    beam_width: int,
    minimum_deployment_target: Any | None = None,
) -> dict[str, Any]:
    """Convert split models in memory without saving or publishing artifacts.

    Shipping export remains deliberately unchanged until recurrent Core ML and
    native candidate parity are proven against a trained challenger checkpoint.
    """
    if ct is None:
        raise RuntimeError(f"Core ML conversion is unavailable: {COREML_IMPORT_ERROR}")
    contract = attention_incremental_tensor_contract(model, max_input_len, beam_width)
    target = minimum_deployment_target or ct.target.macOS13
    encoder_wrapper = CoreMLAttentionEncoderWrapper(model)
    decoder_wrapper = CoreMLAttentionDecoderStepWrapper(model, beam_width)
    input_vocab_size = int(model.input_embedding.num_embeddings)
    if input_vocab_size <= len(SPECIAL):
        raise ValueError("Incremental encoder requires at least one lexical input token.")
    lexical_token_id = len(SPECIAL)

    example_input = torch.zeros((1, max_input_len), dtype=torch.int32)
    example_input[0, 0] = lexical_token_id
    example_input[0, 1] = SPECIAL.index(EOS)
    example_tokens = torch.full(
        (beam_width, 1),
        SPECIAL.index(SOS),
        dtype=torch.int32,
    )
    was_training = model.training
    model.eval()
    try:
        with torch.no_grad():
            encoder_example = encoder_wrapper(example_input)
            example_hidden = encoder_example[3].expand(-1, beam_width, -1).contiguous()
        traced_encoder = torch.jit.trace(encoder_wrapper.eval(), example_input)
        traced_decoder = torch.jit.trace(
            decoder_wrapper.eval(),
            (
                example_tokens,
                example_hidden,
                encoder_example[0],
                encoder_example[1],
                encoder_example[2],
            ),
        )
        encoder_model = ct.convert(
            traced_encoder,
            convert_to="mlprogram",
            minimum_deployment_target=target,
            inputs=[
                ct.TensorType(name="inputIds", shape=(1, max_input_len), dtype=np.int32),
            ],
            outputs=[
                ct.TensorType(name="encoderOutputs", dtype=np.float16),
                ct.TensorType(name="encoderEnergy", dtype=np.float16),
                ct.TensorType(name="validMask", dtype=np.float16),
                ct.TensorType(name="initialDecoderHidden", dtype=np.float16),
            ],
        )
        decoder_model = ct.convert(
            traced_decoder,
            convert_to="mlprogram",
            minimum_deployment_target=target,
            inputs=[
                ct.TensorType(name="decoderTokenIds", shape=(beam_width, 1), dtype=np.int32),
                ct.TensorType(
                    name="decoderHidden",
                    shape=tuple(contract["decoderStep"]["inputs"]["decoderHidden"]["shape"]),
                    dtype=np.float16,
                ),
                ct.TensorType(
                    name="encoderOutputs",
                    shape=tuple(contract["decoderStep"]["inputs"]["encoderOutputs"]["shape"]),
                    dtype=np.float16,
                ),
                ct.TensorType(
                    name="encoderEnergy",
                    shape=tuple(contract["decoderStep"]["inputs"]["encoderEnergy"]["shape"]),
                    dtype=np.float16,
                ),
                ct.TensorType(
                    name="validMask",
                    shape=tuple(contract["decoderStep"]["inputs"]["validMask"]["shape"]),
                    dtype=np.float16,
                ),
            ],
            outputs=[
                ct.TensorType(name="stepLogits", dtype=np.float16),
                ct.TensorType(name="nextDecoderHidden", dtype=np.float16),
            ],
        )
    finally:
        model.train(was_training)
    return {
        "encoderModel": encoder_model,
        "decoderStepModel": decoder_model,
        "contract": contract,
    }


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
    model: nn.Module,
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
        "model_id": args.model_id,
        "architecture_family": args.architecture_family,
        "attention": args.attention_type,
        "embedding_dim": args.embedding_dim,
        "hidden_dim": args.hidden_dim,
        "attention_dim": args.attention_dim,
        "layers": args.layers,
        "dropout": args.dropout,
        "max_input_len": args.max_input_len,
        "max_output_len": args.max_output_len,
        "beam_width": args.beam_width,
        "maximum_candidates": args.maximum_candidates,
    }


def training_recovery_identity(
    args: argparse.Namespace,
    run_input_snapshot: dict[str, Any],
    input_vocab: dict[str, int],
    output_vocab: dict[str, int],
    train_rows: list[dict[str, Any]],
    dev_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
        "modelId": args.model_id,
        "trainingContractSha256": args.training_contract_sha256,
        "effectiveTrainingConfigSha256":
            args.effective_training_config_sha256,
        "effectiveArtifactInputsSha256":
            args.effective_artifact_inputs_sha256,
        "runtimeConfig": checkpoint_runtime_config(args),
        "runInputSnapshot": run_input_snapshot,
        "inputVocabSha256": sha256_json(input_vocab),
        "outputVocabSha256": sha256_json(output_vocab),
        "sampledRowDigests": {
            "train": sampled_rows_sha256(train_rows),
            "dev": sampled_rows_sha256(dev_rows),
        },
    }


def training_recovery_state_files(args: argparse.Namespace) -> list[Path]:
    if not args.out_dir.exists():
        return []
    files: list[Path] = []
    for path in args.out_dir.iterdir():
        if not TRAINING_RECOVERY_STATE_PATTERN.fullmatch(path.name):
            continue
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(
                f"Refusing unsafe training recovery state: {path}"
            )
        if path.resolve().parent != args.out_dir.resolve():
            raise SystemExit(
                f"Training recovery state escaped the candidate root: {path}"
            )
        files.append(path)
    return sorted(files)


def clear_training_recovery(args: argparse.Namespace) -> None:
    metadata_path = training_recovery_metadata_path(args)
    if metadata_path.is_symlink():
        raise SystemExit(
            f"Refusing symbolic-link training recovery metadata: {metadata_path}"
        )
    if metadata_path.exists():
        if not metadata_path.is_file():
            raise SystemExit(
                f"Training recovery metadata is not a regular file: {metadata_path}"
            )
        metadata_path.unlink()
    for path in training_recovery_state_files(args):
        path.unlink()


def save_training_recovery(
    args: argparse.Namespace,
    *,
    identity: dict[str, Any],
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    training_generator: torch.Generator,
    completed_epoch: int,
    losses: list[float],
    epoch_metrics: list[dict[str, Any]],
    best_state: dict[str, torch.Tensor],
    best_dev_loss: float,
    best_epoch: int,
    epochs_without_improvement: int,
    stopped_early: bool,
    training_duration_seconds: float,
    resume_count: int,
    export_run_ids: list[str],
) -> Path:
    if completed_epoch < 1 or len(epoch_metrics) != completed_epoch:
        raise ValueError("Training recovery epoch history is inconsistent.")
    if len(losses) != completed_epoch or not math.isfinite(best_dev_loss):
        raise ValueError("Training recovery loss history is inconsistent.")
    assert_run_input_snapshot_unchanged(args)
    state_path = training_recovery_state_path(
        args,
        args.export_run_id,
        completed_epoch,
    )
    if state_path.exists() or state_path.is_symlink():
        raise SystemExit(
            f"Training recovery generation unexpectedly exists: {state_path}"
        )
    state_staging = staging_sibling(state_path, "staging")
    payload = {
        "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "createdByExportRunId": args.export_run_id,
        "identity": identity,
        "identitySha256": sha256_json(identity),
        "completedEpoch": completed_epoch,
        "modelState": {
            name: value.detach().cpu().clone()
            for name, value in model.state_dict().items()
        },
        "optimizerState": optimizer.state_dict(),
        "trainingGeneratorState":
            training_generator.get_state().detach().cpu().clone(),
        "torchRngState": torch.get_rng_state().detach().cpu().clone(),
        "losses": list(losses),
        "epochMetrics": copy.deepcopy(epoch_metrics),
        "bestState": {
            name: value.detach().cpu().clone()
            for name, value in best_state.items()
        },
        "bestDevWeightedTokenCrossEntropy": best_dev_loss,
        "bestEpoch": best_epoch,
        "epochsWithoutImprovement": epochs_without_improvement,
        "stoppedEarly": stopped_early,
        "trainingDurationSeconds": training_duration_seconds,
        "resumeCount": resume_count,
        "exportRunIds": list(export_run_ids),
    }
    try:
        with state_staging.open("xb") as handle:
            torch.save(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        if state_staging.stat().st_size > MAX_TRAINING_RECOVERY_BYTES:
            raise SystemExit(
                "Training recovery state exceeds the 512 MiB safety limit."
            )
        os.replace(state_staging, state_path)
    finally:
        state_staging.unlink(missing_ok=True)

    state_sha256 = sha256_file(state_path)
    metadata = {
        "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
        "status": "recoverable-incomplete-training",
        "updatedAt": iso_now(),
        "stateFile": state_path.name,
        "stateSha256": state_sha256,
        "stateBytes": state_path.stat().st_size,
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "createdByExportRunId": args.export_run_id,
        "completedEpoch": completed_epoch,
        "identitySha256": payload["identitySha256"],
    }
    write_json(training_recovery_metadata_path(args), metadata)
    for obsolete in training_recovery_state_files(args):
        if obsolete != state_path:
            obsolete.unlink()
    return state_path


def load_training_recovery(
    args: argparse.Namespace,
    *,
    identity: dict[str, Any],
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    training_generator: torch.Generator,
) -> dict[str, Any] | None:
    metadata_path = training_recovery_metadata_path(args)
    states = training_recovery_state_files(args)
    preloaded_recovery: dict[str, Any] | None = None
    recovered_orphan_pointer = False
    if not metadata_path.exists():
        if len(states) > 1:
            raise SystemExit(
                "Multiple orphaned training recovery states exist without an "
                "atomic metadata pointer; pass --restart-training to discard them."
            )
        if not states:
            return None
        state_path = states[0]
        preloaded_recovery = load_training_recovery_payload(state_path)
        metadata = {
            "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
            "status": "recoverable-incomplete-training",
            "updatedAt": iso_now(),
            "stateFile": state_path.name,
            "stateSha256": sha256_file(state_path),
            "stateBytes": state_path.stat().st_size,
            "modelId": preloaded_recovery.get("modelId"),
            "trainingRunId": preloaded_recovery.get("trainingRunId"),
            "createdByExportRunId":
                preloaded_recovery.get("createdByExportRunId"),
            "completedEpoch": preloaded_recovery.get("completedEpoch"),
            "identitySha256": preloaded_recovery.get("identitySha256"),
        }
        recovered_orphan_pointer = True
    else:
        metadata = read_json(metadata_path)
    required_metadata = {
        "schemaVersion",
        "status",
        "updatedAt",
        "stateFile",
        "stateSha256",
        "stateBytes",
        "modelId",
        "trainingRunId",
        "createdByExportRunId",
        "completedEpoch",
        "identitySha256",
    }
    if set(metadata) != required_metadata:
        raise SystemExit(
            "Training recovery metadata has an unsupported closed schema; "
            "pass --restart-training to discard it."
        )
    state_name = metadata.get("stateFile")
    if not isinstance(state_name, str) or not (
        TRAINING_RECOVERY_STATE_PATTERN.fullmatch(state_name)
    ):
        raise SystemExit("Training recovery metadata names an unsafe state file.")
    state_path = args.out_dir / state_name
    if state_path not in states:
        raise SystemExit("Training recovery metadata points to a missing state.")
    state_bytes = state_path.stat().st_size
    if (
        metadata.get("schemaVersion") != TRAINING_RECOVERY_SCHEMA_VERSION
        or metadata.get("status") != "recoverable-incomplete-training"
        or metadata.get("modelId") != args.model_id
        or metadata.get("stateBytes") != state_bytes
        or state_bytes < 1
        or state_bytes > MAX_TRAINING_RECOVERY_BYTES
        or metadata.get("stateSha256") != sha256_file(state_path)
        or metadata.get("identitySha256") != sha256_json(identity)
    ):
        raise SystemExit(
            "Training recovery metadata is stale or corrupt; pass "
            "--restart-training to discard it."
        )
    recovery = (
        preloaded_recovery
        if preloaded_recovery is not None
        else load_training_recovery_payload(state_path)
    )
    if not isinstance(recovery, dict):
        raise SystemExit("Training recovery payload must be an object.")
    required_recovery = {
        "schemaVersion",
        "modelId",
        "trainingRunId",
        "createdByExportRunId",
        "identity",
        "identitySha256",
        "completedEpoch",
        "modelState",
        "optimizerState",
        "trainingGeneratorState",
        "torchRngState",
        "losses",
        "epochMetrics",
        "bestState",
        "bestDevWeightedTokenCrossEntropy",
        "bestEpoch",
        "epochsWithoutImprovement",
        "stoppedEarly",
        "trainingDurationSeconds",
        "resumeCount",
        "exportRunIds",
    }
    if set(recovery) != required_recovery:
        raise SystemExit(
            "Training recovery payload has an unsupported closed schema."
        )
    if (
        recovery.get("schemaVersion") != TRAINING_RECOVERY_SCHEMA_VERSION
        or recovery.get("modelId") != args.model_id
        or not is_run_identifier(recovery.get("trainingRunId"))
        or not is_run_identifier(recovery.get("createdByExportRunId"))
        or recovery.get("identity") != identity
        or recovery.get("identitySha256") != sha256_json(identity)
        or recovery.get("identitySha256") != metadata["identitySha256"]
        or recovery.get("trainingRunId") != metadata["trainingRunId"]
        or recovery.get("createdByExportRunId")
            != metadata["createdByExportRunId"]
        or recovery.get("completedEpoch") != metadata["completedEpoch"]
        or type(recovery.get("completedEpoch")) is not int
        or recovery["completedEpoch"] < 1
        or state_path.name != training_recovery_state_path(
            args,
            recovery.get("createdByExportRunId"),
            recovery.get("completedEpoch"),
        ).name
    ):
        raise SystemExit(
            "Training recovery payload identity is stale or corrupt; pass "
            "--restart-training to discard it."
        )
    completed_epoch = recovery["completedEpoch"]
    if (
        type(completed_epoch) is not int
        or not 1 <= completed_epoch <= args.epochs
        or not isinstance(recovery.get("losses"), list)
        or len(recovery["losses"]) != completed_epoch
        or any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            for value in recovery["losses"]
        )
        or not isinstance(recovery.get("epochMetrics"), list)
        or len(recovery["epochMetrics"]) != completed_epoch
        or type(recovery.get("bestEpoch")) is not int
        or not 1 <= recovery["bestEpoch"] <= completed_epoch
        or not math.isfinite(
            float(recovery.get("bestDevWeightedTokenCrossEntropy", math.inf))
        )
        or type(recovery.get("epochsWithoutImprovement")) is not int
        or recovery["epochsWithoutImprovement"] < 0
        or not isinstance(recovery.get("trainingDurationSeconds"), (int, float))
        or not math.isfinite(float(recovery["trainingDurationSeconds"]))
        or recovery["trainingDurationSeconds"] < 0
        or type(recovery.get("resumeCount")) is not int
        or recovery["resumeCount"] < 0
        or not isinstance(recovery.get("exportRunIds"), list)
        or not all(
            is_run_identifier(value) for value in recovery["exportRunIds"]
        )
        or len(set(recovery["exportRunIds"]))
            != len(recovery["exportRunIds"])
        or len(recovery["exportRunIds"]) != recovery["resumeCount"] + 1
        or recovery["exportRunIds"][-1]
            != recovery["createdByExportRunId"]
        or not isinstance(recovery.get("stoppedEarly"), bool)
        or not valid_recovery_epoch_metrics(recovery)
    ):
        raise SystemExit("Training recovery progress metadata is invalid.")
    try:
        model.load_state_dict(recovery["modelState"])
        optimizer.load_state_dict(recovery["optimizerState"])
        training_generator.set_state(recovery["trainingGeneratorState"])
        torch.set_rng_state(recovery["torchRngState"])
    except (KeyError, RuntimeError, TypeError, ValueError) as error:
        raise SystemExit(
            "Training recovery tensor or optimizer state is incompatible."
        ) from error
    best_state = recovery.get("bestState")
    if not isinstance(best_state, dict) or set(best_state) != set(
        model.state_dict()
    ):
        raise SystemExit("Training recovery best-state inventory is invalid.")
    args.training_run_id = recovery["trainingRunId"]
    if recovered_orphan_pointer:
        write_json(metadata_path, metadata)
        print(
            json.dumps(
                {
                    "status": "recovered-orphaned-training-pointer",
                    "trainingRunId": args.training_run_id,
                    "completedEpoch": completed_epoch,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    for obsolete in states:
        if obsolete != state_path:
            obsolete.unlink()
    print(
        json.dumps(
            {
                "status": "resumed-training-recovery",
                "trainingRunId": args.training_run_id,
                "completedEpoch": completed_epoch,
                "resumeCount": recovery["resumeCount"] + 1,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return recovery


def load_training_recovery_payload(state_path: Path) -> dict[str, Any]:
    state_bytes = state_path.stat().st_size
    if not 1 <= state_bytes <= MAX_TRAINING_RECOVERY_BYTES:
        raise SystemExit(
            "Training recovery state is empty or exceeds the 512 MiB safety limit."
        )
    try:
        with open_regular_binary(state_path, "training recovery state") as handle:
            recovery = torch.load(handle, map_location="cpu", weights_only=True)
    except Exception as error:
        raise SystemExit(
            "Training recovery failed safe tensor-only loading."
        ) from error
    if not isinstance(recovery, dict):
        raise SystemExit("Training recovery payload must be an object.")
    return recovery


def valid_recovery_epoch_metrics(recovery: dict[str, Any]) -> bool:
    metrics = recovery["epochMetrics"]
    required = {
        "epoch",
        "trainWeightedTokenCrossEntropy",
        "devWeightedTokenCrossEntropy",
        "best",
    }
    for index, metric in enumerate(metrics):
        if not isinstance(metric, dict) or set(metric) != required:
            return False
        if type(metric["epoch"]) is not int or metric["epoch"] != index + 1:
            return False
        if not isinstance(metric["best"], bool):
            return False
        for name in (
            "trainWeightedTokenCrossEntropy",
            "devWeightedTokenCrossEntropy",
        ):
            value = metric[name]
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(float(value))
            ):
                return False
        if float(recovery["losses"][index]) != float(
            metric["trainWeightedTokenCrossEntropy"]
        ):
            return False
    best_epoch = recovery["bestEpoch"]
    best_loss = float(recovery["bestDevWeightedTokenCrossEntropy"])
    return (
        metrics[best_epoch - 1]["best"] is True
        and float(
            metrics[best_epoch - 1]["devWeightedTokenCrossEntropy"]
        ) == best_loss
    )


def train_model(args: argparse.Namespace) -> dict[str, Any]:
    run_input_snapshot = ensure_run_input_snapshot(args)
    if args.restart_training:
        clear_training_recovery(args)
    if args.training_run_id is None:
        args.training_run_id = uuid.uuid4().hex
    if not is_run_identifier(args.training_run_id):
        raise SystemExit("Training run identity must be a 32-character lowercase hexadecimal value.")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.use_deterministic_algorithms(True)
    train_rows, dev_rows, dataset_manifest = load_rows(
        args.dataset_manifest,
        args.max_train_rows,
        args.max_dev_rows,
        args.seed,
        args.max_input_len,
        args.max_output_len,
        split_paths=args.run_dataset_split_paths,
    )
    if not train_rows:
        raise SystemExit("Training selection is empty.")
    if args.early_stopping_enabled and not dev_rows:
        raise SystemExit("Early stopping requires a non-empty dev selection.")
    input_vocab = build_vocab(train_rows, "input")
    output_vocab = build_vocab(train_rows, "output")
    model = build_model_from_runtime_config(
        len(input_vocab),
        len(output_vocab),
        checkpoint_runtime_config(args),
    )
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
    train_sample_sha256 = sampled_rows_sha256(train_rows)
    dev_sample_sha256 = sampled_rows_sha256(dev_rows)
    recovery_identity = training_recovery_identity(
        args,
        run_input_snapshot,
        input_vocab,
        output_vocab,
        train_rows,
        dev_rows,
    )
    recovery = load_training_recovery(
        args,
        identity=recovery_identity,
        model=model,
        optimizer=optimizer,
        training_generator=training_generator,
    )
    if recovery:
        losses = [float(value) for value in recovery["losses"]]
        epoch_metrics = copy.deepcopy(recovery["epochMetrics"])
        best_state: dict[str, torch.Tensor] | None = {
            name: value.detach().cpu().clone()
            for name, value in recovery["bestState"].items()
        }
        best_dev_loss = float(
            recovery["bestDevWeightedTokenCrossEntropy"]
        )
        best_epoch = int(recovery["bestEpoch"])
        epochs_without_improvement = int(
            recovery["epochsWithoutImprovement"]
        )
        stopped_early = bool(recovery["stoppedEarly"])
        first_epoch = int(recovery["completedEpoch"])
        prior_training_duration_seconds = float(
            recovery["trainingDurationSeconds"]
        )
        resume_count = int(recovery["resumeCount"]) + 1
        export_run_ids = list(recovery["exportRunIds"])
        if args.export_run_id not in export_run_ids:
            export_run_ids.append(args.export_run_id)
        resumed_from_epoch: int | None = first_epoch
    else:
        losses = []
        epoch_metrics = []
        best_state = None
        best_dev_loss = math.inf
        best_epoch = 0
        epochs_without_improvement = 0
        stopped_early = False
        first_epoch = 0
        prior_training_duration_seconds = 0.0
        resume_count = 0
        export_run_ids = [args.export_run_id]
        resumed_from_epoch = None
    segment_started = time.perf_counter()
    for epoch in range(first_epoch, args.epochs):
        if stopped_early:
            break
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
        should_stop = (
            args.early_stopping_enabled
            and epochs_without_improvement
                >= args.early_stopping_patience
        )
        if should_stop:
            stopped_early = True
        epoch_result = {
            "epoch": epoch + 1,
            "trainWeightedTokenCrossEntropy": train_loss,
            "devWeightedTokenCrossEntropy": dev_loss,
            "best": improved,
        }
        epoch_metrics.append(epoch_result)
        print(json.dumps(epoch_result, ensure_ascii=False), flush=True)
        if best_state is None:
            raise SystemExit(
                "Training epoch completed without a finite best dev checkpoint."
            )
        recovery_path = save_training_recovery(
            args,
            identity=recovery_identity,
            model=model,
            optimizer=optimizer,
            training_generator=training_generator,
            completed_epoch=epoch + 1,
            losses=losses,
            epoch_metrics=epoch_metrics,
            best_state=best_state,
            best_dev_loss=best_dev_loss,
            best_epoch=best_epoch,
            epochs_without_improvement=epochs_without_improvement,
            stopped_early=stopped_early,
            training_duration_seconds=(
                prior_training_duration_seconds
                + time.perf_counter()
                - segment_started
            ),
            resume_count=resume_count,
            export_run_ids=export_run_ids,
        )
        epoch_hook = getattr(args, "training_epoch_hook", None)
        if epoch_hook is not None:
            epoch_hook(epoch_result, recovery_path)
        if should_stop:
            break

    if best_state is None:
        raise SystemExit("Training completed without a finite best dev checkpoint.")
    if args.restore_best_weights:
        model.load_state_dict(best_state)

    evaluation = evaluate_model(model, dev_rows, input_vocab, output_vocab, args, device)
    training_duration_seconds = (
        prior_training_duration_seconds
        + time.perf_counter()
        - segment_started
    )
    assert_run_input_snapshot_unchanged(args)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    write_vocab_metadata(input_vocab, output_vocab, args, dataset_manifest)
    recovery_summary = {
        "epochRecoveryEnabled": True,
        "resumed": recovery is not None,
        "resumedFromEpoch": resumed_from_epoch,
        "resumeCount": resume_count,
        "exportRunIds": export_run_ids,
    }
    checkpoint = {
        "modelId": args.model_id,
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
        "runInputSnapshot": run_input_snapshot,
        "trainerSha256": run_input_snapshot["trainer"]["sha256"],
        "vocabMetadataSha256": sha256_file(args.vocab_metadata),
        "datasetManifestSha256": run_input_snapshot["dataset"]["manifestSha256"],
        "datasetContentSha256": run_input_snapshot["dataset"]["contentSha256"],
        "datasetSplitSha256": {
            split: evidence["sha256"]
            for split, evidence in run_input_snapshot["dataset"]["splits"].items()
        },
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
        "trainingRecovery": recovery_summary,
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
        assert_run_input_snapshot_unchanged(args)
        os.replace(checkpoint_staging, checkpoint_target)
    finally:
        checkpoint_staging.unlink(missing_ok=True)
    checkpoint_sha256 = sha256_file(checkpoint_target)
    report = {
        "generatedAt": iso_now(),
        "command": "python scripts/train-open-vocab-seq2seq-transliterator.py",
        "status": "passed-training-checkpoint",
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "trainingComplete": True,
        "trainingExecutionModes": args.execution_modes,
        "durationMs": round(training_duration_seconds * 1000),
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
        "runInputSnapshot": checkpoint["runInputSnapshot"],
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
        "trainingRecovery": recovery_summary,
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
        "candidateLimitations": candidate_limitations(),
    }
    assert_run_input_snapshot_unchanged(args)
    write_json(training_report_path(args), report)
    clear_training_recovery(args)
    return {"model": model.cpu(), "checkpoint": checkpoint, "report": report}


def load_checkpoint(args: argparse.Namespace) -> dict[str, Any]:
    run_input_snapshot = ensure_run_input_snapshot(args)
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
    if checkpoint.get("modelId") != args.model_id:
        raise SystemExit("Checkpoint modelId does not match the selected training config.")
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
        "runInputSnapshot",
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
    if checkpoint["runInputSnapshot"] != run_input_snapshot:
        raise SystemExit("Checkpoint run-input snapshot does not match the current trainer/config/data/gold evidence.")
    if checkpoint["trainerSha256"] != sha256_file(Path(__file__)):
        raise SystemExit("Checkpoint trainerSha256 does not match the current trainer implementation.")
    if not args.vocab_metadata.is_file():
        raise SystemExit("Checkpoint vocabulary metadata is missing; historical provenance cannot be backfilled from current inputs.")
    if checkpoint["vocabMetadataSha256"] != sha256_file(args.vocab_metadata):
        raise SystemExit("Checkpoint vocabulary metadata digest does not match the current vocabulary artifact.")
    model = load_model_from_checkpoint_payload(checkpoint)
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
        "runInputSnapshot",
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
    model: nn.Module,
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
    if vocab.get("tokenization") != OUTPUT_TOKENIZATION:
        raise SystemExit("Vocabulary output tokenization does not match the scalar runtime contract.")
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
    if vocab.get("decoder", {}).get("maxSteps") != checkpoint["config"]["max_output_len"] - 1:
        raise SystemExit("Vocabulary decoder maxSteps does not expose the complete output tensor.")
    if vocab.get("decoder", {}).get("outputSequenceValidation") != OUTPUT_SEQUENCE_VALIDATION:
        raise SystemExit("Vocabulary output sequence validator does not match the runtime contract.")
    lexical_output_tokens = [
        token
        for token in expected_output_tokens
        if token not in SPECIAL
    ]
    if not lexical_output_tokens or not all(is_valid_output_scalar(token) for token in lexical_output_tokens):
        raise SystemExit("Checkpoint output vocabulary must contain exactly one Unicode scalar per lexical token.")
    if vocab.get("dataset", {}).get("manifestSha256") != checkpoint.get("datasetManifestSha256"):
        raise SystemExit("Vocabulary dataset manifest digest does not match the checkpoint.")
    if vocab.get("dataset", {}).get("splitSha256") != checkpoint.get("datasetSplitSha256"):
        raise SystemExit("Vocabulary dataset split digests do not match the checkpoint.")


@torch.no_grad()
def decode_candidates(
    model: nn.Module,
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
        tokens_by_id=tokens_by_id(output_vocab),
    )
    return decode_token_sequences(token_sequences, output_vocab, maximum_candidates)


def decoder_max_steps(input_grapheme_count: int, max_output_len: int) -> int:
    del input_grapheme_count  # Retained for compatibility with frozen callers.
    return max(0, max_output_len - 1)


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
    tokens_by_id: list[str] | None = None,
) -> list[list[int]]:
    if beam_width < 1 or maximum_candidates < 1 or vocab_size < 1:
        raise SystemExit("Decoder contract values must be positive.")
    beams: list[tuple[list[int], float]] = [([sos_id], 0.0)]
    completed: list[tuple[list[int], float]] = []
    invalid_ids = {pad_id, sos_id, unk_id}
    max_steps = decoder_max_steps(input_grapheme_count, max_output_len)
    for iteration in range(max_steps):
        final_step = iteration + 1 == max_steps
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
            eligible = [
                token_id
                for token_id in range(vocab_size)
                if token_id not in invalid_ids
                and (not final_step or token_id == eos_id)
                and output_token_permitted(
                    ids,
                    token_id,
                    eos_id=eos_id,
                    tokens_by_id=tokens_by_id,
                )
            ]
            eligible.sort(key=lambda token_id: (-float(log_probabilities[token_id]), token_id))
            for token_id in eligible[:beam_width]:
                next_beams.append((ids + [token_id], score + float(log_probabilities[token_id])))
        if not next_beams:
            break
        beams = sorted(next_beams, key=beam_rank_key)[:beam_width]
    completed.extend(item for item in beams if item[0][-1] == eos_id)
    ranked = sorted(completed, key=beam_rank_key)
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
            and analyze_devanagari_output_sequence(candidate)["terminable"]
            and candidate not in candidates
        ):
            candidates.append(candidate)
        if len(candidates) >= maximum_candidates:
            break
    return candidates


def output_token_permitted(
    prefix_ids: list[int],
    token_id: int,
    *,
    eos_id: int,
    tokens_by_id: list[str] | None,
) -> bool:
    """Apply the scalar grammar without changing decoder score or tie ordering."""
    if tokens_by_id is None:
        return True
    if not 0 <= token_id < len(tokens_by_id):
        return False
    prefix = "".join(
        tokens_by_id[index]
        for index in prefix_ids
        if 0 <= index < len(tokens_by_id) and tokens_by_id[index] not in SPECIAL
    )
    if token_id == eos_id:
        return bool(analyze_devanagari_output_sequence(prefix)["terminable"])
    token = tokens_by_id[token_id]
    if not is_valid_output_scalar(token):
        return False
    return bool(analyze_devanagari_output_sequence(prefix + token)["validPrefix"])


def evaluate_model(model: nn.Module, rows: list[dict[str, Any]], input_vocab: dict[str, int], output_vocab: dict[str, int], args: argparse.Namespace, device: torch.device) -> dict[str, Any]:
    model.eval().to("cpu")
    sample_limit = min(len(rows), 800)
    sample = deterministic_source_sample(rows, sample_limit, args.seed + 2, "internal-evaluation")
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
        if args.maximum_candidates >= 3 and any(candidate in acceptable for candidate in predictions[:3]):
            top3 += 1
    model.to(device)
    return {
        "sampleRows": len(sample),
        "sampleSelectionPolicy": "deterministic-source-stratified-v1",
        "sampleIdSha256": sha256_text("\n".join(sorted(row["id"] for row in sample))),
        "sampleTop1Accuracy": round(top1 / max(len(sample), 1), 6),
        "sampleTop3Accuracy": round(top3 / max(len(sample), 1), 6) if args.maximum_candidates >= 3 else None,
        "sampleTop3Reportable": args.maximum_candidates >= 3,
        "maximumCandidates": args.maximum_candidates,
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


class CompiledAttentionIncrementalCoreMLBackend:
    def __init__(
        self,
        encoder_model: Any,
        decoder_step_model: Any,
        tensor_contract: dict[str, Any],
        artifacts: dict[str, dict[str, Any]],
        artifact_paths: dict[str, dict[str, Path]],
    ):
        self.encoder_model = encoder_model
        self.decoder_step_model = decoder_step_model
        self.tensor_contract = tensor_contract
        self.artifacts = copy.deepcopy(artifacts)
        self.artifact_paths = artifact_paths

    def verify_artifacts(self) -> None:
        observed = attention_artifact_evidence_from_paths(self.artifact_paths)
        if observed != self.artifacts:
            raise SystemExit("Split attention Core ML artifacts changed during exact-artifact execution.")

    def encode(self, input_ids: np.ndarray) -> dict[str, np.ndarray]:
        result = self.encoder_model.predict({"inputIds": input_ids})
        return validate_attention_prediction_outputs(
            result,
            self.tensor_contract["encoder"]["outputs"],
            "compiled attention encoder",
        )

    def predict_step(
        self,
        decoder_token_ids: np.ndarray,
        decoder_hidden: np.ndarray,
        encoder_context: dict[str, np.ndarray],
    ) -> dict[str, np.ndarray]:
        result = self.decoder_step_model.predict({
            "decoderTokenIds": decoder_token_ids,
            "decoderHidden": decoder_hidden,
            "encoderOutputs": encoder_context["encoderOutputs"],
            "encoderEnergy": encoder_context["encoderEnergy"],
            "validMask": encoder_context["validMask"],
        })
        return validate_attention_prediction_outputs(
            result,
            self.tensor_contract["decoderStep"]["outputs"],
            "compiled attention decoder step",
        )


def validate_attention_prediction_outputs(
    result: Any,
    expected: dict[str, dict[str, Any]],
    label: str,
) -> dict[str, np.ndarray]:
    if not isinstance(result, dict) or set(result) != set(expected):
        raise SystemExit(f"{label} returned unexpected output names.")
    validated: dict[str, np.ndarray] = {}
    for name, requirement in expected.items():
        value = np.asarray(result[name])
        required_shape = tuple(requirement["shape"])
        if value.shape != required_shape:
            raise SystemExit(f"{label} output {name} has shape {value.shape}, expected {required_shape}.")
        if value.dtype.kind != "f" or not np.isfinite(value).all():
            raise SystemExit(f"{label} output {name} is non-floating or non-finite.")
        validated[name] = value.astype(np.float16, copy=False)
    return validated


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


def validate_attention_incremental_coreml_feature_contract(
    encoder_model: Any,
    decoder_step_model: Any,
    tensor_contract: dict[str, Any],
) -> None:
    int32_type = ct.proto.FeatureTypes_pb2.ArrayFeatureType.INT32
    float16_type = ct.proto.FeatureTypes_pb2.ArrayFeatureType.FLOAT16
    data_types = {"INT32": int32_type, "FLOAT16": float16_type}

    for role, model in (("encoder", encoder_model), ("decoderStep", decoder_step_model)):
        specification = model.get_spec()
        observed_groups = {
            "inputs": {feature.name: feature for feature in specification.description.input},
            "outputs": {feature.name: feature for feature in specification.description.output},
        }
        for group, observed in observed_groups.items():
            expected = tensor_contract[role][group]
            if set(observed) != set(expected):
                raise SystemExit(f"Split attention {role} {group} do not match the derived tensor contract.")
            for name, requirement in expected.items():
                multi_array = observed[name].type.multiArrayType
                expected_type = data_types.get(requirement["dataType"])
                if list(multi_array.shape) != requirement["shape"] or multi_array.dataType != expected_type:
                    raise SystemExit(
                        f"Split attention {role} {group[:-1]} {name} does not match "
                        f"{requirement['dataType']} {requirement['shape']}."
                    )


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
    pytorch_model: nn.Module,
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
    pytorch_model: nn.Module,
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


def attention_artifact_evidence_from_paths(
    paths: dict[str, dict[str, Path]],
) -> dict[str, dict[str, Any]]:
    evidence: dict[str, dict[str, Any]] = {}
    if set(paths) != {"encoder", "decoderStep"}:
        raise SystemExit("Split attention artifact inventory must contain encoder and decoderStep.")
    for role in ("encoder", "decoderStep"):
        role_paths = paths[role]
        if set(role_paths) != {"mlpackage", "compiledModel"}:
            raise SystemExit(f"Split attention {role} artifact paths are incomplete.")
        package = role_paths["mlpackage"]
        compiled = role_paths["compiledModel"]
        evidence[role] = {
            "role": role,
            "mlpackage": rel(package),
            "mlpackageBytes": directory_bytes(package),
            "mlpackageSha256": directory_sha256(package),
            "compiledModel": rel(compiled),
            "compiledBytes": directory_bytes(compiled),
            "compiledSha256": directory_sha256(compiled),
        }
    return evidence


def attention_artifact_content_evidence(
    artifacts: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    return {
        role: {
            field: artifacts[role][field]
            for field in (
                "mlpackageBytes",
                "mlpackageSha256",
                "compiledBytes",
                "compiledSha256",
            )
        }
        for role in ("encoder", "decoderStep")
    }


def verified_attention_prepublication_validation(
    validation: Any,
    source_checkpoint_sha256: str,
    tensor_contract: dict[str, Any],
    artifact_content: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    required_fields = {
        "status",
        "phase",
        "sourceCheckpointSha256",
        "runtimeModelContract",
        "featureContractSha256",
        "artifactContent",
        "knownAnswerInputSha256",
        "maximumAbsoluteEncoderError",
        "maximumAbsoluteLogitError",
        "maximumAbsoluteHiddenStateError",
        "relativeTolerance",
        "absoluteTolerance",
    }
    if not isinstance(validation, dict) or set(validation) != required_fields:
        raise SystemExit("Split attention pre-publication attestation evidence is incomplete.")
    if (
        validation["status"] != "passed"
        or validation["phase"] != "pre-publication-staging"
        or validation["sourceCheckpointSha256"] != source_checkpoint_sha256
        or validation["runtimeModelContract"] != ATTENTION_INCREMENTAL_RUNTIME_CONTRACT
        or validation["featureContractSha256"] != sha256_json(tensor_contract)
        or validation["artifactContent"] != artifact_content
        or not isinstance(validation["knownAnswerInputSha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", validation["knownAnswerInputSha256"])
        or validation["relativeTolerance"] != COREML_PARITY_RTOL
        or validation["absoluteTolerance"] != COREML_PARITY_ATOL
    ):
        raise SystemExit("Split attention pre-publication attestation does not match the published bytes.")
    for field in (
        "maximumAbsoluteEncoderError",
        "maximumAbsoluteLogitError",
        "maximumAbsoluteHiddenStateError",
    ):
        value = validation[field]
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)) or value < 0:
            raise SystemExit("Split attention pre-publication parity evidence is invalid.")
    return validation


def verified_attention_artifact_evidence(
    args: argparse.Namespace,
    export: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    if export.get("runtimeModelContract") != ATTENTION_INCREMENTAL_RUNTIME_CONTRACT:
        raise SystemExit("Split attention export is missing its runtime model contract.")
    expected = export.get("artifacts")
    if not isinstance(expected, dict) or set(expected) != {"encoder", "decoderStep"}:
        raise SystemExit("Split attention export has a partial artifact inventory.")
    observed = attention_artifact_evidence_from_paths(attention_artifact_paths(args))
    if observed != expected:
        raise SystemExit("Split attention export artifacts are stale, partial, or mismatched.")
    total_compiled_bytes = sum(item["compiledBytes"] for item in observed.values())
    total_package_bytes = sum(item["mlpackageBytes"] for item in observed.values())
    if (
        export.get("totalCompiledBytes") != total_compiled_bytes
        or export.get("totalPackageBytes") != total_package_bytes
    ):
        raise SystemExit("Split attention export aggregate sizes do not match its artifacts.")
    return observed


def validate_attention_checkpoint_export_binding(
    pytorch_model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
    export: dict[str, Any],
) -> str:
    if args.model_id != ATTENTION_MODEL_ID or checkpoint.get("modelId") != ATTENTION_MODEL_ID:
        raise SystemExit("Split attention export requires the attention challenger checkpoint.")
    if not isinstance(pytorch_model, BidirectionalAttentionSeq2Seq):
        raise SystemExit("Split attention export requires the attention challenger model family.")
    if checkpoint.get("config") != checkpoint_runtime_config(args):
        raise SystemExit("Split attention export checkpoint dimensions do not match this invocation.")
    if checkpoint.get("trainingRunId") != args.training_run_id:
        raise SystemExit("Split attention export checkpoint belongs to another training run.")
    checkpoint_sha256 = validate_attention_checkpoint_file_binding(
        pytorch_model,
        checkpoint,
        args,
    )
    if export.get("sourceCheckpointSha256") != checkpoint_sha256:
        raise SystemExit("Split attention export is not bound to the exact checkpoint bytes.")
    return checkpoint_sha256


def validate_attention_checkpoint_file_binding(
    pytorch_model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> str:
    source_path = checkpoint_path(args)
    try:
        with open_regular_binary(source_path, "attention checkpoint") as handle:
            source_checkpoint = torch.load(handle, map_location="cpu", weights_only=True)
    except Exception as error:
        raise SystemExit("Split attention checkpoint failed safe tensor-only loading.") from error
    if not isinstance(source_checkpoint, dict):
        raise SystemExit("Split attention checkpoint payload must be an object.")
    source_metadata = {key: value for key, value in source_checkpoint.items() if key != "stateDict"}
    expected_metadata = {key: value for key, value in checkpoint.items() if key != "stateDict"}
    if source_metadata != expected_metadata:
        raise SystemExit("Split attention checkpoint file metadata does not match the in-memory checkpoint.")
    source_state = source_checkpoint.get("stateDict")
    checkpoint_state = checkpoint.get("stateDict")
    model_state = pytorch_model.state_dict()
    if not isinstance(source_state, dict) or not isinstance(checkpoint_state, dict):
        raise SystemExit("Split attention checkpoint is missing its state dictionary.")
    if set(source_state) != set(checkpoint_state) or set(source_state) != set(model_state):
        raise SystemExit("Split attention checkpoint state dictionary keys do not match the model.")
    for name in sorted(source_state):
        source_tensor = source_state[name]
        checkpoint_tensor = checkpoint_state[name]
        model_tensor = model_state[name]
        if (
            not isinstance(source_tensor, torch.Tensor)
            or not isinstance(checkpoint_tensor, torch.Tensor)
            or not torch.equal(source_tensor.cpu(), checkpoint_tensor.cpu())
            or not torch.equal(source_tensor.cpu(), model_tensor.detach().cpu())
        ):
            raise SystemExit(f"Split attention checkpoint tensor {name} does not match the exported model.")
    return sha256_file(source_path)


def load_verified_compiled_attention_coreml(
    pytorch_model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
    export: dict[str, Any],
) -> tuple[CompiledAttentionIncrementalCoreMLBackend, dict[str, Any]]:
    if ct is None:
        raise SystemExit(f"Core ML validation is unavailable: {COREML_IMPORT_ERROR}")
    checkpoint_sha256 = validate_attention_checkpoint_export_binding(
        pytorch_model,
        checkpoint,
        args,
        export,
    )
    tensor_contract = export.get("tensorContract")
    expected_contract = attention_incremental_tensor_contract(
        pytorch_model,
        args.max_input_len,
        args.beam_width,
    )
    if tensor_contract != expected_contract:
        raise SystemExit("Split attention export tensor contract does not match the bound checkpoint.")
    artifacts = verified_attention_artifact_evidence(args, export)
    verified_attention_prepublication_validation(
        export.get("prePublicationValidation"),
        checkpoint_sha256,
        tensor_contract,
        attention_artifact_content_evidence(artifacts),
    )
    paths = attention_artifact_paths(args)
    backend, parity = attest_compiled_attention_artifacts(
        pytorch_model,
        checkpoint,
        args,
        paths,
        artifacts,
        tensor_contract,
        "published",
    )
    return backend, {
        "status": "passed",
        "sourceCheckpointSha256": checkpoint_sha256,
        "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
        "tensorContract": tensor_contract,
        "artifacts": artifacts,
        **parity,
    }


def attest_compiled_attention_artifacts(
    pytorch_model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
    paths: dict[str, dict[str, Path]],
    artifacts: dict[str, dict[str, Any]],
    tensor_contract: dict[str, Any],
    phase: str,
) -> tuple[CompiledAttentionIncrementalCoreMLBackend, dict[str, Any]]:
    try:
        encoder_package = ct.models.MLModel(str(paths["encoder"]["mlpackage"]))
        decoder_package = ct.models.MLModel(str(paths["decoderStep"]["mlpackage"]))
        encoder_compiled = ct.models.CompiledMLModel(str(paths["encoder"]["compiledModel"]))
        decoder_compiled = ct.models.CompiledMLModel(str(paths["decoderStep"]["compiledModel"]))
    except Exception as error:
        raise SystemExit(f"Unable to load the exact {phase} split attention Core ML artifacts.") from error
    validate_attention_incremental_coreml_feature_contract(
        encoder_package,
        decoder_package,
        tensor_contract,
    )
    backend = CompiledAttentionIncrementalCoreMLBackend(
        encoder_compiled,
        decoder_compiled,
        tensor_contract,
        artifacts,
        paths,
    )
    parity = validate_attention_compiled_known_answer(backend, pytorch_model, checkpoint, args)
    return backend, parity


def validate_staged_attention_coreml(
    pytorch_model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
    paths: dict[str, dict[str, Path]],
    tensor_contract: dict[str, Any],
    source_checkpoint_sha256: str,
) -> dict[str, Any]:
    observed_checkpoint_sha256 = validate_attention_checkpoint_file_binding(
        pytorch_model,
        checkpoint,
        args,
    )
    if observed_checkpoint_sha256 != source_checkpoint_sha256:
        raise SystemExit("Checkpoint bytes changed before staged split attention attestation.")
    expected_contract = attention_incremental_tensor_contract(
        pytorch_model,
        args.max_input_len,
        args.beam_width,
    )
    if tensor_contract != expected_contract:
        raise SystemExit("Staged split attention tensor contract does not match the checkpoint.")
    staged_artifacts = attention_artifact_evidence_from_paths(paths)
    _, parity = attest_compiled_attention_artifacts(
        pytorch_model,
        checkpoint,
        args,
        paths,
        staged_artifacts,
        tensor_contract,
        "staged",
    )
    return {
        "status": "passed",
        "phase": "pre-publication-staging",
        "sourceCheckpointSha256": source_checkpoint_sha256,
        "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
        "featureContractSha256": sha256_json(tensor_contract),
        "artifactContent": attention_artifact_content_evidence(staged_artifacts),
        **parity,
    }


def validate_attention_compiled_known_answer(
    backend: CompiledAttentionIncrementalCoreMLBackend,
    pytorch_model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    input_ids, decoder_row = known_answer_tensors(checkpoint, args)
    decoder_ids = np.repeat(decoder_row, args.beam_width, axis=0)
    lexical_output_ids = [
        token_id for token, token_id in sorted(checkpoint["outputVocab"].items(), key=lambda item: item[1])
        if token not in SPECIAL
    ]
    for lane in range(args.beam_width):
        decoder_ids[lane, 1] = lexical_output_ids[lane % len(lexical_output_ids)]

    encoder_result = backend.encode(input_ids)
    with torch.no_grad():
        expected_encoder = CoreMLAttentionEncoderWrapper(pytorch_model.eval().to("cpu"))(
            torch.from_numpy(input_ids)
        )
    encoder_names = ("encoderOutputs", "encoderEnergy", "validMask", "initialDecoderHidden")
    maximum_encoder_error = 0.0
    for name, expected in zip(encoder_names, expected_encoder):
        observed = encoder_result[name].astype(np.float32)
        expected_array = expected.detach().cpu().numpy()
        error = float(np.max(np.abs(observed.astype(np.float64) - expected_array.astype(np.float64))))
        maximum_encoder_error = max(maximum_encoder_error, error)
        if not np.allclose(observed, expected_array, rtol=COREML_PARITY_RTOL, atol=COREML_PARITY_ATOL):
            raise SystemExit(
                f"Exact compiled attention encoder output {name} diverges from the bound checkpoint; "
                f"max error={error}."
            )

    context = {
        "encoderOutputs": encoder_result["encoderOutputs"],
        "encoderEnergy": encoder_result["encoderEnergy"],
        "validMask": encoder_result["validMask"],
    }
    hidden = np.repeat(encoder_result["initialDecoderHidden"], args.beam_width, axis=1)
    compiled_steps: list[np.ndarray] = []
    for index in range(decoder_ids.shape[1]):
        step = backend.predict_step(decoder_ids[:, index : index + 1], hidden, context)
        compiled_steps.append(step["stepLogits"].astype(np.float32)[:, None, :])
        hidden = step["nextDecoderHidden"]
    compiled_logits = np.concatenate(compiled_steps, axis=1)
    with torch.no_grad():
        expected_logits, expected_hidden = run_attention_incrementally(
            pytorch_model,
            torch.from_numpy(input_ids),
            torch.from_numpy(decoder_ids),
        )
    expected_logits_array = expected_logits.detach().cpu().numpy()
    expected_hidden_array = expected_hidden.detach().cpu().numpy()
    maximum_logit_error = float(np.max(np.abs(
        compiled_logits.astype(np.float64) - expected_logits_array.astype(np.float64)
    )))
    maximum_hidden_error = float(np.max(np.abs(
        hidden.astype(np.float64) - expected_hidden_array.astype(np.float64)
    )))
    if not np.allclose(
        compiled_logits,
        expected_logits_array,
        rtol=COREML_PARITY_RTOL,
        atol=COREML_PARITY_ATOL,
    ):
        raise SystemExit(
            "Exact compiled attention decoder logits diverge from the bound checkpoint; "
            f"max error={maximum_logit_error}."
        )
    if not np.allclose(
        hidden.astype(np.float32),
        expected_hidden_array,
        rtol=COREML_PARITY_RTOL,
        atol=COREML_PARITY_ATOL,
    ):
        raise SystemExit(
            "Exact compiled attention decoder state diverges from the bound checkpoint; "
            f"max error={maximum_hidden_error}."
        )
    backend.verify_artifacts()
    return {
        "knownAnswerInputSha256": hashlib.sha256(input_ids.tobytes() + decoder_ids.tobytes()).hexdigest(),
        "maximumAbsoluteEncoderError": maximum_encoder_error,
        "maximumAbsoluteLogitError": maximum_logit_error,
        "maximumAbsoluteHiddenStateError": maximum_hidden_error,
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
    manifest_bytes = read_regular_bytes(
        args.gold_manifest,
        "gold manifest",
        maximum_bytes=8 * 1024 * 1024,
    )
    manifest = parse_json_object_bytes(manifest_bytes, "gold manifest")
    suites = manifest.get("suites")
    if manifest.get("schemaVersion") != 3 or not isinstance(suites, list) or not suites:
        raise SystemExit("Gold prediction evidence requires a non-empty schema-v3 gold manifest.")
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
        suite_bytes = read_regular_bytes(
            suite_path,
            f"gold suite {suite_id}",
            maximum_bytes=64 * 1024 * 1024,
        )
        observed = {
            "sha256": hashlib.sha256(suite_bytes).hexdigest(),
            "bytes": len(suite_bytes),
            "rows": sum(1 for line in suite_bytes.splitlines() if line.strip()),
        }
        if observed["sha256"] != expected_sha256:
            raise SystemExit(f"Gold suite {suite_id} SHA-256 does not match the manifest.")
        if observed["rows"] != expected_rows:
            raise SystemExit(f"Gold suite {suite_id} row count does not match the manifest.")
        try:
            lines = suite_bytes.decode("utf-8").splitlines()
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
        "goldManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "goldCorpusSha256": manifest["corpusSha256"],
        "goldSuites": suite_evidence,
        "goldRows": len(rows),
    }


def load_verified_official_benchmark_rows(
    args: argparse.Namespace,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    manifest_path = args.official_benchmark_manifest
    require_repo_regular_file(manifest_path, "official benchmark manifest")
    manifest_bytes = read_regular_bytes(
        manifest_path,
        "official benchmark manifest",
        maximum_bytes=8 * 1024 * 1024,
    )
    manifest = parse_json_object_bytes(
        manifest_bytes,
        "official benchmark manifest",
    )
    suites = manifest.get("suites")
    if (
        manifest.get("schemaVersion") != 2
        or manifest.get("status") != "official-public-benchmark-locked"
        or manifest.get("trainingUse") != "forbidden-evaluation-only"
        or manifest.get("uniqueInputPolicy")
        != "trim-lowercase-NFC-collapse-whitespace"
        or not isinstance(suites, list)
        or len(suites) != 3
    ):
        raise SystemExit("Official benchmark manifest contract is invalid.")
    if manifest.get("corpusSha256") != gold_corpus_sha256(suites):
        raise SystemExit(
            "Official benchmark corpusSha256 does not match its ordered suite inventory."
        )

    expected_buckets = {"native-frequent", "indian-name", "foreign-name"}
    seen_suite_ids: set[str] = set()
    seen_buckets: set[str] = set()
    seen_row_ids: set[str] = set()
    seen_inputs: set[str] = set()
    rows: list[dict[str, Any]] = []
    suite_evidence: list[dict[str, Any]] = []
    for suite in suites:
        if not isinstance(suite, dict):
            raise SystemExit("Official benchmark suite inventory is invalid.")
        suite_id = suite.get("id")
        recorded_path = suite.get("path")
        expected_sha256 = suite.get("sha256")
        expected_rows = suite.get("rows")
        bucket = suite.get("benchmarkBucket")
        if (
            not isinstance(suite_id, str)
            or not suite_id
            or suite_id in seen_suite_ids
            or bucket not in expected_buckets
            or bucket in seen_buckets
            or not isinstance(expected_rows, int)
            or isinstance(expected_rows, bool)
            or expected_rows < 1
            or not isinstance(expected_sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
        ):
            raise SystemExit(
                "Official benchmark suite IDs, buckets, hashes, and row counts "
                "must be valid and unique."
            )
        seen_suite_ids.add(suite_id)
        seen_buckets.add(bucket)
        if (
            not isinstance(recorded_path, str)
            or not recorded_path
            or Path(recorded_path).is_absolute()
            or Path(recorded_path).as_posix() != recorded_path
            or ".." in Path(recorded_path).parts
        ):
            raise SystemExit(
                f"Official benchmark suite {suite_id} path is not canonical."
            )
        suite_path = ROOT / recorded_path
        require_repo_regular_file(
            suite_path,
            f"official benchmark suite {suite_id}",
        )
        suite_bytes = read_regular_bytes(
            suite_path,
            f"official benchmark suite {suite_id}",
            maximum_bytes=64 * 1024 * 1024,
        )
        observed_sha256 = hashlib.sha256(suite_bytes).hexdigest()
        if observed_sha256 != expected_sha256:
            raise SystemExit(
                f"Official benchmark suite {suite_id} SHA-256 does not match "
                "the manifest."
            )
        try:
            lines = suite_bytes.decode("utf-8").splitlines()
        except UnicodeDecodeError as error:
            raise SystemExit(
                f"Official benchmark suite {suite_id} is not valid UTF-8."
            ) from error
        parsed_rows = 0
        for line_number, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            parsed_rows += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(
                    f"Official benchmark suite {suite_id}:{line_number} is invalid JSON."
                ) from error
            if (
                not isinstance(row, dict)
                or not isinstance(row.get("id"), str)
                or not row["id"]
                or row["id"] in seen_row_ids
                or not isinstance(row.get("input"), str)
                or not normalize_input(row["input"])
                or not isinstance(row.get("acceptable"), list)
                or not row["acceptable"]
                or not all(
                    isinstance(value, str) and value == nfc(value) and value
                    for value in row["acceptable"]
                )
            ):
                raise SystemExit(
                    f"Official benchmark suite {suite_id}:{line_number} has an "
                    "invalid or duplicate evidence row."
                )
            input_identity = normalize_input(row["input"])
            if input_identity in seen_inputs:
                raise SystemExit(
                    f"Official benchmark repeats normalized input: {input_identity}"
                )
            seen_row_ids.add(row["id"])
            seen_inputs.add(input_identity)
            rows.append({
                **row,
                "benchmarkBucket": bucket,
            })
        if parsed_rows != expected_rows:
            raise SystemExit(
                f"Official benchmark suite {suite_id} row count does not match "
                "the manifest."
            )
        suite_evidence.append({
            "id": suite_id,
            "path": recorded_path,
            "sha256": observed_sha256,
            "rows": parsed_rows,
            "benchmarkBucket": bucket,
        })
    if seen_buckets != expected_buckets:
        raise SystemExit("Official benchmark does not cover all locked buckets.")
    return rows, {
        "manifest": rel(manifest_path),
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "corpusSha256": manifest["corpusSha256"],
        "suites": suite_evidence,
        "rows": len(rows),
    }


def official_benchmark_input_sha256(rows: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        digest.update(str(row["id"]).encode("utf-8"))
        digest.update(b"\0")
        digest.update(normalize_input(row["input"]).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def verify_official_benchmark_training_isolation(
    official_rows: list[dict[str, Any]],
    split_paths: dict[str, Path],
    split_evidence: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    benchmark_inputs = {
        normalize_input(row["input"])
        for row in official_rows
    }
    overlaps: set[str] = set()
    for split in ("train", "dev"):
        identities = load_split_inputs(split_paths[split])
        overlaps.update(benchmark_inputs.intersection(identities))
    if overlaps:
        examples = ", ".join(sorted(overlaps)[:5])
        raise SystemExit(
            "Official benchmark input leakage into train/dev: "
            f"{len(overlaps)} normalized inputs ({examples})."
        )
    return {
        "policy": "official-benchmark-inputs-absent-from-train-and-dev-v1",
        "benchmarkInputSha256": official_benchmark_input_sha256(official_rows),
        "comparedSplitSha256": {
            split: split_evidence[split]["sha256"]
            for split in ("train", "dev")
        },
        "overlappingInputCount": 0,
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
        tokens_by_id=tokens_by_id(output_vocab),
    )
    return decode_token_sequences(token_sequences, output_vocab, args.maximum_candidates)


def decode_attention_coreml_candidates(
    backend: CompiledAttentionIncrementalCoreMLBackend,
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
    input_ids = np.asarray(
        [encode(list(normalized), input_vocab, args.max_input_len, add_sos=False)],
        dtype=np.int32,
    )
    encoded = backend.encode(input_ids)
    context = {
        "encoderOutputs": encoded["encoderOutputs"],
        "encoderEnergy": encoded["encoderEnergy"],
        "validMask": encoded["validMask"],
    }
    initial_hidden = encoded["initialDecoderHidden"][:, 0, :]
    beams: list[tuple[list[int], float, np.ndarray]] = [
        ([output_vocab[SOS]], 0.0, initial_hidden.copy()),
    ]
    completed: list[tuple[list[int], float]] = []
    invalid_ids = {output_vocab[PAD], output_vocab[SOS], output_vocab[UNK]}
    vocabulary_size = len(output_vocab)
    output_tokens_by_id = tokens_by_id(output_vocab)
    max_steps = decoder_max_steps(len(normalized), args.max_output_len)
    for iteration in range(max_steps):
        final_step = iteration + 1 == max_steps
        active: list[tuple[list[int], float, np.ndarray]] = []
        for ids, score, state in beams:
            if ids[-1] == output_vocab[EOS]:
                completed.append((ids, score))
            else:
                active.append((ids, score, state))
        if not active:
            break
        token_ids = np.full((args.beam_width, 1), output_vocab[PAD], dtype=np.int32)
        hidden_shape = backend.tensor_contract["decoderStep"]["inputs"]["decoderHidden"]["shape"]
        hidden = np.zeros(tuple(hidden_shape), dtype=np.float16)
        for lane, (ids, _, state) in enumerate(active[:args.beam_width]):
            token_ids[lane, 0] = ids[-1]
            hidden[:, lane, :] = state
        step = backend.predict_step(token_ids, hidden, context)
        logits = step["stepLogits"].astype(np.float64)
        next_hidden = step["nextDecoderHidden"]
        next_beams: list[tuple[list[int], float, np.ndarray]] = []
        for lane, (ids, score, _) in enumerate(active[:args.beam_width]):
            log_probabilities = log_softmax_numpy(logits[lane])
            eligible = [
                token_id
                for token_id in range(vocabulary_size)
                if token_id not in invalid_ids
                and (not final_step or token_id == output_vocab[EOS])
                and output_token_permitted(
                    ids,
                    token_id,
                    eos_id=output_vocab[EOS],
                    tokens_by_id=output_tokens_by_id,
                )
            ]
            eligible.sort(key=lambda token_id: (-float(log_probabilities[token_id]), token_id))
            state = next_hidden[:, lane, :].copy()
            for token_id in eligible[:args.beam_width]:
                next_beams.append((
                    ids + [token_id],
                    score + float(log_probabilities[token_id]),
                    state.copy(),
                ))
        if not next_beams:
            break
        next_beams.sort(key=lambda item: beam_rank_key((item[0], item[1])))
        beams = next_beams[:args.beam_width]
    completed.extend(
        (ids, score)
        for ids, score, _ in beams
        if ids[-1] == output_vocab[EOS]
    )
    ranked = sorted(completed, key=beam_rank_key)
    unique: list[list[int]] = []
    seen: set[tuple[int, ...]] = set()
    for ids, _ in ranked:
        identity = tuple(ids)
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(ids)
        if len(unique) >= args.maximum_candidates:
            break
    return decode_token_sequences(unique, output_vocab, args.maximum_candidates)


def write_gold_predictions(
    backend: CompiledCoreMLBackend | CompiledAttentionIncrementalCoreMLBackend,
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
                candidates = decode_exact_compiled_candidates(
                    backend,
                    row["input"],
                    checkpoint,
                    args,
                )
                handle.write(json.dumps({"id": row["id"], "input": row["input"], "candidates": candidates[:args.maximum_candidates]}, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staging, output_path)
    finally:
        staging.unlink(missing_ok=True)
    _, verified_again = load_verified_gold_rows(args)
    if verified_again != gold_evidence:
        raise SystemExit("Gold corpus changed during exact-artifact prediction generation.")
    backend_evidence = verified_prediction_backend_evidence(
        backend,
        args,
        "gold prediction generation",
    )
    return {
        **backend_evidence,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        **gold_evidence,
        "predictions": rel(output_path),
        "predictionsSha256": sha256_file(output_path),
    }


def write_official_benchmark_predictions(
    backend: CompiledCoreMLBackend | CompiledAttentionIncrementalCoreMLBackend,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    rows, current_evidence = load_verified_official_benchmark_rows(args)
    locked_evidence = ensure_run_input_snapshot(args)["officialBenchmark"]
    locked_base = {
        key: value
        for key, value in locked_evidence.items()
        if key != "trainingIsolation"
    }
    if current_evidence != locked_base:
        raise SystemExit(
            "Official benchmark differs from the immutable run-input snapshot."
        )
    output_path = official_benchmark_predictions_path(args)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    staging = staging_sibling(output_path, "staging")
    try:
        with staging.open("x", encoding="utf-8") as handle:
            for row in rows:
                candidates = decode_exact_compiled_candidates(
                    backend,
                    row["input"],
                    checkpoint,
                    args,
                )
                handle.write(json.dumps({
                    "id": row["id"],
                    "input": row["input"],
                    "candidates": candidates[:args.maximum_candidates],
                }, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(staging, output_path)
    finally:
        staging.unlink(missing_ok=True)
    _, verified_again = load_verified_official_benchmark_rows(args)
    if verified_again != current_evidence:
        raise SystemExit(
            "Official benchmark changed during exact-artifact prediction generation."
        )
    backend_evidence = verified_prediction_backend_evidence(
        backend,
        args,
        "official benchmark prediction generation",
    )
    return {
        **backend_evidence,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        **current_evidence,
        "trainingIsolation": locked_evidence["trainingIsolation"],
        "predictions": rel(output_path),
        "predictionsSha256": sha256_file(output_path),
    }


def decode_exact_compiled_candidates(
    backend: CompiledCoreMLBackend | CompiledAttentionIncrementalCoreMLBackend,
    text: str,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> list[str]:
    if isinstance(backend, CompiledAttentionIncrementalCoreMLBackend):
        return decode_attention_coreml_candidates(backend, text, checkpoint, args)
    return decode_coreml_candidates(backend, text, checkpoint, args)


def verified_prediction_backend_evidence(
    backend: CompiledCoreMLBackend | CompiledAttentionIncrementalCoreMLBackend,
    args: argparse.Namespace,
    operation: str,
) -> dict[str, Any]:
    if isinstance(backend, CompiledAttentionIncrementalCoreMLBackend):
        backend.verify_artifacts()
        return {
            "backend": "coreml-compiled-split-attention-models",
            "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
            "compiledModels": backend.artifacts,
            "artifactIdentity": {
                "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
                "compiledArtifacts": {
                    role: {
                        "path": artifact["compiledModel"],
                        "sha256": artifact["compiledSha256"],
                        "bytes": artifact["compiledBytes"],
                    }
                    for role, artifact in backend.artifacts.items()
                },
            },
        }
    if directory_sha256(args.compiled_model) != backend.compiled_sha256:
        raise SystemExit(
            f"Compiled Core ML bytes changed during {operation}."
        )
    compiled_bytes = directory_bytes(args.compiled_model)
    return {
        "backend": "coreml-compiled-model",
        "compiledModel": rel(args.compiled_model),
        "compiledModelSha256": backend.compiled_sha256,
        "artifactIdentity": {
            "runtimeModelContract": "single-seq2seq-v1",
            "compiledArtifacts": {
                "model": {
                    "path": rel(args.compiled_model),
                    "sha256": backend.compiled_sha256,
                    "bytes": compiled_bytes,
                },
            },
        },
    }


def export_attention_incremental_coreml(
    model: nn.Module,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    if args.model_id != ATTENTION_MODEL_ID or checkpoint.get("modelId") != ATTENTION_MODEL_ID:
        raise SystemExit("Split attention publication requires the attention challenger checkpoint.")
    if not isinstance(model, BidirectionalAttentionSeq2Seq):
        raise SystemExit("Split attention publication requires BidirectionalAttentionSeq2Seq.")
    if checkpoint.get("trainingRunId") != args.training_run_id:
        raise SystemExit("Split attention publication checkpoint belongs to another training run.")
    if checkpoint.get("config") != checkpoint_runtime_config(args):
        raise SystemExit("Split attention publication checkpoint dimensions do not match this invocation.")
    source_checkpoint_sha256 = validate_attention_checkpoint_file_binding(model, checkpoint, args)
    targets = attention_artifact_paths(args)
    staged_paths = {
        role: {
            kind: staging_sibling(target, "staging")
            for kind, target in role_targets.items()
        }
        for role, role_targets in targets.items()
    }
    compile_outputs = {
        role: {
            "coremltools": staging_sibling(
                args.out_dir / f"LekhNeuralTransliterator{role}.coremltools.mlmodelc",
                "compile",
            ),
            "xcode": staging_sibling(args.out_dir / f"coreml-{role}-compiled", "compile"),
        }
        for role in ("encoder", "decoderStep")
    }
    temporary_directories = [
        path
        for role_paths in (*staged_paths.values(), *compile_outputs.values())
        for path in role_paths.values()
    ]
    try:
        converted = convert_attention_incremental_coreml_for_testing(
            model,
            max_input_len=args.max_input_len,
            beam_width=args.beam_width,
            minimum_deployment_target=ct.target.macOS13,
        )
        tensor_contract = converted["contract"]
        expected_contract = attention_incremental_tensor_contract(
            model,
            args.max_input_len,
            args.beam_width,
        )
        if tensor_contract != expected_contract:
            raise RuntimeError("Converted split attention tensor contract changed unexpectedly.")
        converted_models = {
            "encoder": converted["encoderModel"],
            "decoderStep": converted["decoderStepModel"],
        }
        for role in ("encoder", "decoderStep"):
            package_staging = staged_paths[role]["mlpackage"]
            compiled_staging = staged_paths[role]["compiledModel"]
            package_staging.parent.mkdir(parents=True, exist_ok=True)
            converted_models[role].save(str(package_staging))
            compiled = ct.models.MLModel(str(package_staging)).get_compiled_model_path()
            if not compiled or not Path(compiled).exists():
                compiled = compile_mlpackage_with_coremltools(
                    package_staging,
                    compile_outputs[role]["coremltools"],
                )
            if not compiled or not Path(compiled).exists():
                compiled = compile_mlpackage_with_xcode(
                    package_staging,
                    compile_outputs[role]["xcode"],
                )
            if not compiled or not Path(compiled).exists():
                raise RuntimeError(f"Core ML compilation returned no compiled {role} path.")
            compiled_source = normalize_compiled_model_path(Path(compiled))
            secure_directory_files(compiled_source, require_repo_containment=False)
            shutil.copytree(compiled_source, compiled_staging)
            secure_directory_files(package_staging)
            secure_directory_files(compiled_staging)

        staged_content = {
            role: {
                "mlpackageBytes": directory_bytes(staged_paths[role]["mlpackage"]),
                "mlpackageSha256": directory_sha256(staged_paths[role]["mlpackage"]),
                "compiledBytes": directory_bytes(staged_paths[role]["compiledModel"]),
                "compiledSha256": directory_sha256(staged_paths[role]["compiledModel"]),
            }
            for role in ("encoder", "decoderStep")
        }
        prepublication_validation = validate_staged_attention_coreml(
            model,
            checkpoint,
            args,
            staged_paths,
            tensor_contract,
            source_checkpoint_sha256,
        )
        verified_attention_prepublication_validation(
            prepublication_validation,
            source_checkpoint_sha256,
            tensor_contract,
            staged_content,
        )
        publications = [
            (staged_paths[role][kind], targets[role][kind])
            for role in ("encoder", "decoderStep")
            for kind in ("mlpackage", "compiledModel")
        ]
        assert_run_input_snapshot_unchanged(args)
        publish_directories_atomically(publications)
        artifacts = attention_artifact_evidence_from_paths(targets)
        for role in ("encoder", "decoderStep"):
            if any(artifacts[role][field] != value for field, value in staged_content[role].items()):
                raise RuntimeError(f"Published split attention {role} bytes differ from staging.")
        return {
            "status": "passed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
            "sourceCheckpointSha256": source_checkpoint_sha256,
            "tensorContract": tensor_contract,
            "prePublicationValidation": prepublication_validation,
            "artifacts": artifacts,
            "totalCompiledBytes": sum(item["compiledBytes"] for item in artifacts.values()),
            "totalPackageBytes": sum(item["mlpackageBytes"] for item in artifacts.values()),
        }
    except Exception as error:  # pragma: no cover - conversion is environment-dependent.
        return {
            "status": "failed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
            "sourceCheckpointSha256": source_checkpoint_sha256,
            "error": repr(error),
        }
    finally:
        for temporary in temporary_directories:
            try:
                safe_remove_sibling_directory(temporary, temporary.parent)
            except Exception:
                pass


def export_coreml(model: nn.Module, checkpoint: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_coreml:
        return {"status": "skipped", "trainingRunId": args.training_run_id, "exportRunId": args.export_run_id}
    if ct is None:
        return {
            "status": "failed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "error": f"coremltools import failed: {COREML_IMPORT_ERROR}",
        }
    if args.model_id == ATTENTION_MODEL_ID:
        return export_attention_incremental_coreml(model, checkpoint, args)
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
        assert_run_input_snapshot_unchanged(args)
        publish_directories_atomically([
            (package_staging, package_target),
            (compiled_staging, args.compiled_model),
        ])
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
    backend: CompiledCoreMLBackend | CompiledAttentionIncrementalCoreMLBackend,
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
        "measurementKind": "full-candidate-generation",
        "p50Ms": None,
        "p95Ms": None,
        "p99Ms": None,
    }
    output_path = measurements_path(args)
    benchmark_inputs: list[str] = []
    try:
        benchmark_inputs = benchmark_input_texts(checkpoint, args)
        if isinstance(backend, CompiledAttentionIncrementalCoreMLBackend):
            result["artifact"] = attention_benchmark_artifact_identity(args)

            def invoke(text: str) -> None:
                decode_attention_coreml_candidates(backend, text, checkpoint, args)
        else:
            result["artifact"] = rel(args.compiled_model)

            def invoke(text: str) -> None:
                decode_coreml_candidates(backend, text, checkpoint, args)

        for _ in range(3):
            for text in benchmark_inputs:
                invoke(text)
        durations = []
        while len(durations) < 120:
            for text in benchmark_inputs:
                started = time.perf_counter()
                invoke(text)
                durations.append((time.perf_counter() - started) * 1000)
                if len(durations) >= 120:
                    break
        result["p50Ms"] = round(float(np.percentile(durations, 50)), 6)
        result["p95Ms"] = round(float(np.percentile(durations, 95)), 6)
        result["p99Ms"] = round(float(np.percentile(durations, 99)), 6)
    except Exception as error:
        result["error"] = repr(error)
    if isinstance(backend, CompiledAttentionIncrementalCoreMLBackend):
        try:
            backend.verify_artifacts()
        except SystemExit as error:
            result["error"] = str(error)
    elif directory_sha256(args.compiled_model) != backend.compiled_sha256:
        result["error"] = "Compiled Core ML bytes changed during benchmark execution."
    write_json(output_path, {
        "generatedAt": iso_now(),
        "measurementKind": "full-candidate-generation",
        "sampleCount": 120,
        "benchmarkInputsSha256": sha256_text("\n".join(benchmark_inputs)) if benchmark_inputs else None,
        "devices": [result],
    })
    return result


def benchmark_input_texts(checkpoint: dict[str, Any], args: argparse.Namespace) -> list[str]:
    input_vocab = checkpoint["inputVocab"]
    lexical_tokens = [
        token
        for token, _ in sorted(input_vocab.items(), key=lambda item: item[1])
        if token not in SPECIAL and len(token) == 1
    ]
    if not lexical_tokens:
        raise SystemExit("Candidate-generation benchmark requires lexical input tokens.")
    candidates = [
        value
        for value in REQUIRED_CASES
        if len(value) < args.max_input_len and all(token in input_vocab for token in value)
    ]
    maximum_lexical_length = args.max_input_len - 1
    for requested_length in (3, 8, 16):
        length = min(requested_length, maximum_lexical_length)
        if length <= 0:
            continue
        value = "".join(lexical_tokens[index % len(lexical_tokens)] for index in range(length))
        if value not in candidates:
            candidates.append(value)
    output = [
        value
        for value in candidates
        if 0 < len(value) <= maximum_lexical_length
    ][:3]
    if not output:
        raise SystemExit("Candidate-generation benchmark could not construct a representable input.")
    return output


def valid_benchmark_result(result: dict[str, Any], args: argparse.Namespace) -> bool:
    required = {
        "name", "macOS", "architecture", "packagedApp", "secureFieldInferenceCount",
        "measurementKind", "p50Ms", "p95Ms", "p99Ms", "artifact",
    }
    try:
        evidence = read_json(measurements_path(args))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        set(result) == required
        and all(isinstance(result.get(key), (int, float)) and math.isfinite(float(result[key])) and result[key] >= 0
                for key in ("p50Ms", "p95Ms", "p99Ms"))
        and isinstance(result.get("artifact"), str)
        and result["artifact"] == (
            attention_benchmark_artifact_identity(args)
            if args.model_id == ATTENTION_MODEL_ID
            else rel(args.compiled_model)
        )
        and evidence.get("measurementKind") == "full-candidate-generation"
        and evidence.get("sampleCount") == 120
        and isinstance(evidence.get("benchmarkInputsSha256"), str)
        and len(evidence["benchmarkInputsSha256"]) == 64
        and evidence.get("devices") == [result]
    )


def attention_benchmark_artifact_identity(args: argparse.Namespace) -> str:
    paths = attention_artifact_paths(args)
    return "+".join(
        rel(paths[role]["compiledModel"])
        for role in ("encoder", "decoderStep")
    )


def write_vocab_metadata(input_vocab: dict[str, int], output_vocab: dict[str, int], args: argparse.Namespace, dataset_manifest: dict[str, Any]) -> None:
    run_input_snapshot = ensure_run_input_snapshot(args)
    input_by_id = tokens_by_id(input_vocab)
    output_by_id = tokens_by_id(output_vocab)
    payload = {
        "schemaVersion": 1,
        "modelId": args.model_id,
        "generatedAt": iso_now(),
        "tokenization": OUTPUT_TOKENIZATION,
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
            "maxSteps": args.max_output_len - 1,
            "outputSequenceValidation": OUTPUT_SEQUENCE_VALIDATION,
            "rejectWhitespaceCandidates": True,
            "rejectLatinCandidates": True,
        },
        "dataset": {
            "manifest": rel(args.dataset_manifest),
            "manifestSha256": run_input_snapshot["dataset"]["manifestSha256"],
            "splitSha256": {
                split: evidence["sha256"]
                for split, evidence in run_input_snapshot["dataset"]["splits"].items()
            },
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
    if checkpoint.get("runInputSnapshot") != ensure_run_input_snapshot(args):
        raise SystemExit("Refusing to publish a runtime manifest from mixed run-input evidence.")
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
    if coreml.get("runtimeModelContract") == ATTENTION_INCREMENTAL_RUNTIME_CONTRACT:
        return write_attention_incremental_manifest(
            args,
            checkpoint,
            coreml,
            benchmark,
            checkpoint_sha256,
        )
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
        "selectedArtifact": checkpoint["modelId"],
        "runtime": "CoreML",
        "localOnly": True,
        "neuralTailOnly": True,
        "productionEligible": production_eligible,
        "architecture": args.effective_training_config["architecture"]["family"],
        "openVocabulary": True,
        "tokenization": OUTPUT_TOKENIZATION,
        "outputSequenceValidation": OUTPUT_SEQUENCE_VALIDATION,
        "decoder": "beam-search",
        "beamSearch": {
            "enabled": True,
            "beamWidth": args.beam_width,
            "maxOutputGraphemes": args.max_output_len,
            "maxSteps": args.max_output_len - 1,
        },
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
            "targetP99Ms": 50,
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
        "limitations": candidate_limitations(),
    }
    write_json(args.manifest, manifest)
    return manifest


def attention_tensor_contract_from_checkpoint(checkpoint: dict[str, Any]) -> dict[str, Any]:
    config = checkpoint.get("config") or {}
    if (
        checkpoint.get("modelId") != ATTENTION_MODEL_ID
        or config.get("architecture_family") != ATTENTION_ARCHITECTURE_FAMILY
        or config.get("attention") != ADDITIVE_ATTENTION
    ):
        raise SystemExit("Cannot derive the split tensor contract from a non-attention checkpoint.")
    layers = int(config["layers"])
    hidden_dim = int(config["hidden_dim"])
    attention_dim = int(config["attention_dim"])
    max_input_len = int(config["max_input_len"])
    beam_width = int(config["beam_width"])
    output_vocab_size = len(checkpoint["outputVocab"])
    return {
        "encoder": {
            "inputs": {
                "inputIds": {"shape": [1, max_input_len], "dataType": "INT32"},
            },
            "outputs": {
                "encoderOutputs": {"shape": [1, max_input_len, hidden_dim * 2], "dataType": "FLOAT16"},
                "encoderEnergy": {"shape": [1, max_input_len, attention_dim], "dataType": "FLOAT16"},
                "validMask": {"shape": [1, max_input_len], "dataType": "FLOAT16"},
                "initialDecoderHidden": {"shape": [layers, 1, hidden_dim], "dataType": "FLOAT16"},
            },
        },
        "decoderStep": {
            "inputs": {
                "decoderTokenIds": {"shape": [beam_width, 1], "dataType": "INT32"},
                "decoderHidden": {"shape": [layers, beam_width, hidden_dim], "dataType": "FLOAT16"},
                "encoderOutputs": {"shape": [1, max_input_len, hidden_dim * 2], "dataType": "FLOAT16"},
                "encoderEnergy": {"shape": [1, max_input_len, attention_dim], "dataType": "FLOAT16"},
                "validMask": {"shape": [1, max_input_len], "dataType": "FLOAT16"},
            },
            "outputs": {
                "stepLogits": {"shape": [beam_width, output_vocab_size], "dataType": "FLOAT16"},
                "nextDecoderHidden": {"shape": [layers, beam_width, hidden_dim], "dataType": "FLOAT16"},
            },
        },
    }


def write_attention_incremental_manifest(
    args: argparse.Namespace,
    checkpoint: dict[str, Any],
    coreml: dict[str, Any],
    benchmark: dict[str, Any],
    checkpoint_sha256: str,
) -> dict[str, Any]:
    if coreml.get("sourceCheckpointSha256") != checkpoint_sha256:
        raise SystemExit("Refusing to publish split attention artifacts from stale checkpoint bytes.")
    tensor_contract = coreml.get("tensorContract")
    if tensor_contract != attention_tensor_contract_from_checkpoint(checkpoint):
        raise SystemExit("Refusing to publish a stale split attention tensor contract.")
    artifacts = verified_attention_artifact_evidence(args, coreml)
    verified_attention_prepublication_validation(
        coreml.get("prePublicationValidation"),
        checkpoint_sha256,
        tensor_contract,
        attention_artifact_content_evidence(artifacts),
    )
    artifact_validation = coreml.get("artifactValidation") or {}
    if (
        artifact_validation.get("status") != "passed"
        or artifact_validation.get("sourceCheckpointSha256") != checkpoint_sha256
        or artifact_validation.get("runtimeModelContract") != ATTENTION_INCREMENTAL_RUNTIME_CONTRACT
        or artifact_validation.get("tensorContract") != tensor_contract
        or artifact_validation.get("artifacts") != artifacts
    ):
        raise SystemExit("Refusing to publish split attention artifacts without exact compiled parity attestation.")
    model_bytes = sum(item["compiledBytes"] for item in artifacts.values())
    contract_issues = runtime_artifact_contract_issues(args, checkpoint, model_bytes)
    if contract_issues:
        raise SystemExit(f"Refusing to write an invalid native runtime artifact: {'; '.join(contract_issues)}")
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
        "selectedArtifact": checkpoint["modelId"],
        "runtime": "CoreML",
        "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
        "tensorContract": tensor_contract,
        "compiledModels": artifacts,
        "localOnly": True,
        "neuralTailOnly": True,
        "productionEligible": False,
        "architecture": args.effective_training_config["architecture"]["family"],
        "openVocabulary": True,
        "tokenization": OUTPUT_TOKENIZATION,
        "outputSequenceValidation": OUTPUT_SEQUENCE_VALIDATION,
        "decoder": "beam-search",
        "beamSearch": {
            "enabled": True,
            "beamWidth": args.beam_width,
            "maxOutputGraphemes": args.max_output_len,
            "maxSteps": args.max_output_len - 1,
        },
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
            "targetP99Ms": 50,
            "measuredOnDevice": benchmark.get("p99Ms") is not None,
            "devices": [benchmark],
        },
        "requiredCases": REQUIRED_CASES,
        "sha256": {
            "compiledModels": {
                role: artifacts[role]["compiledSha256"]
                for role in ("encoder", "decoderStep")
            },
            "mlpackages": {
                role: artifacts[role]["mlpackageSha256"]
                for role in ("encoder", "decoderStep")
            },
            "sourceCheckpoint": checkpoint_sha256,
            "trainingDatasetManifest": checkpoint["datasetManifestSha256"],
            "vocabMetadata": checkpoint.get("vocabMetadataSha256", "0" * 64),
        },
        "limitations": candidate_limitations(),
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


def candidate_limitations() -> list[str]:
    return [
        "This candidate manifest contains placeholder quality metrics until its exported predictions are evaluated and promoted.",
        "Its local unpackaged benchmark is diagnostic; promotion requires a packaged full-candidate measurement on Apple Silicon.",
        "The model is token-only, does not use prior-word context, and remains opt-in while deterministic suggestions stay the default.",
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
    ensure_run_input_snapshot(args)
    if args.skip_train:
        loaded = load_checkpoint(args)
    else:
        loaded = train_model(args)
    model: nn.Module = loaded["model"]
    checkpoint: dict[str, Any] = loaded["checkpoint"]
    training_report: dict[str, Any] = loaded["report"]
    if args.training_run_id == args.export_run_id:
        raise SystemExit("Training and export publication identities must be distinct.")
    assert_run_input_snapshot_unchanged(args)
    coreml = export_coreml(model, checkpoint, args)
    export_succeeded = coreml.get("status") == "passed"
    split_attention_export = (
        export_succeeded
        and coreml.get("runtimeModelContract") == ATTENTION_INCREMENTAL_RUNTIME_CONTRACT
    )
    prediction_evidence: dict[str, Any] | None = None
    comparison_evidence: dict[str, Any] | None = None
    if export_succeeded:
        if split_attention_export:
            backend, artifact_validation = load_verified_compiled_attention_coreml(
                model,
                checkpoint,
                args,
                coreml,
            )
        else:
            backend, artifact_validation = load_verified_compiled_coreml(
                model,
                checkpoint,
                args,
                str(coreml["compiledSha256"]),
                str(coreml["mlpackageSha256"]),
            )
        coreml = {**coreml, "artifactValidation": artifact_validation}
        prediction_evidence = write_gold_predictions(backend, checkpoint, args)
        comparison_evidence = write_official_benchmark_predictions(
            backend,
            checkpoint,
            args,
        )
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
        (
            int(coreml["totalCompiledBytes"])
            if split_attention_export
            else directory_bytes(args.compiled_model) if export_succeeded else 0
        ),
    )
    publishable = (
        benchmark_succeeded
        and prediction_evidence is not None
        and comparison_evidence is not None
        and not runtime_contract_issues
    )
    assert_run_input_snapshot_unchanged(args)
    manifest = write_manifest(args, checkpoint, training_report, coreml, benchmark) if publishable else None
    if publishable:
        export_status = (
            "passed-open-vocab-attention-split-candidate"
            if split_attention_export
            else "passed-open-vocab-seq2seq-candidate"
        )
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
    if split_attention_export:
        compiled_models = verified_attention_artifact_evidence(args, coreml)
        compiled_sha256 = None
        mlpackage_sha256 = None
    else:
        compiled_models = None
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
    if comparison_evidence:
        comparison_path = official_benchmark_predictions_path(args)
        if (
            comparison_evidence.get("predictionsSha256")
            != sha256_file(comparison_path)
        ):
            raise SystemExit(
                "Official benchmark prediction bytes changed before "
                "export-report publication."
            )
        _, current_comparison_evidence = (
            load_verified_official_benchmark_rows(args)
        )
        expected_comparison_evidence = {
            key: comparison_evidence[key]
            for key in (
                "manifest",
                "manifestSha256",
                "corpusSha256",
                "suites",
                "rows",
            )
        }
        if current_comparison_evidence != expected_comparison_evidence:
            raise SystemExit(
                "Official benchmark evidence changed before export-report "
                "publication."
            )
        if (
            comparison_evidence.get("trainingIsolation")
            != ensure_run_input_snapshot(args)["officialBenchmark"][
                "trainingIsolation"
            ]
        ):
            raise SystemExit(
                "Official benchmark training-isolation evidence changed before "
                "export-report publication."
            )

    export_report: dict[str, Any] = {
        "generatedAt": iso_now(),
        "status": export_status,
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "executionModes": args.execution_modes,
        "trainingContractSha256": args.training_contract_sha256,
        "effectiveTrainingConfigSha256": args.effective_training_config_sha256,
        "effectiveArtifactInputsSha256": args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "runInputSnapshot": ensure_run_input_snapshot(args),
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
        "comparisonBenchmark": ({
            "manifest": comparison_evidence["manifest"],
            "manifestSha256": comparison_evidence["manifestSha256"],
            "corpusSha256": comparison_evidence["corpusSha256"],
            "suites": comparison_evidence["suites"],
            "rows": comparison_evidence["rows"],
            "trainingIsolation": comparison_evidence["trainingIsolation"],
            "predictions": comparison_evidence["predictions"],
            "predictionsSha256": comparison_evidence["predictionsSha256"],
            "predictionsBackend": comparison_evidence["backend"],
            "predictionArtifactIdentity": comparison_evidence[
                "artifactIdentity"
            ],
        } if comparison_evidence else None),
        "measurements": rel(measurements_path(args)) if export_succeeded else None,
        "measurementsSha256": sha256_file(measurements_path(args)) if export_succeeded else None,
        "compiledModel": rel(args.compiled_model) if export_succeeded and not split_attention_export else None,
        "compiledModelSha256": compiled_sha256,
        "mlpackage": rel(mlpackage_path(args)) if export_succeeded and not split_attention_export else None,
        "mlpackageSha256": mlpackage_sha256,
        "manifest": rel(args.manifest) if manifest else None,
        "manifestSha256": sha256_file(args.manifest) if manifest else None,
        "productionEligible": bool(manifest and manifest["productionEligible"]),
        "candidateLimitations": candidate_limitations(),
    }
    if split_attention_export:
        export_report.update({
            "runtimeModelContract": ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
            "sourceCheckpointSha256": checkpoint_sha256,
            "tensorContract": coreml["tensorContract"],
            "prePublicationValidation": coreml["prePublicationValidation"],
            "compiledModels": compiled_models,
        })
    assert_run_input_snapshot_unchanged(args)
    write_json(export_report_path(args), export_report)

    print(json.dumps({
        "status": export_status,
        "checkpoint": export_report["checkpoint"],
        "trainingReport": export_report["trainingReport"],
        "exportReport": rel(export_report_path(args)),
        "compiledModel": export_report["compiledModel"],
        "manifest": export_report["manifest"],
        "predictions": export_report["predictions"],
        "comparisonPredictions": (
            export_report["comparisonBenchmark"]["predictions"]
            if export_report["comparisonBenchmark"]
            else None
        ),
        "measurements": export_report["measurements"],
        "coremlExport": coreml.get("status"),
        "productionEligible": export_report["productionEligible"],
        "candidateLimitations": export_report["candidateLimitations"],
    }, ensure_ascii=False, indent=2))
    if not publishable and not args.skip_coreml:
        raise SystemExit(1)
    return export_report


def main() -> None:
    args = parse_args()
    with exclusive_run_lock(args):
        try:
            ensure_run_input_snapshot(args)
            run_pipeline(args)
        finally:
            cleanup_run_input_snapshot(args)


if __name__ == "__main__":
    main()
