# Daemon Source

This directory contains the executable local TypeScript daemon used by the Windows TSF development slice. It owns the engine, protocol negotiation, epoch-scoped sessions, request ordering, deadlines, diagnostics, and the JSONL/named-pipe transports.

The Windows transport currently enforces:

- a SID-derived pipe name with no shared fallback or environment-selected endpoint;
- strict UTF-8 newline framing with a 64 KiB frame ceiling;
- at most 16 active connections and 32 queued requests per connection;
- ordered writes with cancellation of work that has not started after disconnect;
- bounded idle time and sanitized transport failures.

An explicit user-only Windows security descriptor still requires the planned native pipe owner. Until that owner creates the pipe and the client verifies its installed binary identity, this transport remains a development boundary rather than production authorization evidence.

Do not move language-engine logic into the TSF DLL or IMK adapter. Native adapters marshal typed protocol messages, mutate host text only through the host API, and fail open.
