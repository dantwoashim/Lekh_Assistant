# Lekh Assistant

Lekh Assistant is a local-first Nepali typing assistant for macOS and Windows.
It lets you type Nepali in ordinary desktop apps instead of copying text from a
website.

The v1.0 product uses the deterministic engine:

- Romanized Nepali typing is the primary mode.
- Suggestions appear while you type and are committed only when you choose one.
- Traditional typing is available on macOS as a clearly labeled Beta.
- Windows v1.0 provides Romanized typing.
- Dictionary data and conservative proofread rules run locally.
- Password and other secure fields fail closed.
- Experimental neural/Core ML typing is off and is not packaged in v1.0.

## Download

Use the assets on the
[GitHub Releases page](https://github.com/dantwoashim/Lekh_Assistant/releases).

| Computer | Download | Supported release target |
|---|---|---|
| Apple Silicon or Intel Mac | Lekh-Keyboard-Test-Installer.zip | macOS 13 or newer |
| Windows PC | Lekh-Keyboard-Companion-<version>-Setup-x64.exe | Windows 11 x64 |

Both packages are unsigned. This project does not have a paid Apple Developer
ID or Windows code-signing certificate, so your computer will show an
unknown-developer or unknown-publisher warning. The warnings and limitations
are explained below; no signing or notarization claim is made.

## Install on macOS

1. Download Lekh-Keyboard-Test-Installer.zip.
2. In Finder, double-click the ZIP once. A folder named
   Lekh Keyboard Test Installer appears beside it.
3. Open that folder. Do not rename, remove, or rearrange its contents.
4. Control-click or right-click `Lekh Keyboard Test Installer.app`, choose Open, then click Open again.
5. Read the installer result and click OK.
6. Save open work, then log out of your Mac and log back in. macOS can cache
   newly installed input methods, especially unsigned ones.
7. Open System Settings → Keyboard.
8. Beside Text Input, click Edit….
9. Click the + button at the lower-left.
10. Select Nepali in the left column, select Lekh Keyboard in the right column,
    then click Add.
11. In the menu bar, click the current input-source icon and choose Lekh
    Keyboard.

### If macOS blocks the installer

The supported order is:

1. Try the Finder right-click → Open flow above.
2. If the app is still blocked, open System Settings → Privacy & Security,
   scroll to the Security section, and click Open Anyway for Lekh Keyboard Test
   Installer.
3. Only if both paths fail, open Terminal and run this command against the
   installer app itself:

    xattr -dr com.apple.quarantine "/path/to/Lekh Keyboard Test Installer.app"

Drag the installer app into Terminal to insert its exact path. Never run that
command on Downloads, your home folder, or an entire drive. Then repeat the
right-click → Open step.

### If Lekh is not listed under Input Sources

1. Confirm that the installer reported success.
2. Log out and back in; do not only close System Settings.
3. Return to System Settings → Keyboard → Text Input → Edit… → + → Nepali.
4. If it is still absent, run the installer again from the complete extracted
   folder and repeat the logout/login step.

## Install on Windows

1. Download the x64 Setup.exe asset.
2. Double-click it.
3. If Windows shows “Windows protected your PC,” click More info, verify that
   the file name is the Lekh installer you downloaded, then click Run anyway.
4. When User Account Control asks whether to allow changes, click Yes.
5. In Lekh Keyboard Companion Setup, keep the default install folder unless you
   have a reason to change it. Click Install.
6. Wait for the installer to finish. It registers the Lekh text service and
   starts the local background companion.
7. Press Windows key + Space.
8. Choose Lekh Keyboard Nepali.

If Lekh is not in the Windows key + Space list, sign out of Windows and sign
back in once. If it remains absent, uninstall Lekh Keyboard Companion, restart
Windows, and install the same Setup.exe again.

The Windows installer requires administrator approval because it registers a
machine-wide Text Services Framework component. The x64 install/start,
registration, background-service, uninstall, and cleanup lifecycle is exercised
on a Windows CI runner.

## Type Nepali

### Romanized mode

1. Select Lekh as your current input source.
2. Type the Nepali word using Latin letters. For example, type namaste.
3. Review the Devanagari candidates.
4. Choose the intended candidate. Lekh does not silently replace text with an
   unchosen suggestion.

Common protected Latin text—such as PDF, NID, email addresses, URLs, file
names, and numbers—is preserved instead of being forced into Devanagari.

### macOS controls

| Action | Control |
|---|---|
| Choose Romanized Nepali | Click the ले menu → Romanized → Nepali |
| Open the mode chooser | Control + Option + Space |
| Accept the gray inline completion | Tab or Right Arrow |
| Open/move through candidates | Down Arrow, then Up/Down |
| Commit the highlighted candidate | Return |
| Choose a visible shortcut | Option + 1, 2, or 3 |
| Keep/cancel to raw text | Escape |
| Turn Lekh off | Click the ले menu → Switch to ABC, or choose another input source |

Traditional → Nepali (Beta) and Traditional → Romanized (Beta) are available
from the same ले menu. Their physical layout has not been validated by an
experienced Traditional typist, so Romanized → Nepali is the recommended v1.0
mode.

### Windows controls

| Action | Control |
|---|---|
| Turn Lekh on or switch keyboards | Windows key + Space |
| Move through candidates | Up/Down Arrow |
| Choose a numbered candidate | 1–8 |
| Commit the selected candidate | Space or Enter |
| Turn Lekh off | Windows key + Space, then choose another keyboard |

To stop the Windows background companion completely, open Lekh Keyboard
Companion from the Start menu and choose File → Exit Lekh Keyboard Companion.
Typing then fails open to unchanged Latin input until you reopen the companion.

## Suggestions, dictionary, and proofread

- Suggestions come from bundled deterministic rules, word/phrase data, and
  local explicit-choice memory.
- Dictionary data improves candidate ranking and local lookup. v1.0 does not
  present itself as an authoritative dictionary with certified definitions.
- Proofread appears as conservative Fix candidates for supported active Nepali
  tokens. It is not a document-wide grammar checker.
- Nothing is committed merely because it appears in the candidate window.

## Uninstall

### macOS

Open the original extracted installer folder, right-click Lekh Keyboard
Uninstaller.app, choose Open, and confirm removal. Switch to ABC first if Lekh
is active. The uninstaller removes the input method and Lekh-owned local data,
including learned words, packs, backups, caches, and logs.

### Windows

Open Settings → Apps → Installed apps, find Lekh Keyboard Companion, open its
… menu, and choose Uninstall. Approve the User Account Control prompt. The
uninstaller stops the companion/broker, removes startup registration, unregisters
the text service, and removes the installed files.

## Privacy and safe behavior

Typing, suggestions, dictionary queries, and proofread processing stay on the
computer. The v1.0 typing path has no text telemetry and does not require an
account or network connection.

Lekh refuses to transform secure fields. If the host context, service, or IPC
state cannot be trusted, it clears local composition state and leaves host text
unchanged. Personal learning records explicit candidate choices locally; it
does not store surrounding sentences.

## Known limitations

- macOS and Windows packages are unsigned.
- Windows GUI behavior has automated native/logic coverage but no claimed
  physical Notepad, browser, or Word visual inspection.
- The Windows release installer is x64; ARM64 source builds and tests, but no
  ARM64 installer is currently shipped.
- Traditional typing is Beta and has no verified physical-layout corpus.
- Preeti results are fixture-based; there are no consented real-document or
  user-submitted validation rows.
- Proofread is conservative and is not full grammar correction.
- v1.0 has no auto-update service.

See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the complete release-honesty
record.

---

## Developers

End users do not need Node.js or a terminal. The rest of this README is for
contributors building from source.

### Prerequisites

- Node.js 24
- npm 11
- macOS: Xcode Command Line Tools and the macOS SDK
- Windows: Visual Studio Build Tools, CMake, and the Windows SDK

Install dependencies:

    npm ci

### Primary v1 command surface

These eight commands are the only documented top-level v1 entry points.
Lower-level maintenance scripts remain in package.json for maintainers and
historical workflows.

| Command | Purpose | Host |
|---|---|---|
| npm run v1:dev | Start the local development surface | macOS / Windows |
| npm run v1:build | Build the web/companion UI | macOS / Windows |
| npm run v1:test | Run the deterministic v1 test suite | macOS / Windows |
| npm run v1:check | Run format, types, tests, build, IPC, and commit-policy checks | macOS / Windows |
| npm run v1:build:macos | Compile the native macOS input method with neural typing off | macOS |
| npm run v1:build:windows | Compile the Windows TSF service | Windows |
| npm run v1:package:macos | Build and verify the unsigned universal installer ZIP | macOS |
| npm run v1:package:windows | Build the unsigned x64 Windows installer | Windows |

### Repository map

    src/                         Deterministic engine and focused UI
    native/macos-imk/skeleton/   macOS InputMethodKit implementation
    native/windows-tsf/skeleton/ Windows Text Services Framework implementation
    native/daemon/               Local deterministic daemon
    native/shared/               IPC and local storage contracts
    scripts/                     Build, package, and verification automation
    data/                        Bundled deterministic language data
    docs/                        Architecture, safety, and historical records

Architecture truth: Windows: TSF text service. macOS: InputMethodKit input method.
The Electron/browser demo is **not** the keyboard app. The companion app is **not** the keyboard app.
Preeti to Unicode is a side utility, not the main system-wide typing path.

### Current evidence

- [State of build](STATE_OF_BUILD.md)
- [Known limitations](KNOWN_LIMITATIONS.md)
- [Traditional / Preeti corpus result](C3_TRADITIONAL_PREETI_CORPUS_RESULTS.md)
- [Mid-mission adversarial review](ADVERSARIAL_REVIEW_MID_V1.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](docs/THIRD_PARTY_NOTICES.md)

## License

MIT. See [LICENSE](LICENSE).
