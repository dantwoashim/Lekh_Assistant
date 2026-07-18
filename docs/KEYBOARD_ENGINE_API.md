# Keyboard Engine API

Generated: 2026-05-27

The `KeyboardEngine` API is the repo-executable contract for Lekh Keyboard. It is implemented in `src/engine/keyboard` and sits above the existing conversion, proofread, dictionary, and memory modules.

## Scope

This API supports:

- browser/web-lab typing simulation;
- Windows TSF bridge contract;
- macOS InputMethodKit bridge contract;
- session lifecycle;
- composition update;
- key-stroke processing;
- candidate commit;
- raw commit;
- cancellation;
- proof hints;
- dictionary lookup;
- warm startup reporting.

Native TSF and IMK proof targets exist, but production qualification still requires their signed host matrices. Final Traditional layout source-of-truth validation and production calibration remain gated work.

## Important Types

- `SessionId`: opaque string session key.
- `KeyboardMode`: `romanized`, `traditional`, `unicode-proofread`, `dictionary-lookup`, or `diagnostic`.
- `KeyboardKeyEvent`: native/web normalized key event. `processKeyStroke` requires this shape and is not optional.
- `TypingContext`: app, field, locale, mode, layout, domain, secure-input, and surface policy.
- `CandidateUpdate`: per-update composition, display preview, candidates, proof hints, warnings, confidence, and latency.
- `CommitResult`: committed text plus consumed/replacement ranges and follow-up candidates.
- `WarmResult`: readiness, partial state, loaded modules, unavailable modules, warm time, and warnings.

## `compositionText` vs `displayText`

`compositionText` is the raw active buffer.

Examples:

- Romanized mode: `swas`
- Traditional placeholder mode: `abc`

`displayText` is the Unicode preview intended for OS marked/composition display.

Examples:

- `swasthya` -> `स्वास्थ्य`
- Traditional placeholder keeps `abc` until audited mapping exists.

Native integrations must treat these as separate values. The raw buffer is not always the preview.

Native learning is a two-phase transaction. `prepareCommittedCorrectionLearning(sessionId, commitEpoch)` validates the one-time host receipt and returns an opaque, frozen, privacy-projected row without changing ranking. The daemon persists that exact row first. Only after durable storage succeeds may it call `commitPreparedCorrectionLearning(prepared)`. A failed write neither consumes the pending receipt nor creates in-memory-only truth. `learnCommittedCorrection` remains the explicit in-process convenience path for storage-free browser/tests.

## Native Range Semantics

All public ranges use UTF-16 code units at the native boundary.

- `Candidate.replaceRange`: range in active composition buffer that a candidate replaces.
- `CommitResult.consumedRange`: range in active composition buffer consumed by the commit.
- `CommitResult.replacementRange`: range inside already committed surrounding context, mainly for proofread corrections.

If both `replacementRange` and `consumedRange` appear, the bridge applies `replacementRange` first, then clears/consumes `consumedRange`.

Helpers live in `src/engine/keyboard/ranges.ts`:

- `validateRange`
- `clampRange`
- `sliceByUtf16Range`
- `replaceByUtf16Range`
- `insertAtCaret`
- `deleteBeforeCaret`
- `deleteAfterCaret`

## Browser/Web-Lab Path

Use `updateComposition(sessionId, input, cursor)`.

The caller sends the full active composition string. This is the simplest path for React input events and local testing.

The neutral engine contract caps active composition at 128 UTF-16 code units. The exact bound is accepted. Bulk updates or key insertions that would produce `+1` fail open before refresh/model/proof/hash work and preserve the previous bounded session state. Caret and edit helpers clamp to extended-grapheme boundaries, so deletion cannot strand a surrogate or combining sequence. This is a work bound, not the larger committed-text limit.

## Native IME Path

Use `processKeyStroke(sessionId, key)`.

This method is required, not optional. It is the contract for Windows TSF and native adapters. The engine accepts malformed runtime key events defensively: missing modifier objects are normalized to false booleans, malformed UTF-16 and non-text modifier shortcuts pass through, and unknown or stale session IDs return bounded diagnostic `CandidateUpdate` values instead of crashing the host process.

Numeric candidate shortcuts commit through `processKeyStroke`, whose `CandidateUpdate` has no host-commit receipt. They therefore remain deliberately non-learning: recording a preference before the native host acknowledges its text edit would convert an attempted edit into false user-memory evidence. Shortcut learning can be enabled only after an acknowledgement-capable protocol grants the same one-time confirmation used by `memory.learn`.

## Candidate Finalization

Keyboard candidates are finalized before they reach UI or IPC callers:

1. collect bounded candidates from enabled sources;
2. normalize by candidate text for dedupe;
3. merge reasons from duplicate sources;
4. keep the highest-confidence candidate shape for the text;
5. sort by confidence and source/type priority;
6. cap the visible list;
7. assign sequential shortcuts after final sort.

Labels are explanatory metadata only. They do not make duplicate candidate text unique.

Use `processKeyStroke(sessionId, key)`.

The caller sends one normalized key event at a time. This path is required for Windows TSF and macOS InputMethodKit bridges.

Prompt 1 implements:

- printable character append;
- Backspace;
- Delete;
- Enter;
- Tab;
- Escape;
- Space as an exact raw delimiter commit in the default/browser/native contract;
- modifier shortcut pass-through warning.

Space follows the engine contract: raw text is the default for browser and native sessions, and IPC callers have no auto-commit authority. A test-build-only factory, excluded from production consumers and guarded by an opaque module-private capability, exercises the checked-in exact/single-output experiment. That policy validates before activation, explicitly quarantines ten known ambiguous/ordinary-Latin inputs, never grants learning authority, and remains production-ineligible until its human-rated intent, ambiguity, negative-corpus, and undo gates pass. Enter remains raw unless the user explicitly selected a candidate.

## Prompt 2 Intelligence Layer

Prompt 2 adds live keyboard behavior behind the same API:

- Romanized candidates update per keystroke.
- Romanized helper suggestions are available as secondary candidates.
- Candidate labels can show Romanized forms when `showRomanizedLabels` is true.
- Traditional physical key mapping remains placeholder-safe, while Unicode Traditional suggestions work.
- Proof hints populate `CandidateUpdate.proofHints`.
- Dictionary lookup returns local `DictionaryResult` rows without unsafe meanings.
- `commitCandidate` records local correction memory outside secure contexts.
- `CommitResult.followupCandidates` returns conservative phrase continuations.

## Secure Fields

If `TypingContext.secureInput` is true, or field type is `password` or `code`:

- candidates are empty;
- proof hints are empty;
- memory is not recorded;
- display text remains raw;
- warnings explain raw pass-through behavior.

## Traditional Placeholder

Traditional mode currently preserves raw composition and emits a warning:

`Traditional layout mapping pending source-of-truth audit; preserving composition.`

This is intentional. Final Traditional mapping must wait for the audit artifacts.

## Warm Startup

`warm(options?: WarmOptions)` must not block forever.

- `warm()` returns full readiness for lightweight modules.
- `warm({ timeoutMs })` may return `partial: true`.
- Partial warm still leaves the basic typing path usable.

## Ranking And Latency

Candidate linguistic ranking does not include a latency-cost penalty. Performance is controlled through:

- candidate caps;
- bounded lookups;
- caching;
- lazy loading;
- performance benchmarks.

Latency is reported in `CandidateUpdate.latencyMs` and benchmark reports, not mixed into linguistic score.
