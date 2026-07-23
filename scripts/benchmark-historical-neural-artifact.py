#!/usr/bin/env python3
"""Measure the quarantined neural artifact on a locked benchmark.

This command is intentionally incapable of declaring production eligibility. It
exists only to establish a content-addressed baseline that a clean retraining or
challenger architecture must beat.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import time
import unicodedata
from pathlib import Path
from typing import Any

import coremltools as ct
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PAD = "<pad>"
SOS = "<s>"
EOS = "</s>"
UNK = "<unk>"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-quarantined-historical-artifact", action="store_true")
    parser.add_argument(
        "--benchmark-manifest",
        type=Path,
        default=ROOT / "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
    )
    parser.add_argument(
        "--artifact-manifest",
        type=Path,
        default=ROOT / "models/macos/LekhNeuralTransliterator.manifest.json",
    )
    parser.add_argument(
        "--vocab",
        type=Path,
        default=ROOT / "models/macos/LekhNeuralTransliterator.vocab.json",
    )
    parser.add_argument(
        "--compiled-model",
        type=Path,
        default=ROOT / "models/macos/LekhNeuralTransliterator.mlmodelc",
    )
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=ROOT / "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/checkpoint.pt",
    )
    parser.add_argument("--beam-width", type=int, default=4)
    parser.add_argument("--maximum-candidates", type=int, default=4)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--predictions", type=Path, default=ROOT / ".tmp/neural-historical-aksharantar-predictions.jsonl")
    parser.add_argument("--report", type=Path, default=ROOT / "reports/neural-historical-aksharantar-baseline.json")
    args = parser.parse_args()
    if not args.allow_quarantined_historical_artifact:
        raise SystemExit("Refusing to measure a quarantined artifact without --allow-quarantined-historical-artifact.")
    if args.beam_width < 1 or args.maximum_candidates < 1 or args.maximum_candidates > args.beam_width:
        raise SystemExit("Beam width and maximum candidates must be positive, with candidates <= beam width.")
    if args.limit is not None and args.limit < 1:
        raise SystemExit("--limit must be positive when supplied.")
    return args


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"Expected a JSON object: {path}")
    return value


def display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path.resolve())


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    files = sorted(item for item in path.rglob("*") if item.is_file())
    if not files:
        raise SystemExit(f"Compiled model contains no files: {path}")
    for item in files:
        if item.is_symlink():
            raise SystemExit(f"Compiled model contains a symbolic link: {item}")
        digest.update(item.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with item.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def corpus_sha256(suites: list[dict[str, Any]]) -> str:
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


def load_benchmark(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = read_json(path)
    suites = manifest.get("suites")
    if manifest.get("schemaVersion") != 2 or not isinstance(suites, list) or not suites:
        raise SystemExit("Benchmark requires a non-empty schema-v2 manifest.")
    if manifest.get("trainingUse") != "forbidden-evaluation-only":
        raise SystemExit("Refusing a benchmark that is not explicitly evaluation-only.")
    if manifest.get("corpusSha256") != corpus_sha256(suites):
        raise SystemExit("Benchmark corpus digest is stale.")
    rows: list[dict[str, Any]] = []
    inputs: set[str] = set()
    ids: set[str] = set()
    for suite in suites:
        suite_path = ROOT / str(suite.get("path", ""))
        if file_sha256(suite_path) != suite.get("sha256"):
            raise SystemExit(f"Benchmark suite digest mismatch: {suite.get('id')}")
        lines = [line for line in suite_path.read_text(encoding="utf-8").splitlines() if line]
        if len(lines) != suite.get("rows"):
            raise SystemExit(f"Benchmark suite row-count mismatch: {suite.get('id')}")
        for line in lines:
            row = json.loads(line)
            input_identity = normalize_input(row.get("input", ""))
            if row.get("id") in ids or input_identity in inputs:
                raise SystemExit("Benchmark metric identities are not unique.")
            ids.add(row.get("id"))
            inputs.add(input_identity)
            rows.append({**row, "suiteId": suite["id"]})
    return manifest, rows


def normalize_input(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFC", str(value or "")).strip().lower().split())


def encode_input(text: str, vocab: dict[str, Any]) -> np.ndarray | None:
    ids_by_token = vocab["input"]["idsByToken"]
    maximum = int(vocab["input"]["maxLength"])
    normalized = normalize_input(text)
    if not normalized or len(normalized) > maximum - 1:
        return None
    token_ids: list[int] = []
    for token in normalized:
        token_id = ids_by_token.get(token, ids_by_token[UNK])
        if token_id == ids_by_token[UNK]:
            return None
        token_ids.append(int(token_id))
    token_ids.append(int(ids_by_token[EOS]))
    token_ids.extend([int(ids_by_token[PAD])] * (maximum - len(token_ids)))
    return np.asarray([token_ids], dtype=np.int32)


def log_softmax(values: np.ndarray) -> np.ndarray:
    maximum = float(np.max(values))
    shifted = values.astype(np.float64, copy=False) - maximum
    return values.astype(np.float64, copy=False) - (maximum + math.log(float(np.exp(shifted).sum())))


def candidate_rank(item: tuple[list[int], float]) -> tuple[float, tuple[int, ...]]:
    ids, score = item
    return (-score / max(len(ids), 1), tuple(ids))


def decode_candidates(
    model: Any,
    input_ids: np.ndarray,
    input_length: int,
    vocab: dict[str, Any],
    beam_width: int,
    maximum_candidates: int,
) -> list[str]:
    output = vocab["output"]
    ids_by_token = output["idsByToken"]
    tokens_by_id = output["tokensById"]
    pad_id = int(ids_by_token[PAD])
    sos_id = int(ids_by_token[SOS])
    eos_id = int(ids_by_token[EOS])
    unk_id = int(ids_by_token[UNK])
    decoder_length = int(output["maxLength"]) - 1
    maximum_steps = min(decoder_length, input_length + 8)
    beams: list[tuple[list[int], float]] = [([sos_id], 0.0)]
    completed: list[tuple[list[int], float]] = []
    invalid_ids = {pad_id, sos_id, unk_id}
    for _ in range(maximum_steps):
        next_beams: list[tuple[list[int], float]] = []
        for prefix, score in beams:
            if prefix[-1] == eos_id:
                completed.append((prefix, score))
                continue
            decoder_ids = prefix + [pad_id] * (decoder_length - len(prefix))
            result = model.predict({
                "inputIds": input_ids,
                "decoderInputIds": np.asarray([decoder_ids], dtype=np.int32),
            })
            logits = np.asarray(result["logits"])
            step = len(prefix) - 1
            if logits.shape != (1, decoder_length, len(tokens_by_id)) or not np.isfinite(logits).all():
                raise SystemExit(f"Compiled model returned invalid logits: {logits.shape}")
            probabilities = log_softmax(logits[0, step, :])
            eligible = [token_id for token_id in range(len(tokens_by_id)) if token_id not in invalid_ids]
            eligible.sort(key=lambda token_id: (-float(probabilities[token_id]), token_id))
            for token_id in eligible[:beam_width]:
                next_beams.append((prefix + [token_id], score + float(probabilities[token_id])))
        if not next_beams:
            break
        beams = sorted(next_beams, key=candidate_rank)[:beam_width]
    ranked = sorted(completed + beams, key=candidate_rank)
    candidates: list[str] = []
    for token_ids, _ in ranked:
        parts = []
        for token_id in token_ids:
            token = tokens_by_id[token_id]
            if token in (PAD, SOS, UNK):
                continue
            if token == EOS:
                break
            parts.append(token)
        candidate = "".join(parts)
        if candidate and not any(character.isspace() for character in candidate) and not any("a" <= character.lower() <= "z" for character in candidate):
            if candidate not in candidates:
                candidates.append(candidate)
        if len(candidates) >= maximum_candidates:
            break
    return candidates


def graphemes(value: str) -> list[str]:
    output: list[str] = []
    for character in unicodedata.normalize("NFC", value):
        if output and ("\u093c" <= character <= "\u094d" or "\u0951" <= character <= "\u0957" or character in "ँंः"):
            output[-1] += character
        else:
            output.append(character)
    return output


def edit_distance(left: list[str], right: list[str]) -> int:
    previous = list(range(len(right) + 1))
    for left_index, left_value in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_value in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_value != right_value),
            ))
        previous = current
    return previous[-1]


def metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    top1 = 0
    top3 = 0
    reciprocal_rank = 0.0
    character_error = 0.0
    for row in rows:
        acceptable = set(row["acceptable"])
        candidates = row["candidates"]
        if candidates[:1] and candidates[0] in acceptable:
            top1 += 1
        if any(candidate in acceptable for candidate in candidates[:3]):
            top3 += 1
        rank = next((index for index, candidate in enumerate(candidates, start=1) if candidate in acceptable), None)
        if rank is not None:
            reciprocal_rank += 1.0 / rank
        predicted = candidates[0] if candidates else ""
        character_error += min(
            edit_distance(graphemes(predicted), graphemes(target)) / max(len(graphemes(target)), 1)
            for target in acceptable
        )
    count = len(rows)
    return {
        "rows": count,
        "top1Accuracy": round(top1 / max(count, 1), 6),
        "top3Accuracy": round(top3 / max(count, 1), 6),
        "meanReciprocalRank": round(reciprocal_rank / max(count, 1), 6),
        "characterErrorRate": round(character_error / max(count, 1), 6),
    }


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


def main() -> None:
    args = parse_args()
    artifact_manifest = read_json(args.artifact_manifest)
    vocab = read_json(args.vocab)
    benchmark_manifest, benchmark_rows = load_benchmark(args.benchmark_manifest)
    if args.limit is not None:
        benchmark_rows = benchmark_rows[: args.limit]
    observed_hashes = {
        "compiledModel": directory_sha256(args.compiled_model),
        "sourceCheckpoint": file_sha256(args.checkpoint),
        "vocabMetadata": file_sha256(args.vocab),
    }
    for key, observed in observed_hashes.items():
        if artifact_manifest.get("sha256", {}).get(key) != observed:
            raise SystemExit(f"Historical artifact hash mismatch: {key}")
    if artifact_manifest.get("productionEligible") is not False:
        raise SystemExit("Historical baseline command only accepts an explicitly production-ineligible artifact.")

    model = ct.models.CompiledMLModel(str(args.compiled_model), compute_units=ct.ComputeUnit.ALL)
    measured: list[dict[str, Any]] = []
    latencies: list[float] = []
    args.predictions.parent.mkdir(parents=True, exist_ok=True)
    with args.predictions.open("w", encoding="utf-8") as predictions:
        for index, row in enumerate(benchmark_rows, start=1):
            encoded = encode_input(row["input"], vocab)
            started = time.perf_counter()
            candidates = [] if encoded is None else decode_candidates(
                model,
                encoded,
                len(normalize_input(row["input"])),
                vocab,
                args.beam_width,
                args.maximum_candidates,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000
            latencies.append(elapsed_ms)
            prediction = {"id": row["id"], "input": row["input"], "candidates": candidates}
            predictions.write(json.dumps(prediction, ensure_ascii=False, separators=(",", ":")) + "\n")
            measured.append({**row, "candidates": candidates})
            if index % 100 == 0:
                print(json.dumps({"completed": index, "total": len(benchmark_rows)}), flush=True)

    suite_metrics = {
        suite_id: metrics([row for row in measured if row["suiteId"] == suite_id])
        for suite_id in sorted({row["suiteId"] for row in measured})
    }
    report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "command": "python scripts/benchmark-historical-neural-artifact.py --allow-quarantined-historical-artifact",
        "status": "measured-quarantined-historical-baseline",
        "promotionEligible": False,
        "modelId": artifact_manifest.get("selectedArtifact"),
        "architecture": artifact_manifest.get("architecture"),
        "parameterCount": artifact_manifest.get("parameterCount"),
        "artifactManifest": display_path(args.artifact_manifest),
        "artifactManifestSha256": file_sha256(args.artifact_manifest),
        "artifactHashes": observed_hashes,
        "benchmarkManifest": display_path(args.benchmark_manifest),
        "benchmarkManifestSha256": file_sha256(args.benchmark_manifest),
        "benchmarkCorpusSha256": benchmark_manifest["corpusSha256"],
        "predictions": display_path(args.predictions),
        "predictionsSha256": file_sha256(args.predictions),
        "beamWidth": args.beam_width,
        "maximumCandidates": args.maximum_candidates,
        "metrics": metrics(measured),
        "metricsBySuite": suite_metrics,
        "latencyMs": {
            "samples": len(latencies),
            "p50": round(statistics.median(latencies), 6),
            "p95": round(percentile(latencies, 0.95), 6),
            "p99": round(percentile(latencies, 0.99), 6),
            "maximum": round(max(latencies, default=0.0), 6),
        },
        "limitations": [
            "The checkpoint predates current leakage and provenance corrections and is permanently quarantined.",
            "This measurement is a historical comparison baseline, never production promotion evidence.",
            "Latency is measured from a Python/Core ML harness rather than the packaged input-method service.",
        ],
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "report": str(args.report), "metrics": report["metrics"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
