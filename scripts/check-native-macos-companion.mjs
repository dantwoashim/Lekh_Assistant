#!/usr/bin/env node
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  findCodeSignBlockedExtendedAttributes,
  isValidCompanionBuildVersion,
  isValidCompanionShortVersion,
  parseCodeSignInspection,
  resolveCompanionBundleVersions
} from "./lib/macos-companion-package-metadata.mjs";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(root, "release", "Lekh Keyboard Companion.app");
const plistPath = join(appBundle, "Contents", "Info.plist");
const executable = join(appBundle, "Contents", "MacOS", "LekhKeyboardCompanion");
const failures = [];
const production = process.argv.includes("--production");
const requiredProductionExpectations = [
  "LEKH_EXPECTED_TEAM_ID",
  "LEKH_EXPECTED_SHORT_VERSION",
  "LEKH_EXPECTED_BUILD_VERSION",
  "LEKH_EXPECTED_SOURCE_REVISION"
];
const missingProductionExpectations = production
  ? requiredProductionExpectations.filter((key) => !process.env[key])
  : [];
if (missingProductionExpectations.length > 0) {
  failures.push(`Production verification requires explicit trust anchors: ${missingProductionExpectations.join(", ")}.`);
}
if (production && process.env.LEKH_EXPECTED_TEAM_ID && !/^[A-Z0-9]{10}$/.test(process.env.LEKH_EXPECTED_TEAM_ID)) {
  failures.push("LEKH_EXPECTED_TEAM_ID must be an exact 10-character Apple Team ID.");
}
if (production && process.env.LEKH_EXPECTED_SHORT_VERSION && !isValidCompanionShortVersion(process.env.LEKH_EXPECTED_SHORT_VERSION)) {
  failures.push("LEKH_EXPECTED_SHORT_VERSION is not a canonical three-part version.");
}
if (production && process.env.LEKH_EXPECTED_BUILD_VERSION && !isValidCompanionBuildVersion(process.env.LEKH_EXPECTED_BUILD_VERSION)) {
  failures.push("LEKH_EXPECTED_BUILD_VERSION is not a canonical positive integer build.");
}
if (production && process.env.LEKH_EXPECTED_SOURCE_REVISION && !/^[0-9a-f]{40}$/i.test(process.env.LEKH_EXPECTED_SOURCE_REVISION)) {
  failures.push("LEKH_EXPECTED_SOURCE_REVISION must be an exact 40-hex Git commit.");
}

function sha256File(path) {
  const result = spawnSync("/usr/bin/shasum", ["-a", "256", path], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`Could not hash ${path}: ${result.stderr || result.stdout}`.trim());
    return null;
  }
  return result.stdout.trim().split(/\s+/)[0] ?? null;
}

function codeSignIdentityAt(path, { requireDesignatedRequirement = false } = {}) {
  if (!existsSync(path)) return null;
  const display = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", path], { encoding: "utf8" });
  const requirement = spawnSync("/usr/bin/codesign", ["-d", "-r-", path], { encoding: "utf8" });
  if (display.status !== 0 || (requireDesignatedRequirement && requirement.status !== 0)) {
    failures.push(`Could not inspect delivered code identity: ${display.stderr || requirement.stderr}`.trim());
    return null;
  }
  return parseCodeSignInspection(`${display.stdout}${display.stderr}\n${requirement.stdout}${requirement.stderr}`);
}

function artifactIdentityAt(path) {
  const pathExecutable = join(path, "Contents", "MacOS", "LekhKeyboardCompanion");
  const pathPlist = join(path, "Contents", "Info.plist");
  if (!existsSync(pathExecutable) || !existsSync(pathPlist)) return null;
  return {
    ...codeSignIdentityAt(path, { requireDesignatedRequirement: true }),
    executableSha256: sha256File(pathExecutable),
    infoPlistSha256: sha256File(pathPlist)
  };
}

function sameCodeSignIdentity(left, right) {
  if (!left || !right) return false;
  return [
    "identifier",
    "codeDirectoryHash",
    "teamIdentifier",
    "signingKind",
    "designatedRequirement",
    "secureTimestamp",
    "timestamp"
  ].every((field) => left[field] === right[field]);
}

function deliveredArtifactIdentity() {
  return artifactIdentityAt(appBundle);
}

function sameArtifactIdentity(left, right) {
  if (!left || !right) return false;
  return [
    "identifier",
    "codeDirectoryHash",
    "teamIdentifier",
    "signingKind",
    "designatedRequirement",
    "hardenedRuntime",
    "secureTimestamp",
    "timestamp",
    "executableSha256",
    "infoPlistSha256"
  ].every((field) => left[field] === right[field]);
}

function inspectDmgEmbeddedCompanion(dmgPath) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "lekh-companion-dmg-check-"));
  const mountPoint = join(temporaryRoot, "volume");
  mkdirSync(mountPoint);
  try {
    const attach = spawnSync("hdiutil", [
      "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint, dmgPath
    ], { encoding: "utf8", timeout: 120_000 });
    if (attach.status !== 0) {
      failures.push(`Could not mount delivered DMG read-only: ${attach.stderr || attach.stdout}`.trim());
      return null;
    }
    const appEntries = readdirSync(mountPoint, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
      .map((entry) => entry.name);
    if (appEntries.length !== 1 || appEntries[0] !== "Lekh Keyboard Companion.app") {
      failures.push(`Delivered DMG must contain exactly one expected app; found ${JSON.stringify(appEntries)}.`);
      return null;
    }
    const embeddedApp = join(mountPoint, "Lekh Keyboard Companion.app");
    if (!existsSync(embeddedApp)) {
      failures.push("Delivered DMG does not contain Lekh Keyboard Companion.app at its root.");
      return null;
    }
    const strictSignature = spawnSync("codesign", [
      "--verify", "--deep", "--strict", "--verbose=2", embeddedApp
    ], { encoding: "utf8" });
    const ticket = spawnSync("xcrun", ["stapler", "validate", embeddedApp], { encoding: "utf8" });
    const gatekeeper = spawnSync("spctl", [
      "--assess", "--type", "execute", "--verbose=2", embeddedApp
    ], { encoding: "utf8" });
    if (strictSignature.status !== 0) failures.push("DMG embedded app strict code-signature validation failed.");
    if (ticket.status !== 0) failures.push("DMG embedded app stapled-ticket validation failed.");
    if (gatekeeper.status !== 0) failures.push("DMG embedded app Gatekeeper assessment failed.");
    return artifactIdentityAt(embeddedApp);
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8", timeout: 120_000 });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function plistValue(key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`Could not read ${key} from delivered Info.plist: ${result.stderr || result.stdout}`.trim());
    return null;
  }
  return result.stdout.trim();
}

function latestSuccessfulPackageReport() {
  const reports = [
    join(root, "reports", "macos-native-signed-package-report.json"),
    join(root, "reports", "macos-native-unsigned-package-report.json")
  ].flatMap((path) => {
    if (!existsSync(path)) return [];
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!String(value.status).startsWith("passed-") || value.appBundle !== appBundle) return [];
      if (production && value.testMode === true) return [];
      return [{ path, value }];
    } catch (error) {
      failures.push(`Could not parse companion package report ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
  return reports.sort((left, right) => {
    const leftTime = Date.parse(left.value.generatedAt) || 0;
    const rightTime = Date.parse(right.value.generatedAt) || 0;
    return rightTime - leftTime;
  })[0] ?? null;
}

function fallbackBundleVersions() {
  try {
    const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    let gitCount = null;
    if (!Object.prototype.hasOwnProperty.call(process.env, "LEKH_APP_BUILD")) {
      const result = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git rev-list failed");
      gitCount = result.stdout.trim();
    }
    return resolveCompanionBundleVersions({ environment: process.env, packageVersion, gitCount });
  } catch (error) {
    failures.push(`Could not derive expected companion versions: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

if (!existsSync(appBundle)) failures.push("Native companion app bundle is missing.");
if (existsSync(appBundle) && lstatSync(appBundle).isSymbolicLink()) {
  failures.push("Native companion app bundle path must not be a symbolic link.");
}
if (!existsSync(plistPath)) failures.push("Native companion Info.plist is missing.");
if (!existsSync(executable)) failures.push("Native companion executable is missing.");

let plist = "";
let shortVersion = null;
let buildVersion = null;
let embeddedSourceRevision = null;
let embeddedSourceTreeClean = null;
if (existsSync(plistPath)) {
  plist = readFileSync(plistPath, "utf8");
  shortVersion = plistValue("CFBundleShortVersionString");
  buildVersion = plistValue("CFBundleVersion");
  embeddedSourceRevision = plistValue("LekhSourceRevision");
  embeddedSourceTreeClean = plistValue("LekhSourceTreeClean") === "true";
  if (!isValidCompanionShortVersion(shortVersion)) {
    failures.push(`CFBundleShortVersionString is invalid: ${JSON.stringify(shortVersion)}.`);
  }
  if (!isValidCompanionBuildVersion(buildVersion)) {
    failures.push(`CFBundleVersion is invalid: ${JSON.stringify(buildVersion)}.`);
  }
  if (!plist.includes("public.app-category.utilities")) failures.push("Companion must use the Utilities app category.");
  if (plist.includes("NSAllowsArbitraryLoads")) failures.push("Companion must not allow arbitrary network loads.");
  for (const key of [
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSLocationUsageDescription"
  ]) {
    if (plist.includes(`<key>${key}</key>`)) failures.push(`Companion declares unused hardware capability ${key}.`);
  }
}

const packageReport = latestSuccessfulPackageReport();
const explicitVersionExpectation = production ||
  Object.prototype.hasOwnProperty.call(process.env, "LEKH_APP_SHORT_VERSION") ||
  Object.prototype.hasOwnProperty.call(process.env, "LEKH_APP_BUILD");
const expectedVersions = production
  ? {
      shortVersion: process.env.LEKH_EXPECTED_SHORT_VERSION ?? null,
      buildVersion: process.env.LEKH_EXPECTED_BUILD_VERSION ?? null,
      shortVersionSource: "LEKH_EXPECTED_SHORT_VERSION",
      buildVersionSource: "LEKH_EXPECTED_BUILD_VERSION"
    }
  : explicitVersionExpectation || !packageReport
  ? fallbackBundleVersions()
  : {
      shortVersion: packageReport.value.shortVersion,
      buildVersion: packageReport.value.buildVersion,
      shortVersionSource: `package-report:${packageReport.path}`,
      buildVersionSource: `package-report:${packageReport.path}`
    };

if (packageReport) {
  if (!isValidCompanionShortVersion(packageReport.value.shortVersion)) {
    failures.push("Latest successful package report has no valid shortVersion.");
  }
  if (!isValidCompanionBuildVersion(packageReport.value.buildVersion)) {
    failures.push("Latest successful package report has no valid buildVersion.");
  }
  if (embeddedSourceRevision !== packageReport.value.sourceRevision) {
    failures.push("Delivered signed plist source revision does not match the package report.");
  }
}
if (expectedVersions && shortVersion !== expectedVersions.shortVersion) {
  failures.push(
    `Delivered CFBundleShortVersionString ${JSON.stringify(shortVersion)} does not match ${expectedVersions.shortVersionSource} value ${JSON.stringify(expectedVersions.shortVersion)}.`
  );
}
if (expectedVersions && buildVersion !== expectedVersions.buildVersion) {
  failures.push(
    `Delivered CFBundleVersion ${JSON.stringify(buildVersion)} does not match ${expectedVersions.buildVersionSource} value ${JSON.stringify(expectedVersions.buildVersion)}.`
  );
}

let architectures = [];
if (existsSync(executable)) {
  const lipo = spawnSync("lipo", ["-archs", executable], { encoding: "utf8" });
  architectures = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/).sort() : [];
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    failures.push(`Native companion must be universal; found ${architectures.join(", ") || "unknown"}.`);
  }
}

if (existsSync(join(appBundle, "Contents", "Frameworks", "Electron Framework.framework"))) {
  failures.push("macOS companion must not embed Electron Framework.");
}
if (existsSync(join(appBundle, "Contents", "Resources", "app.asar"))) {
  failures.push("macOS companion must not package a browser renderer archive.");
}

const xattrs = existsSync(appBundle)
  ? spawnSync("/usr/bin/xattr", ["-r", appBundle], { encoding: "utf8" })
  : { status: 1, stdout: "", stderr: "missing delivered app bundle" };
const blockedExtendedAttributes = xattrs.status === 0
  ? findCodeSignBlockedExtendedAttributes(xattrs.stdout)
  : [];
if (xattrs.status !== 0) failures.push(`Could not inspect delivered bundle metadata: ${xattrs.stderr}`);
if (blockedExtendedAttributes.length > 0) {
  failures.push(`Delivered bundle contains code-signing-blocked metadata: ${JSON.stringify(blockedExtendedAttributes)}.`);
}

const verify = existsSync(appBundle)
  ? spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle], { encoding: "utf8" })
  : { status: 1, stderr: "missing delivered app bundle" };
if (verify.status !== 0) failures.push(`Delivered bundle code signature verification failed: ${verify.stderr}`);

const artifactIdentity = deliveredArtifactIdentity();
let dmgArtifactIdentity = null;
if (artifactIdentity?.identifier !== "com.lekh.keyboard.companion") {
  failures.push("Delivered app code-signing identifier is not com.lekh.keyboard.companion.");
}
if (artifactIdentity?.hardenedRuntime !== true) {
  failures.push("Delivered app is missing hardened-runtime code-signing flags.");
}
const expectedArtifactIdentity = packageReport?.value?.artifactIdentity ?? null;
if (packageReport) {
  if (!expectedArtifactIdentity || typeof expectedArtifactIdentity !== "object") {
    failures.push("Latest successful package report is not bound to an artifactIdentity.");
  } else if (artifactIdentity) {
    for (const field of [
      "identifier",
      "codeDirectoryHash",
      "teamIdentifier",
      "signingKind",
      "designatedRequirement",
      "hardenedRuntime",
      "secureTimestamp",
      "timestamp",
      "executableSha256",
      "infoPlistSha256"
    ]) {
      if (artifactIdentity[field] !== expectedArtifactIdentity[field]) {
        failures.push(`Delivered artifact ${field} does not match the package report.`);
      }
    }
  }
  if (packageReport.value.signed === true) {
    if (packageReport.value.status !== "passed-signed-notarized") {
      failures.push("Signed package report does not carry passed-signed-notarized status.");
    }
    if (
      artifactIdentity?.identifier !== "com.lekh.keyboard.companion" ||
      artifactIdentity.signingKind !== "developer-id" ||
      !artifactIdentity.teamIdentifier ||
      artifactIdentity.hardenedRuntime !== true ||
      artifactIdentity.secureTimestamp !== true
    ) {
      failures.push("Signed package report is not backed by the required timestamped, hardened Developer ID app identity.");
    }
    if (packageReport.value.sourceTreeClean !== true || !/^[0-9a-f]{40}$/i.test(packageReport.value.sourceRevision ?? "")) {
      failures.push("Signed package report lacks clean, commit-bound source provenance.");
    }
    const notarization = packageReport.value.notarization;
    const requiredNotarizationFacts = [
      "appSubmitted",
      "appTicketStapledAndValidated",
      "appGatekeeperAccepted",
      "dmgSubmitted",
      "dmgSigned",
      "dmgTicketStapledAndValidated",
      "dmgGatekeeperAccepted"
    ];
    if (!notarization || requiredNotarizationFacts.some((field) => notarization[field] !== true)) {
      failures.push("Signed package report lacks complete app and DMG notarization evidence.");
    }
    const notarizedArtifact = packageReport.value.notarizedArtifact;
    const expectedNotarizedArtifact = join(
      root,
      "release",
      `Lekh-Keyboard-Companion-${packageReport.value.shortVersion}.dmg`
    );
    if (notarizedArtifact !== expectedNotarizedArtifact) {
      failures.push("Signed package report does not name the canonical release DMG path.");
    }
    if (!notarizedArtifact || !existsSync(notarizedArtifact)) {
      failures.push("Signed package report notarizedArtifact is missing.");
    } else {
      if (lstatSync(notarizedArtifact).isSymbolicLink()) {
        failures.push("Delivered notarized DMG path must not be a symbolic link.");
      }
      const dmgSha256 = sha256File(notarizedArtifact);
      if (!dmgSha256 || dmgSha256 !== packageReport.value.notarizedArtifactSha256) {
        failures.push("Delivered notarized DMG SHA-256 does not match the package report.");
      }
      const dmgSignature = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", notarizedArtifact], { encoding: "utf8" });
      const dmgTicket = spawnSync("xcrun", ["stapler", "validate", notarizedArtifact], { encoding: "utf8" });
      const dmgGatekeeper = spawnSync("spctl", [
        "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", notarizedArtifact
      ], { encoding: "utf8" });
      if (dmgSignature.status !== 0) failures.push("Delivered notarized DMG signature validation failed.");
      if (dmgTicket.status !== 0) failures.push("Delivered notarized DMG ticket validation failed.");
      if (dmgGatekeeper.status !== 0) failures.push("Delivered notarized DMG Gatekeeper assessment failed.");
      dmgArtifactIdentity = codeSignIdentityAt(notarizedArtifact);
      if (
        dmgArtifactIdentity?.signingKind !== "developer-id" ||
        !dmgArtifactIdentity.teamIdentifier ||
        dmgArtifactIdentity.secureTimestamp !== true
      ) {
        failures.push("Delivered notarized DMG is not signed by a timestamped Developer ID identity.");
      }
      if (!sameCodeSignIdentity(dmgArtifactIdentity, packageReport.value.dmgArtifactIdentity)) {
        failures.push("Delivered notarized DMG signer identity does not match the package report.");
      }
      const embeddedIdentity = inspectDmgEmbeddedCompanion(notarizedArtifact);
      if (!sameArtifactIdentity(embeddedIdentity, artifactIdentity)) {
        failures.push("Delivered DMG embedded app identity does not match the delivered companion app.");
      }
      if (!sameArtifactIdentity(embeddedIdentity, packageReport.value.dmgEmbeddedAppIdentity)) {
        failures.push("Delivered DMG embedded app identity does not match package-time binding evidence.");
      }
    }
  } else if (artifactIdentity?.signingKind !== "ad-hoc") {
    failures.push("Unsigned development package report is not backed by an ad-hoc delivered artifact.");
  }
}
if (production && packageReport?.value?.signed !== true) {
  failures.push("Production companion verification requires a signed, notarized package report.");
}
if (production && packageReport?.value?.signed === true) {
  const expectedTeamIdentifier = process.env.LEKH_EXPECTED_TEAM_ID;
  const expectedSourceRevision = process.env.LEKH_EXPECTED_SOURCE_REVISION;
  if (artifactIdentity?.teamIdentifier !== expectedTeamIdentifier) {
    failures.push("Delivered Developer ID Team ID does not match LEKH_EXPECTED_TEAM_ID.");
  }
  if (dmgArtifactIdentity?.teamIdentifier !== expectedTeamIdentifier) {
    failures.push("Delivered DMG Developer ID Team ID does not match LEKH_EXPECTED_TEAM_ID.");
  }
  if (packageReport.value.sourceRevision !== expectedSourceRevision) {
    failures.push("Signed package source revision does not match LEKH_EXPECTED_SOURCE_REVISION.");
  }
  if (embeddedSourceRevision !== expectedSourceRevision || embeddedSourceTreeClean !== true) {
    failures.push("Delivered signed plist does not embed the expected clean source revision.");
  }
  if (packageReport.value.shortVersion !== process.env.LEKH_EXPECTED_SHORT_VERSION) {
    failures.push("Signed package short version does not match LEKH_EXPECTED_SHORT_VERSION.");
  }
  if (packageReport.value.buildVersion !== process.env.LEKH_EXPECTED_BUILD_VERSION) {
    failures.push("Signed package build version does not match LEKH_EXPECTED_BUILD_VERSION.");
  }
  const appTicket = spawnSync("xcrun", ["stapler", "validate", appBundle], { encoding: "utf8" });
  const appGatekeeper = spawnSync("spctl", [
    "--assess", "--type", "execute", "--verbose=2", appBundle
  ], { encoding: "utf8" });
  if (appTicket.status !== 0) failures.push("Delivered app stapled-ticket validation failed.");
  if (appGatekeeper.status !== 0) failures.push("Delivered app Gatekeeper assessment failed.");
}

const size = existsSync(appBundle)
  ? Number(spawnSync("du", ["-sk", appBundle], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0] || 0) * 1024
  : 0;
if (size > 10 * 1024 * 1024) failures.push(`Native companion exceeds 10 MiB: ${size} bytes.`);

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run check:macos-companion-package",
  suite: "native-macos-companion-check",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed" : "failed",
  appBundle,
  shortVersion,
  buildVersion,
  embeddedSourceRevision,
  embeddedSourceTreeClean,
  expectedShortVersion: expectedVersions?.shortVersion ?? null,
  expectedBuildVersion: expectedVersions?.buildVersion ?? null,
  expectedVersionEvidence: explicitVersionExpectation
    ? "environment/package.json/git-count"
    : packageReport?.path ?? "package.json/git-count",
  architectures,
  bundleBytes: size,
  electronFrameworkPresent: existsSync(join(appBundle, "Contents", "Frameworks", "Electron Framework.framework")),
  metadataSafe: xattrs.status === 0 && blockedExtendedAttributes.length === 0,
  blockedExtendedAttributes,
  signatureVerifiedOnDeliveredBundle: verify.status === 0,
  production,
  artifactIdentity,
  dmgArtifactIdentity,
  packageReport: packageReport?.path ?? null,
  failures
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "macos-companion-package-check.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exit(1);
