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
    dev_weighted = apply_source_multipliers(
        dev_rows,
        args.source_multipliers,
    )
    input_vocab = build_input_vocab(train_rows)
    output_vocab = build_output_vocab(train_rows)
    return {
        "trainRows": train_rows,
        "devRows": dev_weighted,
        "datasetManifest": manifest,
        "inputVocab": input_vocab,
        "outputVocab": output_vocab,
        "augmentation": augmentation,
    }


def main() -> None:
    # Training/export publication is added in the next implementation slice.
    # Refuse to create partial candidate artifacts from the foundation alone.
    parse_args()
    raise SystemExit(
        "CTC trainer foundation is verified, but artifact publication is not "
        "enabled until recovery and Core ML export are bound."
    )


if __name__ == "__main__":
    main()
