import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { buildMacOSReleaseVerifierScript, minisignKeyFingerprint } from "./macos-release-verifier-script.mjs";

const roots = [];
const minisign = spawnSync("sh", ["-c", "command -v minisign"], { encoding: "utf8" }).stdout.trim();
let compiledSignatureVerifier;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function signatureVerifierBinary() {
  if (compiledSignatureVerifier) return compiledSignatureVerifier;
  const root = mkdtempSync(join(tmpdir(), "lekh-signature-verifier-test-"));
  roots.push(root);
  const output = join(root, "verify-release-manifest");
  const source = join(process.cwd(), "native", "macos-imk", "skeleton", "verify-release-manifest.swift");
  const compiled = spawnSync("swiftc", ["-O", source, "-o", output], { encoding: "utf8" });
  expect(compiled.status, compiled.stderr).toBe(0);
  compiledSignatureVerifier = output;
  return output;
}

function writeSignedFixture() {
  const root = mkdtempSync(join(tmpdir(), "lekh-release-verifier-test-"));
  roots.push(root);
  const secretKey = join(root, "test.sec");
  const publicKeyPath = join(root, "generated.pub");
  const generated = spawnSync(minisign, ["-G", "-W", "-p", publicKeyPath, "-s", secretKey], { encoding: "utf8" });
  expect(generated.status, generated.stderr).toBe(0);
  const publicKey = readFileSync(publicKeyPath, "utf8").trim().split(/\r?\n/u).at(-1);
  rmSync(publicKeyPath);

  writeFileSync(join(root, "README.txt"), "trusted release\n");
  writeFileSync(join(root, "lekh-release-manifest-minisign.pub"), `untrusted comment: test key\n${publicKey}\n`);
  const signatureVerifierPath = join(root, "verify-release-manifest");
  copyFileSync(signatureVerifierBinary(), signatureVerifierPath);
  chmodSync(signatureVerifierPath, 0o755);
  const verifierPath = join(root, "Verify Lekh Release.command");
  writeFileSync(verifierPath, buildMacOSReleaseVerifierScript({
    publicKey,
    signatureVerifierPath: "verify-release-manifest",
    signatureVerifierSha256: sha256(signatureVerifierPath)
  }));
  chmodSync(verifierPath, 0o755);

  const paths = ["README.txt", "Verify Lekh Release.command", "lekh-release-manifest-minisign.pub", "verify-release-manifest"];
  const files = paths.map((path) => ({ path, bytes: statSync(join(root, path)).size, sha256: sha256(join(root, path)) }));
  const manifestPath = join(root, "RELEASE-MANIFEST.json");
  writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, hashAlgorithm: "SHA-256", files }, null, 2)}\n`);
  const signaturePath = join(root, "RELEASE-MANIFEST.json.minisig");
  const signed = spawnSync(minisign, ["-S", "-l", "-m", manifestPath, "-s", secretKey, "-x", signaturePath], { encoding: "utf8" });
  expect(signed.status, signed.stderr).toBe(0);
  rmSync(secretKey);
  writeFileSync(join(root, "SHA256SUMS.txt"), `${files.map(({ path, sha256: hash }) => `${hash}  ${path}`).join("\n")}\n`);
  return { root, verifierPath };
}

function verify({ root, verifierPath }) {
  return spawnSync("/bin/bash", [verifierPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LEKH_RELEASE_VERIFY_NONINTERACTIVE: "1" }
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  compiledSignatureVerifier = undefined;
});

describe("macOS release verifier", () => {
  it("pins a stable key fingerprint", () => {
    expect(minisignKeyFingerprint("RWTEST")).toBe(createHash("sha256").update("RWTEST").digest("hex"));
  });

  it.runIf(process.platform === "darwin" && Boolean(minisign))(
    "rejects a tampered payload even when the attacker rewrites unsigned SHA256SUMS.txt",
    () => {
      const fixture = writeSignedFixture();
      const initial = verify(fixture);
      expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);

      const readme = join(fixture.root, "README.txt");
      writeFileSync(readme, "altered release\n");
      const checksumPath = join(fixture.root, "SHA256SUMS.txt");
      const rewritten = readFileSync(checksumPath, "utf8").replace(/^[a-f0-9]{64}(?=  README\.txt$)/mu, sha256(readme));
      writeFileSync(checksumPath, rewritten);

      const tampered = verify(fixture);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("SHA-256 mismatch for README.txt");
    }
  );

  it.runIf(process.platform === "darwin" && Boolean(minisign))(
    "rejects replacement of the bundled signature verifier before trusting the manifest",
    () => {
      const fixture = writeSignedFixture();
      writeFileSync(join(fixture.root, "verify-release-manifest"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(fixture.root, "verify-release-manifest"), 0o755);
      const tampered = verify(fixture);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain("bundled signature-verifier fingerprint mismatch");
    }
  );

  it.runIf(process.platform === "darwin" && Boolean(minisign))(
    "verifies a quarantined download only after making a private metadata-clean snapshot",
    () => {
      const fixture = writeSignedFixture();
      const quarantine = "0083;00000000;LekhVerifierTest;";
      for (const path of [fixture.verifierPath, join(fixture.root, "verify-release-manifest")]) {
        const tagged = spawnSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantine, path], { encoding: "utf8" });
        expect(tagged.status, tagged.stderr).toBe(0);
      }

      const result = verify(fixture);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Creating a private metadata-clean release snapshot");
      const originalStillQuarantined = spawnSync(
        "/usr/bin/xattr",
        ["-p", "com.apple.quarantine", join(fixture.root, "verify-release-manifest")],
        { encoding: "utf8" }
      );
      expect(originalStillQuarantined.status).toBe(0);
    }
  );

  it.runIf(process.platform === "darwin" && Boolean(minisign))(
    "allows Finder metadata but still rejects every other unlisted file",
    () => {
      const fixture = writeSignedFixture();
      writeFileSync(join(fixture.root, ".DS_Store"), "finder metadata\n");
      const withFinderMetadata = verify(fixture);
      expect(withFinderMetadata.status, `${withFinderMetadata.stdout}\n${withFinderMetadata.stderr}`).toBe(0);

      writeFileSync(join(fixture.root, "unlisted-payload.txt"), "not signed\n");
      const withUnlistedPayload = verify(fixture);
      expect(withUnlistedPayload.status).not.toBe(0);
      expect(withUnlistedPayload.stderr).toContain("release has missing or unlisted files");
    }
  );

  it("keeps rollback idempotent and authenticates the private snapshot ahead of installation", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "package-macos-imk-test-installer.mjs"), "utf8");
    expect(source).toContain('if [[ "$ROLLBACK_COMPLETED" == "1" ]]');
    expect(source).toContain("trap on_exit EXIT");
    expect(source).not.toContain("trap 'rollback; cleanup' EXIT");
    expect(source.indexOf('/usr/bin/ditto --norsrc --noextattr --noacl "$SOURCE_RELEASE_DIR" "$STAGED_RELEASE_DIR"')).toBeLessThan(
      source.indexOf('LEKH_RELEASE_VERIFY_NONINTERACTIVE=1 "$RELEASE_VERIFIER"')
    );
    expect(source.indexOf('LEKH_RELEASE_VERIFY_NONINTERACTIVE=1 "$RELEASE_VERIFIER"')).toBeLessThan(
      source.indexOf('"$INSTALLER_BIN"')
    );
    expect(source).not.toContain("xattr -dr com.apple.quarantine");
    expect(source).toContain('"-S", "-l", "-m", releaseManifestPath');
  });
});
