# Native Daemon Lifecycle

On Windows, the daemon hosts the shared keyboard engine outside the native TSF shell. Native shells stay thin and fail open. The current macOS IMK uses its in-process Swift engine and does not depend on this daemon.

## Role

- Host `KeyboardEngine`.
- Maintain warm state.
- Own local memory, dictionary, and settings storage adapters.
- Serve Windows TSF over local IPC.
- Serve companion app settings and diagnostics.
- Never send typed text to the network.
- Expose redacted `diagnostics.getMetrics` counters without typed text.

## Windows

- The per-user companion starts hidden at login, owns `LekhPipeBroker.exe`, and self-heals broker crashes with capped exponential backoff outside the key path. Closing the settings window leaves this single background instance and the keyboard broker running; relaunching the shortcut reopens settings in that instance.
- The broker launches the daemon through private inherited standard-I/O handles, passes only an explicit runtime/locale/profile-directory environment allowlist, and assigns it to a kill-on-close job.
- TSF DLL reconnects non-blockingly on activation.
- The TSF DLL never launches either process on the hot path.
- The broker owns a per-user-named, current-logon-authorized pipe and verifies daemon protocol readiness before opening it.
- If daemon is unavailable, TSF passes through raw keystrokes and records a local diagnostic.
- If daemon crashes mid-session, TSF times out, invalidates sessions, passes through, and requests restart outside the hot path.
- Every TSF detach uses terminal `session.end`. A serialized worker retries an immutable request and requires an exact acknowledgement; failure triggers an acknowledged same-client negotiation that atomically purges all of that client's sessions.
- Until End or client-purge acknowledgement succeeds, a durable barrier prevents a new TSF daemon session. Reconciliation is asynchronous, carries no typed text or COM pointers, and resumes focus through a generation-checked TSF-thread completion window.
- Exact completed IPC retries remain replayable after the original deadline while their bounded client cache is live; an expired request that never ran still fails before dispatch.

## macOS

- The current IMK hot path uses `LekhEngineCore` in process.
- It performs no per-keystroke XPC, daemon launch, network request, or synchronous file decoding.
- Signing, notarization, and the host-application validation matrix remain release gates; they do not change this hot-path architecture.

## Daemon API

The daemon implements the IPC messages in `native/shared/ipc`.

Runtime responsibilities:

- session TTL cleanup
- crash-safe memory flush
- warm partial state
- diagnostic status and redacted counters
- no remote network listener
- strict hot-path IPC timeouts

## Current Status

Prompt 3 adds a repo-executable TypeScript development daemon dispatcher:

- handles `health.check`, `engine.warm`, session lifecycle, keystroke processing, suggestions, proof hints, dictionary lookup, memory learning, diagnostics, and shutdown;
- validates IPC envelopes before dispatch;
- records redacted counters for processed keystrokes, timeouts, pass-through fallbacks, and committed candidates;
- exposes `withHotPathTimeout` so native shells have a tested pass-through fallback model.
- treats an accepted `engine.shutdown` request as a terminal queue barrier, then clears engine/protocol state and closes storage exactly once even if finalization fails.

Windows now has a source-complete native broker, explicit pipe authorization, exact server-image verification, companion launch wiring, package fail-closed checks, and Windows-native security/backend tests. Release still requires the host-application matrix, latency evidence, recovery testing, and Authenticode for a public production installer. macOS still requires host validation plus signing/notarization for a public release.
