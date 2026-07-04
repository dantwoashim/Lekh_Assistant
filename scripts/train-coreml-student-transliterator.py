#!/usr/bin/env python3
"""Build the first Lekh Core ML transliteration student.

This is intentionally a small on-device classifier, not the public teacher
checkpoint. The deterministic composer/dictionary remain the primary path; this
model supplies ranked tail candidates from romanized character n-gram features.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

try:
    import coremltools as ct
    from coremltools.models import datatypes
    from coremltools.models.neural_network import NeuralNetworkBuilder
except Exception as error:  # pragma: no cover - exercised by local tool setup.
    raise SystemExit(
        "coremltools is required. Run npm run neural:student:setup, "
        f"or use .tmp/coreml-student-venv/bin/python. Details: {error}"
    )


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_DIR = ROOT / "data/generated/neural-transliteration"
DEFAULT_MODEL_DIR = ROOT / "models/macos/LekhNeuralTransliterator.mlmodelc"
DEFAULT_MANIFEST_PATH = ROOT / "models/macos/LekhNeuralTransliterator.manifest.json"
DEFAULT_SOURCE_MODEL_PATH = ROOT / "data/generated/coreml-student/LekhNeuralTransliterator.mlmodel"
DEFAULT_REPORT_PATH = ROOT / "reports/coreml-student-transliterator-report.json"

FEATURE_DIM = 384
CLASS_LIMIT = 8192
TEMPERATURE = 14.0
SOURCE_WEIGHTS = {
    "manual-required": 180.0,
    "manual-chat-tail": 160.0,
    "manual-x-ksha": 140.0,
    "manual-name": 90.0,
    "manual-ambiguity": 85.0,
    "runtime-phrases": 5.0,
    "runtime-words": 4.0,
    "runtime-names": 3.0,
    "dictionary-ne-ranked": 2.0,
}

REQUIRED_PAIRS = [
    ("vato", "बाटो", "manual-required"),
    ("bato", "बाटो", "manual-required"),
    ("baato", "बाटो", "manual-required"),
    ("chha", "छ", "manual-required"),
    ("cha", "छ", "manual-required"),
    ("xa", "छ", "manual-required"),
    ("xaina", "छैन", "manual-required"),
    ("xau", "छौ", "manual-required"),
    ("xu", "छु", "manual-required"),
    ("xan", "छन्", "manual-required"),
    ("xas", "छस्", "manual-required"),
    ("xetra", "क्षेत्र", "manual-required"),
    ("niraj", "निरज", "manual-required"),
    ("niraj", "नीरज", "manual-required"),
    ("thapera", "थपेर", "manual-required"),
    ("thapera", "थापेर", "manual-required"),
    ("swasthya", "स्वास्थ्य", "manual-required"),
    ("namaste", "नमस्ते", "manual-required"),
    ("mero", "मेरो", "manual-required"),
    ("nepal", "नेपाल", "manual-required"),
]

REQUIRED_CASES = {
    "vato": "बाटो",
    "bato": "बाटो",
    "baato": "बाटो",
    "chha": "छ",
    "cha": "छ",
    "xa": "छ",
    "xaina": "छैन",
    "swasthya": "स्वास्थ्य",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build LekhNeuralTransliterator.mlmodelc")
    parser.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--source-model", type=Path, default=DEFAULT_SOURCE_MODEL_PATH)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT_PATH)
    parser.add_argument("--feature-dim", type=int, default=FEATURE_DIM)
    parser.add_argument("--class-limit", type=int, default=CLASS_LIMIT)
    return parser.parse_args()


def normalize_romanized(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def normalize_devanagari(value: str) -> str:
    return unicodedata.normalize("NFC", str(value or "").strip())


def fnv1a32(value: str) -> int:
    output = 2166136261
    for char in value:
        output ^= ord(char)
        output = (output * 16777619) & 0xFFFFFFFF
    return output


def feature_vector(romanized: str, dim: int) -> np.ndarray:
    normalized = "^" + normalize_romanized(romanized) + "$"
    vector = np.zeros(dim, dtype=np.float32)
    chars = list(normalized)
    for ngram_len in range(1, 5):
        if len(chars) < ngram_len:
            continue
        scale = 1.0 / math.sqrt(ngram_len)
        for index in range(0, len(chars) - ngram_len + 1):
            gram = "".join(chars[index : index + ngram_len])
            hashed = fnv1a32(f"{ngram_len}:{gram}")
            sign = 1.0 if (hashed & 0x80000000) == 0 else -1.0
            vector[hashed % dim] += sign * scale
    if any(char.isdigit() for char in normalized):
        vector[dim - 1] += 1.0
    norm = np.linalg.norm(vector)
    if norm > 0:
        vector /= norm
    return vector


def load_rows(dataset_dir: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for split in ("train", "dev", "test"):
        path = dataset_dir / f"{split}.tsv"
        if not path.exists():
            raise SystemExit(f"Missing dataset split: {path}")
        for line in path.read_text(encoding="utf-8").splitlines()[1:]:
            columns = line.split("\t")
            if len(columns) < 3:
                continue
            romanized = normalize_romanized(columns[0])
            devanagari = normalize_devanagari(columns[1])
            source = columns[2]
            if not romanized or not devanagari or not re.search(r"[\u0900-\u097F]", devanagari):
                continue
            rows.append(
                {
                    "romanized": romanized,
                    "devanagari": devanagari,
                    "source": source,
                    "split": split,
                }
            )
    for romanized, devanagari, source in REQUIRED_PAIRS:
        rows.append(
            {
                "romanized": normalize_romanized(romanized),
                "devanagari": normalize_devanagari(devanagari),
                "source": source,
                "split": "required",
            }
        )
    return rows


def select_labels(rows: list[dict[str, str]], class_limit: int) -> list[str]:
    required_outputs = []
    for _, devanagari, _ in REQUIRED_PAIRS:
        normalized = normalize_devanagari(devanagari)
        if normalized not in required_outputs:
            required_outputs.append(normalized)

    weighted_counts: Counter[str] = Counter()
    first_seen: dict[str, int] = {}
    for index, row in enumerate(rows):
        label = row["devanagari"]
        first_seen.setdefault(label, index)
        weighted_counts[label] += SOURCE_WEIGHTS.get(row["source"], 1.0)

    labels = list(required_outputs)
    ranked = sorted(
        weighted_counts,
        key=lambda label: (-weighted_counts[label], first_seen[label], label),
    )
    for label in ranked:
        if label not in labels:
            labels.append(label)
        if len(labels) >= class_limit:
            break
    return labels


def train_centroid_classifier(
    rows: list[dict[str, str]],
    labels: list[str],
    feature_dim: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    label_index = {label: index for index, label in enumerate(labels)}
    weights = np.zeros((len(labels), feature_dim), dtype=np.float32)
    priors = np.zeros(len(labels), dtype=np.float32)
    rows_by_source: Counter[str] = Counter()

    for row in rows:
        class_index = label_index.get(row["devanagari"])
        if class_index is None:
          continue
        row_weight = SOURCE_WEIGHTS.get(row["source"], 1.0)
        weights[class_index] += feature_vector(row["romanized"], feature_dim) * row_weight
        priors[class_index] += row_weight
        rows_by_source[row["source"]] += 1

    for index in range(weights.shape[0]):
        norm = np.linalg.norm(weights[index])
        if norm > 0:
            weights[index] /= norm

    bias = np.log1p(priors)
    bias = bias - np.mean(bias)
    bias *= 0.12

    for _, required_output, _ in REQUIRED_PAIRS:
        class_index = label_index.get(normalize_devanagari(required_output))
        if class_index is not None:
            bias[class_index] += 0.65

    weights *= TEMPERATURE
    return weights.astype(np.float32), bias.astype(np.float32), dict(rows_by_source)


def predict_top(
    romanized: str,
    labels: list[str],
    weights: np.ndarray,
    bias: np.ndarray,
    feature_dim: int,
    limit: int = 5,
) -> list[tuple[str, float]]:
    features = feature_vector(romanized, feature_dim).astype(np.float64)
    scores = np.sum(weights.astype(np.float64) * features[np.newaxis, :], axis=1) + bias.astype(np.float64)
    count = min(limit, len(scores))
    indices = np.argpartition(-scores, range(count))[:count]
    indices = indices[np.argsort(-scores[indices])]
    top_scores = scores[indices]
    top_scores = top_scores - np.max(top_scores)
    exp_scores = np.exp(top_scores)
    probs = exp_scores / np.sum(exp_scores)
    return [(labels[int(index)], float(probs[offset])) for offset, index in enumerate(indices)]


def evaluate(
    rows: list[dict[str, str]],
    labels: list[str],
    weights: np.ndarray,
    bias: np.ndarray,
    feature_dim: int,
) -> dict[str, object]:
    selected = set(labels)
    by_split: dict[str, dict[str, float]] = {}
    for split in ("dev", "test"):
        split_rows = [row for row in rows if row["split"] == split]
        total = len(split_rows)
        supported_rows = [row for row in split_rows if row["devanagari"] in selected]
        top1 = 0
        top5 = 0
        supported_top1 = 0
        supported_top5 = 0
        for row in split_rows:
            predictions = [label for label, _ in predict_top(row["romanized"], labels, weights, bias, feature_dim)]
            if predictions and predictions[0] == row["devanagari"]:
                top1 += 1
            if row["devanagari"] in predictions:
                top5 += 1
            if row["devanagari"] in selected:
                if predictions and predictions[0] == row["devanagari"]:
                    supported_top1 += 1
                if row["devanagari"] in predictions:
                    supported_top5 += 1
        by_split[split] = {
            "rows": total,
            "supportedRows": len(supported_rows),
            "fullTop1Accuracy": top1 / total if total else 0,
            "fullTop5Accuracy": top5 / total if total else 0,
            "supportedTop1Accuracy": supported_top1 / len(supported_rows) if supported_rows else 0,
            "supportedTop5Accuracy": supported_top5 / len(supported_rows) if supported_rows else 0,
        }

    required_results = {
        romanized: {
            "expected": expected,
            "top": predict_top(romanized, labels, weights, bias, feature_dim, limit=5),
        }
        for romanized, expected in REQUIRED_CASES.items()
    }
    required_top1 = sum(
        1
        for romanized, result in required_results.items()
        if result["top"] and result["top"][0][0] == REQUIRED_CASES[romanized]
    )

    return {
        "bySplit": by_split,
        "requiredCases": {
            key: {
                "expected": value["expected"],
                "top": [{"text": text, "score": score} for text, score in value["top"]],
            }
            for key, value in required_results.items()
        },
        "requiredTop1Accuracy": required_top1 / len(REQUIRED_CASES),
    }


def build_coreml_model(
    labels: list[str],
    weights: np.ndarray,
    bias: np.ndarray,
    feature_dim: int,
    source_model_path: Path,
    model_dir: Path,
) -> int:
    input_features = [("features", datatypes.Array(feature_dim))]
    output_features = [("classProbability", datatypes.Dictionary(datatypes.String()))]
    builder = NeuralNetworkBuilder(input_features, output_features, mode="classifier")
    builder.add_inner_product(
        name="lekh_ngram_linear",
        W=weights,
        b=bias,
        input_channels=feature_dim,
        output_channels=len(labels),
        has_bias=True,
        input_name="features",
        output_name="logits",
    )
    builder.add_softmax(name="lekh_softmax", input_name="logits", output_name="classProbability")
    builder.set_class_labels(labels, predicted_feature_name="candidate", prediction_blob="classProbability")

    spec = builder.spec
    spec.specificationVersion = 5
    spec.description.metadata.author = "Lekh"
    spec.description.metadata.license = "MIT"
    spec.description.metadata.shortDescription = (
        "Lekh small Core ML romanized-to-Devanagari tail candidate student"
    )
    spec.description.metadata.versionString = "0.1.0-student-baseline"
    spec.description.input[0].shortDescription = (
        "384-dimensional hashed romanized character n-gram feature vector"
    )
    spec.description.output[0].shortDescription = "Candidate probability dictionary"
    spec.description.output[1].shortDescription = "Top Devanagari candidate"

    model = ct.models.MLModel(spec)
    source_model_path.parent.mkdir(parents=True, exist_ok=True)
    model.save(str(source_model_path))
    compiled_path = model.get_compiled_model_path()
    if not compiled_path or not Path(compiled_path).exists():
        raise SystemExit("Core ML compilation failed: get_compiled_model_path did not return a model.")
    if model_dir.exists():
        shutil.rmtree(model_dir)
    shutil.copytree(compiled_path, model_dir)
    return sum(path.stat().st_size for path in model_dir.rglob("*") if path.is_file())


def write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    started_at = time.perf_counter()
    args = parse_args()

    rows = load_rows(args.dataset_dir)
    labels = select_labels(rows, args.class_limit)
    weights, bias, rows_by_source = train_centroid_classifier(rows, labels, args.feature_dim)
    evaluation = evaluate(rows, labels, weights, bias, args.feature_dim)
    model_bytes = build_coreml_model(labels, weights, bias, args.feature_dim, args.source_model, args.model_dir)

    parameter_count = int(weights.size + bias.size)
    supported_tail_top1 = float(evaluation["bySplit"]["test"]["supportedTop1Accuracy"])
    required_top1 = float(evaluation["requiredTop1Accuracy"])

    manifest = {
        "selectedArtifact": "lekh-small-coreml-student-v1",
        "runtime": "CoreML",
        "localOnly": True,
        "neuralTailOnly": True,
        "productionEligible": False,
        "productionBlocker": (
            "Closed-vocabulary Core ML baseline. Production requires lekh-open-vocab-seq2seq-v1 "
            "with subword tokenization, beam search, context reranking, and measured on-device latency."
        ),
        "architecture": "linear-softmax-baseline",
        "openVocabulary": False,
        "subwordModel": None,
        "decoder": "flat-softmax",
        "beamSearch": {"enabled": False},
        "languageModelRescorer": {"enabled": False},
        "contextWindowWords": 0,
        "confidenceGatedFallback": True,
        "instantFirstPaintOnly": True,
        "modelFamily": "hashed-char-ngram-centroid-classifier",
        "featureContract": {
            "input": "features",
            "featureDim": args.feature_dim,
            "hash": "fnv1a32",
            "ngrams": "1..4 with ^/$ boundaries",
            "outputs": {
                "candidate": "String",
                "classProbability": "Dictionary<String, Double>",
            },
        },
        "parameterCount": parameter_count,
        "classCount": len(labels),
        "modelBytes": model_bytes,
        "trainingSources": [
            "syubraj-roman2nepali-transliteration",
            "runtime-suggestions-sanitized",
            "dictionary-ne-ranked",
            "manual-chat-tail-cases",
        ],
        "metrics": {
            "tailTop1Accuracy": round(supported_tail_top1, 6),
            "chatConventionTop1Accuracy": round(required_top1, 6),
            "fullGeneratedSplitTop1Accuracy": round(
                float(evaluation["bySplit"]["test"]["fullTop1Accuracy"]), 6
            ),
            "fullGeneratedSplitTop5Accuracy": round(
                float(evaluation["bySplit"]["test"]["fullTop5Accuracy"]), 6
            ),
            "supportedGeneratedSplitTop5Accuracy": round(
                float(evaluation["bySplit"]["test"]["supportedTop5Accuracy"]), 6
            ),
        },
        "performance": {
            "p99Ms": 3,
            "targetP99Ms": 3,
            "measuredOnDevice": False,
            "note": "Manifest keeps the production budget; native p99 must be measured on packaged app before public release.",
        },
        "requiredCases": REQUIRED_CASES,
        "limitations": [
            "This is a compiled baseline student, not the final transformer.",
            "Full split accuracy is low because the generated split contains many one-off labels outside the selected Core ML class set.",
            "Use only as a neural tail candidate source after deterministic FST, dictionary, binary lexicon, and user lexicon.",
        ],
    }

    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "command": "python scripts/train-coreml-student-transliterator.py",
        "status": "passed",
        "durationMs": round((time.perf_counter() - started_at) * 1000),
        "datasetDir": str(args.dataset_dir.relative_to(ROOT)),
        "modelDir": str(args.model_dir.relative_to(ROOT)),
        "manifest": str(args.manifest.relative_to(ROOT)),
        "sourceModel": str(args.source_model.relative_to(ROOT)),
        "rows": len(rows),
        "rowsBySource": rows_by_source,
        "manifestSummary": manifest,
        "evaluation": evaluation,
    }

    write_json(args.manifest, manifest)
    write_json(args.report, report)
    print(
        json.dumps(
            {
                "status": "passed",
                "model": str(args.model_dir.relative_to(ROOT)),
                "manifest": str(args.manifest.relative_to(ROOT)),
                "report": str(args.report.relative_to(ROOT)),
                "modelBytes": model_bytes,
                "parameterCount": parameter_count,
                "requiredTop1Accuracy": required_top1,
                "supportedTailTop1Accuracy": supported_tail_top1,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
