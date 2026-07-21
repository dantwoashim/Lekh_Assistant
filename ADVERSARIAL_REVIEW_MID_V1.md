# Lekh Assistant v1.0 — Mid-Mission Adversarial Review

Date: 2026-07-21  
Review pass: 1 of exactly 2 permitted v1 adversarial passes  
Review boundary: immediately after Part B  
Reviewed implementation revision: `b42487b0604fe12309d786d9c4225c7201d1716f`

## Scope

This pass considered only the P0 classes authorized by R3: data corruption,
text committed to the wrong application, host or service crashes, a security
hole exploitable by a co-located unprivileged user, and installer bricking.
It reviewed the Windows TSF context/focus and edit-session path, candidate
selection and response correlation, public and private named-pipe boundaries,
broker/daemon process identity, COM registration and lifetime, and silent
installer/uninstaller behavior. It did not create another review pass or add a
new release gate.

## P0 result

| Finding | P0 reason | Resolution | Evidence |
|---|---|---|---|
| MID-P0-001 — a live `IClassFactory` was absent from the DLL object count, so `DllCanUnloadNow` could return `S_OK` while the factory still owned executable vtable references | An in-process COM server unload at that point can leave a dangling class-factory pointer and crash its host process | `LekhClassFactory` now increments the shared DLL object count for its complete lifetime; `LekhComServerLifetimeTests` holds a real factory reference and requires `S_FALSE` until release, then `S_OK` | Fix revision `b42487b0604fe12309d786d9c4225c7201d1716f`; [CI run 29843100876](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29843100876) |

This resolution follows the Windows COM contract that `DllCanUnloadNow` must
return `S_FALSE` while any object managed by the DLL still has references:
[Microsoft Learn — DllCanUnloadNow](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-dllcanunloadnow).

**Open P0 list: empty.**

## Executed evidence

Local checks at the reviewed revision:

```text
npm run test:v1
Test Files  47 passed (47)
Tests       452 passed (452)

npx vitest run native/windows-tsf/skeleton/windowsTsfSource.test.ts --pool=forks --maxWorkers=1
Test Files  1 passed (1)
Tests       11 passed (11)

npm run check:windows-installer-contract
status: passed

npm run check:ipc-schema
status: pass; version: 2; messageTypes: 18
```

CI run 29843100876 was green on macOS ARM64, macOS x64, Windows ARM64,
and Windows x64. The new native lifetime test passed on both Windows targets:

- [Windows x64 job 88676814238](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29843100876/job/88676814238): `LekhComServerLifetimeTests` passed; 7/7 native CTests passed; the unsigned installer completed install, daemon negotiation, silent uninstall, and clean removal.
- [Windows ARM64 job 88676814186](https://github.com/dantwoashim/Lekh_Assistant/actions/runs/29843100876/job/88676814186): `LekhComServerLifetimeTests` passed; 7/7 native CTests passed.

## Non-P0 disposition

No non-P0 issue was fixed in this pass. The five observed lesser issues were
recorded as the one-line backlog entries V2-087 through V2-091: candidate-font
handle ownership, multi-user install lifecycle, same-account concurrent logon
pipe naming, recoverable TSF-unregister failure, and complete rollback after a
background-start failure.

## Pass accounting

Mid-mission adversarial pass 1 is consumed and complete. No review spawned a
follow-on review. The only remaining permitted adversarial pass is the final
P0-only pass required by E3.
