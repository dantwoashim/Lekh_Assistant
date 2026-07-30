# Neural Engine Runtime Placement

## Why this gate exists

`MLModelConfiguration.computeUnits = .all` permits Core ML to choose among
available compute units. `MLComputePlan` reports anticipated supported and
preferred devices. Neither proves where a live prediction executed.

Apple's Core ML performance report distinguishes a layer that actually ran on
a compute unit from one that is merely supported there. Apple's Core ML
Instrument exposes live prediction and compute events, and the Neural Engine
Instrument shows Neural Engine hardware activity inside those prediction
intervals. Lekh therefore permits a production Neural Engine claim only from a
correlated live trace for the exact packaged artifact set.

Primary Apple references:

- [Optimize your Core ML usage (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10027/)
- [MLComputePlanDeviceUsage](https://developer.apple.com/documentation/coreml/mlcomputeplandeviceusage)
- [Xcode support and downloads](https://developer.apple.com/support/xcode)
- [Apple Developer membership comparison](https://developer.apple.com/support/compare-memberships/)

Xcode is free. This local profiling workflow does not require the paid Apple
Developer Program, Developer ID signing, or notarization. Those paid services
remain relevant to public distribution, not to Instruments evidence on the
developer's own Mac.

## Current environment truth

As of 2026-07-28, this Mac has Apple Silicon and macOS 26.2, but only Xcode
Command Line Tools are active. `xcrun xctrace list templates` fails because
the full Xcode Instruments toolchain is absent. Apple's current system
requirements list Xcode 26.6 as supporting macOS Tahoe 26.2 through 26.x, so
the installed OS is compatible. The machine has only about 20 GiB free, which
is not a safe margin for installing and expanding current Xcode. Consequently,
no valid runtime-placement evidence exists yet, and the production promotion
gate must remain closed.

This limitation is tooling and disk capacity, not the missing $99 Developer
Program membership.

## Current fail-closed provenance status

The JSON summary is not trusted by itself. The verifier now requires an
in-process provenance capability produced only after safely reopening the
repository-contained raw `.trace` directory and strict UTF-8 XML export,
rejecting path indirection and unsafe XML declarations, and recomputing both
recorded hashes. That capability is deliberately non-serializable: copying its
fields into JSON does not recreate it.

Artifact custody alone still cannot prove that the summary's process,
prediction-interval, model-role, and Neural Engine correlations were derived
from the trace. No real `xctrace` Core ML + Neural Engine XML sample exists in
the repository, so inventing table names or row semantics would be
self-attestation under another name. Production Neural Engine claims therefore
remain fail-closed with
`neural-runtime-placement.semantic-correlation-unverified`.

Closing this gate requires one versioned export produced by the real Xcode
workflow below, followed by a fixture-backed parser that derives the required
correlations from those exact rows and passes the branded capability through
every production validator. Until that sample and integration exist, the
validation command must fail and no Neural Engine execution claim is allowed.

## Required capture

1. Install the current stable Xcode from the Mac App Store after making enough
   free space for both the download and installation.
2. Select its developer directory and confirm Instruments is available:

   ```sh
   sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
   xcrun xctrace list templates
   ```

3. Package the exact unpromoted candidate with
   `LEKH_NEURAL_PACKAGE_MODE=candidate-promotion`.
4. Prepare the Core ML + Neural Engine Instruments trace, then start the
   long-form exact-bundle workload:

   ```sh
   node scripts/benchmark-neural-native-service.mjs \
     --placement-capture \
     --bundle "/absolute/path/to/Lekh Keyboard.imkdevbundle"
   ```

   Placement-capture mode prints its process ID and waits 20 seconds for
   Instruments to attach. It then performs 5 warm-up requests and 40 measured
   full-candidate requests through the public asynchronous service. It covers
   model loading, Core ML prediction, iterative beam search, target-script
   validation, cancellation behavior, and completion delivery.

5. In Instruments, use the Core ML template, add the Neural Engine Instrument,
   attach to the printed `LekhInputMethodBehaviorProbe` process during the
   20-second window, and capture the complete placement workload.
6. Export the trace tables and retain SHA-256 identities for both the raw trace
   and exported tables.
7. Build a closed
   `lekh-neural-runtime-placement-evidence` JSON record. It must identify:

   - the exact manifest, vocabulary, artifact-set, role names, compiled hashes,
     and byte counts;
   - the Apple Silicon hardware, macOS version, Xcode version, and capture
     instruments;
   - the exact closed workload emitted by the capture report: the ordered
     tokens `prashasan`, `nagarikta`, `mantralaya`, `sambidhan`, and
     `paryatan`, with exactly 5 warm-up and 40 measured full-candidate
     requests;
   - the workload identity SHA-256 published by the capture report (the
     validator independently recomputes and enforces the same identity);
   - process-scoped Core ML prediction intervals;
   - correlated Neural Engine hardware activity;
   - a nonzero prediction count and observed Neural Engine compute for every
     runtime role.

8. After the fixture-backed correlation parser and provenance handoff are
   implemented, validate the record:

   ```sh
   node scripts/check-neural-runtime-placement-evidence.mjs \
     --artifact-root data/generated/neural-open-vocab-model/<model-id> \
     --evidence reports/neural-runtime-placement-evidence.json \
     --trace-directory reports/neural-runtime-placement.trace \
     --trace-export reports/neural-runtime-placement.xml
   ```

   The checker reopens both artifacts inside the repository, rejects symlink
   indirection, recomputes their exact hashes, and passes a non-serializable
   provenance capability into the placement validator. Until a fixture-backed
   semantic parser exists, this command is expected to fail closed rather than
   accept the hand-authored correlation booleans.

9. Bind that validated record into the candidate-promotion benchmark:

   ```sh
   node scripts/benchmark-neural-native-service.mjs \
     --promotion-evidence \
     --runtime-placement-evidence \
       reports/neural-runtime-placement-evidence.json
   ```

The promoter, model selector, live Phase 9 verifier, runtime-conformance gate,
and final readiness gate independently revalidate the embedded runtime
placement against the exact artifact set. A compute-plan-only report fails.

## Claim language

Until this gate passes, allowed language is:

> Core ML model; Neural Engine compatibility is anticipated but live placement
> has not been verified.

After it passes for the exact artifact set, allowed language is:

> Neural Engine execution was observed on the recorded Apple Silicon device
> for the exact packaged model during the captured workload.

The evidence never implies that every operation, every Mac model, or every
future macOS version will use the Neural Engine.
