# Native IPC Contract

`lekh-keyboard-protocol.json` is the canonical protocol source. Generation produces the JSON Schema, TypeScript descriptors and response schemas, Swift constants, and C++ constants. Every one of the 18 request and success-response payloads has a closed-world generated schema. `requestValidation.ts` validates daemon requests, while `responseValidation.ts` resolves the generated definitions and rejects missing, extra, type-confused, unbounded, or unsafe nested response data. Consumers use `validateIpcResponseForRequest` when they have the originating request so request identity, sequence, negotiated server, session epoch/session ID, and proof-hint coordinates are bound rather than validated in isolation.

The current Windows transport is protocol version 2, strict UTF-8 newline-delimited JSON, bounded to 65,536 bytes including the newline. The public named pipe terminates in the native broker; the daemon is a contained child behind inherited private handles. The macOS IMK does not use this protocol on its typing path because its deterministic engine is in-process.

Hot-path calls have a 50 ms whole-request deadline. Timeout, malformed metadata, unknown response fields, stale epochs, and unavailable IPC fail open: the native shell preserves the host input path and reports only bounded, non-sensitive diagnostics outside the hot path.

The canonical active-composition work bound is 128 UTF-16 code units, sourced from `data/engine/lekh-engine-contract.v1.json` and checked during protocol generation. It is not the 16,384-unit general text/output limit. Exact-bound requests remain valid; `+1` composition requests and responses are rejected, and TypeScript request validation additionally requires the cursor to be on an extended-grapheme boundary.

IPC clients cannot activate passive candidate commits. Space and Enter decisions are raw and must preserve exactly one matching delimiter. A production-ineligible exact-Space experiment exists only in the TypeScript policy test build behind an opaque module-private capability; it cannot be selected through `TypingContext`, IPC, or a production engine factory.

Security requirements:

- Windows uses a per-logon/user protected named pipe and verifies the broker process identity.
- macOS may use app-group-scoped XPC only for administrative work outside the typing path; it is not a keystroke dependency.
- Cross-user connections are rejected.
- No remote TCP listener or local-network API is allowed.
