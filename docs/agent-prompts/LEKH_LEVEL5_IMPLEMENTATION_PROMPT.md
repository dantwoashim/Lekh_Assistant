# Lekh Keyboard Level-1 to Level-5 Implementation Prompt

You are responsible for transforming Lekh Keyboard from a Level-1 native IMK prototype into Level-5 professional macOS software. You have `Lekh-Complete-Project-Context.xml`, which contains the repository inventory, relevant source, validated findings, and this prompt.

Produce an implementation-grade transformation plan. Do not respond with generic architecture advice. Every change must name the existing file or a precise new file, affected symbols, data contracts, migration behavior, tests, dependencies, and release gate.

## Level-5 Definition

Level 5 means:

- a real InputMethodKit keyboard working system-wide;
- one bounded, deterministic, in-process Swift engine on the keystroke path;
- no synchronous XPC, network, browser, Electron, or companion dependency while typing;
- four complete and distinct modes;
- predictable marked-text composition and candidate selection;
- a high-quality dictionary/FST/context pipeline with an optional honest neural tail;
- raw typing always recoverable;
- no host freeze when any optional component fails;
- no learning, logging, or retention in secure input;
- native, accessible, localized UX;
- Developer ID signing, hardened runtime, notarization, stapling, update, rollback, and uninstall;
- measured latency and accuracy;
- real evidence across the host-app matrix and multi-day native-speaker pilots.

## Required Architectural Direction

1. Extract a pure Swift `LekhEngineCore` target with no AppKit dependency.
2. Keep deterministic composition, lexicon lookup, FST generation, context ranking, and read-only personalization in-process.
3. Use administrative IPC only when justified for signed pack/model management, preference coordination, imports, or diagnostics.
4. Replace string-only candidates with a typed model carrying:
   - text;
   - normalized input;
   - score and calibrated confidence;
   - source (`exactDictionary`, `fst`, `context`, `personal`, `neural`, `proofread`);
   - scope (`token`, `phrase`, `nextWord`);
   - whether it is safe for default acceptance;
   - explanation/localization key.
5. Create one canonical transliteration specification that generates deterministic Swift and TypeScript tables.
6. Require exact parity for deterministic stages. Use rank-correlation/top-k metrics with explicit tolerances for contextual or floating-point ranking.
7. Wire binary lexicon validators into load-time acceptance and preserve the last known-good pack.
8. Give session state one explicit synchronization boundary: an actor, serial executor, or documented per-controller ownership with tests.

## Acceptance Contract Must Be Unambiguous

The current implementation and previous analyses confuse three different values:

- literal raw Latin input, such as `mero`;
- deterministic transliteration, such as `मेरो`;
- a ranked or contextual prediction, which may be a different token or phrase.

Design and document distinct actions for each. Use this professional baseline unless testing proves a better policy:

- The marked composition keeps the raw input recoverable and previews the current token candidate.
- Space accepts the visibly highlighted token candidate and inserts a space.
- Shift-Space provides a guaranteed literal-raw escape and inserts a space.
- Number keys choose visible candidates only when the candidate panel is active.
- Arrow keys change selection and preview.
- Enter accepts the selected candidate without silently inserting an unrelated phrase; a second Enter performs the host newline.
- Tab accepts only while a candidate panel is active and only if the preference enables it; otherwise Tab passes to the host.
- Escape first dismisses conversion/selection and restores recoverable raw composition. Define and test the second-Escape behavior explicitly.
- Backspace edits by grapheme cluster, never UTF-16 unit or scalar accident.
- Punctuation commits only a visible token candidate or deterministic transliteration according to the same acceptance policy.
- A phrase may replace active composition only when the active input itself spans the phrase. Next-word predictions are separate and can never replace a single token.

Do not implement a policy where ordinary Nepali typing requires pressing Tab after every word. Do not silently convert an unshown or unselected phrase.

## Inline Preview and Candidate UX

InputMethodKit marked text is the native composition mechanism. There is no universal trailing-ghost API.

Specify:

- raw and preview ranges using IMK-supported marked-text attributes;
- cursor and selection ranges in UTF-16 as required by Cocoa, while editing internal strings by grapheme cluster;
- capability-based fallback when a host ignores colour or marked ranges;
- no promise that custom grey colour renders identically everywhere;
- whether stock `IMKCandidates` or the custom panel is authoritative;
- panel anchoring, focus avoidance, click debouncing, keyboard navigation, VoiceOver, reduced motion, dark mode, multi-display placement, and dismissal;
- no “Button” placeholders, duplicate commits, stale marked text, or phrase-over-token replacement.

Candidate quantity is not a quality target. Show up to five. Show three or more only when distinct candidates pass relevance/confidence thresholds.

## Four Complete Pipelines

Define and implement:

### Romanized to Nepali

Latin normalization -> exact dictionary -> weighted deterministic FST -> personal preference -> context ranker -> optional neural tail -> Devanagari candidates.

### Romanized to Romanized

Romanized Nepali spelling normalization and completion -> protected Latin/code-switch handling -> Romanized suggestions only. Devanagari may be shown only as an explicitly labelled helper, never committed accidentally.

### Traditional to Nepali

Verified Nepali/InScript physical layout -> conjunct/matra/halanta state machine -> Unicode normalization -> Devanagari spelling/proofread candidates.

### Traditional to Romanized

Traditional physical input -> normalized Devanagari composition -> weighted many-to-many Devanagari-to-Romanized transducer -> ranked Romanized alternatives. Do not naively reverse a many-to-one forward table.

For each mode, provide fixtures, expected composition, candidates, acceptance behavior, protected-token behavior, and fallback.

## Engine and Model Quality

- Benchmark the existing Swift and TypeScript engines on the same frozen, human-gold, contamination-checked dataset before deciding what to port.
- Remove hardcoded demo rows from ranking authority after equivalent reviewed data exists in the pack.
- Use real corpus frequency and calibrated ranking.
- Do not force three low-quality candidates.
- Treat the current Core ML model as a disabled or clearly labelled non-production tail baseline.
- Apply strict neural gates only to production packaging; development/test builds must remain possible.
- Prefer shipping the first production model inside the signed app. Do not add writable model hot-swap until there is a justified update requirement and a fail-closed signature/version design.
- A future open-vocabulary model requires reproducible training, dataset provenance/licensing, held-out native-speaker evaluation, quantization measurements, Core ML compatibility, on-device latency, and fallback tests.
- Never advertise “neural,” “AI,” or accuracy numbers that the packaged artifact and inference path cannot prove.

## Host Compatibility

Start with standards-based IMK behavior and capability probes. Add host-specific workarounds only after a reproducible failure.

- Use the frontmost application bundle identifier only as a coarse signal.
- Do not assume `IMKTextInput` exposes a browser URL.
- Do not inspect Chrome/Google Docs URLs or accessibility trees without an explicit, separately justified privacy design.
- Capture actual event route, marked/selected/replacement ranges, commit result, and anonymized latency.
- Never log text, key values, candidate strings, or secure input.

Required matrix:

TextEdit, Notes, Safari fields/contenteditable/address bar where allowed, Chrome fields/contenteditable, Google Docs, Spotlight, Messages, Mail, WhatsApp Desktop, VS Code, Microsoft Word, Terminal, and password/secure fields.

## Security and Release

Specify:

- secure-input cancellation/pass-through and store-layer learning refusal;
- local-only user lexicon with view/export/forget/delete controls;
- no text telemetry;
- signed dictionary packs with last-good fallback and app-version compatibility;
- model integrity strategy;
- Developer ID Application/Installer identities;
- hardened runtime and minimal justified entitlements;
- notarization and stapling;
- atomic installation with rollback;
- restoration of the user’s previous input source;
- confirmation-based uninstall and optional personal-data deletion;
- stale-bundle detection without directly corrupting Apple preference files;
- crash-loop recovery that falls back safely rather than silently rewriting the user’s input-source configuration.

## Required Deliverable

Return:

1. Current architecture and runtime call graph.
2. Level-5 target architecture.
3. Product decisions that must be approved before coding.
4. File-by-file implementation map.
5. Exact types, protocols, state machines, schemas, and representative Swift patches.
6. Data migration and backward compatibility.
7. P0/P1/P2 sequence with dependencies, engineer-days, and rollback points.
8. Unit, integration, performance, security, accessibility, and host-app tests.
9. Objective accuracy/latency targets with measurement methodology.
10. Hidden-risk register.
11. Production release gates.
12. A first two-week implementation slice that is independently testable and leaves ABC recovery intact.

Do not call Electron or the companion app the keyboard. Do not invent an IMK ghost API. Do not treat a numeric timeout parameter as an enforced deadline. Do not claim host compatibility without real evidence. Do not recommend a per-keystroke XPC bridge.
