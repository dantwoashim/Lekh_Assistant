import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const buildProvenanceSchemaKeys = [
  "schemaVersion", "recordType", "gitRevision", "gitTree", "sourceFilesClean",
  "shortVersion", "buildNumber", "architectures", "packagingScriptSha256"
].sort();
const gitObjectPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const codeDirectoryPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const LOCAL_PROVENANCE_ASSURANCE = "local-unattested";

function exactKeys(value, expected) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === expected.join("\0");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readInstalledImkBuildProvenance({ root, appBundle, bundleIdentity }) {
  const issues = [];
  const path = join(appBundle, "Contents", "Resources", "LekhBuildProvenance.v1.json");
  let record = null;
  let manifestSha256 = null;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 16_384) {
      issues.push("build-provenance-file-invalid");
    } else {
      const bytes = readFileSync(path);
      manifestSha256 = createHash("sha256").update(bytes).digest("hex");
      record = JSON.parse(bytes.toString("utf8"));
    }
  } catch {
    issues.push("build-provenance-unreadable");
  }

  if (!exactKeys(record, buildProvenanceSchemaKeys)) {
    issues.push("build-provenance-schema-invalid");
  } else {
    if (record.schemaVersion !== 1 || record.recordType !== "lekh-imk-build-provenance") {
      issues.push("build-provenance-identity-invalid");
    }
    if (!gitObjectPattern.test(record.gitRevision) || !gitObjectPattern.test(record.gitTree)) {
      issues.push("build-provenance-git-object-invalid");
    } else {
      const tree = spawnSync("/usr/bin/git", ["rev-parse", `${record.gitRevision}^{tree}`], {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe"
      });
      if (tree.status !== 0 || tree.stdout.trim() !== record.gitTree) {
        issues.push("build-provenance-git-tree-mismatch");
      }
    }
    if (record.sourceFilesClean !== true) issues.push("build-provenance-source-dirty");
    if (
      record.shortVersion !== bundleIdentity.shortVersion ||
      record.buildNumber !== bundleIdentity.buildVersion
    ) {
      issues.push("build-provenance-version-mismatch");
    }
    if (
      !Array.isArray(record.architectures) ||
      record.architectures.length < 1 ||
      record.architectures.length > 2 ||
      new Set(record.architectures).size !== record.architectures.length ||
      record.architectures.some((architecture) => !["arm64", "x86_64"].includes(architecture)) ||
      !record.architectures.includes(bundleIdentity.architecture)
    ) {
      issues.push("build-provenance-architectures-invalid");
    }
    const packageScript = join(root, "scripts", "package-macos-imk-dev.mjs");
    if (
      !sha256Pattern.test(record.packagingScriptSha256) ||
      !existsSync(packageScript) ||
      record.packagingScriptSha256 !== sha256(packageScript)
    ) {
      issues.push("build-provenance-packager-mismatch");
    }
  }

  const signature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (signature.status !== 0) issues.push("installed-bundle-signature-invalid");
  return {
    record,
    manifestSha256,
    // This proves only that the local manifest is well-formed, internally
    // consistent, and covered by the bundle signature. A bundle author can
    // sign an arbitrary executable beside an arbitrary manifest, so this is
    // deliberately not represented as source-to-binary attestation.
    manifestIntegrityVerified: issues.length === 0,
    provenanceAssurance: LOCAL_PROVENANCE_ASSURANCE,
    sourceToBinaryAttested: false,
    issues
  };
}

export function runningCodeIdentity(processIdentifier) {
  if (!Number.isInteger(processIdentifier) || processIdentifier <= 1) {
    return { status: 2, processIdentifier, identifier: null, codeDirectoryHash: null, validityStatus: null };
  }
  const helper = spawnSync("/usr/bin/swift", ["-e", `
import Foundation
import Security

let processIdentifier = Int32(${processIdentifier})
let attributes = [
  kSecGuestAttributePid as String: NSNumber(value: processIdentifier)
] as CFDictionary
var dynamicCode: SecCode?
guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &dynamicCode) == errSecSuccess,
      let dynamicCode else { exit(2) }
let validityStatus = SecCodeCheckValidity(dynamicCode, SecCSFlags(), nil)
guard validityStatus == errSecSuccess else { exit(3) }
var staticCode: SecStaticCode?
guard SecCodeCopyStaticCode(dynamicCode, SecCSFlags(), &staticCode) == errSecSuccess,
      let staticCode else { exit(4) }
var information: CFDictionary?
guard SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &information
      ) == errSecSuccess,
      let values = information as? [String: Any],
      let identifier = values[kSecCodeInfoIdentifier as String] as? String,
      let unique = values[kSecCodeInfoUnique as String] as? Data else { exit(5) }
let output: [String: Any] = [
  "processIdentifier": processIdentifier,
  "identifier": identifier,
  "codeDirectoryHash": unique.map { String(format: "%02x", $0) }.joined(),
  "validityStatus": validityStatus
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`], { encoding: "utf8", stdio: "pipe" });
  let parsed = null;
  try {
    parsed = JSON.parse(helper.stdout.trim());
  } catch {
    // Closed schema below rejects malformed dynamic-code evidence.
  }
  const valid = helper.status === 0 &&
    exactKeys(parsed, ["codeDirectoryHash", "identifier", "processIdentifier", "validityStatus"].sort()) &&
    parsed.processIdentifier === processIdentifier &&
    parsed.identifier === "com.lekh.inputmethod.LekhKeyboard" &&
    codeDirectoryPattern.test(parsed.codeDirectoryHash) &&
    parsed.validityStatus === 0;
  return {
    status: valid ? 0 : helper.status || 3,
    processIdentifier,
    identifier: valid ? parsed.identifier : null,
    codeDirectoryHash: valid ? parsed.codeDirectoryHash : null,
    validityStatus: valid ? parsed.validityStatus : null
  };
}

export function artifactProvenanceEvidence({
  root,
  appBundle,
  bundleIdentity,
  runtimeRecord,
  evidenceRevision
}) {
  const build = readInstalledImkBuildProvenance({ root, appBundle, bundleIdentity });
  const runningPath = Number.isInteger(runtimeRecord?.processIdentifier)
    ? (() => {
        const result = spawnSync("/usr/bin/swift", ["-e", `
import Darwin
import Foundation
let pid = Int32(${runtimeRecord.processIdentifier})
var buffer = [CChar](repeating: 0, count: 4096)
let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
if length > 0 { print(String(cString: buffer)) } else { exit(2) }
`], { encoding: "utf8", stdio: "pipe" });
        if (result.status !== 0) return null;
        try {
          return realpathSync(result.stdout.trim());
        } catch {
          return null;
        }
      })()
    : null;
  const runningExecutableSha256 = runningPath && existsSync(runningPath) && statSync(runningPath).isFile()
    ? sha256(runningPath)
    : null;
  const runningCode = runningCodeIdentity(runtimeRecord?.processIdentifier);
  const installedCodeDirectoryHash = bundleIdentity.codeDirectoryHash || null;
  const embeddedSourceRevision = build.record?.gitRevision ?? null;
  const evidenceRevisionMatches = build.manifestIntegrityVerified === true &&
    embeddedSourceRevision === evidenceRevision;
  const executableHashesMatch = sha256Pattern.test(bundleIdentity.executableSha256 ?? "") &&
    runningExecutableSha256 === bundleIdentity.executableSha256;
  const codeDirectoryHashesMatch = codeDirectoryPattern.test(installedCodeDirectoryHash ?? "") &&
    runningCode.status === 0 &&
    runningCode.codeDirectoryHash === installedCodeDirectoryHash;
  const buildVersionsMatch = typeof bundleIdentity.buildVersion === "string" &&
    bundleIdentity.buildVersion.length > 0 &&
    runtimeRecord?.bundleVersion === bundleIdentity.buildVersion;
  const artifactIntegrityVerified = build.manifestIntegrityVerified === true &&
    evidenceRevisionMatches &&
    executableHashesMatch &&
    codeDirectoryHashesMatch &&
    buildVersionsMatch;
  const artifactProvenance = {
    schemaVersion: 1,
    provenanceAssurance: LOCAL_PROVENANCE_ASSURANCE,
    sourceToBinaryAttested: false,
    artifactIntegrityVerified,
    embeddedManifest: build.record,
    embeddedManifestSha256: build.manifestSha256,
    embeddedManifestIntegrityVerified: build.manifestIntegrityVerified,
    embeddedSourceRevision,
    evidenceRevisionMatches,
    installedExecutableSha256: bundleIdentity.executableSha256 || null,
    runningExecutableSha256,
    executableHashesMatch,
    installedCodeDirectoryHash,
    runningCodeDirectoryHash: runningCode.codeDirectoryHash,
    codeDirectoryHashesMatch,
    installedBuildVersion: bundleIdentity.buildVersion || null,
    runningBuildVersion: runtimeRecord?.bundleVersion ?? null,
    buildVersionsMatch
  };
  return {
    artifactProvenance,
    localArtifactIntegrityVerified: artifactIntegrityVerified,
    provenanceAssurance: LOCAL_PROVENANCE_ASSURANCE,
    sourceToBinaryAttested: false,
    issues: [
      ...build.issues,
      ...(artifactProvenance.evidenceRevisionMatches ? [] : ["evidence-revision-mismatch"]),
      ...(artifactProvenance.executableHashesMatch ? [] : ["running-executable-digest-mismatch"]),
      ...(artifactProvenance.codeDirectoryHashesMatch ? [] : ["running-code-directory-mismatch"]),
      ...(artifactProvenance.buildVersionsMatch ? [] : ["running-build-version-mismatch"])
    ]
  };
}
