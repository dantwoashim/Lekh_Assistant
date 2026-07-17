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

interface IpcResponse<T = unknown> {
  id: string;
  type: string;
  version: 2;
  ok: boolean;
  serverInstanceId: string;
  requestSequence: number;
  sessionEpoch?: number;
  payload?: T;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
    action: "none" | "retry" | "passThrough" | "restartSession" | "restartDaemon";
  };
  latencyMs?: number;
}
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
- Identifiers are bounded to 256 UTF-16 code units. Request sequences, timestamps, deadlines, session epochs, and commit epochs must be non-negative or positive JSON-safe integers as their field contracts require; oversized or fractional metadata is rejected before dispatch.
- `memory.learn` payload is exactly `{sessionId, sessionEpoch, commitEpoch}`. It cannot transport a correction entry or surrounding text, and returns `learned: false` for missing, stale, replayed, ended, secure, uncertain, or unclassified sessions.

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
