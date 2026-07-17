# Keyboard Privacy And Security Model

Generated: 2026-05-27

Lekh Keyboard must be local-first. Typed text must not leave the user's machine during normal typing.

## Typing Data Rules

- No network request is allowed in the hot typing path.
- No hidden telemetry is allowed.
- No typed-text collection by default.
- Diagnostic export must be redacted by default.
- Pilot examples require explicit consent and redaction.
- Dictionary meanings must not be scraped or added from unsafe sources.

## Secure Input

For password, secure, code, or sensitive fields:

- memory recording is disabled;
- proofread hints are disabled or reduced;
- suggestions are disabled or reduced;
- raw input must pass through safely;
- no text context is retained beyond the active event handling requirement.

## Local Memory

Personal correction memory is local-only.

Required controls:

- reset;
- export;
- import;
- explain what is stored;
- disable in secure fields;
- never override protected spans or force unsafe candidates.

## Personal Dictionary

The personal dictionary is local-only.

Required controls:

- add/remove word;
- export/import;
- reset;
- source/provenance fields for imported lists;
- no unsafe meaning data unless licensed and reviewed.

## Native IPC Security

Windows:

- per-user-named pipe owned only by the native broker;
- protected DACL restricted to the current logon SID plus LocalSystem (or the current user SID for a non-interactive token without a logon SID), with remote clients rejected;
- TSF verification of the server user token and exact installed broker file identity;
- private inherited-handle transport between the broker and daemon;
- no remote TCP listener;
- no arbitrary command execution through IPC;
- fail-open pass-through on timeout or daemon failure.

macOS:

- app-scoped XPC service;
- app group/shared container only where required;
- reject unexpected clients;
- fail-open pass-through on XPC failure.

## Storage Paths

Planned native storage paths:

- Windows: `%APPDATA%/Lekh Keyboard/`
- macOS: `~/Library/Application Support/Lekh Keyboard/`

Future encryption strategy:

- Windows DPAPI for sensitive local settings or secrets.
- macOS Keychain for sensitive local settings or secrets.
- SQLite for local memory/dictionary storage after native scaffold work.

## Companion Privacy Page Requirements

The companion app must expose:

- memory status and controls;
- personal dictionary controls;
- telemetry status, which defaults to none/off;
- diagnostic export controls with redaction notice;
- secure-input behavior explanation;
- pilot data consent form, if pilot reporting is added.

## Audit Status

Current checks:

- `npm run check:privacy`
- `npm run check:engine-local`
- `npm run check:engine-no-dom`
- `npm run check:user-data`

Prompt 1 status: local-first checks pass in baseline and will remain in default verification.
