# Lekh macOS UX contract

Status: normative development contract. A release must block when a MUST item is not evidenced.

## Product boundary

- The InputMethodKit bundle is the keyboard. It alone receives host key events and owns composition.
- The macOS companion configures setup, preferences, privacy and diagnostics. It never receives per-keystroke content.
- The browser surface and Windows companion are not the macOS keyboard.
- A model is described as neural only when a compiled artifact, manifest, invocation path and prediction evidence agree.

## Interaction objective

Lekh minimizes *attention cost per correct token*, not merely physical keystrokes. Suggestions are useful only when their expected savings exceed the cost of noticing, evaluating and rejecting them.

Primary research basis:

- Apple InputMethodKit candidates: https://developer.apple.com/documentation/inputmethodkit/imkcandidates
- Apple macOS candidate-window behavior: https://support.apple.com/guide/chinese-input-method/cim12992/mac
- Apple settings guidance: https://developer.apple.com/design/human-interface-guidelines/settings
- Apple accessibility guidance: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Quinn and Zhai, suggestion interaction cost: https://research.google/pubs/a-costbenefit-study-of-text-entry-suggestion-interaction/
- Arnold, Gajos and Kalai, phrase suggestions versus predictions: https://www.microsoft.com/en-us/research/publication/suggesting-phrases-vs-predicting-words-mobile-text-composition/
- Aksharantar transliteration benchmark: https://aclanthology.org/2023.findings-emnlp.4/

## Assistance ladder

Only one level may demand user attention at a time.

1. **Fail-open raw input**
   - Secure input, an unavailable client, invalid geometry, engine failure or rejected data pack MUST leave raw host typing available.
   - No auxiliary window may appear in secure input.

2. **Marked composition**
   - The host marked range is the sole editable composition.
   - It MUST remain stable as asynchronous candidates arrive.
   - Prefix-only whole words MUST NOT replace a stable exact or deterministic token preview.

3. **Inline completion**
   - At most one suffix-only completion may appear.
   - It MUST be same-script, single-token, bounded, and backed by a trusted source/target suffix relationship until confidence is human-calibrated.
   - It MUST be a separate nonactivating, mouse-transparent surface and never become part of marked text.
   - It is accept-enabled only after the panel successfully renders at valid host caret geometry.

4. **Passive alternatives**
   - The passive candidate panel shows at most three relevant alternatives.
   - No row is selected or visually highlighted in the passive state.
   - Option-1 through Option-3 or a deliberate mouse-up may choose a passive alternative.
   - Plain digits remain ordinary typing until candidate browsing is explicitly engaged.

5. **Expanded candidate browsing**
   - Down or Up enters explicit browsing, dismisses the ghost, and selects a visible row.
   - Up/Down wrap. Home/End select boundaries. Page Up/Page Down change pages when pages exist.
   - In this state only, Space or Return may confirm the selected candidate; the visible selected state and commit behavior must agree.

## Key contract

| State | Key | Required result |
|---|---|---|
| Ghost visible | Tab or Right Arrow | Commit exactly the visible accepted token; no implicit trailing space |
| Passive alternatives | Option-1…3 | Commit exactly that visible row |
| Passive alternatives | Plain 0…9 | Do not commit a candidate |
| Browsing | 1…8 | Commit the corresponding visible page row |
| Browsing | Space | Commit selected candidate plus one space |
| Browsing | Return | Commit selected candidate plus one newline |
| Not browsing | Space | Commit exactly the raw composition plus one space; experimental auto-commit has no native or production authority |
| Not browsing | Return | Commit exactly the raw composition plus one newline |
| Any composition | Shift-Tab | Commit raw, then pass focus traversal to the host exactly once |
| Converted composition | First Escape | Dismiss alternatives and commit the exact raw composition without learning or data loss |
| No active composition | Second Escape | Pass through to the host so its overlay/dialog can dismiss normally |
| Secure input | Any | No suggestion, learning, inference, content diagnostic or retained content |

## Composition-surface state machine

`idle → composing → renderScheduled → rendered`

- Every render schedule captures session ID, raw buffer and a monotonically increasing generation.
- A render is discarded if any capture no longer matches.
- Caret geometry is queried one main-run-loop turn after `setMarkedText`.
- Invalid, nonfinite or off-screen geometry hides both auxiliary surfaces; mouse-position fallback is forbidden.
- A new physical key invalidates the old render before engine work begins.
- Focus loss, host commit, cancel, secure-input activation and controller close hide all surfaces.

`rendered` has mutually coordinated substates:

- `ghost` (candidate panel hidden; Down/Up reveals alternatives)
- `passiveCandidates` (shown only when no safe ghost is visible)
- `expandedCandidates` (ghost hidden)
- `dismissedRaw` (both hidden)

## Candidate quality contract

- Exact, protected and explicitly learned candidates form the primary tier.
- Prefix completions and contextual candidates form a secondary tier and cannot displace a stable current-token candidate.
- A single-token input cannot yield whitespace, line separators, control characters or a phrase candidate.
- Romanized→Nepali candidates contain Devanagari and no Latin, except an intentional protected raw token.
- Romanized→Romanized and Traditional→Romanized candidates contain no Devanagari.
- Traditional→Nepali output remains Devanagari or the exact raw traditional token.
- Personal candidates require at least two explicit acceptances before promotion.
- Personal context boosts require at least two observations and are capped so old behavior cannot dominate forever.
- NFC-equivalent candidates deduplicate to one visible row.

## Companion state machine

The companion derives state from the installed bundle and Text Input Source APIs; it does not ask the user to declare state.

1. `missing`: explain that the native input method is absent and reveal the install location.
2. `installedUnregistered`: open Keyboard Settings because macOS has not registered a selectable source.
3. `registeredDisabled`: an explicit **Enable Lekh** action calls the system input-source API; failure opens Keyboard Settings.
4. `enabledInactive`: **Use Lekh Now** explicitly selects Lekh and explains Control-Space/ABC recovery.
5. `active`: offer **Try in TextEdit** and show no setup warning.

The state refreshes on launch, app activation, wake and a low-frequency foreground timer. “Ready” and “setup incomplete” may never appear simultaneously.

macOS packaging MUST:

- use a universal native SwiftUI/AppKit executable;
- remain below 10 MiB before signing/notarization;
- embed no Electron framework or browser renderer;
- declare no camera, microphone, audio-capture, Bluetooth or location usage;
- disallow arbitrary network loads;
- use the Utilities category;
- have no special runtime entitlements unless a reviewed feature proves need.

## Accessibility contract

- Candidate and ghost panels never become key windows or steal host focus.
- Every candidate exposes button role, absolute candidate number, text, explanation and selected state.
- VoiceOver announcements occur once per composition, at low priority, and only for a suggestion actually visible on screen.
- The companion uses native controls, logical keyboard order and explicit labels/hints.
- Meaning is never conveyed by color alone.
- Reduce Motion disables panel animation.
- Reduce Transparency uses an opaque surface.
- Increase Contrast strengthens text, borders and selection without changing behavior.
- No instruction or status disappears on a timer.

## Privacy and trust contract

- Private Mode is reachable directly from the input menu and is reflected in the companion.
- Secure fields override every learning preference.
- Clearing personal learning deletes token and bigram rows, clears in-memory ranking state, and checkpoints the WAL.
- Safe diagnostics contain versions, booleans, counts and latency aggregates only—never keys, words, candidates or surrounding text.
- Development/ad-hoc signing is labeled as development; only a real Developer ID certificate may display Developer ID status.

## Release evidence

A UX-quality candidate requires all of the following:

- Native companion source tests and universal package check pass.
- Companion accessibility tree exposes every navigation item, mode, toggle, destructive confirmation and diagnostic action.
- Light, Dark, Increase Contrast, Reduce Transparency and Reduce Motion are inspected.
- 820×620 and 1440×900 window layouts have no unreachable controls.
- TextEdit HID probes prove ghost presence/acceptance, exact raw Space, passive digit safety, explicit candidate selection and two-stage Escape; any future calibrated auto-commit requires a separately promoted contract and host matrix.
- Required host matrix records screenshots, committed text and surface behavior for every host/version.
- Deterministic p99 stays below 5 ms after all UX logic.
- End-to-end neural-tail latency measures complete beam decoding, not a single Core ML forward pass.
- Native-speaker blind evaluation meets the declared quality gates; generated or contract-seed data cannot substitute for reviewed gold.
- A 72-hour soak and multi-day pilot report crashes, stuck marked ranges, focus theft, accidental commits and suggestion acceptance/rejection rates using content-free aggregates only.

No document or guard-script pass alone proves SOTA. The claim requires shipped-artifact, real-host, native-speaker and pilot evidence.
