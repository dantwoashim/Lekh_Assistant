#!/usr/bin/env python3
"""Focused tests for the Transformer-CTC training foundation."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

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
        loss, numerator, denominator = TRAINER.weighted_ctc_loss(
            logits,
            targets,
            target_lengths,
            weights,
        )
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


if __name__ == "__main__":
    unittest.main()
