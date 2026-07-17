import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isTrustedProductionIMKBuildAttestation,
  inspectProductionIMKInstallerArchive,
  PRODUCTION_ATTESTATION_PREDICATE,
  PRODUCTION_ATTESTATION_REPOSITORY,
  PRODUCTION_ATTESTED_ARTIFACT_ROLES,
  PRODUCTION_ATTESTED_REPORT_PATHS,
  PRODUCTION_QA_EVIDENCE_INDEX_PATH,
  readProductionReleasePolicy,
  validateProductionQAEvidenceIndex,
  validateProductionReleaseEvidenceManifest,
  verifiedAttestationOutputBindsSubject,
  verifyProductionIMKBuildAttestation
} from "./macos-production-release-attestation.mjs";
import {
  canonicalMacOSQATuples,
  MACOS_IMK_QA_MATRIX_POLICY_PATH,
  readCanonicalMacOSQAMatrixPolicy
} from "./macos-imk-qa-matrix-policy.mjs";

const roots = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = "a".repeat(40);
const tree = "b".repeat(40);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeFixture(root, path, bytes) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), bytes);
  return {
    path,
    sha256: digest(bytes),
    sizeBytes: statSync(join(root, path)).size
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lekh-production-attestation-"));
  roots.push(root);
  writeFixture(
    root,
    MACOS_IMK_QA_MATRIX_POLICY_PATH,
    readFileSync(join(process.cwd(), MACOS_IMK_QA_MATRIX_POLICY_PATH))
  );
  const matrixPolicy = readCanonicalMacOSQAMatrixPolicy(root);
  expect(matrixPolicy.valid).toBe(true);
  const reports = PRODUCTION_ATTESTED_REPORT_PATHS.map((path) =>
    writeFixture(root, path, Buffer.from(`${path}\n`, "utf8"))
  );
  const artifactPaths = {
    "coreml-model-archive": "release/attestation/LekhNeuralTransliterator.mlmodelc.zip",
    "coreml-model-manifest": "release/attestation/LekhNeuralTransliterator.manifest.json",
    "dictionary-pack-release-index": "release/attestation/dictionary-packs.index.v1.json",
    "macos-companion-dmg": "release/Lekh-Keyboard-Companion-1.2.3.dmg",
    "macos-installer-zip": "release/native/macos/Lekh-Keyboard-Test-Installer.zip",
    "release-manifest": "release/native/macos/RELEASE-MANIFEST.json",
    "release-manifest-signature": "release/native/macos/RELEASE-MANIFEST.json.minisig",
    "sbom-spdx": "release/attestation/lekh-release.spdx.json",
    "update-appcast": "release/native/macos/appcast.xml"
  };
  const artifacts = PRODUCTION_ATTESTED_ARTIFACT_ROLES.map((role) => ({
    role,
    ...writeFixture(root, artifactPaths[role], Buffer.from(`${role}\n`, "utf8"))
  }));
  const installer = artifacts.find(({ role }) => role === "macos-installer-zip");
  const executableSha256 = "c".repeat(64);
  const codeDirectoryHash = "d".repeat(40);
  const buildProvenanceSha256 = "e".repeat(64);
  const secureReport = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-macos-imk-host-secure-field.mjs",
    suite: "macos-imk-host-secure-field",
    durationMs: 1,
    hostFramework: "AppKit",
    hostControl: "NSSecureTextField",
    appBundle: "/Library/Input Methods/Lekh Keyboard.app",
    bundleIdentity: {
      bundlePath: "/Library/Input Methods/Lekh Keyboard.app",
      executablePath: "/Library/Input Methods/Lekh Keyboard.app/Contents/MacOS/LekhInputMethodApp",
      bundleIdentifier: "com.lekh.inputmethod.LekhKeyboard",
      shortVersion: "1.2.3",
      buildVersion: "42",
      connectionName: "com.lekh.inputmethod.LekhKeyboard_Connection",
      macOS: "26.0",
      architecture: "arm64",
      executableSha256,
      codeDirectoryHash
    },
    automation: {
      status: 0,
      eligible: true,
      accessibilityTrusted: true,
      eventPostAccess: true,
      eventListenAccess: true,
      eventListenAccessRequired: false,
      stderr: ""
    },
    runtime: {
      exactInstalledRuntimeVerified: true,
      issues: [],
      processIdentifier: 42,
      bundleVersionMatches: true,
      executablePathMatches: true
    },
    artifactProvenance: { embeddedSourceRevision: revision },
    evidenceProvenance: {
      schemaVersion: 1,
      gitRevision: revision,
      sourceFilesClean: true,
      sourceStatusReadable: true,
      sources: []
    },
    recovery: {
      startup: { status: "no-recovery-required", cleanupEvidence: null },
      guardian: {
        status: "completed",
        disposition: "normal-completion",
        processIdentifier: 43,
        exitCode: 0,
        signal: null
      }
    },
    failures: [],
    cleanup: {
      hostTerminated: true,
      inputSourceRestored: true,
      preferencesRestored: true,
      secureInputReturnedToBaseline: true,
      temporaryHostRemoved: true
    },
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
      sourceCategory: "Keyboard Input Source",
      sourceType: "Keyboard Layout",
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
      database: {
        ready: true,
        rowCountDelta: 0,
        frequencyDelta: 0,
        lastUsedEqual: true,
        canonicalDigestEqual: true,
        equal: true
      },
      writerDrainStable: true,
      runtimeGhostEvidenceUnchanged: true,
      runtimeHealthFileUnchanged: true,
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
      originalProcessIdentifier: 42,
      executablePathPinned: true,
      processStartTokenPinned: true,
      stable: true,
      checkpoints: []
    },
    status: "passed"
  };
  const entries = canonicalMacOSQATuples(matrixPolicy.policy).map((tuple, index) => {
    if (tuple.app === "Password Fields" && tuple.case === "secure-field-no-memory") {
      const major = /^macOS (\d+)/u.exec(tuple.target)[1];
      const targetReport = {
        ...secureReport,
        bundleIdentity: {
          ...secureReport.bundleIdentity,
          macOS: `${major}.0`,
          architecture: tuple.target.endsWith("Intel") ? "x86_64" : "arm64"
        }
      };
      const evidencePath = tuple.target === "macOS 26 Apple Silicon"
        ? "reports/macos-imk-host-secure-field.json"
        : `reports/qa/macos-imk/password-fields/secure-field-no-memory.${index}.json`;
      const secureIndexedEvidence = writeFixture(
        root,
        evidencePath,
        Buffer.from(`${JSON.stringify(targetReport, null, 2)}\n`, "utf8")
      );
      if (evidencePath === "reports/macos-imk-host-secure-field.json") {
        const secureReportIndex = reports.findIndex(({ path }) => path === evidencePath);
        reports[secureReportIndex] = secureIndexedEvidence;
      }
      return { ...tuple, evidence: [{ ...secureIndexedEvidence, artifacts: [] }] };
    }
    const caseSlug = tuple.case;
    const appSlug = tuple.app.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const artifact = writeFixture(
      root,
      `reports/qa/macos-imk/${appSlug}/artifacts/${caseSlug}.${index}.txt`,
      Buffer.from(`host-evidence-artifact-${index}\n`, "utf8")
    );
    const major = /^macOS (\d+)/u.exec(tuple.target)[1];
    const manual = {
      schemaVersion: 1,
      suite: "macos-imk-manual-host-evidence",
      generatedAt: new Date().toISOString(),
      target: tuple.target,
      app: tuple.app,
      case: tuple.case,
      macOSVersion: `${major}.0`,
      architecture: tuple.target.endsWith("Intel") ? "x86_64" : "arm64",
      inputSource: "com.lekh.inputmethod.LekhKeyboard.Main",
      bundleIdentity: {
        bundleIdentifier: "com.lekh.inputmethod.LekhKeyboard",
        shortVersion: "1.2.3",
        buildVersion: "42",
        sourceRevision: revision,
        sourceTree: tree,
        connectionName: "com.lekh.inputmethod.LekhKeyboard_Connection",
        executableSha256,
        codeDirectoryHash,
        buildProvenanceSha256
      },
      steps: [{ action: "type", expected: "passed", actual: "passed", pass: true }],
      expected: "passed",
      actual: "passed",
      pass: true,
      artifacts: [{ kind: "text", path: artifact.path, sha256: artifact.sha256 }],
      logPaths: [],
      provenance: {
        schemaVersion: 1,
        gitRevision: revision,
        worktreeClean: true,
        installedSourceRevision: revision,
        installedSourceTree: tree,
        installedBuildProvenanceSha256: buildProvenanceSha256,
        installedExecutableSha256: executableSha256,
        installedBuildVersion: "42"
      }
    };
    const indexedEvidence = writeFixture(
      root,
      `reports/qa/macos-imk/${appSlug}/${caseSlug}.${index}.json`,
      Buffer.from(`${JSON.stringify(manual, null, 2)}\n`, "utf8")
    );
    return { ...tuple, evidence: [{ ...indexedEvidence, artifacts: [artifact] }] };
  });
  const evidenceRecord = {
    schemaVersion: 1,
    recordType: "lekh-macos-imk-qa-evidence-index",
    generatedAt: new Date().toISOString(),
    sourceRevision: revision,
    sourceTree: tree,
    matrixPolicySha256: matrixPolicy.sha256,
    installerZipSha256: installer.sha256,
    expectedEntryCount: matrixPolicy.policy.expectedEntryCount,
    entries,
    issues: []
  };
  const evidence = writeFixture(
    root,
    PRODUCTION_QA_EVIDENCE_INDEX_PATH,
    Buffer.from(`${JSON.stringify(evidenceRecord, null, 2)}\n`, "utf8")
  );
  const qaReportIndex = reports.findIndex(({ path }) => path === "reports/macos-imk-qa-matrix-report.json");
  reports[qaReportIndex] = writeFixture(
    root,
    "reports/macos-imk-qa-matrix-report.json",
    Buffer.from(`${JSON.stringify({
      status: "passed-production",
      matrixPolicy: {
        path: matrixPolicy.path,
        sha256: matrixPolicy.sha256,
        tupleOrdering: matrixPolicy.policy.tupleOrdering,
        evidenceReusePolicy: matrixPolicy.policy.evidenceReusePolicy
      },
      evidenceIndex: { ...evidence, entryCount: entries.length, issueCodes: [] }
    }, null, 2)}\n`, "utf8")
  );
  const manifest = {
    schemaVersion: 1,
    recordType: "lekh-production-release-evidence",
    release: {
      version: "1.2.3",
      buildNumber: "42",
      runIdentifier: "123e4567-e89b-42d3-a456-426614174000",
      generatedAt: new Date().toISOString(),
      repository: PRODUCTION_ATTESTATION_REPOSITORY,
      sourceRevision: revision,
      sourceTree: tree,
      sourceRef: "refs/tags/v1.2.3"
    },
    reports,
    artifacts,
    evidenceIndex: { ...evidence, entryCount: entries.length }
  };
  return { root, manifest, evidenceRecord, installer };
}

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: "pipe" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function writeApp(path, identifier, executableName, executableBytes = "#!/bin/sh\nexit 0\n") {
  mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(path, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(path, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${executableName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>42</string>
</dict></plist>
`);
  const executable = join(path, "Contents", "MacOS", executableName);
  if (Buffer.isBuffer(executableBytes)) writeFileSync(executable, executableBytes);
  else writeFileSync(executable, executableBytes);
  chmodSync(executable, 0o755);
}

function tamperedInstallerArchive(root) {
  const folder = join(root, "Lekh Keyboard Test Installer");
  const installer = join(folder, "Lekh Keyboard Test Installer.app");
  const uninstaller = join(folder, "Lekh Keyboard Uninstaller.app");
  const imk = join(installer, "Contents", "Resources", "Lekh Keyboard.app");
  writeApp(installer, "com.lekh.inputmethod.Installer", "install-lekh-keyboard");
  writeApp(uninstaller, "com.lekh.inputmethod.Uninstaller", "uninstall-lekh-keyboard");
  writeApp(
    imk,
    "com.lekh.inputmethod.LekhKeyboard",
    "LekhInputMethodApp",
    readFileSync("/usr/bin/true")
  );
  const helperNames = [
    "atomic-install-swap",
    "purge-lekh-input-sources",
    "register-lekh-input-source",
    "restore-system-keyboard",
    "terminate-exact-processes"
  ];
  for (const app of [installer, uninstaller]) {
    for (const name of helperNames) {
      const helper = join(app, "Contents", "Resources", name);
      copyFileSync("/usr/bin/true", helper);
      chmodSync(helper, 0o755);
      run("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", helper]);
    }
  }
  run("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", imk]);
  run("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", installer]);
  run("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp=none", "--sign", "-", uninstaller]);
  writeFileSync(join(imk, "Contents", "Resources", "tampered-after-signing.txt"), "tampered\n");
  const zipPath = join(root, "tampered.zip");
  run("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", "--noacl", folder, zipPath]);
  return zipPath;
}

describe("production release attestation policy", () => {
  it("accepts only a closed, complete raw-evidence and shipped-artifact manifest", () => {
    const { root, manifest, evidenceRecord, installer } = fixture();
    const options = {
      root,
      currentRevision: revision,
      currentTree: tree,
      currentSourceRef: "refs/tags/v1.2.3",
      currentVersion: "1.2.3"
    };
    const baseline = validateProductionReleaseEvidenceManifest(manifest, options);
    expect(baseline.issueCodes).toEqual([]);
    expect(baseline.valid).toBe(true);

    const fabricatedCoverage = structuredClone(evidenceRecord);
    fabricatedCoverage.entries = fabricatedCoverage.entries.map((entry, index) => ({
      ...entry,
      target: `target-${index}`
    }));
    expect(validateProductionQAEvidenceIndex(fabricatedCoverage, {
      root,
      sourceRevision: revision,
      sourceTree: tree,
      installerZipSha256: installer.sha256
    }).issueCodes).toContain("evidence-index.canonical-tuple-set-or-order-invalid");

    const reusedEvidence = structuredClone(evidenceRecord);
    reusedEvidence.entries[1].evidence = structuredClone(reusedEvidence.entries[0].evidence);
    expect(validateProductionQAEvidenceIndex(reusedEvidence, {
      root,
      sourceRevision: revision,
      sourceTree: tree,
      installerZipSha256: installer.sha256
    }).issueCodes).toEqual(expect.arrayContaining([
      "evidence-index.evidence-reused-across-tuples",
      "evidence-index.artifact-reused-across-tuples"
    ]));

    const extraField = structuredClone(manifest);
    extraField.reports[0].unreviewed = true;
    expect(validateProductionReleaseEvidenceManifest(extraField, options).issueCodes)
      .toContain("attestation.report-entry-invalid");

    const changedEvidence = structuredClone(manifest);
    writeFileSync(join(root, PRODUCTION_QA_EVIDENCE_INDEX_PATH), "changed\n");
    expect(validateProductionReleaseEvidenceManifest(changedEvidence, options).issueCodes)
      .toContain("attestation.evidence-index-digest-mismatch");

    const duplicateArtifact = structuredClone(manifest);
    duplicateArtifact.artifacts[1].path = duplicateArtifact.artifacts[0].path;
    expect(validateProductionReleaseEvidenceManifest(duplicateArtifact, options).issueCodes)
      .toContain("attestation.artifact-entry-invalid");
  });

  it("requires a verified timestamp, SLSA predicate, and exact subject digest", () => {
    const expected = "c".repeat(64);
    const output = [{
      verificationResult: {
        verifiedTimestamps: [{ timestamp: new Date().toISOString() }],
        statement: {
          predicateType: PRODUCTION_ATTESTATION_PREDICATE,
          subject: [{ digest: { sha256: expected } }]
        }
      }
    }];
    expect(verifiedAttestationOutputBindsSubject(output, expected)).toBe(true);
    expect(verifiedAttestationOutputBindsSubject(output, "d".repeat(64))).toBe(false);
    const noTimestamp = structuredClone(output);
    noTimestamp[0].verificationResult.verifiedTimestamps = [];
    expect(verifiedAttestationOutputBindsSubject(noTimestamp, expected)).toBe(false);
  });

  it("cannot turn a plain object or injected fake command into a trusted build proof", () => {
    expect(isTrustedProductionIMKBuildAttestation({
      verified: true,
      executableSha256: "e".repeat(64)
    })).toBe(false);
    const source = readFileSync(join(process.cwd(), "scripts", "lib", "macos-production-release-attestation.mjs"), "utf8");
    expect(source).not.toContain("runCommand =");
    expect(source).not.toContain('ghPath =');
    expect(source).not.toContain(' : "gh"');

    const result = verifyProductionIMKBuildAttestation({
      root: process.cwd(),
      runCommand: () => ({ status: 0, stdout: "[]", stderr: "" }),
      ghPath: "/tmp/counterfeit-gh"
    });
    expect(result.verified).toBe(false);
    expect(isTrustedProductionIMKBuildAttestation(result)).toBe(false);
  });

  it.runIf(process.platform === "darwin")("rejects symlink archive entries before extraction", () => {
    const root = mkdtempSync(join(tmpdir(), "lekh-production-archive-symlink-"));
    roots.push(root);
    const folder = join(root, "Lekh Keyboard Test Installer");
    mkdirSync(folder, { recursive: true });
    symlinkSync("/tmp", join(folder, "unsafe-link"));
    const zipPath = join(root, "unsafe.zip");
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", folder, zipPath]);
    const inspection = inspectProductionIMKInstallerArchive({
      root,
      zipPath,
      expectedTeamIdentifier: "ABCDE12345",
      expectedVersion: "1.2.3"
    });
    expect(inspection.valid).toBe(false);
    expect(inspection.issueCodes).toContain("attestation.imk-installer-archive-entry-kind-invalid");
  });

  it.runIf(process.platform === "darwin")("rejects a resource changed after the delivered bundle was signed", () => {
    const root = mkdtempSync(join(tmpdir(), "lekh-production-archive-tamper-"));
    roots.push(root);
    const inspection = inspectProductionIMKInstallerArchive({
      root,
      zipPath: tamperedInstallerArchive(root),
      expectedTeamIdentifier: "ABCDE12345",
      expectedVersion: "1.2.3"
    });
    expect(inspection.valid).toBe(false);
    expect(inspection.issueCodes).toContain("attestation.imk-installer-bundle-signature-invalid");
  });

  it("keeps production blocked until reviewed builder digests and Apple Team ID are committed", () => {
    const policy = readProductionReleasePolicy(process.cwd());
    expect(policy.valid).toBe(false);
    expect(policy.issueCodes).toEqual(expect.arrayContaining([
      "attestation.policy-imkBuildSignerDigest-unconfigured",
      "attestation.policy-releaseSignerDigest-unconfigured",
      "attestation.policy-apple-team-id-unconfigured",
      "attestation.policy-github-cli-arm64-unconfigured",
      "attestation.policy-github-cli-x86_64-unconfigured"
    ]));
  });
});
