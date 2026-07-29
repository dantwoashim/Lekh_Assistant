#!/usr/bin/env python3
"""Train Lekh's fixed-shape Transformer-CTC transliteration successor.

The preserved seq2seq trainer remains the authority for shared repository,
dataset, Unicode, and evidence primitives. This trainer owns the distinct CTC
architecture, vocabulary, augmentation, loss, recovery, export, and runtime
contract. Its immutable snapshot records both imported modules by digest.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
import platform
import random
import re
import shutil
import sys
import time
import unicodedata
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset


ROOT = Path(__file__).resolve().parents[1]
LEGACY_TRAINER_PATH = (
    ROOT / "scripts/train-open-vocab-seq2seq-transliterator.py"
)
SHARED_MODEL_PATH = ROOT / "scripts/lib/neural_ctc_transformer.py"
CONFIG_PATH = (
    ROOT
    / "data/neural/training/open-vocab-ctc-transformer-v2.config.json"
)

if str(ROOT / "scripts/lib") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts/lib"))

from neural_ctc_transformer import (  # noqa: E402
    CTC_BLANK_ID,
    CTCTransformer,
    CTCTransformerDimensions,
    ctc_prefix_beam_search,
    ctc_required_time_steps,
    validate_ctc_input_ids,
)


def load_legacy_trainer() -> Any:
    specification = importlib.util.spec_from_file_location(
        "lekh_ctc_shared_training_primitives",
        LEGACY_TRAINER_PATH,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Unable to load the preserved training primitives.")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    except Exception:
        sys.modules.pop(specification.name, None)
        raise
    return module


LEGACY = load_legacy_trainer()

MODEL_ID = "lekh-open-vocab-ctc-transformer-v2"
ARCHITECTURE_FAMILY = "fixed-shape-transformer-ctc"
RUNTIME_MODEL_CONTRACT = "single-transformer-ctc-v1"
OUTPUT_TOKENIZATION = "unicode-scalar-character"
OUTPUT_SEQUENCE_VALIDATION = "devanagari-word-sequence-v1"
CTC_BLANK = "<ctc-blank>"
PAD = "<pad>"
EOS = "</s>"
UNK = "<unk>"
INPUT_SPECIAL = [PAD, EOS, UNK]
AUGMENTATION_SOURCE = "augmentation-chat-alias-v1"
MAX_CONFIG_BYTES = 8 * 1024 * 1024
NEURAL_TAIL_ADMISSION_POLICY = "roman-token-protected-bypass-v1"
PROTECTED_LATIN_TOKENS = frozenset({
    "api", "otp", "pan", "pdf", "url", "http", "https", "email",
    "gmail", "icloud", "login", "username", "password", "wifi",
    "wi-fi", "qr", "id", "pin", "cvv", "esewa", "khalti", "ime",
    "ntc", "ncell", "tiktok", "whatsapp", "viber", "zoom", "teams",
    "slack", "github", "git", "xcode", "swift", "json", "csv",
    "postgresql", "npm", "swiftui", "macos", "readme", "hello",
    "user", "candidate", "phrase", "detect", "wrong", "upload",
    "submit",
})
SAFE_NEURAL_ROMAN_TOKEN = re.compile(r"^[a-z][a-z'-]*$")

# The remote handoff deliberately calls these names as a trainer interface.
checkpoint_path = LEGACY.checkpoint_path
training_report_path = LEGACY.training_report_path
training_recovery_metadata_path = LEGACY.training_recovery_metadata_path
training_recovery_state_path = LEGACY.training_recovery_state_path
training_recovery_state_files = LEGACY.training_recovery_state_files
export_report_path = LEGACY.export_report_path
predictions_path = LEGACY.predictions_path
official_benchmark_predictions_path = (
    LEGACY.official_benchmark_predictions_path
)
measurements_path = LEGACY.measurements_path
mlpackage_path = LEGACY.mlpackage_path
cleanup_run_input_snapshot = LEGACY.cleanup_run_input_snapshot
exclusive_run_lock = LEGACY.exclusive_run_lock
open_regular_binary = LEGACY.open_regular_binary
read_json = LEGACY.read_json
sha256_file = LEGACY.sha256_file
sha256_text = LEGACY.sha256_text
sha256_json = LEGACY.sha256_json
canonical_json_text = LEGACY.canonical_json_text
write_json = LEGACY.write_json
rel = LEGACY.rel
iso_now = LEGACY.iso_now
staging_sibling = LEGACY.staging_sibling
is_run_identifier = LEGACY.is_run_identifier
device_for_training = LEGACY.device_for_training
source_summary = LEGACY.source_summary
source_weight_mass = LEGACY.source_weight_mass
sampled_rows_sha256 = LEGACY.sampled_rows_sha256
tokens_by_id = LEGACY.tokens_by_id
contains_ascii_latin = LEGACY.contains_ascii_latin
analyze_devanagari_output_sequence = (
    LEGACY.analyze_devanagari_output_sequence
)
is_valid_output_scalar = LEGACY.is_valid_output_scalar
load_verified_gold_rows = LEGACY.load_verified_gold_rows
load_verified_official_benchmark_rows = (
    LEGACY.load_verified_official_benchmark_rows
)
ct = LEGACY.ct
COREML_IMPORT_ERROR = LEGACY.COREML_IMPORT_ERROR
COREML_PARITY_RTOL = LEGACY.COREML_PARITY_RTOL
COREML_PARITY_ATOL = LEGACY.COREML_PARITY_ATOL
directory_bytes = LEGACY.directory_bytes
directory_sha256 = LEGACY.directory_sha256
secure_directory_files = LEGACY.secure_directory_files
safe_remove_sibling_directory = LEGACY.safe_remove_sibling_directory
publish_directories_atomically = LEGACY.publish_directories_atomically
compile_mlpackage_with_coremltools = (
    LEGACY.compile_mlpackage_with_coremltools
)
compile_mlpackage_with_xcode = LEGACY.compile_mlpackage_with_xcode
normalize_compiled_model_path = LEGACY.normalize_compiled_model_path
normalize_input = LEGACY.normalize_input
REQUIRED_CASES = LEGACY.REQUIRED_CASES

_legacy_capture_run_input_snapshot = LEGACY.capture_run_input_snapshot


def execution_topology(
    training_modes: dict[str, Any],
    export_modes: dict[str, Any],
) -> str:
    training_pair = (
        training_modes.get("skipTrain"),
        training_modes.get("skipCoreML"),
    )
    export_pair = (
        export_modes.get("skipTrain"),
        export_modes.get("skipCoreML"),
    )
    if training_pair == (False, False) and export_pair == (False, False):
        return "single-host-train-and-export-v1"
    if training_pair == (False, True) and export_pair == (False, True):
        return "training-only-no-coreml-v1"
    if training_pair == (False, True) and export_pair == (True, False):
        return "split-host-train-then-macos-export-v1"
    raise SystemExit(
        "CTC training and export execution modes do not form an approved "
        "single-host or split-host publication topology."
    )


def parse_args(
    argv: list[str] | None = None,
    environment: dict[str, str] | None = None,
) -> argparse.Namespace:
    argv = list(sys.argv[1:] if argv is None else argv)
    environment = dict(os.environ if environment is None else environment)
    config_parser = argparse.ArgumentParser(add_help=False)
    config_parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    config_args, _ = config_parser.parse_known_args(argv)
    config_path = config_args.config.resolve()
    if not config_path.is_file():
        raise SystemExit(f"Missing training config: {config_path}")
    config_bytes = LEGACY.read_regular_bytes(
        config_path,
        "CTC training config",
        maximum_bytes=MAX_CONFIG_BYTES,
    )
    config = LEGACY.parse_json_object_bytes(
        config_bytes,
        "CTC training config",
    )
    validate_executable_config(config)

    architecture = config["architecture"]
    decoder = config["decoder"]
    training = config["training"]
    training_run = config["trainingRun"]
    early_stopping = training_run["earlyStopping"]
    optimizer = training["optimizer"]
    scheduler = training["scheduler"]

    parser = argparse.ArgumentParser(
        description=__doc__,
        parents=[config_parser],
    )
    parser.add_argument(
        "--dataset-manifest",
        type=Path,
        default=ROOT / training["datasetManifest"],
    )
    parser.add_argument(
        "--gold-manifest",
        type=Path,
        default=ROOT / config["evaluation"]["goldManifest"],
    )
    parser.add_argument(
        "--official-benchmark-manifest",
        type=Path,
        default=ROOT / config["evaluation"]["officialBenchmarkManifest"],
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=(ROOT / config["export"]["sourceCheckpoint"]).parent,
    )
    parser.add_argument("--compiled-model", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--vocab-metadata", type=Path)
    add_configurable_argument(
        parser,
        "--max-train-rows",
        int,
        training_run["maximumTrainRows"],
        "LEKH_NEURAL_MAX_TRAIN_ROWS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--max-dev-rows",
        int,
        training_run["maximumDevRows"],
        "LEKH_NEURAL_MAX_DEV_ROWS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--epochs",
        int,
        training_run["maximumEpochs"],
        "LEKH_NEURAL_EPOCHS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--batch-size",
        int,
        training_run["batchSize"],
        "LEKH_NEURAL_BATCH_SIZE",
        environment,
    )
    add_configurable_argument(
        parser,
        "--model-dimension",
        int,
        architecture["modelDimension"],
        "LEKH_NEURAL_MODEL_DIMENSION",
        environment,
    )
    add_configurable_argument(
        parser,
        "--attention-heads",
        int,
        architecture["attentionHeads"],
        "LEKH_NEURAL_ATTENTION_HEADS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--feed-forward-dimension",
        int,
        architecture["feedForwardDimension"],
        "LEKH_NEURAL_FEED_FORWARD_DIMENSION",
        environment,
    )
    add_configurable_argument(
        parser,
        "--layers",
        int,
        architecture["encoderLayers"],
        "LEKH_NEURAL_LAYERS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--dropout",
        float,
        architecture["dropout"],
        "LEKH_NEURAL_DROPOUT",
        environment,
    )
    add_configurable_argument(
        parser,
        "--max-input-len",
        int,
        decoder["maxInputGraphemes"],
        "LEKH_NEURAL_MAX_INPUT_LEN",
        environment,
    )
    add_configurable_argument(
        parser,
        "--output-time-steps",
        int,
        decoder["outputTimeSteps"],
        "LEKH_NEURAL_OUTPUT_TIME_STEPS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--beam-width",
        int,
        decoder["beamWidth"],
        "LEKH_NEURAL_BEAM_WIDTH",
        environment,
    )
    add_configurable_argument(
        parser,
        "--maximum-candidates",
        int,
        decoder["maximumCandidates"],
        "LEKH_NEURAL_MAXIMUM_CANDIDATES",
        environment,
    )
    add_configurable_argument(
        parser,
        "--learning-rate",
        float,
        training_run["peakLearningRate"],
        "LEKH_NEURAL_LEARNING_RATE",
        environment,
    )
    add_configurable_argument(
        parser,
        "--gradient-clip-norm",
        float,
        training_run["gradientClipNorm"],
        "LEKH_NEURAL_GRADIENT_CLIP_NORM",
        environment,
    )
    add_configurable_argument(
        parser,
        "--weight-decay",
        float,
        optimizer["weightDecay"],
        "LEKH_NEURAL_WEIGHT_DECAY",
        environment,
    )
    add_configurable_argument(
        parser,
        "--warmup-steps",
        int,
        scheduler["warmupSteps"],
        "LEKH_NEURAL_WARMUP_STEPS",
        environment,
    )
    add_configurable_argument(
        parser,
        "--early-stopping-patience",
        int,
        early_stopping["patienceEpochs"],
        "LEKH_NEURAL_EARLY_STOPPING_PATIENCE",
        environment,
    )
    add_configurable_argument(
        parser,
        "--early-stopping-min-delta",
        float,
        early_stopping["minimumDelta"],
        "LEKH_NEURAL_EARLY_STOPPING_MIN_DELTA",
        environment,
    )
    add_configurable_argument(
        parser,
        "--seed",
        int,
        training_run["seed"],
        "LEKH_NEURAL_SEED",
        environment,
    )
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--skip-coreml", action="store_true")
    parser.add_argument(
        "--training-device",
        choices=("cpu", "cuda"),
        default="cpu",
    )
    parser.add_argument("--restart-training", action="store_true")
    args = parser.parse_args(argv)

    args.training_config = config
    args.model_id = MODEL_ID
    args.architecture_family = ARCHITECTURE_FAMILY
    args.runtime_model_contract = RUNTIME_MODEL_CONTRACT
    args.max_output_len = args.output_time_steps
    args.optimizer_beta1 = float(optimizer["beta1"])
    args.optimizer_beta2 = float(optimizer["beta2"])
    args.optimizer_epsilon = float(optimizer["epsilon"])
    args.augmentation_config = copy.deepcopy(training["augmentation"])
    args.source_multipliers = {
        str(source): float(multiplier)
        for source, multiplier in training["samplingPolicy"][
            "sourceMultipliers"
        ].items()
    }
    args.early_stopping_enabled = bool(early_stopping["enabled"])
    args.early_stopping_metric = str(early_stopping["metric"])
    args.restore_best_weights = bool(
        early_stopping["restoreBestWeights"]
    )
    candidate_stem = "LekhNeuralTransliterator"
    if args.compiled_model is None:
        args.compiled_model = args.out_dir / f"{candidate_stem}.mlmodelc"
    if args.manifest is None:
        args.manifest = args.out_dir / f"{candidate_stem}.manifest.json"
    if args.vocab_metadata is None:
        args.vocab_metadata = args.out_dir / f"{candidate_stem}.vocab.json"
    validate_effective_args(args)
    LEGACY.validate_output_paths(args)

    args.training_contract_sha256 = hashlib.sha256(config_bytes).hexdigest()
    args.config = config_path
    args.configured_training_config = configured_training_config(config)
    args.effective_training_config = effective_training_config(args, config)
    args.effective_training_config_canonical_json = canonical_json_text(
        args.effective_training_config
    )
    args.effective_training_config_sha256 = sha256_text(
        args.effective_training_config_canonical_json
    )
    args.training_overrides = collect_training_overrides(
        argv,
        environment,
        args.configured_training_config,
        args.effective_training_config,
    )
    args.configured_artifact_inputs = LEGACY.configured_artifact_inputs(
        config_path,
        config,
    )
    args.effective_artifact_inputs = LEGACY.effective_artifact_inputs(args)
    args.effective_artifact_inputs_canonical_json = canonical_json_text(
        args.effective_artifact_inputs
    )
    args.effective_artifact_inputs_sha256 = sha256_text(
        args.effective_artifact_inputs_canonical_json
    )
    args.artifact_overrides = LEGACY.collect_artifact_overrides(
        argv,
        args.configured_artifact_inputs,
        args.effective_artifact_inputs,
    )
    args.execution_modes = {
        "skipTrain": bool(args.skip_train),
        "skipCoreML": bool(args.skip_coreml),
        "trainingDevice": str(args.training_device),
    }
    if args.skip_train and args.restart_training:
        raise SystemExit(
            "--skip-train and --restart-training are mutually exclusive."
        )
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
    default = (
        cast(environment[environment_name])
        if environment_name in environment
        else cast(configured)
    )
    parser.add_argument(option, type=cast, default=default)


def validate_executable_config(config: dict[str, Any]) -> None:
    if (
        config.get("schemaVersion") != 2
        or config.get("implementationContractVersion") != 2
        or config.get("modelId") != MODEL_ID
    ):
        raise SystemExit("CTC config identity/version is unsupported.")
    architecture = config.get("architecture") or {}
    decoder = config.get("decoder") or {}
    training = config.get("training") or {}
    evaluation = config.get("evaluation") or {}
    if (
        architecture.get("family") != ARCHITECTURE_FAMILY
        or architecture.get("runtimeModelContract")
            != RUNTIME_MODEL_CONTRACT
        or architecture.get("tokenization") != OUTPUT_TOKENIZATION
    ):
        raise SystemExit("CTC architecture contract is invalid.")
    if (
        decoder.get("type") != "ctc-prefix-beam-search"
        or decoder.get("blankId") != CTC_BLANK_ID
        or decoder.get("outputSequenceValidation")
            != OUTPUT_SEQUENCE_VALIDATION
    ):
        raise SystemExit("CTC decoder contract is invalid.")
    if (
        training.get("loss") != "weighted-ctc"
        or training.get("lossComputationDevice")
            != "cpu-for-deterministic-backward"
    ):
        raise SystemExit(
            "CTC config must declare deterministic CPU weighted-CTC loss."
        )
    if training.get("scheduler", {}).get("type") != (
        "linear-warmup-inverse-square-root"
    ):
        raise SystemExit("CTC scheduler contract is invalid.")
    if evaluation != {
        "goldManifest": "data/neural/gold/manifest.v3.json",
        "officialBenchmarkManifest": (
            "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
        ),
        "officialBenchmarkTrainingUse": "forbidden-evaluation-only",
    }:
        raise SystemExit("CTC evaluation inputs are not the locked corpora.")
    context = config.get("context") or {}
    if (
        context.get("previousWords") != 0
        or context.get("languageModelRescorer", {}).get("enabled") is not False
    ):
        raise SystemExit("CTC context/rescoring must remain disabled.")
    expected_root = (
        "data/generated/neural-open-vocab-model/"
        "lekh-open-vocab-ctc-transformer-v2"
    )
    expected_exports = {
        "sourceCheckpoint": f"{expected_root}/checkpoint.pt",
        "intermediateMLPackage": (
            f"{expected_root}/LekhNeuralTransliterator.mlpackage"
        ),
        "compiledModel": (
            f"{expected_root}/LekhNeuralTransliterator.mlmodelc"
        ),
        "manifest": (
            f"{expected_root}/LekhNeuralTransliterator.manifest.json"
        ),
        "vocabMetadata": (
            f"{expected_root}/LekhNeuralTransliterator.vocab.json"
        ),
    }
    for field, expected in expected_exports.items():
        if config.get("export", {}).get(field) != expected:
            raise SystemExit(f"CTC export.{field} must equal {expected}.")
    if config.get("artifact", {}).get("compiledModel") != (
        expected_exports["compiledModel"]
    ):
        raise SystemExit("CTC artifact/export compiled paths differ.")
    if config.get("artifact", {}).get("manifest") != (
        expected_exports["manifest"]
    ):
        raise SystemExit("CTC artifact/export manifest paths differ.")
    if config.get("artifact", {}).get("vocabMetadata") != (
        expected_exports["vocabMetadata"]
    ):
        raise SystemExit("CTC artifact/export vocabulary paths differ.")
    aliases = training.get("augmentation", {}).get("aliases")
    if (
        not isinstance(aliases, list)
        or not aliases
        or any(
            not isinstance(alias, dict)
            or set(alias) != {
                "from",
                "to",
                "weightMultiplier",
            }
            for alias in aliases
        )
    ):
        raise SystemExit("CTC augmentation aliases are invalid.")
    alias_pairs = set()
    for alias in aliases:
        source = alias["from"]
        replacement = alias["to"]
        multiplier = alias["weightMultiplier"]
        if (
            not isinstance(source, str)
            or not source
            or not source.isascii()
            or not source.islower()
            or not source.isalpha()
            or not isinstance(replacement, str)
            or not replacement
            or not replacement.isascii()
            or not replacement.islower()
            or not replacement.isalpha()
            or source == replacement
            or not isinstance(multiplier, (int, float))
            or not math.isfinite(float(multiplier))
            or float(multiplier) <= 0
            or (source, replacement) in alias_pairs
        ):
            raise SystemExit("CTC augmentation alias values are invalid.")
        alias_pairs.add((source, replacement))
    augmentation = training["augmentation"]
    if (
        augmentation.get("enabled") is not True
        or augmentation.get("policy") != AUGMENTATION_SOURCE
        or augmentation.get("heldOutCollisionPolicy") != "reject"
        or augmentation.get("conflictingTrainingTargetPolicy") != "reject"
    ):
        raise SystemExit("CTC augmentation safety policy is invalid.")
    source_multipliers = training.get("samplingPolicy", {}).get(
        "sourceMultipliers"
    )
    if (
        not isinstance(source_multipliers, dict)
        or any(
            not isinstance(source, str)
            or not source
            or not isinstance(multiplier, (int, float))
            or not math.isfinite(float(multiplier))
            or float(multiplier) <= 0
            for source, multiplier in source_multipliers.items()
        )
    ):
        raise SystemExit("CTC source multipliers are invalid.")
    optimizer = training.get("optimizer") or {}
    if (
        optimizer.get("type") != "adamw"
        or any(
            not isinstance(optimizer.get(field), (int, float))
            or not math.isfinite(float(optimizer[field]))
            for field in ("beta1", "beta2", "epsilon", "weightDecay")
        )
        or not 0 < float(optimizer["beta1"]) < 1
        or not 0 < float(optimizer["beta2"]) < 1
        or float(optimizer["epsilon"]) <= 0
        or float(optimizer["weightDecay"]) < 0
    ):
        raise SystemExit("CTC optimizer contract is invalid.")


def validate_effective_args(args: argparse.Namespace) -> None:
    positive_integers = {
        "max_train_rows": args.max_train_rows,
        "max_dev_rows": args.max_dev_rows,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "model_dimension": args.model_dimension,
        "attention_heads": args.attention_heads,
        "feed_forward_dimension": args.feed_forward_dimension,
        "layers": args.layers,
        "max_input_len": args.max_input_len,
        "output_time_steps": args.output_time_steps,
        "beam_width": args.beam_width,
        "maximum_candidates": args.maximum_candidates,
        "warmup_steps": args.warmup_steps,
        "early_stopping_patience": args.early_stopping_patience,
    }
    invalid = [
        name
        for name, value in positive_integers.items()
        if type(value) is not int or value < 1
    ]
    if invalid:
        raise SystemExit(
            "CTC integer arguments must be positive: " + ", ".join(invalid)
        )
    numeric = {
        "dropout": args.dropout,
        "learning_rate": args.learning_rate,
        "gradient_clip_norm": args.gradient_clip_norm,
        "weight_decay": args.weight_decay,
        "early_stopping_min_delta": args.early_stopping_min_delta,
    }
    if any(not math.isfinite(float(value)) for value in numeric.values()):
        raise SystemExit("CTC numeric arguments must be finite.")
    if not 0 <= args.dropout < 1:
        raise SystemExit("CTC dropout must be in [0, 1).")
    if (
        args.learning_rate <= 0
        or args.gradient_clip_norm <= 0
        or args.weight_decay < 0
        or args.early_stopping_min_delta < 0
    ):
        raise SystemExit("CTC optimizer arguments are outside their domains.")
    if args.model_dimension % args.attention_heads:
        raise SystemExit(
            "CTC model dimension must divide evenly by attention heads."
        )
    if not 2 <= args.beam_width <= 16:
        raise SystemExit("CTC beam width must be in [2, 16].")
    if not 1 <= args.maximum_candidates <= args.beam_width:
        raise SystemExit(
            "CTC maximum candidates must be in [1, beam width]."
        )
    if args.output_time_steps < 8 or args.output_time_steps > 48:
        raise SystemExit("CTC output time steps must be in [8, 48].")
    if not args.early_stopping_enabled or not args.restore_best_weights:
        raise SystemExit(
            "CTC training requires early stopping and best-weight restoration."
        )


def configured_training_config(config: dict[str, Any]) -> dict[str, Any]:
    architecture = config["architecture"]
    decoder = config["decoder"]
    training = config["training"]
    training_run = config["trainingRun"]
    early_stopping = training_run["earlyStopping"]
    return {
        "architecture": {
            "family": architecture["family"],
            "runtimeModelContract": architecture["runtimeModelContract"],
            "modelDimension": int(architecture["modelDimension"]),
            "attentionHeads": int(architecture["attentionHeads"]),
            "feedForwardDimension": int(
                architecture["feedForwardDimension"]
            ),
            "encoderLayers": int(architecture["encoderLayers"]),
            "dropout": float(architecture["dropout"]),
        },
        "decoder": {
            "type": decoder["type"],
            "blankId": int(decoder["blankId"]),
            "beamWidth": int(decoder["beamWidth"]),
            "maxInputGraphemes": int(decoder["maxInputGraphemes"]),
            "outputTimeSteps": int(decoder["outputTimeSteps"]),
            "maximumCandidates": int(decoder["maximumCandidates"]),
        },
        "training": {
            "augmentation": copy.deepcopy(training["augmentation"]),
            "sourceMultipliers": copy.deepcopy(
                training["samplingPolicy"]["sourceMultipliers"]
            ),
            "optimizer": copy.deepcopy(training["optimizer"]),
            "scheduler": copy.deepcopy(training["scheduler"]),
        },
        "trainingRun": {
            "seed": int(training_run["seed"]),
            "maximumTrainRows": int(training_run["maximumTrainRows"]),
            "maximumDevRows": int(training_run["maximumDevRows"]),
            "maximumEpochs": int(training_run["maximumEpochs"]),
            "batchSize": int(training_run["batchSize"]),
            "peakLearningRate": float(training_run["peakLearningRate"]),
            "gradientClipNorm": float(training_run["gradientClipNorm"]),
            "earlyStopping": {
                "enabled": bool(early_stopping["enabled"]),
                "metric": early_stopping["metric"],
                "patienceEpochs": int(
                    early_stopping["patienceEpochs"]
                ),
                "minimumDelta": float(early_stopping["minimumDelta"]),
                "restoreBestWeights": bool(
                    early_stopping["restoreBestWeights"]
                ),
            },
        },
    }


def effective_training_config(
    args: argparse.Namespace,
    config: dict[str, Any],
) -> dict[str, Any]:
    effective = configured_training_config(config)
    effective["architecture"].update({
        "modelDimension": args.model_dimension,
        "attentionHeads": args.attention_heads,
        "feedForwardDimension": args.feed_forward_dimension,
        "encoderLayers": args.layers,
        "dropout": args.dropout,
    })
    effective["decoder"].update({
        "beamWidth": args.beam_width,
        "maxInputGraphemes": args.max_input_len,
        "outputTimeSteps": args.output_time_steps,
        "maximumCandidates": args.maximum_candidates,
    })
    effective["training"]["optimizer"]["weightDecay"] = args.weight_decay
    effective["training"]["scheduler"]["warmupSteps"] = args.warmup_steps
    effective["trainingRun"].update({
        "seed": args.seed,
        "maximumTrainRows": args.max_train_rows,
        "maximumDevRows": args.max_dev_rows,
        "maximumEpochs": args.epochs,
        "batchSize": args.batch_size,
        "peakLearningRate": args.learning_rate,
        "gradientClipNorm": args.gradient_clip_norm,
    })
    effective["trainingRun"]["earlyStopping"].update({
        "patienceEpochs": args.early_stopping_patience,
        "minimumDelta": args.early_stopping_min_delta,
    })
    return effective


def collect_training_overrides(
    argv: list[str],
    environment: dict[str, str],
    configured: dict[str, Any],
    effective: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    bindings = {
        "architecture.modelDimension": (
            "--model-dimension",
            "LEKH_NEURAL_MODEL_DIMENSION",
        ),
        "architecture.attentionHeads": (
            "--attention-heads",
            "LEKH_NEURAL_ATTENTION_HEADS",
        ),
        "architecture.feedForwardDimension": (
            "--feed-forward-dimension",
            "LEKH_NEURAL_FEED_FORWARD_DIMENSION",
        ),
        "architecture.encoderLayers": (
            "--layers",
            "LEKH_NEURAL_LAYERS",
        ),
        "architecture.dropout": (
            "--dropout",
            "LEKH_NEURAL_DROPOUT",
        ),
        "decoder.beamWidth": (
            "--beam-width",
            "LEKH_NEURAL_BEAM_WIDTH",
        ),
        "decoder.maxInputGraphemes": (
            "--max-input-len",
            "LEKH_NEURAL_MAX_INPUT_LEN",
        ),
        "decoder.outputTimeSteps": (
            "--output-time-steps",
            "LEKH_NEURAL_OUTPUT_TIME_STEPS",
        ),
        "decoder.maximumCandidates": (
            "--maximum-candidates",
            "LEKH_NEURAL_MAXIMUM_CANDIDATES",
        ),
        "training.optimizer.weightDecay": (
            "--weight-decay",
            "LEKH_NEURAL_WEIGHT_DECAY",
        ),
        "training.scheduler.warmupSteps": (
            "--warmup-steps",
            "LEKH_NEURAL_WARMUP_STEPS",
        ),
        "trainingRun.seed": ("--seed", "LEKH_NEURAL_SEED"),
        "trainingRun.maximumTrainRows": (
            "--max-train-rows",
            "LEKH_NEURAL_MAX_TRAIN_ROWS",
        ),
        "trainingRun.maximumDevRows": (
            "--max-dev-rows",
            "LEKH_NEURAL_MAX_DEV_ROWS",
        ),
        "trainingRun.maximumEpochs": (
            "--epochs",
            "LEKH_NEURAL_EPOCHS",
        ),
        "trainingRun.batchSize": (
            "--batch-size",
            "LEKH_NEURAL_BATCH_SIZE",
        ),
        "trainingRun.peakLearningRate": (
            "--learning-rate",
            "LEKH_NEURAL_LEARNING_RATE",
        ),
        "trainingRun.gradientClipNorm": (
            "--gradient-clip-norm",
            "LEKH_NEURAL_GRADIENT_CLIP_NORM",
        ),
        "trainingRun.earlyStopping.patienceEpochs": (
            "--early-stopping-patience",
            "LEKH_NEURAL_EARLY_STOPPING_PATIENCE",
        ),
        "trainingRun.earlyStopping.minimumDelta": (
            "--early-stopping-min-delta",
            "LEKH_NEURAL_EARLY_STOPPING_MIN_DELTA",
        ),
    }
    overrides: dict[str, dict[str, Any]] = {}
    for dotted_path, (option, environment_name) in bindings.items():
        if LEGACY.option_present(argv, option):
            source = "command-line"
        elif environment_name in environment:
            source = f"environment:{environment_name}"
        else:
            continue
        configured_value = LEGACY.nested_value(configured, dotted_path)
        effective_value = LEGACY.nested_value(effective, dotted_path)
        if configured_value != effective_value:
            overrides[dotted_path] = {
                "configured": configured_value,
                "effective": effective_value,
                "source": source,
            }
    return overrides


def capture_run_input_snapshot(
    args: argparse.Namespace,
    *,
    freeze_dataset: bool = False,
) -> dict[str, Any]:
    snapshot = _legacy_capture_run_input_snapshot(
        args,
        freeze_dataset=freeze_dataset,
    )
    snapshot["trainer"] = {
        "path": rel(Path(__file__)),
        "sha256": sha256_file(Path(__file__)),
    }
    snapshot["trainerDependencies"] = [
        {
            "path": rel(path),
            "sha256": sha256_file(path),
        }
        for path in (LEGACY_TRAINER_PATH, SHARED_MODEL_PATH)
    ]
    return snapshot


def ensure_run_input_snapshot(
    args: argparse.Namespace,
) -> dict[str, Any]:
    LEGACY.configure_deterministic_runtime(args)
    snapshot = getattr(args, "run_input_snapshot", None)
    if snapshot is None:
        snapshot = capture_run_input_snapshot(args, freeze_dataset=True)
        args.run_input_snapshot = snapshot
    return snapshot


def immutable_run_input_snapshot(
    snapshot: dict[str, Any],
) -> dict[str, Any]:
    return LEGACY.immutable_run_input_snapshot(snapshot)


def run_input_snapshots_share_immutable_inputs(
    training_snapshot: dict[str, Any],
    export_snapshot: dict[str, Any],
) -> bool:
    return (
        immutable_run_input_snapshot(training_snapshot)
        == immutable_run_input_snapshot(export_snapshot)
    )


def assert_run_input_snapshot_unchanged(
    args: argparse.Namespace,
) -> None:
    expected = ensure_run_input_snapshot(args)
    observed = capture_run_input_snapshot(args)
    if observed != expected:
        raise SystemExit(
            "CTC trainer/config/dependencies/data/gold changed during the run."
        )


def load_base_rows(
    args: argparse.Namespace,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    # The preserved loader reserves two autoregressive positions. Supplying
    # output_time_steps + 2 retains its validation while enforcing the exact
    # CTC target ceiling below.
    train_rows, dev_rows, manifest = LEGACY.load_rows(
        args.dataset_manifest,
        args.max_train_rows,
        args.max_dev_rows,
        args.seed,
        args.max_input_len,
        args.output_time_steps + 2,
        split_paths=args.run_dataset_split_paths,
    )
    for split, rows in (("train", train_rows), ("dev", dev_rows)):
        for row in rows:
            scalars = LEGACY.output_scalars(row["target"])
            required = len(scalars) + sum(
                left == right
                for left, right in zip(scalars, scalars[1:])
            )
            if required > args.output_time_steps:
                raise SystemExit(
                    f"CTC {split} row {row['id']} requires {required} "
                    f"time steps, exceeding {args.output_time_steps}."
                )
    return train_rows, dev_rows, manifest


def held_out_inputs(args: argparse.Namespace) -> set[str]:
    paths = args.run_dataset_split_paths
    blocked = set()
    for split in ("dev", "test"):
        blocked.update(LEGACY.load_split_inputs(paths[split]))
    gold_rows, _ = load_verified_gold_rows(args)
    official_rows, _ = load_verified_official_benchmark_rows(args)
    blocked.update(
        LEGACY.normalize_input(row.get("input", ""))
        for row in [*gold_rows, *official_rows]
    )
    blocked.discard("")
    return blocked


def augment_training_rows(
    rows: list[dict[str, Any]],
    aliases: list[dict[str, Any]],
    *,
    blocked_inputs: set[str],
    max_input_len: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    targets_by_input: dict[str, set[str]] = {}
    for row in rows:
        targets_by_input.setdefault(row["input"], set()).update(
            row["acceptable"]
        )
    seen_pairs = {
        (row["input"], row["target"])
        for row in rows
    }
    augmented: list[dict[str, Any]] = []
    rejected = Counter()
    by_alias = Counter()
    for row in sorted(rows, key=lambda item: item["id"]):
        for alias in aliases:
            source = str(alias["from"])
            replacement = str(alias["to"])
            multiplier = float(alias["weightMultiplier"])
            if source not in row["input"]:
                continue
            candidate = row["input"].replace(source, replacement)
            if (
                candidate == row["input"]
                or not candidate
                or len(candidate) > max_input_len - 1
                or not all("a" <= character <= "z" for character in candidate)
            ):
                rejected["invalid"] += 1
                continue
            if candidate in blocked_inputs:
                rejected["held-out-collision"] += 1
                continue
            existing_targets = targets_by_input.get(candidate, set())
            if existing_targets and row["target"] not in existing_targets:
                rejected["conflicting-training-target"] += 1
                continue
            pair = (candidate, row["target"])
            if pair in seen_pairs:
                rejected["duplicate"] += 1
                continue
            identity = sha256_text(
                canonical_json_text({
                    "policy": AUGMENTATION_SOURCE,
                    "sourceId": row["id"],
                    "input": candidate,
                    "target": row["target"],
                    "alias": {
                        "from": source,
                        "to": replacement,
                        "weightMultiplier": multiplier,
                    },
                })
            )[:24]
            generated = {
                **copy.deepcopy(row),
                "id": f"ctc_aug_{identity}",
                "input": candidate,
                "sourceIds": [
                    AUGMENTATION_SOURCE,
                    f"derived:{LEGACY.primary_source(row)}",
                ],
                "weight": float(row["weight"]) * multiplier,
                "augmentation": {
                    "policy": AUGMENTATION_SOURCE,
                    "sourceId": row["id"],
                    "from": source,
                    "to": replacement,
                    "weightMultiplier": multiplier,
                },
            }
            augmented.append(generated)
            targets_by_input.setdefault(candidate, set()).update(
                generated["acceptable"]
            )
            seen_pairs.add(pair)
            by_alias[f"{source}->{replacement}"] += 1
    combined = [*rows, *augmented]
    report = {
        "schemaVersion": 1,
        "policy": AUGMENTATION_SOURCE,
        "baseRows": len(rows),
        "generatedRows": len(augmented),
        "combinedRows": len(combined),
        "generatedByAlias": dict(sorted(by_alias.items())),
        "rejected": dict(sorted(rejected.items())),
        "blockedInputCount": len(blocked_inputs),
        "generatedRowsSha256": sampled_rows_sha256(augmented),
    }
    return combined, report


def apply_source_multipliers(
    rows: Iterable[dict[str, Any]],
    multipliers: dict[str, float],
) -> list[dict[str, Any]]:
    weighted = []
    for row in rows:
        source = LEGACY.primary_source(row)
        multiplier = float(multipliers.get(source, 1.0))
        if not math.isfinite(multiplier) or multiplier <= 0:
            raise SystemExit(
                f"Source multiplier for {source} must be positive and finite."
            )
        updated = copy.deepcopy(row)
        updated["weight"] = float(row["weight"]) * multiplier
        updated["sourceWeightMultiplier"] = multiplier
        weighted.append(updated)
    return weighted


def build_input_vocab(rows: Sequence[dict[str, Any]]) -> dict[str, int]:
    lexical = sorted({
        character
        for row in rows
        for character in row["input"]
    })
    if not lexical or any(
        len(character) != 1 or not "a" <= character <= "z"
        for character in lexical
    ):
        raise SystemExit("CTC input vocabulary contains invalid Roman scalars.")
    return {
        token: index
        for index, token in enumerate([*INPUT_SPECIAL, *lexical])
    }


def build_output_vocab(rows: Sequence[dict[str, Any]]) -> dict[str, int]:
    lexical = sorted({
        scalar
        for row in rows
        for scalar in LEGACY.output_scalars(row["target"])
    })
    if not lexical or any(
        not is_valid_output_scalar(scalar)
        for scalar in lexical
    ):
        raise SystemExit(
            "CTC output vocabulary contains invalid Devanagari scalars."
        )
    return {
        token: index
        for index, token in enumerate([CTC_BLANK, *lexical])
    }


def encode_input(
    value: str,
    vocabulary: dict[str, int],
    max_input_len: int,
) -> list[int]:
    normalized = LEGACY.normalize_input(value)
    lexical_ids = [
        vocabulary.get(character, vocabulary[UNK])
        for character in normalized
    ]
    ids = [*lexical_ids, vocabulary[EOS]]
    if len(ids) > max_input_len:
        raise ValueError("CTC input exceeds the fixed input tensor.")
    return [*ids, *([vocabulary[PAD]] * (max_input_len - len(ids)))]


def encode_target(
    value: str,
    vocabulary: dict[str, int],
    output_time_steps: int,
) -> list[int]:
    ids = [vocabulary[scalar] for scalar in LEGACY.output_scalars(value)]
    if ctc_required_time_steps(ids) > output_time_steps:
        raise ValueError("CTC target exceeds the fixed alignment tensor.")
    return ids


class CTCTransliterationDataset(Dataset):
    def __init__(
        self,
        rows: Sequence[dict[str, Any]],
        input_vocab: dict[str, int],
        output_vocab: dict[str, int],
        max_input_len: int,
        output_time_steps: int,
    ) -> None:
        self.rows = rows
        self.input_vocab = input_vocab
        self.output_vocab = output_vocab
        self.max_input_len = max_input_len
        self.output_time_steps = output_time_steps

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(
        self,
        index: int,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        row = self.rows[index]
        source = torch.tensor(
            encode_input(
                row["input"],
                self.input_vocab,
                self.max_input_len,
            ),
            dtype=torch.int32,
        )
        target = torch.tensor(
            encode_target(
                row["target"],
                self.output_vocab,
                self.output_time_steps,
            ),
            dtype=torch.int64,
        )
        weight = torch.tensor(float(row["weight"]), dtype=torch.float32)
        return source, target, weight


def collate_ctc_batch(
    batch: Sequence[tuple[torch.Tensor, torch.Tensor, torch.Tensor]],
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    if not batch:
        raise ValueError("Cannot collate an empty CTC batch.")
    sources, targets, weights = zip(*batch)
    target_lengths = torch.tensor(
        [target.numel() for target in targets],
        dtype=torch.int64,
    )
    return (
        torch.stack(sources),
        torch.cat(targets),
        target_lengths,
        torch.stack(weights),
    )


def weighted_ctc_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    target_lengths: torch.Tensor,
    weights: torch.Tensor,
    *,
    blank_id: int = CTC_BLANK_ID,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    if logits.ndim != 3:
        raise ValueError("CTC logits must have [batch, time, classes].")
    batch, time_steps, classes = logits.shape
    if (
        target_lengths.shape != (batch,)
        or weights.shape != (batch,)
        or targets.ndim != 1
        or int(target_lengths.sum()) != targets.numel()
        or classes < 2
    ):
        raise ValueError("CTC batch tensors have incompatible shapes.")
    if (
        not torch.isfinite(logits).all()
        or not torch.isfinite(weights).all()
        or torch.any(weights <= 0)
    ):
        raise ValueError("CTC logits and weights must be finite and positive.")
    # PyTorch 2.7 has no deterministic CUDA implementation for CTC backward.
    # Keep the Transformer forward pass on CUDA, but cross the differentiable
    # device-copy boundary before log-softmax/CTC. Gradients flow back to the
    # CUDA logits while the loss kernel remains deterministic and fail-closed.
    # Targets and weights intentionally remain on CPU in the training loop.
    loss_logits = logits.to(device="cpu", dtype=torch.float32)
    loss_targets = targets.to(device="cpu", dtype=torch.int64)
    loss_target_lengths = target_lengths.to(
        device="cpu",
        dtype=torch.int64,
    )
    loss_weights = weights.to(device="cpu", dtype=torch.float32)
    input_lengths = torch.full(
        (batch,),
        time_steps,
        dtype=torch.int64,
        device="cpu",
    )
    losses = torch.nn.functional.ctc_loss(
        torch.log_softmax(loss_logits, dim=-1).transpose(0, 1),
        loss_targets,
        input_lengths,
        loss_target_lengths,
        blank=blank_id,
        reduction="none",
        zero_infinity=False,
    )
    if not torch.isfinite(losses).all():
        raise SystemExit(
            "CTC loss became non-finite; target alignment is invalid."
        )
    numerator = (losses * loss_weights).sum()
    denominator = loss_weights.sum()
    return numerator / denominator, numerator.detach(), denominator.detach()


def dimensions_from_runtime_config(
    input_vocab_size: int,
    output_class_count: int,
    runtime_config: dict[str, Any],
) -> CTCTransformerDimensions:
    if (
        runtime_config.get("model_id") != MODEL_ID
        or runtime_config.get("architecture_family")
            != ARCHITECTURE_FAMILY
        or runtime_config.get("runtime_model_contract")
            != RUNTIME_MODEL_CONTRACT
        or runtime_config.get("blank_id") != CTC_BLANK_ID
    ):
        raise SystemExit("Checkpoint does not name the CTC runtime contract.")
    return CTCTransformerDimensions(
        input_vocab_size=input_vocab_size,
        output_class_count=output_class_count,
        max_input_length=int(runtime_config["max_input_len"]),
        output_time_steps=int(runtime_config["output_time_steps"]),
        model_dimension=int(runtime_config["model_dimension"]),
        attention_heads=int(runtime_config["attention_heads"]),
        feed_forward_dimension=int(
            runtime_config["feed_forward_dimension"]
        ),
        encoder_layers=int(runtime_config["layers"]),
        dropout=float(runtime_config["dropout"]),
        padding_id=0,
    )


def checkpoint_runtime_config(
    args: argparse.Namespace,
) -> dict[str, Any]:
    return {
        "model_id": args.model_id,
        "architecture_family": args.architecture_family,
        "runtime_model_contract": args.runtime_model_contract,
        "model_dimension": args.model_dimension,
        "attention_heads": args.attention_heads,
        "feed_forward_dimension": args.feed_forward_dimension,
        "layers": args.layers,
        "dropout": args.dropout,
        "max_input_len": args.max_input_len,
        "output_time_steps": args.output_time_steps,
        "blank_id": CTC_BLANK_ID,
        "beam_width": args.beam_width,
        "maximum_candidates": args.maximum_candidates,
    }


def build_model_from_runtime_config(
    input_vocab_size: int,
    output_class_count: int,
    runtime_config: dict[str, Any],
) -> CTCTransformer:
    return CTCTransformer(
        dimensions_from_runtime_config(
            input_vocab_size,
            output_class_count,
            runtime_config,
        )
    )


def load_model_from_checkpoint_payload(
    checkpoint: dict[str, Any],
) -> CTCTransformer:
    input_vocab = checkpoint.get("inputVocab")
    output_vocab = checkpoint.get("outputVocab")
    state_dict = checkpoint.get("stateDict")
    runtime_config = checkpoint.get("config")
    if (
        not isinstance(input_vocab, dict)
        or not isinstance(output_vocab, dict)
        or not isinstance(state_dict, dict)
        or not isinstance(runtime_config, dict)
        or checkpoint.get("modelId") != MODEL_ID
    ):
        raise SystemExit("CTC checkpoint model payload is invalid.")
    model = build_model_from_runtime_config(
        len(input_vocab),
        len(output_vocab),
        runtime_config,
    )
    try:
        model.load_state_dict(state_dict)
    except RuntimeError as error:
        raise SystemExit(
            "CTC state dictionary differs from its runtime config."
        ) from error
    return model


def decode_ctc_logits(
    logits: np.ndarray,
    output_vocab: dict[str, int],
    *,
    beam_width: int,
    maximum_candidates: int,
) -> list[str]:
    reverse = tokens_by_id(output_vocab)
    if not reverse or reverse[CTC_BLANK_ID] != CTC_BLANK:
        raise ValueError("CTC output vocabulary has no blank class at zero.")

    def prefix_text(prefix: tuple[int, ...]) -> str:
        return "".join(reverse[token_id] for token_id in prefix)

    token_sequences = ctc_prefix_beam_search(
        logits,
        beam_width=beam_width,
        maximum_candidates=maximum_candidates,
        blank_id=CTC_BLANK_ID,
        prefix_permitted=lambda prefix, token_id: (
            0 < token_id < len(reverse)
            and is_valid_output_scalar(reverse[token_id])
            and analyze_devanagari_output_sequence(
                prefix_text(prefix) + reverse[token_id]
            )["validPrefix"]
        ),
        sequence_permitted=lambda prefix: (
            analyze_devanagari_output_sequence(prefix_text(prefix))[
                "terminable"
            ]
        ),
    )
    candidates = []
    for token_ids in token_sequences:
        candidate = "".join(reverse[token_id] for token_id in token_ids)
        if (
            candidate
            and not contains_ascii_latin(candidate)
            and not any(character.isspace() for character in candidate)
            and candidate not in candidates
        ):
            candidates.append(candidate)
    return candidates[:maximum_candidates]


def learning_rate_for_step(
    step: int,
    *,
    peak_learning_rate: float,
    warmup_steps: int,
) -> float:
    if step < 1 or warmup_steps < 1 or peak_learning_rate <= 0:
        raise ValueError("Learning-rate schedule inputs are invalid.")
    if step <= warmup_steps:
        scale = step / warmup_steps
    else:
        scale = math.sqrt(warmup_steps / step)
    return peak_learning_rate * scale


def build_optimizer(
    model: nn.Module,
    args: argparse.Namespace,
) -> torch.optim.AdamW:
    return torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate / args.warmup_steps,
        betas=(args.optimizer_beta1, args.optimizer_beta2),
        eps=args.optimizer_epsilon,
        weight_decay=args.weight_decay,
    )


def set_optimizer_learning_rate(
    optimizer: torch.optim.Optimizer,
    learning_rate: float,
) -> None:
    for group in optimizer.param_groups:
        group["lr"] = learning_rate


def prepare_training_data(
    args: argparse.Namespace,
) -> dict[str, Any]:
    train_base, dev_rows, manifest = load_base_rows(args)
    blocked = held_out_inputs(args)
    train_augmented, augmentation = augment_training_rows(
        train_base,
        args.augmentation_config["aliases"],
        blocked_inputs=blocked,
        max_input_len=args.max_input_len,
    )
    train_rows = apply_source_multipliers(
        train_augmented,
        args.source_multipliers,
    )
    # Source multipliers are a training intervention. Development retains the
    # dataset's original row weights so early stopping measures an unbiased
    # held-out distribution.
    dev_weighted = copy.deepcopy(dev_rows)
    input_vocab = build_input_vocab(train_rows)
    output_vocab = build_output_vocab(train_rows)
    missing_dev_output_scalars = sorted({
        scalar
        for row in dev_weighted
        for scalar in LEGACY.output_scalars(row["target"])
        if scalar not in output_vocab
    })
    if missing_dev_output_scalars:
        raise SystemExit(
            "Development targets contain output scalars absent from the "
            "training vocabulary."
        )
    return {
        "trainRows": train_rows,
        "devRows": dev_weighted,
        "datasetManifest": manifest,
        "inputVocab": input_vocab,
        "outputVocab": output_vocab,
        "augmentation": augmentation,
    }


TRAINING_RECOVERY_SCHEMA_VERSION = 3


def training_recovery_identity(
    args: argparse.Namespace,
    run_input_snapshot: dict[str, Any],
    data: dict[str, Any],
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
        "inputVocabSha256": sha256_json(data["inputVocab"]),
        "outputVocabSha256": sha256_json(data["outputVocab"]),
        "sampledRowDigests": {
            "train": sampled_rows_sha256(data["trainRows"]),
            "dev": sampled_rows_sha256(data["devRows"]),
        },
        "augmentation": copy.deepcopy(data["augmentation"]),
    }


def clear_training_recovery(args: argparse.Namespace) -> None:
    LEGACY.clear_training_recovery(args)


def load_training_recovery_payload(
    state_path: Path,
) -> dict[str, Any]:
    state_bytes = state_path.stat().st_size
    if not 1 <= state_bytes <= LEGACY.MAX_TRAINING_RECOVERY_BYTES:
        raise SystemExit(
            "CTC recovery is empty or exceeds the 512 MiB safety limit."
        )
    try:
        with open_regular_binary(
            state_path,
            "CTC training recovery",
        ) as handle:
            recovery = torch.load(
                handle,
                map_location="cpu",
                weights_only=True,
            )
    except Exception as error:
        raise SystemExit(
            "CTC recovery failed safe tensor-only loading."
        ) from error
    if not isinstance(recovery, dict):
        raise SystemExit("CTC recovery payload must be an object.")
    return recovery


def valid_recovery_cuda_rng_states(
    args: argparse.Namespace,
    recovery: dict[str, Any],
) -> bool:
    states = recovery.get("cudaRngStates")
    if not isinstance(states, list) or not all(
        isinstance(value, torch.Tensor)
        and value.device.type == "cpu"
        and value.dtype == torch.uint8
        and value.ndim == 1
        for value in states
    ):
        return False
    if args.resolved_training_device == "cuda":
        return len(states) == torch.cuda.device_count()
    return len(states) == 0


def valid_recovery_epoch_metrics(
    recovery: dict[str, Any],
) -> bool:
    metrics = recovery.get("epochMetrics")
    train_losses = recovery.get("trainLosses")
    if not isinstance(metrics, list) or not isinstance(train_losses, list):
        return False
    required = {
        "best",
        "devWeightedCTCLoss",
        "epoch",
        "globalStep",
        "learningRate",
        "trainWeightedCTCLoss",
    }
    for index, metric in enumerate(metrics):
        if not isinstance(metric, dict) or set(metric) != required:
            return False
        if type(metric["epoch"]) is not int or metric["epoch"] != index + 1:
            return False
        if type(metric["globalStep"]) is not int or metric["globalStep"] < 1:
            return False
        if not isinstance(metric["best"], bool):
            return False
        for field in (
            "devWeightedCTCLoss",
            "learningRate",
            "trainWeightedCTCLoss",
        ):
            value = metric[field]
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(float(value))
            ):
                return False
        if float(train_losses[index]) != float(
            metric["trainWeightedCTCLoss"]
        ):
            return False
    best_epoch = recovery.get("bestEpoch")
    best_loss = recovery.get("bestDevWeightedCTCLoss")
    return (
        type(best_epoch) is int
        and 1 <= best_epoch <= len(metrics)
        and isinstance(best_loss, (int, float))
        and not isinstance(best_loss, bool)
        and math.isfinite(float(best_loss))
        and metrics[best_epoch - 1]["best"] is True
        and float(metrics[best_epoch - 1]["devWeightedCTCLoss"])
            == float(best_loss)
    )


def save_training_recovery(
    args: argparse.Namespace,
    *,
    identity: dict[str, Any],
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    training_generator: torch.Generator,
    completed_epoch: int,
    global_step: int,
    train_losses: list[float],
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
    if (
        completed_epoch < 1
        or global_step < completed_epoch
        or len(train_losses) != completed_epoch
        or len(epoch_metrics) != completed_epoch
        or not math.isfinite(best_dev_loss)
    ):
        raise ValueError("CTC recovery progress is inconsistent.")
    assert_run_input_snapshot_unchanged(args)
    state_path = training_recovery_state_path(
        args,
        args.export_run_id,
        completed_epoch,
    )
    if state_path.exists() or state_path.is_symlink():
        raise SystemExit(
            f"CTC recovery generation unexpectedly exists: {state_path}"
        )
    staging = staging_sibling(state_path, "staging")
    payload = {
        "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "createdByExportRunId": args.export_run_id,
        "identity": identity,
        "identitySha256": sha256_json(identity),
        "completedEpoch": completed_epoch,
        "globalStep": global_step,
        "modelState": {
            name: value.detach().cpu().clone()
            for name, value in model.state_dict().items()
        },
        "optimizerState": optimizer.state_dict(),
        "trainingGeneratorState":
            training_generator.get_state().detach().cpu().clone(),
        "torchRngState": torch.get_rng_state().detach().cpu().clone(),
        "cudaRngStates": [
            value.detach().cpu().clone()
            for value in torch.cuda.get_rng_state_all()
        ] if args.resolved_training_device == "cuda" else [],
        "trainLosses": list(train_losses),
        "epochMetrics": copy.deepcopy(epoch_metrics),
        "bestState": {
            name: value.detach().cpu().clone()
            for name, value in best_state.items()
        },
        "bestDevWeightedCTCLoss": best_dev_loss,
        "bestEpoch": best_epoch,
        "epochsWithoutImprovement": epochs_without_improvement,
        "stoppedEarly": stopped_early,
        "trainingDurationSeconds": training_duration_seconds,
        "resumeCount": resume_count,
        "exportRunIds": list(export_run_ids),
    }
    try:
        with staging.open("xb") as handle:
            torch.save(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        if staging.stat().st_size > LEGACY.MAX_TRAINING_RECOVERY_BYTES:
            raise SystemExit("CTC recovery exceeds the 512 MiB limit.")
        os.replace(staging, state_path)
    finally:
        staging.unlink(missing_ok=True)
    metadata = {
        "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
        "status": "recoverable-incomplete-training",
        "updatedAt": iso_now(),
        "stateFile": state_path.name,
        "stateSha256": sha256_file(state_path),
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
    recovery: dict[str, Any] | None = None
    recovered_orphan = False
    if not metadata_path.exists():
        if len(states) > 1:
            raise SystemExit(
                "Multiple orphaned CTC recoveries exist; use "
                "--restart-training to discard them."
            )
        if not states:
            return None
        state_path = states[0]
        recovery = load_training_recovery_payload(state_path)
        metadata = recovery_metadata_from_payload(state_path, recovery)
        recovered_orphan = True
    else:
        metadata = read_json(metadata_path)
    required_metadata = {
        "completedEpoch",
        "createdByExportRunId",
        "identitySha256",
        "modelId",
        "schemaVersion",
        "stateBytes",
        "stateFile",
        "stateSha256",
        "status",
        "trainingRunId",
        "updatedAt",
    }
    if set(metadata) != required_metadata:
        raise SystemExit("CTC recovery metadata has an unsupported schema.")
    state_name = metadata.get("stateFile")
    if (
        not isinstance(state_name, str)
        or not LEGACY.TRAINING_RECOVERY_STATE_PATTERN.fullmatch(state_name)
    ):
        raise SystemExit("CTC recovery points to an unsafe filename.")
    state_path = args.out_dir / state_name
    if state_path not in states:
        raise SystemExit("CTC recovery points to a missing state.")
    state_bytes = state_path.stat().st_size
    if (
        metadata.get("schemaVersion") != TRAINING_RECOVERY_SCHEMA_VERSION
        or metadata.get("status") != "recoverable-incomplete-training"
        or metadata.get("modelId") != args.model_id
        or metadata.get("stateBytes") != state_bytes
        or not 1 <= state_bytes <= LEGACY.MAX_TRAINING_RECOVERY_BYTES
        or metadata.get("stateSha256") != sha256_file(state_path)
        or metadata.get("identitySha256") != sha256_json(identity)
    ):
        raise SystemExit("CTC recovery metadata is stale or corrupt.")
    if recovery is None:
        recovery = load_training_recovery_payload(state_path)
    required_payload = {
        "bestDevWeightedCTCLoss",
        "bestEpoch",
        "bestState",
        "completedEpoch",
        "createdByExportRunId",
        "cudaRngStates",
        "epochMetrics",
        "epochsWithoutImprovement",
        "exportRunIds",
        "globalStep",
        "identity",
        "identitySha256",
        "modelId",
        "modelState",
        "optimizerState",
        "resumeCount",
        "schemaVersion",
        "stoppedEarly",
        "torchRngState",
        "trainLosses",
        "trainingDurationSeconds",
        "trainingGeneratorState",
        "trainingRunId",
    }
    if set(recovery) != required_payload:
        raise SystemExit("CTC recovery payload has an unsupported schema.")
    completed_epoch = recovery.get("completedEpoch")
    if (
        recovery.get("schemaVersion") != TRAINING_RECOVERY_SCHEMA_VERSION
        or recovery.get("modelId") != args.model_id
        or recovery.get("identity") != identity
        or recovery.get("identitySha256") != sha256_json(identity)
        or recovery.get("identitySha256") != metadata["identitySha256"]
        or not is_run_identifier(recovery.get("trainingRunId"))
        or not is_run_identifier(recovery.get("createdByExportRunId"))
        or recovery.get("trainingRunId") != metadata["trainingRunId"]
        or recovery.get("createdByExportRunId")
            != metadata["createdByExportRunId"]
        or completed_epoch != metadata["completedEpoch"]
        or type(completed_epoch) is not int
        or not 1 <= completed_epoch <= args.epochs
        or state_path.name != training_recovery_state_path(
            args,
            recovery["createdByExportRunId"],
            completed_epoch,
        ).name
    ):
        raise SystemExit("CTC recovery identity is stale or corrupt.")
    if (
        type(recovery.get("globalStep")) is not int
        or recovery["globalStep"] < completed_epoch
        or not isinstance(recovery.get("trainLosses"), list)
        or len(recovery["trainLosses"]) != completed_epoch
        or any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            for value in recovery["trainLosses"]
        )
        or type(recovery.get("epochsWithoutImprovement")) is not int
        or recovery["epochsWithoutImprovement"] < 0
        or not isinstance(recovery.get("stoppedEarly"), bool)
        or not isinstance(
            recovery.get("trainingDurationSeconds"),
            (int, float),
        )
        or not math.isfinite(float(recovery["trainingDurationSeconds"]))
        or recovery["trainingDurationSeconds"] < 0
        or type(recovery.get("resumeCount")) is not int
        or recovery["resumeCount"] < 0
        or not isinstance(recovery.get("exportRunIds"), list)
        or not all(
            is_run_identifier(value)
            for value in recovery["exportRunIds"]
        )
        or len(set(recovery["exportRunIds"]))
            != len(recovery["exportRunIds"])
        or len(recovery["exportRunIds"]) != recovery["resumeCount"] + 1
        or recovery["exportRunIds"][-1]
            != recovery["createdByExportRunId"]
        or not valid_recovery_epoch_metrics(recovery)
        or not valid_recovery_cuda_rng_states(args, recovery)
    ):
        raise SystemExit("CTC recovery progress metadata is invalid.")
    try:
        model.load_state_dict(recovery["modelState"])
        optimizer.load_state_dict(recovery["optimizerState"])
        training_generator.set_state(recovery["trainingGeneratorState"])
        torch.set_rng_state(recovery["torchRngState"])
        if args.resolved_training_device == "cuda":
            torch.cuda.set_rng_state_all(recovery["cudaRngStates"])
    except (KeyError, RuntimeError, TypeError, ValueError) as error:
        raise SystemExit("CTC recovery tensor state is incompatible.") from error
    best_state = recovery.get("bestState")
    if not isinstance(best_state, dict) or set(best_state) != set(
        model.state_dict()
    ):
        raise SystemExit("CTC recovery best-state inventory is invalid.")
    args.training_run_id = recovery["trainingRunId"]
    if recovered_orphan:
        write_json(metadata_path, metadata)
        print(json.dumps({
            "status": "recovered-orphaned-ctc-training-pointer",
            "trainingRunId": args.training_run_id,
            "completedEpoch": completed_epoch,
        }, ensure_ascii=False), flush=True)
    for obsolete in states:
        if obsolete != state_path:
            obsolete.unlink()
    print(json.dumps({
        "status": "resumed-ctc-training-recovery",
        "trainingRunId": args.training_run_id,
        "completedEpoch": completed_epoch,
        "resumeCount": recovery["resumeCount"] + 1,
    }, ensure_ascii=False), flush=True)
    return recovery


def recovery_metadata_from_payload(
    state_path: Path,
    recovery: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": TRAINING_RECOVERY_SCHEMA_VERSION,
        "status": "recoverable-incomplete-training",
        "updatedAt": iso_now(),
        "stateFile": state_path.name,
        "stateSha256": sha256_file(state_path),
        "stateBytes": state_path.stat().st_size,
        "modelId": recovery.get("modelId"),
        "trainingRunId": recovery.get("trainingRunId"),
        "createdByExportRunId": recovery.get("createdByExportRunId"),
        "completedEpoch": recovery.get("completedEpoch"),
        "identitySha256": recovery.get("identitySha256"),
    }


@torch.no_grad()
def evaluate_weighted_ctc_loss(
    model: CTCTransformer,
    loader: DataLoader,
    device: torch.device,
) -> float:
    model.eval()
    numerator = 0.0
    denominator = 0.0
    for sources, targets, target_lengths, weights in loader:
        sources = sources.to(device)
        logits = model(sources)
        _loss, batch_numerator, batch_denominator = weighted_ctc_loss(
            logits,
            targets,
            target_lengths,
            weights,
        )
        numerator += float(batch_numerator.cpu())
        denominator += float(batch_denominator.cpu())
    result = numerator / max(denominator, 1.0)
    if not math.isfinite(result):
        raise SystemExit("Development weighted CTC loss became non-finite.")
    return result


@torch.no_grad()
def evaluate_model(
    model: CTCTransformer,
    rows: list[dict[str, Any]],
    input_vocab: dict[str, int],
    output_vocab: dict[str, int],
    args: argparse.Namespace,
) -> dict[str, Any]:
    model.eval().to("cpu")
    sample = LEGACY.deterministic_source_sample(
        rows,
        min(len(rows), 800),
        args.seed + 2,
        "ctc-internal-evaluation",
    )
    top1 = 0
    top3 = 0
    batch_size = min(args.batch_size, 128)
    for start in range(0, len(sample), batch_size):
        chunk = sample[start : start + batch_size]
        sources = torch.tensor(
            [
                encode_input(
                    row["input"],
                    input_vocab,
                    args.max_input_len,
                )
                for row in chunk
            ],
            dtype=torch.int32,
        )
        logits = model(sources).detach().cpu().numpy()
        for row, row_logits in zip(chunk, logits):
            candidates = decode_ctc_logits(
                row_logits,
                output_vocab,
                beam_width=args.beam_width,
                maximum_candidates=args.maximum_candidates,
            )
            expected = set(row["acceptable"])
            top1 += bool(candidates and candidates[0] in expected)
            top3 += bool(expected.intersection(candidates[:3]))
    count = len(sample)
    return {
        "sampleRows": count,
        "top1Accuracy": top1 / count if count else 0,
        "top3Accuracy": top3 / count if count else 0,
    }


def write_vocab_metadata(
    input_vocab: dict[str, int],
    output_vocab: dict[str, int],
    args: argparse.Namespace,
) -> None:
    snapshot = ensure_run_input_snapshot(args)
    payload = {
        "schemaVersion": 2,
        "modelId": args.model_id,
        "generatedAt": iso_now(),
        "tokenization": OUTPUT_TOKENIZATION,
        "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
        "input": {
            "maxLength": args.max_input_len,
            "tokensById": tokens_by_id(input_vocab),
            "idsByToken": input_vocab,
            "padId": input_vocab[PAD],
            "eosId": input_vocab[EOS],
            "unkId": input_vocab[UNK],
        },
        "output": {
            "timeSteps": args.output_time_steps,
            "tokensById": tokens_by_id(output_vocab),
            "idsByToken": output_vocab,
            "blankId": output_vocab[CTC_BLANK],
        },
        "decoder": {
            "type": "ctc-prefix-beam-search",
            "beamWidth": args.beam_width,
            "maximumCandidates": args.maximum_candidates,
            "outputSequenceValidation": OUTPUT_SEQUENCE_VALIDATION,
            "rejectWhitespaceCandidates": True,
            "rejectLatinCandidates": True,
        },
        "dataset": {
            "manifest": rel(args.dataset_manifest),
            "manifestSha256": snapshot["dataset"]["manifestSha256"],
            "splitSha256": {
                split: evidence["sha256"]
                for split, evidence in snapshot["dataset"]["splits"].items()
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


def train_model(args: argparse.Namespace) -> dict[str, Any]:
    snapshot = ensure_run_input_snapshot(args)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.restart_training:
        clear_training_recovery(args)
    if args.training_run_id is None:
        args.training_run_id = uuid.uuid4().hex
    if not is_run_identifier(args.training_run_id):
        raise SystemExit("CTC training run id is invalid.")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.use_deterministic_algorithms(True)
    data = prepare_training_data(args)
    train_rows = data["trainRows"]
    dev_rows = data["devRows"]
    if not train_rows or not dev_rows:
        raise SystemExit("CTC training and development selections are required.")
    input_vocab = data["inputVocab"]
    output_vocab = data["outputVocab"]
    model = build_model_from_runtime_config(
        len(input_vocab),
        len(output_vocab),
        checkpoint_runtime_config(args),
    )
    parameter_count = sum(
        parameter.numel() for parameter in model.parameters()
    )
    architecture = args.training_config["architecture"]
    if not (
        int(architecture["minimumParameterCount"])
        <= parameter_count
        <= int(architecture["maximumParameterCount"])
    ):
        raise SystemExit("CTC parameter count is outside the product envelope.")
    device = device_for_training(args)
    model.to(device)
    training_generator = torch.Generator()
    training_generator.manual_seed(args.seed)
    train_loader = DataLoader(
        CTCTransliterationDataset(
            train_rows,
            input_vocab,
            output_vocab,
            args.max_input_len,
            args.output_time_steps,
        ),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
        generator=training_generator,
        collate_fn=collate_ctc_batch,
        pin_memory=device.type == "cuda",
    )
    dev_loader = DataLoader(
        CTCTransliterationDataset(
            dev_rows,
            input_vocab,
            output_vocab,
            args.max_input_len,
            args.output_time_steps,
        ),
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=0,
        collate_fn=collate_ctc_batch,
        pin_memory=device.type == "cuda",
    )
    optimizer = build_optimizer(model, args)
    recovery_identity = training_recovery_identity(args, snapshot, data)
    recovery = load_training_recovery(
        args,
        identity=recovery_identity,
        model=model,
        optimizer=optimizer,
        training_generator=training_generator,
    )
    if recovery:
        train_losses = [
            float(value) for value in recovery["trainLosses"]
        ]
        epoch_metrics = copy.deepcopy(recovery["epochMetrics"])
        best_state = {
            name: value.detach().cpu().clone()
            for name, value in recovery["bestState"].items()
        }
        best_dev_loss = float(recovery["bestDevWeightedCTCLoss"])
        best_epoch = int(recovery["bestEpoch"])
        epochs_without_improvement = int(
            recovery["epochsWithoutImprovement"]
        )
        stopped_early = bool(recovery["stoppedEarly"])
        first_epoch = int(recovery["completedEpoch"])
        global_step = int(recovery["globalStep"])
        prior_duration = float(recovery["trainingDurationSeconds"])
        resume_count = int(recovery["resumeCount"]) + 1
        export_run_ids = list(recovery["exportRunIds"])
        if args.export_run_id not in export_run_ids:
            export_run_ids.append(args.export_run_id)
        resumed_from_epoch: int | None = first_epoch
    else:
        train_losses = []
        epoch_metrics = []
        best_state: dict[str, torch.Tensor] | None = None
        best_dev_loss = math.inf
        best_epoch = 0
        epochs_without_improvement = 0
        stopped_early = False
        first_epoch = 0
        global_step = 0
        prior_duration = 0.0
        resume_count = 0
        export_run_ids = [args.export_run_id]
        resumed_from_epoch = None
    segment_started = time.perf_counter()
    for epoch_index in range(first_epoch, args.epochs):
        if stopped_early:
            break
        model.train()
        epoch_numerator = 0.0
        epoch_denominator = 0.0
        for sources, targets, target_lengths, weights in train_loader:
            global_step += 1
            current_learning_rate = learning_rate_for_step(
                global_step,
                peak_learning_rate=args.learning_rate,
                warmup_steps=args.warmup_steps,
            )
            set_optimizer_learning_rate(optimizer, current_learning_rate)
            sources = sources.to(device)
            logits = model(sources)
            loss, batch_numerator, batch_denominator = weighted_ctc_loss(
                logits,
                targets,
                target_lengths,
                weights,
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                model.parameters(),
                args.gradient_clip_norm,
            )
            optimizer.step()
            epoch_numerator += float(batch_numerator.cpu())
            epoch_denominator += float(batch_denominator.cpu())
        train_loss = epoch_numerator / max(epoch_denominator, 1.0)
        if not math.isfinite(train_loss):
            raise SystemExit("Training weighted CTC loss became non-finite.")
        dev_loss = evaluate_weighted_ctc_loss(model, dev_loader, device)
        train_losses.append(train_loss)
        improved = (
            dev_loss < best_dev_loss - args.early_stopping_min_delta
        )
        if improved:
            best_dev_loss = dev_loss
            best_epoch = epoch_index + 1
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
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
            "epoch": epoch_index + 1,
            "trainWeightedCTCLoss": train_loss,
            "devWeightedCTCLoss": dev_loss,
            "learningRate": learning_rate_for_step(
                global_step,
                peak_learning_rate=args.learning_rate,
                warmup_steps=args.warmup_steps,
            ),
            "globalStep": global_step,
            "best": improved,
        }
        epoch_metrics.append(epoch_result)
        print(json.dumps(epoch_result, ensure_ascii=False), flush=True)
        if best_state is None:
            raise SystemExit("CTC epoch completed without a best checkpoint.")
        recovery_path = save_training_recovery(
            args,
            identity=recovery_identity,
            model=model,
            optimizer=optimizer,
            training_generator=training_generator,
            completed_epoch=epoch_index + 1,
            global_step=global_step,
            train_losses=train_losses,
            epoch_metrics=epoch_metrics,
            best_state=best_state,
            best_dev_loss=best_dev_loss,
            best_epoch=best_epoch,
            epochs_without_improvement=epochs_without_improvement,
            stopped_early=stopped_early,
            training_duration_seconds=(
                prior_duration + time.perf_counter() - segment_started
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
        raise SystemExit("CTC training produced no finite best checkpoint.")
    if args.restore_best_weights:
        model.load_state_dict(best_state)
    evaluation = evaluate_model(
        model,
        dev_rows,
        input_vocab,
        output_vocab,
        args,
    )
    duration = prior_duration + time.perf_counter() - segment_started
    assert_run_input_snapshot_unchanged(args)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    write_vocab_metadata(input_vocab, output_vocab, args)
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
        "effectiveTrainingConfigCanonicalJson":
            args.effective_training_config_canonical_json,
        "effectiveTrainingConfigSha256":
            args.effective_training_config_sha256,
        "trainingOverrides": args.training_overrides,
        "configuredArtifactInputs": args.configured_artifact_inputs,
        "effectiveArtifactInputs": args.effective_artifact_inputs,
        "effectiveArtifactInputsCanonicalJson":
            args.effective_artifact_inputs_canonical_json,
        "effectiveArtifactInputsSha256":
            args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "runInputSnapshot": snapshot,
        "trainerSha256": snapshot["trainer"]["sha256"],
        "vocabMetadataSha256": sha256_file(args.vocab_metadata),
        "datasetManifestSha256": snapshot["dataset"]["manifestSha256"],
        "datasetContentSha256": snapshot["dataset"]["contentSha256"],
        "datasetSplitSha256": {
            split: evidence["sha256"]
            for split, evidence in snapshot["dataset"]["splits"].items()
        },
        "parameterCount": parameter_count,
        "baseTrainingRows": data["augmentation"]["baseRows"],
        "trainingRows": len(train_rows),
        "devRows": len(dev_rows),
        "trainingSourceCounts": source_summary(train_rows),
        "devSourceCounts": source_summary(dev_rows),
        "trainingSourceWeightMass": source_weight_mass(train_rows),
        "devSourceWeightMass": source_weight_mass(dev_rows),
        "augmentation": data["augmentation"],
        "trainLosses": train_losses,
        "epochMetrics": epoch_metrics,
        "globalStep": global_step,
        "bestEpoch": best_epoch,
        "bestDevWeightedCTCLoss": best_dev_loss,
        "stoppedEarly": stopped_early,
        "trainingRecovery": recovery_summary,
        "sampledRowDigests": {
            "train": sampled_rows_sha256(train_rows),
            "dev": sampled_rows_sha256(dev_rows),
        },
        "evaluation": evaluation,
    }
    target = checkpoint_path(args)
    staging = staging_sibling(target, "staging")
    try:
        with staging.open("xb") as handle:
            torch.save(checkpoint, handle)
            handle.flush()
            os.fsync(handle.fileno())
        assert_run_input_snapshot_unchanged(args)
        os.replace(staging, target)
    finally:
        staging.unlink(missing_ok=True)
    checkpoint_sha256 = sha256_file(target)
    report = {
        "generatedAt": iso_now(),
        "command": "python scripts/train-open-vocab-ctc-transformer.py",
        "status": "passed-training-checkpoint",
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "trainingComplete": True,
        "trainingExecutionModes": args.execution_modes,
        "durationMs": round(duration * 1_000),
        "device": str(device),
        "lossComputationDevice": "cpu-for-deterministic-backward",
        "trainingConfig": rel(args.config),
        "trainingContractSha256": args.training_contract_sha256,
        "configuredTrainingConfig": args.configured_training_config,
        "effectiveTrainingConfig": args.effective_training_config,
        "effectiveTrainingConfigCanonicalJson":
            args.effective_training_config_canonical_json,
        "effectiveTrainingConfigSha256":
            args.effective_training_config_sha256,
        "trainingOverrides": args.training_overrides,
        "configuredArtifactInputs": args.configured_artifact_inputs,
        "effectiveArtifactInputs": args.effective_artifact_inputs,
        "effectiveArtifactInputsCanonicalJson":
            args.effective_artifact_inputs_canonical_json,
        "effectiveArtifactInputsSha256":
            args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "runInputSnapshot": snapshot,
        "trainerSha256": checkpoint["trainerSha256"],
        "vocabMetadataSha256": checkpoint["vocabMetadataSha256"],
        "inputDatasetManifest": rel(args.dataset_manifest),
        "inputDatasetManifestSha256":
            checkpoint["datasetManifestSha256"],
        "inputDatasetContentSha256":
            checkpoint["datasetContentSha256"],
        "inputDatasetSplitSha256": checkpoint["datasetSplitSha256"],
        "checkpoint": rel(target),
        "checkpointSha256": checkpoint_sha256,
        "parameterCount": parameter_count,
        "baseTrainingRows": checkpoint["baseTrainingRows"],
        "trainingRows": len(train_rows),
        "devRows": len(dev_rows),
        "trainingSourceCounts": checkpoint["trainingSourceCounts"],
        "devSourceCounts": checkpoint["devSourceCounts"],
        "trainingSourceWeightMass":
            checkpoint["trainingSourceWeightMass"],
        "devSourceWeightMass": checkpoint["devSourceWeightMass"],
        "augmentation": checkpoint["augmentation"],
        "sampledRowDigests": checkpoint["sampledRowDigests"],
        "trainLosses": train_losses,
        "epochMetrics": epoch_metrics,
        "globalStep": global_step,
        "bestEpoch": best_epoch,
        "bestDevWeightedCTCLoss": best_dev_loss,
        "stoppedEarly": stopped_early,
        "trainingRecovery": recovery_summary,
        "earlyStopping": {
            "enabled": args.early_stopping_enabled,
            "metric": args.early_stopping_metric,
            "patienceEpochs": args.early_stopping_patience,
            "minimumDelta": args.early_stopping_min_delta,
            "restoreBestWeights": args.restore_best_weights,
            "bestEpoch": best_epoch,
            "bestDevWeightedCTCLoss": best_dev_loss,
            "stoppedEarly": stopped_early,
            "epochsCompleted": len(epoch_metrics),
        },
        "evaluation": evaluation,
        "datasetRows": data["datasetManifest"].get("totalRows"),
        "productionEligible": False,
        "candidateLimitations": candidate_limitations(),
    }
    assert_run_input_snapshot_unchanged(args)
    write_json(training_report_path(args), report)
    clear_training_recovery(args)
    return {
        "model": model.cpu(),
        "checkpoint": checkpoint,
        "report": report,
    }


def load_checkpoint(args: argparse.Namespace) -> dict[str, Any]:
    snapshot = ensure_run_input_snapshot(args)
    current_checkpoint = checkpoint_path(args)
    current_report = training_report_path(args)
    if not current_checkpoint.is_file() or not current_report.is_file():
        raise SystemExit("CTC checkpoint/report is missing.")
    report = read_json(current_report)
    if report.get("checkpointSha256") != sha256_file(current_checkpoint):
        raise SystemExit("CTC report checkpoint digest is stale.")
    try:
        with open_regular_binary(
            current_checkpoint,
            "CTC checkpoint",
        ) as handle:
            checkpoint = torch.load(
                handle,
                map_location="cpu",
                weights_only=True,
            )
    except Exception as error:
        raise SystemExit(
            "CTC checkpoint failed safe tensor-only loading."
        ) from error
    required = {
        "artifactOverrides",
        "configuredArtifactInputs",
        "configuredTrainingConfig",
        "effectiveArtifactInputs",
        "effectiveArtifactInputsCanonicalJson",
        "effectiveArtifactInputsSha256",
        "effectiveTrainingConfig",
        "effectiveTrainingConfigCanonicalJson",
        "effectiveTrainingConfigSha256",
        "runInputSnapshot",
        "sampledRowDigests",
        "trainerSha256",
        "trainingContractSha256",
        "trainingOverrides",
        "vocabMetadataSha256",
    }
    if (
        not isinstance(checkpoint, dict)
        or checkpoint.get("modelId") != args.model_id
        or not is_run_identifier(checkpoint.get("trainingRunId"))
        or not required.issubset(checkpoint)
    ):
        raise SystemExit("CTC checkpoint provenance is incomplete.")
    args.training_run_id = checkpoint["trainingRunId"]
    comparisons = {
        "trainingContractSha256": args.training_contract_sha256,
        "configuredTrainingConfig": args.configured_training_config,
        "effectiveTrainingConfig": args.effective_training_config,
        "effectiveTrainingConfigCanonicalJson":
            args.effective_training_config_canonical_json,
        "effectiveTrainingConfigSha256":
            args.effective_training_config_sha256,
        "trainingOverrides": args.training_overrides,
        "configuredArtifactInputs": args.configured_artifact_inputs,
        "effectiveArtifactInputs": args.effective_artifact_inputs,
        "effectiveArtifactInputsCanonicalJson":
            args.effective_artifact_inputs_canonical_json,
        "effectiveArtifactInputsSha256":
            args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
    }
    for field, expected in comparisons.items():
        if checkpoint.get(field) != expected:
            raise SystemExit(
                f"CTC checkpoint differs from effective contract: {field}."
            )
    if not run_input_snapshots_share_immutable_inputs(
        checkpoint["runInputSnapshot"],
        snapshot,
    ):
        raise SystemExit("CTC checkpoint immutable inputs have changed.")
    if checkpoint["trainerSha256"] != sha256_file(Path(__file__)):
        raise SystemExit("CTC checkpoint trainer digest is stale.")
    if (
        not args.vocab_metadata.is_file()
        or checkpoint["vocabMetadataSha256"]
            != sha256_file(args.vocab_metadata)
    ):
        raise SystemExit("CTC vocabulary artifact is missing or stale.")
    model = load_model_from_checkpoint_payload(checkpoint)
    model.eval()
    validate_checkpoint_runtime_bindings(args, checkpoint, model)
    for field in required:
        if report.get(field) != checkpoint.get(field):
            raise SystemExit(
                f"CTC report/checkpoint provenance differs: {field}."
            )
    for field in (
        "augmentation",
        "baseTrainingRows",
        "bestDevWeightedCTCLoss",
        "bestEpoch",
        "devRows",
        "devSourceCounts",
        "devSourceWeightMass",
        "globalStep",
        "parameterCount",
        "trainingRows",
        "trainingSourceCounts",
        "trainingSourceWeightMass",
    ):
        if report.get(field) != checkpoint.get(field):
            raise SystemExit(
                f"CTC report/checkpoint metadata differs: {field}."
            )
    return {
        "model": model,
        "checkpoint": checkpoint,
        "report": report,
    }


def validate_checkpoint_runtime_bindings(
    args: argparse.Namespace,
    checkpoint: dict[str, Any],
    model: nn.Module,
) -> None:
    if checkpoint.get("config") != checkpoint_runtime_config(args):
        raise SystemExit("CTC checkpoint runtime dimensions are stale.")
    if checkpoint.get("parameterCount") != sum(
        parameter.numel() for parameter in model.parameters()
    ):
        raise SystemExit("CTC checkpoint parameter count is stale.")
    vocabulary = read_json(args.vocab_metadata)
    input_vocab = checkpoint.get("inputVocab")
    output_vocab = checkpoint.get("outputVocab")
    if (
        vocabulary.get("schemaVersion") != 2
        or vocabulary.get("modelId") != MODEL_ID
        or vocabulary.get("runtimeModelContract")
            != RUNTIME_MODEL_CONTRACT
        or vocabulary.get("tokenization") != OUTPUT_TOKENIZATION
        or vocabulary.get("input", {}).get("idsByToken") != input_vocab
        or vocabulary.get("input", {}).get("tokensById")
            != tokens_by_id(input_vocab)
        or vocabulary.get("output", {}).get("idsByToken") != output_vocab
        or vocabulary.get("output", {}).get("tokensById")
            != tokens_by_id(output_vocab)
        or vocabulary.get("input", {}).get("padId")
            != input_vocab.get(PAD)
        or vocabulary.get("input", {}).get("eosId")
            != input_vocab.get(EOS)
        or vocabulary.get("input", {}).get("unkId")
            != input_vocab.get(UNK)
        or vocabulary.get("output", {}).get("blankId")
            != output_vocab.get(CTC_BLANK)
        or output_vocab.get(CTC_BLANK) != CTC_BLANK_ID
    ):
        raise SystemExit("CTC vocabulary does not bind the checkpoint.")
    lexical = [
        token
        for token in tokens_by_id(output_vocab)
        if token != CTC_BLANK
    ]
    if not lexical or not all(
        is_valid_output_scalar(token) for token in lexical
    ):
        raise SystemExit("CTC lexical vocabulary is invalid.")


class CompiledCTCCoreMLBackend:
    def __init__(
        self,
        model: Any,
        *,
        output_time_steps: int,
        output_class_count: int,
        compiled_sha256: str,
    ) -> None:
        self.model = model
        self.expected_shape = (
            1,
            output_time_steps,
            output_class_count,
        )
        self.compiled_sha256 = compiled_sha256

    def predict(self, input_ids: np.ndarray) -> np.ndarray:
        values = np.asarray(input_ids)
        if values.dtype != np.int32 or values.ndim != 2:
            raise SystemExit(
                "Compiled CTC Core ML input must be a rank-two INT32 array."
            )
        result = self.model.predict({"inputIds": values})
        if not isinstance(result, dict) or set(result) != {"logits"}:
            raise SystemExit(
                "Compiled CTC Core ML inference must return only logits."
            )
        logits = np.asarray(result["logits"])
        if (
            logits.shape != self.expected_shape
            or logits.dtype.kind != "f"
            or not np.isfinite(logits).all()
        ):
            raise SystemExit(
                "Compiled CTC Core ML logits violate the fixed tensor contract."
            )
        return logits


def convert_ctc_coreml_for_testing(
    model: CTCTransformer,
    *,
    max_input_len: int,
    minimum_deployment_target: Any,
) -> Any:
    if ct is None:
        raise RuntimeError(
            f"Core ML conversion is unavailable: {COREML_IMPORT_ERROR}"
        )
    if (
        not isinstance(model, CTCTransformer)
        or model.dimensions.max_input_length != max_input_len
    ):
        raise ValueError("CTC conversion model dimensions are inconsistent.")
    model = model.eval().to("cpu")
    example = torch.zeros((1, max_input_len), dtype=torch.int32)
    lexical_id = min(3, model.dimensions.input_vocab_size - 1)
    example[0, 0] = lexical_id
    traced = torch.jit.trace(model, example)
    return ct.convert(
        traced,
        convert_to="mlprogram",
        minimum_deployment_target=minimum_deployment_target,
        inputs=[
            ct.TensorType(
                name="inputIds",
                shape=tuple(example.shape),
                dtype=np.int32,
            ),
        ],
        outputs=[
            ct.TensorType(name="logits", dtype=np.float16),
        ],
    )


def ctc_coreml_tensor_contract(
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, dict[str, Any]]:
    return {
        "inputIds": {
            "shape": [1, args.max_input_len],
            "dataType": "INT32",
        },
        "logits": {
            "shape": [
                1,
                args.output_time_steps,
                len(checkpoint["outputVocab"]),
            ],
            "dataType": "FLOAT16",
        },
    }


def validate_ctc_coreml_feature_contract(
    coreml_model: Any,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, dict[str, Any]]:
    specification = coreml_model.get_spec()
    inputs = {
        feature.name: feature
        for feature in specification.description.input
    }
    outputs = {
        feature.name: feature
        for feature in specification.description.output
    }
    if set(inputs) != {"inputIds"} or set(outputs) != {"logits"}:
        raise SystemExit(
            "CTC Core ML feature names violate the native runtime contract."
        )
    expected = ctc_coreml_tensor_contract(checkpoint, args)
    int32_type = ct.proto.FeatureTypes_pb2.ArrayFeatureType.INT32
    float16_type = ct.proto.FeatureTypes_pb2.ArrayFeatureType.FLOAT16
    input_feature = inputs["inputIds"].type.multiArrayType
    output_feature = outputs["logits"].type.multiArrayType
    if (
        list(input_feature.shape) != expected["inputIds"]["shape"]
        or input_feature.dataType != int32_type
        or list(output_feature.shape) != expected["logits"]["shape"]
        or output_feature.dataType != float16_type
    ):
        raise SystemExit(
            "CTC Core ML feature shapes or data types are inconsistent."
        )
    return expected


def ctc_known_answer_input(
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> np.ndarray:
    input_vocab = checkpoint["inputVocab"]
    lexical_ids = [
        token_id
        for token, token_id in sorted(
            input_vocab.items(),
            key=lambda item: item[1],
        )
        if token not in INPUT_SPECIAL
    ]
    if not lexical_ids:
        raise SystemExit(
            "CTC Core ML attestation requires lexical input tokens."
        )
    prefix = lexical_ids[: min(6, args.max_input_len - 1)]
    prefix.append(input_vocab[EOS])
    return np.asarray(
        [
            prefix
            + [input_vocab[PAD]] * (args.max_input_len - len(prefix))
        ],
        dtype=np.int32,
    )


def validate_ctc_coreml_known_answer(
    backend: CompiledCTCCoreMLBackend,
    pytorch_model: CTCTransformer,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    input_ids = ctc_known_answer_input(checkpoint, args)
    with torch.no_grad():
        expected = (
            pytorch_model.eval().to("cpu")(
                torch.from_numpy(input_ids)
            )
            .detach()
            .cpu()
            .numpy()
        )
    observed = backend.predict(input_ids)
    difference = np.abs(
        observed.astype(np.float64) - expected.astype(np.float64)
    )
    maximum_error = float(np.max(difference))
    if not np.allclose(
        observed,
        expected,
        rtol=COREML_PARITY_RTOL,
        atol=COREML_PARITY_ATOL,
    ):
        raise SystemExit(
            "Exact compiled CTC Core ML logits diverge from the checkpoint; "
            f"max error={maximum_error}."
        )
    return {
        "knownAnswerInputSha256": hashlib.sha256(
            input_ids.tobytes()
        ).hexdigest(),
        "maximumAbsoluteLogitError": maximum_error,
        "relativeTolerance": COREML_PARITY_RTOL,
        "absoluteTolerance": COREML_PARITY_ATOL,
    }


def load_verified_compiled_ctc_coreml(
    pytorch_model: CTCTransformer,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
    *,
    package_path: Path,
    compiled_path: Path,
    expected_package_sha256: str,
    expected_compiled_sha256: str,
) -> tuple[CompiledCTCCoreMLBackend, dict[str, Any]]:
    if ct is None:
        raise SystemExit(
            f"Core ML validation is unavailable: {COREML_IMPORT_ERROR}"
        )
    package_sha256 = directory_sha256(package_path)
    compiled_sha256 = directory_sha256(compiled_path)
    if (
        package_sha256 != expected_package_sha256
        or compiled_sha256 != expected_compiled_sha256
    ):
        raise SystemExit(
            "CTC Core ML bytes changed before exact-artifact validation."
        )
    try:
        package_model = ct.models.MLModel(str(package_path))
        compiled_model = ct.models.CompiledMLModel(str(compiled_path))
    except Exception as error:
        raise SystemExit(
            "Unable to load the exact CTC Core ML artifacts."
        ) from error
    tensor_contract = validate_ctc_coreml_feature_contract(
        package_model,
        checkpoint,
        args,
    )
    backend = CompiledCTCCoreMLBackend(
        compiled_model,
        output_time_steps=args.output_time_steps,
        output_class_count=len(checkpoint["outputVocab"]),
        compiled_sha256=compiled_sha256,
    )
    parity = validate_ctc_coreml_known_answer(
        backend,
        pytorch_model,
        checkpoint,
        args,
    )
    return backend, {
        "status": "passed",
        "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
        "mlpackageSha256": package_sha256,
        "compiledModelSha256": compiled_sha256,
        "tensorContract": tensor_contract,
        **parity,
    }


def validate_ctc_checkpoint_file_binding(
    model: CTCTransformer,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> str:
    path = checkpoint_path(args)
    try:
        with open_regular_binary(path, "CTC checkpoint") as handle:
            source = torch.load(
                handle,
                map_location="cpu",
                weights_only=True,
            )
    except Exception as error:
        raise SystemExit(
            "CTC checkpoint failed exact tensor-only reload."
        ) from error
    if not isinstance(source, dict):
        raise SystemExit("CTC checkpoint payload is not an object.")
    source_state = source.get("stateDict")
    memory_state = checkpoint.get("stateDict")
    model_state = model.state_dict()
    if (
        not isinstance(source_state, dict)
        or not isinstance(memory_state, dict)
        or set(source_state) != set(memory_state)
        or set(source_state) != set(model_state)
    ):
        raise SystemExit("CTC checkpoint state dictionary is inconsistent.")
    source_metadata = {
        key: value
        for key, value in source.items()
        if key != "stateDict"
    }
    memory_metadata = {
        key: value
        for key, value in checkpoint.items()
        if key != "stateDict"
    }
    if source_metadata != memory_metadata:
        raise SystemExit(
            "CTC checkpoint file metadata differs from memory."
        )
    for name in sorted(source_state):
        if (
            not torch.equal(source_state[name], memory_state[name])
            or not torch.equal(source_state[name], model_state[name])
        ):
            raise SystemExit(
                f"CTC checkpoint tensor differs from the export model: {name}."
            )
    return sha256_file(path)


def export_coreml(
    model: CTCTransformer,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> dict[str, Any]:
    if args.skip_coreml:
        return {
            "status": "skipped",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
        }
    if ct is None:
        return {
            "status": "failed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
            "error": f"coremltools import failed: {COREML_IMPORT_ERROR}",
        }
    if (
        not isinstance(model, CTCTransformer)
        or checkpoint.get("modelId") != MODEL_ID
        or checkpoint.get("config") != checkpoint_runtime_config(args)
        or checkpoint.get("trainingRunId") != args.training_run_id
    ):
        raise SystemExit(
            "CTC Core ML export is not bound to the active checkpoint."
        )
    source_checkpoint_sha256 = validate_ctc_checkpoint_file_binding(
        model,
        checkpoint,
        args,
    )
    package_target = mlpackage_path(args)
    compiled_target = args.compiled_model
    package_staging = staging_sibling(package_target, "staging")
    compiled_staging = staging_sibling(compiled_target, "staging")
    coremltools_output = staging_sibling(
        args.out_dir / "LekhNeuralTransliterator.coremltools.mlmodelc",
        "compile",
    )
    xcode_output = staging_sibling(
        args.out_dir / "coreml-compiled",
        "compile",
    )
    temporary_directories = (
        package_staging,
        compiled_staging,
        coremltools_output,
        xcode_output,
    )
    try:
        converted = convert_ctc_coreml_for_testing(
            model,
            max_input_len=args.max_input_len,
            minimum_deployment_target=ct.target.macOS13,
        )
        package_target.parent.mkdir(parents=True, exist_ok=True)
        converted.save(str(package_staging))
        compiled = ct.models.MLModel(
            str(package_staging)
        ).get_compiled_model_path()
        if not compiled or not Path(compiled).exists():
            compiled = compile_mlpackage_with_coremltools(
                package_staging,
                coremltools_output,
            )
        if not compiled or not Path(compiled).exists():
            compiled = compile_mlpackage_with_xcode(
                package_staging,
                xcode_output,
            )
        if not compiled or not Path(compiled).exists():
            raise RuntimeError(
                "Core ML compilation returned no compiled CTC model."
            )
        compiled_source = normalize_compiled_model_path(Path(compiled))
        secure_directory_files(
            compiled_source,
            require_repo_containment=False,
        )
        shutil.copytree(compiled_source, compiled_staging)
        secure_directory_files(package_staging)
        secure_directory_files(compiled_staging)
        package_sha256 = directory_sha256(package_staging)
        compiled_sha256 = directory_sha256(compiled_staging)
        _backend, prepublication = load_verified_compiled_ctc_coreml(
            model,
            checkpoint,
            args,
            package_path=package_staging,
            compiled_path=compiled_staging,
            expected_package_sha256=package_sha256,
            expected_compiled_sha256=compiled_sha256,
        )
        prepublication = {
            **prepublication,
            "phase": "pre-publication-staging",
            "sourceCheckpointSha256": source_checkpoint_sha256,
        }
        assert_run_input_snapshot_unchanged(args)
        publish_directories_atomically([
            (package_staging, package_target),
            (compiled_staging, compiled_target),
        ])
        _published_backend, artifact_validation = (
            load_verified_compiled_ctc_coreml(
                model,
                checkpoint,
                args,
                package_path=package_target,
                compiled_path=compiled_target,
                expected_package_sha256=package_sha256,
                expected_compiled_sha256=compiled_sha256,
            )
        )
        return {
            "status": "passed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
            "sourceCheckpointSha256": source_checkpoint_sha256,
            "mlpackage": rel(package_target),
            "mlpackageBytes": directory_bytes(package_target),
            "mlpackageSha256": package_sha256,
            "compiledModel": rel(compiled_target),
            "compiledBytes": directory_bytes(compiled_target),
            "compiledSha256": compiled_sha256,
            "tensorContract": ctc_coreml_tensor_contract(
                checkpoint,
                args,
            ),
            "prePublicationValidation": prepublication,
            "artifactValidation": {
                **artifact_validation,
                "phase": "published-exact-artifact",
                "sourceCheckpointSha256": source_checkpoint_sha256,
            },
        }
    except Exception as error:  # pragma: no cover - environment-dependent.
        return {
            "status": "failed",
            "trainingRunId": args.training_run_id,
            "exportRunId": args.export_run_id,
            "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
            "sourceCheckpointSha256": source_checkpoint_sha256,
            "error": repr(error),
        }
    finally:
        for temporary in temporary_directories:
            try:
                safe_remove_sibling_directory(
                    temporary,
                    temporary.parent,
                )
            except Exception:
                pass


def admitted_neural_input(
    text: str,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> str | None:
    normalized = normalize_input(text)
    if (
        not 3 <= len(normalized) < args.max_input_len
        or SAFE_NEURAL_ROMAN_TOKEN.fullmatch(normalized) is None
        or normalized in PROTECTED_LATIN_TOKENS
    ):
        return None
    input_vocab = checkpoint["inputVocab"]
    if any(
        token not in input_vocab
        or input_vocab[token] == input_vocab[UNK]
        for token in normalized
    ):
        return None
    return normalized


def decode_compiled_ctc_candidates(
    backend: CompiledCTCCoreMLBackend,
    text: str,
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> list[str]:
    normalized = admitted_neural_input(text, checkpoint, args)
    if normalized is None:
        return []
    encoded = encode_input(
        normalized,
        checkpoint["inputVocab"],
        args.max_input_len,
    )
    logits = backend.predict(
        np.asarray([encoded], dtype=np.int32)
    )[0]
    return decode_ctc_logits(
        logits,
        checkpoint["outputVocab"],
        beam_width=args.beam_width,
        maximum_candidates=args.maximum_candidates,
    )


def verified_ctc_backend_evidence(
    backend: CompiledCTCCoreMLBackend,
    args: argparse.Namespace,
    operation: str,
) -> dict[str, Any]:
    observed_sha256 = directory_sha256(args.compiled_model)
    if observed_sha256 != backend.compiled_sha256:
        raise SystemExit(
            f"Compiled CTC Core ML bytes changed during {operation}."
        )
    compiled_bytes = directory_bytes(args.compiled_model)
    return {
        "backend": "coreml-compiled-transformer-ctc",
        "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
        "compiledModel": rel(args.compiled_model),
        "compiledModelSha256": observed_sha256,
        "artifactIdentity": {
            "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
            "compiledArtifacts": {
                "model": {
                    "path": rel(args.compiled_model),
                    "sha256": observed_sha256,
                    "bytes": compiled_bytes,
                },
            },
        },
    }


def write_ctc_gold_predictions(
    backend: CompiledCTCCoreMLBackend,
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
                candidates = decode_compiled_ctc_candidates(
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
    _, verified_again = load_verified_gold_rows(args)
    if verified_again != gold_evidence:
        raise SystemExit(
            "Gold corpus changed during CTC prediction generation."
        )
    backend_evidence = verified_ctc_backend_evidence(
        backend,
        args,
        "gold prediction generation",
    )
    return {
        **backend_evidence,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "inputAdmissionPolicy": NEURAL_TAIL_ADMISSION_POLICY,
        **gold_evidence,
        "predictions": rel(output_path),
        "predictionsSha256": sha256_file(output_path),
    }


def write_ctc_official_benchmark_predictions(
    backend: CompiledCTCCoreMLBackend,
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
            "Official benchmark differs from the CTC input snapshot."
        )
    output_path = official_benchmark_predictions_path(args)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    staging = staging_sibling(output_path, "staging")
    try:
        with staging.open("x", encoding="utf-8") as handle:
            for row in rows:
                candidates = decode_compiled_ctc_candidates(
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
            "Official benchmark changed during CTC prediction generation."
        )
    backend_evidence = verified_ctc_backend_evidence(
        backend,
        args,
        "official benchmark prediction generation",
    )
    return {
        **backend_evidence,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "inputAdmissionPolicy": NEURAL_TAIL_ADMISSION_POLICY,
        **current_evidence,
        "trainingIsolation": locked_evidence["trainingIsolation"],
        "predictions": rel(output_path),
        "predictionsSha256": sha256_file(output_path),
    }


def ctc_benchmark_inputs(
    checkpoint: dict[str, Any],
    args: argparse.Namespace,
) -> list[str]:
    preferred = (
        "prashasan",
        "niraj",
        "nepal",
        "sambidhan",
        "pariwartan",
    )
    values = [
        value
        for value in preferred
        if admitted_neural_input(value, checkpoint, args) is not None
    ]
    lexical = [
        token
        for token, token_id in sorted(
            checkpoint["inputVocab"].items(),
            key=lambda item: item[1],
        )
        if token not in INPUT_SPECIAL
        and len(token) == 1
        and "a" <= token <= "z"
    ]
    for requested_length in (3, 8, 16):
        length = min(requested_length, args.max_input_len - 1)
        if length < 3 or not lexical:
            continue
        candidate = "".join(
            lexical[index % len(lexical)]
            for index in range(length)
        )
        if (
            candidate not in values
            and admitted_neural_input(candidate, checkpoint, args)
                is not None
        ):
            values.append(candidate)
    if not values:
        raise SystemExit(
            "CTC benchmark could not construct an admitted input."
        )
    return values[:3]


def benchmark_compiled_ctc_coreml(
    args: argparse.Namespace,
    backend: CompiledCTCCoreMLBackend,
    checkpoint: dict[str, Any],
) -> dict[str, Any]:
    architecture = platform.machine().lower()
    mapped_architecture = (
        "arm64"
        if architecture == "arm64"
        else "x86_64"
        if architecture in {"x86_64", "amd64"}
        else architecture
    )
    inputs = ctc_benchmark_inputs(checkpoint, args)
    for _ in range(3):
        for value in inputs:
            decode_compiled_ctc_candidates(
                backend,
                value,
                checkpoint,
                args,
            )
    durations: list[float] = []
    while len(durations) < 120:
        for value in inputs:
            started = time.perf_counter()
            decode_compiled_ctc_candidates(
                backend,
                value,
                checkpoint,
                args,
            )
            durations.append((time.perf_counter() - started) * 1_000)
            if len(durations) >= 120:
                break
    verified_ctc_backend_evidence(
        backend,
        args,
        "full-candidate benchmark",
    )
    result = {
        "name": "local-mac",
        "macOS": platform.mac_ver()[0] or "unknown",
        "architecture": mapped_architecture,
        "packagedApp": False,
        "secureFieldInferenceCount": -1,
        "measurementKind": "full-candidate-generation",
        "p50Ms": round(float(np.percentile(durations, 50)), 6),
        "p95Ms": round(float(np.percentile(durations, 95)), 6),
        "p99Ms": round(float(np.percentile(durations, 99)), 6),
        "artifact": rel(args.compiled_model),
    }
    write_json(measurements_path(args), {
        "generatedAt": iso_now(),
        "measurementKind": "full-candidate-generation",
        "decoder": "ctc-prefix-beam-search",
        "beamWidth": args.beam_width,
        "sampleCount": len(durations),
        "benchmarkInputsSha256": sha256_text("\n".join(inputs)),
        "devices": [result],
    })
    return result


def valid_ctc_benchmark_result(
    result: dict[str, Any],
    args: argparse.Namespace,
) -> bool:
    required = {
        "name",
        "macOS",
        "architecture",
        "packagedApp",
        "secureFieldInferenceCount",
        "measurementKind",
        "p50Ms",
        "p95Ms",
        "p99Ms",
        "artifact",
    }
    try:
        evidence = read_json(measurements_path(args))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        set(result) == required
        and result["measurementKind"] == "full-candidate-generation"
        and all(
            isinstance(result.get(key), (int, float))
            and math.isfinite(float(result[key]))
            and result[key] >= 0
            for key in ("p50Ms", "p95Ms", "p99Ms")
        )
        and result["artifact"] == rel(args.compiled_model)
        and evidence.get("measurementKind")
            == "full-candidate-generation"
        and evidence.get("decoder") == "ctc-prefix-beam-search"
        and evidence.get("beamWidth") == args.beam_width
        and evidence.get("sampleCount") == 120
        and isinstance(evidence.get("benchmarkInputsSha256"), str)
        and len(evidence["benchmarkInputsSha256"]) == 64
        and evidence.get("devices") == [result]
    )


def ctc_runtime_artifact_contract_issues(
    args: argparse.Namespace,
    checkpoint: dict[str, Any],
    compiled_bytes: int,
) -> list[str]:
    architecture = args.training_config["architecture"]
    parameter_count = int(checkpoint.get("parameterCount", 0))
    issues: list[str] = []
    if not (
        int(architecture["minimumParameterCount"])
        <= parameter_count
        <= int(architecture["maximumParameterCount"])
    ):
        issues.append(
            "parameter count is outside the configured CTC contract"
        )
    if not 1 <= compiled_bytes <= int(
        architecture["maximumCompiledBytes"]
    ):
        issues.append(
            "compiled model size is outside the configured CTC contract"
        )
    if not 4 <= args.max_input_len <= 128:
        issues.append("input length is outside the native contract")
    if not 8 <= args.output_time_steps <= 48:
        issues.append("CTC time dimension is outside the native contract")
    if checkpoint.get("outputVocab", {}).get(CTC_BLANK) != CTC_BLANK_ID:
        issues.append("CTC blank class is not zero")
    return issues


def write_ctc_runtime_manifest(
    args: argparse.Namespace,
    checkpoint: dict[str, Any],
    training_report: dict[str, Any],
    coreml: dict[str, Any],
    benchmark: dict[str, Any],
) -> dict[str, Any]:
    if not run_input_snapshots_share_immutable_inputs(
        checkpoint.get("runInputSnapshot"),
        ensure_run_input_snapshot(args),
    ):
        raise SystemExit(
            "Refusing a CTC runtime manifest with mixed immutable inputs."
        )
    if (
        coreml.get("status") != "passed"
        or coreml.get("runtimeModelContract") != RUNTIME_MODEL_CONTRACT
        or coreml.get("tensorContract")
            != ctc_coreml_tensor_contract(checkpoint, args)
        or coreml.get("compiledSha256")
            != directory_sha256(args.compiled_model)
        or coreml.get("mlpackageSha256")
            != directory_sha256(mlpackage_path(args))
        or coreml.get("artifactValidation", {}).get("status")
            != "passed"
        or coreml.get("artifactValidation", {}).get(
            "sourceCheckpointSha256"
        ) != sha256_file(checkpoint_path(args))
    ):
        raise SystemExit(
            "Refusing a CTC manifest without exact Core ML attestation."
        )
    if (
        not is_run_identifier(args.training_run_id)
        or not is_run_identifier(args.export_run_id)
        or args.training_run_id == args.export_run_id
        or checkpoint.get("trainingRunId") != args.training_run_id
        or training_report.get("trainingRunId") != args.training_run_id
    ):
        raise SystemExit("CTC manifest run identities are inconsistent.")
    checkpoint_sha256 = sha256_file(checkpoint_path(args))
    if training_report.get("checkpointSha256") != checkpoint_sha256:
        raise SystemExit("CTC training report binds another checkpoint.")
    compiled_bytes = directory_bytes(args.compiled_model)
    issues = ctc_runtime_artifact_contract_issues(
        args,
        checkpoint,
        compiled_bytes,
    )
    if issues:
        raise SystemExit(
            "Refusing an invalid CTC runtime artifact: "
            + "; ".join(issues)
        )
    context = args.training_config["context"]
    rescorer = context["languageModelRescorer"]
    training_sources = sorted(
        source
        for source, count in checkpoint.get(
            "trainingSourceCounts",
            {},
        ).items()
        if int(count) > 0
    )
    manifest = {
        "schemaVersion": 2,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "selectedArtifact": checkpoint["modelId"],
        "runtime": "CoreML",
        "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
        "tensorContract": coreml["tensorContract"],
        "localOnly": True,
        "neuralTailOnly": True,
        "productionEligible": False,
        "architecture": ARCHITECTURE_FAMILY,
        "openVocabulary": True,
        "tokenization": OUTPUT_TOKENIZATION,
        "outputSequenceValidation": OUTPUT_SEQUENCE_VALIDATION,
        "decoder": "ctc-prefix-beam-search",
        "beamSearch": {
            "enabled": True,
            "beamWidth": args.beam_width,
            "maxOutputGraphemes": args.output_time_steps,
            "maxSteps": args.output_time_steps,
        },
        "languageModelRescorer": {
            "enabled": bool(rescorer["enabled"]),
            "source": str(rescorer["source"]),
            "weight": float(rescorer["weight"]),
        },
        "contextWindowWords": int(context["previousWords"]),
        "parameterCount": int(checkpoint["parameterCount"]),
        "modelBytes": compiled_bytes,
        "trainingSources": training_sources,
        "datasetReports": [
            args.training_config["export"]["reports"]["dataset"],
        ],
        "evaluationReports": [
            args.training_config["export"]["reports"]["evaluation"],
        ],
        "benchmarkReports": [
            args.training_config["export"]["reports"]["benchmark"],
        ],
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
            "p50Ms": benchmark["p50Ms"],
            "p95Ms": benchmark["p95Ms"],
            "p99Ms": benchmark["p99Ms"],
            "targetP99Ms": args.training_config[
                "productionGates"
            ]["p99Ms"],
            "measuredOnDevice": True,
            "devices": [benchmark],
        },
        "requiredCases": REQUIRED_CASES,
        "sha256": {
            "compiledModel": coreml["compiledSha256"],
            "sourceCheckpoint": checkpoint_sha256,
            "trainingDatasetManifest":
                checkpoint["datasetManifestSha256"],
            "vocabMetadata": checkpoint["vocabMetadataSha256"],
        },
        "limitations": candidate_limitations(),
    }
    write_json(args.manifest, manifest)
    return manifest


def candidate_limitations() -> list[str]:
    return [
        "Quality metrics remain provisional until locked gold and official benchmark evaluation pass.",
        "The local Core ML benchmark is diagnostic until the exact packaged runtime is measured.",
        "Neural Engine execution is not claimed without an artifact-bound Instruments trace.",
        "The neural tail remains opt-in behind deterministic suggestions.",
    ]


def run_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    ensure_run_input_snapshot(args)
    loaded = load_checkpoint(args) if args.skip_train else train_model(args)
    model: CTCTransformer = loaded["model"]
    checkpoint = loaded["checkpoint"]
    training_report = loaded["report"]
    topology = execution_topology(
        training_report.get("trainingExecutionModes", {}),
        args.execution_modes,
    )
    if args.training_run_id == args.export_run_id:
        raise SystemExit(
            "CTC training and export identities must be distinct."
        )
    assert_run_input_snapshot_unchanged(args)
    coreml = export_coreml(model, checkpoint, args)
    export_succeeded = coreml.get("status") == "passed"
    prediction_evidence: dict[str, Any] | None = None
    comparison_evidence: dict[str, Any] | None = None
    if export_succeeded:
        backend, independent_validation = (
            load_verified_compiled_ctc_coreml(
                model,
                checkpoint,
                args,
                package_path=mlpackage_path(args),
                compiled_path=args.compiled_model,
                expected_package_sha256=str(
                    coreml["mlpackageSha256"]
                ),
                expected_compiled_sha256=str(
                    coreml["compiledSha256"]
                ),
            )
        )
        if (
            independent_validation.get("status") != "passed"
            or independent_validation.get("tensorContract")
                != coreml.get("tensorContract")
            or independent_validation.get("knownAnswerInputSha256")
                != coreml.get("artifactValidation", {}).get(
                    "knownAnswerInputSha256"
                )
            or independent_validation.get("relativeTolerance")
                != COREML_PARITY_RTOL
            or independent_validation.get("absoluteTolerance")
                != COREML_PARITY_ATOL
        ):
            raise SystemExit(
                "Published CTC artifact attestation is inconsistent."
            )
        prediction_evidence = write_ctc_gold_predictions(
            backend,
            checkpoint,
            args,
        )
        comparison_evidence = (
            write_ctc_official_benchmark_predictions(
                backend,
                checkpoint,
                args,
            )
        )
        benchmark = benchmark_compiled_ctc_coreml(
            args,
            backend,
            checkpoint,
        )
    else:
        benchmark = {
            "status": "skipped",
            "reason": (
                "Core ML export did not produce a verified CTC artifact."
            ),
        }
    benchmark_succeeded = (
        export_succeeded
        and valid_ctc_benchmark_result(benchmark, args)
    )
    runtime_contract_issues = (
        ctc_runtime_artifact_contract_issues(
            args,
            checkpoint,
            directory_bytes(args.compiled_model),
        )
        if export_succeeded
        else []
    )
    publishable = (
        benchmark_succeeded
        and prediction_evidence is not None
        and comparison_evidence is not None
        and not runtime_contract_issues
    )
    assert_run_input_snapshot_unchanged(args)
    manifest = (
        write_ctc_runtime_manifest(
            args,
            checkpoint,
            training_report,
            coreml,
            benchmark,
        )
        if publishable
        else None
    )
    if publishable:
        status = "passed-open-vocab-ctc-transformer-candidate"
    elif args.skip_coreml:
        status = "passed-training-candidate-coreml-export-skipped"
    elif export_succeeded:
        status = (
            "failed-runtime-artifact-contract"
            if runtime_contract_issues
            else "failed-coreml-benchmark"
        )
    else:
        status = "failed-coreml-export"

    checkpoint_sha256 = sha256_file(checkpoint_path(args))
    training_report_sha256 = sha256_file(training_report_path(args))
    if (
        checkpoint.get("trainingRunId") != args.training_run_id
        or training_report.get("trainingRunId") != args.training_run_id
        or training_report.get("checkpointSha256")
            != checkpoint_sha256
    ):
        raise SystemExit(
            "CTC training artifacts changed before export publication."
        )
    if export_succeeded:
        if (
            directory_sha256(args.compiled_model)
                != coreml.get("compiledSha256")
            or directory_sha256(mlpackage_path(args))
                != coreml.get("mlpackageSha256")
        ):
            raise SystemExit(
                "CTC Core ML bytes changed before export publication."
            )
    if prediction_evidence is not None:
        if prediction_evidence.get("predictionsSha256") != sha256_file(
            predictions_path(args)
        ):
            raise SystemExit(
                "CTC gold predictions changed before publication."
            )
        _, current_gold = load_verified_gold_rows(args)
        expected_gold = {
            key: prediction_evidence[key]
            for key in (
                "goldManifest",
                "goldManifestSha256",
                "goldCorpusSha256",
                "goldSuites",
                "goldRows",
            )
        }
        if current_gold != expected_gold:
            raise SystemExit(
                "CTC gold evidence changed before publication."
            )
    if comparison_evidence is not None:
        if comparison_evidence.get(
            "predictionsSha256"
        ) != sha256_file(official_benchmark_predictions_path(args)):
            raise SystemExit(
                "CTC official predictions changed before publication."
            )
        _, current_official = (
            load_verified_official_benchmark_rows(args)
        )
        expected_official = {
            key: comparison_evidence[key]
            for key in (
                "manifest",
                "manifestSha256",
                "corpusSha256",
                "suites",
                "rows",
            )
        }
        if current_official != expected_official:
            raise SystemExit(
                "CTC official evidence changed before publication."
            )
        if comparison_evidence.get(
            "trainingIsolation"
        ) != ensure_run_input_snapshot(args)["officialBenchmark"][
            "trainingIsolation"
        ]:
            raise SystemExit(
                "CTC official training-isolation evidence changed."
            )

    export_report = {
        "generatedAt": iso_now(),
        "status": status,
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "executionModes": args.execution_modes,
        "executionTopology": topology,
        "trainingExecutionModes":
            training_report["trainingExecutionModes"],
        "trainingContractSha256": args.training_contract_sha256,
        "effectiveTrainingConfigSha256":
            args.effective_training_config_sha256,
        "effectiveArtifactInputsSha256":
            args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "runInputSnapshot": ensure_run_input_snapshot(args),
        "trainingRunInputSnapshotSha256": sha256_json(
            training_report["runInputSnapshot"]
        ),
        "exportRunInputSnapshotSha256": sha256_json(
            ensure_run_input_snapshot(args)
        ),
        "runtimeArtifactContractIssues": runtime_contract_issues,
        "checkpoint": rel(checkpoint_path(args)),
        "checkpointSha256": checkpoint_sha256,
        "trainingReport": rel(training_report_path(args)),
        "trainingReportSha256": training_report_sha256,
        "coremlExport": coreml,
        "runtimeModelContract": RUNTIME_MODEL_CONTRACT,
        "inputAdmissionPolicy": NEURAL_TAIL_ADMISSION_POLICY,
        "predictions": (
            prediction_evidence.get("predictions")
            if prediction_evidence
            else None
        ),
        "predictionsSha256": (
            prediction_evidence.get("predictionsSha256")
            if prediction_evidence
            else None
        ),
        "predictionsBackend": (
            prediction_evidence.get("backend")
            if prediction_evidence
            else None
        ),
        "goldManifest": (
            prediction_evidence.get("goldManifest")
            if prediction_evidence
            else None
        ),
        "goldManifestSha256": (
            prediction_evidence.get("goldManifestSha256")
            if prediction_evidence
            else None
        ),
        "goldCorpusSha256": (
            prediction_evidence.get("goldCorpusSha256")
            if prediction_evidence
            else None
        ),
        "goldSuites": (
            prediction_evidence.get("goldSuites")
            if prediction_evidence
            else None
        ),
        "goldRows": (
            prediction_evidence.get("goldRows")
            if prediction_evidence
            else None
        ),
        "comparisonBenchmark": ({
            "manifest": comparison_evidence["manifest"],
            "manifestSha256":
                comparison_evidence["manifestSha256"],
            "corpusSha256": comparison_evidence["corpusSha256"],
            "suites": comparison_evidence["suites"],
            "rows": comparison_evidence["rows"],
            "trainingIsolation":
                comparison_evidence["trainingIsolation"],
            "predictions": comparison_evidence["predictions"],
            "predictionsSha256":
                comparison_evidence["predictionsSha256"],
            "predictionsBackend":
                comparison_evidence["backend"],
            "predictionArtifactIdentity":
                comparison_evidence["artifactIdentity"],
        } if comparison_evidence else None),
        "measurements": (
            rel(measurements_path(args))
            if export_succeeded
            else None
        ),
        "measurementsSha256": (
            sha256_file(measurements_path(args))
            if export_succeeded
            else None
        ),
        "compiledModel": (
            rel(args.compiled_model)
            if export_succeeded
            else None
        ),
        "compiledModelSha256": (
            coreml.get("compiledSha256")
            if export_succeeded
            else None
        ),
        "mlpackage": (
            rel(mlpackage_path(args))
            if export_succeeded
            else None
        ),
        "mlpackageSha256": (
            coreml.get("mlpackageSha256")
            if export_succeeded
            else None
        ),
        "manifest": rel(args.manifest) if manifest else None,
        "manifestSha256": (
            sha256_file(args.manifest)
            if manifest
            else None
        ),
        "productionEligible": bool(
            manifest and manifest["productionEligible"]
        ),
        "candidateLimitations": candidate_limitations(),
    }
    assert_run_input_snapshot_unchanged(args)
    write_json(export_report_path(args), export_report)
    print(json.dumps({
        "status": export_report["status"],
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
