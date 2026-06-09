# Lekh Keyboard Companion Desktop Shell

This Electron wrapper packages the existing React companion UI as a desktop settings and diagnostics app.

It is not the keyboard input method. Windows keystrokes must go through the native TSF text service, and macOS keystrokes must go through the native IMK input method. The companion app only manages settings, privacy, dictionary/memory controls, diagnostics, release status, and side utilities.

Security defaults:

- `nodeIntegration` is disabled.
- `contextIsolation` and `sandbox` are enabled.
- The preload exposes a small read-only product boundary object.
- External navigation is denied except safe `https:` and `mailto:` links opened in the OS browser.
- Normal typing text is not sent to a network service.
