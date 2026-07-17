# Lekh Windows TSF Vertical-Slice Contract

## Implemented boundary

The TSF DLL is deliberately thin. It:

- registers `ITfKeyEventSink` through `ITfKeystrokeMgr`;
- observes document and context focus through `ITfThreadMgrEventSink`;
- classifies the selected range through `GUID_PROP_INPUTSCOPE`;
- suppresses password, private, password/PIN, secure-mode, and unclassified contexts;
- begins a real daemon session with `session.begin` after a context is classified safe;
- sends bounded `session.processKeyStroke` requests over the per-user named pipe;
- requires the response ID, type, version, success flag, session ID, action, and action payload to match;
- applies compose, commit, and cancel decisions only inside a synchronous read/write `ITfEditSession`;
- ends the daemon session when TSF focus, document, context, or service activation changes.

No engine, transliteration, ranking, dictionary, or learning logic lives in the DLL.

## No-key-loss invariant

`OnKeyDown` starts with `eaten = FALSE`. It changes the result to `TRUE` only after the equivalent engine decision has successfully changed the host document:

- `compose`: insert or replace text in an owned TSF composition;
- `commit`: replace and end the owned composition, or insert committed text;
- `cancel`: delete and end an existing owned composition.

Malformed, mismatched, late, failed, or timed-out responses pass through. A rejected edit session passes through. If text was inserted but the host rejected composition ownership and rollback also failed, that key is consumed to avoid duplicating the already-inserted text, and the context is suppressed until focus changes.

Only Latin letter keys translated through the active Windows keyboard layout are admitted without an active composition. Translation uses the non-mutating `ToUnicodeEx` mode so probing a dead key cannot alter host keyboard state. Space, Backspace, Enter, and Escape are admitted only while the DLL owns a composition. Tab, Delete, digits, navigation, system shortcuts, Ctrl/Alt/Windows shortcuts, and candidate shortcuts remain pass-through until their native behavior is implemented.

The vertical slice remains behind `LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING=1` until the Windows host matrix passes.

## Privacy invariant

No surrounding text is sent by this slice. A session begins with empty left/right context. If TSF secure mode is active, input scope is sensitive, or input scope cannot be classified, the DLL does not contact the daemon and does not consume the key.

## Transport bounds

- Pipe: per-user `\\.\pipe\LekhKeyboard-${USER-SID}`.
- Authorization: the native broker applies and verifies a protected DACL for the current logon SID plus LocalSystem and rejects remote clients. A non-interactive token without a logon SID falls back to its current user SID.
- Server identity: TSF accepts only the current-user process whose executable is the exact `LekhPipeBroker.exe` installed beside the DLL.
- Daemon isolation: the broker relays through private inherited handles; the Node daemon never owns the public endpoint.
- Whole hot-path request deadline (wait, write, and complete response frame): 50 ms.
- Request and response ceiling: 64 KiB.
- Newline-framed byte-stream reads and writes use cancellable overlapped I/O.
- The DLL never launches or reconnects the daemon on the host key path.

## Still required before production

- native candidate UI and candidate selection;
- TSF display attributes;
- surrounding-context extraction with explicit privacy minimization;
- composition ownership/focus testing in every target host;
- Windows x64 and ARM64 CI artifacts;
- signed binaries and a validated installer;
- accessibility, high-DPI, multi-monitor, sleep/resume, crash-recovery, and upgrade testing.
