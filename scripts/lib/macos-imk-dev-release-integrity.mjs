import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

export const BUILD_PROVENANCE_KEYS = Object.freeze([
  "architectures",
  "buildNumber",
  "gitRevision",
  "gitTree",
  "packagingScriptSha256",
  "recordType",
  "schemaVersion",
  "shortVersion",
  "sourceFilesClean"
]);

const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CODE_DIRECTORY_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SUCCESS_STATUS_BY_SIGNING_CLASS = Object.freeze({
  "ad-hoc-development": "passed-adhoc-release",
  "development-signed": "passed-development-signed",
  "developer-id-ready": "passed-developer-id-ready"
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readSmallRegularFile(path, maximumBytes, issue, issues) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
      issues.push(issue);
      return null;
    }
    return readFileSync(path);
  } catch {
    issues.push(issue);
    return null;
  }
}

function parseJSON(bytes, issue, issues) {
  if (!bytes) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    issues.push(issue);
    return null;
  }
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 20 * 1024 * 1024
  });
}

function canonicalExistingPath(path, issue, issues) {
  try {
    return realpathSync(path);
  } catch {
    issues.push(issue);
    return null;
  }
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function classifyMacOSCodeSigning(displayText) {
  const text = typeof displayText === "string" ? displayText : "";
  const authorities = [...text.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(text)?.[1]?.trim() ?? "";
  const timestamp = /^Timestamp=(.+)$/mu.exec(text)?.[1]?.trim() ?? "";
  const signature = /^Signature=(.+)$/mu.exec(text)?.[1]?.trim() ?? "";
  const flags = /^CodeDirectory\b[^\n]*\bflags=[^\n]*$/mu.exec(text)?.[0] ?? "";
  const hardenedRuntime = /\bruntime\b/u.test(flags);
  const secureTimestamp = timestamp.length > 0 && timestamp.toLowerCase() !== "none";
  const adHoc = signature.toLowerCase() === "adhoc" || /\badhoc\b/u.test(flags);
  const usableTeamIdentifier = /^[A-Z0-9]{10}$/u.test(teamIdentifier) ? teamIdentifier : "";
  const leafMatchesTeam = usableTeamIdentifier.length > 0 &&
    new RegExp(`^Developer ID Application: .+ \\(${escapedPattern(usableTeamIdentifier)}\\)$`, "u")
      .test(authorities[0] ?? "");
  const developerIDChain = authorities.length === 3 &&
    leafMatchesTeam &&
    authorities[1] === "Developer ID Certification Authority" &&
    authorities[2] === "Apple Root CA";
  const developerIDReady = !adHoc && developerIDChain && hardenedRuntime && secureTimestamp;
  const classification = developerIDReady
    ? "developer-id-ready"
    : adHoc
      ? "ad-hoc-development"
      : "development-signed";
  return {
    classification,
    productionSigningRequired: !developerIDReady,
    developerIDReady,
    hardenedRuntime,
    secureTimestamp,
    teamIdentifier: usableTeamIdentifier || null,
    authorities,
    signature: signature || null
  };
}

export function validateClosedBuildProvenance(record, expectations = {}) {
  const issues = [];
  if (!hasExactKeys(record, BUILD_PROVENANCE_KEYS)) {
    return ["build-provenance-schema-not-closed"];
  }
  if (record.schemaVersion !== 1 || record.recordType !== "lekh-imk-build-provenance") {
    issues.push("build-provenance-record-identity-invalid");
  }
  if (!GIT_OBJECT_PATTERN.test(record.gitRevision) || !GIT_OBJECT_PATTERN.test(record.gitTree)) {
    issues.push("build-provenance-git-identity-invalid");
  }
  if (record.sourceFilesClean !== true) issues.push("build-provenance-source-not-clean");
  if (typeof record.shortVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(record.shortVersion)) {
    issues.push("build-provenance-version-invalid");
  }
  if (typeof record.buildNumber !== "string" || !/^[1-9]\d*$/u.test(record.buildNumber)) {
    issues.push("build-provenance-build-number-invalid");
  }
  if (
    !Array.isArray(record.architectures) ||
    record.architectures.length < 1 ||
    record.architectures.length > 2 ||
    new Set(record.architectures).size !== record.architectures.length ||
    record.architectures.some((architecture) => !["arm64", "x86_64"].includes(architecture)) ||
    [...record.architectures].sort().join("\0") !== record.architectures.join("\0")
  ) {
    issues.push("build-provenance-architectures-invalid");
  }
  if (!SHA256_PATTERN.test(record.packagingScriptSha256)) {
    issues.push("build-provenance-packager-hash-invalid");
  }
  if (expectations.gitRevision && record.gitRevision !== expectations.gitRevision) {
    issues.push("build-provenance-not-current-head");
  }
  if (expectations.gitTree && record.gitTree !== expectations.gitTree) {
    issues.push("build-provenance-not-current-tree");
  }
  if (
    expectations.packagingScriptSha256 &&
    record.packagingScriptSha256 !== expectations.packagingScriptSha256
  ) {
    issues.push("build-provenance-packager-hash-mismatch");
  }
  return issues;
}

export function validateMacOSIMKDevArtifactEvidence({
  manifest,
  manifestSha256,
  packageReport,
  currentGitRevision,
  currentGitTree,
  currentSourceClean,
  packagingScriptSha256,
  expectedReportArtifact,
  executableSha256,
  codeDirectoryHash,
  signingEvidence
}) {
  const issues = validateClosedBuildProvenance(manifest, {
    gitRevision: currentGitRevision,
    gitTree: currentGitTree,
    packagingScriptSha256
  });
  if (currentSourceClean !== true) issues.push("current-source-not-clean");
  if (!isPlainObject(packageReport)) return [...issues, "package-report-invalid"];
  if (packageReport.command !== "npm run package:macos:imk:dev" || packageReport.suite !== "macos-imk-dev-package") {
    issues.push("package-report-identity-invalid");
  }
  const expectedStatus = SUCCESS_STATUS_BY_SIGNING_CLASS[signingEvidence?.classification];
  if (!expectedStatus || packageReport.status !== expectedStatus) {
    issues.push("package-report-not-successful-for-signing-class");
  }
  if (packageReport.artifact !== expectedReportArtifact) issues.push("package-report-artifact-mismatch");
  if (!SHA256_PATTERN.test(manifestSha256) || packageReport.buildProvenanceSha256 !== manifestSha256) {
    issues.push("package-report-manifest-hash-mismatch");
  }
  if (!sameJSON(packageReport.buildProvenance, manifest)) {
    issues.push("package-report-manifest-record-mismatch");
  }
  if (!SHA256_PATTERN.test(executableSha256) || packageReport.executableSha256 !== executableSha256) {
    issues.push("package-report-executable-hash-mismatch");
  }
  if (!CODE_DIRECTORY_PATTERN.test(codeDirectoryHash) || packageReport.codeDirectoryHash !== codeDirectoryHash) {
    issues.push("package-report-code-directory-hash-mismatch");
  }
  if (packageReport.signingClassification !== signingEvidence?.classification) {
    issues.push("package-report-signing-classification-mismatch");
  }
  if (packageReport.productionSigningRequired !== signingEvidence?.productionSigningRequired) {
    issues.push("package-report-production-signing-state-mismatch");
  }
  return [...new Set(issues)];
}

export function verifyMacOSIMKDevArtifact({
  root,
  appBundle,
  packageReportPath,
  expectedReportArtifact
}) {
  const issues = [];
  const canonicalRoot = canonicalExistingPath(root, "workspace-root-unreadable", issues);
  const canonicalBundle = canonicalExistingPath(appBundle, "artifact-bundle-unreadable", issues);
  const canonicalExpectedArtifact = canonicalExistingPath(
    expectedReportArtifact,
    "package-report-artifact-unreadable",
    issues
  );
  if (!canonicalRoot || !canonicalBundle || !canonicalExpectedArtifact) {
    return { status: "failed", issues };
  }
  try {
    const bundleMetadata = lstatSync(appBundle);
    if (!bundleMetadata.isDirectory() || bundleMetadata.isSymbolicLink()) {
      issues.push("artifact-bundle-not-regular-directory");
    }
  } catch {
    issues.push("artifact-bundle-unreadable");
  }
  const executablePath = join(canonicalBundle, "Contents", "MacOS", "LekhInputMethodApp");
  const manifestPath = join(canonicalBundle, "Contents", "Resources", "LekhBuildProvenance.v1.json");
  const packagingScriptPath = join(canonicalRoot, "scripts", "package-macos-imk-dev.mjs");
  const manifestBytes = readSmallRegularFile(
    manifestPath,
    16_384,
    "build-provenance-file-invalid",
    issues
  );
  const reportBytes = readSmallRegularFile(
    packageReportPath,
    1_048_576,
    "package-report-file-invalid",
    issues
  );
  const executableBytes = readSmallRegularFile(
    executablePath,
    256 * 1024 * 1024,
    "artifact-executable-file-invalid",
    issues
  );
  const packagingScriptBytes = readSmallRegularFile(
    packagingScriptPath,
    1_048_576,
    "packaging-script-file-invalid",
    issues
  );
  const manifest = parseJSON(manifestBytes, "build-provenance-json-invalid", issues);
  const packageReport = parseJSON(reportBytes, "package-report-json-invalid", issues);

  const signatureVerification = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", canonicalBundle], canonicalRoot);
  if (signatureVerification.status !== 0) issues.push("artifact-signature-invalid");
  const codeIdentity = run("/usr/bin/codesign", ["-dvvv", executablePath], canonicalRoot);
  const codeIdentityText = `${codeIdentity.stdout ?? ""}\n${codeIdentity.stderr ?? ""}`;
  if (codeIdentity.status !== 0) issues.push("artifact-code-identity-unreadable");
  const codeDirectoryHash = /(?:^|\n)CDHash=([^\s]+)/u.exec(codeIdentityText)?.[1]?.toLowerCase() ?? "";
  const signingEvidence = classifyMacOSCodeSigning(codeIdentityText);

  const gitRevision = run("/usr/bin/git", ["rev-parse", "HEAD"], canonicalRoot);
  const gitTree = run("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], canonicalRoot);
  const gitStatus = run(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    canonicalRoot
  );
  if (gitRevision.status !== 0 || gitTree.status !== 0 || gitStatus.status !== 0) {
    issues.push("current-source-identity-unreadable");
  }
  const evidenceIssues = validateMacOSIMKDevArtifactEvidence({
    manifest,
    manifestSha256: manifestBytes ? sha256Bytes(manifestBytes) : "",
    packageReport,
    currentGitRevision: gitRevision.status === 0 ? gitRevision.stdout.trim() : "",
    currentGitTree: gitTree.status === 0 ? gitTree.stdout.trim() : "",
    currentSourceClean: gitStatus.status === 0 && gitStatus.stdout.trim() === "",
    packagingScriptSha256: packagingScriptBytes ? sha256Bytes(packagingScriptBytes) : "",
    expectedReportArtifact: canonicalExpectedArtifact,
    executableSha256: executableBytes ? sha256Bytes(executableBytes) : "",
    codeDirectoryHash,
    signingEvidence
  });
  issues.push(...evidenceIssues);
  return {
    status: issues.length === 0 ? "passed" : "failed",
    issues: [...new Set(issues)],
    artifact: canonicalBundle,
    packageReportArtifact: canonicalExpectedArtifact,
    gitRevision: gitRevision.status === 0 ? gitRevision.stdout.trim() : null,
    gitTree: gitTree.status === 0 ? gitTree.stdout.trim() : null,
    executableSha256: executableBytes ? sha256Bytes(executableBytes) : null,
    codeDirectoryHash: codeDirectoryHash || null,
    signingClassification: signingEvidence.classification,
    productionSigningRequired: signingEvidence.productionSigningRequired
  };
}

export function canonicalPathForReport(path) {
  return resolve(path);
}
