import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "scripts", "package-macos-imk-dev.mjs"),
  "utf8"
);

describe("macOS neural packaging integration contract", () => {
  it("live-verifies promotion before applying the closed package-mode policy", () => {
    const descriptor = source.indexOf("resolveNeuralArtifactDescriptor({");
    const livePromotion = source.indexOf(
      "verifyNeuralProductionPromotionReceipt({"
    );
    const packagePolicy = source.indexOf("assertNeuralPackageModePolicy({");
    const artifactCopy = source.indexOf(
      "for (const artifact of sourceDescriptor.artifacts)"
    );

    expect(descriptor).toBeGreaterThan(-1);
    expect(livePromotion).toBeGreaterThan(descriptor);
    expect(packagePolicy).toBeGreaterThan(livePromotion);
    expect(artifactCopy).toBeGreaterThan(packagePolicy);
  });

  it("seals the copied receipt and artifacts before signing", () => {
    const artifactCopy = source.indexOf(
      "for (const artifact of sourceDescriptor.artifacts)"
    );
    const receiptCopy = source.indexOf(
      "copyFileSync(\n      neuralPromotionReceiptSourcePath"
    );
    const manifestCopy = source.indexOf(
      "copyFileSync(neuralManifestSourcePath, neuralManifestBundlePath)"
    );
    const evidenceBuild = source.indexOf(
      "buildFinalPackagedNeuralEvidence(finalEvidenceOptions)"
    );
    const evidenceWrite = source.indexOf(
      "writeFileSync(\n    neuralPackageEvidenceBundlePath"
    );
    const signing = source.indexOf('run("codesign", "codesign", signArgs)');

    expect(receiptCopy).toBeGreaterThan(artifactCopy);
    expect(manifestCopy).toBeGreaterThan(receiptCopy);
    expect(evidenceBuild).toBeGreaterThan(manifestCopy);
    expect(evidenceWrite).toBeGreaterThan(evidenceBuild);
    expect(signing).toBeGreaterThan(evidenceWrite);
  });

  it("re-verifies exact neural resources after signing and publication", () => {
    const calls = [...source.matchAll(/verifyPackagedNeuralResources\(/gu)];
    const signing = source.indexOf('run("codesign", "codesign", signArgs)');
    const atomicPublish = source.indexOf('"publish-bundle-atomic-swap"');
    const signedVerification = source.indexOf(
      "verifyPackagedNeuralResources(\n      neuralResourcesDirectory"
    );
    const publishedVerification = source.indexOf(
      "publishedNeuralEvidence = verifyPackagedNeuralResources("
    );

    expect(calls).toHaveLength(3);
    expect(signedVerification).toBeGreaterThan(signing);
    expect(publishedVerification).toBeGreaterThan(atomicPublish);
    expect(source).toContain(
      ': "published-neural-resource-verification"'
    );
  });
});
