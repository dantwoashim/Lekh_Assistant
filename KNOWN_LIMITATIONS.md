# Lekh Assistant v1.0 — Known Limitations

This document distinguishes what the release automation proves from what still requires use on a physical computer. A documented hardware gap is not represented as tested.

## Windows typing validation

CI runs a native Windows integration test on x64 and ARM64. The test creates the real Windows Text Services Framework thread manager, document manager, focused context, and edit session; commits the deterministic engine result `नमस्ते` through `ITfInsertAtSelection`; and asserts that an in-memory `ITextStoreACP` target receives the exact Devanagari text while preserving pre-existing Latin text.

This proves the final native TSF text-mutation path without substituting clipboard or synthetic-key injection. The current CI sink does not emulate the full incremental composition lifecycle, prove interactive behavior in physical installations of Notepad, browsers, or Microsoft Word, exercise application-specific TSF quirks, or visually inspect the candidate popup. Those gaps require real Windows hardware and are not claimed as verified for v1.0.
