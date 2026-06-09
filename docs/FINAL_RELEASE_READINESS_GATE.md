# Final Release Readiness Gate

Generated: 2026-06-08

## Engineering Release Candidate Gate

Status: complete.

Evidence:

- typecheck/test/build/checks pass in the latest verification and targeted runs.
- scorecard freshness gate passes.
- keyboard hot-path performance passes.
- no duplicate candidates.
- shortcuts are sequential.
- protected-token and secure-input paths are covered.

## Native Release Candidate Gate

Status: blocked-native-environment.

Required evidence still missing:

- Windows TSF text service registered and tested in real host apps.
- macOS IMK proof target builds, but the input method is not yet packaged/installed/tested in real host apps.
- Native named pipe/XPC latency measured on target platforms.
- No host-app freeze under daemon/XPC failure.

## Private Pilot Gate

Status: partial.

Ready:

- consent policy.
- feedback system.
- demo script.
- benchmark and scorecard evidence.

Blocked:

- native dev build validation for installed keyboard pilot.
- signed/notarized companion and input method packages.
- human feedback does not exist yet.
- Traditional physical layout not validated.

## Public Beta Gate

Status: blocked-external.

Required:

- signed Windows build.
- signed/notarized macOS build.
- installer/update/uninstall validation.
- pilot feedback triage.
- privacy review.

## Stable Launch Gate

Status: blocked-external.

Required:

- all beta blockers resolved.
- crash handling validated.
- update rollback validated.
- final release notes and support path.

## Final Gate Decision

The repo is ready for native implementation and stakeholder demo. It is not ready for public beta or stable launch until native platform validation, signing/notarization, and pilot feedback are complete.
