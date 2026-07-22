# Lekh Assistant v1.0 — Final Adversarial Review

Date: 2026-07-22  
Review pass: 2 of exactly 2 permitted v1 adversarial passes  
Review boundary: immediately before the v1.0.0 release candidate  
Reviewed implementation revision: `48e234708782a1ab05d7d86115d5e63cae49dd9c`

## Scope

This pass considered only the P0 classes authorized by R3: data corruption,
text committed to the wrong application or context, host or service crashes, a
security hole exploitable by a co-located unprivileged user, and installer
bricking. Three parallel specialist lanes covered macOS input integrity,
Windows TSF/IPC integrity, and cross-platform installer/artifact integrity as
one coordinated final pass. No lane spawned another review, and no finding
below P0 was fixed.

## P0 result

| Specialist lane | Result | Principal evidence |
|---|---|---|
| macOS text integrity and crash boundary | Zero open P0s | Secure and unknown contexts purge composition/UI state; commit requires the owning client and current session/surface generation; multi-grapheme callbacks preflight atomically; the Swift unit probe and all 31 shared behavior cases passed |
| Windows TSF and IPC boundary | Zero open P0s | Focus/context changes abandon state; commit requires the retained `ITfContext`; responses bind sequence/server/session/epoch before mutation; named pipes revalidate protected user/System ACLs and broker identity; native Windows tests passed on x64 and ARM64 |
| Installer, uninstall, and artifact boundary | Zero open P0s | macOS verifies, atomically swaps, and can roll back its fixed per-user payload; Windows x64 CI verifies exact COM/TSF/startup/service state and complete uninstall cleanup; both published artifacts independently matched their same-run SHA-256 values |

**Open P0 list: empty.**

No P0 fix was required in this pass.

## File-level review evidence

### macOS

- `LekhInputController.swift:487-555`, `665-680`, `1845-1864`, and
  `2008-2020` fail closed and purge state for secure input across event,
  command, and delayed-surface paths.
- `LekhInputController.swift:2462-2506`, `1241-1255`, and `2606-2625` bind
  session ownership and insertion to the current client.
- `LekhInputController.swift:2361-2459` binds candidate authority to the
  visible surface generation, session, raw buffer, and exact client.
- `LekhInputController.swift:495-528` preflights multi-grapheme callbacks
  before consuming input; `1338-1346` limits unmarked replacement to the
  zero-length caret immediately after the known raw token.
- The installer verifies the staged bundle, swaps only the fixed Lekh path,
  and retains rollback state until registration succeeds in
  `package-macos-imk-test-installer.mjs:539-577` and `626-678`.

### Windows

- `LekhTextService.cpp:246-295` closes state on focus/context changes and
  rejects secure or unknown privacy states; `334-410` requires the incoming
  context to match `activeContext_` before either key or candidate commit.
- `TsfEditSession.cpp:12-23`, `69-120`, and `381-395` classify sensitive
  scopes and treat failed inspection as unknown. Its mutation path at
  `203-325` and `398-424` is confined to the supplied TSF edit session.
- `TsfProtocol.cpp:288-336` and `459-591` validate sequence, server instance,
  session, epoch, schema, and action fields before accepting a response.
- `LekhPipeSecurity.cpp:82-146`, `LekhPipeBroker.cpp:224-242`,
  `IpcClient.cpp:183-201`, and `LekhPipeServerIdentity.cpp:61-101` restrict the
  endpoint to the current user/System, reject remote or second-instance pipe
  clients, and bind the live server to the installed broker executable.
- The earlier COM-unload P0 remains covered by `ClassFactory.cpp:11-15` and
  `57-60` plus `LekhComServerLifetimeTests.cpp:23-55`.

### Installers and artifacts

- `scripts/test-windows-installer.ps1:170-223` verifies installed artifacts,
  exact COM path, TSF profile, startup command, live broker negotiation, silent
  uninstall, and removal of files, processes, startup, COM, and TSF state.
- The macOS release manifest rejects traversal, symlinks and non-regular
  entries, missing or unlisted files, byte/hash mismatches, and verifier/key
  mismatches before installation.
- The independently downloaded E2 bundle passed `shasum -a 256 -c` for the
  universal macOS ZIP and Windows x64 EXE. The unverified Windows ARM64
  installer remains unpublished and is not represented as shippable.

## Executed evidence

Local checks at the reviewed revision:

```text
LEKH_EXPERIMENTAL_NEURAL_TYPING=0 npm run v1:check
Format check passed.
Typecheck passed.
Test Files  47 passed (47)
Tests       452 passed (452)
Production build passed; service worker wrote 15 precached URLs.
IPC schema passed: version 2, 18 message types.
Experimental passive-commit policy passed; production bundles exclude it.

npm run check:behavior-contract
keyboard-behavior-contract: 31/31 passed

npm run check:native-imk-privacy-security
status: passed; violations: []

npm run check:windows-installer-contract
status: passed; failures: []; packageFailsClosed: true

node scripts/check-macos-unsigned-install-ux.mjs
RESULT — C2 unsigned first-run walkthrough passed.
```

At the exact reviewed revision,
[CI run 29880779970](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970)
passed all four architecture jobs and the combined release-bundle job:

- [macOS Apple Silicon job 88800965537](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/job/88800965537)
- [macOS Intel x64 job 88800965541](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/job/88800965541)
- [Windows x64 job 88800965564](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/job/88800965564), including installer lifecycle
- [Windows ARM64 job 88800965526](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/job/88800965526), native build/tests only
- [release-bundle job 88801735491](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29880779970/job/88801735491)

## Non-P0 disposition

No new below-P0 issue was found, so `BACKLOG_V2.md` is unchanged by this pass.
Previously recorded lower-severity installer and lifecycle limitations remain
there and were not re-opened.

## Pass accounting

Final adversarial pass 2 is consumed and complete. Both permitted v1 review
passes are now exhausted. No additional adversarial review is permitted for
this mission.
