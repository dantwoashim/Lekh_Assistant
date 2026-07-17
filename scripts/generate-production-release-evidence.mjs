#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PRODUCTION_ATTESTED_ARTIFACT_ROLES,
  PRODUCTION_ATTESTED_REPORT_PATHS,
  PRODUCTION_ATTESTATION_REPOSITORY,
  PRODUCTION_QA_EVIDENCE_INDEX_PATH,
  PRODUCTION_RELEASE_EVIDENCE_PATH,
  validateProductionReleaseEvidenceManifest
} from "./lib/macos-production-release-attestation.mjs";

const root = process.cwd();
const outputPath = join(root, PRODUCTION_RELEASE_EVIDENCE_PATH);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const artifactPaths = Object.freeze({
  "coreml-model-archive": "release/attestation/LekhNeuralTransliterator.mlmodelc.zip",
  "coreml-model-manifest": "release/attestation/LekhNeuralTransliterator.manifest.json",
  "dictionary-pack-release-index": "release/attestation/dictionary-packs.index.v1.json",
  "macos-installer-zip": "release/native/macos/Lekh-Keyboard-Test-Installer.zip",
  "release-manifest": "release/native/macos/RELEASE-MANIFEST.json",
  "release-manifest-signature": "release/native/macos/RELEASE-MANIFEST.json.minisig",
  "sbom-spdx": "release/attestation/lekh-release.spdx.json",
  "update-appcast": "release/native/macos/appcast.xml"
});

function fail(issueCodes) {
  const unique = [...new Set(issueCodes)].sort();
  process.stderr.write(`${JSON.stringify({ status: "failed", issueCodes: unique }, null, 2)}\n`);
  process.exit(1);
}

function git(args) {
  return spawnSync("/usr/bin/git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function regularFile(relativePath, maximumBytes, issues) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.length > 512 ||
      isAbsolute(relativePath) || relativePath.includes("\\") ||
      relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    issues.push("generator.path-invalid");
    return null;
  }
  const absolute = resolve(root, relativePath);
  try {
    const rootCanonical = realpathSync(root);
    const canonical = realpathSync(absolute);
    const metadata = lstatSync(absolute);
    if (!canonical.startsWith(`${rootCanonical}${sep}`) || !metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.size <= 0 || metadata.size > maximumBytes) {
      issues.push(`generator.file-invalid:${relativePath}`);
      return null;
    }
    return { absolute, sizeBytes: metadata.size };
  } catch {
    issues.push(`generator.file-unreadable:${relativePath}`);
    return null;
  }
}

function sha256(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
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

function indexed(relativePath, maximumBytes, issues) {
  const file = regularFile(relativePath, maximumBytes, issues);
  return file ? { path: relativePath, sha256: sha256(file.absolute), sizeBytes: file.sizeBytes } : null;
}

function embeddedInstallerManifest(issues) {
  const zip = regularFile(artifactPaths["macos-installer-zip"], 2 * 1024 * 1024 * 1024, issues);
  if (!zip) return null;
  const entry = "Lekh Keyboard Test Installer/RELEASE-MANIFEST.json";
  const result = spawnSync("/usr/bin/unzip", ["-p", zip.absolute, entry], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    issues.push("generator.installer-manifest-unreadable");
    return null;
  }
  try {
    const value = JSON.parse(result.stdout);
    if (value.channel !== "developer-id" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value.version ?? "") ||
        !Number.isSafeInteger(value.build) || value.build <= 0) {
      issues.push("generator.installer-manifest-identity-invalid");
      return null;
    }
    return value;
  } catch {
    issues.push("generator.installer-manifest-json-invalid");
    return null;
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomically(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}

const issues = [];
const revisionResult = git(["rev-parse", "HEAD"]);
const treeResult = git(["rev-parse", "HEAD^{tree}"]);
const statusResult = git([
  "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
  ":(exclude)reports/**", ":(exclude)release/**"
]);
const originResult = git(["remote", "get-url", "origin"]);
const revision = revisionResult.status === 0 ? revisionResult.stdout.trim() : "";
const tree = treeResult.status === 0 ? treeResult.stdout.trim() : "";
if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) issues.push("generator.source-identity-invalid");
if (statusResult.status !== 0 || statusResult.stdout.trim() !== "") issues.push("generator.source-worktree-dirty");
const origin = originResult.stdout.trim().replace(/^git@github\.com:/u, "https://github.com/").replace(/\.git$/u, "");
if (originResult.status !== 0 || origin !== `https://github.com/${PRODUCTION_ATTESTATION_REPOSITORY}`) {
  issues.push("generator.origin-invalid");
}

let packageVersion = "";
try { packageVersion = /^(\d+\.\d+\.\d+)/u.exec(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version)?.[1] ?? ""; }
catch { issues.push("generator.package-version-unreadable"); }
const sourceRef = `refs/tags/v${packageVersion}`;
const tagResult = git(["rev-list", "-n", "1", sourceRef]);
if (!packageVersion || tagResult.status !== 0 || tagResult.stdout.trim() !== revision) issues.push("generator.release-tag-invalid");

const installerManifest = embeddedInstallerManifest(issues);
if (installerManifest && installerManifest.version !== packageVersion) issues.push("generator.release-version-mismatch");
const companionPath = `release/Lekh-Keyboard-Companion-${packageVersion}.dmg`;
const resolvedArtifactPaths = { ...artifactPaths, "macos-companion-dmg": companionPath };

const reports = PRODUCTION_ATTESTED_REPORT_PATHS.map((path) => indexed(path, 32 * 1024 * 1024, issues));
const artifacts = PRODUCTION_ATTESTED_ARTIFACT_ROLES.map((role) => {
  const record = indexed(resolvedArtifactPaths[role], 2 * 1024 * 1024 * 1024, issues);
  return record ? { role, ...record } : null;
});
const evidenceFile = indexed(PRODUCTION_QA_EVIDENCE_INDEX_PATH, 64 * 1024 * 1024, issues);
let evidenceIndex = null;
if (evidenceFile) {
  try {
    const value = JSON.parse(readFileSync(join(root, evidenceFile.path), "utf8"));
    if (!Number.isSafeInteger(value.expectedEntryCount) || value.expectedEntryCount <= 0 ||
        !Array.isArray(value.entries) || value.entries.length !== value.expectedEntryCount) {
      issues.push("generator.evidence-index-invalid");
    } else {
      evidenceIndex = { ...evidenceFile, entryCount: value.entries.length };
    }
  } catch {
    issues.push("generator.evidence-index-unreadable");
  }
}
if (reports.some((entry) => entry === null) || artifacts.some((entry) => entry === null) || !evidenceIndex || !installerManifest) {
  issues.push("generator.required-inputs-incomplete");
}
if (issues.length > 0) fail(issues);

const manifest = {
  schemaVersion: 1,
  recordType: "lekh-production-release-evidence",
  release: {
    version: packageVersion,
    buildNumber: String(installerManifest.build),
    runIdentifier: randomUUID(),
    generatedAt: new Date().toISOString(),
    repository: PRODUCTION_ATTESTATION_REPOSITORY,
    sourceRevision: revision,
    sourceTree: tree,
    sourceRef
  },
  reports,
  artifacts,
  evidenceIndex
};
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeAtomically(outputPath, bytes);
const validation = validateProductionReleaseEvidenceManifest(manifest, {
  root,
  currentRevision: revision,
  currentTree: tree,
  currentSourceRef: sourceRef,
  currentVersion: packageVersion
});
if (!validation.valid) {
  try { unlinkSync(outputPath); } catch {}
  fail(validation.issueCodes);
}
const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
if (!sha256Pattern.test(manifestSha256)) fail(["generator.output-digest-invalid"]);
process.stdout.write(`${JSON.stringify({
  status: "passed",
  manifest: relative(root, outputPath).split(sep).join("/"),
  sha256: manifestSha256,
  reports: reports.length,
  artifacts: artifacts.length,
  evidenceEntries: evidenceIndex.entryCount
}, null, 2)}\n`);
