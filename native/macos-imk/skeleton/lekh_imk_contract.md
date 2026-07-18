# Lekh IMK Contract

The IMK bundle must be thin:

- receive key events through `IMKInputController`;
- keep the keystroke hot path inside the local IMK process;
- query the memory-mapped `runtime-suggestions.lkb` binary lexicon;
- use marked text for composition preview;
- use `IMKCandidates` for first candidate UI;
- commit selected text through IMK APIs;
- pass through safely if a host app cannot accept composition.

The minimum native behavior is:

- `swasthya ` commits raw `swasthya ` unless the user explicitly accepts `स्वास्थ्य`;
- Enter commits raw composition plus one newline, or an explicitly authorized candidate plus one newline;
- Space commits raw composition plus one space, or an explicitly authorized candidate plus one space;
- candidate authorization is a fresh physical-selection receipt bound to the exact candidate/surface generation, session, raw source, and host client; programmatic selection callbacks and asynchronous refreshes cannot reuse it;
- Backspace edits composition;
- Escape cancels marked text;
- Command/Control/Option shortcuts pass through.

Hot path requirements:

- binary lexicon ready target: under 5 ms from mmap open/header parse;
- candidate lookup target: under 1 ms p99;
- active composition is capped by the generated protocol contract at 128 UTF-16 code units;
- exactly 128 units remain composable, while any append crossing that bound is rejected before candidate, proofread, or neural work;
- a crossing grapheme or multi-character callback is never split: the prior raw composition is finalized (or its unmarked host text is retained), and the complete new callback returns to macOS once;
- steady-state keyboard RSS target: under 25 MB;
- no per-keystroke XPC, network, daemon launch, or synchronous file decoding;
- any XPC/file-watching mechanism is allowed only for signed dictionary-pack hot-swap outside the key event path;
- never block host apps while refreshing packs.

Secure input:

- password/secure fields pass through or suppress suggestions/memory according to OS policy;
- no typed text leaves the local process boundary;
- diagnostics record timing counters only, not keys or text.

Production requires Developer ID signing and notarization.
