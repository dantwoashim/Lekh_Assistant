import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { secureFieldHostEvidenceHasClosedSchema } from "./macos-imk-qa-indexed-evidence.mjs";
import { isTrustedProductionIMKBuildAttestation } from "./macos-production-release-attestation.mjs";

export const LEKH_INPUT_SOURCE_IDENTIFIER = "com.lekh.inputmethod.LekhKeyboard.Main";
export const LEKH_BUNDLE_IDENTIFIER = "com.lekh.inputmethod.LekhKeyboard";
export const LEKH_CONNECTION_NAME = "com.lekh.inputmethod.LekhKeyboard_Connection";
export const MANUAL_HOST_EVIDENCE_SCHEMA_VERSION = 1;
export const MANUAL_HOST_EVIDENCE_SUITE = "macos-imk-manual-host-evidence";

export const SECURE_FIELD_EVIDENCE_SOURCE_PATHS = Object.freeze([
  "scripts/check-macos-imk-host-secure-field.mjs",
  "scripts/lib/macos-imk-host-harness.mjs",
  "scripts/lib/macos-host-state-lease.mjs",
  "scripts/lib/macos-imk-qa-evidence-validator.mjs",
  "scripts/lib/macos-imk-qa-indexed-evidence.mjs",
  "scripts/lib/macos-secure-probe-recovery.mjs",
  "scripts/lib/macos-imk-build-identity.mjs",
  "scripts/macos-companion-publication-lock.swift",
  "scripts/package-macos-imk-dev.mjs",
  "native/macos-imk/qa-hosts/LekhSecureFieldHost/main.swift",
  "native/macos-imk/qa-hosts/LekhSecureFieldHost/Info.plist",
  "native/macos-imk/skeleton/LekhInputController.swift",
  "native/macos-imk/skeleton/LekhRuntimeHealth.swift"
]);

const manualEvidenceKeys = Object.freeze([
  "schemaVersion",
  "suite",
  "generatedAt",
  "target",
  "app",
  "case",
  "macOSVersion",
  "architecture",
  "inputSource",
  "bundleIdentity",
  "steps",
  "expected",
  "actual",
  "pass",
  "artifacts",
  "logPaths",
  "provenance"
]);

const manualBundleIdentityKeys = Object.freeze([
  "bundleIdentifier",
  "shortVersion",
  "buildVersion",
  "sourceRevision",
  "sourceTree",
  "connectionName",
  "executableSha256",
  "codeDirectoryHash",
  "buildProvenanceSha256"
]);

const manualProvenanceKeys = Object.freeze([
  "schemaVersion",
  "gitRevision",
  "worktreeClean",
  "installedSourceRevision",
  "installedSourceTree",
  "installedBuildProvenanceSha256",
  "installedExecutableSha256",
  "installedBuildVersion"
]);

const manualStepKeys = Object.freeze(["action", "expected", "actual", "pass"]);
const manualArtifactKeys = Object.freeze(["kind", "path", "sha256"]);
const artifactKinds = new Set(["screenshot", "video", "log", "json", "text"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitRevisionPattern = /^[a-f0-9]{40,64}$/u;
const fixedSyntheticCanary = "swasthya";
const fixedSyntheticExpected = `${fixedSyntheticCanary} `;
const secureProductionFileCapability = Symbol("secure-production-file-capability");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isNonemptyString(value, maximumLength = 16_384) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000]/u.test(value);
}

function validTimestamp(value) {
  if (!isNonemptyString(value, 128)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now() + 5 * 60_000;
}

function addIssue(issues, condition, code) {
  if (!condition) issues.push(code);
}

function uniqueIssues(issues) {
  return [...new Set(issues)];
}

function serializedSecureReportContainsCanary(report) {
  const serialized = JSON.stringify(report);
  const variants = [
    fixedSyntheticCanary,
    fixedSyntheticExpected,
    Buffer.from(fixedSyntheticCanary, "utf8").toString("base64"),
    Buffer.from(fixedSyntheticExpected, "utf8").toString("base64"),
    Buffer.from(fixedSyntheticCanary, "utf8").toString("hex"),
    Buffer.from(fixedSyntheticExpected, "utf8").toString("hex"),
    createHash("sha256").update(fixedSyntheticCanary, "utf8").digest("hex"),
    createHash("sha256").update(fixedSyntheticExpected, "utf8").digest("hex")
  ];
  return variants.some((variant) => serialized.includes(variant));
}

function command(commandPath, args, options = {}) {
  return spawnSync(commandPath, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options
  });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function captureRepositoryState(root, sourcePaths = null, { excludeEvidence = false } = {}) {
  const revision = command("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root });
  const tree = command("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], { cwd: root });
  const statusArguments = ["status", "--porcelain=v1", "--untracked-files=all"];
  if (Array.isArray(sourcePaths)) statusArguments.push("--", ...sourcePaths);
  else if (excludeEvidence) statusArguments.push("--", ".", ":(exclude)reports/**");
  const status = command("/usr/bin/git", statusArguments, { cwd: root });
  const sourceHashes = {};
  if (Array.isArray(sourcePaths)) {
    for (const path of sourcePaths) {
      const absolute = join(root, path);
      sourceHashes[path] = existsSync(absolute) ? sha256File(absolute) : null;
    }
  }
  return Object.freeze({
    readable: revision.status === 0 && tree.status === 0 && status.status === 0,
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    tree: tree.status === 0 ? tree.stdout.trim() : null,
    clean: status.status === 0 && status.stdout.trim() === "",
    sourceHashes: Object.freeze(sourceHashes)
  });
}

function plistValue(plistPath, key) {
  const read = command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  return read.status === 0 ? read.stdout.trim() : "";
}

export function captureManualHostEvidenceContext({
  root,
  appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app")
}) {
  const issues = [];
  const plistPath = join(appBundle, "Contents", "Info.plist");
  const executable = join(appBundle, "Contents", "MacOS", "LekhInputMethodApp");
  const provenancePath = join(appBundle, "Contents", "Resources", "LekhBuildProvenance.v1.json");
  let identity = null;
  try {
    addIssue(issues, existsSync(plistPath), "context.installed-plist-missing");
    addIssue(issues, existsSync(executable), "context.installed-executable-missing");
    addIssue(issues, existsSync(provenancePath), "context.installed-provenance-missing");
    if (issues.length === 0) {
      const executablePath = realpathSync(executable);
      const metadata = lstatSync(executablePath);
      addIssue(issues, metadata.isFile() && !metadata.isSymbolicLink(), "context.installed-executable-invalid");
      const signature = command("/usr/bin/codesign", ["-dvvv", executablePath]);
      const signatureVerification = command("/usr/bin/codesign", ["--verify", "--strict", appBundle]);
      const signatureOutput = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
      const codeDirectoryHash = /\bCDHash=([a-f0-9]{40,64})\b/iu.exec(signatureOutput)?.[1]?.toLowerCase() ?? "";
      const provenanceMetadata = lstatSync(provenancePath);
      addIssue(
        issues,
        provenanceMetadata.isFile() &&
          !provenanceMetadata.isSymbolicLink() &&
          provenanceMetadata.size > 0 &&
          provenanceMetadata.size <= 64 * 1024,
        "context.installed-provenance-invalid"
      );
      let buildProvenance = null;
      try {
        buildProvenance = JSON.parse(readFileSync(provenancePath, "utf8"));
      } catch {
        issues.push("context.installed-provenance-malformed");
      }
      const buildProvenanceValid = hasExactKeys(buildProvenance, [
        "schemaVersion", "recordType", "gitRevision", "gitTree", "sourceFilesClean",
        "shortVersion", "buildNumber", "architectures", "packagingScriptSha256"
      ]) &&
        buildProvenance.schemaVersion === 1 &&
        buildProvenance.recordType === "lekh-imk-build-provenance" &&
        gitRevisionPattern.test(buildProvenance.gitRevision ?? "") &&
        gitRevisionPattern.test(buildProvenance.gitTree ?? "") &&
        buildProvenance.sourceFilesClean === true &&
        isNonemptyString(buildProvenance.shortVersion, 128) &&
        isNonemptyString(buildProvenance.buildNumber, 128) &&
        Array.isArray(buildProvenance.architectures) &&
        buildProvenance.architectures.length > 0 &&
        buildProvenance.architectures.length <= 2 &&
        buildProvenance.architectures.every((architecture) => ["arm64", "x86_64"].includes(architecture)) &&
        new Set(buildProvenance.architectures).size === buildProvenance.architectures.length &&
        sha256Pattern.test(buildProvenance.packagingScriptSha256 ?? "");
      addIssue(issues, buildProvenanceValid, "context.installed-provenance-schema-invalid");
      identity = {
        bundleIdentifier: plistValue(plistPath, "CFBundleIdentifier"),
        shortVersion: plistValue(plistPath, "CFBundleShortVersionString"),
        buildVersion: plistValue(plistPath, "CFBundleVersion"),
        sourceRevision: buildProvenance?.gitRevision ?? "",
        sourceTree: buildProvenance?.gitTree ?? "",
        connectionName: plistValue(plistPath, "InputMethodConnectionName"),
        executableSha256: sha256File(executablePath),
        codeDirectoryHash,
        buildProvenanceSha256: sha256File(provenancePath)
      };
      addIssue(issues, identity.bundleIdentifier === LEKH_BUNDLE_IDENTIFIER, "context.bundle-identifier-invalid");
      addIssue(issues, isNonemptyString(identity.shortVersion, 128), "context.short-version-invalid");
      addIssue(issues, isNonemptyString(identity.buildVersion, 128), "context.build-version-invalid");
      addIssue(issues, gitRevisionPattern.test(identity.sourceRevision), "context.source-revision-invalid");
      addIssue(issues, gitRevisionPattern.test(identity.sourceTree), "context.source-tree-invalid");
      addIssue(issues, identity.connectionName === LEKH_CONNECTION_NAME, "context.connection-name-invalid");
      addIssue(issues, sha256Pattern.test(identity.executableSha256), "context.executable-digest-invalid");
      addIssue(issues, /^[a-f0-9]{40,64}$/u.test(identity.codeDirectoryHash), "context.code-directory-hash-invalid");
      addIssue(issues, sha256Pattern.test(identity.buildProvenanceSha256), "context.provenance-digest-invalid");
      addIssue(issues, signature.status === 0 && signatureVerification.status === 0, "context.code-signature-invalid");
      addIssue(issues, buildProvenance?.shortVersion === identity.shortVersion, "context.provenance-short-version-mismatch");
      addIssue(issues, String(buildProvenance?.buildNumber ?? "") === identity.buildVersion, "context.provenance-build-version-mismatch");
    }
  } catch {
    issues.push("context.installed-bundle-unreadable");
    identity = null;
  }

  const repository = captureRepositoryState(root, null, { excludeEvidence: true });
  addIssue(issues, repository.readable, "context.repository-unreadable");
  addIssue(issues, repository.clean, "context.worktree-dirty");
  addIssue(issues, gitRevisionPattern.test(repository.revision ?? ""), "context.git-revision-invalid");
  addIssue(issues, gitRevisionPattern.test(repository.tree ?? ""), "context.git-tree-invalid");
  addIssue(issues, identity?.sourceRevision === repository.revision, "context.installed-source-revision-stale");
  addIssue(issues, identity?.sourceTree === repository.tree, "context.installed-source-tree-stale");
  return Object.freeze({
    ready: issues.length === 0,
    issueCodes: Object.freeze(uniqueIssues(issues)),
    repository,
    bundleIdentity: identity ? Object.freeze(identity) : null
  });
}

function resolveEvidenceArtifact(root, artifactPath) {
  if (!isNonemptyString(artifactPath, 4096) || isAbsolute(artifactPath)) return null;
  const absolute = resolve(root, artifactPath);
  const relationship = relative(root, absolute);
  if (!relationship || relationship.startsWith("..") || isAbsolute(relationship)) return null;
  const evidenceRoot = resolve(root, "reports", "qa", "macos-imk");
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalEvidenceRoot = realpathSync(evidenceRoot);
    const canonicalAbsolute = realpathSync(absolute);
    const evidenceRootRelationship = relative(canonicalRoot, canonicalEvidenceRoot);
    const evidenceRelationship = relative(canonicalEvidenceRoot, canonicalAbsolute);
    if (
      !evidenceRootRelationship ||
      evidenceRootRelationship.startsWith("..") ||
      isAbsolute(evidenceRootRelationship) ||
      !evidenceRelationship ||
      evidenceRelationship.startsWith("..") ||
      isAbsolute(evidenceRelationship)
    ) return null;
    return canonicalAbsolute;
  } catch {
    return null;
  }
}

export function validateManualHostEvidence(evidence, {
  root,
  expectedApp,
  expectedCase,
  expectedTarget,
  evidencePath = null,
  context
}) {
  const issues = [];
  addIssue(issues, context?.ready === true, "manual.context-not-ready");
  addIssue(issues, hasExactKeys(evidence, manualEvidenceKeys), "manual.schema-fields-invalid");
  if (!isRecord(evidence)) return { valid: false, issueCodes: uniqueIssues(issues) };

  addIssue(issues, evidence.schemaVersion === MANUAL_HOST_EVIDENCE_SCHEMA_VERSION, "manual.schema-version-invalid");
  addIssue(issues, evidence.suite === MANUAL_HOST_EVIDENCE_SUITE, "manual.suite-invalid");
  addIssue(issues, validTimestamp(evidence.generatedAt), "manual.generated-at-invalid");
  addIssue(issues, evidence.target === expectedTarget, "manual.target-mismatch");
  addIssue(issues, evidence.app === expectedApp, "manual.app-mismatch");
  addIssue(issues, evidence.case === expectedCase, "manual.case-mismatch");

  const expectedMajor = /^macOS (\d+) (?:Apple Silicon|Intel)$/u.exec(expectedTarget)?.[1] ?? null;
  const expectedArchitecture = expectedTarget.endsWith("Intel") ? "x86_64" : "arm64";
  addIssue(issues, /^\d+\.\d+(?:\.\d+)?$/u.test(evidence.macOSVersion ?? ""), "manual.macos-version-invalid");
  addIssue(
    issues,
    expectedMajor !== null && String(evidence.macOSVersion ?? "").split(".")[0] === expectedMajor,
    "manual.macos-target-mismatch"
  );
  addIssue(issues, evidence.architecture === expectedArchitecture, "manual.architecture-mismatch");
  addIssue(issues, evidence.inputSource === LEKH_INPUT_SOURCE_IDENTIFIER, "manual.input-source-mismatch");
  addIssue(issues, evidence.pass === true, "manual.pass-not-true");
  addIssue(issues, isNonemptyString(evidence.expected), "manual.expected-invalid");
  addIssue(issues, isNonemptyString(evidence.actual), "manual.actual-invalid");

  addIssue(issues, hasExactKeys(evidence.bundleIdentity, manualBundleIdentityKeys), "manual.bundle-identity-schema-invalid");
  if (hasExactKeys(evidence.bundleIdentity, manualBundleIdentityKeys) && context?.bundleIdentity) {
    for (const key of manualBundleIdentityKeys) {
      addIssue(issues, evidence.bundleIdentity[key] === context.bundleIdentity[key], `manual.bundle-identity-${key}-mismatch`);
    }
  }

  addIssue(issues, hasExactKeys(evidence.provenance, manualProvenanceKeys), "manual.provenance-schema-invalid");
  if (hasExactKeys(evidence.provenance, manualProvenanceKeys) && context?.repository) {
    addIssue(issues, evidence.provenance.schemaVersion === 1, "manual.provenance-version-invalid");
    addIssue(issues, evidence.provenance.gitRevision === context.repository.revision, "manual.provenance-revision-stale");
    addIssue(issues, evidence.provenance.worktreeClean === true && context.repository.clean === true, "manual.provenance-worktree-dirty");
    addIssue(
      issues,
      evidence.provenance.installedSourceRevision === context.bundleIdentity?.sourceRevision &&
        evidence.provenance.installedSourceRevision === context.repository.revision,
      "manual.provenance-installed-source-stale"
    );
    addIssue(
      issues,
      evidence.provenance.installedSourceTree === context.bundleIdentity?.sourceTree &&
        evidence.provenance.installedSourceTree === context.repository.tree,
      "manual.provenance-installed-tree-stale"
    );
    addIssue(
      issues,
      evidence.provenance.installedBuildProvenanceSha256 === context.bundleIdentity?.buildProvenanceSha256,
      "manual.provenance-resource-stale"
    );
    addIssue(
      issues,
      evidence.provenance.installedExecutableSha256 === context.bundleIdentity?.executableSha256,
      "manual.provenance-executable-stale"
    );
    addIssue(
      issues,
      evidence.provenance.installedBuildVersion === context.bundleIdentity?.buildVersion,
      "manual.provenance-build-stale"
    );
  }

  addIssue(issues, Array.isArray(evidence.steps) && evidence.steps.length > 0, "manual.steps-missing");
  if (Array.isArray(evidence.steps)) {
    addIssue(issues, evidence.steps.length <= 256, "manual.steps-excessive");
    for (const step of evidence.steps) {
      const valid = hasExactKeys(step, manualStepKeys) &&
        isNonemptyString(step.action) &&
        isNonemptyString(step.expected) &&
        isNonemptyString(step.actual) &&
        step.pass === true;
      addIssue(issues, valid, "manual.step-invalid");
    }
  }

  addIssue(issues, Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0, "manual.artifacts-missing");
  const artifactPaths = new Map();
  if (Array.isArray(evidence.artifacts)) {
    addIssue(issues, evidence.artifacts.length <= 128, "manual.artifacts-excessive");
    for (const artifact of evidence.artifacts) {
      const schemaValid = hasExactKeys(artifact, manualArtifactKeys) &&
        artifactKinds.has(artifact.kind) &&
        sha256Pattern.test(artifact.sha256 ?? "");
      addIssue(issues, schemaValid, "manual.artifact-schema-invalid");
      if (!schemaValid) continue;
      const absolute = resolveEvidenceArtifact(root, artifact.path);
      addIssue(issues, absolute !== null, "manual.artifact-path-invalid");
      if (!absolute) continue;
      let validFile = false;
      try {
        const metadata = lstatSync(absolute);
        validFile = metadata.isFile() && !metadata.isSymbolicLink() && sha256File(absolute) === artifact.sha256;
      } catch {
        validFile = false;
      }
      addIssue(issues, validFile, "manual.artifact-unverified");
      if (validFile) {
        addIssue(issues, !artifactPaths.has(artifact.path), "manual.artifact-path-duplicate");
        artifactPaths.set(artifact.path, artifact.kind);
      }
    }
  }

  addIssue(issues, Array.isArray(evidence.logPaths), "manual.log-paths-invalid");
  if (Array.isArray(evidence.logPaths)) {
    addIssue(issues, evidence.logPaths.length <= 64, "manual.log-paths-excessive");
    addIssue(issues, new Set(evidence.logPaths).size === evidence.logPaths.length, "manual.log-path-duplicate");
    for (const path of evidence.logPaths) {
      addIssue(issues, artifactPaths.get(path) === "log", "manual.log-path-not-attested");
    }
  }

  if (evidencePath) {
    const canonicalEvidence = resolve(evidencePath);
    addIssue(
      issues,
      ![...artifactPaths.keys()].some((path) => resolve(root, path) === canonicalEvidence),
      "manual.evidence-self-attested"
    );
  }
  return { valid: issues.length === 0, issueCodes: uniqueIssues(issues) };
}

function exactCleanupPassed(cleanup) {
  return cleanup?.hostTerminated === true &&
    cleanup?.inputSourceRestored === true &&
    cleanup?.preferencesRestored === true &&
    cleanup?.secureInputReturnedToBaseline === true &&
    cleanup?.temporaryHostRemoved === true;
}

function secureProvenancePassed(provenance, repository) {
  if (
    provenance?.schemaVersion !== 1 ||
    provenance?.sourceFilesClean !== true ||
    provenance?.sourceStatusReadable !== true ||
    provenance?.gitRevision !== repository.revision ||
    repository.readable !== true ||
    repository.clean !== true ||
    !Array.isArray(provenance.sources) ||
    provenance.sources.length !== SECURE_FIELD_EVIDENCE_SOURCE_PATHS.length
  ) return false;
  return SECURE_FIELD_EVIDENCE_SOURCE_PATHS.every((path, index) => {
    const source = provenance.sources[index];
    return hasExactKeys(source, ["path", "sha256"]) &&
      source.path === path &&
      sha256Pattern.test(source.sha256 ?? "") &&
      source.sha256 === repository.sourceHashes[path];
  });
}

function localArtifactIntegrityPassed(artifact, { report, repository, root }) {
  const artifactKeys = [
    "schemaVersion",
    "provenanceAssurance",
    "sourceToBinaryAttested",
    "artifactIntegrityVerified",
    "embeddedSourceRevision",
    "evidenceRevisionMatches",
    "installedExecutableSha256",
    "runningExecutableSha256",
    "executableHashesMatch",
    "installedCodeDirectoryHash",
    "runningCodeDirectoryHash",
    "codeDirectoryHashesMatch",
    "installedBuildVersion",
    "runningBuildVersion",
    "buildVersionsMatch",
    "embeddedManifest",
    "embeddedManifestSha256",
    "embeddedManifestIntegrityVerified"
  ];
  const manifestKeys = [
    "schemaVersion",
    "recordType",
    "gitRevision",
    "gitTree",
    "sourceFilesClean",
    "shortVersion",
    "buildNumber",
    "architectures",
    "packagingScriptSha256"
  ];
  if (!hasExactKeys(artifact, artifactKeys) || !hasExactKeys(artifact.embeddedManifest, manifestKeys)) {
    return false;
  }
  const manifest = artifact.embeddedManifest;
  const architectures = manifest.architectures;
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestDigest = createHash("sha256").update(manifestSerialized).digest("hex");
  const packagingScriptPath = join(root, "scripts", "package-macos-imk-dev.mjs");
  const packagingScriptDigest = existsSync(packagingScriptPath) ? sha256File(packagingScriptPath) : null;
  return artifact.schemaVersion === 1 &&
    artifact.provenanceAssurance === "local-unattested" &&
    artifact.sourceToBinaryAttested === false &&
    artifact.artifactIntegrityVerified === true &&
    artifact.embeddedManifestIntegrityVerified === true &&
    artifact.embeddedSourceRevision === manifest.gitRevision &&
    artifact.embeddedSourceRevision === report.evidenceProvenance?.gitRevision &&
    artifact.embeddedSourceRevision === repository.revision &&
    artifact.evidenceRevisionMatches === true &&
    artifact.installedExecutableSha256 === report.bundleIdentity?.executableSha256 &&
    artifact.runningExecutableSha256 === report.bundleIdentity?.executableSha256 &&
    artifact.executableHashesMatch === true &&
    sha256Pattern.test(artifact.installedExecutableSha256 ?? "") &&
    artifact.installedCodeDirectoryHash === report.bundleIdentity?.codeDirectoryHash &&
    artifact.runningCodeDirectoryHash === report.bundleIdentity?.codeDirectoryHash &&
    artifact.codeDirectoryHashesMatch === true &&
    /^[a-f0-9]{40,64}$/u.test(artifact.installedCodeDirectoryHash ?? "") &&
    artifact.installedBuildVersion === report.bundleIdentity?.buildVersion &&
    artifact.runningBuildVersion === report.bundleIdentity?.buildVersion &&
    artifact.buildVersionsMatch === true &&
    manifest.schemaVersion === 1 &&
    manifest.recordType === "lekh-imk-build-provenance" &&
    manifest.gitRevision === repository.revision &&
    manifest.gitTree === repository.tree &&
    gitRevisionPattern.test(manifest.gitTree ?? "") &&
    manifest.sourceFilesClean === true &&
    manifest.shortVersion === report.bundleIdentity?.shortVersion &&
    String(manifest.buildNumber ?? "") === report.bundleIdentity?.buildVersion &&
    Array.isArray(architectures) &&
    architectures.length > 0 &&
    architectures.length <= 2 &&
    architectures.every((architecture) => ["arm64", "x86_64"].includes(architecture)) &&
    new Set(architectures).size === architectures.length &&
    JSON.stringify(architectures) === JSON.stringify([...architectures].sort()) &&
    architectures.includes(report.bundleIdentity?.architecture) &&
    manifest.packagingScriptSha256 === packagingScriptDigest &&
    sha256Pattern.test(manifest.packagingScriptSha256 ?? "") &&
    artifact.embeddedManifestSha256 === manifestDigest &&
    sha256Pattern.test(artifact.embeddedManifestSha256 ?? "");
}

export function validateSecureFieldHostEvidence(report, {
  root,
  repositoryState = captureRepositoryState(root, SECURE_FIELD_EVIDENCE_SOURCE_PATHS),
  fullRepositoryState = captureRepositoryState(root, null, { excludeEvidence: true }),
  currentInstalledContext = captureManualHostEvidenceContext({ root }),
  requireTrustedSourceToBinaryAttestation = false,
  trustedBuildAttestation = null
}, capability = null) {
  const issues = [];
  if (!isRecord(report)) {
    return {
      valid: false,
      trustedSourceToBinaryAttested: false,
      issueCodes: ["secure.report-invalid"]
    };
  }
  addIssue(issues, secureFieldHostEvidenceHasClosedSchema(report), "secure.closed-schema-invalid");
  addIssue(issues, report.status === "passed", "secure.status-not-passed");
  addIssue(issues, report.suite === "macos-imk-host-secure-field", "secure.suite-invalid");
  addIssue(issues, report.command === "node scripts/check-macos-imk-host-secure-field.mjs", "secure.command-invalid");
  addIssue(issues, validTimestamp(report.generatedAt), "secure.generated-at-invalid");
  addIssue(issues, report.hostFramework === "AppKit", "secure.host-framework-invalid");
  addIssue(issues, report.hostControl === "NSSecureTextField", "secure.host-control-invalid");
  addIssue(issues, Array.isArray(report.failures) && report.failures.length === 0, "secure.failures-present");
  addIssue(issues, !serializedSecureReportContainsCanary(report), "secure.synthetic-canary-present");
  addIssue(issues, secureProvenancePassed(report.evidenceProvenance, repositoryState), "secure.provenance-stale-or-invalid");
  addIssue(
    issues,
    fullRepositoryState.readable === true &&
      fullRepositoryState.clean === true &&
      fullRepositoryState.revision === repositoryState.revision &&
      fullRepositoryState.tree === repositoryState.tree,
    "secure.current-worktree-provenance-invalid"
  );

  addIssue(issues, report.bundleIdentity?.bundleIdentifier === LEKH_BUNDLE_IDENTIFIER, "secure.bundle-identifier-invalid");
  addIssue(issues, report.bundleIdentity?.connectionName === LEKH_CONNECTION_NAME, "secure.connection-name-invalid");
  addIssue(issues, isNonemptyString(report.bundleIdentity?.shortVersion, 128), "secure.short-version-invalid");
  addIssue(issues, isNonemptyString(report.bundleIdentity?.buildVersion, 128), "secure.build-version-invalid");
  addIssue(issues, sha256Pattern.test(report.bundleIdentity?.executableSha256 ?? ""), "secure.executable-digest-invalid");
  addIssue(issues, /^[a-f0-9]{40,64}$/u.test(report.bundleIdentity?.codeDirectoryHash ?? ""), "secure.code-directory-hash-invalid");
  addIssue(issues, ["arm64", "x86_64"].includes(report.bundleIdentity?.architecture), "secure.runtime-architecture-invalid");
  addIssue(issues, currentInstalledContext.ready === true, "secure.current-installed-context-invalid");
  if (currentInstalledContext.bundleIdentity) {
    const installed = currentInstalledContext.bundleIdentity;
    addIssue(issues, installed.bundleIdentifier === report.bundleIdentity?.bundleIdentifier, "secure.current-bundle-identifier-mismatch");
    addIssue(issues, installed.shortVersion === report.bundleIdentity?.shortVersion, "secure.current-short-version-mismatch");
    addIssue(issues, installed.buildVersion === report.bundleIdentity?.buildVersion, "secure.current-build-version-mismatch");
    addIssue(issues, installed.connectionName === report.bundleIdentity?.connectionName, "secure.current-connection-name-mismatch");
    addIssue(issues, installed.executableSha256 === report.bundleIdentity?.executableSha256, "secure.current-executable-mismatch");
    addIssue(issues, installed.codeDirectoryHash === report.bundleIdentity?.codeDirectoryHash, "secure.current-code-directory-mismatch");
    addIssue(issues, installed.sourceRevision === report.artifactProvenance?.embeddedSourceRevision, "secure.current-source-revision-mismatch");
    addIssue(issues, installed.sourceTree === report.artifactProvenance?.embeddedManifest?.gitTree, "secure.current-source-tree-mismatch");
    addIssue(
      issues,
      installed.buildProvenanceSha256 === report.artifactProvenance?.embeddedManifestSha256,
      "secure.current-provenance-resource-mismatch"
    );
  }
  addIssue(
    issues,
    localArtifactIntegrityPassed(report.artifactProvenance, { report, repository: fullRepositoryState, root }),
    "secure.local-artifact-integrity-invalid"
  );
  const trustedSourceToBinaryAttested = trustedSecureSourceToBinaryEvidence({
    root,
    report,
    repositoryState: fullRepositoryState,
    trustedBuildAttestation
  });
  // A caller-controlled label inside the host report remains insufficient.
  // Production accepts only the separately verified GitHub Actions SLSA
  // statement that binds this report, the package report, and the exact IMK
  // executable digest to the current clean source revision.
  addIssue(
    issues,
    requireTrustedSourceToBinaryAttestation !== true || trustedSourceToBinaryAttested,
    "secure.trusted-source-to-binary-attestation-required"
  );
  addIssue(
    issues,
    requireTrustedSourceToBinaryAttestation !== true || capability === secureProductionFileCapability,
    "secure.production-report-file-required"
  );
  addIssue(issues, report.runtime?.exactInstalledRuntimeVerified === true, "secure.runtime-not-verified");
  addIssue(issues, report.runtime?.bundleVersionMatches === true, "secure.runtime-version-mismatch");
  addIssue(issues, report.runtime?.executablePathMatches === true, "secure.runtime-path-mismatch");
  addIssue(issues, Array.isArray(report.runtime?.issues) && report.runtime.issues.length === 0, "secure.runtime-issues-present");
  addIssue(issues, Number.isInteger(report.durationMs) && report.durationMs >= 0, "secure.duration-invalid");
  addIssue(issues, isNonemptyString(report.appBundle, 4096) && isAbsolute(report.appBundle), "secure.app-bundle-path-invalid");

  addIssue(issues, report.automation?.eligible === true, "secure.automation-ineligible");
  addIssue(issues, report.automation?.status === 0, "secure.automation-status-invalid");
  addIssue(issues, report.automation?.accessibilityTrusted === true, "secure.accessibility-untrusted");
  addIssue(issues, report.automation?.eventPostAccess === true, "secure.event-post-unavailable");
  addIssue(issues, typeof report.automation?.eventListenAccess === "boolean", "secure.event-listen-state-invalid");
  addIssue(issues, report.automation?.eventListenAccessRequired === false, "secure.event-listen-policy-invalid");
  addIssue(issues, report.automation?.stderr === "", "secure.automation-stderr-present");

  const privacy = report.privacy ?? {};
  for (const key of [
    "rawPayloadIncluded",
    "candidateTextIncluded",
    "databaseRowsIncluded",
    "databaseDigestIncluded",
    "logLinesIncluded",
    "secureAXValueRead",
    "eventTapInstalled"
  ]) addIssue(issues, privacy[key] === false, `secure.privacy-${key}-invalid`);
  addIssue(issues, privacy.syntheticCanaryAbsentFromSerializedReport === true, "secure.privacy-canary-invalid");

  const startup = report.recovery?.startup;
  const startupPassed = startup?.status === "no-recovery-required" ||
    (startup?.status === "recovered" && exactCleanupPassed(startup.cleanupEvidence));
  addIssue(issues, startupPassed, "secure.startup-recovery-invalid");
  const guardian = report.recovery?.guardian;
  addIssue(
    issues,
    guardian?.status === "completed" &&
      guardian?.disposition === "normal-completion" &&
      Number.isInteger(guardian?.processIdentifier) && guardian.processIdentifier > 1 &&
      guardian?.exitCode === 0 &&
      guardian?.signal === null,
    "secure.guardian-settlement-invalid"
  );
  addIssue(issues, exactCleanupPassed(report.cleanup), "secure.cleanup-invalid");

  const host = report.host ?? {};
  addIssue(issues, host.bundleIdentifier === "com.lekh.qa.SecureFieldHost", "secure.host-identity-invalid");
  addIssue(issues, host.freshProcessVerified === true, "secure.host-process-unverified");
  addIssue(issues, host.calibrationDelivered === true, "secure.calibration-undelivered");
  addIssue(issues, Number.isInteger(host.expectedUTF16Length) && host.expectedUTF16Length > 0, "secure.expected-length-invalid");

  const secureInput = report.secureInput ?? {};
  const protectionPath = secureInput.protectionPath;
  addIssue(issues, secureInput.baselineEnabled === false, "secure.baseline-invalid");
  addIssue(issues, secureInput.enabledDuringFocusedEntry === true, "secure.focused-entry-not-secure");
  addIssue(issues, secureInput.causalFalseToTrueTransition === true, "secure.transition-unproven");
  addIssue(issues, secureInput.sourceStableThroughEntry === true, "secure.route-unstable");
  addIssue(issues, secureInput.sourceSampleCount === 10, "secure.atomic-route-samples-invalid");
  addIssue(issues, isNonemptyString(secureInput.sourceIdentifierDuringSecureEntry, 512), "secure.route-identifier-invalid");
  addIssue(
    issues,
    protectionPath === "lekh-selected-route-attribution-unavailable" ||
      protectionPath === "macos-ascii-source-substitution",
    "secure.protection-path-invalid"
  );
  addIssue(
    issues,
    secureInput.liveControllerCallbackAttributed === false,
    "secure.live-controller-attribution-overclaimed"
  );
  if (protectionPath === "lekh-selected-route-attribution-unavailable") {
    addIssue(issues, secureInput.sourceIdentifierDuringSecureEntry === LEKH_INPUT_SOURCE_IDENTIFIER, "secure.lekh-route-id-mismatch");
    addIssue(issues, secureInput.osInputSourceSubstitutionObserved === false, "secure.lekh-route-substitution-conflict");
    addIssue(
      issues,
      secureInput.controllerAttributionNote ===
        "TIS selection does not prove whether macOS invoked or bypassed the IMK controller; callback guards are covered by the separate native functional probe.",
      "secure.controller-attribution-note-invalid"
    );
  } else if (protectionPath === "macos-ascii-source-substitution") {
    addIssue(issues, secureInput.sourceIdentifierDuringSecureEntry !== LEKH_INPUT_SOURCE_IDENTIFIER, "secure.substitution-route-id-invalid");
    addIssue(issues, secureInput.sourceWasASCIICapable === true, "secure.substitution-not-ascii");
    addIssue(issues, secureInput.sourceWasEnabled === true, "secure.substitution-not-enabled");
    addIssue(issues, secureInput.sourceCategoryValid === true, "secure.substitution-category-invalid");
    addIssue(issues, secureInput.sourceTypeValid === true, "secure.substitution-type-invalid");
    addIssue(issues, secureInput.osInputSourceSubstitutionObserved === true, "secure.substitution-observation-missing");
    addIssue(
      issues,
      secureInput.controllerAttributionNote ===
        "macOS visibly substituted an ASCII-capable keyboard source for secure entry.",
      "secure.substitution-attribution-note-invalid"
    );
  }

  const assertions = report.assertions ?? {};
  for (const key of [
    "rawHostResultMatched",
    "secureInputRouteObserved",
    "secureInputRouteStable",
    "noMarkedText",
    "noVisibleLekhCandidateOrGhostSurface",
    "personalizationPreferenceRequested",
    "writerDrainStable",
    "runtimeGhostEvidenceUnchanged",
    "runtimeHealthFileUnchanged"
  ]) addIssue(issues, assertions[key] === true, `secure.assertion-${key}-invalid`);
  addIssue(
    issues,
    assertions.database?.ready === true &&
      assertions.database?.rowCountDelta === 0 &&
      assertions.database?.frequencyDelta === 0 &&
      assertions.database?.lastUsedEqual === true &&
      assertions.database?.canonicalDigestEqual === true &&
      assertions.database?.equal === true,
    "secure.database-evidence-invalid"
  );
  addIssue(
    issues,
    assertions.unifiedLog?.reliable === true &&
      assertions.unifiedLog?.eventCount === 0 &&
      assertions.unifiedLog?.malformedEventCount === 0 &&
      assertions.unifiedLog?.summaryRecordCount === 1 &&
      assertions.unifiedLog?.surfaceEventCount === 0 &&
      assertions.unifiedLog?.syntheticInputMentioned === false,
    "secure.unified-log-evidence-invalid"
  );
  addIssue(
    issues,
    assertions.metricLog?.reliable === true &&
      assertions.metricLog?.appendedLineCount === 0 &&
      assertions.metricLog?.appendedByteCount === 0 &&
      assertions.metricLog?.appendedPayloadContainsSyntheticInput === false,
    "secure.metric-log-evidence-invalid"
  );

  const epoch = report.runtimeEpoch ?? {};
  const requiredCheckpoints = new Set([
    "calibration-complete",
    "secure-focus",
    "secure-token",
    "secure-down-arrow",
    "secure-space",
    "secure-evidence-finalized"
  ]);
  const checkpoints = Array.isArray(epoch.checkpoints) ? epoch.checkpoints : [];
  addIssue(issues, epoch.stable === true, "secure.runtime-epoch-unstable");
  addIssue(issues, Number.isInteger(epoch.originalProcessIdentifier) && epoch.originalProcessIdentifier > 1, "secure.runtime-epoch-pid-invalid");
  addIssue(issues, epoch.originalProcessIdentifier === report.runtime?.processIdentifier, "secure.runtime-epoch-pid-mismatch");
  addIssue(issues, epoch.executablePathPinned === true, "secure.runtime-epoch-executable-unpinned");
  addIssue(issues, epoch.processStartTokenPinned === true, "secure.runtime-epoch-start-token-unpinned");
  addIssue(
    issues,
    checkpoints.length === requiredCheckpoints.size && checkpoints.every((checkpoint) =>
      checkpoint?.verified === true &&
      Array.isArray(checkpoint?.issueCodes) && checkpoint.issueCodes.length === 0 &&
      requiredCheckpoints.has(checkpoint?.step)
    ) && requiredCheckpoints.size === new Set(checkpoints.map(({ step }) => step)).size,
    "secure.runtime-checkpoints-invalid"
  );

  return {
    valid: issues.length === 0,
    trustedSourceToBinaryAttested,
    issueCodes: uniqueIssues(issues)
  };
}

export function validateSecureFieldHostEvidenceFile({
  root,
  trustedBuildAttestation,
  reportPath = join(root, "reports", "macos-imk-host-secure-field.json"),
  repositoryState = captureRepositoryState(root, SECURE_FIELD_EVIDENCE_SOURCE_PATHS),
  fullRepositoryState = captureRepositoryState(root, null, { excludeEvidence: true }),
  currentInstalledContext = captureManualHostEvidenceContext({ root })
}) {
  const expectedPath = join(root, "reports", "macos-imk-host-secure-field.json");
  if (resolve(reportPath) !== resolve(expectedPath)) {
    return {
      valid: false,
      trustedSourceToBinaryAttested: false,
      issueCodes: ["secure.production-report-path-invalid"],
      evidenceMetadata: null
    };
  }
  let beforeBytes;
  let beforeDigest;
  let report;
  try {
    const metadata = lstatSync(reportPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 16 * 1024 * 1024) {
      throw new Error("invalid secure report file");
    }
    beforeBytes = readFileSync(reportPath);
    beforeDigest = createHash("sha256").update(beforeBytes).digest("hex");
    report = JSON.parse(beforeBytes.toString("utf8"));
  } catch {
    return {
      valid: false,
      trustedSourceToBinaryAttested: false,
      issueCodes: ["secure.production-report-unreadable"],
      evidenceMetadata: null
    };
  }
  const validation = validateSecureFieldHostEvidence(report, {
    root,
    repositoryState,
    fullRepositoryState,
    currentInstalledContext,
    requireTrustedSourceToBinaryAttestation: true,
    trustedBuildAttestation
  }, secureProductionFileCapability);
  let stable = false;
  try {
    const afterBytes = readFileSync(reportPath);
    stable = beforeBytes.length === afterBytes.length &&
      beforeDigest === createHash("sha256").update(afterBytes).digest("hex");
  } catch {
    stable = false;
  }
  const issueCodes = stable
    ? validation.issueCodes
    : uniqueIssues([...validation.issueCodes, "secure.production-report-changed-during-validation"]);
  return {
    valid: validation.valid && stable,
    trustedSourceToBinaryAttested: validation.trustedSourceToBinaryAttested && stable,
    issueCodes,
    evidenceMetadata: {
      suite: typeof report.suite === "string" ? report.suite : null,
      generatedAt: typeof report.generatedAt === "string" ? report.generatedAt : null,
      sha256: stable ? beforeDigest : null
    }
  };
}

function trustedSecureSourceToBinaryEvidence({
  root,
  report,
  repositoryState,
  trustedBuildAttestation
}) {
  if (
    !isTrustedProductionIMKBuildAttestation(trustedBuildAttestation) ||
    trustedBuildAttestation.gitRevision !== repositoryState?.revision ||
    trustedBuildAttestation.gitTree !== repositoryState?.tree
  ) return false;

  const executableDigest = trustedBuildAttestation.executableSha256;
  if (
    !sha256Pattern.test(executableDigest ?? "") ||
    trustedBuildAttestation.signingClassification !== "developer-id-ready" ||
    executableDigest !== report.bundleIdentity?.executableSha256 ||
    executableDigest !== report.artifactProvenance?.installedExecutableSha256 ||
    report.artifactProvenance?.runningExecutableSha256 !== executableDigest ||
    trustedBuildAttestation.codeDirectoryHash !== report.bundleIdentity?.codeDirectoryHash
  ) return false;

  try {
    const packageReport = JSON.parse(readFileSync(
      join(root, "reports", "macos-imk-dev-package-report.json"),
      "utf8"
    ));
    return packageReport.status === "passed-developer-id-ready" &&
      packageReport.signingClassification === "developer-id-ready" &&
      packageReport.productionSigningRequired === false &&
      packageReport.executableSha256 === executableDigest &&
      packageReport.codeDirectoryHash === report.bundleIdentity?.codeDirectoryHash &&
      packageReport.buildProvenance?.gitRevision === repositoryState.revision &&
      packageReport.buildProvenance?.gitTree === repositoryState.tree &&
      packageReport.buildProvenance?.sourceFilesClean === true;
  } catch {
    return false;
  }
}

export function manualHostEvidenceAllowedForMatrix({ production, app, testCase }) {
  return !(
    production === true &&
    app === "Password Fields" &&
    testCase === "secure-field-no-memory"
  );
}

export function macOSQAMatrixStatus({ production, missingCount }) {
  if (!Number.isInteger(missingCount) || missingCount < 0) return "failed-invalid-evidence-count";
  if (missingCount > 0) {
    return production ? "failed-production-missing-host-evidence" : "passed-dev-matrix-defined";
  }
  return production ? "passed-production" : "passed-dev-matrix-complete";
}
