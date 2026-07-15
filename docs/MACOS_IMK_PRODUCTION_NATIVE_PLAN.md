# Lekh Keyboard macOS IMK Production Native Plan

Generated: 2026-06-11

> Historical note: the prototype findings below are retained as audit history.
> The normative current behavior and release gates live in
> `LEKH_SOTA_UX_CONTRACT.md` and
> `LEKH_LEVEL5_FORENSIC_TRANSFORMATION_REPORT.md`. The keyboard now uses an
> in-process deterministic engine and an optional asynchronous local Core ML
> tail; typing never depends on XPC or a network.

## 2026-07-15 IMK Launch Correction

On macOS 26.2, real `imklaunchagent` diagnostics proved that the legacy
`Lekh_Keyboard_Connection` name was refused as an unrecognized connection
identity. The transport contract now uses the bundle-derived third-party name
`com.lekh.inputmethod.LekhKeyboard_Connection` consistently in the plist,
server startup, companion health attestation, packaging, installation and host
probes. TextEdit then reached the actual controller path and explicitly
accepted `swasthya` as `स्वास्थ्य`. Natural TIS launch remains a required
regression test after every packaged install; a prelaunched server is diagnostic
evidence only.

## 2026-06-11 Implementation Update

Implemented in the repo after the initial diagnosis:

- `LekhInputController.swift` now has durable `os.Logger` logging, lifecycle hooks, `commitComposition`, `composedString`, `originalString`, command-selector handling for Escape/Backspace/Enter/Tab, secure-event pass-through, modifier pass-through, marked-range commit fallback, and real `IMKCandidates` wiring.
- `LekhXpcClient.swift` exposes composition/reset inspection so the controller can avoid swallowing Backspace/Enter/Tab/Space with no active composition.
- `App/main.swift` prevents duplicate IMK server instances and reads `InputMethodConnectionName` from `Info.plist`.
- `install-dev.sh` now restores ABC, kills stale IMK server processes, clears dev xattrs, ad-hoc signs the installed bundle, registers without auto-launching, and leaves ABC selected.
- `uninstall-dev.sh` restores ABC, unregisters from LaunchServices where possible, kills the IMK server, and removes the dev bundle.
- `package-macos-imk-dev.mjs` now packages the icon resource and ad-hoc signs the app bundle.
- `scripts/check-macos-imk-host-textedit-cgevent.mjs` adds a key-code CGEvent TextEdit probe. It remains a probe, not a release gate.

Verified after these changes:

- `npm run build:macos`: passed.
- `npm run test:native-scaffold`: passed, 7 files / 29 tests.
- `npm run package:macos:imk:dev`: passed, ad-hoc-signed bundle.
- `npm run check:macos-imk-bundle`: passed.
- `native/macos-imk/skeleton/install-dev.sh`: passed and left ABC selected.
- `npm run check:macos-imk-install`: passed.
- `npm run typecheck`: passed.

Important correction from implementation:

- `ComponentInputModeDict` was tested and removed from the dev plist because the attempted mode-enabled plist made `TISSelectInputSource` return `paramErr (-50)`. Do not add it to production until it has a separate compatibility spike that proves selection, System Settings visibility, and host typing. The current dev plist intentionally keeps the previously selectable single-source shape.

Still not production-ready:

- The CGEvent TextEdit probe currently records `blocked-automation`: it can select Lekh, but did not prove host text insertion in this desktop automation environment.
- Manual hardware host-app matrix evidence is still required.
- Developer ID signing, notarization, fresh-machine installer evidence, the full host matrix, and a multi-day pilot remain open gates.

## 1. Executive Diagnosis

Lekh is not production-ready as a native macOS keyboard. The browser demo and companion app are irrelevant to native readiness. The repo currently proves that an unsigned development IMK app bundle can build, install under `~/Library/Input Methods`, register with Text Input Source Services, enable, and launch-smoke. It does not prove that real host apps deliver key events to the controller or that marked text and commit behavior work across TextEdit, Safari, Chrome, Notes, Mail, Messages, WhatsApp Desktop, VS Code, Word, Google Docs, Spotlight, and secure fields.

The launch blocker is the missing verified native IMK event-to-composition-to-commit loop in real host apps. The current source also has production blockers: no real macOS XPC engine bridge, no real `IMKCandidates` panel, no secure-field pass-through detection in the IMK controller, incomplete lifecycle/session handling, no production signing/notarization, and only an automation probe that currently records `blocked-automation`.

Local evidence gathered on 2026-06-11:

- `swift build` passes in `native/macos-imk/skeleton`.
- `npm run test:native-scaffold` passes with 7 files and 29 tests when run with the bundled Node runtime.
- TIS sees one enabled input source: `com.lekh.inputmethod.keyboard`, localized name `Lekh Keyboard`, type `TISTypeKeyboardInputMethodWithoutModes`.
- The active input source was restored to `com.apple.keylayout.ABC`.
- The binary exports `_OBJC_CLASS_$_LekhInputController`, so the Swift controller class export is not the current smoking gun.
- At that historical checkpoint, `InputMethodConnectionName` and `IMKServer(name:)` both used `Lekh_Keyboard_Connection`; macOS 26.2 later proved that matching an arbitrary value internally was insufficient.
- Two controlled scripted TextEdit probes selected Lekh successfully but produced no `/tmp/lekh-imk-host.log` events and TextEdit remained empty. This confirms the script is not reliable host-app proof. It does not prove real hardware typing fails or works.

## 2. Root-Cause Table

| Area | Finding | Classification | Exact mechanism | Evidence |
| --- | --- | --- | --- | --- |
| Bundle registration | Dev app bundle is discoverable and enabled | confirmed working | TIS registry lists `com.lekh.inputmethod.keyboard` as enabled keyboard input method | `register-dev.swift`, local TIS query |
| Active keyboard safety | ABC restore works | confirmed working | `restore-system-keyboard.swift` selects ABC/US through TIS | local restore result |
| Controller class export | `LekhInputController` exists as Objective-C class | ruled out as current blocker | binary contains `_OBJC_CLASS_$_LekhInputController` | `nm -m` |
| Connection identity | Plist/server names matched but the name was not bundle-derived | later confirmed launch blocker | macOS 26.2 logged `Refusing connection name for bundle` | real `imklaunchagent` evidence, 2026-07-15 |
| Real host typing proof | No accepted evidence yet | confirmed blocker | TextEdit probe produced empty content and no controller event log | `reports/macos-imk-host-textedit-smoke.json`, 2026-06-11 probes |
| Automation reliability | AppleScript is not a release gate | confirmed blocker in test method | scripted `System Events keystroke` can bypass, race, or be denied before IMK event delivery | no `handle`/`inputText` log |
| Event route ambiguity | Controller implements `inputText`, `handle`, and partial `didCommand` | highly likely blocker | IMK has three alternative event styles; if keybinding route is used, Backspace/Enter/Tab may become selectors and current `didCommand` handles only Escape/cancel | SDK header plus source |
| Backspace/Enter/Tab policy | Incomplete outside `handle(_:)` route | highly likely blocker | command selectors can pass to host instead of editing/committing composition | source |
| Marked text reliability | Unverified across hosts | needs manual host-app test | `setMarkedText`/`insertText` are void; current code returns true after calls, so a rejecting host can appear as swallowed typing | source plus missing host evidence |
| Candidate UI | Not implemented natively | confirmed blocker | `LekhCandidateController` stores arrays only; no `IMKCandidates`, no `candidates(_:)`, no `candidateSelected(_:)` | source |
| Browser gray inline UX | Not native proof | confirmed product decision | native equivalent is marked text plus candidate panel; gray ghost text is app-specific and not portable | IMK API surface |
| XPC/daemon | macOS XPC client is stubbed | confirmed blocker | `LekhXpcEngineClient.processKey` creates an envelope then returns fallback; no `NSXPCConnection` or service | source |
| Daemon down behavior | Engine fallback exists only as source policy | partial | TypeScript daemon has 50 ms timeout; Swift XPC path is not real; active composition crash behavior is not host-tested | source/tests |
| Secure/password fields | Native detection missing | confirmed blocker | engine supports secure context, but IMK controller never detects `IsSecureEventInputEnabled` or field type and never suppresses marked text/memory itself | source |
| Modifier pass-through | Option/Alt can be mishandled | confirmed source bug | `handle` passes Command/Control through but not ordinary Option characters | source |
| Session lifecycle | Incomplete | confirmed blocker | no `activateServer`, `deactivateServer`, `commitComposition`, `composedString`, `originalString`, or per-client context cleanup | source |
| Install/uninstall | Dev-only | confirmed blocker | uninstall removes bundle only; no kill, `lsregister -u`, stale registration/cache handling, signed package, or fresh-machine flow | scripts |
| Signing/notarization | Not production | confirmed blocker | copied executable is ad-hoc signed, bundle resources/Info.plist are not sealed, no Developer ID/notarization | `codesign -dv` |
| Quarantine | Not observed | ruled out locally | no `com.apple.quarantine` xattr was present | `xattr -lr` |
| Stale bundle versions | Can happen | possible | stable bundle ID plus LaunchServices/TIS caches can run stale code until killed/logout | install method |

## 3. Confirmed Blockers

1. No real host-app matrix pass exists. TextEdit automation is currently `blocked-automation`, not proof.
2. The macOS XPC bridge is not implemented. XPC mode cannot transliterate.
3. Native candidate UI is not wired. There is no `IMKCandidates` panel.
4. Native secure-field pass-through is not implemented.
5. Lifecycle/session cleanup is incomplete.
6. Dev packaging is unsigned/unnotarized and not a clean install/uninstall product.
7. The team cannot claim native readiness until manual or reliable hardware-level host tests capture event logs, inserted text, screenshots/video, and diagnostics.

## 4. Likely Blockers

1. Mixed IMK event strategies will cause app-specific behavior. Pick one primary route and log fallback routes.
2. Some hosts will reject or mishandle marked text. Returning `true` after an unverified `setMarkedText` can swallow keys.
3. Electron/Chrome/VS Code/WhatsApp and Word will have different marked-text/candidate quirks.
4. Secure Event Input can bypass or suppress input methods. Lekh must pass through and avoid memory writes.
5. LaunchServices/TIS caches can preserve stale bundles. Fresh install testing and stale cleanup are mandatory.

## 5. Fix Architecture

### Bundle Structure

```text
Lekh Keyboard.app/
  Contents/
    Info.plist
    MacOS/LekhKeyboardIMK
    Resources/LekhInputSource.icns
    Resources/runtime-suggestions.json
    Resources/lekh-engine-contract.v1.json
    Resources/runtime-suggestions.lkb
    Resources/LekhNeuralTransliterator.mlmodelc/  # only after neural release gates
```

Install the IMK app under `~/Library/Input Methods/Lekh Keyboard.app` for per-user installs. Production may also support `/Library/Input Methods` only with admin installer validation.

### Required `Info.plist`

Use stable values and make code read from plist so names cannot drift:

```xml
<key>CFBundleIdentifier</key>
<string>com.lekh.inputmethod.LekhKeyboard</string>
<key>CFBundleExecutable</key>
<string>LekhInputMethodApp</string>
<key>CFBundlePackageType</key>
<string>APPL</string>
<key>LSUIElement</key>
<true/>
<key>LSMinimumSystemVersion</key>
<string>13.0</string>
<key>InputMethodConnectionName</key>
<string>com.lekh.inputmethod.LekhKeyboard_Connection</string>
<key>InputMethodServerControllerClass</key>
<string>LekhInputController</string>
<key>tsInputMethodCharacterRepertoireKey</key>
<array>
  <string>Latn</string>
  <string>Deva</string>
</array>
<key>tsInputMethodIconFileKey</key>
<string>LekhInputSource.icns</string>
```

The exact connection name is a runtime contract, not a naming preference. On
macOS 26.2, `imklaunchagent` rejected the arbitrary legacy
`Lekh_Keyboard_Connection` value as unrecognized. The shipping plist,
`IMKServer`, packaging gates, installer payload and installed bundle must all
use exactly `com.lekh.inputmethod.LekhKeyboard_Connection`; startup fails
closed if the value is missing or different.

### App Lifecycle

```swift
private final class AppDelegate: NSObject, NSApplicationDelegate {
  private var server: IMKServer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let bundle = Bundle.main
    let connection = bundle.object(forInfoDictionaryKey: "InputMethodConnectionName") as! String
    let bundleId = bundle.bundleIdentifier!
    os_log("starting IMK server connection=%{public}@ bundle=%{public}@", connection, bundleId)
    server = IMKServer(name: connection, bundleIdentifier: bundleId)
  }
}
```

Add startup assertions in debug builds:

- plist connection exists;
- `Bundle.main.bundleIdentifier == "com.lekh.inputmethod.keyboard"`;
- `NSClassFromString("LekhInputController") != nil`;
- one server object only;
- log process start and version.

### Controller Structure

```swift
@objc(LekhInputController)
final class LekhInputController: IMKInputController {
  private var session: NativeSession
  private var engine: EngineBridge
  private var candidatePanel: IMKCandidates?
  private var currentCandidates: [Candidate] = []

  required override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
    self.session = NativeSession()
    self.engine = EngineBridge.shared
    super.init(server: server, delegate: delegate, client: inputClient)
    self.candidatePanel = IMKCandidates(server: server, panelType: kIMKSingleRowSteppingCandidatePanel)
  }
}
```

Implement:

- `recognizedEvents(_:)` returns keyDown only for milestone 1.
- Primary route: `handle(_ event: NSEvent!, client:)`.
- Fallback route: `inputText(_:key:modifiers:client:)`, if needed after host logs prove a host uses it.
- Avoid bare `inputText(_:client:)` as the main route unless command-selector behavior is fully implemented.
- `didCommand(by:client:)` handles `cancelOperation`, `deleteBackward`, `insertNewline`, `insertTab`, and returns false when no composition exists.
- `activateServer` begins a session with app bundle/context and warms engine outside the hot path.
- `deactivateServer` commits or cancels according to active composition policy, hides candidates, ends session.
- `commitComposition` commits active primary/raw text, clears buffer, hides candidates.
- `composedString` returns current display marked text.
- `originalString` returns raw typed buffer as attributed string.
- `candidates(_:)` returns current candidate strings.
- `candidateSelected(_:)` commits the selected candidate.
- `candidateSelectionChanged(_:)` updates preview only, not committed text.

### Event Policy

| Key | No active composition | Active composition |
| --- | --- | --- |
| printable Latin/Devanagari | start/update composition, return true | update composition, return true |
| Space | return false | commit primary or raw plus trailing space, return true |
| Enter | return false | commit primary/raw, return true |
| Tab | return false | accept/cycle candidate only if candidate panel active; otherwise return false |
| Backspace | return false | delete one grapheme from raw buffer; clear marked text if empty |
| Escape | return false | cancel composition, hide candidates |
| Command shortcuts | return false | return false unless an explicit Lekh command is active |
| Control shortcuts | return false | return false except explicitly reserved mode UI |
| Option/Alt | return false by default | return false by default; do not consume Option characters |
| Secure Event Input | return false | cancel/clear local state and return false |

### Composition And Commit

- Keep raw composition separate from display text.
- Use `String` grapheme operations for Devanagari deletion and caret movement; convert to UTF-16 offsets only at IMK/client boundaries.
- Use `setMarkedText(_:selectionRange:replacementRange:)` for previews.
- Use `insertText(_:replacementRange:)` only to commit.
- Clear native state after commit/cancel.
- Never insert duplicate text after a commit.
- Treat `NSRange(location: NSNotFound, length: NSNotFound)` as default, but add host-specific evidence for TextEdit, Safari, Chrome, VS Code, Word, and Electron. If a host requires a different replacement range, encode it behind a host compatibility layer.

### Candidate Behavior

- The native equivalent of browser gray inline suggestions is marked text plus an IMK candidate panel. Do not promise browser-style gray ghost text system-wide.
- Use `IMKCandidates` for the first production UI.
- Show panel when candidates exist and composition is active.
- Hide panel on cancel, commit, deactivate, secure input, and empty candidate list.
- Use number selection keys for candidates. Tab is optional and must not break focus when no composition exists.
- Enter commits the selected/primary candidate only while composition is active, matching normal IME behavior.
- Space commits primary plus space while composition is active.

### XPC And Daemon Strategy

- Milestone 1 must not depend on XPC. Use a static Swift proof engine so host typing can be proven first.
- Production adds `com.lekh.keyboard.EngineXPC` with `NSXPCConnection`.
- The IMK hot path has a hard deadline: target 20 ms, absolute cap 50 ms.
- If no daemon session exists, begin/warm outside the key path.
- If XPC is down and there is no composition, return false so the host receives the original key.
- If XPC dies during active composition, commit raw buffer plus current printable key or cancel safely, then return true only if raw text was preserved.
- Validate message type, version, max payload bytes, string lengths, enum values, candidate counts, and UTF-8/UTF-16 boundaries on both sides.
- Do not send typed text to network services. No hidden telemetry. Diagnostics must be redacted by default.

### Install/Register/Uninstall

Install:

1. Restore ABC.
2. Kill old `LekhKeyboardIMK`.
3. Remove stale `~/Library/Input Methods/Lekh Keyboard.app`.
4. Copy signed app bundle.
5. Clear quarantine only in developer builds.
6. Run `lsregister -f`.
7. Run `TISRegisterInputSource`.
8. Run `TISEnableInputSource`.
9. Do not auto-select except in controlled QA scripts.
10. Show first-run instructions for System Settings -> Keyboard -> Input Sources -> Lekh Keyboard.

Uninstall:

1. Restore ABC.
2. Kill IMK server and XPC service.
3. Remove app bundle.
4. Run `lsregister -u` where available.
5. Remove launch agents/login items and XPC helper artifacts.
6. Offer to remove local settings/memory separately.
7. Tell user if logout/login is required for System Settings cache cleanup.

### Debug Logging

Use unified logging with subsystem `com.lekh.inputmethod.keyboard`.

Categories:

- `lifecycle`: app start, server start, activate/deactivate.
- `event`: route, modifier class, action, and lengths only. Do not log typed text or physical key codes.
- `composition`: buffer length, display length, candidate count, commit/cancel.
- `candidate`: show/hide/update/selected.
- `xpc`: health, warm, latency, timeout, fallback.
- `install`: register/select/restore results.

QA debug builds may enable extra lifecycle diagnostics behind `LEKH_IMK_DEBUG_LOG=1`, but they must still avoid raw text, candidate text, committed text, clipboard content, and physical key codes.

### Recovery

- Companion status must show current input source, IMK server status, XPC health, daemon warm status, and last fallback reason.
- Provide an emergency Restore ABC button.
- Provide `native/macos-imk/skeleton/restore-system-keyboard.sh` as a documented recovery command.
- Do not auto-select unfinished IMK during install.
- If the IMK detects repeated failures, it should disable composition for the current session and pass through.

## 6. Implementation Sequence

1. Add lifecycle/event logging and expose route logs for `activateServer`, `deactivateServer`, `handle`, `inputText`, `didCommand`, `commitComposition`, and candidates.
2. Build a minimal static IMK proof with no XPC dependency.
3. Wire `IMKCandidates` and `candidates(_:)`, even if only one static candidate exists.
4. Run manual hardware TextEdit test with logs and video.
5. Expand to Safari, Chrome, VS Code.
6. Fix host-specific marked text/commit issues.
7. Add secure-field pass-through and test password fields.
8. Add real XPC service and bounded bridge.
9. Add companion diagnostics and Restore ABC.
10. Build signed/notarized package and fresh-machine installer.
11. Run full app matrix and multi-day pilot.

## 7. Minimal IMK Proof Milestone

Acceptance is exactly this:

- Install input method under `~/Library/Input Methods`.
- Select Lekh intentionally.
- Type `swasthya ` with a real keyboard in TextEdit. Result: `स्वास्थ्य `.
- Repeat in Safari text field, Chrome text field, and VS Code editor.
- Space commits.
- Escape cancels active composition.
- Backspace edits active composition by one grapheme.
- Command shortcuts pass through.
- Daemon/XPC down cannot freeze the host. In milestone 1, no daemon is used.
- Restore ABC works immediately.

Minimal implementation rules:

- Static Swift engine maps `swasthya` -> `स्वास्थ्य`.
- Primary event path logs `handle` route.
- If a host uses `inputText` or `didCommand`, log and implement parity.
- Candidate UI may show one candidate, but it must be native `IMKCandidates`.
- No memory writes.
- No telemetry.
- No XPC.

Pass evidence:

- `/tmp/lekh-imk-host.log` or unified log export showing route/action/latency.
- Screenshot or video for each app.
- Current input source before and after.
- Text content copied from the host app.
- ABC restore confirmation.

## 8. Production IMK Milestone

Add after minimal proof:

- Real engine bridge through XPC or an embedded native engine if XPC latency is not reliable.
- `NSXPCConnection` service with health/warm/session/keystroke/candidate APIs.
- Candidate panel with selection keys, annotations/labels where useful, and host-specific positioning tests.
- Mode switcher for four surfaces: Romanized -> Nepali Unicode, Romanized -> Romanized helper, Traditional -> Traditional suggestions, Traditional -> Romanized helper.
- Preferences UI in companion.
- Diagnostics export with redacted logs.
- Secure input and password field pass-through.
- Signed and notarized installer.
- Clean uninstall.
- Crash recovery, daemon restart, timeout fallback.
- Pilot support tooling.

## 9. Test Matrix

For every app below, run the cases below and record expected result, evidence, logs, and screenshots/video.

Apps:

| App | Exact test location | Evidence |
| --- | --- | --- |
| TextEdit | new plain-text document | saved `.txt`, log, video |
| Notes | new note body/title | screenshot, copied text, log |
| Safari | address/search bar and normal web text field | screenshot, copied text, log |
| Chrome | address/search bar, web form, Google Docs | screenshot/video, copied text, log |
| Messages | compose field to self/test thread | screenshot, do not send private text |
| Mail | draft subject/body | saved draft screenshot, log |
| WhatsApp Desktop | test chat compose field | screenshot/video, log |
| VS Code | editor buffer and find box | saved file, screenshot, log |
| Microsoft Word | document body and title/search if relevant | `.docx`, screenshot, log |
| Google Docs | browser document body/title | screenshot/video, copied text, log |
| Spotlight | search field | screenshot/video, log |
| Password fields | local test page and macOS password prompt where allowed | no typed text captured, only pass-through/fallback log |

Cases:

| Case | Steps | Expected |
| --- | --- | --- |
| Romanized word | type `swasthya ` | `स्वास्थ्य ` committed |
| Romanized phrase | type `mero swasthya ramro xa ` | expected Nepali phrase committed or candidate-gated per engine policy |
| Mixed English/Nepali | type `meeting ma swasthya report ` | protected English tokens preserved according to policy |
| Protected token | type email, URL, phone, code-like token | token not corrupted |
| Traditional input | switch Traditional; type verified Devanagari sequence | composition/candidates behave per mode |
| Backspace | type `swas`, Backspace twice, continue | active composition edits, no stale marked text |
| Escape | type `swas`, Escape | marked text clears, no commit |
| Enter | type `swasthya`, Enter | composition commits; second Enter performs host action |
| Tab | no composition then Tab; active composition then Tab | focus moves when no composition; candidate action only when active |
| Space | active composition then Space | commit plus space |
| Command shortcut | type active composition, press Command-A/C/V/Z/S | shortcuts pass through or composition policy is documented |
| Input source switching | ABC -> Lekh -> ABC while app focused | no stuck composition, no lost typing |
| Daemon down | kill XPC/daemon before and during composition | host never freezes, raw typing preserved or safe cancel |
| Daemon restart | restart daemon mid-session | reconnect outside hot path |
| Sleep/wake | sleep Mac, wake, type | no gray/stale input source, no freeze |
| App restart | quit/reopen host app | new session clean |
| Logout/login | logout/login after install | input source still listed and starts |
| Uninstall/reinstall | uninstall, verify ABC, reinstall | no stale versions, no broken typing |

Log path:

- Unified logs: `log show --last 30m --predicate 'subsystem == "com.lekh.inputmethod.keyboard"'`
- QA debug file if enabled: `/tmp/lekh-imk-host.log`
- Reports: `reports/macos-imk-host-matrix/<date>/<app>.json`

## 10. Hidden Risk Register

| Risk | Detection | Prevention | Test case | Release gate |
| --- | --- | --- | --- | --- |
| IMK API behavior differs by macOS version | run same matrix on macOS 13, 14, 15, 26 | compatibility layer and versioned logs | TextEdit/Safari/Chrome on each OS | all supported OS versions pass |
| `handle` vs `inputText` route differs | log route per key | implement parity or choose one route | each app route report | no unhandled route |
| Electron marked text quirks | VS Code/WhatsApp tests | host compatibility fixes | composition/backspace/commit | pass both Electron apps |
| Word/Office quirks | Word body/title tests | replacement range compatibility | phrase, backspace, enter | Word pass |
| Secure fields | `IsSecureEventInputEnabled`, password test page | pass-through, no memory | password field typing | no text logged/stored |
| Candidate UI inconsistent | visual screenshot and route logs | use `IMKCandidates` first | candidate show/select/hide | all core apps pass |
| Devanagari grapheme bugs | unit tests plus host deletion video | use Character/grapheme operations | matra/halanta/backspace | no broken clusters |
| First-key performance spike | latency logs | warm engine on launch/activate | first word after login | p95 below 20 ms, cap 50 ms |
| Daemon crash loop | kill/restart test | circuit breaker and pass-through | daemon down/restart | no freeze, no stuck IMK |
| Stale input registration | fresh VM and reinstall tests | kill old app, remove stale bundle, version bump | uninstall/reinstall/logout | no duplicate/stale source |
| User cannot recover | forced broken IMK drill | Restore ABC in companion and script | break daemon then restore | ABC restored under 10 seconds |
| Shortcut conflicts | shortcut audit | avoid global hooks; use input menu or preferences | Command/Control/Option cases | no host shortcut broken |
| Apple Silicon vs Intel | run on both | universal build/signing | smoke matrix | both pass |
| Notarization/hardened runtime | notarization CI | sign app and XPC together | fresh download install | Gatekeeper accepts |
| XPC entitlement issue | Console/XPC logs | correct bundle IDs and signing chain | XPC health/warm | service launches |
| Privacy review | diagnostics audit | redaction by default, no telemetry | secure and normal typing logs | no typed text in default logs |

## 11. Release Gates

Do not call macOS production-ready until all are true:

- TextEdit, Notes, Safari, Chrome, Messages, Mail, WhatsApp Desktop, VS Code, Word, Google Docs, Spotlight, and password-field tests pass.
- No host app freezes.
- No broken typing state after daemon crash, sleep/wake, app restart, logout/login, or input source switching.
- Secure fields pass through and do not write memory or diagnostics containing typed text.
- Protected tokens are not corrupted.
- IMK server starts reliably.
- XPC/daemon starts reliably.
- Timeout fallback works when daemon dies.
- Install/uninstall/reinstall are clean.
- Restore ABC works.
- Signed and notarized package exists.
- First-run setup is clear.
- Diagnostics are available and redacted.
- Pilot users type real messages/documents for multiple days without P0/P1 typing bugs.

## 12. Exact Next Actions For Engineers

1. Add native route logging and lifecycle overrides to `LekhInputController.swift`.
2. Replace the candidate state holder with real `IMKCandidates`.
3. Implement `commitComposition`, `composedString`, `originalString`, and `candidates(_:)`.
4. Make `didCommand` handle Backspace, Enter, Tab, Escape with the same policy as `handle`.
5. Pass through Option/Alt by default.
6. Add secure input detection and fail-open behavior.
7. Remove XPC dependency from milestone 1; keep static `swasthya` proof.
8. Create a manual QA script that prints current input source, starts log capture, asks the tester to type real hardware keys, restores ABC, and writes a report.
9. Prove TextEdit with `swasthya ` -> `स्वास्थ्य `.
10. Prove Safari, Chrome, and VS Code.
11. Only after milestone 1 passes, implement XPC service and daemon bridge.
12. Build signed/notarized installer and run fresh-machine matrix.
