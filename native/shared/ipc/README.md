# Native IPC Contract

Windows native services may communicate with the Lekh daemon over local-only IPC using the message envelope in `messages.ts` and the JSON schema in `lekh-keyboard-ipc.schema.json`. The macOS IMK does not use this protocol on its typing path; its deterministic engine is in-process.

Production encoding preference is length-prefixed CBOR or MessagePack. JSON is allowed for debug builds and schema validation. The contract is versioned as `version: 1`.

Hot-path keystroke calls target under 10 ms common case and must time out at 50 ms. Timeout behavior is fail-open: the native shell passes through or preserves composition and reports a diagnostic outside the hot path.

Security requirements:

- Windows uses a per-user named pipe.
- macOS may use app-group-scoped XPC only for administrative work outside the typing path; it is not a keystroke dependency.
- Cross-user connections are rejected.
- No remote TCP listener or local-network API is allowed.
