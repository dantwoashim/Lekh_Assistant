# Lekh Keyboard Companion Desktop Shell

This Electron wrapper packages the existing React companion UI as a desktop settings and diagnostics app.

It is not the keyboard input method. Windows keystrokes must go through the native TSF text service, and macOS keystrokes must go through the native IMK input method. The companion app only manages settings, privacy, dictionary/memory controls, diagnostics, release status, and side utilities.

Security defaults:

- `nodeIntegration` is disabled.
- `contextIsolation` and `sandbox` are enabled.
- The preload exposes a small read-only product boundary object.
- External navigation is denied except safe `https:` and `mailto:` links opened in the OS browser.
- Normal typing text is not sent to a network service.
- Update checks stay disabled unless the running macOS companion has a Developer ID application signature. The update client follows only pinned-host HTTPS redirects, bounds the streamed appcast/archive body independently of `Content-Length`, parses one unambiguous namespace-aware appcast item, and verifies both SHA-256 and the pinned Ed25519 archive signature.
- The Electron update path downloads a verified archive to a private temporary file and reveals it to the user; it does not claim notarized, unattended, or automatic installation without the required Apple release credentials.
