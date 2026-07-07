# macOS IMK Proof Target

This folder documents and sketches the macOS InputMethodKit path for Lekh Keyboard.

The `skeleton` package now contains a buildable IMK-oriented proof target:

- `LekhInputController.swift`
- `LekhCandidateController.swift`
- `LekhCandidatePanel.swift`
- `LekhInlinePreviewPanel.swift`
- `LekhEngineCore.swift`

It is not a production macOS input method yet. The deterministic key path is intentionally in-process and has no synchronous XPC, daemon, file-decoding, or network dependency. Production still requires the complete macOS host-app matrix, Developer ID signing, notarization, installer validation, and pilot feedback.

See:

- `feasibility/README.md`
- `skeleton/LekhInputController.swift`
- `skeleton/lekh_imk_contract.md`
