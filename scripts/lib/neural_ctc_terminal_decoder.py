"""Terminal-safe, deterministic CTC prefix-beam decoding.

The active remote checkpoint authenticates the original shared model module,
so the short macOS export phase installs this compatibility decoder without
changing either authenticated training source file.  The implementation keeps
only finite-score prefixes and applies final sequence eligibility before the
last beam truncation.  That ordering ensures an ineligible terminal prefix
cannot crowd a lower-scoring valid candidate out of the returned n-best list.
"""

from __future__ import annotations

import math
from contextlib import contextmanager
from typing import Any, Callable, Iterator, MutableMapping

import numpy as np


NEGATIVE_INFINITY = -math.inf
PrefixPermit = Callable[[tuple[int, ...], int], bool]
SequencePermit = Callable[[tuple[int, ...]], bool]

CTC_FINITE_PATH_DECODER_POLICY = {
    "schemaVersion": 2,
    "policyId": "ctc-finite-terminal-path-v2",
    "finitePathRule": (
        "repeat-aware-required-time-steps<=logit-time-steps"
    ),
    "finalPruneRule": (
        "sequence-eligibility-before-final-beam-truncation"
    ),
    "purpose": "return-ranked-finite-terminable-candidates",
}

AUDIT_KEYS = frozenset({
    "decodeCalls",
    "finalEligibilityChecks",
    "finalIneligiblePrefixes",
    "nonFinitePrefixesPruned",
})


def new_ctc_decoder_audit_state() -> dict[str, int]:
    """Return the exact mutable counter set used by export evidence."""
    return {
        "decodeCalls": 0,
        "finalEligibilityChecks": 0,
        "finalIneligiblePrefixes": 0,
        "nonFinitePrefixesPruned": 0,
    }


def terminal_safe_ctc_prefix_beam_search(
    logits: Any,
    *,
    beam_width: int,
    maximum_candidates: int,
    blank_id: int = 0,
    prefix_permitted: PrefixPermit | None = None,
    sequence_permitted: SequencePermit | None = None,
    audit_state: MutableMapping[str, int] | None = None,
) -> list[list[int]]:
    """Rank finite CTC sequences with final eligibility inside the beam.

    Prefix constraints apply whenever a new output token is appended.
    Sequence constraints intentionally apply only at the final time step:
    an incomplete prefix must remain searchable while more model time steps
    are available, but it must not consume a final n-best beam slot.
    """
    values = _validated_ctc_logits(logits, blank_id)
    if type(beam_width) is not int or beam_width < 1:
        raise ValueError("CTC beam width must be a positive integer.")
    if type(maximum_candidates) is not int or maximum_candidates < 1:
        raise ValueError("CTC maximum candidates must be a positive integer.")
    if audit_state is not None and set(audit_state) != AUDIT_KEYS:
        raise ValueError("CTC decoder audit state has an invalid shape.")

    prefix_permitted = prefix_permitted or (
        lambda _prefix, _token: True
    )
    sequence_permitted = sequence_permitted or (lambda _prefix: True)
    _increment(audit_state, "decodeCalls")

    beams: dict[tuple[int, ...], tuple[float, float]] = {
        (): (0.0, NEGATIVE_INFINITY),
    }
    final_time_step = values.shape[0] - 1

    for time_step in range(values.shape[0]):
        probabilities = _log_softmax(values[time_step])
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
                _log_add(previous_blank, blank),
                _log_add(previous_non_blank, non_blank),
            )

        for prefix, (
            probability_blank,
            probability_non_blank,
        ) in beams.items():
            total = _log_add(
                probability_blank,
                probability_non_blank,
            )
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
                        non_blank=(
                            probability_non_blank + token_probability
                        ),
                    )
                    if prefix_permitted(prefix, token_id):
                        update(
                            prefix + (token_id,),
                            non_blank=(
                                probability_blank + token_probability
                            ),
                        )
                elif prefix_permitted(prefix, token_id):
                    update(
                        prefix + (token_id,),
                        non_blank=total + token_probability,
                    )

        ranked: list[
            tuple[tuple[int, ...], tuple[float, float], float]
        ] = []
        for prefix, probability in next_beams.items():
            score = _log_add(probability[0], probability[1])
            if not math.isfinite(score):
                _increment(audit_state, "nonFinitePrefixesPruned")
                continue
            ranked.append((prefix, probability, score))

        ranked.sort(key=lambda item: (-item[2], item[0]))
        selected: list[
            tuple[tuple[int, ...], tuple[float, float], float]
        ] = []
        for item in ranked:
            prefix = item[0]
            if time_step == final_time_step:
                _increment(audit_state, "finalEligibilityChecks")
                if not prefix or not sequence_permitted(prefix):
                    _increment(
                        audit_state,
                        "finalIneligiblePrefixes",
                    )
                    continue
            selected.append(item)
            if len(selected) == beam_width:
                break
        beams = {
            prefix: probability
            for prefix, probability, _score in selected
        }

    ranked_final = sorted(
        (
            (
                prefix,
                _log_add(
                    probability_blank,
                    probability_non_blank,
                ),
            )
            for prefix, (
                probability_blank,
                probability_non_blank,
            ) in beams.items()
        ),
        key=lambda item: (-item[1], item[0]),
    )
    return [
        list(prefix)
        for prefix, _score in ranked_final[:maximum_candidates]
    ]


@contextmanager
def install_terminal_safe_ctc_decoder(
    owner: Any,
    *,
    audit_state: MutableMapping[str, int] | None = None,
) -> Iterator[None]:
    """Temporarily replace an imported trainer's decoder and restore it."""
    original = getattr(owner, "ctc_prefix_beam_search", None)
    if not callable(original):
        raise RuntimeError("CTC trainer has no callable prefix decoder.")

    def installed(
        logits: Any,
        *decoder_args: Any,
        **decoder_kwargs: Any,
    ) -> list[list[int]]:
        if decoder_args:
            raise TypeError(
                "CTC decoder arguments after logits must be keyword-only."
            )
        return terminal_safe_ctc_prefix_beam_search(
            logits,
            audit_state=audit_state,
            **decoder_kwargs,
        )

    owner.ctc_prefix_beam_search = installed
    try:
        yield
    finally:
        owner.ctc_prefix_beam_search = original


def _validated_ctc_logits(logits: Any, blank_id: int) -> np.ndarray:
    values = np.asarray(logits)
    if (
        values.ndim != 2
        or values.shape[0] < 1
        or values.shape[1] < 2
        or values.dtype.kind != "f"
        or not np.isfinite(values).all()
    ):
        raise ValueError(
            "CTC logits must be a finite [time, classes] float matrix."
        )
    if (
        type(blank_id) is not int
        or not 0 <= blank_id < values.shape[1]
    ):
        raise ValueError("CTC blank id is outside the class dimension.")
    return values


def _log_softmax(logits: np.ndarray) -> np.ndarray:
    values = np.asarray(logits, dtype=np.float64)
    maximum = float(np.max(values))
    return values - (
        maximum
        + math.log(float(np.exp(values - maximum).sum()))
    )


def _log_add(*values: float) -> float:
    finite = [
        value
        for value in values
        if value != NEGATIVE_INFINITY
    ]
    if not finite:
        return NEGATIVE_INFINITY
    maximum = max(finite)
    return maximum + math.log(
        sum(math.exp(value - maximum) for value in finite)
    )


def _increment(
    audit_state: MutableMapping[str, int] | None,
    key: str,
) -> None:
    if audit_state is not None:
        audit_state[key] += 1


__all__ = [
    "AUDIT_KEYS",
    "CTC_FINITE_PATH_DECODER_POLICY",
    "install_terminal_safe_ctc_decoder",
    "new_ctc_decoder_audit_state",
    "terminal_safe_ctc_prefix_beam_search",
]
