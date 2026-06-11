# macOS Native Dev Proof Status

Generated: 2026-06-10

## Current Result

The macOS native keyboard path now has an unsigned development IMK input-method bundle that can be built, packaged, installed into `~/Library/Input Methods`, registered with macOS Text Input Source Services, enabled, and launch-smoked from the installed app bundle. The bundle includes the local `runtime-suggestions.json` pack for native word, phrase, and name suggestions.

Important safety correction: the dev installer must not auto-select the unfinished IMK as the global keyboard. A broken IMK can prevent typing across apps. Selection is now an explicit controlled-test step only.

This is stronger than a companion app and stronger than a browser demo. It is the correct macOS direction for Niraj's requested keyboard app.

## Verified Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run build:macos` | passed | Swift IMK target builds |
| `npm run package:macos:imk:dev` | passed unsigned dev | `release/native/macos/Lekh Keyboard.app` |
| `native/macos-imk/skeleton/install-dev.sh` | passed | copied to `~/Library/Input Methods/Lekh Keyboard.app`, registered, enabled, not auto-selected |
| `npm run check:macos-imk-bundle` | passed | verifies Info.plist, executable, controller, connection, Latin/Devanagari repertoire, and runtime suggestions pack |
| `npm run check:macos-imk-install` | passed | verifies installed bundle, registry discovery, launch smoke |
| `npm run test:native-scaffold` | passed | source-level native checks include IMK packaging/install scripts |

## What This Proves

- The macOS artifact is an actual InputMethodKit app bundle, not only Electron.
- macOS recognizes the bundle as `Lekh Keyboard`.
- The input source identifier is `com.lekh.inputmethod.keyboard`.
- The input source type is `TISTypeKeyboardInputMethodWithoutModes`.
- The input source can be enabled through native Text Input Source APIs.
- The packaged native engine can load local runtime suggestions from app resources.
- The installed app executable remains alive in a launch smoke.

## What Is Still Not Proven

The repo still must complete a real host-app typing matrix before public macOS launch claims:

- TextEdit typing
- Safari typing
- Chrome typing
- Pages typing
- VS Code typing
- password/secure text field pass-through
- daemon-down pass-through
- signed and notarized install on a fresh machine

The local attempt to automate TextEdit was blocked by macOS Accessibility permission for `osascript` in this environment. That is an environment permission issue, not proof that host typing works. It must be completed manually or in a CI/manual QA machine with Accessibility automation allowed.

## Current Launch Boundary

Allowed claim:

> The macOS native IMK development input method builds, installs, registers, enables, and launch-smokes locally.

Not allowed claim:

> The macOS keyboard is production-launch-ready.

That claim requires the host-app matrix, Developer ID signing, notarization, and fresh-machine install/uninstall verification.
