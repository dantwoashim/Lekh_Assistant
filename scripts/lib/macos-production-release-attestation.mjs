import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyMacOSCodeSigning } from "./macos-imk-dev-release-integrity.mjs";
import { validateIndexedMacOSHostEvidence } from "./macos-imk-qa-indexed-evidence.mjs";
import {
  canonicalMacOSQATupleKey,
  canonicalMacOSQATuples,
  readCanonicalMacOSQAMatrixPolicy
} from "./macos-imk-qa-matrix-policy.mjs";

export const PRODUCTION_ATTESTATION_REPOSITORY = "dantwoashim/Lekh_Assistant";
export const PRODUCTION_ATTESTATION_PREDICATE = "https://slsa.dev/provenance/v1";
export const PRODUCTION_RELEASE_POLICY_PATH = "config/macos-production-release-policy.v1.json";
export const PRODUCTION_RELEASE_EVIDENCE_PATH = "reports/production-release-evidence.v1.json";
export const PRODUCTION_QA_EVIDENCE_INDEX_PATH = "reports/qa/macos-imk/evidence-index.v1.json";

export const PRODUCTION_ATTESTED_REPORT_PATHS = Object.freeze([
  "reports/macos-companion-package-check.json",
  "reports/macos-imk-dev-package-report.json",
  "reports/macos-imk-host-ghost-smoke.json",
  "reports/macos-imk-host-interaction-safety.json",
  "reports/macos-imk-host-secure-field.json",
  "reports/macos-imk-qa-matrix-report.json",
  "reports/macos-imk-test-installer-report.json",
  "reports/macos-native-signed-package-report.json",
  "reports/macos-update-security-production-report.json",
  "reports/native-imk-privacy-security-report.json",
  "reports/neural-coreml-device-benchmark-production.json",
  "reports/neural-gold-eval-production-report.json",
  "reports/neural-open-vocab-dataset-production-report.json",
  "reports/neural-open-vocab-evaluation-production.json",
  "reports/neural-production-promotion-production-report.json",
  "reports/neural-sota-worldclass-production-report.json"
].sort());

export const PRODUCTION_ATTESTED_ARTIFACT_ROLES = Object.freeze([
  "coreml-model-archive",
  "coreml-model-manifest",
  "dictionary-pack-release-index",
  "macos-companion-dmg",
  "macos-installer-zip",
  "release-manifest",
  "release-manifest-signature",
  "sbom-spdx",
  "update-appcast"
].sort());

const trustedReleaseAttestations = new WeakSet();
const trustedIMKBuildAttestations = new WeakSet();
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitObjectPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const teamIdentifierPattern = /^[A-Z0-9]{10}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const semverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const manifestKeys = Object.freeze(["artifacts", "evidenceIndex", "recordType", "release", "reports", "schemaVersion"].sort());
const releaseKeys = Object.freeze([
  "buildNumber", "generatedAt", "repository", "runIdentifier", "sourceRef",
  "sourceRevision", "sourceTree", "version"
].sort());
const reportKeys = Object.freeze(["path", "sha256", "sizeBytes"].sort());
const artifactKeys = Object.freeze(["path", "role", "sha256", "sizeBytes"].sort());
const evidenceIndexKeys = Object.freeze(["entryCount", "path", "sha256", "sizeBytes"].sort());
const qaIndexKeys = Object.freeze([
  "entries", "expectedEntryCount", "generatedAt", "installerZipSha256", "issues",
  "matrixPolicySha256", "recordType", "schemaVersion", "sourceRevision", "sourceTree"
].sort());
const qaIndexEntryKeys = Object.freeze(["app", "case", "evidence", "target"].sort());
const qaIndexEvidenceKeys = Object.freeze(["artifacts", "path", "sha256", "sizeBytes"].sort());
const qaIndexArtifactKeys = Object.freeze(["path", "sha256", "sizeBytes"].sort());
const policyKeys = Object.freeze([
  "appleDeveloperTeamIdentifier", "imkBuildSignerDigest", "imkBuildSignerWorkflow",
  "githubCLISha256", "recordType", "releaseSignerDigest", "releaseSignerWorkflow", "repository",
  "schemaVersion", "sourceRefPattern"
].sort());
const githubCLIKeys = Object.freeze(["arm64", "x86_64"].sort());

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function unique(values) {
  return [...new Set(values)];
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function command(executable, args, cwd, options = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
    ...options
  });
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now() + 5 * 60_000;
}

function safeWorkspaceFile(root, relativePath, maximumBytes, issue, issues) {
  if (
    typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 512 ||
    isAbsolute(relativePath) || relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    issues.push(`${issue}-path-invalid`);
    return null;
  }
  const resolvedRoot = resolve(root);
  const absolute = resolve(resolvedRoot, relativePath);
  if (!absolute.startsWith(`${resolvedRoot}${sep}`)) {
    issues.push(`${issue}-path-escape`);
    return null;
  }
  try {
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
      issues.push(`${issue}-file-invalid`);
      return null;
    }
    const canonical = realpathSync(absolute);
    if (!canonical.startsWith(`${realpathSync(resolvedRoot)}${sep}`)) {
      issues.push(`${issue}-canonical-escape`);
      return null;
    }
    return {
      absolute,
      canonical,
      device: metadata.dev,
      inode: metadata.ino,
      sizeBytes: metadata.size
    };
  } catch {
    issues.push(`${issue}-unreadable`);
    return null;
  }
}

function readSmallJSON(root, relativePath, maximumBytes, issue, issues) {
  const file = safeWorkspaceFile(root, relativePath, maximumBytes, issue, issues);
  if (!file) return { file: null, value: null };
  try {
    return { file, value: JSON.parse(readFileSync(file.absolute, "utf8")) };
  } catch {
    issues.push(`${issue}-json-invalid`);
    return { file, value: null };
  }
}

function strictGitHubOrigin(value) {
  const text = String(value ?? "").trim();
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(text);
  if (ssh) return ssh[1];
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) return "";
    const parts = url.pathname.replace(/^\//u, "").replace(/\.git$/u, "").split("/");
    return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part))
      ? parts.join("/")
      : "";
  } catch {
    return "";
  }
}

function pinnedGitHubCLI(policy, issues) {
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : "";
  const expectedDigest = architecture ? policy?.githubCLISha256?.[architecture] : null;
  if (!sha256Pattern.test(expectedDigest ?? "")) {
    issues.push("attestation.github-cli-digest-unconfigured");
    return null;
  }
  for (const candidate of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try {
      const canonical = realpathSync(candidate);
      const metadata = lstatSync(canonical);
      accessSync(canonical, constants.X_OK);
      if (metadata.isFile() && !metadata.isSymbolicLink()) {
        if (sha256File(canonical) !== expectedDigest) {
          issues.push("attestation.github-cli-digest-mismatch");
          return null;
        }
        return canonical;
      }
    } catch {
      // Continue through the fixed absolute allow-list. PATH is never used.
    }
  }
  issues.push("attestation.github-cli-unavailable");
  return null;
}

export function readProductionReleasePolicy(root) {
  const issues = [];
  const { value: policy } = readSmallJSON(root, PRODUCTION_RELEASE_POLICY_PATH, 32 * 1024, "attestation.policy", issues);
  if (!exactKeys(policy, policyKeys)) {
    issues.push("attestation.policy-schema-invalid");
  } else {
    if (policy.schemaVersion !== 1 || policy.recordType !== "lekh-macos-production-release-policy") {
      issues.push("attestation.policy-identity-invalid");
    }
    if (policy.repository !== PRODUCTION_ATTESTATION_REPOSITORY) issues.push("attestation.policy-repository-invalid");
    if (policy.sourceRefPattern !== "refs/tags/v<semver>") issues.push("attestation.policy-source-ref-invalid");
    for (const key of ["imkBuildSignerWorkflow", "releaseSignerWorkflow"]) {
      if (!new RegExp(`^${PRODUCTION_ATTESTATION_REPOSITORY.replace("/", "\\/")}\\/.github\\/workflows\\/[a-z0-9-]+\\.yml$`, "u").test(policy[key] ?? "")) {
        issues.push(`attestation.policy-${key}-invalid`);
      } else {
        const workflowPath = policy[key].slice(`${PRODUCTION_ATTESTATION_REPOSITORY}/`.length);
        const workflowIssues = [];
        if (!safeWorkspaceFile(root, workflowPath, 1024 * 1024, `attestation.policy-${key}`, workflowIssues)) {
          issues.push(`attestation.policy-${key}-missing`);
        }
      }
    }
    for (const key of ["imkBuildSignerDigest", "releaseSignerDigest"]) {
      if (!gitObjectPattern.test(policy[key] ?? "")) issues.push(`attestation.policy-${key}-unconfigured`);
    }
    if (!teamIdentifierPattern.test(policy.appleDeveloperTeamIdentifier ?? "")) {
      issues.push("attestation.policy-apple-team-id-unconfigured");
    }
    if (!exactKeys(policy.githubCLISha256, githubCLIKeys)) {
      issues.push("attestation.policy-github-cli-digests-invalid");
    } else {
      for (const architecture of githubCLIKeys) {
        if (!sha256Pattern.test(policy.githubCLISha256[architecture] ?? "")) {
          issues.push(`attestation.policy-github-cli-${architecture}-unconfigured`);
        }
      }
    }
  }
  return { valid: issues.length === 0, issueCodes: unique(issues), policy };
}

function exactProductionRepositoryState(root) {
  const issues = [];
  const revision = command("/usr/bin/git", ["rev-parse", "HEAD"], root);
  const tree = command("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], root);
  const status = command("/usr/bin/git", [
    "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
    ":(exclude)reports/**", ":(exclude)release/**"
  ], root);
  const origin = command("/usr/bin/git", ["remote", "get-url", "origin"], root);
  const packageResult = readSmallJSON(root, "package.json", 2 * 1024 * 1024, "attestation.package", issues);
  const version = /^(\d+\.\d+\.\d+)/u.exec(packageResult.value?.version ?? "")?.[1] ?? "";
  const sourceRef = semverPattern.test(version) ? `refs/tags/v${version}` : "";
  const tag = sourceRef ? command("/usr/bin/git", ["rev-list", "-n", "1", sourceRef], root) : { status: 1, stdout: "" };
  if (revision.status !== 0 || tree.status !== 0 || status.status !== 0 || origin.status !== 0) {
    issues.push("attestation.repository-state-unreadable");
  }
  const revisionValue = revision.status === 0 ? revision.stdout.trim() : "";
  const treeValue = tree.status === 0 ? tree.stdout.trim() : "";
  if (status.status !== 0 || status.stdout.trim() !== "") issues.push("attestation.source-worktree-dirty");
  if (strictGitHubOrigin(origin.stdout) !== PRODUCTION_ATTESTATION_REPOSITORY) {
    issues.push("attestation.origin-repository-invalid");
  }
  if (!sourceRef || tag.status !== 0 || tag.stdout.trim() !== revisionValue) {
    issues.push("attestation.immutable-release-tag-missing-or-stale");
  }
  return { issues: unique(issues), revision: revisionValue, tree: treeValue, sourceRef, version };
}

function artifactPathValid(role, path) {
  const fixed = {
    "coreml-model-archive": "release/attestation/LekhNeuralTransliterator.mlmodelc.zip",
    "coreml-model-manifest": "release/attestation/LekhNeuralTransliterator.manifest.json",
    "dictionary-pack-release-index": "release/attestation/dictionary-packs.index.v1.json",
    "macos-installer-zip": "release/native/macos/Lekh-Keyboard-Test-Installer.zip",
    "release-manifest": "release/native/macos/RELEASE-MANIFEST.json",
    "release-manifest-signature": "release/native/macos/RELEASE-MANIFEST.json.minisig",
    "sbom-spdx": "release/attestation/lekh-release.spdx.json",
    "update-appcast": "release/native/macos/appcast.xml"
  };
  if (Object.hasOwn(fixed, role)) return fixed[role] === path;
  if (role === "macos-companion-dmg") {
    return /^release\/Lekh-Keyboard-Companion-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.dmg$/u.test(path);
  }
  return false;
}

export function validateProductionReleaseEvidenceManifest(manifest, {
  root,
  currentRevision,
  currentTree,
  currentSourceRef,
  currentVersion
}) {
  const issues = [];
  const matrixPolicyResult = readCanonicalMacOSQAMatrixPolicy(root);
  if (!exactKeys(manifest, manifestKeys)) {
    return { valid: false, issueCodes: ["attestation.manifest-schema-invalid"], reportDigests: {}, artifactDigests: {} };
  }
  if (manifest.schemaVersion !== 1 || manifest.recordType !== "lekh-production-release-evidence") {
    issues.push("attestation.manifest-identity-invalid");
  }
  const release = manifest.release;
  if (!exactKeys(release, releaseKeys)) issues.push("attestation.release-schema-invalid");
  else {
    if (release.repository !== PRODUCTION_ATTESTATION_REPOSITORY) issues.push("attestation.repository-invalid");
    if (release.version !== currentVersion || !semverPattern.test(release.version ?? "")) issues.push("attestation.release-version-invalid");
    if (!/^[1-9]\d*$/u.test(release.buildNumber ?? "")) issues.push("attestation.release-build-invalid");
    if (!uuidPattern.test(release.runIdentifier ?? "")) issues.push("attestation.release-run-id-invalid");
    if (!validTimestamp(release.generatedAt)) issues.push("attestation.generated-at-invalid");
    if (release.sourceRevision !== currentRevision || !gitObjectPattern.test(release.sourceRevision ?? "")) issues.push("attestation.source-revision-invalid");
    if (release.sourceTree !== currentTree || !gitObjectPattern.test(release.sourceTree ?? "")) issues.push("attestation.source-tree-invalid");
    if (release.sourceRef !== currentSourceRef || !/^refs\/tags\/v\d+\.\d+\.\d+$/u.test(release.sourceRef ?? "")) issues.push("attestation.source-ref-invalid");
  }

  const reportDigests = {};
  if (!Array.isArray(manifest.reports) || manifest.reports.length !== PRODUCTION_ATTESTED_REPORT_PATHS.length ||
      JSON.stringify(manifest.reports.map((entry) => entry?.path)) !== JSON.stringify(PRODUCTION_ATTESTED_REPORT_PATHS)) {
    issues.push("attestation.report-set-invalid");
  } else {
    for (const entry of manifest.reports) {
      if (!exactKeys(entry, reportKeys) || !sha256Pattern.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
        issues.push("attestation.report-entry-invalid");
        continue;
      }
      const file = safeWorkspaceFile(root, entry.path, 32 * 1024 * 1024, "attestation.report", issues);
      if (!file || file.sizeBytes !== entry.sizeBytes || sha256File(file.absolute) !== entry.sha256) {
        issues.push("attestation.report-digest-mismatch");
        continue;
      }
      reportDigests[entry.path] = entry.sha256;
    }
  }

  const artifactDigests = {};
  const artifactPaths = {};
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== PRODUCTION_ATTESTED_ARTIFACT_ROLES.length ||
      JSON.stringify(manifest.artifacts.map((entry) => entry?.role)) !== JSON.stringify(PRODUCTION_ATTESTED_ARTIFACT_ROLES)) {
    issues.push("attestation.artifact-set-invalid");
  } else {
    const paths = new Set();
    for (const entry of manifest.artifacts) {
      if (!exactKeys(entry, artifactKeys) || !PRODUCTION_ATTESTED_ARTIFACT_ROLES.includes(entry.role) ||
          !artifactPathValid(entry.role, entry.path) || !sha256Pattern.test(entry.sha256 ?? "") ||
          !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0 || paths.has(entry.path)) {
        issues.push("attestation.artifact-entry-invalid");
        continue;
      }
      paths.add(entry.path);
      const file = safeWorkspaceFile(root, entry.path, 2 * 1024 * 1024 * 1024, "attestation.artifact", issues);
      if (!file || file.sizeBytes !== entry.sizeBytes || sha256File(file.absolute) !== entry.sha256) {
        issues.push("attestation.artifact-digest-mismatch");
        continue;
      }
      artifactDigests[entry.role] = entry.sha256;
      artifactPaths[entry.role] = entry.path;
    }
  }

  if (!exactKeys(manifest.evidenceIndex, evidenceIndexKeys) ||
      manifest.evidenceIndex?.path !== PRODUCTION_QA_EVIDENCE_INDEX_PATH ||
      !sha256Pattern.test(manifest.evidenceIndex?.sha256 ?? "") ||
      !Number.isSafeInteger(manifest.evidenceIndex?.sizeBytes) || manifest.evidenceIndex.sizeBytes <= 0 ||
      !Number.isSafeInteger(manifest.evidenceIndex?.entryCount) || manifest.evidenceIndex.entryCount <= 0) {
    issues.push("attestation.evidence-index-entry-invalid");
  } else {
    const file = safeWorkspaceFile(root, manifest.evidenceIndex.path, 64 * 1024 * 1024, "attestation.evidence-index", issues);
    if (!file || file.sizeBytes !== manifest.evidenceIndex.sizeBytes || sha256File(file.absolute) !== manifest.evidenceIndex.sha256) {
      issues.push("attestation.evidence-index-digest-mismatch");
    } else {
      let index = null;
      try {
        index = JSON.parse(readFileSync(file.absolute, "utf8"));
      } catch {
        issues.push("attestation.evidence-index-json-invalid");
      }
      const indexValidation = validateProductionQAEvidenceIndex(index, {
        root,
        sourceRevision: currentRevision,
        sourceTree: currentTree,
        installerZipSha256: artifactDigests["macos-installer-zip"]
      });
      issues.push(...indexValidation.issueCodes);
      if (indexValidation.entryCount !== manifest.evidenceIndex.entryCount) {
        issues.push("attestation.evidence-index-entry-count-mismatch");
      }
      try {
        const qaReport = JSON.parse(readFileSync(join(root, "reports", "macos-imk-qa-matrix-report.json"), "utf8"));
        if (
          qaReport.status !== "passed-production" ||
          qaReport.evidenceIndex?.path !== manifest.evidenceIndex.path ||
          qaReport.evidenceIndex?.sha256 !== manifest.evidenceIndex.sha256 ||
          qaReport.evidenceIndex?.sizeBytes !== manifest.evidenceIndex.sizeBytes ||
          qaReport.evidenceIndex?.entryCount !== manifest.evidenceIndex.entryCount ||
          qaReport.matrixPolicy?.path !== matrixPolicyResult.path ||
          qaReport.matrixPolicy?.sha256 !== matrixPolicyResult.sha256 ||
          qaReport.matrixPolicy?.tupleOrdering !== matrixPolicyResult.policy?.tupleOrdering ||
          qaReport.matrixPolicy?.evidenceReusePolicy !== matrixPolicyResult.policy?.evidenceReusePolicy ||
          !Array.isArray(qaReport.evidenceIndex?.issueCodes) || qaReport.evidenceIndex.issueCodes.length !== 0
        ) issues.push("attestation.qa-report-evidence-index-binding-invalid");
      } catch {
        issues.push("attestation.qa-report-evidence-index-binding-invalid");
      }
    }
  }
  return { valid: issues.length === 0, issueCodes: unique(issues), reportDigests, artifactDigests, artifactPaths };
}

export function validateProductionQAEvidenceIndex(index, {
  root,
  sourceRevision,
  sourceTree,
  installerZipSha256
}) {
  const issues = [];
  const matrixPolicyResult = readCanonicalMacOSQAMatrixPolicy(root);
  if (!matrixPolicyResult.valid) issues.push(...matrixPolicyResult.issueCodes);
  if (!exactKeys(index, qaIndexKeys)) {
    return { valid: false, issueCodes: ["evidence-index.schema-invalid"], entryCount: 0 };
  }
  if (index.schemaVersion !== 1 || index.recordType !== "lekh-macos-imk-qa-evidence-index") {
    issues.push("evidence-index.identity-invalid");
  }
  if (!validTimestamp(index.generatedAt)) issues.push("evidence-index.generated-at-invalid");
  if (!gitObjectPattern.test(sourceRevision ?? "") || !gitObjectPattern.test(sourceTree ?? "") ||
      index.sourceRevision !== sourceRevision || index.sourceTree !== sourceTree) {
    issues.push("evidence-index.source-identity-invalid");
  }
  if (index.matrixPolicySha256 !== matrixPolicyResult.sha256) {
    issues.push("evidence-index.matrix-policy-digest-invalid");
  }
  if (!sha256Pattern.test(installerZipSha256 ?? "") || index.installerZipSha256 !== installerZipSha256) {
    issues.push("evidence-index.installer-digest-invalid");
  }
  if (!Array.isArray(index.issues) || index.issues.length !== 0) issues.push("evidence-index.issues-present");
  const expectedTuples = matrixPolicyResult.valid
    ? canonicalMacOSQATuples(matrixPolicyResult.policy)
    : [];
  if (!Array.isArray(index.entries) || index.entries.length !== expectedTuples.length ||
      index.expectedEntryCount !== matrixPolicyResult.policy?.expectedEntryCount) {
    issues.push("evidence-index.entry-count-invalid");
  } else {
    const tuples = new Set();
    const actualTupleKeys = index.entries.map((entry) =>
      canonicalMacOSQATupleKey({ target: entry?.target, app: entry?.app, case: entry?.case })
    );
    const expectedTupleKeys = expectedTuples.map(canonicalMacOSQATupleKey);
    if (JSON.stringify(actualTupleKeys) !== JSON.stringify(expectedTupleKeys)) {
      issues.push("evidence-index.canonical-tuple-set-or-order-invalid");
    }
    const evidenceOwners = new Map();
    const artifactOwners = new Map();
    const registerOwner = (owners, identities, tuple, issue) => {
      for (const identity of identities) {
        if (!identity) continue;
        const prior = owners.get(identity);
        if (prior !== undefined && prior !== tuple) issues.push(issue);
        else owners.set(identity, tuple);
      }
    };
    for (const entry of index.entries) {
      if (!exactKeys(entry, qaIndexEntryKeys) ||
          ![entry.target, entry.app, entry.case].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256) ||
          !Array.isArray(entry.evidence) || entry.evidence.length === 0 || entry.evidence.length > 64) {
        issues.push("evidence-index.entry-invalid");
        continue;
      }
      const tuple = `${entry.target}\0${entry.app}\0${entry.case}`;
      if (tuples.has(tuple)) issues.push("evidence-index.entry-duplicate");
      tuples.add(tuple);
      const paths = new Set();
      const orderedEvidencePaths = entry.evidence.map((evidence) => evidence?.path);
      if (JSON.stringify(orderedEvidencePaths) !== JSON.stringify([...orderedEvidencePaths].sort())) {
        issues.push("evidence-index.evidence-order-invalid");
      }
      for (const evidence of entry.evidence) {
        if (!exactKeys(evidence, qaIndexEvidenceKeys) || !sha256Pattern.test(evidence.sha256 ?? "") ||
            !Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes <= 0 || !Array.isArray(evidence.artifacts) ||
            evidence.artifacts.length > 128 || paths.has(evidence.path)) {
          issues.push("evidence-index.evidence-entry-invalid");
          continue;
        }
        paths.add(evidence.path);
        const file = safeWorkspaceFile(root, evidence.path, 64 * 1024 * 1024, "evidence-index.evidence", issues);
        let parsedEvidence = null;
        if (file) {
          try {
            const evidenceBytes = readFileSync(file.absolute);
            if (evidenceBytes.length !== evidence.sizeBytes || sha256Bytes(evidenceBytes) !== evidence.sha256) {
              issues.push("evidence-index.evidence-digest-mismatch");
            } else {
              parsedEvidence = JSON.parse(evidenceBytes.toString("utf8"));
            }
          } catch {
            issues.push("evidence-index.evidence-json-invalid");
          }
        } else {
          issues.push("evidence-index.evidence-digest-mismatch");
        }
        registerOwner(evidenceOwners, [
          `path:${evidence.path}`,
          file ? `canonical:${file.canonical}` : null,
          file ? `inode:${file.device}:${file.inode}` : null,
          `sha256:${evidence.sha256}`
        ], tuple, "evidence-index.evidence-reused-across-tuples");
        if (parsedEvidence) {
          const identity = validateIndexedMacOSHostEvidence(parsedEvidence, {
            target: entry.target,
            app: entry.app,
            testCase: entry.case,
            path: evidence.path,
            sourceRevision,
            sourceTree,
            indexedArtifacts: evidence.artifacts
          });
          issues.push(...identity.issueCodes);
        }
        const artifactPaths = new Set();
        const orderedArtifactPaths = evidence.artifacts.map((artifact) => artifact?.path);
        if (JSON.stringify(orderedArtifactPaths) !== JSON.stringify([...orderedArtifactPaths].sort())) {
          issues.push("evidence-index.artifact-order-invalid");
        }
        for (const artifact of evidence.artifacts) {
          if (!exactKeys(artifact, qaIndexArtifactKeys) || !sha256Pattern.test(artifact.sha256 ?? "") ||
              !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0 || artifactPaths.has(artifact.path)) {
            issues.push("evidence-index.artifact-entry-invalid");
            continue;
          }
          artifactPaths.add(artifact.path);
          const artifactFile = safeWorkspaceFile(root, artifact.path, 256 * 1024 * 1024, "evidence-index.artifact", issues);
          if (!artifactFile || artifactFile.sizeBytes !== artifact.sizeBytes || sha256File(artifactFile.absolute) !== artifact.sha256) {
            issues.push("evidence-index.artifact-digest-mismatch");
          }
          registerOwner(artifactOwners, [
            `path:${artifact.path}`,
            artifactFile ? `canonical:${artifactFile.canonical}` : null,
            artifactFile ? `inode:${artifactFile.device}:${artifactFile.inode}` : null,
            `sha256:${artifact.sha256}`
          ], tuple, "evidence-index.artifact-reused-across-tuples");
        }
      }
    }
    if (tuples.size !== expectedTuples.length) issues.push("evidence-index.entry-coverage-invalid");
  }
  return {
    valid: issues.length === 0,
    issueCodes: unique(issues),
    entryCount: Array.isArray(index.entries) ? index.entries.length : 0
  };
}

export function verifiedAttestationOutputBindsSubject(parsed, expectedSha256) {
  if (!sha256Pattern.test(expectedSha256 ?? "") || !Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.some((entry) => {
    const result = entry?.verificationResult;
    return result?.statement?.predicateType === PRODUCTION_ATTESTATION_PREDICATE &&
      Array.isArray(result.verifiedTimestamps) && result.verifiedTimestamps.length > 0 &&
      Array.isArray(result.statement.subject) &&
      result.statement.subject.some((subject) => subject?.digest?.sha256 === expectedSha256);
  });
}

function verificationArguments({ artifactPath, repository, signerWorkflow, signerDigest, sourceDigest, sourceRef, bundlePath }) {
  const args = [
    "attestation", "verify", artifactPath,
    "--repo", repository,
    "--signer-workflow", signerWorkflow,
    "--signer-digest", signerDigest,
    "--source-digest", sourceDigest,
    "--source-ref", sourceRef,
    "--predicate-type", PRODUCTION_ATTESTATION_PREDICATE,
    "--deny-self-hosted-runners",
    "--format", "json"
  ];
  if (bundlePath) args.push("--bundle", bundlePath);
  return args;
}

function validateAttestationBundle(root, bundlePath, issues) {
  if (bundlePath === null) return null;
  const relativePath = relative(root, resolve(bundlePath)).split(sep).join("/");
  const file = safeWorkspaceFile(root, relativePath, 32 * 1024 * 1024, "attestation.bundle", issues);
  return file?.absolute ?? null;
}

function parseVerification(result, expectedSha256, issues) {
  if (result.status !== 0) {
    issues.push("attestation.cryptographic-verification-failed");
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    issues.push("attestation.verifier-output-invalid");
  }
  if (!verifiedAttestationOutputBindsSubject(parsed, expectedSha256)) {
    issues.push("attestation.subject-digest-unbound");
  }
}

const installerFolderName = "Lekh Keyboard Test Installer";
const installerRelativeApp = `${installerFolderName}/Lekh Keyboard Test Installer.app`;
const uninstallerRelativeApp = `${installerFolderName}/Lekh Keyboard Uninstaller.app`;
const imkRelativeApp = `${installerRelativeApp}/Contents/Resources/Lekh Keyboard.app`;
const imkRelativeExecutable = `${imkRelativeApp}/Contents/MacOS/LekhInputMethodApp`;
const expectedApplicationIdentifiers = Object.freeze(new Map([
  [installerRelativeApp, "com.lekh.inputmethod.Installer"],
  [uninstallerRelativeApp, "com.lekh.inputmethod.Uninstaller"],
  [imkRelativeApp, "com.lekh.inputmethod.LekhKeyboard"]
]));
const expectedSignedMachORelativePaths = Object.freeze([
  `${imkRelativeApp}/Contents/MacOS/LekhInputMethodApp`,
  ...["atomic-install-swap", "purge-lekh-input-sources", "register-lekh-input-source", "restore-system-keyboard", "terminate-exact-processes"]
    .flatMap((name) => [
      `${installerRelativeApp}/Contents/Resources/${name}`,
      `${uninstallerRelativeApp}/Contents/Resources/${name}`
    ])
].sort());

function safeZipEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024 ||
      /[\\\u0000-\u001f\u007f]/u.test(entry) || entry.startsWith("/") || entry.startsWith("~")) return false;
  const withoutTrailingSlash = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  const parts = withoutTrailingSlash.split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    (withoutTrailingSlash === installerFolderName || withoutTrailingSlash.startsWith(`${installerFolderName}/`));
}

function inspectZipEntries(zipPath, root, issues) {
  const list = command("/usr/bin/unzip", ["-Z", "-1", zipPath], root);
  const detailed = command("/usr/bin/unzip", ["-Z", "-l", zipPath], root);
  if (list.status !== 0 || detailed.status !== 0) {
    issues.push("attestation.imk-installer-archive-directory-unreadable");
    return [];
  }
  const entries = list.stdout.split(/\r?\n/u).filter(Boolean);
  const metadataLines = detailed.stdout.split(/\r?\n/u)
    .filter((line) => /^[dlcbps-][rwxstST-]{9}\s/u.test(line));
  if (entries.length === 0 || entries.length > 10_000 || metadataLines.length !== entries.length) {
    issues.push("attestation.imk-installer-archive-entry-count-invalid");
    return [];
  }
  const normalized = new Set();
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const metadataLine = metadataLines[index];
    const kind = metadataLine[0];
    const sizeMatch = /^[dlcbps-][rwxstST-]{9}\s+\S+\s+\S+\s+(\d+)\s/u.exec(metadataLine);
    const size = sizeMatch ? Number(sizeMatch[1]) : Number.NaN;
    const normalizedEntry = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (!safeZipEntry(entry) || normalized.has(normalizedEntry)) {
      issues.push("attestation.imk-installer-archive-entry-path-invalid");
    }
    normalized.add(normalizedEntry);
    if ((entry.endsWith("/") && kind !== "d") || (!entry.endsWith("/") && kind !== "-")) {
      issues.push("attestation.imk-installer-archive-entry-kind-invalid");
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024 * 1024) {
      issues.push("attestation.imk-installer-archive-entry-size-invalid");
    } else {
      totalUncompressedBytes += size;
    }
  }
  if (totalUncompressedBytes > 4 * 1024 * 1024 * 1024) {
    issues.push("attestation.imk-installer-archive-expanded-size-invalid");
  }
  if (!normalized.has(installerFolderName)) {
    issues.push("attestation.imk-installer-archive-root-missing");
  }
  return entries;
}

function extractedTree(directoryPath, issues) {
  const entries = [];
  const canonicalRoot = realpathSync(directoryPath);
  const visit = (path, relativePath) => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const relativeEntry = relativePath ? `${relativePath}/${name}` : name;
      let metadata;
      try { metadata = lstatSync(absolute); } catch {
        issues.push("attestation.imk-installer-extracted-entry-unreadable");
        continue;
      }
      if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
        issues.push("attestation.imk-installer-extracted-entry-kind-invalid");
        continue;
      }
      try {
        const canonical = realpathSync(absolute);
        if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
          issues.push("attestation.imk-installer-extracted-entry-escape");
          continue;
        }
      } catch {
        issues.push("attestation.imk-installer-extracted-entry-unreadable");
        continue;
      }
      entries.push({ absolute, relative: relativeEntry, directory: metadata.isDirectory(), sizeBytes: metadata.size });
      if (metadata.isDirectory()) visit(absolute, relativeEntry);
    }
  };
  visit(directoryPath, "");
  return entries;
}

function staticCodeIdentity(path, expectedIdentifier, expectedTeamIdentifier, root) {
  if (!teamIdentifierPattern.test(expectedTeamIdentifier ?? "")) return null;
  const encoded = (value) => Buffer.from(value, "utf8").toString("base64");
  const source = `
import Foundation
import Security

func decoded(_ value: String) -> String {
  String(data: Data(base64Encoded: value)!, encoding: .utf8)!
}

let path = decoded("${encoded(path)}")
let expectedIdentifier = decoded("${encoded(expectedIdentifier)}")
let expectedTeam = decoded("${encoded(expectedTeamIdentifier)}")
var staticCode: SecStaticCode?
guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, SecCSFlags(), &staticCode) == errSecSuccess,
      let staticCode else { exit(2) }
let requirementText = "identifier \\"" + expectedIdentifier + "\\" and anchor apple generic and certificate leaf[subject.OU] = \\"" + expectedTeam + "\\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
var requirement: SecRequirement?
guard SecRequirementCreateWithString(requirementText as CFString, SecCSFlags(), &requirement) == errSecSuccess,
      let requirement else { exit(3) }
let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
let validity = SecStaticCodeCheckValidity(staticCode, flags, requirement)
guard validity == errSecSuccess else { exit(4) }
var information: CFDictionary?
guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
      let values = information as? [String: Any],
      let identifier = values[kSecCodeInfoIdentifier as String] as? String,
      let teamIdentifier = values[kSecCodeInfoTeamIdentifier as String] as? String,
      let unique = values[kSecCodeInfoUnique as String] as? Data else { exit(5) }
let output: [String: Any] = [
  "codeDirectoryHash": unique.map { String(format: "%02x", $0) }.joined(),
  "identifier": identifier,
  "teamIdentifier": teamIdentifier,
  "validityStatus": validity
]
let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`;
  const result = command("/usr/bin/swift", ["-e", source], root);
  let parsed = null;
  try { parsed = JSON.parse(result.stdout.trim()); } catch {}
  if (result.status !== 0 || !exactKeys(parsed, ["codeDirectoryHash", "identifier", "teamIdentifier", "validityStatus"].sort()) ||
      parsed.identifier !== expectedIdentifier || parsed.teamIdentifier !== expectedTeamIdentifier || parsed.validityStatus !== 0 ||
      !gitObjectPattern.test(parsed.codeDirectoryHash ?? "")) return null;
  return parsed;
}

function plistValue(path, key, root) {
  const result = command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path], root);
  return result.status === 0 ? result.stdout.trim() : "";
}

function validateEmbeddedInstallerManifest(root, extractionRoot, extractedEntries, expectedVersion, expectedBuild, issues) {
  const folder = join(extractionRoot, installerFolderName);
  const manifestPath = join(folder, "RELEASE-MANIFEST.json");
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {
    issues.push("attestation.imk-installer-release-manifest-invalid");
    return;
  }
  const keys = ["build", "channel", "files", "generatedAt", "hashAlgorithm", "product", "schemaVersion", "signature", "version"].sort();
  if (!exactKeys(manifest, keys) || manifest.schemaVersion !== 1 || manifest.product !== "Lekh Keyboard" ||
      manifest.channel !== "developer-id" || manifest.version !== expectedVersion || manifest.build !== Number(expectedBuild) ||
      manifest.hashAlgorithm !== "SHA-256" || !validTimestamp(manifest.generatedAt) ||
      !exactKeys(manifest.signature, ["algorithm", "detachedSignature", "publicKey"].sort()) ||
      manifest.signature.algorithm !== "minisign" || manifest.signature.publicKey !== "lekh-release-manifest-minisign.pub" ||
      manifest.signature.detachedSignature !== "RELEASE-MANIFEST.json.minisig" || !Array.isArray(manifest.files)) {
    issues.push("attestation.imk-installer-release-manifest-schema-invalid");
    return;
  }
  const actualFiles = extractedEntries
    .filter((entry) => !entry.directory && entry.relative.startsWith(`${installerFolderName}/`))
    .map((entry) => entry.relative.slice(`${installerFolderName}/`.length))
    .filter((path) => !["RELEASE-MANIFEST.json", "RELEASE-MANIFEST.json.minisig", "SHA256SUMS.txt"].includes(path))
    .sort((left, right) => left.localeCompare(right, "en"));
  const listedFiles = manifest.files.map((entry) => entry?.path);
  if (JSON.stringify(listedFiles) !== JSON.stringify(actualFiles)) {
    issues.push("attestation.imk-installer-release-manifest-file-set-invalid");
    return;
  }
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ["bytes", "path", "sha256"].sort()) || !sha256Pattern.test(entry.sha256 ?? "") ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      issues.push("attestation.imk-installer-release-manifest-entry-invalid");
      continue;
    }
    const path = join(folder, entry.path);
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== entry.bytes || sha256File(path) !== entry.sha256) {
        issues.push("attestation.imk-installer-release-manifest-digest-invalid");
      }
    } catch {
      issues.push("attestation.imk-installer-release-manifest-digest-invalid");
    }
  }
  try {
    const committedKey = readFileSync(join(root, "public", "security", "lekh-release-manifest-minisign.pub"));
    const embeddedKey = readFileSync(join(folder, "lekh-release-manifest-minisign.pub"));
    if (!committedKey.equals(embeddedKey)) issues.push("attestation.imk-installer-release-public-key-mismatch");
  } catch {
    issues.push("attestation.imk-installer-release-public-key-mismatch");
  }
}

function validateEmbeddedInstallerChecksums(extractionRoot, extractedEntries, issues) {
  const folder = join(extractionRoot, installerFolderName);
  const expectedFiles = extractedEntries
    .filter((entry) => !entry.directory && entry.relative.startsWith(`${installerFolderName}/`))
    .map((entry) => entry.relative.slice(`${installerFolderName}/`.length))
    .filter((path) => path !== "SHA256SUMS.txt")
    .sort((left, right) => left.localeCompare(right, "en"));
  let lines = [];
  try {
    lines = readFileSync(join(folder, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/u);
  } catch {
    issues.push("attestation.imk-installer-checksums-invalid");
    return;
  }
  if (lines.length !== expectedFiles.length) {
    issues.push("attestation.imk-installer-checksum-file-set-invalid");
    return;
  }
  const parsed = lines.map((line) => /^([a-f0-9]{64})  (.+)$/u.exec(line));
  if (parsed.some((match) => match === null) ||
      JSON.stringify(parsed.map((match) => match[2])) !== JSON.stringify(expectedFiles)) {
    issues.push("attestation.imk-installer-checksum-file-set-invalid");
    return;
  }
  for (const match of parsed) {
    const path = match[2];
    if (!safeZipEntry(`${installerFolderName}/${path}`)) {
      issues.push("attestation.imk-installer-checksum-path-invalid");
      continue;
    }
    try {
      if (sha256File(join(folder, path)) !== match[1]) {
        issues.push("attestation.imk-installer-checksum-digest-invalid");
      }
    } catch {
      issues.push("attestation.imk-installer-checksum-digest-invalid");
    }
  }
}

export function inspectProductionIMKInstallerArchive({
  root,
  zipPath,
  expectedTeamIdentifier,
  expectedVersion
}) {
  const issues = [];
  const zipSha256Before = sha256File(zipPath);
  const entries = inspectZipEntries(zipPath, root, issues);
  let temporaryDirectory = null;
  let executableSha256 = null;
  let codeDirectoryHash = null;
  let signingClassification = "unreadable";
  let signingTeamIdentifier = null;
  let bundleIdentifier = null;
  let shortVersion = null;
  let buildVersion = null;
  let architectures = [];
  try {
    if (issues.length === 0) {
      const archiveTest = command("/usr/bin/unzip", ["-t", zipPath], root, { maxBuffer: 64 * 1024 * 1024 });
      if (archiveTest.status !== 0) issues.push("attestation.imk-installer-archive-crc-invalid");
    }
    if (issues.length === 0) {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "lekh-attested-installer-"));
      const extraction = command("/usr/bin/ditto", ["-x", "-k", "--norsrc", "--noextattr", "--noacl", zipPath, temporaryDirectory], root);
      if (extraction.status !== 0) issues.push("attestation.imk-installer-archive-extraction-invalid");
    }
    const extractedEntries = temporaryDirectory ? extractedTree(temporaryDirectory, issues) : [];
    if (temporaryDirectory && entries.length > 0) {
      const archiveSet = entries.map((entry) => entry.endsWith("/") ? entry.slice(0, -1) : entry).sort();
      const extractedSet = extractedEntries.map((entry) => entry.relative).sort();
      if (JSON.stringify(archiveSet) !== JSON.stringify(extractedSet)) {
        issues.push("attestation.imk-installer-extracted-tree-mismatch");
      }
    }
    if (temporaryDirectory) {
      const appSet = extractedEntries.filter((entry) => entry.directory && entry.relative.endsWith(".app"))
      .map((entry) => entry.relative).sort();
    if (JSON.stringify(appSet) !== JSON.stringify([...expectedApplicationIdentifiers.keys()].sort())) {
      issues.push("attestation.imk-installer-application-set-invalid");
    }
    for (const [relativeApp, identifier] of expectedApplicationIdentifiers) {
      const appPath = join(temporaryDirectory, relativeApp);
      const strict = command("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", appPath], root);
      const deep = command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], root);
      if (strict.status !== 0 || deep.status !== 0) issues.push("attestation.imk-installer-bundle-signature-invalid");
      const identity = staticCodeIdentity(appPath, identifier, expectedTeamIdentifier, root);
      if (!identity) issues.push("attestation.imk-installer-bundle-designated-requirement-invalid");
      if (relativeApp === imkRelativeApp && identity) codeDirectoryHash = identity.codeDirectoryHash;
    }
    for (const relativeApp of [installerRelativeApp, uninstallerRelativeApp]) {
      const appPath = join(temporaryDirectory, relativeApp);
      if (command("/usr/bin/xcrun", ["stapler", "validate", appPath], root).status !== 0) {
        issues.push("attestation.imk-installer-notarization-ticket-invalid");
      }
      if (command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], root).status !== 0) {
        issues.push("attestation.imk-installer-gatekeeper-assessment-invalid");
      }
    }

    const actualMachO = [];
    for (const entry of extractedEntries.filter((item) => !item.directory)) {
      const fileType = command("/usr/bin/file", ["-b", entry.absolute], root);
      if (fileType.status !== 0 || !fileType.stdout.includes("Mach-O")) continue;
      actualMachO.push(entry.relative);
      const verification = command("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", entry.absolute], root);
      const display = command("/usr/bin/codesign", ["-dvvv", entry.absolute], root);
      const displayText = `${display.stdout ?? ""}\n${display.stderr ?? ""}`;
      const signing = classifyMacOSCodeSigning(displayText);
      const lipo = command("/usr/bin/lipo", ["-archs", entry.absolute], root);
      const fileArchitectures = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/u).sort() : [];
      if (verification.status !== 0 || display.status !== 0 || signing.classification !== "developer-id-ready" ||
          signing.teamIdentifier !== expectedTeamIdentifier ||
          JSON.stringify(fileArchitectures) !== JSON.stringify(["arm64", "x86_64"])) {
        issues.push("attestation.imk-installer-signed-component-invalid");
      }
    }
    if (JSON.stringify(actualMachO.sort()) !== JSON.stringify(expectedSignedMachORelativePaths)) {
      issues.push("attestation.imk-installer-signed-component-set-invalid");
    }

    const executablePath = join(temporaryDirectory, imkRelativeExecutable);
    const plistPath = join(temporaryDirectory, imkRelativeApp, "Contents", "Info.plist");
    try { executableSha256 = sha256File(executablePath); } catch {
      issues.push("attestation.imk-installer-executable-unreadable");
    }
    const display = command("/usr/bin/codesign", ["-dvvv", "--requirements", "-", executablePath], root);
    const identityText = `${display.stdout ?? ""}\n${display.stderr ?? ""}`;
    const signing = classifyMacOSCodeSigning(identityText);
    signingClassification = signing.classification;
    signingTeamIdentifier = signing.teamIdentifier;
    if (!codeDirectoryHash) codeDirectoryHash = /(?:^|\n)CDHash=([^\s]+)/u.exec(identityText)?.[1]?.toLowerCase() ?? null;
    const lipo = command("/usr/bin/lipo", ["-archs", executablePath], root);
    architectures = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/u).sort() : [];
    bundleIdentifier = plistValue(plistPath, "CFBundleIdentifier", root) || null;
    shortVersion = plistValue(plistPath, "CFBundleShortVersionString", root) || null;
    buildVersion = plistValue(plistPath, "CFBundleVersion", root) || null;
    if (display.status !== 0 || signing.classification !== "developer-id-ready" ||
        signing.teamIdentifier !== expectedTeamIdentifier || !gitObjectPattern.test(codeDirectoryHash ?? "") ||
        bundleIdentifier !== "com.lekh.inputmethod.LekhKeyboard" || shortVersion !== expectedVersion ||
        !/^[1-9]\d*$/u.test(buildVersion ?? "") ||
        JSON.stringify(architectures) !== JSON.stringify(["arm64", "x86_64"])) {
      issues.push("attestation.imk-shipped-identity-invalid");
    }
    if (existsSync(join(temporaryDirectory, uninstallerRelativeApp, "Contents", "Resources", "Lekh Keyboard.app"))) {
      issues.push("attestation.imk-installer-uninstaller-embeds-payload");
    }
    validateEmbeddedInstallerManifest(root, temporaryDirectory, extractedEntries, expectedVersion, buildVersion, issues);
    validateEmbeddedInstallerChecksums(temporaryDirectory, extractedEntries, issues);
    }
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  try {
    const zipSha256After = sha256File(zipPath);
    if (zipSha256After !== zipSha256Before) issues.push("attestation.imk-installer-changed-during-inspection");
  } catch {
    issues.push("attestation.imk-installer-changed-during-inspection");
  }
  return Object.freeze({
    valid: issues.length === 0,
    issueCodes: Object.freeze(unique(issues)),
    executableSha256,
    codeDirectoryHash,
    signingClassification,
    signingTeamIdentifier,
    bundleIdentifier,
    shortVersion,
    buildVersion,
    architectures: Object.freeze([...architectures])
  });
}

export function verifyProductionIMKBuildAttestation({
  root,
  installerZipPath = join(root, "release", "native", "macos", "Lekh-Keyboard-Test-Installer.zip"),
  attestationBundlePath = null
}) {
  const policyResult = readProductionReleasePolicy(root);
  const repository = exactProductionRepositoryState(root);
  const issues = [...policyResult.issueCodes, ...repository.issues];
  const policy = policyResult.policy ?? {};
  const relativeZip = relative(root, resolve(installerZipPath)).split(sep).join("/");
  if (relativeZip !== "release/native/macos/Lekh-Keyboard-Test-Installer.zip") issues.push("attestation.imk-installer-path-invalid");
  const zip = safeWorkspaceFile(root, relativeZip, 2 * 1024 * 1024 * 1024, "attestation.imk-installer", issues);
  const zipSha256 = zip ? sha256File(zip.absolute) : null;
  const inspection = zip ? inspectProductionIMKInstallerArchive({
    root,
    zipPath: zip.absolute,
    expectedTeamIdentifier: policy.appleDeveloperTeamIdentifier,
    expectedVersion: repository.version
  }) : {
    issueCodes: ["attestation.imk-installer-unavailable"],
    executableSha256: null,
    codeDirectoryHash: null,
    signingClassification: "unreadable",
    signingTeamIdentifier: null,
    bundleIdentifier: null,
    shortVersion: null,
    buildVersion: null,
    architectures: []
  };
  issues.push(...inspection.issueCodes);
  const bundlePath = validateAttestationBundle(root, attestationBundlePath, issues);
  const gh = pinnedGitHubCLI(policy, issues);
  if (issues.length === 0 && gh && zipSha256) {
    const args = verificationArguments({
      artifactPath: zip.absolute,
      repository: policy.repository,
      signerWorkflow: policy.imkBuildSignerWorkflow,
      signerDigest: policy.imkBuildSignerDigest,
      sourceDigest: repository.revision,
      sourceRef: repository.sourceRef,
      bundlePath
    });
    parseVerification(command(gh, args, root), zipSha256, issues);
  }
  const verified = issues.length === 0;
  const result = Object.freeze({
    verified,
    assurance: verified ? "github-actions-slsa-v1-shipped-installer" : "unverified",
    issueCodes: unique(issues),
    gitRevision: repository.revision || null,
    gitTree: repository.tree || null,
    sourceRef: repository.sourceRef || null,
    installerZipPath: relativeZip,
    installerZipSha256: zipSha256,
    executableSha256: inspection.executableSha256,
    codeDirectoryHash: inspection.codeDirectoryHash,
    signingClassification: inspection.signingClassification,
    signingTeamIdentifier: inspection.signingTeamIdentifier,
    bundleIdentifier: inspection.bundleIdentifier,
    shortVersion: inspection.shortVersion,
    buildVersion: inspection.buildVersion,
    architectures: Object.freeze([...inspection.architectures])
  });
  if (verified) trustedIMKBuildAttestations.add(result);
  return result;
}

export function isTrustedProductionIMKBuildAttestation(value) {
  return isRecord(value) && value.verified === true && trustedIMKBuildAttestations.has(value);
}

export function verifyProductionReleaseAttestation({
  root,
  manifestPath = join(root, PRODUCTION_RELEASE_EVIDENCE_PATH),
  attestationBundlePath = null
}) {
  const policyResult = readProductionReleasePolicy(root);
  const repository = exactProductionRepositoryState(root);
  const issues = [...policyResult.issueCodes, ...repository.issues];
  const policy = policyResult.policy ?? {};
  const relativeManifest = relative(root, resolve(manifestPath)).split(sep).join("/");
  if (relativeManifest !== PRODUCTION_RELEASE_EVIDENCE_PATH) issues.push("attestation.manifest-path-invalid");
  const manifestResult = readSmallJSON(root, relativeManifest, 4 * 1024 * 1024, "attestation.manifest", issues);
  const validation = validateProductionReleaseEvidenceManifest(manifestResult.value, {
    root,
    currentRevision: repository.revision,
    currentTree: repository.tree,
    currentSourceRef: repository.sourceRef,
    currentVersion: repository.version
  });
  issues.push(...validation.issueCodes);
  const manifestSha256 = manifestResult.file ? sha256File(manifestResult.file.absolute) : null;
  const bundlePath = validateAttestationBundle(root, attestationBundlePath, issues);
  const gh = pinnedGitHubCLI(policy, issues);
  if (issues.length === 0 && gh && manifestSha256) {
    const args = verificationArguments({
      artifactPath: manifestResult.file.absolute,
      repository: policy.repository,
      signerWorkflow: policy.releaseSignerWorkflow,
      signerDigest: policy.releaseSignerDigest,
      sourceDigest: repository.revision,
      sourceRef: repository.sourceRef,
      bundlePath
    });
    parseVerification(command(gh, args, root), manifestSha256, issues);
  }
  const verified = issues.length === 0;
  const result = Object.freeze({
    verified,
    assurance: verified ? "github-actions-slsa-v1-release-evidence" : "unverified",
    issueCodes: unique(issues),
    manifestPath: relativeManifest,
    manifestSha256,
    gitRevision: repository.revision || null,
    gitTree: repository.tree || null,
    sourceRef: repository.sourceRef || null,
    reportDigests: Object.freeze({ ...validation.reportDigests }),
    artifactDigests: Object.freeze({ ...validation.artifactDigests }),
    artifactPaths: Object.freeze({ ...validation.artifactPaths })
  });
  if (verified) trustedReleaseAttestations.add(result);
  return result;
}

export function trustedAttestationBindsReport(attestation, path, root) {
  if (!isRecord(attestation) || !trustedReleaseAttestations.has(attestation) || attestation.verified !== true ||
      !sha256Pattern.test(attestation.reportDigests?.[path] ?? "")) return false;
  const issues = [];
  const file = safeWorkspaceFile(root, path, 32 * 1024 * 1024, "attestation.bound-report", issues);
  return issues.length === 0 && file !== null && sha256File(file.absolute) === attestation.reportDigests[path];
}
