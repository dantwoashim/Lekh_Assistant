import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findCodeSignBlockedExtendedAttributes,
  packageShortVersion,
  parseCodeSignInspection,
  resolveCompanionBundleVersions
} from "./lib/macos-companion-package-metadata.mjs";

describe("native macOS companion package metadata", () => {
  it("derives bundle versions from package semver and git count", () => {
    expect(packageShortVersion("2.7.4-rc.3+sha.abc123")).toBe("2.7.4");
    expect(() => packageShortVersion("2.7.4-01")).toThrow();
    expect(resolveCompanionBundleVersions({
      environment: {},
      packageVersion: "0.1.0-week1",
      gitCount: "159"
    })).toEqual({
      shortVersion: "0.1.0",
      buildVersion: "159",
      shortVersionSource: "package.json",
      buildVersionSource: "git-rev-list-count"
    });
  });

  it("uses explicit release-pipeline versions without numeric coercion", () => {
    expect(resolveCompanionBundleVersions({
      environment: {
        LEKH_APP_SHORT_VERSION: "3.2.1",
        LEKH_APP_BUILD: "802"
      },
      packageVersion: "0.1.0-week1",
      gitCount: "159"
    })).toEqual({
      shortVersion: "3.2.1",
      buildVersion: "802",
      shortVersionSource: "LEKH_APP_SHORT_VERSION",
      buildVersionSource: "LEKH_APP_BUILD"
    });
  });

  it.each([
    ["1.2", "10"],
    ["01.2.3", "10"],
    ["1.2.3-beta", "10"],
    ["1.2.3</string>", "10"],
    ["1.2.3", "0"],
    ["1.2.3", "01"],
    ["1.2.3", "1.2"],
    ["1.2.3", "1234567890123456789"]
  ])("rejects unsafe or noncanonical plist versions %s / %s", (shortVersion, buildVersion) => {
    expect(() => resolveCompanionBundleVersions({
      environment: {
        LEKH_APP_SHORT_VERSION: shortVersion,
        LEKH_APP_BUILD: buildVersion
      },
      packageVersion: "0.1.0",
      gitCount: "159"
    })).toThrow();
  });

  it("reports only extended attributes that make strict code signing unsafe", () => {
    const output = [
      "/release/Lekh.app: com.apple.provenance",
      "/release/Lekh.app: com.apple.FinderInfo",
      "/release/Lekh.app: com.apple.fileprovider.fpfs#P",
      "/release/Lekh.app/Contents/icon.icns: com.apple.ResourceFork",
      "/release/Lekh.app/Contents/icon.icns: com.apple.ResourceFork"
    ].join("\n");
    expect(findCodeSignBlockedExtendedAttributes(output)).toEqual([
      { path: "/release/Lekh.app", attribute: "com.apple.FinderInfo" },
      { path: "/release/Lekh.app", attribute: "com.apple.fileprovider.fpfs#P" },
      { path: "/release/Lekh.app/Contents/icon.icns", attribute: "com.apple.ResourceFork" }
    ]);
  });

  it("parses ad-hoc and Developer ID code identity without trusting display labels", () => {
    expect(parseCodeSignInspection([
      "Executable=/release/Lekh",
      "Identifier=com.lekh.keyboard.companion",
      "CodeDirectory v=20500 size=2364 flags=0x10002(adhoc,runtime) hashes=67+3 location=embedded",
      "Signature=adhoc",
      "CDHash=abcdef0123456789",
      "TeamIdentifier=not set",
      "designated => identifier \"com.lekh.keyboard.companion\""
    ].join("\n"))).toMatchObject({
      identifier: "com.lekh.keyboard.companion",
      codeDirectoryHash: "abcdef0123456789",
      teamIdentifier: null,
      signingKind: "ad-hoc",
      hardenedRuntime: true,
      secureTimestamp: false,
      designatedRequirement: 'identifier "com.lekh.keyboard.companion"'
    });
    expect(parseCodeSignInspection([
      "Identifier=com.lekh.keyboard.companion",
      "CodeDirectory v=20500 size=2364 flags=0x10000(runtime) hashes=67+3 location=embedded",
      "Authority=Developer ID Application: Lekh Example (ABCDE12345)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=ABCDE12345",
      "Timestamp=15 Jul 2026 at 14:20:00",
      "CDHash=0123456789abcdef"
    ].join("\n"))).toMatchObject({
      identifier: "com.lekh.keyboard.companion",
      codeDirectoryHash: "0123456789abcdef",
      teamIdentifier: "ABCDE12345",
      signingKind: "developer-id",
      hardenedRuntime: true,
      secureTimestamp: true
    });
  });

  it("checks the delivered app directly and never masks it with a clean verification copy", () => {
    const packager = readFileSync("scripts/package-native-macos-companion.mjs", "utf8");
    const checker = readFileSync("scripts/check-native-macos-companion.mjs", "utf8");
    const lockHelper = readFileSync("scripts/macos-companion-publication-lock.swift", "utf8");
    expect(packager).toContain("LEKH_APP_SHORT_VERSION");
    expect(packager).toContain("LEKH_APP_BUILD");
    expect(packager).toContain("Signed releases require an explicit trusted monotonic LEKH_APP_BUILD");
    expect(packager).toContain("<key>LekhSourceRevision</key>");
    expect(packager).toContain("LEKH_NOTARY_KEYCHAIN_PROFILE");
    expect(packager).toContain("redactArgumentIndexes");
    expect(packager).toContain("secretValues");
    expect(packager).not.toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(packager).not.toContain('"--password"');
    expect(packager).toContain("signatureVerifiedOnDeliveredBundle");
    expect(packager).toContain("settledVerificationSamples");
    expect(packager).toContain("acquirePublicationLock()");
    expect(packager).toContain('openSync(publicationLockFile, "a+", 0o600)');
    expect(packager).toContain('stdio: ["ignore", "pipe", "pipe", publicationLockDescriptor]');
    expect(packager).toContain("assertPublicationLockHeld()");
    expect(packager).not.toContain("publicationLockDirectory");
    expect(lockHelper).toContain("flock(descriptor, LOCK_EX | LOCK_NB)");
    expect(lockHelper).toContain("Never call LOCK_UN here");
    expect(packager).toContain("recoverInterruptedPublication()");
    expect(packager).toContain("writePublicationTransaction(transaction)");
    expect(packager).toContain("LEKH_PACKAGE_TEST_FAULT_AFTER_APP_SWAP");
    expect(packager).toContain("LEKH_PACKAGE_TEST_FAULT_AFTER_DMG_SWAP");
    expect(packager).toContain("LEKH_PACKAGE_TEST_FAULT_AFTER_FINALIZATION_MARKER");
    expect(packager).toContain('process.env.LEKH_PACKAGE_TEST_MODE === "1"');
    expect(packager).toContain("atomicSwapBundles(deliveryExchange, deliveredAppBundle)");
    expect(packager).toContain('phase: "committed-awaiting-report"');
    expect(packager).toContain("writeJsonAtomically(reportPathForTransaction(transaction), transaction.report)");
    expect(packager).toContain("gitObjectAtRevision(sourceRevision, relativePath)");
    expect(packager).toContain("publicationState.committed = true");
    expect(packager).toContain("artifactIdentity: deliveredIdentity");
    expect(packager).toContain("dmgArtifactIdentity");
    expect(packager).toContain("notarizedArtifactSha256");
    expect(packager).not.toContain("<key>CFBundleVersion</key><string>101</string>");
    expect(checker).toContain('["--verify", "--deep", "--strict", "--verbose=2", appBundle]');
    expect(checker).toContain("signatureVerifiedOnDeliveredBundle");
    expect(checker).toContain("artifactIdentity[field] !== expectedArtifactIdentity[field]");
    expect(checker).toContain("inspectDmgEmbeddedCompanion(notarizedArtifact)");
    expect(checker).toContain("LEKH_EXPECTED_TEAM_ID");
    expect(checker).toContain("LEKH_EXPECTED_SOURCE_REVISION");
    expect(checker).toContain("Delivered app stapled-ticket validation failed");
    expect(checker).toContain("Delivered DMG Developer ID Team ID does not match LEKH_EXPECTED_TEAM_ID");
    expect(checker).toContain("Production companion verification requires a signed, notarized package report");
    expect(checker).not.toContain("verificationBundle");
    expect(checker).not.toContain("signatureVerifiedOnCleanTransportCopy");
  });
});
