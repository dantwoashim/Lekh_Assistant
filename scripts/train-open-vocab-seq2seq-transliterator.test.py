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
from unittest import mock
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
        with self.assertRaisesRegex(SystemExit, "mutually exclusive"):
            TRAINER.parse_args(
                ["--skip-train", "--restart-training"],
                {},
            )

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

    def test_split_artifact_publication_is_all_or_nothing(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-split-publication-test-", dir=temporary_root) as directory:
            root = Path(directory)
            targets = [root / f"Target{index}.artifact" for index in range(4)]
            staging = [root / f".Target{index}.staging.artifact" for index in range(4)]
            for index, target in enumerate(targets):
                target.mkdir()
                (target / "payload.bin").write_bytes(f"old-{index}".encode("utf-8"))
            for index, stage in enumerate(staging[:3]):
                stage.mkdir()
                (stage / "payload.bin").write_bytes(f"new-{index}".encode("utf-8"))

            with self.assertRaisesRegex(RuntimeError, "not a safe directory"):
                TRAINER.publish_directories_atomically(list(zip(staging, targets)))
            self.assertEqual(
                [(target / "payload.bin").read_bytes() for target in targets],
                [f"old-{index}".encode("utf-8") for index in range(4)],
            )

            staging[3].mkdir()
            (staging[3] / "payload.bin").write_bytes(b"new-3")
            original_replace = TRAINER.os.replace
            failed = False

            def fail_second_publish(source: object, destination: object) -> None:
                nonlocal failed
                if Path(source) == staging[1] and not failed:
                    failed = True
                    raise OSError("injected publication failure")
                original_replace(source, destination)

            with mock.patch.object(TRAINER.os, "replace", side_effect=fail_second_publish):
                with self.assertRaisesRegex(OSError, "injected publication failure"):
                    TRAINER.publish_directories_atomically(list(zip(staging, targets)))
            self.assertEqual(
                [(target / "payload.bin").read_bytes() for target in targets],
                [f"old-{index}".encode("utf-8") for index in range(4)],
            )
            self.assertFalse(list(root.glob(".*.backup.*")))
            staging[0].mkdir()
            (staging[0] / "payload.bin").write_bytes(b"new-0")
            TRAINER.publish_directories_atomically(list(zip(staging, targets)))
            self.assertEqual(
                [(target / "payload.bin").read_bytes() for target in targets],
                [f"new-{index}".encode("utf-8") for index in range(4)],
            )

    def test_split_artifact_inventory_rejects_stale_and_partial_sets(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-split-inventory-test-", dir=temporary_root) as directory:
            root = Path(directory)
            out_dir = root / "run"
            args = TRAINER.parse_args([
                "--config", str(TRAINER.ROOT / "data/neural/training/open-vocab-bigru-attention-v1.config.json"),
                "--out-dir", str(out_dir),
                "--compiled-model", str(out_dir / "Attention.mlmodelc"),
                "--manifest", str(out_dir / "Attention.manifest.json"),
                "--vocab-metadata", str(out_dir / "Attention.vocab.json"),
            ], {})
            paths = TRAINER.attention_artifact_paths(args)
            for role in ("encoder", "decoderStep"):
                for kind in ("mlpackage", "compiledModel"):
                    path = paths[role][kind]
                    path.mkdir(parents=True, exist_ok=False)
                    (path / "payload.bin").write_bytes(f"{role}-{kind}".encode("utf-8"))
            artifacts = TRAINER.attention_artifact_evidence_from_paths(paths)
            export = {
                "runtimeModelContract": TRAINER.ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
                "artifacts": artifacts,
                "totalCompiledBytes": sum(item["compiledBytes"] for item in artifacts.values()),
                "totalPackageBytes": sum(item["mlpackageBytes"] for item in artifacts.values()),
            }
            self.assertEqual(TRAINER.verified_attention_artifact_evidence(args, export), artifacts)

            encoder_package_file = paths["encoder"]["mlpackage"] / "payload.bin"
            encoder_package_file.write_bytes(encoder_package_file.read_bytes() + b"stale")
            with self.assertRaisesRegex(SystemExit, "stale, partial, or mismatched"):
                TRAINER.verified_attention_artifact_evidence(args, export)

            encoder_package_file.write_bytes(b"encoder-mlpackage")
            TRAINER.shutil.rmtree(paths["decoderStep"]["compiledModel"])
            with self.assertRaisesRegex(SystemExit, "Missing directory artifact"):
                TRAINER.verified_attention_artifact_evidence(args, export)

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
        fixture_path = TRAINER.ROOT / "contracts/neural-decoder/v2/lekh-neural-decoder.v2.json"
        fixture = TRAINER.read_json(fixture_path)
        self.assertEqual(fixture["schemaVersion"], 2)
        self.assertEqual(fixture["tokenization"], TRAINER.OUTPUT_TOKENIZATION)
        self.assertEqual(
            fixture["outputSequenceValidation"],
            TRAINER.OUTPUT_SEQUENCE_VALIDATION,
        )
        self.assertEqual(fixture["maxSteps"], "maxOutputLength-minus-1")
        for case in fixture["sequenceCases"]:
            self.assertEqual(
                TRAINER.analyze_devanagari_output_sequence(case["value"]),
                {
                    "validPrefix": case["validPrefix"],
                    "terminable": case["terminable"],
                    "issueCodes": case["issueCodes"],
                },
                case["value"],
            )
        for case in fixture["cases"]:
            def predict(prefix: list[int], _step: int) -> TRAINER.np.ndarray:
                return TRAINER.np.asarray(case["logitsByPrefix"][",".join(map(str, prefix))], dtype=TRAINER.np.float64)

            observed = TRAINER.beam_search_token_ids(
                predict,
                input_grapheme_count=0,
                max_output_len=case["maxOutputLength"],
                beam_width=case["beamWidth"],
                maximum_candidates=case["beamWidth"],
                pad_id=case["invalidTokenIds"][0],
                sos_id=case["sosTokenId"],
                eos_id=case["eosTokenId"],
                unk_id=case["invalidTokenIds"][2],
                vocab_size=case["vocabularySize"],
                tokens_by_id=case["tokensById"],
            )
            self.assertEqual(observed, case["expectedTokenIds"], case["id"])

    def test_unicode_scalar_output_contract_and_sequence_grammar(self) -> None:
        self.assertEqual(TRAINER.output_scalars("किं"), ["क", "ि", "ं"])
        for value in [
            "नेपाल",
            "क्षेत्र",
            "क़लम",
            "किं",
            "गाउँ",
            "दुःख",
            "पश्चात्",
            "क्‍ष",
            "पुनर्अभिमुखीकरण",
        ]:
            analysis = TRAINER.analyze_devanagari_output_sequence(value)
            self.assertTrue(analysis["validPrefix"], value)
            self.assertTrue(analysis["terminable"], value)
        for value, issue in [
            ("ेनेपाल", "dependent-vowel-sign-without-consonant"),
            ("ंचुनाव", "mark-without-base"),
            ("किी", "multiple-dependent-vowel-signs"),
            ("कुँँ", "duplicate-mark"),
            ("छन्ः", "mark-after-virama"),
            ("कि्", "virama-after-dependent-vowel-sign"),
            ("क्‍ा", "joiner-not-before-consonant"),
            ("राम।", "punctuation"),
        ]:
            analysis = TRAINER.analyze_devanagari_output_sequence(value)
            self.assertFalse(analysis["validPrefix"], value)
            self.assertIn(issue, analysis["issueCodes"], value)
        pending_joiner = TRAINER.analyze_devanagari_output_sequence("क्‍")
        self.assertTrue(pending_joiner["validPrefix"])
        self.assertFalse(pending_joiner["terminable"])

    def test_scalar_decoder_masks_invalid_prefixes_and_uses_every_tensor_step(self) -> None:
        tokens = [TRAINER.PAD, TRAINER.SOS, TRAINER.EOS, TRAINER.UNK, "क", "ा", "ि", "्", "\u200D", "ष"]
        self.assertEqual(TRAINER.decoder_max_steps(1, 32), 31)
        self.assertFalse(TRAINER.output_token_permitted([1], 2, eos_id=2, tokens_by_id=tokens))
        self.assertFalse(TRAINER.output_token_permitted([1], 5, eos_id=2, tokens_by_id=tokens))
        self.assertTrue(TRAINER.output_token_permitted([1], 4, eos_id=2, tokens_by_id=tokens))
        self.assertTrue(TRAINER.output_token_permitted([1, 4], 5, eos_id=2, tokens_by_id=tokens))
        self.assertFalse(TRAINER.output_token_permitted([1, 4, 5], 6, eos_id=2, tokens_by_id=tokens))
        self.assertTrue(TRAINER.output_token_permitted([1, 4, 7], 8, eos_id=2, tokens_by_id=tokens))
        self.assertFalse(TRAINER.output_token_permitted([1, 4, 7, 8], 2, eos_id=2, tokens_by_id=tokens))
        self.assertTrue(TRAINER.output_token_permitted([1, 4, 7, 8], 9, eos_id=2, tokens_by_id=tokens))
        self.assertTrue(TRAINER.output_token_permitted([1, 4, 7, 8, 9], 2, eos_id=2, tokens_by_id=tokens))

    def test_decoder_requires_eos_and_never_exceeds_training_lexical_capacity(self) -> None:
        tokens = [TRAINER.PAD, TRAINER.SOS, TRAINER.EOS, TRAINER.UNK, "क", "ख"]

        def predict(_prefix: list[int], _step: int) -> TRAINER.np.ndarray:
            return TRAINER.np.asarray([0, 0, -100, 0, 100, 99], dtype=TRAINER.np.float64)

        observed = TRAINER.beam_search_token_ids(
            predict,
            input_grapheme_count=1,
            max_output_len=4,
            beam_width=2,
            maximum_candidates=2,
            pad_id=0,
            sos_id=1,
            eos_id=2,
            unk_id=3,
            vocab_size=len(tokens),
            tokens_by_id=tokens,
        )
        self.assertTrue(observed)
        self.assertTrue(all(ids[-1] == 2 for ids in observed))
        self.assertTrue(all(len(ids[1:-1]) <= 2 for ids in observed))

    def test_latency_benchmark_exercises_complete_beam_candidate_generation(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-full-decode-benchmark-", dir=temporary_root) as directory:
            args = TRAINER.parse_args([
                "--out-dir", str(Path(directory) / "run"),
                "--max-input-len", "8",
                "--max-output-len", "4",
                "--beam-width", "2",
                "--maximum-candidates", "2",
            ], {})
            input_vocab = {
                TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3,
                "a": 4, "b": 5, "c": 6,
            }
            output_vocab = {
                TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3,
                "क": 4, "ख": 5,
            }

            class CountingModel:
                def __init__(self) -> None:
                    self.calls = 0

                def predict(self, _payload: dict[str, TRAINER.np.ndarray]) -> dict[str, TRAINER.np.ndarray]:
                    self.calls += 1
                    logits = TRAINER.np.zeros((1, 3, 6), dtype=TRAINER.np.float32)
                    logits[:, :, 2] = -10
                    logits[:, :, 4] = 10
                    logits[:, :, 5] = 9
                    return {"logits": logits}

            model = CountingModel()
            backend = TRAINER.CompiledCoreMLBackend(model, (1, 3, 6), "a" * 64)
            with mock.patch.object(TRAINER, "directory_sha256", return_value="a" * 64):
                result = TRAINER.benchmark_coreml(
                    args,
                    backend,
                    {"inputVocab": input_vocab, "outputVocab": output_vocab},
                )

            self.assertGreater(model.calls, 129)
            self.assertTrue(TRAINER.valid_benchmark_result(result, args))
            evidence = TRAINER.read_json(TRAINER.measurements_path(args))
            self.assertEqual(evidence["measurementKind"], "full-candidate-generation")
            self.assertEqual(evidence["sampleCount"], 120)

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
                "schemaVersion": 3,
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

    def test_official_benchmark_is_locked_and_absent_from_train_and_dev(self) -> None:
        args = TRAINER.parse_args([], {})
        rows, evidence = TRAINER.load_verified_official_benchmark_rows(args)
        dataset_manifest = TRAINER.read_json(args.dataset_manifest)
        split_paths = {
            split: TRAINER.ROOT / dataset_manifest["splitFiles"][split]
            for split in ("train", "dev", "test")
        }
        split_evidence = {
            split: TRAINER.inspect_jsonl_artifact(path)
            for split, path in split_paths.items()
        }

        isolation = TRAINER.verify_official_benchmark_training_isolation(
            rows,
            split_paths,
            split_evidence,
        )

        self.assertEqual(len(rows), 4_085)
        self.assertEqual(evidence["rows"], 4_085)
        self.assertEqual(len(evidence["suites"]), 3)
        self.assertEqual(evidence["manifest"], (
            "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
        ))
        self.assertEqual(
            evidence["manifestSha256"],
            TRAINER.sha256_file(args.official_benchmark_manifest),
        )
        self.assertEqual(isolation["overlappingInputCount"], 0)
        self.assertEqual(
            isolation["benchmarkInputSha256"],
            TRAINER.official_benchmark_input_sha256(rows),
        )

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

    def test_attention_challenger_is_isolated_and_has_padding_invariant_shapes(self) -> None:
        args = TRAINER.parse_args([
            "--config",
            "data/neural/training/open-vocab-bigru-attention-v1.config.json",
        ], {})
        self.assertEqual(args.model_id, TRAINER.ATTENTION_MODEL_ID)
        self.assertEqual(args.architecture_family, TRAINER.ATTENTION_ARCHITECTURE_FAMILY)
        self.assertEqual(args.attention_type, TRAINER.ADDITIVE_ATTENTION)
        self.assertNotEqual(args.out_dir, TRAINER.CONFIG_PATH.parent)
        baseline = TRAINER.parse_args([], {})
        self.assertNotEqual(args.out_dir, baseline.out_dir)
        self.assertNotEqual(args.compiled_model, baseline.compiled_model)
        self.assertNotEqual(args.manifest, baseline.manifest)
        self.assertNotEqual(args.vocab_metadata, baseline.vocab_metadata)
        with self.assertRaisesRegex(SystemExit, "cannot replace baseline artifacts"):
            TRAINER.parse_args([
                "--config",
                "data/neural/training/open-vocab-bigru-attention-v1.config.json",
                "--compiled-model",
                str(baseline.compiled_model),
            ], {})
        production_model = TRAINER.build_model_from_runtime_config(
            30,
            150,
            TRAINER.checkpoint_runtime_config(args),
        )
        parameter_count = sum(parameter.numel() for parameter in production_model.parameters())
        architecture = args.training_config["architecture"]
        self.assertGreaterEqual(parameter_count, architecture["minimumParameterCount"])
        self.assertLessEqual(parameter_count, architecture["maximumParameterCount"])

        runtime_config = {
            "model_id": TRAINER.ATTENTION_MODEL_ID,
            "architecture_family": TRAINER.ATTENTION_ARCHITECTURE_FAMILY,
            "attention": TRAINER.ADDITIVE_ATTENTION,
            "embedding_dim": 4,
            "hidden_dim": 8,
            "attention_dim": 6,
            "layers": 2,
            "dropout": 0.0,
            "max_input_len": 8,
            "max_output_len": 8,
            "beam_width": 2,
            "maximum_candidates": 2,
        }
        torch.manual_seed(13)
        attention_model = TRAINER.build_model_from_runtime_config(8, 9, runtime_config).eval()
        baseline_model = TRAINER.Seq2Seq(8, 9, embedding_dim=4, hidden_dim=8, layers=2, dropout=0.0).eval()
        decoder_ids = torch.tensor([[1, 4, 5, 0, 0, 0, 0]], dtype=torch.long)
        compact = torch.tensor([[4, 5, 2]], dtype=torch.long)
        padded = torch.tensor([[4, 5, 2, 0, 0, 0, 0, 0]], dtype=torch.long)
        poisoned_padding = torch.tensor([[4, 5, 2, 7, 6, 5, 4, 7]], dtype=torch.long)

        with torch.no_grad():
            compact_logits = attention_model(compact, decoder_ids)
            attention_logits = attention_model(padded, decoder_ids)
            poisoned_logits = attention_model(poisoned_padding, decoder_ids)
            baseline_logits = baseline_model(padded, decoder_ids)

        self.assertEqual(tuple(attention_logits.shape), (1, 7, 9))
        self.assertEqual(tuple(baseline_logits.shape), (1, 7, 9))
        self.assertTrue(torch.allclose(compact_logits, attention_logits, rtol=1e-6, atol=1e-6))
        self.assertTrue(torch.equal(attention_logits, poisoned_logits))

    def test_attention_incremental_rollout_matches_full_prefix(self) -> None:
        torch.manual_seed(23)
        model = TRAINER.BidirectionalAttentionSeq2Seq(
            8,
            11,
            embedding_dim=4,
            hidden_dim=8,
            layers=2,
            dropout=0.0,
            attention_dim=6,
        ).eval()
        input_ids = torch.tensor([[4, 5, 6, 2, 0, 0, 0, 0]], dtype=torch.int32)
        decoder_ids = torch.tensor([
            [1, 4, 5, 6, 7, 2, 0],
            [1, 5, 6, 7, 8, 2, 0],
            [1, 6, 7, 8, 9, 2, 0],
            [1, 7, 8, 9, 10, 2, 0],
        ], dtype=torch.int32)

        with torch.no_grad():
            full_prefix_logits = model(
                input_ids.expand(decoder_ids.shape[0], -1).long(),
                decoder_ids.long(),
            )
            recurrent_logits, recurrent_hidden = TRAINER.run_attention_incrementally(
                model,
                input_ids,
                decoder_ids,
            )

        self.assertEqual(tuple(recurrent_logits.shape), (4, 7, 11))
        self.assertEqual(tuple(recurrent_hidden.shape), (2, 4, 8))
        self.assertTrue(torch.allclose(full_prefix_logits, recurrent_logits, rtol=1e-6, atol=1e-6))
        self.assertEqual(
            TRAINER.attention_incremental_tensor_contract(model, 8, 4),
            {
                "encoder": {
                    "inputs": {
                        "inputIds": {"shape": [1, 8], "dataType": "INT32"},
                    },
                    "outputs": {
                        "encoderOutputs": {"shape": [1, 8, 16], "dataType": "FLOAT16"},
                        "encoderEnergy": {"shape": [1, 8, 6], "dataType": "FLOAT16"},
                        "validMask": {"shape": [1, 8], "dataType": "FLOAT16"},
                        "initialDecoderHidden": {"shape": [2, 1, 8], "dataType": "FLOAT16"},
                    },
                },
                "decoderStep": {
                    "inputs": {
                        "decoderTokenIds": {"shape": [4, 1], "dataType": "INT32"},
                        "decoderHidden": {"shape": [2, 4, 8], "dataType": "FLOAT16"},
                        "encoderOutputs": {"shape": [1, 8, 16], "dataType": "FLOAT16"},
                        "encoderEnergy": {"shape": [1, 8, 6], "dataType": "FLOAT16"},
                        "validMask": {"shape": [1, 8], "dataType": "FLOAT16"},
                    },
                    "outputs": {
                        "stepLogits": {"shape": [4, 11], "dataType": "FLOAT16"},
                        "nextDecoderHidden": {"shape": [2, 4, 8], "dataType": "FLOAT16"},
                    },
                },
            },
        )

    def test_attention_four_lane_step_matches_independent_steps(self) -> None:
        torch.manual_seed(29)
        model = TRAINER.BidirectionalAttentionSeq2Seq(
            9,
            12,
            embedding_dim=5,
            hidden_dim=7,
            layers=2,
            dropout=0.0,
            attention_dim=6,
        ).eval()
        encoder = TRAINER.CoreMLAttentionEncoderWrapper(model)
        batched_step = TRAINER.CoreMLAttentionDecoderStepWrapper(model, 4)
        independent_step = TRAINER.CoreMLAttentionDecoderStepWrapper(model, 1)
        input_ids = torch.tensor([[4, 5, 6, 2, 0, 0, 0, 0]], dtype=torch.int32)
        token_ids = torch.tensor([[1], [4], [5], [6]], dtype=torch.int32)
        lane_hidden = torch.randn((2, 4, 7), dtype=torch.float32)

        with torch.no_grad():
            encoder_outputs, encoder_energy, valid_mask, _ = encoder(input_ids)
            batched_logits, batched_hidden = batched_step(
                token_ids,
                lane_hidden,
                encoder_outputs,
                encoder_energy,
                valid_mask,
            )
            lane_results = [
                independent_step(
                    token_ids[lane : lane + 1],
                    lane_hidden[:, lane : lane + 1, :],
                    encoder_outputs,
                    encoder_energy,
                    valid_mask,
                )
                for lane in range(4)
            ]
            independent_logits = torch.cat([item[0] for item in lane_results], dim=0)
            independent_hidden = torch.cat([item[1] for item in lane_results], dim=1)

        self.assertTrue(torch.allclose(batched_logits, independent_logits, rtol=1e-6, atol=1e-6))
        self.assertTrue(torch.allclose(batched_hidden, independent_hidden, rtol=1e-6, atol=1e-6))

    @unittest.skipIf(
        TRAINER.ct is None or platform.system() != "Darwin",
        "Core ML model prediction requires coremltools on macOS",
    )
    def test_attention_incremental_coreml_conversion_and_recurrent_parity(self) -> None:
        torch.manual_seed(31)
        model = TRAINER.BidirectionalAttentionSeq2Seq(
            8,
            9,
            embedding_dim=4,
            hidden_dim=8,
            layers=2,
            dropout=0.0,
            attention_dim=6,
        ).eval()
        converted = TRAINER.convert_attention_incremental_coreml_for_testing(
            model,
            max_input_len=8,
            beam_width=4,
        )
        encoder_model = converted["encoderModel"]
        decoder_model = converted["decoderStepModel"]

        data_types = {
            TRAINER.ct.proto.FeatureTypes_pb2.ArrayFeatureType.INT32: "INT32",
            TRAINER.ct.proto.FeatureTypes_pb2.ArrayFeatureType.FLOAT16: "FLOAT16",
        }

        def feature_contract(features: object) -> dict[str, dict[str, object]]:
            observed: dict[str, dict[str, object]] = {}
            for feature in features:
                multi_array = feature.type.multiArrayType
                observed[feature.name] = {
                    "shape": list(multi_array.shape),
                    "dataType": data_types.get(multi_array.dataType, str(multi_array.dataType)),
                }
            return observed

        encoder_spec = encoder_model.get_spec()
        decoder_spec = decoder_model.get_spec()
        self.assertEqual(
            feature_contract(encoder_spec.description.input),
            converted["contract"]["encoder"]["inputs"],
        )
        self.assertEqual(
            feature_contract(encoder_spec.description.output),
            converted["contract"]["encoder"]["outputs"],
        )
        self.assertEqual(
            feature_contract(decoder_spec.description.input),
            converted["contract"]["decoderStep"]["inputs"],
        )
        self.assertEqual(
            feature_contract(decoder_spec.description.output),
            converted["contract"]["decoderStep"]["outputs"],
        )

        input_ids = TRAINER.np.asarray([[4, 5, 6, 2, 0, 0, 0, 0]], dtype=TRAINER.np.int32)
        decoder_ids = TRAINER.np.asarray([
            [1, 4, 5, 6],
            [1, 5, 6, 7],
            [1, 6, 7, 4],
            [1, 7, 4, 5],
        ], dtype=TRAINER.np.int32)
        encoder_result = encoder_model.predict({"inputIds": input_ids})
        constant_step_inputs = {
            "encoderOutputs": TRAINER.np.asarray(encoder_result["encoderOutputs"], dtype=TRAINER.np.float16),
            "encoderEnergy": TRAINER.np.asarray(encoder_result["encoderEnergy"], dtype=TRAINER.np.float16),
            "validMask": TRAINER.np.asarray(encoder_result["validMask"], dtype=TRAINER.np.float16),
        }
        hidden = TRAINER.np.repeat(
            TRAINER.np.asarray(encoder_result["initialDecoderHidden"], dtype=TRAINER.np.float16),
            4,
            axis=1,
        )
        coreml_steps = []
        for index in range(decoder_ids.shape[1]):
            result = decoder_model.predict({
                "decoderTokenIds": decoder_ids[:, index : index + 1],
                "decoderHidden": hidden,
                **constant_step_inputs,
            })
            coreml_steps.append(
                TRAINER.np.asarray(result["stepLogits"], dtype=TRAINER.np.float32)[:, None, :]
            )
            hidden = TRAINER.np.asarray(result["nextDecoderHidden"], dtype=TRAINER.np.float16)
        coreml_logits = TRAINER.np.concatenate(coreml_steps, axis=1)

        with torch.no_grad():
            pytorch_logits, pytorch_hidden = TRAINER.run_attention_incrementally(
                model,
                torch.from_numpy(input_ids),
                torch.from_numpy(decoder_ids),
            )
        self.assertTrue(TRAINER.np.allclose(
            coreml_logits,
            pytorch_logits.detach().numpy(),
            rtol=TRAINER.COREML_PARITY_RTOL,
            atol=TRAINER.COREML_PARITY_ATOL,
        ))
        self.assertTrue(TRAINER.np.allclose(
            hidden.astype(TRAINER.np.float32),
            pytorch_hidden.detach().numpy(),
            rtol=TRAINER.COREML_PARITY_RTOL,
            atol=TRAINER.COREML_PARITY_ATOL,
        ))

    @unittest.skipUnless(
        platform.system() == "Darwin" and TRAINER.ct is not None,
        "Compiled split Core ML publication requires macOS and coremltools",
    )
    def test_attention_split_pipeline_attests_staging_and_preserves_prior_targets_on_parity_failure(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-attention-split-pipeline-test-", dir=temporary_root) as directory:
            root = Path(directory)
            gold_suite_path = root / "gold.jsonl"
            gold_suite_path.write_text(
                json.dumps({"id": "split_gold_000001", "input": "a"}) + "\n",
                encoding="utf-8",
            )
            gold_suite = {
                "id": "split-pipeline-fixture",
                "path": gold_suite_path.relative_to(TRAINER.ROOT).as_posix(),
                "sha256": TRAINER.sha256_file(gold_suite_path),
                "rows": 1,
            }
            gold_manifest = root / "gold-manifest.json"
            gold_manifest.write_text(json.dumps({
                "schemaVersion": 3,
                "corpusSha256": TRAINER.gold_corpus_sha256([gold_suite]),
                "suites": [gold_suite],
            }), encoding="utf-8")
            out_dir = root / "run"
            args = TRAINER.parse_args([
                "--config", str(TRAINER.ROOT / "data/neural/training/open-vocab-bigru-attention-v1.config.json"),
                "--gold-manifest", str(gold_manifest),
                "--out-dir", str(out_dir),
                "--compiled-model", str(out_dir / "Attention.mlmodelc"),
                "--manifest", str(out_dir / "Attention.manifest.json"),
                "--vocab-metadata", str(out_dir / "Attention.vocab.json"),
                "--embedding-dim", "4",
                "--hidden-dim", "8",
                "--attention-dim", "6",
                "--layers", "2",
                "--dropout", "0",
                "--max-input-len", "8",
                "--max-output-len", "8",
                "--beam-width", "2",
                "--maximum-candidates", "2",
            ], {})
            args.training_run_id = "1" * 32
            args.training_config["architecture"]["minimumParameterCount"] = 1
            args.training_config["architecture"]["maximumParameterCount"] = 10_000_000
            args.training_config["architecture"]["maximumCompiledBytes"] = 16 * 1024 * 1024
            input_vocab = {
                TRAINER.PAD: 0,
                TRAINER.SOS: 1,
                TRAINER.EOS: 2,
                TRAINER.UNK: 3,
                "a": 4,
                "b": 5,
            }
            output_vocab = {
                TRAINER.PAD: 0,
                TRAINER.SOS: 1,
                TRAINER.EOS: 2,
                TRAINER.UNK: 3,
                "क": 4,
                "ख": 5,
                "ग": 6,
            }
            torch.manual_seed(37)
            model = TRAINER.build_model_from_runtime_config(
                len(input_vocab),
                len(output_vocab),
                TRAINER.checkpoint_runtime_config(args),
            ).eval()
            run_input_snapshot = TRAINER.ensure_run_input_snapshot(args)
            checkpoint = {
                "modelId": TRAINER.ATTENTION_MODEL_ID,
                "trainingRunId": args.training_run_id,
                "config": TRAINER.checkpoint_runtime_config(args),
                "inputVocab": input_vocab,
                "outputVocab": output_vocab,
                "stateDict": model.state_dict(),
                "parameterCount": sum(parameter.numel() for parameter in model.parameters()),
                "runInputSnapshot": run_input_snapshot,
                "datasetManifestSha256": "d" * 64,
                "vocabMetadataSha256": "e" * 64,
                "trainingSourceCounts": {"test-fixture": 1},
            }
            out_dir.mkdir(parents=True, exist_ok=True)
            torch.save(checkpoint, TRAINER.checkpoint_path(args))
            training_report = {
                "trainingRunId": args.training_run_id,
                "checkpointSha256": TRAINER.sha256_file(TRAINER.checkpoint_path(args)),
            }
            TRAINER.training_report_path(args).write_text(
                json.dumps(training_report),
                encoding="utf-8",
            )

            with mock.patch.object(
                TRAINER,
                "train_model",
                return_value={"model": model, "checkpoint": checkpoint, "report": training_report},
            ):
                export_report = TRAINER.run_pipeline(args)

            runtime_manifest = TRAINER.read_json(args.manifest)
            coreml_export = export_report["coremlExport"]
            self.assertEqual(export_report["status"], "passed-open-vocab-attention-split-candidate")
            self.assertEqual(
                export_report["runtimeModelContract"],
                TRAINER.ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
            )
            self.assertEqual(export_report["sourceCheckpointSha256"], training_report["checkpointSha256"])
            self.assertEqual(export_report["tensorContract"], coreml_export["tensorContract"])
            self.assertEqual(
                export_report["prePublicationValidation"],
                coreml_export["prePublicationValidation"],
            )
            self.assertEqual(coreml_export["prePublicationValidation"]["status"], "passed")
            self.assertEqual(
                coreml_export["prePublicationValidation"]["phase"],
                "pre-publication-staging",
            )
            self.assertEqual(export_report["compiledModels"], coreml_export["artifacts"])
            self.assertEqual(runtime_manifest["compiledModels"], coreml_export["artifacts"])
            self.assertEqual(runtime_manifest["tensorContract"], coreml_export["tensorContract"])
            self.assertEqual(
                runtime_manifest["sha256"]["sourceCheckpoint"],
                training_report["checkpointSha256"],
            )
            self.assertEqual(coreml_export["artifactValidation"]["status"], "passed")
            self.assertEqual(export_report["predictionsBackend"], "coreml-compiled-split-attention-models")
            self.assertEqual(
                export_report["comparisonBenchmark"]["predictionsBackend"],
                "coreml-compiled-split-attention-models",
            )
            self.assertEqual(
                export_report["comparisonBenchmark"][
                    "predictionArtifactIdentity"
                ]["runtimeModelContract"],
                TRAINER.ATTENTION_INCREMENTAL_RUNTIME_CONTRACT,
            )
            self.assertEqual(export_report["comparisonBenchmark"]["rows"], 4_085)
            self.assertEqual(
                export_report["comparisonBenchmark"]["trainingIsolation"][
                    "overlappingInputCount"
                ],
                0,
            )
            for role in ("encoder", "decoderStep"):
                artifact = export_report["compiledModels"][role]
                prediction_artifact = export_report["comparisonBenchmark"][
                    "predictionArtifactIdentity"
                ]["compiledArtifacts"][role]
                self.assertGreater(artifact["compiledBytes"], 0)
                self.assertGreater(artifact["mlpackageBytes"], 0)
                self.assertEqual(len(artifact["compiledSha256"]), 64)
                self.assertEqual(len(artifact["mlpackageSha256"]), 64)
                self.assertEqual(
                    runtime_manifest["sha256"]["compiledModels"][role],
                    artifact["compiledSha256"],
                )
                self.assertEqual(
                    prediction_artifact,
                    {
                        "path": artifact["compiledModel"],
                        "sha256": artifact["compiledSha256"],
                        "bytes": artifact["compiledBytes"],
                    },
                )

            prior_artifacts = TRAINER.attention_artifact_evidence_from_paths(
                TRAINER.attention_artifact_paths(args)
            )
            with mock.patch.object(
                TRAINER,
                "validate_attention_compiled_known_answer",
                side_effect=SystemExit("injected staged parity failure"),
            ):
                with self.assertRaisesRegex(SystemExit, "injected staged parity failure"):
                    TRAINER.export_coreml(model, checkpoint, args)
            self.assertEqual(
                TRAINER.attention_artifact_evidence_from_paths(
                    TRAINER.attention_artifact_paths(args)
                ),
                prior_artifacts,
            )

            checkpoint_bytes = TRAINER.checkpoint_path(args).read_bytes()
            TRAINER.checkpoint_path(args).write_bytes(checkpoint_bytes + b"stale")
            with self.assertRaisesRegex(SystemExit, "exact checkpoint bytes"):
                TRAINER.load_verified_compiled_attention_coreml(
                    model,
                    checkpoint,
                    args,
                    coreml_export,
                )
            TRAINER.checkpoint_path(args).write_bytes(checkpoint_bytes)

            decoder_compiled = TRAINER.attention_artifact_paths(args)["decoderStep"]["compiledModel"]
            _, compiled_files = TRAINER.secure_directory_files(decoder_compiled)
            tampered_file = compiled_files[0][1]
            tampered_file.write_bytes(tampered_file.read_bytes() + b"stale")
            with self.assertRaisesRegex(SystemExit, "stale, partial, or mismatched"):
                TRAINER.load_verified_compiled_attention_coreml(
                    model,
                    checkpoint,
                    args,
                    coreml_export,
                )

    def test_attention_checkpoint_reload_uses_recorded_family(self) -> None:
        runtime_config = {
            "model_id": TRAINER.ATTENTION_MODEL_ID,
            "architecture_family": TRAINER.ATTENTION_ARCHITECTURE_FAMILY,
            "attention": TRAINER.ADDITIVE_ATTENTION,
            "embedding_dim": 4,
            "hidden_dim": 8,
            "attention_dim": 6,
            "layers": 2,
            "dropout": 0.0,
            "max_input_len": 8,
            "max_output_len": 8,
            "beam_width": 2,
            "maximum_candidates": 2,
        }
        input_vocab = {TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3, "a": 4}
        output_vocab = {TRAINER.PAD: 0, TRAINER.SOS: 1, TRAINER.EOS: 2, TRAINER.UNK: 3, "क": 4}
        torch.manual_seed(17)
        original = TRAINER.build_model_from_runtime_config(5, 5, runtime_config).eval()
        payload = {
            "modelId": TRAINER.ATTENTION_MODEL_ID,
            "config": runtime_config,
            "inputVocab": input_vocab,
            "outputVocab": output_vocab,
            "stateDict": original.state_dict(),
        }
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-attention-checkpoint-test-", dir=temporary_root) as directory:
            path = Path(directory) / "checkpoint.pt"
            torch.save(payload, path)
            reloaded_payload = torch.load(path, map_location="cpu", weights_only=True)
            reloaded = TRAINER.load_model_from_checkpoint_payload(reloaded_payload).eval()

        self.assertIsInstance(reloaded, TRAINER.BidirectionalAttentionSeq2Seq)
        input_ids = torch.tensor([[4, 2, 0, 0, 0, 0, 0, 0]], dtype=torch.long)
        decoder_ids = torch.tensor([[1, 4, 0, 0, 0, 0, 0]], dtype=torch.long)
        with torch.no_grad():
            self.assertTrue(torch.equal(original(input_ids, decoder_ids), reloaded(input_ids, decoder_ids)))

        mismatched = {**reloaded_payload, "modelId": TRAINER.MODEL_ID}
        with self.assertRaisesRegex(SystemExit, "inconsistent"):
            TRAINER.load_model_from_checkpoint_payload(mismatched)

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

    def test_run_input_snapshot_detects_dataset_mutation_before_publication(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-run-snapshot-test-", dir=temporary_root) as directory:
            root = Path(directory)
            paths = {split: root / f"{split}.jsonl" for split in ("train", "dev", "test")}
            for split, path in paths.items():
                write_rows(path, [row(f"{split}-1", f"{split}a", "क")])
            evidence = {split: TRAINER.inspect_jsonl_artifact(path) for split, path in paths.items()}
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "schemaVersion": 2,
                "datasetContentSha256": "c" * 64,
                "splitFiles": {split: str(path) for split, path in paths.items()},
                "sha256": {split: item["sha256"] for split, item in evidence.items()},
                "counts": {split: item["rows"] for split, item in evidence.items()},
                "bytes": {split: item["bytes"] for split, item in evidence.items()},
                "totalRows": 3,
            }), encoding="utf-8")
            args = TRAINER.parse_args([
                "--dataset-manifest", str(manifest_path),
                "--out-dir", str(root / "run"),
                "--compiled-model", str(root / "run" / "model.mlmodelc"),
                "--manifest", str(root / "run" / "model.manifest.json"),
                "--vocab-metadata", str(root / "run" / "model.vocab.json"),
                "--max-train-rows", "1",
                "--max-dev-rows", "1",
                "--epochs", "1",
                "--batch-size", "1",
                "--embedding-dim", "4",
                "--hidden-dim", "8",
                "--layers", "1",
                "--dropout", "0",
                "--max-input-len", "16",
                "--max-output-len", "8",
                "--skip-coreml",
            ], {})
            TRAINER.ensure_run_input_snapshot(args)
            paths["dev"].write_text(paths["dev"].read_text(encoding="utf-8") + "\n", encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "dev SHA-256"):
                TRAINER.assert_run_input_snapshot_unchanged(args)
            self.assertFalse((root / "run" / "checkpoint.pt").exists())

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

    def test_acceptable_alias_cannot_hide_target_leakage_across_splits(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-alias-leakage-test-", dir=temporary_root) as directory:
            root = Path(directory)
            paths = {split: root / f"{split}.jsonl" for split in ("train", "dev", "test")}
            write_rows(paths["train"], [row("train-1", "baato", "बाटो")])
            dev_row = row("dev-1", "patha", "पथ")
            dev_row["acceptable"] = ["पथ", "बाटो"]
            write_rows(paths["dev"], [dev_row])
            write_rows(paths["test"], [row("test-1", "ghar", "घर")])
            evidence = {split: TRAINER.inspect_jsonl_artifact(path) for split, path in paths.items()}
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "schemaVersion": 2,
                "datasetContentSha256": "e" * 64,
                "splitFiles": {split: str(path) for split, path in paths.items()},
                "sha256": {split: item["sha256"] for split, item in evidence.items()},
                "counts": {split: item["rows"] for split, item in evidence.items()},
                "bytes": {split: item["bytes"] for split, item in evidence.items()},
                "totalRows": 3,
            }), encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "target leakage between train and dev: बाटो"):
                TRAINER.load_rows(manifest_path, 10, 10, 42, 32, 32)

    def test_normalized_input_identity_cannot_leak_across_dataset_splits(self) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lekh-input-leakage-test-", dir=temporary_root) as directory:
            root = Path(directory)
            paths = {split: root / f"{split}.jsonl" for split in ("train", "dev", "test")}
            write_rows(paths["train"], [row("train-1", "  BaaTo  ", "बाटो")])
            write_rows(paths["dev"], [row("dev-1", "ghar", "घर")])
            write_rows(paths["test"], [row("test-1", "baato", "पथ")])
            evidence = {split: TRAINER.inspect_jsonl_artifact(path) for split, path in paths.items()}
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps({
                "schemaVersion": 2,
                "datasetContentSha256": "d" * 64,
                "splitFiles": {split: str(path) for split, path in paths.items()},
                "sha256": {split: item["sha256"] for split, item in evidence.items()},
                "counts": {split: item["rows"] for split, item in evidence.items()},
                "bytes": {split: item["bytes"] for split, item in evidence.items()},
                "totalRows": 3,
            }), encoding="utf-8")

            with self.assertRaisesRegex(SystemExit, "input leakage between train and test: baato"):
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
                "--compiled-model", str(out_dir / "model.mlmodelc"),
                "--manifest", str(out_dir / "model.manifest.json"),
                "--vocab-metadata", str(out_dir / "model.vocab.json"),
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
            self.assertEqual(report["runInputSnapshot"], checkpoint["runInputSnapshot"])
            self.assertEqual(report["vocabMetadataSha256"], checkpoint["vocabMetadataSha256"])
            self.assertEqual(
                report["trainingRecovery"],
                {
                    "epochRecoveryEnabled": True,
                    "resumed": False,
                    "resumedFromEpoch": None,
                    "resumeCount": 0,
                    "exportRunIds": [args.export_run_id],
                },
            )
            self.assertFalse(
                TRAINER.training_recovery_metadata_path(args).exists()
            )
            self.assertEqual(TRAINER.training_recovery_state_files(args), [])
            reloaded = TRAINER.load_checkpoint(args)
            self.assertEqual(reloaded["report"]["checkpointSha256"], report["checkpointSha256"])
            vocab = json.loads((out_dir / "model.vocab.json").read_text(encoding="utf-8"))
            self.assertEqual(
                set(vocab),
                {"schemaVersion", "modelId", "generatedAt", "tokenization", "input", "output", "decoder", "dataset", "nativeRuntimePolicy"},
            )
            self.assertEqual(
                set(vocab["decoder"]),
                {
                    "type",
                    "beamWidth",
                    "maxSteps",
                    "outputSequenceValidation",
                    "rejectWhitespaceCandidates",
                    "rejectLatinCandidates",
                },
            )
            self.assertEqual(vocab["tokenization"], TRAINER.OUTPUT_TOKENIZATION)
            self.assertEqual(vocab["decoder"]["maxSteps"], 7)
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

    def test_epoch_recovery_resumes_to_the_exact_uninterrupted_weights(
        self,
    ) -> None:
        temporary_root = TRAINER.ROOT / ".tmp"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="lekh-trainer-resume-test-",
            dir=temporary_root,
        ) as directory:
            root = Path(directory)
            split_paths = {
                "train": root / "train.jsonl",
                "dev": root / "dev.jsonl",
                "test": root / "test.jsonl",
            }
            write_rows(
                split_paths["train"],
                [
                    row("train-1", "ka", "क"),
                    row("train-2", "kha", "ख"),
                    row("train-3", "ga", "ग"),
                    row("train-4", "gha", "घ"),
                ],
            )
            write_rows(
                split_paths["dev"],
                [
                    row("dev-1", "na", "न"),
                    row("dev-2", "ma", "म"),
                ],
            )
            write_rows(split_paths["test"], [row("test-1", "pa", "प")])
            split_evidence = {
                split: TRAINER.inspect_jsonl_artifact(path)
                for split, path in split_paths.items()
            }
            dataset_manifest = root / "manifest.json"
            dataset_manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "datasetContentSha256": "b" * 64,
                        "splitFiles": {
                            split: str(path)
                            for split, path in split_paths.items()
                        },
                        "sha256": {
                            split: evidence["sha256"]
                            for split, evidence in split_evidence.items()
                        },
                        "counts": {
                            split: evidence["rows"]
                            for split, evidence in split_evidence.items()
                        },
                        "bytes": {
                            split: evidence["bytes"]
                            for split, evidence in split_evidence.items()
                        },
                        "totalRows": 7,
                    }
                ),
                encoding="utf-8",
            )

            def arguments(out_dir: Path) -> object:
                return TRAINER.parse_args(
                    [
                        "--dataset-manifest",
                        str(dataset_manifest),
                        "--out-dir",
                        str(out_dir),
                        "--compiled-model",
                        str(out_dir / "model.mlmodelc"),
                        "--manifest",
                        str(out_dir / "model.manifest.json"),
                        "--vocab-metadata",
                        str(out_dir / "model.vocab.json"),
                        "--max-train-rows",
                        "4",
                        "--max-dev-rows",
                        "2",
                        "--epochs",
                        "2",
                        "--batch-size",
                        "2",
                        "--embedding-dim",
                        "4",
                        "--hidden-dim",
                        "8",
                        "--layers",
                        "1",
                        "--dropout",
                        "0.1",
                        "--max-input-len",
                        "8",
                        "--max-output-len",
                        "8",
                        "--label-smoothing",
                        "0.05",
                        "--early-stopping-patience",
                        "2",
                        "--skip-coreml",
                    ],
                    {},
                )

            resumed_out = root / "resumed"
            interrupted_args = arguments(resumed_out)

            def interrupt_after_first_epoch(
                epoch_result: dict[str, object],
                _recovery_path: Path,
            ) -> None:
                if epoch_result["epoch"] == 1:
                    raise RuntimeError("injected epoch-boundary interruption")

            interrupted_args.training_epoch_hook = (
                interrupt_after_first_epoch
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "injected epoch-boundary interruption",
            ):
                TRAINER.train_model(interrupted_args)
            TRAINER.cleanup_run_input_snapshot(interrupted_args)
            self.assertTrue(
                TRAINER.training_recovery_metadata_path(
                    interrupted_args
                ).is_file()
            )
            self.assertEqual(
                len(TRAINER.training_recovery_state_files(interrupted_args)),
                1,
            )
            TRAINER.training_recovery_metadata_path(
                interrupted_args
            ).unlink()

            resumed_args = arguments(resumed_out)
            resumed = TRAINER.train_model(resumed_args)
            TRAINER.cleanup_run_input_snapshot(resumed_args)
            self.assertTrue(resumed["report"]["trainingRecovery"]["resumed"])
            self.assertEqual(
                resumed["report"]["trainingRecovery"]["resumedFromEpoch"],
                1,
            )
            self.assertEqual(
                resumed["report"]["trainingRecovery"]["resumeCount"],
                1,
            )
            self.assertFalse(
                TRAINER.training_recovery_metadata_path(resumed_args).exists()
            )
            self.assertEqual(
                TRAINER.training_recovery_state_files(resumed_args),
                [],
            )

            uninterrupted_args = arguments(root / "uninterrupted")
            uninterrupted = TRAINER.train_model(uninterrupted_args)
            TRAINER.cleanup_run_input_snapshot(uninterrupted_args)
            self.assertEqual(
                resumed["checkpoint"]["epochMetrics"],
                uninterrupted["checkpoint"]["epochMetrics"],
            )
            self.assertEqual(
                resumed["checkpoint"]["bestEpoch"],
                uninterrupted["checkpoint"]["bestEpoch"],
            )
            for name, expected in uninterrupted["checkpoint"][
                "stateDict"
            ].items():
                self.assertTrue(
                    torch.equal(
                        resumed["checkpoint"]["stateDict"][name],
                        expected,
                    ),
                    name,
                )

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
                "schemaVersion": 3,
                "corpusSha256": TRAINER.gold_corpus_sha256([gold_suite]),
                "suites": [gold_suite],
            }), encoding="utf-8")

            out_dir = root / "run"
            args = TRAINER.parse_args([
                "--dataset-manifest", str(dataset_manifest),
                "--gold-manifest", str(gold_manifest),
                "--out-dir", str(out_dir),
                "--compiled-model", str(out_dir / "Pipeline.mlmodelc"),
                "--manifest", str(out_dir / "Pipeline.manifest.json"),
                "--vocab-metadata", str(out_dir / "Pipeline.vocab.json"),
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
            self.assertEqual(export_report["comparisonBenchmark"]["rows"], 4_085)
            self.assertEqual(
                export_report["comparisonBenchmark"]["manifestSha256"],
                TRAINER.sha256_file(args.official_benchmark_manifest),
            )
            self.assertEqual(
                export_report["comparisonBenchmark"]["predictionsSha256"],
                TRAINER.sha256_file(
                    TRAINER.official_benchmark_predictions_path(args)
                ),
            )
            self.assertEqual(
                export_report["comparisonBenchmark"][
                    "predictionArtifactIdentity"
                ],
                {
                    "runtimeModelContract": "single-seq2seq-v1",
                    "compiledArtifacts": {
                        "model": {
                            "path": export_report["compiledModel"],
                            "sha256": export_report["compiledModelSha256"],
                            "bytes": runtime_manifest["modelBytes"],
                        },
                    },
                },
            )
            self.assertEqual(
                export_report["comparisonBenchmark"]["trainingIsolation"][
                    "overlappingInputCount"
                ],
                0,
            )
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

    @unittest.skipUnless(platform.system() == "Darwin" and TRAINER.ct is not None, "Core ML export requires macOS and coremltools")
    def test_tiny_attention_challenger_coreml_full_prefix_parity(self) -> None:
        runtime_config = {
            "model_id": TRAINER.ATTENTION_MODEL_ID,
            "architecture_family": TRAINER.ATTENTION_ARCHITECTURE_FAMILY,
            "attention": TRAINER.ADDITIVE_ATTENTION,
            "embedding_dim": 4,
            "hidden_dim": 8,
            "attention_dim": 6,
            "layers": 2,
            "dropout": 0.0,
            "max_input_len": 8,
            "max_output_len": 8,
            "beam_width": 2,
            "maximum_candidates": 2,
        }
        torch.manual_seed(19)
        model = TRAINER.build_model_from_runtime_config(8, 9, runtime_config).eval()
        wrapper = TRAINER.CoreMLWrapper(model).eval()
        input_ids = torch.tensor([[4, 5, 2, 0, 0, 0, 0, 0]], dtype=torch.int32)
        decoder_ids = torch.tensor([[1, 4, 5, 2, 0, 0, 0]], dtype=torch.int32)
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
        with tempfile.TemporaryDirectory(prefix="lekh-attention-coreml-test-", dir=temporary_root) as directory:
            package_path = Path(directory) / "Attention.mlpackage"
            converted.save(str(package_path))
            coreml_model = TRAINER.ct.models.MLModel(str(package_path))
            parity_inputs = [
                input_ids,
                torch.tensor([[4, 2, 0, 0, 0, 0, 0, 0]], dtype=torch.int32),
                torch.tensor([[4, 5, 6, 7, 2, 0, 0, 0]], dtype=torch.int32),
            ]
            for parity_input in parity_inputs:
                with torch.no_grad():
                    expected = wrapper(parity_input, decoder_ids).numpy()
                observed = coreml_model.predict({
                    "inputIds": parity_input.numpy(),
                    "decoderInputIds": decoder_ids.numpy(),
                })["logits"]
                self.assertEqual(tuple(observed.shape), (1, 7, 9))
                self.assertTrue(
                    TRAINER.np.allclose(
                        observed,
                        expected,
                        rtol=TRAINER.COREML_PARITY_RTOL,
                        atol=TRAINER.COREML_PARITY_ATOL,
                    )
                )


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
