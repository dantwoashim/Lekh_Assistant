# Lekh Assistant v1.0 — Known Limitations

This document distinguishes what the release automation proves from what still requires use on a physical computer. A documented hardware gap is not represented as tested.

## Windows typing validation

CI runs a native Windows integration test on x64 and ARM64. The test creates the real Windows Text Services Framework thread manager, document manager, context, and edit sessions; composes and commits `नमस्ते` through `ITfInsertAtSelection`, `ITfContextComposition`, and `ITfRange`; and asserts that an in-memory `ITextStoreACP` target receives the exact Devanagari text while preserving pre-existing Latin text.

This proves the native TSF text-mutation path without substituting clipboard or synthetic-key injection. The current CI environment does not prove interactive behavior in physical installations of Notepad, browsers, or Microsoft Word, does not exercise application-specific TSF quirks, and cannot visually inspect the candidate popup. Those gaps require real Windows hardware and are not claimed as verified for v1.0.
