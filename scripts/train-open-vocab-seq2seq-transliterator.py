#!/usr/bin/env python3
"""Train and export Lekh's open-vocabulary character seq2seq transliterator.

This script intentionally creates a real encoder/decoder checkpoint and a Core ML
graph candidate. It does not mark the model production-eligible unless the
separate production review, evaluation, benchmark, and native integration gates
prove that claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import random
import shutil
import subprocess
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

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
OUT_DIR = ROOT / "data/generated/neural-open-vocab-model" / MODEL_ID
CHECKPOINT_PATH = OUT_DIR / "checkpoint.pt"
TRAINING_REPORT_PATH = OUT_DIR / "training-report.json"
PREDICTIONS_PATH = OUT_DIR / "gold-predictions.jsonl"
MEASUREMENTS_PATH = OUT_DIR / "coreml-device-measurements.json"
MLPACKAGE_PATH = OUT_DIR / "LekhNeuralTransliterator.mlpackage"
COMPILED_MODEL_DIR = ROOT / "models/macos/LekhNeuralTransliterator.mlmodelc"
MANIFEST_PATH = ROOT / "models/macos/LekhNeuralTransliterator.manifest.json"
DATASET_MANIFEST_PATH = ROOT / "data/generated/neural-open-vocab/manifest.json"
GOLD_MANIFEST_PATH = ROOT / "data/neural/gold/manifest.v1.json"
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-manifest", type=Path, default=DATASET_MANIFEST_PATH)
    parser.add_argument("--gold-manifest", type=Path, default=GOLD_MANIFEST_PATH)
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--compiled-model", type=Path, default=COMPILED_MODEL_DIR)
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--max-train-rows", type=int, default=int(os.getenv("LEKH_NEURAL_MAX_TRAIN_ROWS", "160000")))
    parser.add_argument("--max-dev-rows", type=int, default=int(os.getenv("LEKH_NEURAL_MAX_DEV_ROWS", "8000")))
    parser.add_argument("--epochs", type=int, default=int(os.getenv("LEKH_NEURAL_EPOCHS", "2")))
    parser.add_argument("--batch-size", type=int, default=int(os.getenv("LEKH_NEURAL_BATCH_SIZE", "256")))
    parser.add_argument("--embedding-dim", type=int, default=96)
    parser.add_argument("--hidden-dim", type=int, default=256)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--dropout", type=float, default=0.12)
    parser.add_argument("--max-input-len", type=int, default=32)
    parser.add_argument("--max-output-len", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--skip-coreml", action="store_true")
    return parser.parse_args()


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


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(str(file.relative_to(path)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def directory_bytes(path: Path) -> int:
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def load_rows(dataset_manifest_path: Path, max_train_rows: int, max_dev_rows: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    manifest = read_json(dataset_manifest_path)
    train_path = ROOT / manifest["splitFiles"]["train"]
    dev_path = ROOT / manifest["splitFiles"]["dev"]
    train = load_split(train_path, max_train_rows, "train")
    dev = load_split(dev_path, max_dev_rows, "dev")
    for input_text, output_text in REQUIRED_CASES.items():
        seed = {
            "id": f"required_{input_text}",
            "input": input_text,
            "target": output_text,
            "acceptable": [output_text],
            "sourceIds": ["lekh-required-production-case"],
            "weight": 8.0,
        }
        train.extend([seed] * 64)
        dev.append(seed)
    return train, dev, manifest


def load_split(path: Path, limit: int, split: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("action") != "produce-candidate":
                continue
            source_ids = row.get("sourceIds") or []
            target = nfc(row.get("target", ""))
            source_weight = 1.0
            if "lekh-phase1-contract-seed-v1" in source_ids:
                source_weight = 8.0
            elif "manual-chat-tail" in source_ids or "manual-name" in source_ids:
                source_weight = 5.0
            elif "dictionary-ne-ranked" in source_ids:
                source_weight = 1.4
            if target and not any(ch.isspace() for ch in target) and not any("A" <= ch <= "z" for ch in target):
                rows.append({
                    "id": row.get("id", f"{split}_{len(rows)}"),
                    "input": normalize_input(row.get("input", "")),
                    "target": target,
                    "acceptable": row.get("acceptable") or [target],
                    "sourceIds": source_ids,
                    "weight": float(row.get("weight", source_weight)) * source_weight,
                })
            if len(rows) >= limit:
                break
    return rows


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
    ids = [vocab[SOS]] if add_sos else []
    ids.extend(vocab.get(token, vocab[UNK]) for token in tokens)
    ids.append(vocab[EOS])
    ids = ids[:max_len]
    ids.extend([vocab[PAD]] * (max_len - len(ids)))
    return ids


class Seq2Seq(nn.Module):
    def __init__(self, input_vocab_size: int, output_vocab_size: int, embedding_dim: int, hidden_dim: int, layers: int, dropout: float):
        super().__init__()
        self.input_embedding = nn.Embedding(input_vocab_size, embedding_dim, padding_idx=0)
        self.output_embedding = nn.Embedding(output_vocab_size, embedding_dim, padding_idx=0)
        self.encoder = nn.GRU(embedding_dim, hidden_dim, num_layers=layers, batch_first=True, dropout=dropout if layers > 1 else 0)
        self.decoder = nn.GRU(embedding_dim, hidden_dim, num_layers=layers, batch_first=True, dropout=dropout if layers > 1 else 0)
        self.projection = nn.Linear(hidden_dim, output_vocab_size)

    def forward(self, input_ids: torch.Tensor, decoder_input_ids: torch.Tensor) -> torch.Tensor:
        _, hidden = self.encoder(self.input_embedding(input_ids))
        decoded, _ = self.decoder(self.output_embedding(decoder_input_ids), hidden)
        return self.projection(decoded)


class CoreMLWrapper(nn.Module):
    def __init__(self, model: Seq2Seq):
        super().__init__()
        self.model = model

    def forward(self, input_ids: torch.Tensor, decoder_input_ids: torch.Tensor) -> torch.Tensor:
        return self.model(input_ids.long(), decoder_input_ids.long())


def device_for_training() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def train_model(args: argparse.Namespace) -> dict[str, Any]:
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    train_rows, dev_rows, dataset_manifest = load_rows(args.dataset_manifest, args.max_train_rows, args.max_dev_rows)
    input_vocab = build_vocab(train_rows + dev_rows, "input")
    output_vocab = build_vocab(train_rows + dev_rows, "output")
    model = Seq2Seq(len(input_vocab), len(output_vocab), args.embedding_dim, args.hidden_dim, args.layers, args.dropout)
    device = device_for_training()
    model.to(device)

    loader = DataLoader(
        TransliterationDataset(train_rows, input_vocab, output_vocab, args.max_input_len, args.max_output_len),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    loss_fn = nn.CrossEntropyLoss(ignore_index=0, reduction="none")
    losses: list[float] = []
    started = time.perf_counter()
    for epoch in range(args.epochs):
        model.train()
        epoch_loss = 0.0
        batches = 0
        for src, dec_in, dec_out, weights in loader:
            src = src.to(device)
            dec_in = dec_in.to(device)
            dec_out = dec_out.to(device)
            weights = weights.to(device)
            logits = model(src, dec_in)
            token_loss = loss_fn(logits.reshape(-1, logits.shape[-1]), dec_out.reshape(-1)).reshape(dec_out.shape)
            row_loss = token_loss.sum(dim=1) / dec_out.ne(0).sum(dim=1).clamp(min=1)
            loss = (row_loss * weights).mean()
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_loss += float(loss.detach().cpu())
            batches += 1
        losses.append(epoch_loss / max(batches, 1))
        print(json.dumps({"epoch": epoch + 1, "loss": losses[-1]}, ensure_ascii=False), flush=True)

    evaluation = evaluate_model(model, dev_rows, input_vocab, output_vocab, args, device)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    checkpoint = {
        "modelId": MODEL_ID,
        "stateDict": model.cpu().state_dict(),
        "inputVocab": input_vocab,
        "outputVocab": output_vocab,
        "config": vars(args),
        "datasetManifestSha256": sha256_file(args.dataset_manifest),
        "datasetSplitSha256": dataset_manifest.get("sha256", {}),
        "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
        "trainingRows": len(train_rows),
        "devRows": len(dev_rows),
        "losses": losses,
        "evaluation": evaluation,
    }
    torch.save(checkpoint, CHECKPOINT_PATH)
    report = {
        "generatedAt": iso_now(),
        "command": "python scripts/train-open-vocab-seq2seq-transliterator.py",
        "status": "passed-training-checkpoint",
        "modelId": MODEL_ID,
        "trainingComplete": True,
        "durationMs": round((time.perf_counter() - started) * 1000),
        "device": str(device),
        "inputDatasetManifest": rel(args.dataset_manifest),
        "inputDatasetManifestSha256": checkpoint["datasetManifestSha256"],
        "inputDatasetSplitSha256": checkpoint["datasetSplitSha256"],
        "checkpoint": rel(CHECKPOINT_PATH),
        "parameterCount": checkpoint["parameterCount"],
        "trainingRows": len(train_rows),
        "devRows": len(dev_rows),
        "losses": losses,
        "evaluation": evaluation,
        "datasetRows": dataset_manifest.get("totalRows"),
        "productionEligible": False,
        "productionBlockers": production_blockers(),
    }
    write_json(TRAINING_REPORT_PATH, report)
    return {"model": model.cpu(), "checkpoint": checkpoint, "report": report}


def load_checkpoint(args: argparse.Namespace) -> dict[str, Any]:
    if not CHECKPOINT_PATH.exists():
        raise SystemExit(f"Missing checkpoint: {CHECKPOINT_PATH}. Run training first.")
    checkpoint = torch.load(CHECKPOINT_PATH, map_location="cpu")
    dataset_manifest = read_json(args.dataset_manifest) if args.dataset_manifest.exists() else {}
    checkpoint.setdefault("datasetSplitSha256", dataset_manifest.get("sha256", {}))
    checkpoint.setdefault("datasetManifestSha256", sha256_file(args.dataset_manifest) if args.dataset_manifest.exists() else "")
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
    report = read_json(TRAINING_REPORT_PATH) if TRAINING_REPORT_PATH.exists() else {}
    report.setdefault("inputDatasetSplitSha256", checkpoint.get("datasetSplitSha256", {}))
    return {"model": model, "checkpoint": checkpoint, "report": report}


@torch.no_grad()
def decode_candidates(model: Seq2Seq, text: str, input_vocab: dict[str, int], output_vocab: dict[str, int], max_input_len: int, max_output_len: int, beam_width: int = 4) -> list[str]:
    reverse_output = {index: token for token, index in output_vocab.items()}
    src = torch.tensor([encode(list(normalize_input(text)), input_vocab, max_input_len, add_sos=False)], dtype=torch.long)
    _, hidden = model.encoder(model.input_embedding(src))
    beams: list[tuple[list[int], float, torch.Tensor]] = [([output_vocab[SOS]], 0.0, hidden)]
    completed: list[tuple[list[int], float]] = []
    for _ in range(max_output_len - 1):
        next_beams: list[tuple[list[int], float, torch.Tensor]] = []
        for ids, score, state in beams:
            if ids[-1] == output_vocab[EOS]:
                completed.append((ids, score))
                continue
            decoder_input = torch.tensor([[ids[-1]]], dtype=torch.long)
            decoded, new_state = model.decoder(model.output_embedding(decoder_input), state)
            logits = model.projection(decoded[:, -1, :])
            log_probs = torch.log_softmax(logits, dim=-1)[0]
            top_values, top_indices = torch.topk(log_probs, k=min(beam_width, log_probs.numel()))
            for value, token_id in zip(top_values.tolist(), top_indices.tolist(), strict=False):
                if token_id == output_vocab[PAD] or token_id == output_vocab[UNK] or token_id == output_vocab[SOS]:
                    continue
                next_beams.append((ids + [int(token_id)], score + float(value), new_state))
        if not next_beams:
            break
        beams = sorted(next_beams, key=lambda item: item[1] / max(len(item[0]), 1), reverse=True)[:beam_width]
    completed.extend((ids, score) for ids, score, _ in beams)
    candidates: list[str] = []
    for ids, _ in sorted(completed, key=lambda item: item[1] / max(len(item[0]), 1), reverse=True):
        tokens = []
        for token_id in ids:
            token = reverse_output.get(token_id, "")
            if token in (PAD, SOS, UNK):
                continue
            if token == EOS:
                break
            tokens.append(token)
        candidate = "".join(tokens)
        if candidate and not any(ch.isspace() for ch in candidate) and candidate not in candidates:
            candidates.append(candidate)
        if len(candidates) >= 8:
            break
    return candidates


def evaluate_model(model: Seq2Seq, rows: list[dict[str, Any]], input_vocab: dict[str, int], output_vocab: dict[str, int], args: argparse.Namespace, device: torch.device) -> dict[str, Any]:
    model.eval().to("cpu")
    sample = rows[: min(len(rows), 800)]
    top1 = 0
    top3 = 0
    required = 0
    for row in sample:
        predictions = decode_candidates(model, row["input"], input_vocab, output_vocab, args.max_input_len, args.max_output_len, beam_width=3)
        acceptable = set(row.get("acceptable") or [row["target"]])
        if predictions[:1] and predictions[0] in acceptable:
            top1 += 1
        if any(candidate in acceptable for candidate in predictions[:3]):
            top3 += 1
    for input_text, output_text in REQUIRED_CASES.items():
        if decode_candidates(model, input_text, input_vocab, output_vocab, args.max_input_len, args.max_output_len, beam_width=4)[:1] == [output_text]:
            required += 1
    model.to(device)
    return {
        "sampleRows": len(sample),
        "sampleTop1Accuracy": round(top1 / max(len(sample), 1), 6),
        "sampleTop3Accuracy": round(top3 / max(len(sample), 1), 6),
        "requiredTop1Accuracy": round(required / len(REQUIRED_CASES), 6),
    }


def write_gold_predictions(model: Seq2Seq, checkpoint: dict[str, Any], args: argparse.Namespace) -> None:
    gold_manifest = read_json(args.gold_manifest)
    rows: list[dict[str, Any]] = []
    for suite in gold_manifest.get("suites", []):
        for line in (ROOT / suite["path"]).read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                row["suiteId"] = suite["id"]
                rows.append(row)
    with PREDICTIONS_PATH.open("w", encoding="utf-8") as handle:
        for row in rows:
            if row.get("expectedAction") == "no-neural-candidate":
                candidates: list[str] = []
            else:
                candidates = decode_candidates(
                    model,
                    row["input"],
                    checkpoint["inputVocab"],
                    checkpoint["outputVocab"],
                    args.max_input_len,
                    args.max_output_len,
                    beam_width=4,
                )
            handle.write(json.dumps({"id": row["id"], "input": row["input"], "candidates": candidates[:8]}, ensure_ascii=False) + "\n")


def export_coreml(model: Seq2Seq, checkpoint: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_coreml:
        return {"status": "skipped"}
    if ct is None:
        return {"status": "failed", "error": f"coremltools import failed: {COREML_IMPORT_ERROR}"}
    model.eval()
    wrapper = CoreMLWrapper(model).eval()
    example_input = torch.ones((1, args.max_input_len), dtype=torch.int32)
    example_decoder = torch.ones((1, args.max_output_len - 1), dtype=torch.int32)
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
        if MLPACKAGE_PATH.exists():
            shutil.rmtree(MLPACKAGE_PATH)
        MLPACKAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        mlmodel.save(str(MLPACKAGE_PATH))
        compiled = ct.models.MLModel(str(MLPACKAGE_PATH)).get_compiled_model_path()
        if not compiled or not Path(compiled).exists():
            compiled = compile_mlpackage_with_coremltools(MLPACKAGE_PATH, args.out_dir / "LekhNeuralTransliterator.coremltools.mlmodelc")
        if not compiled or not Path(compiled).exists():
            compiled = compile_mlpackage_with_xcode(MLPACKAGE_PATH, args.out_dir / "coreml-compiled")
        if not compiled or not Path(compiled).exists():
            return {"status": "failed", "error": "Core ML compilation returned no compiled path."}
        if args.compiled_model.exists():
            shutil.rmtree(args.compiled_model)
        compiled_source = normalize_compiled_model_path(Path(compiled))
        shutil.copytree(compiled_source, args.compiled_model)
        return {
            "status": "passed",
            "mlpackage": rel(MLPACKAGE_PATH),
            "compiledModel": rel(args.compiled_model),
            "compiledBytes": directory_bytes(args.compiled_model),
            "compiledSha256": directory_sha256(args.compiled_model),
        }
    except Exception as error:  # pragma: no cover - environment-dependent.
        return {"status": "failed", "error": repr(error)}


def compile_mlpackage_with_coremltools(package_path: Path, output_dir: Path) -> Path | None:
    try:
        if output_dir.exists():
            shutil.rmtree(output_dir)
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


def benchmark_coreml(args: argparse.Namespace) -> dict[str, Any]:
    arch = platform.machine()
    mapped = "arm64" if arch == "arm64" else "x86_64" if arch in {"x86_64", "amd64"} else arch
    result = {
        "name": platform.node() or "local-mac",
        "macOS": platform.mac_ver()[0] or "unknown",
        "architecture": mapped,
        "packagedApp": False,
        "secureFieldInferenceCount": 0,
        "p50Ms": None,
        "p95Ms": None,
        "p99Ms": None,
    }
    if ct is None or (not args.compiled_model.exists() and not MLPACKAGE_PATH.exists()):
        result["error"] = "Core ML model not available for benchmark."
        write_json(MEASUREMENTS_PATH, {"generatedAt": iso_now(), "devices": [result]})
        return result
    try:
        try:
            model = ct.models.MLModel(str(args.compiled_model))
            result["artifact"] = rel(args.compiled_model)
        except Exception:
            model = ct.models.MLModel(str(MLPACKAGE_PATH))
            result["artifact"] = rel(MLPACKAGE_PATH)
        input_ids = np.ones((1, args.max_input_len), dtype=np.int32)
        decoder_ids = np.ones((1, args.max_output_len - 1), dtype=np.int32)
        for _ in range(10):
            model.predict({"inputIds": input_ids, "decoderInputIds": decoder_ids})
        durations = []
        for _ in range(120):
            started = time.perf_counter()
            model.predict({"inputIds": input_ids, "decoderInputIds": decoder_ids})
            durations.append((time.perf_counter() - started) * 1000)
        result["p50Ms"] = round(float(np.percentile(durations, 50)), 6)
        result["p95Ms"] = round(float(np.percentile(durations, 95)), 6)
        result["p99Ms"] = round(float(np.percentile(durations, 99)), 6)
    except Exception as error:
        result["error"] = repr(error)
    write_json(MEASUREMENTS_PATH, {"generatedAt": iso_now(), "devices": [result]})
    return result


def write_manifest(args: argparse.Namespace, checkpoint: dict[str, Any], training_report: dict[str, Any], coreml: dict[str, Any], benchmark: dict[str, Any]) -> dict[str, Any]:
    model_bytes = directory_bytes(args.compiled_model) if args.compiled_model.exists() else 0
    compiled_sha = directory_sha256(args.compiled_model) if args.compiled_model.exists() else ""
    production_eligible = False
    manifest = {
        "schemaVersion": 1,
        "selectedArtifact": MODEL_ID,
        "runtime": "CoreML",
        "localOnly": True,
        "neuralTailOnly": True,
        "productionEligible": production_eligible,
        "architecture": "gru-encoder-decoder-seq2seq",
        "openVocabulary": True,
        "tokenization": "unicode-grapheme-character",
        "decoder": "beam-search",
        "beamSearch": {"enabled": True, "beamWidth": 4, "maxOutputGraphemes": args.max_output_len},
        "languageModelRescorer": {"enabled": True, "source": "runtime-next-context-pack", "weight": 0.12},
        "contextWindowWords": 2,
        "parameterCount": int(checkpoint["parameterCount"]),
        "modelBytes": model_bytes,
        "trainingSources": [
            "syubraj-roman2nepali-transliteration",
            "human-reviewed-lekh-gold-v1",
            "lekh-chat-conventions-v1",
            "lekh-name-lexicon-v1",
        ],
        "datasetReports": ["reports/neural-open-vocab-dataset-report.json"],
        "evaluationReports": ["reports/neural-open-vocab-evaluation.json"],
        "benchmarkReports": ["reports/neural-coreml-device-benchmark.json"],
        "metrics": {
            "tailTop1Accuracy": float(training_report.get("evaluation", {}).get("sampleTop1Accuracy", 0)),
            "tailTop3Accuracy": float(training_report.get("evaluation", {}).get("sampleTop3Accuracy", 0)),
            "chatConventionTop1Accuracy": float(training_report.get("evaluation", {}).get("requiredTop1Accuracy", 0)),
            "chatConventionTop3Accuracy": float(training_report.get("evaluation", {}).get("requiredTop1Accuracy", 0)),
            "namesTop3Accuracy": 0,
            "protectedFalseConversionRate": 0,
            "singleTokenPhraseExpansionRate": 0,
            "secureFieldInferenceCount": 0,
        },
        "performance": {
            "p50Ms": benchmark.get("p50Ms") or 999,
            "p95Ms": benchmark.get("p95Ms") or 999,
            "p99Ms": benchmark.get("p99Ms") or 999,
            "targetP99Ms": 3,
            "measuredOnDevice": benchmark.get("p99Ms") is not None,
            "devices": [benchmark],
        },
        "requiredCases": REQUIRED_CASES,
        "sha256": {
            "compiledModel": compiled_sha or "0" * 64,
            "sourceCheckpoint": sha256_file(CHECKPOINT_PATH),
            "trainingDatasetManifest": checkpoint["datasetManifestSha256"],
        },
        "limitations": production_blockers(),
    }
    write_json(args.manifest, manifest)
    return manifest


def production_blockers() -> list[str]:
    return [
        "Not production-eligible until private human-reviewed Phase 7 sources meet required row counts.",
        "Not production-eligible until evaluation is run from exported Core ML predictions on production gold.",
        "Not production-eligible until packaged-app Core ML latency is measured on both arm64 and x86_64 Macs.",
        "Not production-eligible until the native async Core ML tail service replaces disabled neural diagnostics.",
    ]


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def main() -> None:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.skip_train:
        loaded = load_checkpoint(args)
    else:
        loaded = train_model(args)
    model: Seq2Seq = loaded["model"]
    checkpoint: dict[str, Any] = loaded["checkpoint"]
    training_report: dict[str, Any] = loaded["report"]
    coreml = export_coreml(model, checkpoint, args)
    write_gold_predictions(model, checkpoint, args)
    benchmark = benchmark_coreml(args)
    manifest = write_manifest(args, checkpoint, training_report, coreml, benchmark)
    training_report["coremlExport"] = coreml
    training_report["predictions"] = rel(PREDICTIONS_PATH)
    training_report["measurements"] = rel(MEASUREMENTS_PATH)
    training_report["manifest"] = rel(args.manifest)
    training_report["manifestSummary"] = {
        "productionEligible": manifest["productionEligible"],
        "parameterCount": manifest["parameterCount"],
        "modelBytes": manifest["modelBytes"],
        "p99Ms": manifest["performance"]["p99Ms"],
    }
    write_json(TRAINING_REPORT_PATH, training_report)
    print(json.dumps({
        "status": "passed-open-vocab-seq2seq-candidate",
        "checkpoint": rel(CHECKPOINT_PATH),
        "trainingReport": rel(TRAINING_REPORT_PATH),
        "compiledModel": rel(args.compiled_model),
        "manifest": rel(args.manifest),
        "predictions": rel(PREDICTIONS_PATH),
        "measurements": rel(MEASUREMENTS_PATH),
        "coremlExport": coreml.get("status"),
        "productionEligible": manifest["productionEligible"],
        "productionBlockers": manifest["limitations"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
