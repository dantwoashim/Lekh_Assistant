# Windows Release Build

Generated: 2026-08-24

Status: the Windows implementation and local native build path are operational. A public production claim remains blocked on Authenticode signing and physical host-application validation.

## Shipping Architecture

The supported release target is a per-machine NSIS installer for Windows 11 x64. It contains:

- a 64-bit TSF DLL for native 64-bit applications;
- a matching 32-bit TSF DLL for 32-bit applications on 64-bit Windows;
- a 64-bit native named-pipe broker that owns the protected local IPC boundary;
- the bundled local deterministic daemon;
- the Electron companion for preferences, diagnostics, repair, tray recovery, and run-at-sign-in control.

Both TSF DLLs use the same text-service CLSID and language-profile GUID. Setup fails closed and rolls registration back if either architecture is missing or fails to register. The installer requires one administrator approval because TSF registration is machine-wide; preferences and startup behavior remain per-user.

Registration uses the Windows TSF APIs, declares keyboard and modern Windows-app compatibility, and enables the profile for the installing user through `InstallLayoutOrTip`. Setup never makes Lekh the default keyboard or silently switches the active input source.

## Local Windows Verification

Run from a Windows x64 development shell. The build wrapper locates the Visual Studio CMake bundled with Build Tools when CMake is not on `PATH`.

```powershell
npm ci
npm run v1:check:windows
node scripts/build-windows-tsf.mjs --architecture x64
node scripts/build-windows-tsf.mjs --architecture x86
```

For a temporary system-wide development registration:

```powershell
cd native\windows-tsf\skeleton
.\register-dev.ps1
# Test the keyboard, then clean up:
.\unregister-dev.ps1
```

The registration scripts request elevation once, register both DLLs, and roll back the 64-bit registration if the compatibility registration fails.

## Installer Build

An unsigned development installer must be built on Windows:

```powershell
npm run package:windows:unsigned
npm run check:windows-release
npx --no-install electron-fuses read --app "release\win-unpacked\Lekh Keyboard Companion.exe"
```

For a signed release build on the controlled release host:

```powershell
$env:CSC_LINK = "C:\secure\lekh-authenticode.pfx"
$env:CSC_KEY_PASSWORD = "<from the release secret store>"
npm run package:windows
npm run check:windows-release
```

The unsigned installer is diagnostic evidence only. Before publishing, verify the Authenticode chain and timestamp on the installer, companion executable, broker, and both TSF DLLs.

## User Experience Contract

- Windows key + Space selects or leaves **Lekh Keyboard Nepali** through the Windows input switcher.
- Setup enables Lekh in that switcher but preserves the user's current and default keyboards.
- Ctrl + Alt + Space cycles the two verified Windows modes.
- Ctrl + Alt + 1 selects English letters to Nepali; Ctrl + Alt + 2 selects Romanized text.
- Space or Enter commits the highlighted candidate; 1-8 selects a visible row; a pointer/touch click commits that row; Escape restores the source text.
- Candidate placement uses the active TSF composition rectangle, is owned by the active host window, and clamps to the current monitor; the legacy Win32 caret and pointer are fallbacks only.
- The popup raises Windows light-dismiss events and exposes the required UI Automation list, item names, selected state, and selection events to Narrator. In TSF UIless-only hosts it suppresses its custom popup instead of drawing forbidden UI.
- The input-switcher profile uses an icon embedded in the TSF DLL, so it does not depend on a loose image file after installation.
- Closing the companion keeps the keyboard service available in the notification area. **Exit Lekh Keyboard Companion** stops it explicitly.
- The broker is supervised with bounded restart backoff. Diagnostics report registration, broker response, startup state, architecture compatibility, and signing truth.
- **Repair text service** uses one UAC prompt and repairs both 64-bit and 32-bit registration.
- Personal learning is off by default on Windows. It records only explicit committed choices and can be disabled per executable without retaining its full path.
- Secure or unknown contexts clear composition and pass input through without learning.
- In-progress composition text uses a host-rendered, theme-safe TSF input underline that is cleared before commit or cancellation.
- This build does not silently download or install updates.

## Physical Release Matrix

Automation proves contracts, not real host compatibility. Record pass/fail, Windows build, app version and bitness, input caret placement, candidate placement, commit/cancel behavior, and screenshots where safe.

| Area | Required coverage |
| --- | --- |
| Core 64-bit hosts | Notepad, Word, Excel, Chrome, Edge, VS Code |
| 32-bit compatibility | A 32-bit TSF harness and 32-bit Office or another representative 32-bit editor |
| Web and forms | Contenteditable, textarea, search, and a representative Nepali government form |
| Safety | Password/PIN fields, unknown input scopes, Ctrl/Alt/Windows shortcuts, undo/redo |
| Lifecycle | Clean install, repair, in-place upgrade, reboot, sign-out/in, sleep/resume, uninstall, reinstall |
| Windows ergonomics | 100-200% DPI, multiple monitors, high contrast, light/dark system themes, keyboard, pointer, and touch candidate selection |
| Accessibility | Narrator announcement order, UIA candidate selection, keyboard-only flow, high contrast, and 200% scaling |
| Paths and identities | Custom long install path, Unicode user name, standard-user session after administrator install |
| Resilience | Broker crash/restart, companion exit/reopen, stale registration, offline use, rapid app switching |

## Privacy and Security Gates

- Normal typing is local and has no text telemetry or account dependency.
- The named pipe has a protected logon-session DACL and the TSF validates the exact broker image.
- IPC is versioned, bounded, ordered, and deadline-limited.
- The packaged shell validates and loads only its embedded ASAR, disables Node option and inspector injection, denies unneeded renderer/device permissions, and keeps only the Node mode required by the contained daemon.
- Packaging pins the current nine-fuse Electron schema, specifies every fuse, and fails closed if an Electron upgrade introduces an unknown fuse. The browser-specific snapshot fuse stays disabled unless a matching generated snapshot is deliberately packaged; enabling it without that file prevents Electron from starting.
- Diagnostics are local and redacted before export.
- The installer fails closed on missing native artifacts and removes both COM registrations and its startup value on uninstall.
- No release may instruct users to disable SmartScreen, antivirus, or operating-system security globally.

## Remaining External Gates

| Gate | Current truth | Required evidence |
| --- | --- | --- |
| Authenticode | Blocked externally | Trusted certificate, timestamp, and valid signatures on every native binary and installer |
| Physical host matrix | Not yet claimed | Completed matrix on clean Windows 11 x64 machines, including 32-bit host coverage |
| Accessibility validation | Not yet claimed | Keyboard-only, high-contrast, scaled-display, and screen-reader review |
| Pilot usability | Not yet claimed | Consented Nepali typists completing normal work without guided recovery |

## Release Claim

Do not call the Windows release production-ready or world-class until the external gates above pass. Passing builds, unit tests, TSF integration tests, and installer lifecycle automation establish engineering readiness; they do not establish publisher trust, physical-host behavior, or stranger usability.
