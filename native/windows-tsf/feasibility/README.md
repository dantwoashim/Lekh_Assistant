# Windows TSF Vertical Slice

The first real vertical slice now covers:

1. TSF activation and document/context focus lifecycle.
2. Explicit safe input-scope classification.
3. Real daemon `session.begin`, key processing, and `session.end` lifecycle.
4. Strict IPC response parsing and cross-session rejection.
5. Marked composition creation/update, commit, and cancel through `ITfEditSession`.
6. Fail-open behavior when privacy classification, daemon IPC, parsing, or host editing fails.

The slice is opt-in with `LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING=1`. Without that setting, every key passes through unchanged.

Native validation targets:

- Notepad
- Word
- Chrome and Edge
- VS Code
- Excel
- Windows Terminal
- password, PIN, private, search, rich-text, and government web-form fields

The portable protocol suite runs on non-Windows development hosts. The full DLL and its CTest suite require Windows, MSVC, CMake, and the Windows SDK.

Candidate UI, display attributes, contextual document reads, signing, installer validation, and the complete host matrix remain production blockers.
