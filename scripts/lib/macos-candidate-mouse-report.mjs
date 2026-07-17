import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const schemaVersion = 1;
const privateCanary = "LEKH_CANDIDATE_MOUSE_PRIVATE_CANARY_7D1E4A93";
const statuses = new Set(["passed", "failed", "blocked-automation"]);
const safeStepPattern = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitObjectPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const codeDirectoryPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const requiredEpochCheckpoints = Object.freeze([
  "initial-runtime-pin",
  "before-drag-gesture",
  "before-click-gesture",
  "final-runtime-pass"
]);

export const CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS = Object.freeze([
  "scripts/check-macos-imk-host-candidate-mouse.mjs",
  "scripts/lib/macos-candidate-mouse-report.mjs",
  "scripts/lib/macos-candidate-mouse-recovery.mjs",
  "scripts/lib/macos-candidate-textedit-custody.mjs",
  "scripts/lib/macos-textedit-passive-inspection.mjs",
  "scripts/lib/macos-host-state-lease.mjs",
  "scripts/lib/macos-imk-host-harness.mjs",
  "scripts/lib/macos-imk-build-identity.mjs",
  "scripts/macos-companion-publication-lock.swift",
  "scripts/package-macos-imk-dev.mjs",
  "native/macos-imk/skeleton/LekhInputController.swift",
  "native/macos-imk/skeleton/LekhCandidateController.swift",
  "native/macos-imk/skeleton/LekhCandidatePanel.swift"
]);

function boolean(value) {
  return value === true;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function fixedString(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function safeStep(value) {
  return typeof value === "string" && safeStepPattern.test(value) ? value : "internal-failure";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function captureCandidateMouseEvidenceProvenance(root) {
  const runGit = (args) => spawnSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe"
  });
  const revision = runGit(["rev-parse", "HEAD"]);
  const tree = runGit(["rev-parse", "HEAD^{tree}"]);
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    schemaVersion: 1,
    gitRevision: revision.status === 0 ? revision.stdout.trim() : null,
    gitTree: tree.status === 0 ? tree.stdout.trim() : null,
    sourceFilesClean: status.status === 0 && status.stdout.trim() === "",
    sourceStatusReadable: status.status === 0,
    stableDuringProbe: false,
    sources: CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS.map((relativePath) => {
      const absolutePath = join(root, relativePath);
      return {
        path: relativePath,
        sha256: existsSync(absolutePath) ? sha256(absolutePath) : null
      };
    })
  };
}

function runtimeIdentity(identity) {
  return {
    bundleIdentifierMatches: identity?.bundleIdentifier === "com.lekh.inputmethod.LekhKeyboard",
    connectionNameMatches: identity?.connectionName === "com.lekh.inputmethod.LekhKeyboard_Connection",
    shortVersion: typeof identity?.shortVersion === "string" && /^[0-9A-Za-z.-]{1,64}$/u.test(identity.shortVersion)
      ? identity.shortVersion
      : null,
    buildVersion: typeof identity?.buildVersion === "string" && /^\d{1,18}$/u.test(identity.buildVersion)
      ? identity.buildVersion
      : null,
    executableSha256: typeof identity?.executableSha256 === "string" && /^[a-f0-9]{64}$/u.test(identity.executableSha256)
      ? identity.executableSha256
      : null,
    codeDirectoryHash: typeof identity?.codeDirectoryHash === "string" && /^[a-f0-9]{40,64}$/u.test(identity.codeDirectoryHash)
      ? identity.codeDirectoryHash
      : null,
    architecture: ["arm64", "x86_64"].includes(identity?.architecture) ? identity.architecture : null
  };
}

function runtimeEpoch(evidence) {
  const checkpoints = Array.isArray(evidence?.checkpoints) ? evidence.checkpoints : [];
  const labels = checkpoints
    .map((checkpoint) => checkpoint?.label)
    .filter((label) => typeof label === "string" && safeStepPattern.test(label));
  return {
    pinned: boolean(evidence?.pinned),
    checkpointCount: labels.length,
    checkpoints: labels,
    everyCheckpointVerified: checkpoints.length === requiredEpochCheckpoints.length &&
      checkpoints.every((checkpoint, index) =>
        checkpoint?.verified === true && checkpoint?.label === requiredEpochCheckpoints[index]
      ),
    processIdentifier: integerOrNull(evidence?.processIdentifier),
    activationIdentifierPresent: typeof evidence?.activationIdentifier === "string" && evidence.activationIdentifier.length > 0,
    controllerInstanceIdentifierPresent:
      typeof evidence?.controllerInstanceIdentifier === "string" && evidence.controllerInstanceIdentifier.length > 0
  };
}

function sourceProvenanceEvidence(provenance) {
  const byPath = new Map(
    Array.isArray(provenance?.sources)
      ? provenance.sources.map((source) => [source?.path, source])
      : []
  );
  return {
    schemaVersion: provenance?.schemaVersion === 1 ? 1 : null,
    gitRevision: gitObjectPattern.test(provenance?.gitRevision ?? "") ? provenance.gitRevision : null,
    gitTree: gitObjectPattern.test(provenance?.gitTree ?? "") ? provenance.gitTree : null,
    sourceFilesClean: boolean(provenance?.sourceFilesClean),
    sourceStatusReadable: boolean(provenance?.sourceStatusReadable),
    stableDuringProbe: boolean(provenance?.stableDuringProbe),
    sources: CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS.map((path) => ({
      path,
      sha256: sha256Pattern.test(byPath.get(path)?.sha256 ?? "") ? byPath.get(path).sha256 : null
    }))
  };
}

function artifactProvenanceEvidence(provenance) {
  const manifest = provenance?.embeddedManifest;
  const normalizedManifest = {
    schemaVersion: manifest?.schemaVersion === 1 ? 1 : null,
    recordType: manifest?.recordType === "lekh-imk-build-provenance"
      ? manifest.recordType
      : "unverified",
    gitRevision: gitObjectPattern.test(manifest?.gitRevision ?? "") ? manifest.gitRevision : null,
    gitTree: gitObjectPattern.test(manifest?.gitTree ?? "") ? manifest.gitTree : null,
    sourceFilesClean: boolean(manifest?.sourceFilesClean),
    shortVersion: typeof manifest?.shortVersion === "string" &&
      /^[0-9A-Za-z.-]{1,64}$/u.test(manifest.shortVersion)
      ? manifest.shortVersion
      : null,
    buildNumber: typeof manifest?.buildNumber === "string" && /^\d{1,18}$/u.test(manifest.buildNumber)
      ? manifest.buildNumber
      : null,
    architectures: Array.isArray(manifest?.architectures)
      ? manifest.architectures.map((item) => ["arm64", "x86_64"].includes(item) ? item : "invalid")
      : [],
    packagingScriptSha256: sha256Pattern.test(manifest?.packagingScriptSha256 ?? "")
      ? manifest.packagingScriptSha256
      : null
  };
  return {
    provenanceAssurance: provenance?.provenanceAssurance === "local-unattested"
      ? "local-unattested"
      : "unverified",
    sourceToBinaryAttested: boolean(provenance?.sourceToBinaryAttested),
    artifactIntegrityVerified: boolean(provenance?.artifactIntegrityVerified),
    embeddedManifestIntegrityVerified: boolean(provenance?.embeddedManifestIntegrityVerified),
    embeddedManifestSha256: sha256Pattern.test(provenance?.embeddedManifestSha256 ?? "")
      ? provenance.embeddedManifestSha256
      : null,
    embeddedManifest: normalizedManifest,
    embeddedSourceRevision: gitObjectPattern.test(provenance?.embeddedSourceRevision ?? "")
      ? provenance.embeddedSourceRevision
      : null,
    embeddedSourceTree: gitObjectPattern.test(manifest?.gitTree ?? "") ? manifest.gitTree : null,
    packagingScriptSha256: sha256Pattern.test(manifest?.packagingScriptSha256 ?? "")
      ? manifest.packagingScriptSha256
      : null,
    evidenceRevisionMatches: boolean(provenance?.evidenceRevisionMatches),
    installedExecutableSha256: sha256Pattern.test(provenance?.installedExecutableSha256 ?? "")
      ? provenance.installedExecutableSha256
      : null,
    runningExecutableSha256: sha256Pattern.test(provenance?.runningExecutableSha256 ?? "")
      ? provenance.runningExecutableSha256
      : null,
    executableHashesMatch: boolean(provenance?.executableHashesMatch),
    installedCodeDirectoryHash: codeDirectoryPattern.test(provenance?.installedCodeDirectoryHash ?? "")
      ? provenance.installedCodeDirectoryHash
      : null,
    runningCodeDirectoryHash: codeDirectoryPattern.test(provenance?.runningCodeDirectoryHash ?? "")
      ? provenance.runningCodeDirectoryHash
      : null,
    codeDirectoryHashesMatch: boolean(provenance?.codeDirectoryHashesMatch),
    installedBuildVersion: typeof provenance?.installedBuildVersion === "string" &&
      /^\d{1,18}$/u.test(provenance.installedBuildVersion)
      ? provenance.installedBuildVersion
      : null,
    runningBuildVersion: typeof provenance?.runningBuildVersion === "string" &&
      /^\d{1,18}$/u.test(provenance.runningBuildVersion)
      ? provenance.runningBuildVersion
      : null,
    buildVersionsMatch: boolean(provenance?.buildVersionsMatch),
    stableDuringProbe: boolean(provenance?.stableDuringProbe)
  };
}

function gestureEvidence(gesture, expectedGesture) {
  const expected = expectedGesture === "drag-away" ? ["down", "drag", "up"] : ["down", "up"];
  const exactSequence = (value) => Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index]);
  return {
    gesture: fixedString(gesture?.gesture, new Set([expectedGesture]), expectedGesture),
    exactWindowOwnerPreflight: boolean(gesture?.exactWindowOwnerPreflight),
    candidateWindowFramePreflight: boolean(gesture?.candidateWindowFramePreflight),
    exactCandidateAXHitPreflight: boolean(gesture?.exactCandidateAXHitPreflight),
    mouseRoutingWindowPreflight: boolean(gesture?.mouseRoutingWindowPreflight),
    frontmostTextEditPreflight: boolean(gesture?.frontmostTextEditPreflight),
    exactTextEditContextPreflight: boolean(gesture?.exactTextEditContextPreflight),
    inputSourcePreflight: boolean(gesture?.inputSourcePreflight),
    exactPostedSequence: exactSequence(gesture?.postedButtonSequence),
    exactObservedSequence: exactSequence(gesture?.observedButtonSequence),
    fallbackMouseUpPosted: boolean(gesture?.fallbackMouseUpPosted),
    fallbackMouseUpObserved: boolean(gesture?.fallbackMouseUpObserved),
    pointerRestored: boolean(gesture?.pointerRestored),
    exactTextEditContextRecheck: boolean(gesture?.preButtonRecheck?.exactTextEditContext),
    noMoveOrDelayBeforeMouseDown: boolean(gesture?.preButtonRecheck?.noMoveOrDelayBeforeMouseDown),
    recheckToMouseDownPostStartNs: finiteOrNull(gesture?.preButtonRecheck?.recheckToMouseDownPostStartNs),
    routeToMouseDownPostStartNs: finiteOrNull(gesture?.preButtonRecheck?.routeToMouseDownPostStartNs)
  };
}

function cleanupEvidence(cleanup) {
  return {
    textEditTerminated: boolean(cleanup?.textEditTerminated),
    inputSourceRestored: boolean(cleanup?.inputSourceRestored),
    preferencesRestored: boolean(cleanup?.preferencesRestored),
    temporaryDocumentRemoved: boolean(cleanup?.temporaryDocumentRemoved),
    mouseButtonReleased: boolean(cleanup?.mouseButtonReleased),
    pointerRestored: boolean(cleanup?.pointerRestored)
  };
}

function recoveryEvidence(recovery) {
  return {
    lockAcquired: boolean(recovery?.lockAcquired),
    startupDisposition: fixedString(
      recovery?.startupDisposition,
      new Set(["no-recovery-required", "recovered"]),
      "unverified"
    ),
    guardianReady: boolean(recovery?.guardianReady),
    guardianDisposition: fixedString(
      recovery?.guardianDisposition,
      new Set(["normal-completion", "crash-recovery"]),
      "unverified"
    ),
    durableJournalRemoved: boolean(recovery?.durableJournalRemoved)
  };
}

function gesturePassed(gesture, expectedGesture) {
  const maxRecheckNs = 10_000_000;
  const maxRouteNs = 50_000_000;
  return gesture.gesture === expectedGesture &&
    gesture.exactWindowOwnerPreflight === true &&
    gesture.candidateWindowFramePreflight === true &&
    gesture.exactCandidateAXHitPreflight === true &&
    gesture.mouseRoutingWindowPreflight === true &&
    gesture.frontmostTextEditPreflight === true &&
    gesture.exactTextEditContextPreflight === true &&
    gesture.inputSourcePreflight === true &&
    gesture.exactPostedSequence === true &&
    gesture.exactObservedSequence === true &&
    gesture.fallbackMouseUpPosted === false &&
    gesture.fallbackMouseUpObserved === false &&
    gesture.pointerRestored === true &&
    gesture.exactTextEditContextRecheck === true &&
    gesture.noMoveOrDelayBeforeMouseDown === true &&
    Number.isFinite(gesture.recheckToMouseDownPostStartNs) &&
    gesture.recheckToMouseDownPostStartNs >= 0 &&
    gesture.recheckToMouseDownPostStartNs <= maxRecheckNs &&
    Number.isFinite(gesture.routeToMouseDownPostStartNs) &&
    gesture.routeToMouseDownPostStartNs >= 0 &&
    gesture.routeToMouseDownPostStartNs <= maxRouteNs;
}

function computePassIntegrity(report) {
  const source = report.sourceProvenance;
  const artifact = report.artifactProvenance;
  const manifest = artifact.embeddedManifest;
  const packagingSource = source.sources.find((item) => item.path === "scripts/package-macos-imk-dev.mjs");
  const manifestDigest = createHash("sha256")
    .update(`${JSON.stringify(manifest, null, 2)}\n`)
    .digest("hex");
  const sourceProvenanceComplete = source.schemaVersion === 1 &&
    source.sourceFilesClean === true &&
    source.sourceStatusReadable === true &&
    source.stableDuringProbe === true &&
    gitObjectPattern.test(source.gitRevision ?? "") &&
    gitObjectPattern.test(source.gitTree ?? "") &&
    source.sources.length === CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS.length &&
    source.sources.every((item, index) =>
      item.path === CANDIDATE_MOUSE_EVIDENCE_SOURCE_PATHS[index] && sha256Pattern.test(item.sha256 ?? "")
    );
  const reportMetadataComplete = Date.parse(report.generatedAt) >= Date.parse("2024-01-01T00:00:00.000Z") &&
    report.durationMs > 0;
  const artifactProvenanceComplete = artifact.provenanceAssurance === "local-unattested" &&
    artifact.sourceToBinaryAttested === false &&
    artifact.artifactIntegrityVerified === true &&
    artifact.embeddedManifestIntegrityVerified === true &&
    manifest.schemaVersion === 1 &&
    manifest.recordType === "lekh-imk-build-provenance" &&
    manifest.sourceFilesClean === true &&
    manifest.gitRevision === source.gitRevision &&
    manifest.gitTree === source.gitTree &&
    manifest.shortVersion === report.installedRuntime.shortVersion &&
    manifest.buildNumber === report.installedRuntime.buildVersion &&
    manifest.architectures.length >= 1 &&
    manifest.architectures.length <= 2 &&
    new Set(manifest.architectures).size === manifest.architectures.length &&
    JSON.stringify(manifest.architectures) === JSON.stringify([...manifest.architectures].sort()) &&
    manifest.architectures.includes(report.installedRuntime.architecture) &&
    artifact.evidenceRevisionMatches === true &&
    artifact.stableDuringProbe === true &&
    artifact.embeddedSourceRevision === manifest.gitRevision &&
    artifact.embeddedSourceTree === manifest.gitTree &&
    artifact.packagingScriptSha256 === manifest.packagingScriptSha256 &&
    manifest.packagingScriptSha256 === packagingSource?.sha256 &&
    artifact.embeddedManifestSha256 === manifestDigest &&
    artifact.installedExecutableSha256 === report.installedRuntime.executableSha256 &&
    artifact.runningExecutableSha256 === report.installedRuntime.executableSha256 &&
    artifact.executableHashesMatch === true &&
    artifact.installedCodeDirectoryHash === report.installedRuntime.codeDirectoryHash &&
    artifact.runningCodeDirectoryHash === report.installedRuntime.codeDirectoryHash &&
    artifact.codeDirectoryHashesMatch === true &&
    artifact.installedBuildVersion === report.installedRuntime.buildVersion &&
    artifact.runningBuildVersion === report.installedRuntime.buildVersion &&
    artifact.buildVersionsMatch === true;
  const runtimeIdentityComplete = report.installedRuntime.bundleIdentifierMatches === true &&
    report.installedRuntime.connectionNameMatches === true &&
    report.installedRuntime.shortVersion !== null &&
    report.installedRuntime.buildVersion !== null &&
    report.installedRuntime.executableSha256 !== null &&
    report.installedRuntime.codeDirectoryHash !== null &&
    report.installedRuntime.architecture !== null;
  const runtimeEpochComplete = report.runtimeEpoch.pinned === true &&
    report.runtimeEpoch.everyCheckpointVerified === true &&
    report.runtimeEpoch.checkpointCount === requiredEpochCheckpoints.length &&
    Number.isInteger(report.runtimeEpoch.processIdentifier) &&
    report.runtimeEpoch.processIdentifier > 1 &&
    report.runtimeEpoch.activationIdentifierPresent === true &&
    report.runtimeEpoch.controllerInstanceIdentifierPresent === true;
  const recoveryComplete = report.recovery.lockAcquired === true &&
    ["no-recovery-required", "recovered"].includes(report.recovery.startupDisposition) &&
    report.recovery.guardianReady === true &&
    report.recovery.guardianDisposition === "normal-completion" &&
    report.recovery.durableJournalRemoved === true;
  const cleanupComplete = Object.values(report.cleanup).every((value) => value === true);
  const proof = report.proof;
  const proofComplete = proof.personalizationDisabled === true &&
    proof.candidatePanelIdentifierMatched === true &&
    proof.candidateCount >= 3 &&
    proof.firstTwoRowsDistinctDevanagariTokens === true &&
    proof.markedCompositionMatchedFirstCandidate === true &&
    proof.passivePostconditionCount === 4 &&
    proof.postconditionsPassivelyObserved === true &&
    proof.dragAwayPreservedComposition === true &&
    proof.dragAwayPanelRemainedVisible === true &&
    proof.nonFirstCandidateCommitted === true &&
    proof.firstCandidateNotCommitted === true &&
    proof.noCandidateRowsAfterCommit === true &&
    proof.frontmostTextEditPreserved === true &&
    proof.exactTextEditFrontmostInvariantPreserved === true &&
    proof.dragCancellationReceiptActivationMatched === true &&
    proof.dragCancellationReceiptDelta === 1 &&
    proof.dragCancellationReceiptTimestampCausal === true &&
    proof.clickCancellationReceiptActivationMatched === true &&
    proof.clickCancellationReceiptDelta === 0 &&
    proof.clickCancellationReceiptTimestampUnchanged === true &&
    gesturePassed(proof.dragGesture, "drag-away") &&
    gesturePassed(proof.clickGesture, "click");
  const outcomeComplete = report.outcome.step === "complete" && report.outcome.failureCount === 0;
  const complete = [
    reportMetadataComplete,
    sourceProvenanceComplete,
    artifactProvenanceComplete,
    runtimeIdentityComplete,
    runtimeEpochComplete,
    recoveryComplete,
    cleanupComplete,
    proofComplete,
    outcomeComplete
  ].every(Boolean);
  return {
    reportMetadataComplete,
    sourceProvenanceComplete,
    artifactProvenanceComplete,
    runtimeIdentityComplete,
    runtimeEpochComplete,
    recoveryComplete,
    cleanupComplete,
    proofComplete,
    outcomeComplete,
    complete
  };
}

/**
 * Builds the only serializable candidate-mouse report shape. Runtime candidate
 * strings, AX titles/descriptions, document text, surfaces, and child stdout or
 * stderr have no destination in this schema and are therefore unrepresentable.
 */
export function buildCandidateMouseReport({
  generatedAt,
  durationMs,
  status,
  step,
  failureCount,
  bundleIdentity,
  epoch,
  sourceProvenance,
  artifactProvenance,
  recovery,
  cleanup,
  proof
}) {
  const normalizedStatus = fixedString(status, statuses, "failed");
  const parsedGeneratedAt = typeof generatedAt === "string" ? Date.parse(generatedAt) : Number.NaN;
  const report = {
    schemaVersion,
    generatedAt: Number.isFinite(parsedGeneratedAt)
      ? new Date(parsedGeneratedAt).toISOString()
      : new Date(0).toISOString(),
    command: "npm run probe:macos-imk-host:candidate-mouse",
    suite: "macos-imk-host-candidate-mouse",
    durationMs: Math.max(0, Math.round(finiteOrNull(durationMs) ?? 0)),
    outcome: {
      step: safeStep(step),
      failureCount: Math.max(0, integerOrNull(failureCount) ?? 0)
    },
    installedRuntime: runtimeIdentity(bundleIdentity),
    runtimeEpoch: runtimeEpoch(epoch),
    sourceProvenance: sourceProvenanceEvidence(sourceProvenance),
    artifactProvenance: artifactProvenanceEvidence(artifactProvenance),
    recovery: recoveryEvidence(recovery),
    proof: {
      personalizationDisabled: boolean(proof?.personalizationDisabled),
      candidatePanelIdentifierMatched: boolean(proof?.candidatePanelIdentifierMatched),
      candidateCount: Math.max(0, integerOrNull(proof?.candidateCount) ?? 0),
      firstTwoRowsDistinctDevanagariTokens: boolean(proof?.firstTwoRowsDistinctDevanagariTokens),
      markedCompositionMatchedFirstCandidate: boolean(proof?.markedCompositionMatchedFirstCandidate),
      passivePostconditionCount: Math.max(0, integerOrNull(proof?.passivePostconditionCount) ?? 0),
      postconditionsPassivelyObserved: boolean(proof?.postconditionsPassivelyObserved),
      dragAwayPreservedComposition: boolean(proof?.dragAwayPreservedComposition),
      dragAwayPanelRemainedVisible: boolean(proof?.dragAwayPanelRemainedVisible),
      nonFirstCandidateCommitted: boolean(proof?.nonFirstCandidateCommitted),
      firstCandidateNotCommitted: boolean(proof?.firstCandidateNotCommitted),
      noCandidateRowsAfterCommit: boolean(proof?.noCandidateRowsAfterCommit),
      frontmostTextEditPreserved: boolean(proof?.frontmostTextEditPreserved),
      exactTextEditFrontmostInvariantPreserved: boolean(proof?.exactTextEditFrontmostInvariantPreserved),
      dragCancellationReceiptActivationMatched: boolean(proof?.dragCancellationReceiptActivationMatched),
      dragCancellationReceiptDelta: integerOrNull(proof?.dragCancellationReceiptDelta),
      dragCancellationReceiptTimestampCausal: boolean(proof?.dragCancellationReceiptTimestampCausal),
      clickCancellationReceiptActivationMatched: boolean(proof?.clickCancellationReceiptActivationMatched),
      clickCancellationReceiptDelta: integerOrNull(proof?.clickCancellationReceiptDelta),
      clickCancellationReceiptTimestampUnchanged: boolean(proof?.clickCancellationReceiptTimestampUnchanged),
      dragGesture: gestureEvidence(proof?.dragGesture, "drag-away"),
      clickGesture: gestureEvidence(proof?.clickGesture, "click")
    },
    cleanup: cleanupEvidence(cleanup),
    privacy: {
      contentFreeFixedSchema: true,
      rawCandidateTextSerialized: false,
      rawAXLabelsSerialized: false,
      rawSurfaceSerialized: false,
      childOutputSerialized: false,
      canaryAbsent: true
    },
    passIntegrity: null,
    status: normalizedStatus
  };
  report.passIntegrity = computePassIntegrity(report);
  if (normalizedStatus === "passed" && report.passIntegrity.complete !== true) {
    report.status = "failed";
    report.outcome.failureCount = Math.max(1, report.outcome.failureCount);
    report.passIntegrity = computePassIntegrity(report);
  }
  const serialized = JSON.stringify(report);
  if (serialized.includes(privateCanary)) {
    throw new Error("Candidate-mouse report privacy canary escaped fixed-schema redaction.");
  }
  return report;
}

export function candidateMouseReportPrivacyCanary() {
  return privateCanary;
}
