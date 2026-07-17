import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEKH_BUNDLE_IDENTIFIER,
  LEKH_CONNECTION_NAME,
  LEKH_INPUT_SOURCE_IDENTIFIER,
  macOSQAMatrixStatus,
  MANUAL_HOST_EVIDENCE_SCHEMA_VERSION,
  MANUAL_HOST_EVIDENCE_SUITE,
  manualHostEvidenceAllowedForMatrix,
  SECURE_FIELD_EVIDENCE_SOURCE_PATHS,
  validateManualHostEvidence,
  validateSecureFieldHostEvidence
} from "./macos-imk-qa-evidence-validator.mjs";

const temporaryRoots = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function manualFixture() {
  const root = mkdtempSync(join(tmpdir(), "lekh-manual-evidence-"));
  temporaryRoots.push(root);
  const artifactRelativePath = "reports/qa/macos-imk/artifacts/textedit-space.png";
  const artifactPath = join(root, artifactRelativePath);
  mkdirSync(join(root, "reports", "qa", "macos-imk", "artifacts"), { recursive: true });
  writeFileSync(artifactPath, "fixed synthetic screenshot bytes");
  const bundleIdentity = {
    bundleIdentifier: LEKH_BUNDLE_IDENTIFIER,
    shortVersion: "0.1.0",
    buildVersion: "165",
    sourceRevision: "c".repeat(40),
    sourceTree: "d".repeat(40),
    connectionName: LEKH_CONNECTION_NAME,
    executableSha256: "a".repeat(64),
    codeDirectoryHash: "b".repeat(40),
    buildProvenanceSha256: "e".repeat(64)
  };
  const repository = {
    readable: true,
    revision: "c".repeat(40),
    tree: "d".repeat(40),
    clean: true,
    sourceHashes: {}
  };
  const context = {
    ready: true,
    issueCodes: [],
    bundleIdentity,
    repository
  };
  const evidence = {
    schemaVersion: MANUAL_HOST_EVIDENCE_SCHEMA_VERSION,
    suite: MANUAL_HOST_EVIDENCE_SUITE,
    generatedAt: new Date().toISOString(),
    target: "macOS 26 Apple Silicon",
    app: "TextEdit",
    case: "space-commit",
    macOSVersion: "26.0",
    architecture: "arm64",
    inputSource: LEKH_INPUT_SOURCE_IDENTIFIER,
    bundleIdentity: { ...bundleIdentity },
    steps: [{
      action: "Type a deterministic token and press Space.",
      expected: "The host receives one safe commit.",
      actual: "The host received one safe commit.",
      pass: true
    }],
    expected: "One safe host commit.",
    actual: "One safe host commit observed.",
    pass: true,
    artifacts: [{
      kind: "screenshot",
      path: artifactRelativePath,
      sha256: digest("fixed synthetic screenshot bytes")
    }],
    logPaths: [],
    provenance: {
      schemaVersion: 1,
      gitRevision: repository.revision,
      worktreeClean: true,
      installedSourceRevision: bundleIdentity.sourceRevision,
      installedSourceTree: bundleIdentity.sourceTree,
      installedBuildProvenanceSha256: bundleIdentity.buildProvenanceSha256,
      installedExecutableSha256: bundleIdentity.executableSha256,
      installedBuildVersion: bundleIdentity.buildVersion
    }
  };
  return { root, context, evidence };
}

function secureFixture() {
  const root = mkdtempSync(join(tmpdir(), "lekh-secure-evidence-"));
  temporaryRoots.push(root);
  const packagingScript = "fixed package source\n";
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "package-macos-imk-dev.mjs"), packagingScript);
  const sourceHashes = Object.fromEntries(
    SECURE_FIELD_EVIDENCE_SOURCE_PATHS.map((path, index) => [path, String(index + 1).padStart(64, "0")])
  );
  const repositoryState = {
    readable: true,
    revision: "d".repeat(40),
    tree: "e".repeat(40),
    clean: true,
    sourceHashes
  };
  const cleanup = {
    hostTerminated: true,
    inputSourceRestored: true,
    preferencesRestored: true,
    secureInputReturnedToBaseline: true,
    temporaryHostRemoved: true
  };
  const checkpoints = [
    "calibration-complete",
    "secure-focus",
    "secure-token",
    "secure-down-arrow",
    "secure-space",
    "secure-evidence-finalized"
  ].map((step) => ({ step, verified: true, issueCodes: [] }));
  const embeddedManifest = {
    schemaVersion: 1,
    recordType: "lekh-imk-build-provenance",
    gitRevision: repositoryState.revision,
    gitTree: repositoryState.tree,
    sourceFilesClean: true,
    shortVersion: "0.1.0",
    buildNumber: "165",
    architectures: ["arm64", "x86_64"],
    packagingScriptSha256: digest(packagingScript)
  };
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-macos-imk-host-secure-field.mjs",
    suite: "macos-imk-host-secure-field",
    durationMs: 1_234,
    status: "passed",
    hostFramework: "AppKit",
    hostControl: "NSSecureTextField",
    appBundle: "/Users/test/Library/Input Methods/Lekh Keyboard.app",
    failures: [],
    bundleIdentity: {
      bundlePath: "/Users/test/Library/Input Methods/Lekh Keyboard.app",
      executablePath: "/Users/test/Library/Input Methods/Lekh Keyboard.app/Contents/MacOS/LekhInputMethodApp",
      bundleIdentifier: LEKH_BUNDLE_IDENTIFIER,
      connectionName: LEKH_CONNECTION_NAME,
      shortVersion: "0.1.0",
      buildVersion: "165",
      executableSha256: "e".repeat(64),
      codeDirectoryHash: "f".repeat(40),
      architecture: "arm64",
      macOS: "26.0"
    },
    artifactProvenance: {
      schemaVersion: 1,
      provenanceAssurance: "local-unattested",
      sourceToBinaryAttested: false,
      artifactIntegrityVerified: true,
      embeddedSourceRevision: repositoryState.revision,
      evidenceRevisionMatches: true,
      installedExecutableSha256: "e".repeat(64),
      runningExecutableSha256: "e".repeat(64),
      executableHashesMatch: true,
      installedCodeDirectoryHash: "f".repeat(40),
      runningCodeDirectoryHash: "f".repeat(40),
      codeDirectoryHashesMatch: true,
      installedBuildVersion: "165",
      runningBuildVersion: "165",
      buildVersionsMatch: true,
      embeddedManifest,
      embeddedManifestSha256: digest(`${JSON.stringify(embeddedManifest, null, 2)}\n`),
      embeddedManifestIntegrityVerified: true
    },
    automation: {
      status: 0,
      eligible: true,
      accessibilityTrusted: true,
      eventPostAccess: true,
      eventListenAccess: false,
      eventListenAccessRequired: false,
      stderr: ""
    },
    runtime: {
      exactInstalledRuntimeVerified: true,
      issues: [],
      processIdentifier: 4242,
      bundleVersionMatches: true,
      executablePathMatches: true
    },
    evidenceProvenance: {
      schemaVersion: 1,
      gitRevision: repositoryState.revision,
      sourceFilesClean: true,
      sourceStatusReadable: true,
      sources: SECURE_FIELD_EVIDENCE_SOURCE_PATHS.map((path) => ({
        path,
        sha256: sourceHashes[path]
      }))
    },
    recovery: {
      startup: { status: "no-recovery-required", cleanupEvidence: null },
      guardian: {
        status: "completed",
        disposition: "normal-completion",
        processIdentifier: 4243,
        exitCode: 0,
        signal: null
      }
    },
    cleanup,
    privacy: {
      rawPayloadIncluded: false,
      candidateTextIncluded: false,
      databaseRowsIncluded: false,
      databaseDigestIncluded: false,
      logLinesIncluded: false,
      secureAXValueRead: false,
      eventTapInstalled: false,
      syntheticCanaryAbsentFromSerializedReport: true
    },
    host: {
      bundleIdentifier: "com.lekh.qa.SecureFieldHost",
      freshProcessVerified: true,
      calibrationDelivered: true,
      expectedUTF16Length: 9
    },
    secureInput: {
      baselineEnabled: false,
      enabledDuringFocusedEntry: true,
      causalFalseToTrueTransition: true,
      sourceIdentifierDuringSecureEntry: "com.apple.keylayout.ABC",
      sourceWasASCIICapable: true,
      sourceWasEnabled: true,
      sourceCategory: "TISCategoryKeyboardInputSource",
      sourceType: "TISTypeKeyboardLayout",
      sourceCategoryValid: true,
      sourceTypeValid: true,
      sourceStableThroughEntry: true,
      sourceSampleCount: 10,
      liveControllerCallbackAttributed: false,
      controllerAttributionNote: "macOS visibly substituted an ASCII-capable keyboard source for secure entry.",
      protectionPath: "macos-ascii-source-substitution",
      osInputSourceSubstitutionObserved: true
    },
    assertions: {
      rawHostResultMatched: true,
      secureInputRouteObserved: true,
      secureInputRouteStable: true,
      noMarkedText: true,
      noVisibleLekhCandidateOrGhostSurface: true,
      personalizationPreferenceRequested: true,
      writerDrainStable: true,
      runtimeGhostEvidenceUnchanged: true,
      runtimeHealthFileUnchanged: true,
      database: {
        ready: true,
        rowCountDelta: 0,
        frequencyDelta: 0,
        lastUsedEqual: true,
        canonicalDigestEqual: true,
        equal: true
      },
      unifiedLog: {
        reliable: true,
        eventCount: 0,
        malformedEventCount: 0,
        summaryRecordCount: 1,
        surfaceEventCount: 0,
        syntheticInputMentioned: false
      },
      metricLog: {
        reliable: true,
        appendedLineCount: 0,
        appendedByteCount: 0,
        appendedPayloadContainsSyntheticInput: false
      }
    },
    runtimeEpoch: {
      originalProcessIdentifier: 4242,
      executablePathPinned: true,
      processStartTokenPinned: true,
      stable: true,
      checkpoints
    }
  };
  const currentInstalledContext = {
    ready: true,
    issueCodes: [],
    repository: repositoryState,
    bundleIdentity: {
      bundleIdentifier: LEKH_BUNDLE_IDENTIFIER,
      shortVersion: "0.1.0",
      buildVersion: "165",
      sourceRevision: repositoryState.revision,
      sourceTree: repositoryState.tree,
      connectionName: LEKH_CONNECTION_NAME,
      executableSha256: "e".repeat(64),
      codeDirectoryHash: "f".repeat(40),
      buildProvenanceSha256: report.artifactProvenance.embeddedManifestSha256
    }
  };
  mkdirSync(join(root, "reports"), { recursive: true });
  const secureReportBytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(root, "reports", "macos-imk-host-secure-field.json"), secureReportBytes);
  const packageReport = {
    status: "passed-developer-id-ready",
    signingClassification: "developer-id-ready",
    productionSigningRequired: false,
    executableSha256: report.bundleIdentity.executableSha256,
    codeDirectoryHash: report.bundleIdentity.codeDirectoryHash,
    buildProvenance: {
      gitRevision: repositoryState.revision,
      gitTree: repositoryState.tree,
      sourceFilesClean: true
    }
  };
  const packageReportBytes = `${JSON.stringify(packageReport, null, 2)}\n`;
  writeFileSync(join(root, "reports", "macos-imk-dev-package-report.json"), packageReportBytes);
  const trustedBuildAttestation = {
    verified: true,
    gitRevision: repositoryState.revision,
    gitTree: repositoryState.tree,
    executableSha256: report.bundleIdentity.executableSha256,
    codeDirectoryHash: report.bundleIdentity.codeDirectoryHash,
    signingClassification: "developer-id-ready"
  };
  return {
    root,
    report,
    repositoryState,
    currentInstalledContext,
    trustedBuildAttestation
  };
}

describe("strict macOS IMK QA evidence validation", () => {
  it("accepts only an exact current manual-evidence schema", () => {
    const fixture = manualFixture();
    const options = {
      root: fixture.root,
      expectedApp: "TextEdit",
      expectedCase: "space-commit",
      expectedTarget: "macOS 26 Apple Silicon",
      evidencePath: join(fixture.root, "reports", "qa", "macos-imk", "textedit", "space-commit.run.json"),
      context: fixture.context
    };
    expect(validateManualHostEvidence(fixture.evidence, options)).toEqual({ valid: true, issueCodes: [] });

    const attacks = [
      ["wrong app", (evidence) => { evidence.app = "Notes"; }, "manual.app-mismatch"],
      ["wrong case", (evidence) => { evidence.case = "enter-commit"; }, "manual.case-mismatch"],
      ["missing steps", (evidence) => { evidence.steps = []; }, "manual.steps-missing"],
      ["unattested artifact", (evidence) => { evidence.artifacts[0].sha256 = "f".repeat(64); }, "manual.artifact-unverified"],
      ["wrong input source", (evidence) => { evidence.inputSource = "com.apple.keylayout.ABC"; }, "manual.input-source-mismatch"],
      ["stale binary", (evidence) => { evidence.bundleIdentity.buildVersion = "164"; }, "manual.bundle-identity-buildVersion-mismatch"],
      ["stale revision", (evidence) => { evidence.provenance.gitRevision = "0".repeat(40); }, "manual.provenance-revision-stale"],
      ["extra schema field", (evidence) => { evidence.unreviewed = true; }, "manual.schema-fields-invalid"]
    ];
    for (const [label, mutate, expectedIssue] of attacks) {
      const evidence = structuredClone(fixture.evidence);
      mutate(evidence);
      const validation = validateManualHostEvidence(evidence, options);
      expect(validation.valid, label).toBe(false);
      expect(validation.issueCodes, label).toContain(expectedIssue);
    }
  });

  it("uses one strict, content-free secure validator for complete evidence", () => {
    const { root, report, repositoryState, currentInstalledContext } = secureFixture();
    const options = {
      root,
      repositoryState,
      fullRepositoryState: repositoryState,
      currentInstalledContext
    };
    expect(validateSecureFieldHostEvidence(report, options)).toEqual({
      valid: true,
      trustedSourceToBinaryAttested: false,
      issueCodes: []
    });

    const productionResult = validateSecureFieldHostEvidence(report, {
      ...options,
      requireTrustedSourceToBinaryAttestation: true
    });
    expect(productionResult.valid).toBe(false);
    expect(productionResult.issueCodes).toContain(
      "secure.trusted-source-to-binary-attestation-required"
    );

    const trusted = secureFixture();
    const trustedProductionResult = validateSecureFieldHostEvidence(trusted.report, {
      root: trusted.root,
      repositoryState: trusted.repositoryState,
      fullRepositoryState: trusted.repositoryState,
      currentInstalledContext: trusted.currentInstalledContext,
      requireTrustedSourceToBinaryAttestation: true,
      trustedBuildAttestation: trusted.trustedBuildAttestation
    });
    expect(trustedProductionResult.valid).toBe(false);
    expect(trustedProductionResult.trustedSourceToBinaryAttested).toBe(false);
    expect(trustedProductionResult.issueCodes).toContain(
      "secure.trusted-source-to-binary-attestation-required"
    );
    const forgedExecutable = structuredClone(trusted.trustedBuildAttestation);
    forgedExecutable.executableSha256 = "0".repeat(64);
    const forgedExecutableResult = validateSecureFieldHostEvidence(trusted.report, {
      root: trusted.root,
      repositoryState: trusted.repositoryState,
      fullRepositoryState: trusted.repositoryState,
      currentInstalledContext: trusted.currentInstalledContext,
      requireTrustedSourceToBinaryAttestation: true,
      trustedBuildAttestation: forgedExecutable
    });
    expect(forgedExecutableResult.valid).toBe(false);
    expect(forgedExecutableResult.trustedSourceToBinaryAttested).toBe(false);

    const stale = structuredClone(report);
    stale.evidenceProvenance.gitRevision = "0".repeat(40);
    const staleResult = validateSecureFieldHostEvidence(stale, options);
    expect(staleResult.valid).toBe(false);
    expect(staleResult.issueCodes).toContain("secure.provenance-stale-or-invalid");

    const artifactAttacks = [
      (value) => { value.artifactProvenance.embeddedManifest.sourceFilesClean = false; },
      (value) => { value.artifactProvenance.runningCodeDirectoryHash = "0".repeat(40); },
      (value) => { value.artifactProvenance.unreviewed = true; }
    ];
    for (const mutate of artifactAttacks) {
      const attacked = structuredClone(report);
      mutate(attacked);
      const attackedResult = validateSecureFieldHostEvidence(attacked, options);
      expect(attackedResult.valid).toBe(false);
      expect(attackedResult.issueCodes).toContain("secure.local-artifact-integrity-invalid");
    }

    const forgedAttestationLabel = structuredClone(report);
    forgedAttestationLabel.artifactProvenance.provenanceAssurance = "trusted-attested";
    forgedAttestationLabel.artifactProvenance.sourceToBinaryAttested = true;
    const forgedAttestationResult = validateSecureFieldHostEvidence(forgedAttestationLabel, {
      ...options,
      requireTrustedSourceToBinaryAttestation: true
    });
    expect(forgedAttestationResult.valid).toBe(false);
    expect(forgedAttestationResult.issueCodes).toContain("secure.local-artifact-integrity-invalid");
    expect(forgedAttestationResult.issueCodes).toContain(
      "secure.trusted-source-to-binary-attestation-required"
    );

    const extraTopLevel = structuredClone(report);
    extraTopLevel.unreviewed = true;
    const extraTopLevelResult = validateSecureFieldHostEvidence(extraTopLevel, options);
    expect(extraTopLevelResult.valid).toBe(false);
    expect(extraTopLevelResult.issueCodes).toContain("secure.closed-schema-invalid");

    const extraNested = structuredClone(report);
    extraNested.assertions.unreviewed = true;
    const extraNestedResult = validateSecureFieldHostEvidence(extraNested, options);
    expect(extraNestedResult.valid).toBe(false);
    expect(extraNestedResult.issueCodes).toContain("secure.closed-schema-invalid");

    const encodedCanary = structuredClone(report);
    encodedCanary.bundleIdentity.macOS = Buffer.from("swasthya", "utf8").toString("base64");
    const encodedCanaryResult = validateSecureFieldHostEvidence(encodedCanary, options);
    expect(encodedCanaryResult.valid).toBe(false);
    expect(encodedCanaryResult.issueCodes).toContain("secure.synthetic-canary-present");

    const weaker = structuredClone(report);
    weaker.assertions.metricLog.reliable = false;
    delete weaker.privacy.secureAXValueRead;
    weaker.secureInput.sourceSampleCount = 9;
    const weakerResult = validateSecureFieldHostEvidence(weaker, options);
    expect(weakerResult.valid).toBe(false);
    expect(weakerResult.issueCodes).toContain("secure.metric-log-evidence-invalid");
    expect(weakerResult.issueCodes).toContain("secure.privacy-secureAXValueRead-invalid");
    expect(weakerResult.issueCodes).toContain("secure.atomic-route-samples-invalid");
    expect(JSON.stringify(weakerResult)).not.toContain("fixed synthetic");

    const unpinnedProcessEpoch = structuredClone(report);
    unpinnedProcessEpoch.runtimeEpoch.executablePathPinned = false;
    unpinnedProcessEpoch.runtimeEpoch.processStartTokenPinned = false;
    const unpinnedResult = validateSecureFieldHostEvidence(unpinnedProcessEpoch, options);
    expect(unpinnedResult.valid).toBe(false);
    expect(unpinnedResult.issueCodes).toContain("secure.runtime-epoch-executable-unpinned");
    expect(unpinnedResult.issueCodes).toContain("secure.runtime-epoch-start-token-unpinned");
  });

  it("graduates production only when the strict matrix has no missing rows", () => {
    expect(macOSQAMatrixStatus({ production: true, missingCount: 1 })).toBe("failed-production-missing-host-evidence");
    expect(macOSQAMatrixStatus({ production: true, missingCount: 0 })).toBe("passed-production");
    expect(macOSQAMatrixStatus({ production: false, missingCount: 1 })).toBe("passed-dev-matrix-defined");
    expect(macOSQAMatrixStatus({ production: false, missingCount: 0 })).toBe("passed-dev-matrix-complete");
    expect(macOSQAMatrixStatus({ production: true, missingCount: -1 })).toBe("failed-invalid-evidence-count");
  });

  it("never lets generic manual JSON replace the specialized production password-field proof", () => {
    expect(manualHostEvidenceAllowedForMatrix({
      production: true,
      app: "Password Fields",
      testCase: "secure-field-no-memory"
    })).toBe(false);
    expect(manualHostEvidenceAllowedForMatrix({
      production: false,
      app: "Password Fields",
      testCase: "secure-field-no-memory"
    })).toBe(true);
    expect(manualHostEvidenceAllowedForMatrix({
      production: true,
      app: "TextEdit",
      testCase: "space-commit"
    })).toBe(true);
  });
});
