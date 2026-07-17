# Keyboard Memory

Updated: 2026-07-17

Keyboard memory personalizes candidate ranking locally after a user commits a candidate.

## Current Implementation

- `commitCandidate` records the accepted candidate only when the host explicitly classifies the field as `normal` or `search`; missing, secure, password, code, and unknown classifications fail closed.
- The memory entry stores input, chosen output, mode, and surrounding context.
- Future updates can boost the accepted candidate to the top.
- `learnCorrection(entry)` remains a trusted in-process import boundary for compatible local entries; it is not exposed to an untrusted daemon client.
- Daemon `memory.learn` carries only a live session id plus a one-time server-issued commit epoch. It confirms an already server-derived non-secure learning event and cannot submit text, context, timestamps, or ranking fields.

## Covered Behavior

- selecting `प्रबिनको` for `prabin` can make `प्रबिनको` the top future candidate;
- secure/password/code/unknown/unclassified contexts do not record memory;
- memory candidates do not override protected structured tokens.

## Storage Status

Prompt 2 uses the current local in-engine memory path. Native persistent storage adapters belong to Prompt 3.

## Safety

Memory is a ranking signal, not a license to silently mutate protected spans or low-confidence text.
## Prompt 2 Production Update

Local memory can boost selected candidates, honor pinned personal entries, and block never-suggest entries. Secure input disables suggestions and memory writes.

Prompt 2 still uses local in-process/web-lab memory behavior. Native SQLite or OS-backed storage adapters remain Prompt 3 work.
