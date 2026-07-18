#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  discoverPortableExecutables,
  hasReleaseAliasInPath,
  isStrictDescendant,
  readPortableExecutableIdentity,
  releaseTreeContainsAlias,
  signerInventoryMatches
} from "./windows-release-evidence.mjs";

const root = process.cwd();
const startedAt = performance.now();
const releaseDir = join(root, "release");
const reportsDir = join(root, "reports");
const outputPath = join(reportsDir, "windows-release-artifacts-report.json");
const packageMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedArtifactPath = `release/Lekh-Keyboard-Companion-${packageMetadata.version}-Setup-x64.exe`;
const packageReports = [
  join(reportsDir, "windows-signed-package-report.json"),
  join(reportsDir, "windows-unsigned-package-report.json")
  ]
  .filter((path) => existsSync(path))
  .map(readPackageReport)
  .sort((left, right) =>
    right.modifiedAt - left.modifiedAt ||
    Number(right.malformed) - Number(left.malformed) ||
    right.generatedAt - left.generatedAt
  );

const selected = packageReports[0];
const validation = validatePackageEvidence(selected);
const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:windows-release",
  suite: "windows-release-artifacts",
  durationMs: Math.round(performance.now() - startedAt),
  status: validation.ok
    ? (validation.signed ? "passed-signed-release-evidence" : "passed-unsigned-dev-installer")
    : "failed",
  signed: validation.signed,
  packageReport: selected ? relative(root, selected.path) : null,
  artifact: validation.artifact,
  sourceRevision: validation.sourceRevision,
  checks: validation.checks,
  errors: validation.errors,
  note: validation.ok && !validation.signed
    ? "This is hash-bound unsigned development evidence, not a public Windows release."
    : validation.ok
      ? "The exact fresh installer and every packaged native executable passed timestamp-aware Authenticode verification during packaging."
      : "Run package:windows:unsigned for development evidence or package:windows on a clean Windows release host for signed evidence."
};

mkdirSync(reportsDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

if (!validation.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: report.status,
  artifact: validation.artifact?.path,
  sha256: validation.artifact?.sha256,
  report: relative(root, outputPath)
}, null, 2));

function readPackageReport(path) {
  const modifiedAt = statSync(path).mtimeMs;
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    const generatedAt = Date.parse(report.generatedAt);
    return Number.isFinite(generatedAt)
      ? { path, report, generatedAt, modifiedAt, malformed: false }
      : { path, report: null, generatedAt: modifiedAt, modifiedAt, malformed: true };
  } catch {
    return { path, report: null, generatedAt: modifiedAt, modifiedAt, malformed: true };
  }
}

function validatePackageEvidence(selectedReport) {
  const errors = [];
  const checks = [];
  if (!selectedReport) {
    errors.push("No Windows packaging report exists.");
    return { ok: false, signed: false, artifact: null, sourceRevision: null, checks, errors };
  }
  if (selectedReport.malformed || !selectedReport.report) {
    errors.push("The most recently written Windows packaging report is malformed or incomplete.");
    return { ok: false, signed: false, artifact: null, sourceRevision: null, checks, errors };
  }

  const { report } = selectedReport;
  if (report.status !== "passed-signed" && report.status !== "passed-unsigned-dev") {
    errors.push(`The most recent Windows packaging attempt did not pass (${String(report.status)}).`);
    return { ok: false, signed: false, artifact: null, sourceRevision: report.sourceRevision ?? null, checks, errors };
  }
  const signed = report.status === "passed-signed" && report.signed === true;
  const artifact = report.artifact;
  if (!artifact || typeof artifact !== "object") {
    errors.push("Packaging evidence does not contain a structured artifact identity.");
    return { ok: false, signed, artifact: null, sourceRevision: report.sourceRevision ?? null, checks, errors };
  }
  if (artifact.path !== expectedArtifactPath) {
    errors.push(`Expected exact artifact ${expectedArtifactPath}, received ${String(artifact.path)}.`);
  } else {
    checks.push("exact-versioned-artifact-path");
  }

  const absoluteArtifact = resolve(root, String(artifact.path));
  if (!isStrictDescendant(releaseDir, absoluteArtifact) || !existsSync(absoluteArtifact) ||
      hasReleaseAliasInPath(releaseDir, absoluteArtifact)) {
    errors.push("The recorded installer is missing or escapes release/.");
  } else {
    const currentStat = statSync(absoluteArtifact);
    const currentHash = sha256File(absoluteArtifact);
    if (!currentStat.isFile() || currentStat.size !== artifact.bytes || currentHash !== artifact.sha256) {
      errors.push("The installer no longer matches the byte length and SHA-256 recorded by packaging.");
    } else {
      checks.push("artifact-size-and-sha256-bound");
    }
    const modifiedAt = Date.parse(artifact.modifiedAt);
    if (!Number.isFinite(modifiedAt) || Math.abs(currentStat.mtimeMs - modifiedAt) > 2_000 ||
        selectedReport.generatedAt + 2_000 < currentStat.mtimeMs) {
      errors.push("The artifact freshness timestamps do not match the packaging invocation.");
    } else {
      checks.push("artifact-freshness-bound");
    }
  }

  const requiredInventory = new Set([
    expectedArtifactPath,
    "release/win-unpacked/Lekh Keyboard Companion.exe",
    "release/win-unpacked/resources/native/windows-tsf/build/bin/Release/LekhTextService.dll",
    "release/win-unpacked/resources/native/windows-tsf/build-Win32/bin/Release/LekhTextService.dll",
    "release/win-unpacked/resources/native/windows-tsf/build/bin/Release/LekhPipeBroker.exe"
  ]);
  const recordedInventory = Array.isArray(report.binaryInventory) ? report.binaryInventory : [];
  if (report.releaseArtifactsRemainedStable !== true) {
    errors.push("Packaging did not prove that release artifacts remained stable through final verification.");
  }
  const recordedPaths = new Set(recordedInventory.map((entry) => entry?.path));
  if (recordedPaths.size !== recordedInventory.length || recordedPaths.has(undefined)) {
    errors.push("Packaging inventory contains duplicate or invalid artifact paths.");
  }
  for (const expected of requiredInventory) {
    if (!recordedPaths.has(expected)) {
      errors.push(`Packaging inventory is missing ${expected}.`);
    }
  }

  let currentExecutablePaths = [];
  try {
    if (releaseTreeContainsAlias(join(releaseDir, "win-unpacked"))) {
      throw new Error("The unpacked release contains a filesystem alias or Windows reparse point.");
    }
    currentExecutablePaths = [
      expectedArtifactPath,
      ...discoverPortableExecutables(join(releaseDir, "win-unpacked")).map((file) =>
        relative(root, file).replaceAll("\\", "/")
      )
    ];
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const currentExecutableSet = new Set(currentExecutablePaths);
  for (const current of currentExecutableSet) {
    if (!recordedPaths.has(current)) errors.push(`Packaging inventory omitted executable payload: ${current}.`);
  }
  for (const recorded of recordedPaths) {
    if (typeof recorded === "string" && !currentExecutableSet.has(recorded)) {
      errors.push(`Packaging inventory records a stale or non-executable payload: ${recorded}.`);
    }
  }

  for (const expected of recordedPaths) {
    if (typeof expected !== "string") continue;
    const identity = recordedInventory.find((entry) => entry?.path === expected);
    const absolute = resolve(root, expected);
    if (!isStrictDescendant(releaseDir, absolute) || !existsSync(absolute) ||
        hasReleaseAliasInPath(releaseDir, absolute)) {
      errors.push(`Inventoried artifact is missing or escapes release/: ${expected}.`);
      continue;
    }
    const details = statSync(absolute);
    const modifiedAt = Date.parse(identity.modifiedAt);
    let executableIdentity = null;
    try {
      executableIdentity = readPortableExecutableIdentity(absolute);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (!details.isFile() || details.size !== identity.bytes || sha256File(absolute) !== identity.sha256 ||
        !Number.isFinite(modifiedAt) || Math.abs(details.mtimeMs - modifiedAt) > 2_000 ||
        !executableIdentity || executableIdentity.machineName !== identity.machine) {
      errors.push(`Inventoried artifact no longer matches size, SHA-256, or mtime: ${expected}.`);
    }
  }
  if (errors.length === 0) checks.push("closed-world-pe-inventory-size-sha256-mtime-bound");

  if (signed) {
    const verified = Array.isArray(report.signatureVerification)
      ? report.signatureVerification.filter((entry) => entry?.verified === true).map((entry) => entry.artifact)
      : [];
    if (!/^[A-F0-9]{64}$/.test(report.expectedSignerSha256 ?? "")) {
      errors.push("Signed evidence has no valid pinned SHA-256 signer certificate fingerprint.");
    }
    for (const expected of recordedPaths) {
      if (typeof expected !== "string") continue;
      if (!verified.includes(expected)) errors.push(`Missing successful Authenticode verification for ${expected}.`);
      const signer = report.signatureVerification?.find((entry) => entry?.artifact === expected);
      if (signer?.signatureValid !== true) errors.push(`Authenticode validation failed for ${expected}.`);
      if (signer?.timestampVerified !== true) {
        errors.push(`Authenticode timestamp evidence is missing for ${expected}.`);
      }
    }
    if (!signerInventoryMatches(report.signatureVerification, report.expectedSignerSha256, requiredInventory)) {
      errors.push("One or more Lekh-owned binaries were signed by a certificate other than the pinned publisher.");
    }
    if (report.packagingPlatform !== "win32") {
      errors.push("Signed release evidence was not produced on a Windows host.");
    }
    if (report.sourceWasClean !== true || report.sourceRemainedClean !== true) {
      errors.push("Signed packaging did not preserve a clean, stable source tree through final verification.");
    }
    const currentRevision = gitOutput(["rev-parse", "HEAD"]);
    if (!report.sourceRevision || report.sourceRevision !== currentRevision) {
      errors.push("The signed artifact is not bound to the current source revision.");
    }
    if (gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
      errors.push("The current source tree is dirty; signed release evidence cannot cover uncommitted changes.");
    }
    if (errors.length === 0) checks.push("timestamped-authenticode-inventory", "clean-source-revision-bound");
  } else if (report.status !== "passed-unsigned-dev" || report.signed !== false) {
    errors.push("Unsigned evidence has an inconsistent package status.");
  }

  return {
    ok: errors.length === 0,
    signed,
    artifact,
    sourceRevision: report.sourceRevision ?? null,
    checks,
    errors
  };
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  return result.status === 0 ? result.stdout.trim() : null;
}
