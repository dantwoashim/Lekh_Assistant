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

- `swasthya ` commits `स्वास्थ्य `;
- Enter/Space commit the selected composition;
- Backspace edits composition;
- Escape cancels marked text;
- Command/Control/Option shortcuts pass through.

Hot path requirements:

- binary lexicon ready target: under 5 ms from mmap open/header parse;
- candidate lookup target: under 1 ms p99;
- steady-state keyboard RSS target: under 25 MB;
- no per-keystroke XPC, network, daemon launch, or synchronous file decoding;
- any XPC/file-watching mechanism is allowed only for signed dictionary-pack hot-swap outside the key event path;
- never block host apps while refreshing packs.

Secure input:

- password/secure fields pass through or suppress suggestions/memory according to OS policy;
- no typed text leaves the local process boundary;
- diagnostics record timing counters only, not keys or text.

Production requires Developer ID signing and notarization.
