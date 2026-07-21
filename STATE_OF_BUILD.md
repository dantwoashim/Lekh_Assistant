# Lekh Assistant v1.0 — State of Build

Baseline captured on 2026-07-18 at source revision
`9668c6363fd7c342f1a13edc9f08aeee067f327f` on an Apple Silicon Mac running
Node.js 24.14.0 and npm 11.8.0.

This is executable baseline truth for the v1.0 release mission. It deliberately
separates engine tests, native builds, operating-system integration, and real
host-application evidence. A source contract is not counted as a working input
method, and an installed bundle is not counted as usable unless the operating
system exposes and runs it.

## Current end-to-end status

| Surface | What was run | What works now | What is not yet proved |
|---|---|---|---|
| macOS Romanized typing | TypeScript keyboard suite, shared behavior contract, native Swift build, and TypeScript/Swift byte comparison | The deterministic engine composes Romanized input, produces Devanagari candidates, preserves bounded Latin/protected spans, handles graphemes safely, commits an explicitly chosen candidate, and fails closed in password/unknown contexts. The Swift adapter produces byte-identical results for all 31 shared contract cases. | No fresh host-application typing run was performed in this baseline. The installed build is not currently present in the enabled or selected input-source preferences, so system-wide typing is **not claimed end-to-end today**. |
| macOS Traditional / Preeti | Existing Traditional and Preeti tests in the focused product sweep | Native Traditional candidate behavior and the existing Preeti paste-conversion fixtures pass their automated tests. | Native Traditional has no fresh host run. The TypeScript Traditional layout is still marked `pending-audit`, and the Preeti converter is not exposed as a system-wide input scheme in the current focused app. |
| macOS suggestions, dictionary, proofread | Focused product sweep and keyboard suite | Deterministic suggestions, candidate selection, local dictionary lookup APIs/data, protected-span handling, and the current bounded proofread rules pass. | The shipping focused UI does not expose dictionary lookup or a standalone proofread panel. Their system-wide host behavior is not proved by this baseline. |
| macOS build/install | Native Swift build; installed-bundle identity, architecture, signature, and input-source preference inspection | The native package builds when the matching SDK is selected. A previously installed `Lekh Keyboard.app` build 176 exists, is a universal `arm64` + `x86_64` Mach-O, and passes local ad-hoc code-sign verification. | Build 176 is not a v1.0 artifact, is not enabled/selected, is unsigned by Apple and unnotarized, and has its experimental-neural bundle flag enabled. No fresh install/use/uninstall simulation was run. |
| Windows Romanized typing | Windows source/unit proxy tests on macOS and the latest real Windows CI job | IPC schema generation passes; the TSF source-contract tests and installer source contract pass. The repository contains a TSF/broker implementation that is testable at source level. | The latest CI run stopped before MSVC compilation and CTest. There is no passing integration receipt showing Devanagari reached a Windows target sink, so system-wide Windows typing is **not working end-to-end by available evidence**. |
| Windows candidates | Windows source-contract tests | Candidate-window source and state contracts are present and their source tests pass. | No passing Windows runtime/UI integration test currently proves rendering, navigation, or text commit. |
| Windows installer | `npm run check:windows-installer-contract` | The installer source contract passes: required DLL and broker paths exist and packaging fails closed when required inputs are missing. | No CI log currently proves silent install, registration, broker startup, uninstall, and cleanup. |
| Cross-platform deterministic web/companion surfaces | Focused Vitest sweep, app smoke, production web build, offline/privacy/user-data/IPC checks | 191 focused product tests pass; the web build completes; its service worker precaches 15 URLs; no text-telemetry payloads are found; the IPC schema is version 2 with 18 message types. | The focused web UI is not a system-wide keyboard and currently omits end-user dictionary/proofread panels. Windows has no visible companion Quit action in the tested surface; input-source switching is the current toggle. |

## Exact local commands and results

All Node commands used this runtime prefix:

```sh
export PATH=/Users/rohanbasnet14/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
```

### Focused deterministic product sweep

```sh
npx vitest run src/core/transliteration/transliterateRomanized.test.ts src/engine/romanized/candidateEngine.test.ts src/engine/keyboard/keyboardEngine.test.ts src/engine/keyboard/modes.test.ts src/core/dictionary/dictionary.test.ts src/engine/proofread/proofread.test.ts src/engine/protected/protectedSpans.test.ts src/engine/traditional/traditional.test.ts src/core/preeti/convertPreetiToUnicode.test.ts src/features/companion/companionModel.test.ts src/features/companion/settings.test.ts src/features/companion/useCompanionController.test.ts src/tests/companion-shell.test.tsx --pool=forks --maxWorkers=1
npx vitest run src/tests/app-smoke.test.tsx --pool=forks --maxWorkers=1
```

Result: 13 files / 174 tests passed, then 1 file / 17 tests passed.

```sh
npm run test:keyboard
npm run check:behavior-contract
```

Result: 5 files / 195 tests passed; shared behavior contract 31/31 passed.
The contract covers grapheme-safe edits, protected Latin tokens,
secure/unknown-context purging, Romanized and Traditional candidates, explicit
commit, raw delimiter behavior, cancellation, and fail-open errors.

### Web build and finite safety checks

```sh
npm run build
npm run check:privacy
npm run check:offline
npm run check:user-data
npm run check:ipc-schema
```

Result: all passed outside the restricted command sandbox. The build produced
15 precached URLs and 10 hashed assets; privacy, user-data, and IPC checks
reported no violations. The first sandboxed attempt was not a product failure:
`tsx` was denied permission to create its local Unix IPC socket.

### Native macOS build and shared contract

The default `npm run build:macos` first failed because the selected Command Line
Tools compiler did not match the default macOS 26.2 SDK. The exact successful
retry was:

```sh
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
export CLANG_MODULE_CACHE_PATH=/private/tmp/lekh-a1-clang-module-cache
export SWIFT_MODULE_CACHE_PATH=/private/tmp/lekh-a1-swift-module-cache
swift build --disable-sandbox --package-path native/macos-imk/skeleton
```

It completed in 44.56 seconds. No trainer, model execution, or inference
benchmark ran.

The TypeScript and Swift behavior runners each passed 31/31 cases. `cmp` found
their JSONL output byte-identical, with SHA-256:
`2739abe6506fb7394df8128e25b4a6d5e5088dc1928c8108de3b697b52339916`.

```sh
./node_modules/.bin/vite-node scripts/run-keyboard-behavior-contract.ts contracts/keyboard-behavior/v1/lekh-keyboard-behavior.v1.jsonl > /private/tmp/lekh-a1-typescript-behavior.jsonl
native/macos-imk/skeleton/.build/debug/LekhBehaviorContractRunner contracts/keyboard-behavior/v1/lekh-keyboard-behavior.v1.jsonl > /private/tmp/lekh-a1-swift-behavior.jsonl
cmp /private/tmp/lekh-a1-typescript-behavior.jsonl /private/tmp/lekh-a1-swift-behavior.jsonl
shasum -a 256 /private/tmp/lekh-a1-typescript-behavior.jsonl /private/tmp/lekh-a1-swift-behavior.jsonl
```

The standalone native behavior probe was also run:

```sh
env -u LEKH_NEURAL_BENCH_BUNDLE -u LEKH_NEURAL_BENCH_REPORT -u LEKH_DUMP_NATIVE_CANDIDATES native/macos-imk/skeleton/.build/debug/LekhInputMethodBehaviorProbe
```

It failed at:

```text
FAIL: A companion reset epoch must immediately evict learned candidates from live IMK memory
```

Romanized preview/commit, Latin preservation, passive delimiters,
escape/backspace, and host pass-through assertions before that point passed.
Assertions after the failure did not run. The macOS CI job at this same revision
passed this probe, so the local reset-notification result remains environment-
sensitive rather than silently treated as a pass.

### Installed macOS bundle inspection

```sh
ls -ld "$HOME/Library/Input Methods/Lekh Keyboard.app"
plutil -p "$HOME/Library/Input Methods/Lekh Keyboard.app/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$HOME/Library/Input Methods/Lekh Keyboard.app"
file "$HOME/Library/Input Methods/Lekh Keyboard.app/Contents/MacOS/LekhInputMethodApp"
defaults read com.apple.HIToolbox AppleEnabledInputSources
defaults read com.apple.HIToolbox AppleSelectedInputSources
defaults read com.apple.HIToolbox AppleCurrentKeyboardLayoutInputSourceID
```

Result: build 176 exists and passes local ad-hoc signature verification; its
executable contains `arm64` and `x86_64`. No Lekh entry was returned from the
enabled or selected input-source preferences, and the current input source was
`com.apple.keylayout.ABC`.

### Windows proxy and installer source checks

```sh
npm run check:ipc-schema
npm run test:native-scaffold
npm run check:windows-installer-contract
```

Result on macOS: IPC generation reported version 2 / 18 message types. The
installer source contract passed with zero failures. The native scaffold ended
with 17 files passed, 1 failed and 201 tests passed, 1 failed; the failure was a
macOS companion Swift truth-table compile blocked by the restricted local Swift
cache/SDK environment, not a Windows runtime result. `build:windows` correctly
refuses to claim a Windows binary on macOS.

## GitHub Actions baseline

Latest `main` CI examined:
[run 29645227301](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29645227301),
revision `9668c6363fd7c342f1a13edc9f08aeee067f327f`.

| CI target/job | Baseline result |
|---|---|
| macOS `macos-15` | Passed |
| macOS `macos-15-intel` | Passed |
| Windows `windows-2022 / x64` | Failed before native build |
| Windows `windows-2025 / x64` | Failed before native build |
| Windows `windows-2025 / ARM64` | Failed before native build |

In Windows job
[88082249940](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29645227301/job/88082249940),
IPC schema checks passed, then the native scaffold reported 17 files passed,
1 failed; 199 tests passed, 2 skipped, 1 failed. The failure was:

```text
native/daemon/src/productionDaemon.test.ts > production daemon persistence >
survives a process crash, preloads learned memory, and never stores surrounding windows
Error: spawn D:\a\Lekh_Assistant\Lekh_Assistant\node_modules\.bin\vite-node ENOENT
```

The job therefore never reached the PowerShell TSF build, native unit tests, or
installer execution. This CI run is not evidence of a working Windows keyboard.
The last fully green historical `main` workflow was
[run 29595443145](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29595443145),
but it predates the baseline revision and is not used to claim current behavior.

## A3 four-architecture CI resolution

Current v1 CI passed at revision
`a6cc01290721e986693d6bcf3763f008c41efe7a` in
[run 29649454136](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29649454136).

| Architecture target | Result | Job evidence |
|---|---|---|
| macOS ARM64 | Passed | [job 88093159653](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29649454136/job/88093159653) |
| macOS Intel x64 | Passed | [job 88093159648](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29649454136/job/88093159648) |
| Windows x64 | Passed | [job 88093159640](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29649454136/job/88093159640) |
| Windows ARM64 | Passed on native `windows-11-arm` hardware | [job 88093159644](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29649454136/job/88093159644) |

Every target ran the scoped deterministic v1 suite (47 files / 451 tests), built
the application, and verified IPC schema version 2. Both Windows architectures
compiled the TSF service and broker and executed native CTest. Both macOS
architectures built the release `LekhInputMethodApp` product and produced
byte-identical TypeScript/Swift results for all 31 behavior-contract cases.
Neural training, promotion, provenance, model execution, and Core ML compute
probes are absent from v1 CI; the experimental-neural runtime flag is forced off.

## Baseline conclusion

At baseline, the deterministic engine and the macOS TypeScript/Swift behavior
contract agreed, while Windows still had no runtime integration receipt. The
subsequent B1 evidence below supersedes that Windows baseline for the final TSF
commit boundary. The installed macOS development build remains unexercised in a
fresh host session; Part C must close or document that gap.

## B1 Windows Devanagari commit evidence

Revision `5baf64de053ecac8690585178ad3e6566368da5a` added and passed a
native Text Services Framework integration test in
[CI run 29830177965](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29830177965).

| Windows architecture | Native build/test step | Job evidence |
|---|---|---|
| x64 | Passed `LekhTsfInjectionTests` | [job 88632824374](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29830177965/job/88632824374) |
| ARM64 | Passed `LekhTsfInjectionTests` in 0.04 seconds; all 5 native CTests passed | [job 88632824391](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29830177965/job/88632824391) |

The integration executable constructs a real COM `ITfThreadMgr`, focused
`ITfDocumentMgr`, `ITfContext`, TSF edit session, and in-memory
`ITextStoreACP`. It sends the precomposed deterministic result `नमस्ते` through
the production `applyEngineDecision` path and the range-returning
`ITfInsertAtSelection` API. The test asserts that the sink changes from
`Latin remains: ` to `Latin remains: नमस्ते`, that the insertion callback is
used, and that the selection lands after the committed text.

The corresponding native CI command was:

```powershell
powershell -ExecutionPolicy Bypass -File native/windows-tsf/skeleton/build.ps1 -Architecture $env:LEKH_WINDOWS_ARCH -Configuration Release
```

This is evidence for the final TSF mutation boundary, not a claim that CI
visually exercised Notepad, a browser, Word, or the incremental candidate UI.
Those exact hardware/application gaps are recorded in `KNOWN_LIMITATIONS.md`.

## B2 Windows candidate-window evidence

Revision `f753962be1b676e0546cd023ca712d94379d211e` passed the native
candidate tests in
[CI run 29831765740](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29831765740).

| Windows architecture | Native candidate result | Job evidence |
|---|---|---|
| x64 | All 6 native CTests passed, including protocol, candidate state, and candidate-to-TSF injection | [job 88638060869](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29831765740/job/88638060869) |
| ARM64 | Native build and all 6 CTests passed | [job 88638060944](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29831765740/job/88638060944) |

`LekhCandidateStateTests` exercises the complete headless interaction state
machine: initial selection, Up/Down movement and wrapping, digit selection,
Space commit, Enter commit, selection preservation across refreshed results,
missing shortcuts, hidden lists, and reset. `LekhTsfProtocolTests` verifies the
bounded eight-candidate response and explicit `session.commitCandidate`
request/response path. `LekhTsfInjectionTests` selects candidate 2 by digit and
asserts that its exact Devanagari text, `नमस्ते`, reaches the real TSF test sink
without changing the existing Latin prefix.

The shipping TSF DLL also compiles the concrete Win32 renderer. It creates a
topmost `WS_EX_NOACTIVATE` tool window, anchors it near the host caret, renders
the numbered Devanagari rows using `Nirmala UI`, visibly highlights the active
row, and bounds long content with an ellipsis. The service only consumes
Up/Down, digits 1–8, Space, and Enter while that window has a live candidate
state; selection uses the daemon's explicit candidate-commit message and every
focus, context, security, IPC, or edit failure hides and clears the window.

Local verification at the same revision also passed:

```text
npm run test:v1
Test Files  47 passed (47)
Tests       451 passed (451)
```

CI compiles the renderer and verifies its state and final text mutation, but it
does not perform a pixel-level visual inspection inside a physical Notepad,
browser, or Word session. That exact distinction is recorded in
`KNOWN_LIMITATIONS.md`.

## B3 Windows installer lifecycle evidence

Revision `416575f181d67291e11290daa688d08cdf93f944` passed the complete
silent installer lifecycle in
[CI run 29842059755](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29842059755).
All four architecture jobs in that run were green. The executable installer
lifecycle ran in the
[Windows x64 job 88673155934](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29842059755/job/88673155934);
the Windows ARM64 job built and tested the native service but intentionally
skipped the x64-only installer steps.

The job built the unsigned artifact
`Lekh-Keyboard-Companion-0.1.0-week1-Setup-x64.exe` directly from the tested
revision, then ran `scripts/test-windows-installer.ps1` in silent mode. The
receipt proves all of the following on a clean, isolated Windows runner target:

- installation produced the companion executable, native TSF DLL, native pipe
  broker, and deterministic daemon;
- machine-wide COM registration pointed at the installed TSF DLL and the TSF
  input profile existed;
- the current-user background startup entry contained the installed companion
  command;
- the installed broker stayed running and completed a real IPC v2 protocol
  negotiation with the deterministic daemon after two readiness attempts;
- silent uninstall removed installed files, installed processes, the startup
  entry, COM registration, and the TSF profile.

The exact lifecycle result was:

```text
INSTALL: running the unsigned NSIS artifact silently.
INSTALL: artifacts, COM, TSF, and startup entry verified.
SERVICE CHECK: daemon protocol negotiation passed ... after 2 attempt(s).
INSTALL: TSF registration and installed artifacts verified.
UNINSTALL: running the installed uninstaller silently.
CLEAN: files, processes, startup entry, COM registration, and TSF profile were removed.
```

## B4 Windows security-floor evidence

The existing Windows security floor passed without adding new hardening work in
[CI run 29842059755](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29842059755):

| Windows architecture | Existing security result | Job evidence |
|---|---|---|
| x64 | `LekhPipeSecurityTests` passed; all 6 native CTests passed | [job 88673155934](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29842059755/job/88673155934) |
| ARM64 | `LekhPipeSecurityTests` passed; all 6 native CTests passed | [job 88673155935](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29842059755/job/88673155935) |

The native test creates the production security descriptor and named pipe,
reads the resulting kernel-object DACL back through `GetSecurityInfo`, and
requires a protected, non-inherited allow-list containing only the current
logon/user SID and LocalSystem. It also requires remote-client rejection and
verifies that a second first-instance pipe cannot squat on the endpoint. The
broker refuses to run if either descriptor creation or post-creation DACL
validation fails.

The same x64 job passed the existing Windows packaging contract. That contract
requires `perMachine: true`; the normal installer therefore defaults to the
administrator-protected machine installation scope, and no installer rule
grants broad write access to its files. The lifecycle test separately confirmed
machine-wide COM and TSF registration. No additional v1 security policy or
hardening gate was introduced.
