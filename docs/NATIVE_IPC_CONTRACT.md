# Native IPC Contract

The Lekh native IPC contract maps directly to `KeyboardEngine`. It is local-only, versioned, and designed for fail-open keyboard behavior.

Schema and TypeScript definitions:

- `native/shared/ipc/lekh-keyboard-ipc.schema.json`
- `native/shared/ipc/messages.ts`

## Envelope

```ts
interface IpcRequest<T = unknown> {
  id: string;
  type: string;
  version: 2;
  sentAt: number;
  deadlineAt: number;
  clientInstanceId: string;
  requestSequence: number;
  payload: T;
}

interface IpcSuccessResponse<T = unknown> {
  id: string;
  type: string;
  version: 2;
  ok: true;
  serverInstanceId: string;
  requestSequence: number;
  sessionEpoch?: number;
  payload: T;
  error?: never;
  latencyMs?: number;
}

interface IpcErrorResponse {
  id: string;
  type: string;
  version: 2;
  ok: false;
  serverInstanceId: string;
  requestSequence: number;
  sessionEpoch?: number;
  payload?: never;
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    action: "none" | "retry" | "passThrough" | "restartSession" | "restartDaemon";
  };
  latencyMs?: number;
}

type IpcResponse<T = unknown> = IpcSuccessResponse<T> | IpcErrorResponse;
```

## Message Types

| IPC type | KeyboardEngine method |
| --- | --- |
| `protocol.negotiate` | bind protocol and daemon instance |
| `health.check` | daemon health wrapper |
| `engine.warm` | `warm` |
| `session.begin` | `beginSession` |
| `session.processKeyStroke` | `processKeyStroke` |
| `session.updateComposition` | `updateComposition` |
| `session.commitCandidate` | `commitCandidate` |
| `session.commitRaw` | `commitRaw` |
| `session.cancel` | `cancelComposition` |
| `session.end` | `endSession` |
| `session.setMode` | `setMode` |
| `session.setLayout` | `setLayout` |
| `suggestions.get` | `getSuggestions` |
| `proofHints.get` | `getProofHints` |
| `dictionary.lookup` | `lookupDictionary` |
| `memory.learn` | `learnCommittedCorrection` using a one-time server-issued commit receipt |
| `diagnostics.getMetrics` | daemon diagnostics wrapper |
| `engine.shutdown` | `shutdown` |

`session.cancel` and `session.end` are control-class lifecycle messages, not key-path work. A native host that drops a session handle must obtain an exact terminal `session.end` acknowledgement or an acknowledged same-client renegotiation that atomically retires all of that client's sessions before opening another session.

## Timeout Policy

- Common keystroke target: under 10 ms.
- Hard keystroke IPC timeout: 50 ms.
- On timeout, native shell passes through or preserves composition safely.
- Host apps must never freeze while waiting for the daemon.

## Encoding

- The current local transport is strict UTF-8 JSON with newline framing.
- The complete frame, including its newline delimiter, is limited to 65,536 bytes.
- At most 16 named-pipe connections and 32 queued requests per connection are admitted.
- At most 64 negotiated client identities are retained. An identity idle for 30 minutes is evicted before admission checks, and every protocol/engine session it owned is retired in the same serial dispatch boundary.
- The schema is versioned as `version: 2`; negotiation, request sequence, deadline, client instance, server instance, and session epoch are mandatory where applicable.
- All 18 request payloads and all 18 success-response payloads derive closed-world schemas from the canonical protocol specification. The TypeScript response validator recursively enforces generated definitions, nested object keys, tuple lengths, list limits, enum values, finite numbers, and JSON-safe integers.
- Active composition is capped at 128 UTF-16 code units by the neutral engine contract. This work bound is deliberately separate from the 16,384-unit general text/output bound: an exact-bound composition is valid, while a `+1` update is rejected before candidate, model, proofread, cache-key, or identifier work. Carets must also fall on an extended-grapheme boundary.
- Direct engine callers receive the same fail-open behavior if they bypass IPC validation. A rejected growth preserves the last bounded composition without candidates or proof hints; delimiters may still commit an exact-bound composition because committed output uses the separate general text bound.
- Candidate selection IDs are deterministic 128-bit SHA-256 prefixes over the canonical commit semantics (contract version, candidate type, NFC output text, and replacement range). This final formula intentionally supersedes the earlier plan formula that included pack, mode, and source-ranking metadata: two candidates that perform the same commit remain the same semantic choice even when their source or rank changes. Rank and keyboard shortcut are presentation-only and never enter the identity.
- A candidate ID is not a freshness capability. The engine accepts it only while it remains in the current session candidate set; refresh replaces that set, and stale/non-current IDs fail open without committing. Native selection must additionally carry the originating client/session epoch and be discarded when its focus or candidate generation changes.
- Successful response envelopes form a discriminated success/error union. Success constructors require the original positive request sequence and an explicit server identity; session-bearing success types require a positive epoch, while non-session success types forbid one.
- A new request never starts after its deadline. An exact retry of a request already present in the bounded replay cache returns the frozen completed response even after that deadline, so acknowledgement loss cannot duplicate a state mutation. Changed content at the same sequence remains a replay violation.
- Response consumers with an originating request additionally bind response ID/type/sequence, negotiated server identity, session epoch and session ID. `proofHints.get` ranges and `original` text are validated against that request's exact text window, not merely checked as free-standing ordered tuples.
- IPC `TypingContext` has no passive-commit authority. Space and Enter remain exact raw commits for IPC clients. A production-ineligible exact-Space experiment is reachable only through the TypeScript policy test build, validates its closed source-bound policy before activation, never mints learning receipts, and is absent from native packaging consumers.
- The Windows TSF consumer independently rejects unknown response-envelope fields, mismatched request/server/session identities, split session epochs, unknown payload fields, invalid nested candidates or proof hints, unordered UTF-16 ranges, and carets outside the active composition. A rejected response produces no host edit decision, so the original key remains on the host's fail-open path.
- Identifiers are bounded to 256 UTF-16 code units. Request sequences, deadlines, native numeric codes, session epochs, and commit epochs use non-negative or positive JSON-safe integers as their field contracts require. Key timestamps may be fractional but must remain finite, non-negative, and within the JSON-safe range; oversized metadata is rejected before dispatch.
- Commit epoch `0` is mandatory for every non-commit result, including helper refinements and fail-open/no-op results. `memory.learn` continues to require a positive, one-time, server-issued epoch and therefore cannot turn a refinement or timeout fallback into a learning grant.
- `memory.learn` payload is exactly `{sessionId, sessionEpoch, commitEpoch}`. It cannot transport a correction entry or surrounding text, and returns `learned: false` for missing, stale, newly reissued-after-consumption, ended, secure, uncertain, or unclassified sessions. An exact transport retry instead receives the cached original result.
- After `memory.learn` crosses the irreversible durable-commit point, its exact success remains publishable and replayable even if `FULL` SQLite durability crossed the control deadline; reporting a fresh deadline failure at that point would misrepresent committed state.

## Security

- IPC is local-only.
- Windows derives a per-user named-pipe name from the current token SID and has no shared or environment-selected fallback.
- `LekhPipeBroker.exe` owns every installed Windows pipe instance with a protected DACL containing only the current logon SID and LocalSystem, `PIPE_REJECT_REMOTE_CLIENTS`, and a first-instance anti-squatting guard. Non-interactive tokens without a logon SID fall back to the current user SID. The broker re-reads and validates the live DACL before accepting clients.
- The TSF client rejects a server unless it runs under the current user token and its process image is the exact broker binary installed beside `LekhTextService.dll`; path aliases are compared by volume and file identity.
- The Node named-pipe listener is a development diagnostic only. The installed daemon is reachable solely through private inherited handles owned by the broker.
- The current macOS IMK hot path uses its in-process native engine and does not expose this named-pipe transport.
- No remote TCP listener is allowed.
- No typed text telemetry is sent to network services.
- JSON parser, schema-validation, and daemon-dispatch failures return stable public messages; raw parser exceptions, validation keys, engine exceptions, typed fragments, and local paths are not reflected through IPC diagnostics.

## Diagnostics

`diagnostics.getMetrics` returns daemon health counters only:

- uptime in milliseconds;
- active session count;
- warm-state readiness;
- last recoverable daemon error, if any;
- counts for processed keystrokes, IPC timeouts, pass-through fallbacks, and committed candidates.

It must not return typed text, raw composition buffers, dictionary queries, or user documents. Diagnostic export in the companion app must remain redacted by default.
