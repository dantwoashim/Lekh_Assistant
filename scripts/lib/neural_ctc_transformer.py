"""Fixed-shape Transformer-CTC components for Lekh transliteration.

This module has no repository or artifact-publication side effects. The trainer,
Core ML exporter, parity harness, and runtime-decoder tests import the same
model and CTC beam implementation so their numerical contract cannot silently
diverge.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np
import torch
from torch import nn


CTC_BLANK_ID = 0
NEGATIVE_INFINITY = -math.inf


@dataclass(frozen=True)
class CTCTransformerDimensions:
    input_vocab_size: int
    output_class_count: int
    max_input_length: int = 32
    output_time_steps: int = 32
    model_dimension: int = 256
    attention_heads: int = 4
    feed_forward_dimension: int = 1024
    encoder_layers: int = 6
    dropout: float = 0.15
    padding_id: int = 0

    def validate(self) -> None:
        integer_fields = {
            "input_vocab_size": self.input_vocab_size,
            "output_class_count": self.output_class_count,
            "max_input_length": self.max_input_length,
            "output_time_steps": self.output_time_steps,
            "model_dimension": self.model_dimension,
            "attention_heads": self.attention_heads,
            "feed_forward_dimension": self.feed_forward_dimension,
            "encoder_layers": self.encoder_layers,
        }
        if any(type(value) is not int or value < 1 for value in integer_fields.values()):
            raise ValueError("CTC Transformer dimensions must be positive integers.")
        if self.input_vocab_size < 2:
            raise ValueError("Input vocabulary must contain padding and lexical tokens.")
        if self.output_class_count < 2:
            raise ValueError("CTC output must contain blank and lexical classes.")
        if self.model_dimension % self.attention_heads:
            raise ValueError("Model dimension must divide evenly by attention heads.")
        if not 0 <= self.padding_id < self.input_vocab_size:
            raise ValueError("Padding id is outside the input vocabulary.")
        if not math.isfinite(self.dropout) or not 0 <= self.dropout < 1:
            raise ValueError("Dropout must be finite and in [0, 1).")


class MultiHeadAttention(nn.Module):
    """Core ML-friendly explicit scaled dot-product attention."""

    def __init__(self, dimension: int, heads: int, dropout: float) -> None:
        super().__init__()
        if dimension % heads:
            raise ValueError("Attention dimension must divide evenly by heads.")
        self.heads = heads
        self.head_dimension = dimension // heads
        self.scale = 1.0 / math.sqrt(self.head_dimension)
        self.query = nn.Linear(dimension, dimension)
        self.key = nn.Linear(dimension, dimension)
        self.value = nn.Linear(dimension, dimension)
        self.output = nn.Linear(dimension, dimension)
        self.dropout = nn.Dropout(dropout)

    def forward(
        self,
        values: torch.Tensor,
        additive_key_mask: torch.Tensor,
    ) -> torch.Tensor:
        batch, sequence_length, dimension = values.shape
        query = (
            self.query(values)
            .reshape(batch, sequence_length, self.heads, self.head_dimension)
            .permute(0, 2, 1, 3)
        )
        key = (
            self.key(values)
            .reshape(batch, sequence_length, self.heads, self.head_dimension)
            .permute(0, 2, 1, 3)
        )
        projected_value = (
            self.value(values)
            .reshape(batch, sequence_length, self.heads, self.head_dimension)
            .permute(0, 2, 1, 3)
        )
        scores = torch.matmul(query, key.transpose(-2, -1)) * self.scale
        weights = torch.softmax(scores + additive_key_mask, dim=-1)
        context = (
            torch.matmul(self.dropout(weights), projected_value)
            .permute(0, 2, 1, 3)
            .reshape(batch, sequence_length, dimension)
        )
        return self.output(context)


class FeedForward(nn.Module):
    def __init__(
        self,
        dimension: int,
        hidden_dimension: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.input = nn.Linear(dimension, hidden_dimension)
        self.output = nn.Linear(hidden_dimension, dimension)
        self.dropout = nn.Dropout(dropout)

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        activated = torch.nn.functional.gelu(self.input(values))
        return self.output(self.dropout(activated))


class EncoderLayer(nn.Module):
    def __init__(
        self,
        dimension: int,
        heads: int,
        feed_forward_dimension: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.attention_norm = nn.LayerNorm(dimension)
        self.attention = MultiHeadAttention(dimension, heads, dropout)
        self.attention_dropout = nn.Dropout(dropout)
        self.feed_forward_norm = nn.LayerNorm(dimension)
        self.feed_forward = FeedForward(
            dimension,
            feed_forward_dimension,
            dropout,
        )
        self.feed_forward_dropout = nn.Dropout(dropout)

    def forward(
        self,
        values: torch.Tensor,
        additive_key_mask: torch.Tensor,
    ) -> torch.Tensor:
        normalized = self.attention_norm(values)
        values = values + self.attention_dropout(
            self.attention(normalized, additive_key_mask)
        )
        return values + self.feed_forward_dropout(
            self.feed_forward(self.feed_forward_norm(values))
        )


class CTCTransformer(nn.Module):
    """One-pass source-plus-query Transformer producing fixed-width CTC logits.

    The sequence contains 32 source positions followed by 32 learned output
    query positions. Padded source positions are excluded as attention keys,
    while all output queries remain valid. This permits a short Roman input to
    emit a longer Devanagari sequence without breaking the CTC length contract.
    """

    def __init__(self, dimensions: CTCTransformerDimensions) -> None:
        super().__init__()
        dimensions.validate()
        self.dimensions = dimensions
        self.input_embedding = nn.Embedding(
            dimensions.input_vocab_size,
            dimensions.model_dimension,
            padding_idx=dimensions.padding_id,
        )
        self.source_position_embedding = nn.Embedding(
            dimensions.max_input_length,
            dimensions.model_dimension,
        )
        self.output_query_embedding = nn.Embedding(
            dimensions.output_time_steps,
            dimensions.model_dimension,
        )
        self.layers = nn.ModuleList(
            EncoderLayer(
                dimensions.model_dimension,
                dimensions.attention_heads,
                dimensions.feed_forward_dimension,
                dimensions.dropout,
            )
            for _ in range(dimensions.encoder_layers)
        )
        self.output_norm = nn.LayerNorm(dimensions.model_dimension)
        self.projection = nn.Linear(
            dimensions.model_dimension,
            dimensions.output_class_count,
        )
        self.register_buffer(
            "source_positions",
            torch.arange(dimensions.max_input_length).reshape(1, -1),
        )
        self.register_buffer(
            "output_positions",
            torch.arange(dimensions.output_time_steps).reshape(1, -1),
        )
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if isinstance(module, nn.Linear) and module.bias is not None:
                nn.init.zeros_(module.bias)

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        dimensions = self.dimensions
        source = self.input_embedding(input_ids.long())
        source = source + self.source_position_embedding(self.source_positions)
        queries = self.output_query_embedding(self.output_positions).expand(
            input_ids.shape[0],
            -1,
            -1,
        )
        values = torch.cat((source, queries), dim=1)

        source_valid = input_ids.ne(dimensions.padding_id)
        query_valid = torch.ones(
            (
                input_ids.shape[0],
                dimensions.output_time_steps,
            ),
            dtype=torch.bool,
            device=input_ids.device,
        )
        key_valid = torch.cat((source_valid, query_valid), dim=1)
        additive_key_mask = (
            key_valid
            .to(self.input_embedding.weight.dtype)
            .reshape(input_ids.shape[0], 1, 1, values.shape[1])
            - 1.0
        ) * 10_000.0
        for layer in self.layers:
            values = layer(values, additive_key_mask)
        output_queries = values[:, dimensions.max_input_length :, :]
        return self.projection(self.output_norm(output_queries))


def ctc_required_time_steps(token_ids: Sequence[int]) -> int:
    """Return the minimum CTC time dimension for a target token sequence."""
    if any(type(token_id) is not int or token_id <= CTC_BLANK_ID for token_id in token_ids):
        raise ValueError("CTC targets must contain positive lexical class ids.")
    repeats = sum(
        left == right
        for left, right in zip(token_ids, token_ids[1:])
    )
    return len(token_ids) + repeats


def validate_ctc_input_ids(
    input_ids: torch.Tensor,
    dimensions: CTCTransformerDimensions,
) -> None:
    """Validate a dynamic caller before entering the fixed traced graph."""
    if input_ids.ndim != 2:
        raise ValueError("CTC Transformer input must have rank two.")
    if input_ids.shape[1] != dimensions.max_input_length:
        raise ValueError("CTC Transformer input has the wrong fixed length.")
    if input_ids.dtype not in (torch.int32, torch.int64):
        raise ValueError("CTC Transformer input must use int32 or int64 ids.")
    if input_ids.numel() and (
        int(input_ids.min()) < 0
        or int(input_ids.max()) >= dimensions.input_vocab_size
    ):
        raise ValueError("CTC Transformer input id is outside the vocabulary.")


def log_softmax_numpy(logits: np.ndarray) -> np.ndarray:
    values = np.asarray(logits, dtype=np.float64)
    if values.ndim != 1 or values.size < 2 or not np.isfinite(values).all():
        raise ValueError("CTC logit vector must be finite and one-dimensional.")
    maximum = float(np.max(values))
    return values - (maximum + math.log(float(np.exp(values - maximum).sum())))


def log_add(*values: float) -> float:
    finite = [value for value in values if value != NEGATIVE_INFINITY]
    if not finite:
        return NEGATIVE_INFINITY
    maximum = max(finite)
    return maximum + math.log(sum(math.exp(value - maximum) for value in finite))


def ctc_greedy_token_ids(
    logits: np.ndarray,
    *,
    blank_id: int = CTC_BLANK_ID,
) -> list[int]:
    values = validated_ctc_logits(logits, blank_id)
    output: list[int] = []
    previous = blank_id
    for raw_token_id in np.argmax(values, axis=-1):
        token_id = int(raw_token_id)
        if token_id != blank_id and token_id != previous:
            output.append(token_id)
        previous = token_id
    return output


PrefixPermit = Callable[[tuple[int, ...], int], bool]
SequencePermit = Callable[[tuple[int, ...]], bool]


def ctc_prefix_beam_search(
    logits: np.ndarray,
    *,
    beam_width: int,
    maximum_candidates: int,
    blank_id: int = CTC_BLANK_ID,
    prefix_permitted: PrefixPermit | None = None,
    sequence_permitted: SequencePermit | None = None,
) -> list[list[int]]:
    """Deterministic log-domain CTC prefix beam search.

    `prefix_permitted` can enforce the Devanagari scalar grammar before a beam
    is expanded. `sequence_permitted` performs the termination check after all
    fixed time steps. Ties are resolved by lexical token-id sequence.
    """
    values = validated_ctc_logits(logits, blank_id)
    if type(beam_width) is not int or beam_width < 1:
        raise ValueError("CTC beam width must be a positive integer.")
    if type(maximum_candidates) is not int or maximum_candidates < 1:
        raise ValueError("CTC maximum candidates must be a positive integer.")
    prefix_permitted = prefix_permitted or (lambda _prefix, _token: True)
    sequence_permitted = sequence_permitted or (lambda _prefix: True)
    beams: dict[tuple[int, ...], tuple[float, float]] = {
        (): (0.0, NEGATIVE_INFINITY),
    }

    for time_step in range(values.shape[0]):
        probabilities = log_softmax_numpy(values[time_step])
        next_beams: dict[tuple[int, ...], tuple[float, float]] = {}

        def update(
            prefix: tuple[int, ...],
            *,
            blank: float = NEGATIVE_INFINITY,
            non_blank: float = NEGATIVE_INFINITY,
        ) -> None:
            previous_blank, previous_non_blank = next_beams.get(
                prefix,
                (NEGATIVE_INFINITY, NEGATIVE_INFINITY),
            )
            next_beams[prefix] = (
                log_add(previous_blank, blank),
                log_add(previous_non_blank, non_blank),
            )

        for prefix, (probability_blank, probability_non_blank) in beams.items():
            total = log_add(probability_blank, probability_non_blank)
            update(
                prefix,
                blank=total + float(probabilities[blank_id]),
            )
            for token_id in range(values.shape[1]):
                if token_id == blank_id:
                    continue
                token_probability = float(probabilities[token_id])
                if prefix and token_id == prefix[-1]:
                    update(
                        prefix,
                        non_blank=probability_non_blank + token_probability,
                    )
                    extended = prefix + (token_id,)
                    if prefix_permitted(prefix, token_id):
                        update(
                            extended,
                            non_blank=probability_blank + token_probability,
                        )
                    continue
                if prefix_permitted(prefix, token_id):
                    update(
                        prefix + (token_id,),
                        non_blank=total + token_probability,
                    )
        ranked = sorted(
            next_beams.items(),
            key=lambda item: (
                -log_add(item[1][0], item[1][1]),
                item[0],
            ),
        )
        beams = dict(ranked[:beam_width])

    ranked_final = sorted(
        (
            (prefix, log_add(probability_blank, probability_non_blank))
            for prefix, (probability_blank, probability_non_blank) in beams.items()
            if prefix and sequence_permitted(prefix)
        ),
        key=lambda item: (-item[1], item[0]),
    )
    return [
        list(prefix)
        for prefix, _score in ranked_final[:maximum_candidates]
    ]


def validated_ctc_logits(
    logits: np.ndarray,
    blank_id: int,
) -> np.ndarray:
    values = np.asarray(logits)
    if (
        values.ndim != 2
        or values.shape[0] < 1
        or values.shape[1] < 2
        or values.dtype.kind != "f"
        or not np.isfinite(values).all()
    ):
        raise ValueError("CTC logits must be a finite [time, classes] float matrix.")
    if type(blank_id) is not int or not 0 <= blank_id < values.shape[1]:
        raise ValueError("CTC blank id is outside the class dimension.")
    return values


__all__ = [
    "CTC_BLANK_ID",
    "CTCTransformer",
    "CTCTransformerDimensions",
    "ctc_greedy_token_ids",
    "ctc_prefix_beam_search",
    "ctc_required_time_steps",
    "log_add",
    "log_softmax_numpy",
    "validate_ctc_input_ids",
    "validated_ctc_logits",
]
