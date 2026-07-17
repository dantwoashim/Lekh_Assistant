# Lekh Keyboard Companion

The companion app is the settings, diagnostics, privacy, dictionary, memory, and document-tools surface. It is not the IME and not the hot keystroke handler.

The current desktop companion packages the existing React UI through Electron:

- React UI: `src/features/companion/CompanionShell.tsx`
- Desktop wrapper: `electron/main.cjs`
- Preload boundary: `electron/preload.cjs`
- Packager config: `electron-builder.config.cjs`
- Windows NSIS hooks: `build/installer/windows/installer.nsh`
- Bundled daemon artifact: `native/daemon/dist/lekh-keyboard-daemon.mjs`
- Native Windows IPC owner: `native/windows-tsf/skeleton/LekhPipeBroker.cpp`

The companion does not globally hook keys and does not read foreground text. Native keystrokes must go through Windows TSF or macOS IMK.

Planned pages:

1. Home/status
2. Typing settings
3. Romanized settings
4. Traditional layout settings
5. Dictionary
6. Personal memory
7. Privacy
8. Document tools and Preeti side utility
9. Diagnostics
10. About/update

Build commands:

```bash
npm run build:companion
npm run package:windows:unsigned
```

On Windows, the companion starts the native pipe broker and never exposes the Node daemon directly. The broker launches the bundled daemon with an inherited-handle allowlist, removes Node injection variables, contains it in a kill-on-close job, verifies protocol readiness, and owns the protected per-logon-session named pipe expected by TSF. A bounded crash loop restarts the broker outside the key path. If either process is unavailable, TSF passes keystrokes through rather than freezing the host app.

Signed Windows release requires `CSC_LINK` and `CSC_KEY_PASSWORD`.
