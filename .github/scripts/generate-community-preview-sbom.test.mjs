import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inventoryTree,
  validateArchiveEntryNames
} from "./community-preview-integrity.mjs";
import { generateCommunityPreviewSbom } from "./generate-community-preview-sbom.mjs";
import { verifyCommunityPreviewArtifact } from "./verify-community-preview-artifact.mjs";

async function createFixture(prefix = "lekh-sbom-test-") {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const inventoryRoot = join(parent, "Lekh Keyboard macOS Community Preview");
  const resources = join(inventoryRoot, "Lekh Keyboard.imkdevbundle", "Contents", "Resources");
  const artifact = join(parent, "Lekh-Keyboard-macOS-Community-Preview-UNSIGNED.zip");
  const output = join(parent, "lekh-community-preview.spdx.json");
  const packageJson = join(parent, "package.json");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "model.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(
    join(inventoryRoot, "Lekh Keyboard.imkdevbundle", "Contents", "Info.plist"),
    "<plist/>\n",
    "utf8"
  );
  await symlink(
    "Resources/model.bin",
    join(inventoryRoot, "Lekh Keyboard.imkdevbundle", "Contents", "model-current")
  );
  await writeFile(artifact, "artifact fixture whose ZIP extraction is represented by inventoryRoot\n", "utf8");
  await writeFile(
    packageJson,
    `${JSON.stringify({ name: "lekh-keyboard", version: "1.2.3", license: "MIT" })}\n`,
    "utf8"
  );
  return { artifact, inventoryRoot, output, packageJson, parent };
}

async function generateFixture(fixture) {
  return generateCommunityPreviewSbom({
    artifactPath: fixture.artifact,
    inventoryRootPath: fixture.inventoryRoot,
    outputPath: fixture.output,
    packageJsonPath: fixture.packageJson,
    repository: "lekh/test",
    revision: "a".repeat(40),
    createdAt: "2026-07-18T00:00:00.000Z",
    versionInfo: "1.2.3+build.47"
  });
}

test("generates and re-verifies an SPDX 2.3 subject digest plus closed-world extracted inventory", async () => {
  const fixture = await createFixture();
  const result = await generateFixture(fixture);
  const document = JSON.parse(await readFile(fixture.output, "utf8"));
  const expectedArtifactHash = createHash("sha256")
    .update("artifact fixture whose ZIP extraction is represented by inventoryRoot\n")
    .digest("hex");

  assert.equal(document.spdxVersion, "SPDX-2.3");
  assert.equal(document.dataLicense, "CC0-1.0");
  assert.equal(document.packages.length, 1);
  assert.equal(document.packages[0].checksums[0].checksumValue, expectedArtifactHash);
  assert.equal(document.packages[0].versionInfo, "1.2.3+build.47");
  assert.equal(document.packages[0].licenseDeclared, "NOASSERTION");
  assert.match(document.packages[0].comment, /consult the bundled LICENSE and THIRD_PARTY_NOTICES/u);
  assert.equal(document.files.length, 3);
  assert.equal(new Set(document.files.map(({ SPDXID }) => SPDXID)).size, 3);
  assert.equal(document.relationships.length, 4);
  assert.equal(result.artifactSha256, expectedArtifactHash);
  assert.equal(result.fileCount, 3);
  assert.match(result.packageVerificationCode, /^[a-f0-9]{40}$/u);

  const verified = await verifyCommunityPreviewArtifact({
    artifactPath: fixture.artifact,
    expectedBuildNumber: "47",
    inventoryRootPath: fixture.inventoryRoot,
    sbomPath: fixture.output
  });
  assert.equal(verified.artifactSha256, expectedArtifactHash);
  assert.equal(verified.fileCount, 3);
});

test("refuses to describe an empty extracted distribution", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lekh-sbom-empty-test-"));
  const inventoryRoot = join(parent, "Lekh Keyboard macOS Community Preview");
  const artifact = join(parent, "preview.zip");
  const packageJson = join(parent, "package.json");
  await mkdir(inventoryRoot, { recursive: true });
  await writeFile(artifact, "artifact\n", "utf8");
  await writeFile(packageJson, '{"name":"lekh-keyboard","version":"1.0.0"}\n', "utf8");

  await assert.rejects(
    generateCommunityPreviewSbom({
      artifactPath: artifact,
      inventoryRootPath: inventoryRoot,
      outputPath: join(parent, "sbom.json"),
      packageJsonPath: packageJson,
      versionInfo: "1.0.0+build.1"
    }),
    /inventory is empty/u
  );
});

test("detects an artifact changed after its SBOM was generated", async () => {
  const fixture = await createFixture("lekh-sbom-artifact-mismatch-");
  await generateFixture(fixture);
  await writeFile(fixture.artifact, "different artifact bytes\n", "utf8");
  await assert.rejects(
    verifyCommunityPreviewArtifact({
      artifactPath: fixture.artifact,
      expectedBuildNumber: "47",
      inventoryRootPath: fixture.inventoryRoot,
      sbomPath: fixture.output
    }),
    /package SHA-256 does not match/u
  );
});

test("detects extra and changed files in the extracted ZIP inventory", async () => {
  const extraFixture = await createFixture("lekh-sbom-extra-file-");
  await generateFixture(extraFixture);
  await writeFile(join(extraFixture.inventoryRoot, "unlisted.txt"), "surprise\n", "utf8");
  await assert.rejects(
    verifyCommunityPreviewArtifact({
      artifactPath: extraFixture.artifact,
      expectedBuildNumber: "47",
      inventoryRootPath: extraFixture.inventoryRoot,
      sbomPath: extraFixture.output
    }),
    /file count does not match/u
  );

  const changedFixture = await createFixture("lekh-sbom-changed-file-");
  await generateFixture(changedFixture);
  await writeFile(
    join(changedFixture.inventoryRoot, "Lekh Keyboard.imkdevbundle", "Contents", "Resources", "model.bin"),
    "changed\n",
    "utf8"
  );
  await assert.rejects(
    verifyCommunityPreviewArtifact({
      artifactPath: changedFixture.artifact,
      expectedBuildNumber: "47",
      inventoryRootPath: changedFixture.inventoryRoot,
      sbomPath: changedFixture.output
    }),
    /checksum mismatch/u
  );
});

test("closed-world source comparison rejects a different extracted tree", async () => {
  const fixture = await createFixture("lekh-sbom-source-compare-");
  await generateFixture(fixture);
  const extractedParent = await mkdtemp(join(tmpdir(), "lekh-sbom-extracted-"));
  const extractedRoot = join(extractedParent, "Lekh Keyboard macOS Community Preview");
  const extractedResources = join(
    extractedRoot,
    "Lekh Keyboard.imkdevbundle",
    "Contents",
    "Resources"
  );
  await mkdir(extractedResources, { recursive: true });
  await copyFile(
    join(fixture.inventoryRoot, "Lekh Keyboard.imkdevbundle", "Contents", "Resources", "model.bin"),
    join(extractedResources, "model.bin")
  );
  await writeFile(join(extractedRoot, "unexpected.txt"), "extra\n", "utf8");

  await assert.rejects(
    verifyCommunityPreviewArtifact({
      artifactPath: fixture.artifact,
      expectedBuildNumber: "47",
      inventoryRootPath: extractedRoot,
      sbomPath: fixture.output,
      sourceRootPath: fixture.inventoryRoot
    }),
    /Closed-world archive inventory mismatch/u
  );
});

test("rejects absolute, escaping, and dangling symbolic links", async () => {
  for (const [name, target] of [
    ["absolute", "/tmp"],
    ["escaping", "../../outside"],
    ["dangling", "missing-target"]
  ]) {
    const parent = await mkdtemp(join(tmpdir(), `lekh-sbom-${name}-link-`));
    const root = join(parent, "Lekh Keyboard macOS Community Preview");
    await mkdir(join(root, "inside"), { recursive: true });
    await writeFile(join(root, "inside", "content.txt"), "content\n", "utf8");
    await symlink(target, join(root, `${name}-link`));
    await assert.rejects(inventoryTree(root), /symbolic link/u);
  }
});

test("rejects traversal, alternate-root, backslash, and duplicate ZIP entries", () => {
  const root = "Lekh Keyboard macOS Community Preview";
  assert.deepEqual(
    validateArchiveEntryNames([
      `${root}/`,
      `${root}/Lekh Keyboard.imkdevbundle/`,
      `${root}/Lekh Keyboard.imkdevbundle/Contents/Info.plist`
    ], root),
    { entryCount: 3, fileEntryCount: 1 }
  );
  for (const entries of [
    [`${root}/`, `../escape`],
    [`${root}/`, "/absolute"],
    [`${root}/`, `${root}\\evil`],
    [`${root}/`, `${root}/../evil`],
    [`${root}/file`, `${root}/file`],
    [`different-root/file`]
  ]) {
    assert.throws(() => validateArchiveEntryNames(entries, root), /Unsafe|outside|duplicate/u);
  }
});

test("requires versionInfo to include the actual positive build number", async () => {
  const fixture = await createFixture("lekh-sbom-invalid-version-");
  await assert.rejects(
    generateCommunityPreviewSbom({
      artifactPath: fixture.artifact,
      inventoryRootPath: fixture.inventoryRoot,
      outputPath: fixture.output,
      packageJsonPath: fixture.packageJson,
      versionInfo: "1.2.3"
    }),
    /versionInfo/u
  );
});
