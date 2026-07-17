import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildCandidateMouseReport,
  candidateMouseReportPrivacyCanary,
  CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS
} from "./macos-candidate-mouse-report.mjs";

const revision = "c".repeat(40);
const tree = "d".repeat(40);
const packagingDigest = "e".repeat(64);

function sourceProvenance() {
  return {
    schemaVersion: 1,
    gitRevision: revision,
    gitTree: tree,
    sourceFilesClean: true,
    sourceStatusReadable: true,
    stableDuringProbe: true,
    sources: CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS.map((path, index) => ({
      path,
      sha256: path === "scripts/package-macos-imk-dev.mjs"
        ? packagingDigest
        : index.toString(16).padStart(64, "0")
    }))
  };
}

function artifactProvenance() {
  const embeddedManifest = {
    schemaVersion: 1,
    recordType: "lekh-imk-build-provenance",
    gitRevision: revision,
    gitTree: tree,
    sourceFilesClean: true,
    shortVersion: "1.0.0",
    buildNumber: "165",
    architectures: ["arm64"],
    packagingScriptSha256: packagingDigest
  };
  return {
    provenanceAssurance: "local-unattested",
    sourceToBinaryAttested: false,
    artifactIntegrityVerified: true,
    embeddedManifestIntegrityVerified: true,
    embeddedManifestSha256: createHash("sha256")
      .update(`${JSON.stringify(embeddedManifest, null, 2)}\n`)
      .digest("hex"),
    embeddedSourceRevision: revision,
    embeddedManifest,
    evidenceRevisionMatches: true,
    installedExecutableSha256: "a".repeat(64),
    runningExecutableSha256: "a".repeat(64),
    executableHashesMatch: true,
    installedCodeDirectoryHash: "b".repeat(40),
    runningCodeDirectoryHash: "b".repeat(40),
    codeDirectoryHashesMatch: true,
    installedBuildVersion: "165",
    runningBuildVersion: "165",
    buildVersionsMatch: true,
    stableDuringProbe: true
  };
}

function gesture(gestureName) {
  const drag = gestureName === "drag-away";
  return {
    gesture: gestureName,
    exactWindowOwnerPreflight: true,
    candidateWindowFramePreflight: true,
    exactCandidateAXHitPreflight: true,
    mouseRoutingWindowPreflight: true,
    frontmostTextEditPreflight: true,
    exactTextEditContextPreflight: true,
    inputSourcePreflight: true,
    postedButtonSequence: drag ? ["down", "drag", "up"] : ["down", "up"],
    observedButtonSequence: drag ? ["down", "drag", "up"] : ["down", "up"],
    fallbackMouseUpPosted: false,
    fallbackMouseUpObserved: false,
    pointerRestored: true,
    preButtonRecheck: {
      exactTextEditContext: true,
      noMoveOrDelayBeforeMouseDown: true,
      recheckToMouseDownPostStartNs: 1_000_000,
      routeToMouseDownPostStartNs: 2_000_000
    }
  };
}

function validInput(overrides = {}) {
  return {
    generatedAt: new Date().toISOString(),
    durationMs: 12.4,
    status: "passed",
    step: "complete",
    failureCount: 0,
    bundleIdentity: {
      bundleIdentifier: "com.lekh.inputmethod.LekhKeyboard",
      connectionName: "com.lekh.inputmethod.LekhKeyboard_Connection",
      shortVersion: "1.0.0",
      buildVersion: "165",
      executableSha256: "a".repeat(64),
      codeDirectoryHash: "b".repeat(40),
      architecture: "arm64"
    },
    sourceProvenance: sourceProvenance(),
    artifactProvenance: artifactProvenance(),
    epoch: {
      pinned: true,
      processIdentifier: 123,
      activationIdentifier: "activation",
      controllerInstanceIdentifier: "controller",
      checkpoints: [
        { label: "initial-runtime-pin", verified: true },
        { label: "before-drag-gesture", verified: true },
        { label: "before-click-gesture", verified: true },
        { label: "final-runtime-pass", verified: true }
      ]
    },
    recovery: {
      lockAcquired: true,
      startupDisposition: "no-recovery-required",
      guardianReady: true,
      guardianDisposition: "normal-completion",
      durableJournalRemoved: true
    },
    cleanup: {
      textEditTerminated: true,
      inputSourceRestored: true,
      preferencesRestored: true,
      temporaryDocumentRemoved: true,
      mouseButtonReleased: true,
      pointerRestored: true
    },
    proof: {
      personalizationDisabled: true,
      candidatePanelIdentifierMatched: true,
      candidateCount: 3,
      firstTwoRowsDistinctDevanagariTokens: true,
      markedCompositionMatchedFirstCandidate: true,
      passivePostconditionCount: 4,
      postconditionsPassivelyObserved: true,
      dragAwayPreservedComposition: true,
      dragAwayPanelRemainedVisible: true,
      nonFirstCandidateCommitted: true,
      firstCandidateNotCommitted: true,
      noCandidateRowsAfterCommit: true,
      frontmostTextEditPreserved: true,
      exactTextEditFrontmostInvariantPreserved: true,
      dragCancellationReceiptActivationMatched: true,
      dragCancellationReceiptDelta: 1,
      dragCancellationReceiptTimestampCausal: true,
      clickCancellationReceiptActivationMatched: true,
      clickCancellationReceiptDelta: 0,
      clickCancellationReceiptTimestampUnchanged: true,
      dragGesture: gesture("drag-away"),
      clickGesture: gesture("click")
    },
    ...overrides
  };
}

describe("candidate-mouse fixed-schema report", () => {
  it("cannot serialize raw candidates, AX labels, surfaces, document text, or child output", () => {
    const canary = candidateMouseReportPrivacyCanary();
    const privateCandidate = `${canary}-व्यक्तिगत-सुझाव`;
    const input = validInput({
      generatedAt: `Wed, 09 Feb 1994 22:23:32 GMT (${privateCandidate})`,
      step: privateCandidate,
      rawCandidate: privateCandidate,
      accessibility: { label: privateCandidate, value: privateCandidate },
      surface: { windows: [{ rows: [{ label: privateCandidate }] }] },
      stdout: privateCandidate,
      stderr: privateCandidate,
      proof: {
        ...validInput().proof,
        firstCandidate: privateCandidate,
        acceptedText: privateCandidate,
        dragGesture: {
          ...validInput().proof.dragGesture,
          startAXHit: { labels: [privateCandidate] },
          rawSurface: privateCandidate
        }
      }
    });
    const serialized = JSON.stringify(buildCandidateMouseReport(input));
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("व्यक्तिगत-सुझाव");
    expect(serialized).not.toContain('"label"');
    expect(serialized).not.toContain('"surface"');
    expect(serialized).not.toContain('"stdout"');
    expect(serialized).not.toContain('"stderr"');
  });

  it("reports only aggregate gesture/runtime/recovery facts", () => {
    const report = buildCandidateMouseReport(validInput());
    expect(report.status).toBe("passed");
    expect(report.passIntegrity.complete).toBe(true);
    expect(report.runtimeEpoch.everyCheckpointVerified).toBe(true);
    expect(report.runtimeEpoch.checkpointCount).toBe(4);
    expect(report.proof.dragGesture.exactObservedSequence).toBe(true);
    expect(report.proof.clickGesture.exactPostedSequence).toBe(true);
    expect(report.proof.dragCancellationReceiptDelta).toBe(1);
    expect(report.proof.clickCancellationReceiptDelta).toBe(0);
    expect(report.proof).not.toHaveProperty("noStrayInputObserved");
    expect(report.privacy).toEqual({
      contentFreeFixedSchema: true,
      rawCandidateTextSerialized: false,
      rawAXLabelsSerialized: false,
      rawSurfaceSerialized: false,
      childOutputSerialized: false,
      canaryAbsent: true
    });
  });

  it.each([
    ["report metadata", { generatedAt: "not-a-timestamp" }, "reportMetadataComplete"],
    ["cleanup", { cleanup: { ...validInput().cleanup, mouseButtonReleased: false } }, "cleanupComplete"],
    ["recovery settlement", {
      recovery: { ...validInput().recovery, guardianDisposition: "crash-recovery" }
    }, "recoveryComplete"],
    ["runtime epoch", {
      epoch: {
        ...validInput().epoch,
        checkpoints: validInput().epoch.checkpoints.slice(0, 3)
      }
    }, "runtimeEpochComplete"],
    ["source provenance", {
      sourceProvenance: { ...sourceProvenance(), sourceFilesClean: false }
    }, "sourceProvenanceComplete"],
    ["artifact provenance", {
      artifactProvenance: { ...artifactProvenance(), executableHashesMatch: false }
    }, "artifactProvenanceComplete"],
    ["proof", {
      proof: { ...validInput().proof, frontmostTextEditPreserved: false }
    }, "proofComplete"],
    ["missing causal drag receipt", {
      proof: { ...validInput().proof, dragCancellationReceiptDelta: 0 }
    }, "proofComplete"],
    ["duplicate drag receipt", {
      proof: { ...validInput().proof, dragCancellationReceiptDelta: 2 }
    }, "proofComplete"],
    ["click changed cancellation receipt", {
      proof: { ...validInput().proof, clickCancellationReceiptDelta: 1 }
    }, "proofComplete"],
    ["click changed cancellation timestamp", {
      proof: { ...validInput().proof, clickCancellationReceiptTimestampUnchanged: false }
    }, "proofComplete"],
    ["gesture document custody", {
      proof: {
        ...validInput().proof,
        dragGesture: {
          ...validInput().proof.dragGesture,
          preButtonRecheck: {
            ...validInput().proof.dragGesture.preButtonRecheck,
            exactTextEditContext: false
          }
        }
      }
    }, "proofComplete"]
  ])("downgrades a requested pass when %s is incomplete", (_name, override, failedField) => {
    const report = buildCandidateMouseReport(validInput(override));
    expect(report.status).toBe("failed");
    expect(report.outcome.failureCount).toBeGreaterThanOrEqual(1);
    expect(report.passIntegrity.complete).toBe(false);
    expect(report.passIntegrity[failedField]).toBe(false);
  });
});
