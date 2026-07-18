import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateDeterministicCommunityPreviewBundle } from "./validate-community-preview-bundle.mjs";

async function createBundleFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "lekh-preview-bundle-test-"));
  const bundle = join(root, "Lekh Keyboard.imkdevbundle");
  const resources = join(bundle, "Contents", "Resources");
  const reportPath = join(root, "macos-imk-dev-package-report.json");
  await mkdir(resources, { recursive: true });
  const provenance = {
    architectures: ["arm64", "x86_64"],
    buildNumber: "47",
    gitRevision: "a".repeat(40),
    gitTree: "b".repeat(40),
    packagingScriptSha256: "c".repeat(64),
    recordType: "lekh-imk-build-provenance",
    schemaVersion: 1,
    shortVersion: "1.2.3",
    sourceFilesClean: true,
    ...overrides.provenance
  };
  await writeFile(
    join(resources, "LekhBuildProvenance.v1.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8"
  );
  const report = {
    artifact: bundle,
    buildNumber: "47",
    buildProvenance: provenance,
    experimentalNeuralTypingEnabled: false,
    neuralModelPackaged: false,
    packagedNeuralModelBytes: 0,
    productionSigningRequired: true,
    shortVersion: "1.2.3",
    signed: "ad-hoc-hardened-runtime",
    signingClassification: "ad-hoc-development",
    status: "passed-adhoc-release",
    ...overrides.report
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { bundle, reportPath, resources };
}

test("accepts a closed deterministic-only ad-hoc preview identity", async () => {
  const fixture = await createBundleFixture();
  const result = await validateDeterministicCommunityPreviewBundle({
    bundlePath: fixture.bundle,
    expectedBuildNumber: "47",
    reportPath: fixture.reportPath
  });
  assert.equal(result.versionInfo, "1.2.3+build.47");
  assert.equal(result.neuralPolicy, "deterministic-only-no-model");
});

test("rejects a stale build number", async () => {
  const fixture = await createBundleFixture();
  await assert.rejects(
    validateDeterministicCommunityPreviewBundle({
      bundlePath: fixture.bundle,
      expectedBuildNumber: "48",
      reportPath: fixture.reportPath
    }),
    /provenance/u
  );
});

test("rejects a packaged or enabled experimental neural model", async () => {
  const fixture = await createBundleFixture({
    report: {
      experimentalNeuralTypingEnabled: true,
      neuralModelPackaged: true,
      packagedNeuralModelBytes: 123
    }
  });
  await assert.rejects(
    validateDeterministicCommunityPreviewBundle({
      bundlePath: fixture.bundle,
      expectedBuildNumber: "47",
      reportPath: fixture.reportPath
    }),
    /neural typing/u
  );
});

test("rejects neural resources even when the package report claims they are absent", async () => {
  const fixture = await createBundleFixture();
  await mkdir(join(fixture.resources, "LekhNeuralTransliterator.mlmodelc"));
  await assert.rejects(
    validateDeterministicCommunityPreviewBundle({
      bundlePath: fixture.bundle,
      expectedBuildNumber: "47",
      reportPath: fixture.reportPath
    }),
    /forbidden neural resource/u
  );
});
