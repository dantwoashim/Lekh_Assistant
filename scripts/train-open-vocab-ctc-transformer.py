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
import random
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

_legacy_capture_run_input_snapshot = LEGACY.capture_run_input_snapshot


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
    if training.get("loss") != "weighted-ctc":
        raise SystemExit("CTC config must declare weighted-ctc loss.")
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
    input_lengths = torch.full(
        (batch,),
        time_steps,
        dtype=torch.int64,
        device="cpu",
    )
    losses = torch.nn.functional.ctc_loss(
        torch.log_softmax(logits, dim=-1).transpose(0, 1),
        targets,
        input_lengths,
        target_lengths,
        blank=blank_id,
        reduction="none",
        zero_infinity=False,
    )
    if not torch.isfinite(losses).all():
        raise SystemExit(
            "CTC loss became non-finite; target alignment is invalid."
        )
    device_weights = weights.to(losses.device)
    numerator = (losses * device_weights).sum()
    denominator = device_weights.sum()
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
        targets = targets.to(device)
        weights = weights.to(device)
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
            targets = targets.to(device)
            weights = weights.to(device)
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
    checkpoint = loaded["checkpoint"]
    report = loaded["report"]
    if not args.skip_coreml:
        raise SystemExit(
            "CTC Core ML publication is not enabled until exact compiled "
            "artifact parity is bound."
        )
    if report.get("trainingExecutionModes") != args.execution_modes:
        raise SystemExit("CTC training-only execution modes are inconsistent.")
    assert_run_input_snapshot_unchanged(args)
    export_report = {
        "generatedAt": iso_now(),
        "status": "passed-training-candidate-coreml-export-skipped",
        "modelId": args.model_id,
        "trainingRunId": args.training_run_id,
        "exportRunId": args.export_run_id,
        "executionModes": args.execution_modes,
        "executionTopology": "training-only-no-coreml-v1",
        "trainingExecutionModes": report["trainingExecutionModes"],
        "trainingContractSha256": args.training_contract_sha256,
        "effectiveTrainingConfigSha256":
            args.effective_training_config_sha256,
        "effectiveArtifactInputsSha256":
            args.effective_artifact_inputs_sha256,
        "artifactOverrides": args.artifact_overrides,
        "runInputSnapshot": ensure_run_input_snapshot(args),
        "checkpoint": rel(checkpoint_path(args)),
        "checkpointSha256": sha256_file(checkpoint_path(args)),
        "trainingReport": rel(training_report_path(args)),
        "trainingReportSha256": sha256_file(training_report_path(args)),
        "coremlExport": {
            "status": "skipped",
            "reason": "training-only CUDA phase",
        },
        "productionEligible": False,
        "candidateLimitations": candidate_limitations(),
    }
    if (
        report.get("checkpointSha256")
            != export_report["checkpointSha256"]
        or checkpoint.get("trainingRunId") != args.training_run_id
    ):
        raise SystemExit("CTC training artifacts changed before publication.")
    write_json(export_report_path(args), export_report)
    print(json.dumps({
        "status": export_report["status"],
        "checkpoint": export_report["checkpoint"],
        "trainingReport": export_report["trainingReport"],
        "exportReport": rel(export_report_path(args)),
        "productionEligible": False,
    }, ensure_ascii=False, indent=2))
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
