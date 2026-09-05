# Keyboard Readiness Gate

Windows status refreshed: 2026-08-24. Older macOS and language-data rows retain their original evidence basis. See [`WINDOWS_RELEASE_BUILD.md`](./WINDOWS_RELEASE_BUILD.md) for the authoritative Windows release gate.

Status values: `complete`, `partial`, `blocked-external`, `blocked-human`, `blocked-native-environment`, `pending`.

## Engineering Foundation Gate

| Requirement | Status |
| --- | --- |
| KeyboardEngine API implemented | complete |
| session lifecycle works | complete |
| typing-session benchmark passes | complete |
| Keyboard Lab works | complete |
| no-DOM/no-network checks pass | complete |

## Intelligence Gate

| Requirement | Status |
| --- | --- |
| Romanized live typing works | complete |
| Romanized helper suggestions | complete |
| Traditional physical layout | blocked-human |
| Traditional Unicode suggestions | complete |
| proofread/dictionary/memory | complete |
| latency measured | complete |

## Native Feasibility Gate

| Requirement | Status |
| --- | --- |
| Windows TSF implementation/docs | complete-local |
| macOS IMK skeleton/docs | complete |
| IPC contract | complete |
| daemon lifecycle | complete |
| fallback behavior | complete |
| Windows native automated implementation tests | complete-local |
| Windows physical host matrix | pending |

## Release Gate

| Requirement | Status |
| --- | --- |
| real Windows/macOS physical host testing | pending |
| signing/notarization | blocked-external |
| Windows unsigned package/runtime smoke | complete-local |
| elevated clean install/upgrade/uninstall matrix | pending |
| pilot feedback collected | blocked-human |
| privacy review complete | pending |
| crash handling tested | pending |
| update/uninstall tested | pending |

## Final Status

The engineering foundation is substantially implemented. Native public release remains blocked by physical host testing, signing/notarization, authoritative Traditional layout data, and pilot feedback.

## Evidence Required Before Public Release

- final audited Traditional layout or explicit Romanized-first release scope;
- native TSF/IMK proof spikes passing on real host apps;
- daemon timeout/pass-through tests;
- signed Windows installer;
- notarized macOS package;
- privacy review;
- consented private pilot feedback;
- final scorecard with fresh full benchmark reports.
