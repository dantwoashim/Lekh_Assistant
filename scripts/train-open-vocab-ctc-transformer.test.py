#!/usr/bin/env python3
"""Focused tests for the Transformer-CTC training foundation."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import platform
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/train-open-vocab-ctc-transformer.py"
SPECIFICATION = importlib.util.spec_from_file_location(
    "lekh_ctc_trainer",
    SCRIPT,
)
if SPECIFICATION is None or SPECIFICATION.loader is None:
    raise RuntimeError("Unable to load CTC trainer.")
TRAINER = importlib.util.module_from_spec(SPECIFICATION)
SPECIFICATION.loader.exec_module(TRAINER)


def row(
    identifier: str,
    input_value: str,
    target: str,
    *,
    source: str = "ai4bharat-aksharantar-nepali",
    weight: float = 1,
) -> dict[str, object]:
    return {
        "id": identifier,
        "input": input_value,
        "target": target,
        "acceptable": [target],
        "sourceIds": [source],
        "weight": weight,
    }


class ConfigTests(unittest.TestCase):
    def test_canonical_config_resolves_exact_runtime(self) -> None:
        args = TRAINER.parse_args([], {})
        self.assertEqual(args.model_id, TRAINER.MODEL_ID)
        self.assertEqual(
            args.runtime_model_contract,
            TRAINER.RUNTIME_MODEL_CONTRACT,
        )
        self.assertEqual(args.output_time_steps, 32)
        self.assertEqual(args.beam_width, 8)
        self.assertEqual(args.maximum_candidates, 4)
        runtime = TRAINER.checkpoint_runtime_config(args)
        dimensions = TRAINER.dimensions_from_runtime_config(31, 70, runtime)
        model = TRAINER.CTCTransformer(dimensions)
        parameter_count = sum(
            parameter.numel() for parameter in model.parameters()
        )
        self.assertGreaterEqual(parameter_count, 1_000_000)
        self.assertLessEqual(parameter_count, 5_000_000)

    def test_command_line_override_is_bound_into_effective_config(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-ctc-config-",
            dir=ROOT / ".tmp",
        ) as directory:
            output = Path(directory) / "candidate"
            args = TRAINER.parse_args([
                "--out-dir",
                str(output),
                "--compiled-model",
                str(output / "Candidate.mlmodelc"),
                "--manifest",
                str(output / "Candidate.manifest.json"),
                "--vocab-metadata",
                str(output / "Candidate.vocab.json"),
                "--batch-size",
                "8",
            ], {})
        self.assertEqual(args.batch_size, 8)
        self.assertEqual(
            args.training_overrides["trainingRun.batchSize"]["effective"],
            8,
        )


class AugmentationTests(unittest.TestCase):
    def test_chat_aliases_are_training_only_and_deterministic(self) -> None:
        rows = [
            row("one", "chha", "छ"),
            row("two", "bhayo", "भयो"),
        ]
        aliases = [
            {"from": "chh", "to": "x", "weightMultiplier": 0.75},
            {"from": "bh", "to": "v", "weightMultiplier": 0.5},
        ]
        first, first_report = TRAINER.augment_training_rows(
            rows,
            aliases,
            blocked_inputs=set(),
            max_input_len=32,
        )
        second, second_report = TRAINER.augment_training_rows(
            rows,
            aliases,
            blocked_inputs=set(),
            max_input_len=32,
        )
        self.assertEqual(first, second)
        self.assertEqual(first_report, second_report)
        generated = {item["input"]: item for item in first[len(rows):]}
        self.assertEqual(set(generated), {"xa", "vayo"})
        self.assertEqual(generated["xa"]["target"], "छ")
        self.assertEqual(generated["vayo"]["target"], "भयो")
        self.assertEqual(first_report["generatedRows"], 2)

    def test_held_out_and_conflicting_aliases_are_rejected(self) -> None:
        rows = [
            row("one", "chha", "छ"),
            row("two", "xa", "क्स"),
            row("three", "bhayo", "भयो"),
        ]
        generated, report = TRAINER.augment_training_rows(
            rows,
            [
                {"from": "chh", "to": "x", "weightMultiplier": 1},
                {"from": "bh", "to": "v", "weightMultiplier": 1},
            ],
            blocked_inputs={"vayo"},
            max_input_len=32,
        )
        self.assertEqual(len(generated), len(rows))
        self.assertEqual(report["rejected"]["conflicting-training-target"], 1)
        self.assertEqual(report["rejected"]["held-out-collision"], 1)

    def test_source_multipliers_change_loss_mass_not_row_identity(self) -> None:
        rows = [
            row("one", "nam", "नाम", source="runtime-names", weight=1.8),
        ]
        weighted = TRAINER.apply_source_multipliers(
            rows,
            {"runtime-names": 4},
        )
        self.assertEqual(weighted[0]["id"], "one")
        self.assertEqual(weighted[0]["weight"], 7.2)
        self.assertEqual(weighted[0]["sourceWeightMultiplier"], 4)
        self.assertNotIn("sourceWeightMultiplier", rows[0])


class VocabularyAndLossTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [
            row("one", "nam", "नाम"),
            row("two", "ghar", "घर"),
        ]
        self.input_vocab = TRAINER.build_input_vocab(self.rows)
        self.output_vocab = TRAINER.build_output_vocab(self.rows)

    def test_ctc_vocabularies_have_distinct_special_contracts(self) -> None:
        self.assertEqual(TRAINER.CTC_BLANK, "<ctc-blank>")
        self.assertEqual(self.input_vocab[TRAINER.PAD], 0)
        self.assertEqual(self.input_vocab[TRAINER.EOS], 1)
        self.assertEqual(self.input_vocab[TRAINER.UNK], 2)
        self.assertEqual(self.output_vocab[TRAINER.CTC_BLANK], 0)
        self.assertNotIn(TRAINER.PAD, self.output_vocab)
        encoded = TRAINER.encode_input("nam", self.input_vocab, 8)
        self.assertEqual(encoded[:4], [
            self.input_vocab["n"],
            self.input_vocab["a"],
            self.input_vocab["m"],
            self.input_vocab[TRAINER.EOS],
        ])
        self.assertEqual(len(encoded), 8)

    def test_dataset_collate_and_weighted_ctc_loss(self) -> None:
        dataset = TRAINER.CTCTransliterationDataset(
            self.rows,
            self.input_vocab,
            self.output_vocab,
            max_input_len=8,
            output_time_steps=8,
        )
        sources, targets, target_lengths, weights = (
            TRAINER.collate_ctc_batch([dataset[0], dataset[1]])
        )
        self.assertEqual(tuple(sources.shape), (2, 8))
        self.assertEqual(int(target_lengths.sum()), targets.numel())
        logits = torch.zeros(
            (2, 8, len(self.output_vocab)),
            dtype=torch.float32,
            requires_grad=True,
        )
        original_ctc_loss = torch.nn.functional.ctc_loss
        observed_devices: dict[str, str] = {}

        def recording_ctc_loss(
            log_probs: torch.Tensor,
            observed_targets: torch.Tensor,
            input_lengths: torch.Tensor,
            observed_target_lengths: torch.Tensor,
            **kwargs: object,
        ) -> torch.Tensor:
            observed_devices.update({
                "log_probs": log_probs.device.type,
                "targets": observed_targets.device.type,
                "input_lengths": input_lengths.device.type,
                "target_lengths": observed_target_lengths.device.type,
            })
            return original_ctc_loss(
                log_probs,
                observed_targets,
                input_lengths,
                observed_target_lengths,
                **kwargs,
            )

        with mock.patch.object(
            torch.nn.functional,
            "ctc_loss",
            side_effect=recording_ctc_loss,
        ):
            loss, numerator, denominator = TRAINER.weighted_ctc_loss(
                logits,
                targets,
                target_lengths,
                weights,
            )
        self.assertEqual(
            observed_devices,
            {
                "log_probs": "cpu",
                "targets": "cpu",
                "input_lengths": "cpu",
                "target_lengths": "cpu",
            },
        )
        self.assertEqual(loss.device.type, "cpu")
        self.assertTrue(torch.isfinite(loss))
        self.assertTrue(torch.isfinite(numerator))
        self.assertEqual(float(denominator), 2)
        loss.backward()
        self.assertTrue(torch.isfinite(logits.grad).all())

    def test_ctc_decoder_applies_devanagari_grammar(self) -> None:
        output_vocab = {
            TRAINER.CTC_BLANK: 0,
            "क": 1,
            "ा": 2,
            "्": 3,
        }
        logits = np.asarray([
            [0, 8, 10, 1],
            [8, 0, 0, 0],
            [0, 1, 8, 1],
            [8, 0, 0, 0],
        ], dtype=np.float32)
        candidates = TRAINER.decode_ctc_logits(
            logits,
            output_vocab,
            beam_width=8,
            maximum_candidates=4,
        )
        self.assertEqual(candidates[0], "का")
        self.assertTrue(
            all(not candidate.startswith("ा") for candidate in candidates)
        )

    def test_runtime_admission_bypasses_protected_tokens_before_inference(
        self,
    ) -> None:
        input_vocab = {
            TRAINER.PAD: 0,
            TRAINER.EOS: 1,
            TRAINER.UNK: 2,
            "a": 3,
            "m": 4,
            "n": 5,
            "p": 6,
        }
        output_vocab = {
            TRAINER.CTC_BLANK: 0,
            "क": 1,
            "ा": 2,
        }
        logits = np.zeros((1, 8, 3), dtype=np.float16)
        logits[0, 0, 1] = 10
        logits[0, 1, 0] = 10
        logits[0, 2, 2] = 10
        logits[0, 3:, 0] = 10

        class Predictor:
            calls = 0

            @classmethod
            def predict(
                cls,
                _payload: dict[str, np.ndarray],
            ) -> dict[str, np.ndarray]:
                cls.calls += 1
                return {"logits": logits}

        backend = TRAINER.CompiledCTCCoreMLBackend(
            Predictor,
            output_time_steps=8,
            output_class_count=3,
            compiled_sha256="a" * 64,
        )
        checkpoint = {
            "inputVocab": input_vocab,
            "outputVocab": output_vocab,
        }
        args = argparse.Namespace(
            max_input_len=8,
            beam_width=4,
            maximum_candidates=2,
        )
        self.assertEqual(
            TRAINER.decode_compiled_ctc_candidates(
                backend,
                "npm",
                checkpoint,
                args,
            ),
            [],
        )
        self.assertEqual(Predictor.calls, 0)
        candidates = TRAINER.decode_compiled_ctc_candidates(
            backend,
            "nam",
            checkpoint,
            args,
        )
        self.assertEqual(Predictor.calls, 1)
        self.assertEqual(candidates[0], "का")

    def test_inverse_square_root_schedule_peaks_at_warmup(self) -> None:
        before = TRAINER.learning_rate_for_step(
            2000,
            peak_learning_rate=0.001,
            warmup_steps=4000,
        )
        peak = TRAINER.learning_rate_for_step(
            4000,
            peak_learning_rate=0.001,
            warmup_steps=4000,
        )
        after = TRAINER.learning_rate_for_step(
            16000,
            peak_learning_rate=0.001,
            warmup_steps=4000,
        )
        self.assertEqual(before, 0.0005)
        self.assertEqual(peak, 0.001)
        self.assertEqual(after, 0.0005)


class ProvenanceTests(unittest.TestCase):
    def test_checkpoint_loader_rejects_wrong_runtime_family(self) -> None:
        args = TRAINER.parse_args([], {})
        payload = {
            "modelId": TRAINER.MODEL_ID,
            "inputVocab": {TRAINER.PAD: 0, TRAINER.EOS: 1, TRAINER.UNK: 2, "a": 3},
            "outputVocab": {TRAINER.CTC_BLANK: 0, "क": 1},
            "config": {
                **TRAINER.checkpoint_runtime_config(args),
                "architecture_family": "wrong",
            },
            "stateDict": {},
        }
        with self.assertRaisesRegex(SystemExit, "runtime contract"):
            TRAINER.load_model_from_checkpoint_payload(payload)


class CoreMLContractTests(unittest.TestCase):
    @unittest.skipUnless(
        platform.system() == "Darwin" and TRAINER.ct is not None,
        "CTC Core ML conversion requires macOS and coremltools",
    )
    def test_single_model_fp16_conversion_shape_and_parity(self) -> None:
        torch.manual_seed(42)
        input_vocab = {
            TRAINER.PAD: 0,
            TRAINER.EOS: 1,
            TRAINER.UNK: 2,
            "a": 3,
            "n": 4,
            "m": 5,
        }
        output_vocab = {
            TRAINER.CTC_BLANK: 0,
            "क": 1,
            "ा": 2,
            "न": 3,
            "म": 4,
        }
        dimensions = TRAINER.CTCTransformerDimensions(
            input_vocab_size=len(input_vocab),
            output_class_count=len(output_vocab),
            max_input_length=8,
            output_time_steps=8,
            model_dimension=16,
            attention_heads=4,
            feed_forward_dimension=32,
            encoder_layers=1,
            dropout=0,
        )
        model = TRAINER.CTCTransformer(dimensions).eval()
        checkpoint = {
            "inputVocab": input_vocab,
            "outputVocab": output_vocab,
        }
        args = argparse.Namespace(
            max_input_len=8,
            output_time_steps=8,
        )
        converted = TRAINER.convert_ctc_coreml_for_testing(
            model,
            max_input_len=8,
            minimum_deployment_target=TRAINER.ct.target.macOS13,
        )
        contract = TRAINER.validate_ctc_coreml_feature_contract(
            converted,
            checkpoint,
            args,
        )
        self.assertEqual(
            contract,
            {
                "inputIds": {
                    "shape": [1, 8],
                    "dataType": "INT32",
                },
                "logits": {
                    "shape": [1, 8, 5],
                    "dataType": "FLOAT16",
                },
            },
        )
        backend = TRAINER.CompiledCTCCoreMLBackend(
            converted,
            output_time_steps=8,
            output_class_count=5,
            compiled_sha256="a" * 64,
        )
        evidence = TRAINER.validate_ctc_coreml_known_answer(
            backend,
            model,
            checkpoint,
            args,
        )
        self.assertLessEqual(
            evidence["maximumAbsoluteLogitError"],
            TRAINER.COREML_PARITY_ATOL,
        )

    @unittest.skipUnless(
        platform.system() == "Darwin" and TRAINER.ct is not None,
        "Compiled CTC Core ML publication requires macOS and coremltools",
    )
    def test_compiled_publication_is_checkpoint_bound(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-ctc-coreml-publication-",
            dir=ROOT / ".tmp",
        ) as directory:
            output = Path(directory) / "candidate"
            args = TRAINER.parse_args([
                "--out-dir",
                str(output),
                "--compiled-model",
                str(output / "Candidate.mlmodelc"),
                "--manifest",
                str(output / "Candidate.manifest.json"),
                "--vocab-metadata",
                str(output / "Candidate.vocab.json"),
                "--model-dimension",
                "16",
                "--attention-heads",
                "4",
                "--feed-forward-dimension",
                "32",
                "--layers",
                "1",
                "--dropout",
                "0",
                "--max-input-len",
                "8",
                "--output-time-steps",
                "8",
                "--beam-width",
                "4",
                "--maximum-candidates",
                "2",
                "--skip-train",
            ], {})
            args.training_run_id = "b" * 32
            args.export_run_id = "c" * 32
            input_vocab = {
                TRAINER.PAD: 0,
                TRAINER.EOS: 1,
                TRAINER.UNK: 2,
                "a": 3,
                "n": 4,
                "m": 5,
            }
            output_vocab = {
                TRAINER.CTC_BLANK: 0,
                "क": 1,
                "ा": 2,
                "न": 3,
                "म": 4,
            }
            model = TRAINER.build_model_from_runtime_config(
                len(input_vocab),
                len(output_vocab),
                TRAINER.checkpoint_runtime_config(args),
            ).eval()
            checkpoint = {
                "modelId": TRAINER.MODEL_ID,
                "trainingRunId": args.training_run_id,
                "stateDict": model.state_dict(),
                "inputVocab": input_vocab,
                "outputVocab": output_vocab,
                "config": TRAINER.checkpoint_runtime_config(args),
            }
            output.mkdir(parents=True)
            torch.save(
                checkpoint,
                TRAINER.checkpoint_path(args),
            )
            with mock.patch.object(
                TRAINER,
                "assert_run_input_snapshot_unchanged",
                return_value=None,
            ):
                export = TRAINER.export_coreml(
                    model,
                    checkpoint,
                    args,
                )
            self.assertEqual(export["status"], "passed", export)
            self.assertEqual(
                export["runtimeModelContract"],
                TRAINER.RUNTIME_MODEL_CONTRACT,
            )
            self.assertEqual(
                export["artifactValidation"]["status"],
                "passed",
            )
            self.assertEqual(
                export["compiledSha256"],
                TRAINER.directory_sha256(args.compiled_model),
            )
            self.assertEqual(
                export["mlpackageSha256"],
                TRAINER.directory_sha256(
                    TRAINER.mlpackage_path(args)
                ),
            )

    @unittest.skipUnless(
        platform.system() == "Darwin" and TRAINER.ct is not None,
        "End-to-end CTC Core ML publication requires macOS",
    )
    def test_tiny_split_host_export_pipeline_is_complete(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-ctc-complete-pipeline-",
            dir=ROOT / ".tmp",
        ) as directory:
            output = Path(directory) / "candidate"
            args = TRAINER.parse_args([
                "--out-dir",
                str(output),
                "--compiled-model",
                str(output / "Candidate.mlmodelc"),
                "--manifest",
                str(output / "Candidate.manifest.json"),
                "--vocab-metadata",
                str(output / "Candidate.vocab.json"),
                "--model-dimension",
                "16",
                "--attention-heads",
                "4",
                "--feed-forward-dimension",
                "32",
                "--layers",
                "1",
                "--dropout",
                "0",
                "--max-input-len",
                "8",
                "--output-time-steps",
                "8",
                "--beam-width",
                "4",
                "--maximum-candidates",
                "2",
                "--skip-train",
            ], {})
            args.training_config = copy.deepcopy(args.training_config)
            args.training_config["architecture"][
                "minimumParameterCount"
            ] = 1
            args.training_config["architecture"][
                "maximumParameterCount"
            ] = 1_000_000
            args.training_run_id = "b" * 32
            args.export_run_id = "c" * 32
            input_vocab = {
                TRAINER.PAD: 0,
                TRAINER.EOS: 1,
                TRAINER.UNK: 2,
                "a": 3,
                "m": 4,
                "n": 5,
                "p": 6,
            }
            output_vocab = {
                TRAINER.CTC_BLANK: 0,
                "क": 1,
                "ा": 2,
                "न": 3,
                "म": 4,
            }
            model = TRAINER.build_model_from_runtime_config(
                len(input_vocab),
                len(output_vocab),
                TRAINER.checkpoint_runtime_config(args),
            ).eval()
            official_base = {
                "manifest": "official-manifest.json",
                "manifestSha256": "1" * 64,
                "corpusSha256": "2" * 64,
                "suites": [],
                "rows": 1,
            }
            training_isolation = {
                "policy": "test-isolation",
                "overlappingInputCount": 0,
            }
            snapshot = {
                "schemaVersion": 1,
                "trainer": {
                    "path": "scripts/train-open-vocab-ctc-transformer.py",
                    "sha256": TRAINER.sha256_file(
                        Path(TRAINER.__file__)
                    ),
                },
                "dataset": {
                    "manifestSha256": "3" * 64,
                    "contentSha256": "4" * 64,
                    "splits": {},
                },
                "gold": {},
                "officialBenchmark": {
                    **official_base,
                    "trainingIsolation": training_isolation,
                },
                "runtime": {
                    "trainingDevice": "cpu",
                },
            }
            args.run_input_snapshot = snapshot
            output.mkdir(parents=True)
            args.vocab_metadata.write_text(
                "{}\n",
                encoding="utf-8",
            )
            checkpoint = {
                "modelId": TRAINER.MODEL_ID,
                "trainingRunId": args.training_run_id,
                "stateDict": model.state_dict(),
                "inputVocab": input_vocab,
                "outputVocab": output_vocab,
                "config": TRAINER.checkpoint_runtime_config(args),
                "runInputSnapshot": snapshot,
                "parameterCount": sum(
                    parameter.numel()
                    for parameter in model.parameters()
                ),
                "datasetManifestSha256": "3" * 64,
                "vocabMetadataSha256": TRAINER.sha256_file(
                    args.vocab_metadata
                ),
                "trainingSourceCounts": {
                    "test-source": 2,
                },
            }
            torch.save(
                checkpoint,
                TRAINER.checkpoint_path(args),
            )
            training_report = {
                "trainingRunId": args.training_run_id,
                "trainingExecutionModes": {
                    "skipTrain": False,
                    "skipCoreML": True,
                    "trainingDevice": "cuda",
                },
                "checkpointSha256": TRAINER.sha256_file(
                    TRAINER.checkpoint_path(args)
                ),
                "runInputSnapshot": snapshot,
            }
            TRAINER.write_json(
                TRAINER.training_report_path(args),
                training_report,
            )
            gold_evidence = {
                "goldManifest": "gold-manifest.json",
                "goldManifestSha256": "5" * 64,
                "goldCorpusSha256": "6" * 64,
                "goldSuites": [],
                "goldRows": 2,
            }
            gold_rows = [
                {"id": "protected", "input": "npm"},
                {"id": "candidate", "input": "nam"},
            ]
            official_rows = [
                {"id": "official", "input": "nam"},
            ]
            with (
                mock.patch.object(
                    TRAINER,
                    "ensure_run_input_snapshot",
                    return_value=snapshot,
                ),
                mock.patch.object(
                    TRAINER,
                    "assert_run_input_snapshot_unchanged",
                    return_value=None,
                ),
                mock.patch.object(
                    TRAINER,
                    "run_input_snapshots_share_immutable_inputs",
                    return_value=True,
                ),
                mock.patch.object(
                    TRAINER,
                    "load_checkpoint",
                    return_value={
                        "model": model,
                        "checkpoint": checkpoint,
                        "report": training_report,
                    },
                ),
                mock.patch.object(
                    TRAINER,
                    "load_verified_gold_rows",
                    return_value=(gold_rows, gold_evidence),
                ),
                mock.patch.object(
                    TRAINER,
                    "load_verified_official_benchmark_rows",
                    return_value=(official_rows, official_base),
                ),
            ):
                export = TRAINER.run_pipeline(args)
            self.assertEqual(
                export["status"],
                "passed-open-vocab-ctc-transformer-candidate",
            )
            self.assertEqual(
                export["executionTopology"],
                "split-host-train-then-macos-export-v1",
            )
            self.assertEqual(
                export["runtimeArtifactContractIssues"],
                [],
            )
            self.assertEqual(
                export["predictionsBackend"],
                "coreml-compiled-transformer-ctc",
            )
            self.assertTrue(args.manifest.is_file())
            self.assertTrue(
                TRAINER.measurements_path(args).is_file()
            )
            prediction_rows = [
                json.loads(line)
                for line in TRAINER.predictions_path(args)
                    .read_text(encoding="utf-8")
                    .splitlines()
            ]
            self.assertEqual(
                set(prediction_rows[0]),
                {"id", "input", "candidates"},
            )
            self.assertEqual(
                prediction_rows[0]["candidates"],
                [],
            )


class RecoveryAndPublicationTests(unittest.TestCase):
    def test_epoch_recovery_round_trip_restores_exact_state(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-ctc-recovery-",
            dir=ROOT / ".tmp",
        ) as directory:
            args = argparse.Namespace(
                out_dir=Path(directory),
                export_run_id="a" * 32,
                training_run_id="b" * 32,
                model_id=TRAINER.MODEL_ID,
                resolved_training_device="cpu",
                epochs=2,
            )
            model = torch.nn.Linear(3, 2)
            optimizer = torch.optim.AdamW(model.parameters(), lr=0.001)
            generator = torch.Generator().manual_seed(42)
            expected = {
                name: value.detach().clone()
                for name, value in model.state_dict().items()
            }
            metric = {
                "epoch": 1,
                "trainWeightedCTCLoss": 2.0,
                "devWeightedCTCLoss": 1.5,
                "learningRate": 0.001,
                "globalStep": 4,
                "best": True,
            }
            with mock.patch.object(
                TRAINER,
                "assert_run_input_snapshot_unchanged",
                return_value=None,
            ):
                TRAINER.save_training_recovery(
                    args,
                    identity={"schemaVersion": 3, "value": "bound"},
                    model=model,
                    optimizer=optimizer,
                    training_generator=generator,
                    completed_epoch=1,
                    global_step=4,
                    train_losses=[2.0],
                    epoch_metrics=[metric],
                    best_state=expected,
                    best_dev_loss=1.5,
                    best_epoch=1,
                    epochs_without_improvement=0,
                    stopped_early=False,
                    training_duration_seconds=1.25,
                    resume_count=0,
                    export_run_ids=[args.export_run_id],
                )
            with torch.no_grad():
                for parameter in model.parameters():
                    parameter.zero_()
            recovery = TRAINER.load_training_recovery(
                args,
                identity={"schemaVersion": 3, "value": "bound"},
                model=model,
                optimizer=optimizer,
                training_generator=generator,
            )
            self.assertIsNotNone(recovery)
            self.assertEqual(recovery["globalStep"], 4)
            for name, value in model.state_dict().items():
                self.assertTrue(torch.equal(value, expected[name]))
            TRAINER.clear_training_recovery(args)
            self.assertEqual(
                TRAINER.training_recovery_state_files(args),
                [],
            )

    def test_tiny_training_publishes_loadable_bound_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="lekh-ctc-train-",
            dir=ROOT / ".tmp",
        ) as directory:
            output = Path(directory) / "candidate"
            argv = [
                "--out-dir",
                str(output),
                "--compiled-model",
                str(output / "Candidate.mlmodelc"),
                "--manifest",
                str(output / "Candidate.manifest.json"),
                "--vocab-metadata",
                str(output / "Candidate.vocab.json"),
                "--model-dimension",
                "16",
                "--attention-heads",
                "4",
                "--feed-forward-dimension",
                "32",
                "--layers",
                "1",
                "--dropout",
                "0",
                "--max-input-len",
                "8",
                "--output-time-steps",
                "8",
                "--beam-width",
                "4",
                "--maximum-candidates",
                "2",
                "--batch-size",
                "2",
                "--epochs",
                "1",
                "--warmup-steps",
                "1",
                "--early-stopping-patience",
                "1",
                "--skip-coreml",
            ]
            args = TRAINER.parse_args(argv, {})
            args.training_config = copy.deepcopy(args.training_config)
            args.training_config["architecture"][
                "minimumParameterCount"
            ] = 1
            args.training_config["architecture"][
                "maximumParameterCount"
            ] = 1_000_000
            rows = [
                row("one", "nam", "नाम"),
                row("two", "ghar", "घर"),
                row("three", "ram", "राम"),
                row("four", "har", "हार"),
            ]
            input_vocab = TRAINER.build_input_vocab(rows)
            output_vocab = TRAINER.build_output_vocab(rows)
            data = {
                "trainRows": rows,
                "devRows": copy.deepcopy(rows),
                "datasetManifest": {"totalRows": 8},
                "inputVocab": input_vocab,
                "outputVocab": output_vocab,
                "augmentation": {
                    "schemaVersion": 1,
                    "policy": TRAINER.AUGMENTATION_SOURCE,
                    "baseRows": len(rows),
                    "generatedRows": 0,
                    "combinedRows": len(rows),
                    "generatedByAlias": {},
                    "rejected": {},
                    "blockedInputCount": 0,
                    "generatedRowsSha256":
                        TRAINER.sampled_rows_sha256([]),
                },
            }
            snapshot = {
                "schemaVersion": 1,
                "trainer": {
                    "path": TRAINER.rel(TRAINER.Path(TRAINER.__file__)),
                    "sha256": TRAINER.sha256_file(
                        TRAINER.Path(TRAINER.__file__)
                    ),
                },
                "trainerDependencies": [],
                "trainingConfig": {
                    "path": TRAINER.rel(args.config),
                    "sha256": args.training_contract_sha256,
                },
                "dataset": {
                    "manifest": TRAINER.rel(args.dataset_manifest),
                    "manifestSha256": "c" * 64,
                    "contentSha256": "d" * 64,
                    "splits": {
                        split: {
                            "path": f"{split}.jsonl",
                            "sha256": character * 64,
                            "bytes": 1,
                            "rows": len(rows),
                        }
                        for split, character in (
                            ("train", "e"),
                            ("dev", "f"),
                            ("test", "a"),
                        )
                    },
                },
                "gold": {},
                "officialBenchmark": {},
                "runtime": {
                    "python": "test",
                    "trainingDevice": "cpu",
                    "cuda": {"available": False},
                },
            }
            args.run_input_snapshot = snapshot
            args.resolved_training_device = "cpu"
            with (
                mock.patch.object(
                    TRAINER,
                    "ensure_run_input_snapshot",
                    return_value=snapshot,
                ),
                mock.patch.object(
                    TRAINER,
                    "assert_run_input_snapshot_unchanged",
                    return_value=None,
                ),
                mock.patch.object(
                    TRAINER,
                    "prepare_training_data",
                    return_value=data,
                ),
            ):
                export = TRAINER.run_pipeline(args)
                trained_report = TRAINER.read_json(
                    TRAINER.training_report_path(args)
                )
                self.assertEqual(
                    trained_report["status"],
                    "passed-training-checkpoint",
                )
                self.assertEqual(
                    export["status"],
                    "passed-training-candidate-coreml-export-skipped",
                )
                self.assertTrue(TRAINER.checkpoint_path(args).is_file())
                self.assertTrue(TRAINER.training_report_path(args).is_file())
                self.assertTrue(args.vocab_metadata.is_file())
                args.training_run_id = None
                loaded = TRAINER.load_checkpoint(args)
                self.assertEqual(
                    loaded["checkpoint"]["trainingRunId"],
                    trained_report["trainingRunId"],
                )


if __name__ == "__main__":
    unittest.main()
