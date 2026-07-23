#!/usr/bin/env python3
"""Focused executable-contract tests for the open-vocabulary trainer."""

from __future__ import annotations

import importlib.util
import json
import math
import os
import platform
import tempfile
import unittest
from pathlib import Path
import torch
from torch import nn


SCRIPT_PATH = Path(__file__).with_name("train-open-vocab-seq2seq-transliterator.py")
SPEC = importlib.util.spec_from_file_location("lekh_open_vocab_trainer", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load trainer module from {SCRIPT_PATH}")
TRAINER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAINER)


def mark_checkpoint_loaded(path: str) -> None:
    Path(path).write_text("unsafe payload executed", encoding="utf-8")


class UnsafeCheckpointPayload:
    def __init__(self, marker_path: Path):
        self.marker_path = marker_path

    def __reduce__(self):
        return mark_checkpoint_loaded, (str(self.marker_path),)


class TrainerContractTests(unittest.TestCase):
    def test_config_defaults_and_override_precedence_are_bound(self) -> None:
        defaults = TRAINER.parse_args([], {})
        self.assertEqual(TRAINER.device_for_training(), torch.device("cpu"))
        self.assertEqual(defaults.hidden_dim, 256)
        self.assertEqual(defaults.epochs, 8)
        self.assertEqual(defaults.training_overrides, {})
        self.assertEqual(len(defaults.training_contract_sha256), 64)
        self.assertEqual(len(defaults.effective_training_config_sha256), 64)

        overridden = TRAINER.parse_args(
            ["--epochs", "3"],
            {"LEKH_NEURAL_EPOCHS": "2", "LEKH_NEURAL_HIDDEN_DIM": "128"},
        )
        self.assertEqual(overridden.epochs, 3)
        self.assertEqual(overridden.hidden_dim, 128)
        self.assertEqual(
            overridden.training_overrides["trainingRun.maximumEpochs"]["source"],
            "command-line",
        )
        self.assertEqual(
            overridden.training_overrides["architecture.hiddenDim"]["source"],
            "environment:LEKH_NEURAL_HIDDEN_DIM",
        )

        same_value = TRAINER.parse_args(["--epochs", "8"], {})
        self.assertNotIn("trainingRun.maximumEpochs", same_value.training_overrides)
        with self.assertRaisesRegex(SystemExit, "approved repository artifact directory"):
            TRAINER.parse_args(["--compiled-model", "/tmp/untrusted-model.mlmodelc"], {})

    def test_publication_lock_rejects_overlapping_runs_and_records_completion(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-run-lock-test-", dir=temporary_root) as directory:
            args = TRAINER.parse_args(["--out-dir", str(Path(directory) / "run")], {})
            with TRAINER.exclusive_run_lock(args) as lock_path:
                self.assertEqual(lock_path.stat().st_mode & 0o777, 0o600)
                with self.assertRaisesRegex(SystemExit, "owns the publication lock"):
                    with TRAINER.exclusive_run_lock(args):
                        self.fail("Overlapping run unexpectedly acquired the publication lock")

            lock_record = TRAINER.read_json(lock_path)
            self.assertEqual(lock_record["status"], "completed")
            self.assertEqual(lock_record["exportRunId"], args.export_run_id)

    def test_artifact_hashing_rejects_symlinks_and_special_files(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-artifact-type-test-", dir=temporary_root) as directory:
            root = Path(directory)
            regular = root / "regular.bin"
            regular.write_bytes(b"evidence")
            file_link = root / "linked.bin"
            file_link.symlink_to(regular)
            with self.assertRaisesRegex(SystemExit, "symbolic-link artifact"):
                TRAINER.sha256_file(file_link)

            model_dir = root / "Model.mlmodelc"
            model_dir.mkdir()
            (model_dir / "model.bin").write_bytes(b"compiled")
            (model_dir / "linked.bin").symlink_to(regular)
            with self.assertRaisesRegex(SystemExit, "contains a symbolic link"):
                TRAINER.directory_sha256(model_dir)

            (model_dir / "linked.bin").unlink()
            fifo = model_dir / "unexpected.fifo"
            os.mkfifo(fifo)
            with self.assertRaisesRegex(SystemExit, "contains a special file"):
                TRAINER.directory_bytes(model_dir)

    def test_shared_decoder_fixture_uses_log_softmax_and_stable_ties(self) -> None:
        fixture_path = TRAINER.ROOT / "contracts/neural-decoder/v1/lekh-neural-decoder.v1.json"
        fixture = TRAINER.read_json(fixture_path)
        self.assertEqual(fixture["schemaVersion"], 1)
        for case in fixture["cases"]:
            def predict(prefix: list[int], _step: int) -> TRAINER.np.ndarray:
                return TRAINER.np.asarray(case["logitsByPrefix"][",".join(map(str, prefix))], dtype=TRAINER.np.float64)

            observed = TRAINER.beam_search_token_ids(
                predict,
                input_grapheme_count=case["inputGraphemeCount"],
                max_output_len=case["maxOutputLength"],
                beam_width=case["beamWidth"],
                maximum_candidates=case["beamWidth"],
                pad_id=case["invalidTokenIds"][0],
                sos_id=case["sosTokenId"],
                eos_id=case["eosTokenId"],
                unk_id=case["invalidTokenIds"][2],
                vocab_size=case["vocabularySize"],
            )
            self.assertEqual(observed, case["expectedTokenIds"], case["id"])

    def test_gold_manifest_and_every_suite_are_content_addressed(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-gold-binding-test-", dir=temporary_root) as directory:
            root = Path(directory)
            suite_path = root / "suite.jsonl"
            suite_path.write_text(json.dumps({"id": "gold_test_000001", "input": "bato"}) + "\n", encoding="utf-8")
            suite = {
                "id": "fixture-suite",
                "path": suite_path.relative_to(TRAINER.ROOT).as_posix(),
                "sha256": TRAINER.sha256_file(suite_path),
                "rows": 1,
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "schemaVersion": 2,
                "corpusSha256": TRAINER.gold_corpus_sha256([suite]),
                "suites": [suite],
            }), encoding="utf-8")
            args = TRAINER.parse_args(["--gold-manifest", str(manifest_path)], {})

            rows, evidence = TRAINER.load_verified_gold_rows(args)
            self.assertEqual([row["id"] for row in rows], ["gold_test_000001"])
            self.assertEqual(evidence["goldSuites"], [suite])

            suite_path.write_text(json.dumps({"id": "gold_test_000001", "input": "tampered"}) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "SHA-256"):
                TRAINER.load_verified_gold_rows(args)

    def test_encode_reserves_end_of_sequence_and_rejects_overlength_input(self) -> None:
        vocab = {TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3, "a": 4}
        encoded_input = TRAINER.encode(list("aaa"), vocab, 4, add_sos=False)
        encoded_output = TRAINER.encode(list("aa"), vocab, 4, add_sos=True)

        self.assertEqual(encoded_input, [4, 4, 4, 2])
        self.assertEqual(encoded_output, [1, 4, 4, 2])
        with self.assertRaisesRegex(ValueError, "exceeds capacity"):
            TRAINER.encode(list("aaaa"), vocab, 4, add_sos=False)
        with self.assertRaisesRegex(ValueError, "exceeds capacity"):
            TRAINER.encode(list("aaa"), vocab, 4, add_sos=True)
        self.assertTrue(TRAINER.valid_native_output("नेपाली"))
        self.assertFalse(TRAINER.valid_native_output("नेपाली!"))

    def test_encoder_state_is_invariant_to_trailing_padding(self) -> None:
        torch.manual_seed(7)
        model = TRAINER.Seq2Seq(8, 8, embedding_dim=4, hidden_dim=6, layers=2, dropout=0.0).eval()
        compact = torch.tensor([[4, 5, 2, 0]], dtype=torch.long)
        padded = torch.tensor([[4, 5, 2, 0, 0, 0, 0]], dtype=torch.long)

        with torch.no_grad():
            compact_hidden = model.encode_hidden(compact)
            padded_hidden = model.encode_hidden(padded)

        self.assertTrue(torch.equal(compact_hidden, padded_hidden))

    def test_secondary_human_provenance_is_pinned_during_sampling(self) -> None:
        rows = [
            {"id": "public", "sourceIds": ["ai4bharat-aksharantar-nepali"]},
            {
                "id": "reviewed-merge",
                "sourceIds": ["ai4bharat-aksharantar-nepali", "human-reviewed-lekh-gold-v1"],
            },
        ]

        selected = TRAINER.deterministic_source_sample(rows, 1, 42, "train")

        self.assertEqual([item["id"] for item in selected], ["reviewed-merge"])

    def test_dataset_weight_is_not_multiplied_by_source_again(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-weight-policy-test-", dir=temporary_root) as directory:
            path = Path(directory) / "train.jsonl"
            item = row("weighted", "ka", "क")
            item["sourceIds"] = ["ai4bharat-aksharantar-nepali"]
            item["weight"] = 1.35
            write_rows(path, [item])

            loaded = TRAINER.load_split(path, "train", 32, 32)

            self.assertEqual(loaded[0]["weight"], 1.35)

    def test_weighted_token_loss_ignores_padding_and_uses_token_weights(self) -> None:
        logits = torch.tensor(
            [
                [[3.0, 1.0, 0.0], [0.0, 3.0, 1.0], [1.0, 1.0, 1.0]],
                [[0.0, 1.0, 3.0], [1.0, 1.0, 1.0], [1.0, 1.0, 1.0]],
            ]
        )
        targets = torch.tensor([[0, 1, 0], [2, 0, 0]])
        weights = torch.tensor([2.0, 1.0])
        loss_fn = nn.CrossEntropyLoss(ignore_index=0, reduction="none", label_smoothing=0.0)

        loss, numerator, denominator = TRAINER.weighted_token_cross_entropy(
            logits,
            targets,
            weights,
            loss_fn,
        )
        raw = loss_fn(logits.reshape(-1, 3), targets.reshape(-1)).reshape(targets.shape)
        expected_numerator = raw[0, 1] * 2 + raw[1, 0]

        self.assertTrue(math.isclose(float(numerator), float(expected_numerator), rel_tol=1e-6))
        self.assertEqual(float(denominator), 3.0)
        self.assertTrue(math.isclose(float(loss), float(expected_numerator / 3), rel_tol=1e-6))
        smoothed, _, _ = TRAINER.weighted_token_cross_entropy(
            logits,
            targets,
            weights,
            nn.CrossEntropyLoss(ignore_index=0, reduction="none", label_smoothing=0.2),
        )
        self.assertFalse(math.isclose(float(loss), float(smoothed), rel_tol=1e-6))

    def test_dataset_split_tampering_fails_before_training(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-dataset-binding-test-", dir=temporary_root) as directory:
            root = Path(directory)
            paths = {split: root / f"{split}.jsonl" for split in ("train", "dev", "test")}
            for split, path in paths.items():
                write_rows(path, [row(f"{split}-1", split, "क")])
            evidence = {split: TRAINER.inspect_jsonl_artifact(path) for split, path in paths.items()}
            manifest = {
                "schemaVersion": 2,
                "datasetContentSha256": "a" * 64,
                "splitFiles": {split: str(path) for split, path in paths.items()},
                "sha256": {split: item["sha256"] for split, item in evidence.items()},
                "counts": {split: item["rows"] for split, item in evidence.items()},
                "bytes": {split: item["bytes"] for split, item in evidence.items()},
                "totalRows": 3,
            }
            paths["dev"].write_text("tampered\n", encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "dev SHA-256"):
                TRAINER.verify_dataset_split_artifacts(manifest)

    def test_target_identity_cannot_leak_across_dataset_splits(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-target-leakage-test-", dir=temporary_root) as directory:
            root = Path(directory)
            paths = {split: root / f"{split}.jsonl" for split in ("train", "dev", "test")}
            write_rows(paths["train"], [row("train-1", "baato", "बाटो")])
            write_rows(paths["dev"], [row("dev-1", "bato", "बाटो")])
            write_rows(paths["test"], [row("test-1", "ghar", "घर")])
            evidence = {split: TRAINER.inspect_jsonl_artifact(path) for split, path in paths.items()}
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "schemaVersion": 2,
                "datasetContentSha256": "b" * 64,
                "splitFiles": {split: str(path) for split, path in paths.items()},
                "sha256": {split: item["sha256"] for split, item in evidence.items()},
                "counts": {split: item["rows"] for split, item in evidence.items()},
                "bytes": {split: item["bytes"] for split, item in evidence.items()},
                "totalRows": 3,
            }), encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "target leakage between train and dev: बाटो"):
                TRAINER.load_rows(manifest_path, 10, 10, 42, 32, 32)

    def test_internal_accuracy_is_unreportable_when_decoder_cannot_emit_top_three(self) -> None:
        args = TRAINER.parse_args([
            "--maximum-candidates", "2",
            "--beam-width", "2",
            "--max-input-len", "8",
            "--max-output-len", "8",
        ], {})
        rows = [
            {"id": "dev-1", "input": "ka", "target": "क", "acceptable": ["क"], "sourceIds": ["source"], "weight": 1},
        ]
        input_vocab = {TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3, "k": 4, "a": 5}
        output_vocab = {TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3, "क": 4}
        model = TRAINER.Seq2Seq(6, 5, embedding_dim=4, hidden_dim=6, layers=1, dropout=0).eval()

        result = TRAINER.evaluate_model(model, rows, input_vocab, output_vocab, args, torch.device("cpu"))

        self.assertIsNone(result["sampleTop3Accuracy"])
        self.assertFalse(result["sampleTop3Reportable"])
        self.assertEqual(result["maximumCandidates"], 2)
        self.assertEqual(result["sampleSelectionPolicy"], "deterministic-source-stratified-v1")

    def test_tiny_training_run_emits_bound_best_checkpoint(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-trainer-test-", dir=temporary_root) as directory:
            root = Path(directory)
            train_path = root / "train.jsonl"
            dev_path = root / "dev.jsonl"
            test_path = root / "test.jsonl"
            write_rows(train_path, [
                row("train-1", "ka", "क"),
                row("train-2", "kha", "ख"),
                row("train-3", "ga", "ग"),
            ])
            write_rows(dev_path, [row("dev-1", "na", "न"), row("dev-2", "ma", "म")])
            write_rows(test_path, [row("test-1", "pa", "प")])
            split_paths = {"train": train_path, "dev": dev_path, "test": test_path}
            split_evidence = {
                split: TRAINER.inspect_jsonl_artifact(path)
                for split, path in split_paths.items()
            }
            dataset_manifest = root / "manifest.json"
            dataset_manifest.write_text(json.dumps({
                "schemaVersion": 2,
                "datasetContentSha256": "a" * 64,
                "splitFiles": {split: str(path) for split, path in split_paths.items()},
                "sha256": {split: evidence["sha256"] for split, evidence in split_evidence.items()},
                "counts": {split: evidence["rows"] for split, evidence in split_evidence.items()},
                "bytes": {split: evidence["bytes"] for split, evidence in split_evidence.items()},
                "totalRows": 6,
            }), encoding="utf-8")
            out_dir = root / "run"
            args = TRAINER.parse_args([
                "--dataset-manifest", str(dataset_manifest),
                "--out-dir", str(out_dir),
                "--compiled-model", str(root / "model.mlmodelc"),
                "--manifest", str(root / "model.manifest.json"),
                "--vocab-metadata", str(root / "model.vocab.json"),
                "--max-train-rows", "3",
                "--max-dev-rows", "2",
                "--epochs", "1",
                "--batch-size", "2",
                "--embedding-dim", "4",
                "--hidden-dim", "8",
                "--layers", "1",
                "--dropout", "0",
                "--max-input-len", "8",
                "--max-output-len", "8",
                "--label-smoothing", "0.05",
                "--early-stopping-patience", "1",
                "--skip-coreml",
            ], {})

            result = TRAINER.train_model(args)
            report = result["report"]
            checkpoint = result["checkpoint"]

            self.assertTrue((out_dir / "checkpoint.pt").is_file())
            self.assertTrue((out_dir / "training-report.json").is_file())
            self.assertEqual(list(out_dir.glob(".*.staging.*")), [])
            self.assertEqual(report["bestEpoch"], 1)
            self.assertEqual(report["earlyStopping"]["epochsCompleted"], 1)
            self.assertTrue(report["earlyStopping"]["restoreBestWeights"])
            self.assertEqual(report["trainingContractSha256"], checkpoint["trainingContractSha256"])
            self.assertEqual(report["sampledRowDigests"], checkpoint["sampledRowDigests"])
            self.assertEqual(report["effectiveTrainingConfigSha256"], checkpoint["effectiveTrainingConfigSha256"])
            self.assertEqual(report["trainerSha256"], checkpoint["trainerSha256"])
            self.assertEqual(report["vocabMetadataSha256"], checkpoint["vocabMetadataSha256"])
            reloaded = TRAINER.load_checkpoint(args)
            self.assertEqual(reloaded["report"]["checkpointSha256"], report["checkpointSha256"])
            vocab = json.loads((root / "model.vocab.json").read_text(encoding="utf-8"))
            self.assertEqual(
                set(vocab),
                {"schemaVersion", "modelId", "generatedAt", "tokenization", "input", "output", "decoder", "dataset", "nativeRuntimePolicy"},
            )
            self.assertEqual(
                set(vocab["decoder"]),
                {"type", "beamWidth", "rejectWhitespaceCandidates", "rejectLatinCandidates"},
            )
            self.assertEqual(set(vocab["dataset"]), {"manifest", "manifestSha256", "splitSha256"})

            args.compiled_model.mkdir(parents=True)
            (args.compiled_model / "model.bin").write_bytes(b"compiled-model-fixture")
            compiled_sha256 = TRAINER.directory_sha256(args.compiled_model)
            package_path = TRAINER.mlpackage_path(args)
            package_path.mkdir(parents=True)
            (package_path / "model.bin").write_bytes(b"package-fixture")
            package_sha256 = TRAINER.directory_sha256(package_path)
            with self.assertRaisesRegex(SystemExit, "successful Core ML export"):
                TRAINER.write_manifest(args, checkpoint, report, {"status": "skipped"}, {})
            manifest_checkpoint = {**checkpoint, "parameterCount": 1_000_000}
            original_export_run_id = args.export_run_id
            args.export_run_id = args.training_run_id
            with self.assertRaisesRegex(SystemExit, "reuse the training run identity"):
                TRAINER.write_manifest(
                    args,
                    manifest_checkpoint,
                    report,
                    {"status": "passed"},
                    {},
                )
            args.export_run_id = original_export_run_id
            candidate_manifest = TRAINER.write_manifest(
                args,
                manifest_checkpoint,
                report,
                {
                    "status": "passed",
                    "trainingRunId": args.training_run_id,
                    "exportRunId": args.export_run_id,
                    "compiledSha256": compiled_sha256,
                    "mlpackageSha256": package_sha256,
                    "artifactValidation": {
                        "status": "passed",
                        "compiledModelSha256": compiled_sha256,
                        "mlpackageSha256": package_sha256,
                    },
                },
                {
                    "name": "local-mac",
                    "macOS": "test",
                    "architecture": "arm64",
                    "packagedApp": False,
                    "secureFieldInferenceCount": -1,
                    "p50Ms": 0,
                    "p95Ms": None,
                    "p99Ms": None,
                    "artifact": "unmeasured",
                },
            )
            self.assertEqual(candidate_manifest["schemaVersion"], 2)
            self.assertEqual(candidate_manifest["trainingRunId"], args.training_run_id)
            self.assertEqual(candidate_manifest["exportRunId"], args.export_run_id)
            self.assertFalse(candidate_manifest["languageModelRescorer"]["enabled"])
            self.assertEqual(candidate_manifest["contextWindowWords"], 0)
            self.assertEqual(candidate_manifest["trainingSources"], ["test-fixture"])
            self.assertEqual(candidate_manifest["metrics"]["tailTop1Accuracy"], -1)
            self.assertEqual(candidate_manifest["metrics"]["secureFieldInferenceCount"], -1)
            self.assertEqual(candidate_manifest["performance"]["p50Ms"], 0)

            tampered_report = json.loads((out_dir / "training-report.json").read_text(encoding="utf-8"))
            tampered_report["checkpointSha256"] = "0" * 64
            (out_dir / "training-report.json").write_text(json.dumps(tampered_report), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "checkpointSha256"):
                TRAINER.load_checkpoint(args)

            (out_dir / "training-report.json").write_text(json.dumps(report), encoding="utf-8")
            unsafe_marker = root / "unsafe-pickle-executed"
            torch.save({"payload": UnsafeCheckpointPayload(unsafe_marker)}, out_dir / "checkpoint.pt")
            unsafe_report = {**report, "checkpointSha256": TRAINER.sha256_file(out_dir / "checkpoint.pt")}
            (out_dir / "training-report.json").write_text(json.dumps(unsafe_report), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "safe tensor-only loading"):
                TRAINER.load_checkpoint(args)
            self.assertFalse(unsafe_marker.exists())

    @unittest.skipUnless(platform.system() == "Darwin" and TRAINER.ct is not None, "Core ML export requires macOS and coremltools")
    def test_complete_candidate_pipeline_binds_exact_compiled_predictions_and_run_ids(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-complete-pipeline-test-", dir=temporary_root) as directory:
            root = Path(directory)
            split_paths = {split: root / f"{split}.jsonl" for split in ("train", "dev", "test")}
            write_rows(split_paths["train"], [
                row("train-1", "ka", "क"),
                row("train-2", "kha", "ख"),
                row("train-3", "ga", "ग"),
            ])
            write_rows(split_paths["dev"], [row("dev-1", "ma", "म")])
            write_rows(split_paths["test"], [row("test-1", "pa", "प")])
            split_evidence = {
                split: TRAINER.inspect_jsonl_artifact(path)
                for split, path in split_paths.items()
            }
            dataset_manifest = root / "dataset-manifest.json"
            dataset_manifest.write_text(json.dumps({
                "schemaVersion": 2,
                "datasetContentSha256": "b" * 64,
                "splitFiles": {split: str(path) for split, path in split_paths.items()},
                "sha256": {split: evidence["sha256"] for split, evidence in split_evidence.items()},
                "counts": {split: evidence["rows"] for split, evidence in split_evidence.items()},
                "bytes": {split: evidence["bytes"] for split, evidence in split_evidence.items()},
                "totalRows": 5,
            }), encoding="utf-8")

            gold_suite_path = root / "gold.jsonl"
            gold_suite_path.write_text(json.dumps({"id": "gold_pipeline_000001", "input": "ka"}) + "\n", encoding="utf-8")
            gold_suite = {
                "id": "pipeline-fixture",
                "path": gold_suite_path.relative_to(TRAINER.ROOT).as_posix(),
                "sha256": TRAINER.sha256_file(gold_suite_path),
                "rows": 1,
            }
            gold_manifest = root / "gold-manifest.json"
            gold_manifest.write_text(json.dumps({
                "schemaVersion": 2,
                "corpusSha256": TRAINER.gold_corpus_sha256([gold_suite]),
                "suites": [gold_suite],
            }), encoding="utf-8")

            out_dir = root / "run"
            args = TRAINER.parse_args([
                "--dataset-manifest", str(dataset_manifest),
                "--gold-manifest", str(gold_manifest),
                "--out-dir", str(out_dir),
                "--compiled-model", str(root / "Pipeline.mlmodelc"),
                "--manifest", str(root / "Pipeline.manifest.json"),
                "--vocab-metadata", str(root / "Pipeline.vocab.json"),
                "--max-train-rows", "3",
                "--max-dev-rows", "1",
                "--epochs", "1",
                "--batch-size", "2",
                "--early-stopping-patience", "1",
            ], {})

            export_report = TRAINER.run_pipeline(args)
            runtime_manifest = TRAINER.read_json(args.manifest)

            self.assertEqual(export_report["status"], "passed-open-vocab-seq2seq-candidate")
            self.assertEqual(export_report["predictionsBackend"], "coreml-compiled-model")
            self.assertEqual(export_report["goldManifestSha256"], TRAINER.sha256_file(gold_manifest))
            self.assertEqual(export_report["goldSuites"], [gold_suite])
            self.assertEqual(export_report["trainingRunId"], runtime_manifest["trainingRunId"])
            self.assertEqual(export_report["exportRunId"], runtime_manifest["exportRunId"])
            self.assertEqual(export_report["compiledModelSha256"], runtime_manifest["sha256"]["compiledModel"])
            self.assertEqual(export_report["coremlExport"]["artifactValidation"]["status"], "passed")
            self.assertTrue(TRAINER.is_run_identifier(export_report["trainingRunId"]))
            self.assertTrue(TRAINER.is_run_identifier(export_report["exportRunId"]))

    @unittest.skipUnless(platform.system() == "Darwin" and TRAINER.ct is not None, "Core ML export requires macOS and coremltools")
    def test_actual_seq2seq_coreml_export_shape_dtype_and_parity(self) -> None:
        torch.manual_seed(11)
        model = TRAINER.Seq2Seq(8, 9, embedding_dim=4, hidden_dim=8, layers=2, dropout=0.0).eval()
        wrapper = TRAINER.CoreMLWrapper(model).eval()
        input_ids = torch.tensor([[4, 5, 2] + [0] * 29], dtype=torch.int32)
        decoder_ids = torch.tensor([[1, 4, 5, 2] + [0] * 27], dtype=torch.int32)
        traced = torch.jit.trace(wrapper, (input_ids, decoder_ids))
        converted = TRAINER.ct.convert(
            traced,
            convert_to="mlprogram",
            minimum_deployment_target=TRAINER.ct.target.macOS13,
            inputs=[
                TRAINER.ct.TensorType(name="inputIds", shape=input_ids.shape, dtype=TRAINER.np.int32),
                TRAINER.ct.TensorType(name="decoderInputIds", shape=decoder_ids.shape, dtype=TRAINER.np.int32),
            ],
            outputs=[TRAINER.ct.TensorType(name="logits")],
        )

        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-coreml-export-test-", dir=temporary_root) as directory:
            package_path = Path(directory) / "Model.mlpackage"
            converted.save(str(package_path))
            coreml_model = TRAINER.ct.models.MLModel(str(package_path))
            specification = coreml_model.get_spec()
            features = {feature.name: feature for feature in specification.description.input}
            outputs = {feature.name: feature for feature in specification.description.output}
            int32_type = TRAINER.ct.proto.FeatureTypes_pb2.ArrayFeatureType.INT32
            float16_type = TRAINER.ct.proto.FeatureTypes_pb2.ArrayFeatureType.FLOAT16
            self.assertEqual(set(features), {"inputIds", "decoderInputIds"})
            self.assertEqual(set(outputs), {"logits"})
            self.assertEqual(list(features["inputIds"].type.multiArrayType.shape), [1, 32])
            self.assertEqual(list(features["decoderInputIds"].type.multiArrayType.shape), [1, 31])
            self.assertEqual(features["inputIds"].type.multiArrayType.dataType, int32_type)
            self.assertEqual(features["decoderInputIds"].type.multiArrayType.dataType, int32_type)
            self.assertEqual(list(outputs["logits"].type.multiArrayType.shape), [1, 31, 9])
            self.assertEqual(outputs["logits"].type.multiArrayType.dataType, float16_type)

            with torch.no_grad():
                expected = wrapper(input_ids, decoder_ids).numpy()
            observed = coreml_model.predict({
                "inputIds": input_ids.numpy(),
                "decoderInputIds": decoder_ids.numpy(),
            })["logits"]
            self.assertEqual(tuple(observed.shape), tuple(expected.shape))
            self.assertTrue(TRAINER.np.allclose(observed, expected, rtol=1e-3, atol=1e-3))

            input_vocab = {
                TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3,
                "a": 4, "b": 5, "c": 6, "d": 7,
            }
            output_vocab = {
                TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3,
                "क": 4, "ख": 5, "ग": 6, "घ": 7, "ङ": 8,
            }
            args = TRAINER.parse_args([], {})
            checkpoint = {"inputVocab": input_vocab, "outputVocab": output_vocab}
            backend = TRAINER.CompiledCoreMLBackend(coreml_model, (1, 31, 9), "a" * 64)
            evidence = TRAINER.validate_coreml_known_answer(backend, model, checkpoint, args)
            self.assertLessEqual(evidence["maximumAbsoluteLogitError"], TRAINER.COREML_PARITY_ATOL)

            class PerturbedModel:
                def predict(self, payload):
                    result = dict(coreml_model.predict(payload))
                    result["logits"] = result["logits"].copy()
                    result["logits"][0, 0, 0] += 5
                    return result

            perturbed = TRAINER.CompiledCoreMLBackend(PerturbedModel(), (1, 31, 9), "a" * 64)
            with self.assertRaisesRegex(SystemExit, "diverge"):
                TRAINER.validate_coreml_known_answer(perturbed, model, checkpoint, args)


def row(identifier: str, input_text: str, target: str) -> dict[str, object]:
    return {
        "id": identifier,
        "action": "produce-candidate",
        "input": input_text,
        "target": target,
        "acceptable": [target],
        "sourceIds": ["test-fixture"],
        "weight": 1,
    }


def write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    path.write_text("".join(f"{json.dumps(item, ensure_ascii=False)}\n" for item in rows), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
