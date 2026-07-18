# Lekh Windows TSF Vertical-Slice Contract

## Implemented boundary

The TSF DLL is deliberately thin. It:

- registers `ITfKeyEventSink` through `ITfKeystrokeMgr`;
- observes document and context focus through `ITfThreadMgrEventSink`;
- classifies the selected range through `GUID_PROP_INPUTSCOPE`;
- suppresses password, private, password/PIN, secure-mode, and unclassified contexts;
- begins a real daemon session with `session.begin` after a context is classified safe;
- prepares negotiation, a bounded engine warm-up, and session state only on focus/context events or a retirement-completion message; key callbacks never start or reconnect the daemon;
- sends bounded `session.processKeyStroke` requests over the per-user named pipe;
- requires an exact closed-world response envelope with matching request ID, type, version, server identity, request sequence, and session epoch;
- validates the complete candidate-update payload, including required mode/surface/action fields, bounded text and lists, ordered UTF-16 ranges, nested candidates, inline completions, proof hints, warnings, confidence, caret, and schema version before deriving an edit decision;
- applies compose, commit, and cancel decisions only inside a synchronous read/write `ITfEditSession`;
- supplies an `ITfCompositionSink` to every owned composition so host-initiated termination cannot leave a stale range handle;
- materializes canonical Romanized text—not Unicode preview text—in every live TSF composition range and replaces it with Unicode only in a confirmed commit edit;
- detaches every local session with terminal `session.end` on an off-key-path worker containing only opaque identifiers.

No engine, transliteration, ranking, dictionary, or learning logic lives in the DLL.

## No-key-loss invariant

`OnKeyDown` starts with `eaten = FALSE`. It changes the result to `TRUE` only after the key is materialized exactly once:

- `compose`: insert or replace text in an owned TSF composition;
- `commit`: replace and end the owned composition, or insert committed text;
- `cancel`: end ownership while preserving the existing canonical-raw range exactly;
- applied-with-cleanup-failure: the host mutation already contains canonical raw or final committed text, so denied caret/composition cleanup relinquishes ownership without replaying the key. A denied Escape `EndComposition` is not treated as applied; local ownership is relinquished and the physical Escape returns to the host.

Malformed, mismatched, late, failed, timed-out, pass-through, unsupported, and shortcut keys remain host-owned. If a raw composition already exists, the DLL ends it without changing its text; if the host denies `EndComposition`, Lekh releases its COM reference and still passes the current key. No recovery queue survives that boundary, no later operation can move the caret or overwrite the host key, and no warning beep substitutes for delivery.

If `InsertTextAtSelection` succeeds but the host rejects `StartComposition`, that inserted canonical raw is already the one representation of the physical key. The DLL leaves it untouched, eats the key, clears its daemon binding, and never deletes/replays it through a fallback path.

Each normal engine `OnKeyDown` performs at most one 50 ms engine round trip. Retirement never blocks a TSF callback: a serialized worker retries one immutable control-class `session.end` request up to three times with 100 ms transport attempts. Only an exact response-envelope acknowledgement completes it. Exhaustion triggers one higher-sequence, same-client `protocol.negotiate`; the daemon atomically ends all sessions owned by that client before acknowledging negotiation. Queue, transport, parse, or purge failure leaves a durable quarantine barrier that forbids a new Lekh session. A later lifecycle event schedules reconciliation, and a generation-checked message-only completion target follows reactivation so a successful worker can resume only the current safe focus. Worker count participates in `DllCanUnloadNow`.

Only Latin letter keys translated through the active Windows keyboard layout are admitted without an active composition. Translation uses the non-mutating `ToUnicodeEx` mode so probing a dead key cannot alter host keyboard state. Space, Backspace, Enter, and Escape are admitted only while the DLL owns a composition. Tab, Delete, digits, navigation, system shortcuts, Ctrl/Alt/Windows shortcuts, and candidate shortcuts remain host-owned; a live canonical-raw range is ended or relinquished before they pass.

If the host terminates a composition because of a caret move, mouse edit, app edit, or teardown, `OnCompositionTerminated` verifies COM identity, releases ownership, and quarantines local state. The range is already canonical raw, so the callback performs no text replacement, selection movement, retry, or beep. Service-requested terminal edits set an explicit `PreserveAppliedText` disposition before `EndComposition`, including synchronous reentrant callbacks, so accepted commit/cancel text is never reverted.

Registration and removal are per-user, path-owned, and retry-safe. Unregistration first proves that the COM registration is either absent or still points to the installed DLL. It enumerates TSF input processors so an already-removed service is a successful no-op; when TSF cleanup fails, the COM key and installed DLL remain available for a later retry. A successful TSF `Unregister` is authoritative because Windows removes the service's remaining language profiles and categories with it. Installation repair never tears down a pre-existing Lekh TSF registration merely because a later profile or category step fails.

The vertical slice remains behind `LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING=1` until the Windows host matrix passes.

## Privacy invariant

No surrounding text is sent by this slice. A session begins with empty left/right context. Every key in a bound session reclassifies the context before normal key filtering, which covers browser hosts that reuse one TSF context across normal and password fields. If secure mode is active, input scope is sensitive, or input scope cannot be classified, the DLL clears local raw state before scheduling terminal `session.end`, ends the marked range without changing host text, and passes the current secure-field key. If the host denies `EndComposition`, Lekh releases its composition reference immediately. It never erases already represented host characters, moves the caret, retains raw text, or queues a future overwrite. Retirement workers contain only client/server/session IDs, epoch, command, and request metadata.

## Transport bounds

- Pipe: per-user `\\.\pipe\LekhKeyboard-${USER-SID}`.
- Authorization: the native broker applies and verifies a protected DACL for the current logon SID plus LocalSystem and rejects remote clients. A non-interactive token without a logon SID falls back to its current user SID.
- Server identity: TSF accepts only the current-user process whose executable is the exact `LekhPipeBroker.exe` installed beside the DLL.
- Daemon isolation: the broker relays through private inherited handles; the Node daemon never owns the public endpoint.
- Whole engine hot-path request deadline (wait, write, and complete response frame): 50 ms. Terminal retirement and reconciliation are control-class messages dispatched outside key callbacks.
- Candidate and caret offsets are checked against the returned Romanized composition's UTF-16 coordinate space and cannot split a surrogate pair. The current vertical slice admits only Latin composition input; canonical TypeScript validation additionally enforces grapheme boundaries for general text.
- Active composition is limited to the generated 128 UTF-16-unit work bound, independently of the larger general text/output limit. A response over that bound, or a negotiation that reports any other bound, is rejected before TSF derives or applies an edit decision.
- Compose responses must be the exact append/backspace transition from the last host-applied Romanized composition; that canonical raw transition is what TSF stores in the live range. Terminal responses must clear composition and candidate state. Space must commit exactly the expected raw composition plus one space, Enter exactly the expected raw composition plus one newline, and the first Escape may only end an active composition while preserving that exact raw range. With no owned composition, a later Escape remains host-owned and passes through.
- Request and response ceiling: 64 KiB.
- Newline-framed byte-stream reads and writes use cancellable overlapped I/O.
- The DLL never launches or reconnects the daemon on the host key path.

## Still required before production

- native candidate UI and candidate selection;
- candidate/auxiliary Unicode preview UI and TSF display attributes for the canonical-raw range;
- surrounding-context extraction with explicit privacy minimization;
- composition ownership/focus testing in every target host;
- Windows x64 and ARM64 CI artifacts;
- signed binaries and a validated installer;
- accessibility, high-DPI, multi-monitor, sleep/resume, crash-recovery, and upgrade testing.
