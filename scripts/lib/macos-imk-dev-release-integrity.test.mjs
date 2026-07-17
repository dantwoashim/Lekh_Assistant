import { describe, expect, it } from "vitest";
import {
  classifyMacOSCodeSigning,
  MACOS_GENERATED_RELEASE_PATHS,
  macOSSourceStatusArguments,
  validateClosedBuildProvenance,
  validateMacOSIMKDevArtifactEvidence
} from "./macos-imk-dev-release-integrity.mjs";

const hash = "a".repeat(64);
const revision = "b".repeat(40);
const tree = "c".repeat(40);
const manifest = Object.freeze({
  schemaVersion: 1,
  recordType: "lekh-imk-build-provenance",
  gitRevision: revision,
  gitTree: tree,
  sourceFilesClean: true,
  shortVersion: "0.1.0",
  buildNumber: "42",
  architectures: ["arm64", "x86_64"],
  packagingScriptSha256: hash
});

const developerIDText = `Executable=/tmp/LekhInputMethodApp
Identifier=com.lekh.inputmethod.LekhKeyboard
CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+3 location=embedded
Signature size=9000
Authority=Developer ID Application: Lekh Keyboard LLC (ABCDEFGHIJ)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDEFGHIJ
Timestamp=15 Jul 2026 at 10:20:30
CDHash=${"d".repeat(40)}
`;

function validEvidence(overrides = {}) {
  const signingEvidence = classifyMacOSCodeSigning(developerIDText);
  return {
    manifest,
    manifestSha256: hash,
    packageReport: {
      command: "npm run package:macos:imk:dev",
      suite: "macos-imk-dev-package",
      status: "passed-developer-id-ready",
      artifact: "/tmp/source.imkdevbundle",
      buildProvenance: manifest,
      buildProvenanceSha256: hash,
      executableSha256: hash,
      codeDirectoryHash: "d".repeat(40),
      signingClassification: "developer-id-ready",
      productionSigningRequired: false
    },
    currentGitRevision: revision,
    currentGitTree: tree,
    currentSourceClean: true,
    packagingScriptSha256: hash,
    expectedReportArtifact: "/tmp/source.imkdevbundle",
    executableSha256: hash,
    codeDirectoryHash: "d".repeat(40),
    signingEvidence,
    ...overrides
  };
}

describe("macOS IMK dev release integrity", () => {
  it("excludes only generated macOS distribution outputs from source cleanliness", () => {
    expect(MACOS_GENERATED_RELEASE_PATHS).toEqual([
      "release/native/macos/**",
      "public/updates/macos/**"
    ]);
    expect(macOSSourceStatusArguments()).toEqual([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)release/native/macos/**",
      ":(exclude)public/updates/macos/**"
    ]);
    expect(() => macOSSourceStatusArguments({ untrackedFiles: "unsafe" }))
      .toThrow(/Unsupported Git untracked-files policy/u);
  });

  it("accepts only the closed build provenance schema and current source identity", () => {
    expect(validateClosedBuildProvenance(manifest, {
      gitRevision: revision,
      gitTree: tree,
      packagingScriptSha256: hash
    })).toEqual([]);
    expect(validateClosedBuildProvenance({ ...manifest, untrusted: true })).toContain(
      "build-provenance-schema-not-closed"
    );
    expect(validateClosedBuildProvenance(manifest, { gitRevision: "e".repeat(40) })).toContain(
      "build-provenance-not-current-head"
    );
    expect(validateClosedBuildProvenance(manifest, { gitTree: "f".repeat(40) })).toContain(
      "build-provenance-not-current-tree"
    );
  });

  it("classifies only an exact Developer ID Application chain with runtime and timestamp as ready", () => {
    expect(classifyMacOSCodeSigning(developerIDText)).toMatchObject({
      classification: "developer-id-ready",
      developerIDReady: true,
      productionSigningRequired: false,
      teamIdentifier: "ABCDEFGHIJ"
    });
    expect(classifyMacOSCodeSigning(developerIDText.replace("Timestamp=15 Jul 2026 at 10:20:30", "Timestamp=none")))
      .toMatchObject({ classification: "development-signed", productionSigningRequired: true });
    expect(classifyMacOSCodeSigning(developerIDText.replace("Developer ID Application", "Apple Development")))
      .toMatchObject({ classification: "development-signed", productionSigningRequired: true });
    expect(classifyMacOSCodeSigning(developerIDText.replace("flags=0x10000(runtime)", "flags=0x0(none)")))
      .toMatchObject({ classification: "development-signed", productionSigningRequired: true });
    expect(classifyMacOSCodeSigning(`CodeDirectory flags=0x10002(adhoc,runtime)\nSignature=adhoc\nTimestamp=none\n`))
      .toMatchObject({ classification: "ad-hoc-development", productionSigningRequired: true });
  });

  it("binds success to report, manifest, executable hash, CDHash, and signing evidence", () => {
    expect(validateMacOSIMKDevArtifactEvidence(validEvidence())).toEqual([]);
    expect(validateMacOSIMKDevArtifactEvidence(validEvidence({ currentSourceClean: false })))
      .toContain("current-source-not-clean");
    expect(validateMacOSIMKDevArtifactEvidence(validEvidence({ executableSha256: "e".repeat(64) })))
      .toContain("package-report-executable-hash-mismatch");
    expect(validateMacOSIMKDevArtifactEvidence(validEvidence({ codeDirectoryHash: "f".repeat(40) })))
      .toContain("package-report-code-directory-hash-mismatch");
    const failed = validEvidence();
    failed.packageReport = { ...failed.packageReport, status: "failed" };
    expect(validateMacOSIMKDevArtifactEvidence(failed))
      .toContain("package-report-not-successful-for-signing-class");
  });
});
