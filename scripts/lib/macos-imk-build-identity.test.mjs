import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactProvenanceEvidence,
  readInstalledImkBuildProvenance,
  runningCodeIdentity
} from "./macos-imk-build-identity.mjs";

const root = process.cwd();

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe.skipIf(process.platform !== "darwin")("macOS IMK artifact identity", () => {
  it("checks local artifact integrity without attesting that the claimed source built the executable", async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "lekh-build-identity-"));
    const appBundle = join(directory, "Fixture.app");
    const macOSDirectory = join(appBundle, "Contents", "MacOS");
    const resourcesDirectory = join(appBundle, "Contents", "Resources");
    const sourcePath = join(directory, "main.swift");
    const executablePath = join(macOSDirectory, "Fixture");
    const manifestPath = join(resourcesDirectory, "LekhBuildProvenance.v1.json");
    let child = null;
    try {
      mkdirSync(macOSDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(resourcesDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(sourcePath, `
import Foundation
RunLoop.current.run(until: Date().addingTimeInterval(20))
`, { encoding: "utf8", mode: 0o600 });
      execFileSync("/usr/bin/xcrun", ["swiftc", sourcePath, "-o", executablePath]);
      chmodSync(executablePath, 0o755);
      writeFileSync(join(appBundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>com.lekh.inputmethod.LekhKeyboard</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>999</string>
</dict></plist>
`, { encoding: "utf8", mode: 0o600 });
      const gitRevision = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const gitTree = execFileSync("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      const manifest = {
        schemaVersion: 1,
        recordType: "lekh-imk-build-provenance",
        gitRevision,
        gitTree,
        sourceFilesClean: true,
        shortVersion: "0.1.0",
        buildNumber: "999",
        architectures: [process.arch === "x64" ? "x86_64" : process.arch],
        packagingScriptSha256: sha256(join(root, "scripts", "package-macos-imk-dev.mjs"))
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
      execFileSync("/usr/bin/codesign", [
        "--force", "--options", "runtime", "--sign", "-", "--timestamp=none", appBundle
      ]);
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle]);
      const signature = spawnSync("/usr/bin/codesign", ["-dvvv", executablePath], { encoding: "utf8" });
      const codeDirectoryHash = /CDHash=([^\s]+)/u.exec(signature.stderr)?.[1] ?? "";
      const bundleIdentity = {
        bundlePath: realpathSync(appBundle),
        executablePath: realpathSync(executablePath),
        bundleIdentifier: "com.lekh.inputmethod.LekhKeyboard",
        shortVersion: "0.1.0",
        buildVersion: "999",
        connectionName: "com.lekh.inputmethod.LekhKeyboard_Connection",
        executableSha256: sha256(executablePath),
        codeDirectoryHash,
        architecture: process.arch === "x64" ? "x86_64" : process.arch
      };
      const embedded = readInstalledImkBuildProvenance({ root, appBundle, bundleIdentity });
      expect(embedded.manifestIntegrityVerified).toBe(true);
      expect(embedded.provenanceAssurance).toBe("local-unattested");
      expect(embedded.sourceToBinaryAttested).toBe(false);
      expect(Object.hasOwn(embedded, "verified")).toBe(false);

      child = spawn(executablePath, [], { stdio: "ignore" });
      expect(Number.isInteger(child.pid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const dynamic = runningCodeIdentity(child.pid);
      expect(dynamic.status).toBe(0);
      expect(dynamic.codeDirectoryHash).toBe(codeDirectoryHash);
      const evidence = artifactProvenanceEvidence({
        root,
        appBundle,
        bundleIdentity,
        runtimeRecord: { processIdentifier: child.pid, bundleVersion: "999" },
        evidenceRevision: gitRevision
      });
      // Fixture is intentionally unrelated to the manifest's claimed Git
      // source. Its local signature/hash/version consistency may pass, but it
      // must never graduate into source-to-binary evidence.
      expect(evidence.localArtifactIntegrityVerified).toBe(true);
      expect(evidence.provenanceAssurance).toBe("local-unattested");
      expect(evidence.sourceToBinaryAttested).toBe(false);
      expect(Object.hasOwn(evidence, "verified")).toBe(false);
      expect(evidence.artifactProvenance.artifactIntegrityVerified).toBe(true);
      expect(evidence.artifactProvenance.embeddedManifestIntegrityVerified).toBe(true);
      expect(evidence.artifactProvenance.provenanceAssurance).toBe("local-unattested");
      expect(evidence.artifactProvenance.sourceToBinaryAttested).toBe(false);
      expect(evidence.artifactProvenance.embeddedManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(evidence.artifactProvenance.executableHashesMatch).toBe(true);
      expect(evidence.artifactProvenance.codeDirectoryHashesMatch).toBe(true);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGTERM");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
