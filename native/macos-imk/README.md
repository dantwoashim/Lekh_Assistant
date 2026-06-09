# macOS IMK Proof Target

This folder documents and sketches the macOS InputMethodKit path for Lekh Keyboard.

The `skeleton` package now contains a buildable IMK-oriented proof target:

- `LekhInputController.swift`
- `LekhCandidateController.swift`
- `LekhXpcClient.swift`

It is not a production macOS input method yet. Production requires an installed IMK bundle, real XPC service, macOS host-app testing, Developer ID signing, notarization, installer validation, and pilot feedback.

See:

- `feasibility/README.md`
- `skeleton/LekhInputController.swift`
- `skeleton/lekh_imk_contract.md`
