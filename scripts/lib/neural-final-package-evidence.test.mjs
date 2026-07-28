import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectContainedDirectoryTree
} from "./neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";
import {
  buildFinalPackagedNeuralEvidence,
  NeuralFinalPackageEvidenceError,
  verifyFinalPackagedNeuralEvidence
} from "./neural-final-package-evidence.mjs";

const TRAINING_RUN_ID = "1".repeat(32);
const EXPORT_RUN_ID = "2".repeat(32);
const PROMOTION_ID = "3".repeat(64);

describe("final packaged neural evidence", () => {
  it("builds a closed deterministic block from baseline Resources bytes", () => {
    withFixture("baseline", ({ resourcesDirectory }) => {
      const evidence = buildFinalPackagedNeuralEvidence({
        resourcesDirectory
      });

      expect(evidence).toEqual({
        schemaVersion: 1,
        recordType: "lekh-final-packaged-neural-evidence",
        modelId: "lekh-open-vocab-seq2seq-v1",
        runtimeModelContract: "single-seq2seq-v1",
        trainingRunId: TRAINING_RUN_ID,
        exportRunId: EXPORT_RUN_ID,
        manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        vocabSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        artifactSetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        productionEligible: false,
        artifacts: [{
          role: "model",
          bundleName: "LekhNeuralTransliterator.mlmodelc",
          compiledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          compiledBytes: expect.any(Number)
        }],
        promotion: null
      });
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence.artifacts[0])).toBe(true);
      expect(
        verifyFinalPackagedNeuralEvidence({
          resourcesDirectory,
          evidence
        })
      ).toEqual(evidence);
    });
  });

  it("binds split artifact roles and an exact promotion receipt", () => {
    withFixture(
      "split",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        const evidence = buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath: "neural-candidate-promotion-report.json",
          promotionReceiptRoot
        });

        expect(evidence.runtimeModelContract).toBe(
          "split-attention-incremental-v1"
        );
        expect(evidence.artifacts.map(({ role }) => role)).toEqual([
          "decoderStep",
          "encoder"
        ]);
        expect(evidence.promotion).toEqual({
          promotionId: PROMOTION_ID,
          receiptSha256: sha256File(promotionReceiptPath)
        });
        expect(
          verifyFinalPackagedNeuralEvidence({
            resourcesDirectory,
            promotionReceiptPath: "neural-candidate-promotion-report.json",
            promotionReceiptRoot,
            evidence
          })
        ).toEqual(evidence);
      }
    );
  });

  it("detects compiled-model and manifest byte drift", () => {
    withFixture("baseline", ({ resourcesDirectory, modelPath, manifestPath }) => {
      const evidence = buildFinalPackagedNeuralEvidence({
        resourcesDirectory
      });
      writeFileSync(join(modelPath, "weights.bin"), "changed-model-weights");
      expect(() => verifyFinalPackagedNeuralEvidence({
        resourcesDirectory,
        evidence
      })).toThrow(/compiled model bytes do not match/u);
    });

    withFixture("baseline", ({ resourcesDirectory, manifestPath }) => {
      const evidence = buildFinalPackagedNeuralEvidence({
        resourcesDirectory
      });
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.exportRunId = "4".repeat(32);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      expect(() => verifyFinalPackagedNeuralEvidence({
        resourcesDirectory,
        evidence
      })).toThrow(/no longer matches the shipped bytes/u);
    });
  });

  it("detects promotion-receipt drift even when its identities remain valid", () => {
    withFixture(
      "split",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        const evidence = buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot
        });
        const receipt = JSON.parse(readFileSync(promotionReceiptPath, "utf8"));
        receipt.generatedAt = "2099-01-01T00:00:00.000Z";
        writeFileSync(
          promotionReceiptPath,
          `${JSON.stringify(receipt, null, 2)}\n`
        );

        expect(() => verifyFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot,
          evidence
        })).toThrow(/no longer matches the shipped bytes or promotion receipt/u);
      }
    );
  });

  it("rejects open evidence schemas and receipts for another artifact set", () => {
    withFixture("baseline", ({ resourcesDirectory }) => {
      const evidence = buildFinalPackagedNeuralEvidence({
        resourcesDirectory
      });
      expect(() => verifyFinalPackagedNeuralEvidence({
        resourcesDirectory,
        evidence: { ...evidence, untrusted: true }
      })).toThrow(/must contain exactly/u);
      expect(() => verifyFinalPackagedNeuralEvidence({
        resourcesDirectory,
        evidence: {
          ...evidence,
          modelId: "lekh-open-vocab-bigru-attention-v1"
        }
      })).toThrow(/does not match its runtime contract/u);
    });

    withFixture(
      "split",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        const receipt = JSON.parse(readFileSync(promotionReceiptPath, "utf8"));
        receipt.artifactSetSha256 = "f".repeat(64);
        writeFileSync(
          promotionReceiptPath,
          `${JSON.stringify(receipt, null, 2)}\n`
        );
        expect(() => buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot
        })).toThrow(/not bound to the exact packaged manifest/u);
      }
    );
  });

  it("requires promotion evidence exactly for production-eligible packages", () => {
    withFixture(
      "split",
      ({ resourcesDirectory }) => {
        expect(() => buildFinalPackagedNeuralEvidence({
          resourcesDirectory
        })).toThrow(/requires its exact promotion receipt/u);
      }
    );

    withFixture(
      "baseline",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        expect(() => buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot
        })).toThrow(/must not carry a production promotion receipt/u);
      }
    );

    withFixture(
      "baseline",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        expect(buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot
        })).toMatchObject({
          runtimeModelContract: "single-seq2seq-v1",
          productionEligible: true,
          promotion: {
            promotionId: PROMOTION_ID
          }
        });
      },
      { productionEligible: true }
    );
  });

  it("rejects a copied or renamed promotion receipt", () => {
    withFixture(
      "split",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        const renamed = join(promotionReceiptRoot, "copied-receipt.json");
        writeFileSync(renamed, readFileSync(promotionReceiptPath));
        expect(() => buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath: renamed,
          promotionReceiptRoot
        })).toThrow(/canonical filename/u);
      }
    );
  });

  it("rejects obsolete receipt schemas and malformed UTF-8", () => {
    withFixture(
      "split",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        const receipt = JSON.parse(readFileSync(promotionReceiptPath, "utf8"));
        receipt.schemaVersion = 1;
        writeFileSync(
          promotionReceiptPath,
          `${JSON.stringify(receipt, null, 2)}\n`
        );
        expect(() => buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot
        })).toThrow(/not bound to the exact packaged manifest/u);
      }
    );

    withFixture(
      "split",
      ({ resourcesDirectory, promotionReceiptPath, promotionReceiptRoot }) => {
        writeFileSync(
          promotionReceiptPath,
          Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])
        );
        expect(() => buildFinalPackagedNeuralEvidence({
          resourcesDirectory,
          promotionReceiptPath,
          promotionReceiptRoot
        })).toThrow(/not strict UTF-8 JSON/u);
      }
    );
  });
});

function withFixture(kind, callback, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-final-neural-evidence-"));
  const rootAlias = join(parent, "fixture");
  mkdirSync(rootAlias, { recursive: true });
  const root = realpathSync(rootAlias);
  try {
    const resourcesDirectory = join(
      root,
      "Lekh Keyboard.imkdevbundle",
      "Contents",
      "Resources"
    );
    mkdirSync(resourcesDirectory, { recursive: true });
    const manifestPath = join(
      resourcesDirectory,
      "LekhNeuralTransliterator.manifest.json"
    );
    const vocabPath = join(
      resourcesDirectory,
      "LekhNeuralTransliterator.vocab.json"
    );
    writeFileSync(vocabPath, "{\"schemaVersion\":1,\"tokens\":[\"अ\"]}\n");

    const manifest = {
      schemaVersion: 2,
      productionEligible:
        options.productionEligible ?? (kind === "split"),
      localOnly: true,
      neuralTailOnly: true,
      openVocabulary: true,
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
      modelBytes: 0,
      sha256: {
        sourceCheckpoint: "a".repeat(64),
        trainingDatasetManifest: "b".repeat(64),
        vocabMetadata: sha256File(vocabPath)
      }
    };
    let modelPath;
    if (kind === "baseline") {
      modelPath = join(
        resourcesDirectory,
        "LekhNeuralTransliterator.mlmodelc"
      );
      writeTree(modelPath, "baseline");
      const compiled = inspectContainedDirectoryTree(root, modelPath);
      manifest.selectedArtifact = "lekh-open-vocab-seq2seq-v1";
      manifest.architecture = "gru-encoder-decoder-seq2seq";
      manifest.modelBytes = compiled.bytes;
      manifest.sha256.compiledModel = compiled.sha256;
    } else {
      manifest.selectedArtifact = "lekh-open-vocab-bigru-attention-v1";
      manifest.architecture =
        "bidirectional-gru-additive-attention-seq2seq";
      manifest.runtimeModelContract = "split-attention-incremental-v1";
      manifest.tensorContract = {
        encoder: { inputs: {}, outputs: {} },
        decoderStep: { inputs: {}, outputs: {} }
      };
      manifest.compiledModels = {};
      manifest.sha256.compiledModels = {};
      manifest.sha256.mlpackages = {};
      for (const [role, suffix] of [
        ["encoder", "Encoder"],
        ["decoderStep", "DecoderStep"]
      ]) {
        const compiledPath = join(
          resourcesDirectory,
          `LekhNeuralTransliterator${suffix}.mlmodelc`
        );
        writeTree(compiledPath, `compiled-${role}`);
        const compiled = inspectContainedDirectoryTree(root, compiledPath);
        const packageSha256 = role === "encoder"
          ? "c".repeat(64)
          : "d".repeat(64);
        manifest.compiledModels[role] = {
          role,
          compiledModel:
            `candidate/LekhNeuralTransliterator${suffix}.mlmodelc`,
          compiledBytes: compiled.bytes,
          compiledSha256: compiled.sha256,
          mlpackage:
            `candidate/LekhNeuralTransliterator${suffix}.mlpackage`,
          mlpackageBytes: 1,
          mlpackageSha256: packageSha256
        };
        manifest.sha256.compiledModels[role] = compiled.sha256;
        manifest.sha256.mlpackages[role] = packageSha256;
        manifest.modelBytes += compiled.bytes;
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const descriptor = resolveNeuralArtifactDescriptor({
      repoRoot: resourcesDirectory,
      manifestPath,
      vocabPath,
      artifactDirectory: resourcesDirectory,
      verifyExportArtifacts: false
    });
    const promotionReceiptRoot = join(root, "promotion");
    const promotionReceiptPath = join(
      promotionReceiptRoot,
      "neural-candidate-promotion-report.json"
    );
    mkdirSync(dirname(promotionReceiptPath), { recursive: true });
    writeFileSync(
      promotionReceiptPath,
      `${JSON.stringify({
        schemaVersion: 2,
        status: "passed-neural-candidate-promotion",
        generatedAt: "2026-07-24T00:00:00.000Z",
        promotionId: PROMOTION_ID,
        trainingRunId: TRAINING_RUN_ID,
        exportRunId: EXPORT_RUN_ID,
        candidateImmutable: true,
        artifactSetSha256: descriptor.artifactSetSha256,
        productionManifest: {
          sha256: descriptor.manifestSha256
        }
      }, null, 2)}\n`
    );

    callback({
      root,
      resourcesDirectory,
      manifestPath,
      vocabPath,
      modelPath,
      promotionReceiptPath,
      promotionReceiptRoot
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function writeTree(directory, seed) {
  mkdirSync(join(directory, "coreml"), { recursive: true });
  writeFileSync(join(directory, "model.mil"), `${seed}-program`);
  writeFileSync(join(directory, "coreml", "weights.bin"), `${seed}-weights`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
