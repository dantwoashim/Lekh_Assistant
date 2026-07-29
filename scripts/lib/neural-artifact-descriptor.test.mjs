import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectContainedDirectoryTree } from "./neural-artifact-filesystem.mjs";
import {
  NeuralArtifactDescriptorError,
  neuralRuntimeContractMetadata,
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";

describe("neural runtime artifact descriptor", () => {
  it("maps every closed runtime contract to one artifact layout and prediction backend", () => {
    expect(neuralRuntimeContractMetadata("single-seq2seq-v1")).toEqual({
      artifactLayout: "single-model",
      predictionsBackend: "coreml-compiled-model",
      decoder: "beam-search",
      decoderStepDelta: -1
    });
    expect(
      neuralRuntimeContractMetadata("split-attention-incremental-v1")
    ).toEqual({
      artifactLayout: "split-attention",
      predictionsBackend: "coreml-compiled-split-attention-models",
      decoder: "beam-search",
      decoderStepDelta: -1
    });
    expect(
      neuralRuntimeContractMetadata("single-transformer-ctc-v1")
    ).toEqual({
      artifactLayout: "single-model",
      predictionsBackend: "coreml-compiled-transformer-ctc",
      decoder: "ctc-prefix-beam-search",
      decoderStepDelta: 0
    });
    expect(() => neuralRuntimeContractMetadata("unknown")).toThrow(
      /Unsupported neural runtime model contract unknown/u
    );
  });

  it("normalizes and hashes the baseline runtime artifact", () => {
    withFixture("baseline", ({ root, manifest, manifestPath, vocabPath }) => {
      const descriptor = resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath,
        vocabPath
      });
      expect(descriptor.runtimeModelContract).toBe("single-seq2seq-v1");
      expect(descriptor.artifacts).toHaveLength(1);
      expect(descriptor.artifacts[0].role).toBe("model");
      expect(descriptor.artifacts[0].bundleName).toBe(
        "LekhNeuralTransliterator.mlmodelc"
      );
      expect(descriptor.totalCompiledBytes).toBe(manifest.modelBytes);
      expect(descriptor.artifactSetSha256).toMatch(/^[a-f0-9]{64}$/u);
    });
  });

  it("normalizes an exact encoder/decoder-step artifact inventory", () => {
    withFixture("split", ({ root, manifest, manifestPath, vocabPath }) => {
      const descriptor = resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath,
        vocabPath
      });
      expect(descriptor.runtimeModelContract).toBe(
        "split-attention-incremental-v1"
      );
      expect(descriptor.artifacts.map(({ role }) => role)).toEqual([
        "encoder",
        "decoderStep"
      ]);
      expect(descriptor.artifacts.map(({ bundleName }) => bundleName)).toEqual([
        "LekhNeuralTransliteratorEncoder.mlmodelc",
        "LekhNeuralTransliteratorDecoderStep.mlmodelc"
      ]);
      expect(descriptor.totalCompiledBytes).toBe(manifest.modelBytes);
    });
  });

  it("normalizes the exact single-model Transformer CTC inventory", () => {
    withFixture("ctc", ({ root, manifest, manifestPath, vocabPath }) => {
      const descriptor = resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath,
        vocabPath
      });
      expect(descriptor.modelId).toBe(
        "lekh-open-vocab-ctc-transformer-v2"
      );
      expect(descriptor.runtimeModelContract).toBe(
        "single-transformer-ctc-v1"
      );
      expect(descriptor.artifactLayout).toBe("single-model");
      expect(descriptor.predictionsBackend).toBe(
        "coreml-compiled-transformer-ctc"
      );
      expect(descriptor.tensorContract).toEqual(manifest.tensorContract);
      expect(descriptor.artifacts).toHaveLength(1);
      expect(descriptor.artifacts[0]).toMatchObject({
        role: "model",
        bundleName: "LekhNeuralTransliterator.mlmodelc"
      });
      expect(descriptor.totalCompiledBytes).toBe(manifest.modelBytes);
    });
  });

  it("rejects a CTC model with a legacy or open artifact contract", () => {
    withFixture("ctc", ({ root, manifest, manifestPath, vocabPath }) => {
      delete manifest.tensorContract;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifestPath,
        vocabPath
      })).toThrow(/single-transformer-ctc artifact branch/u);
    });

    withFixture("ctc", ({ root, manifest, manifestPath, vocabPath }) => {
      manifest.compiledModels = {};
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifestPath,
        vocabPath
      })).toThrow(/single-transformer-ctc artifact branch/u);
    });
  });

  it("rejects path escapes and byte tampering", () => {
    withFixture("split", ({ root, manifest, manifestPath, vocabPath }) => {
      manifest.compiledModels.encoder.compiledModel = "../outside.mlmodelc";
      expect(() => resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath,
        vocabPath
      })).toThrow(NeuralArtifactDescriptorError);
    });

    withFixture("baseline", ({ root, manifest, manifestPath, vocabPath, modelPath }) => {
      writeFileSync(join(modelPath, "weights.bin"), "tampered");
      expect(() => resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath,
        vocabPath
      })).toThrow(/do not match manifest/u);
    });
  });

  it("rejects an in-memory manifest that is not the manifestPath content", () => {
    withFixture("baseline", ({ root, manifest, manifestPath, vocabPath }) => {
      const substituted = structuredClone(manifest);
      substituted.trainingRunId = "f".repeat(32);

      expect(() => resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest: substituted,
        manifestPath,
        vocabPath
      })).toThrow(/does not match the manifestPath bytes/u);
    });
  });

  it("rejects undeclared fields in a split artifact record", () => {
    withFixture("split", ({ root, manifest, manifestPath, vocabPath }) => {
      manifest.compiledModels.encoder.untrusted = true;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      expect(() => resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifestPath,
        vocabPath
      })).toThrow(/must contain exactly/u);
    });
  });

  it("rebinds a split manifest to the exact compiled artifacts inside a bundle", () => {
    withFixture("split", ({ root, manifest, manifestPath, vocabPath }) => {
      const source = resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath,
        vocabPath
      });
      const bundle = join(root, "bundle");
      const resources = join(bundle, "Contents", "Resources");
      mkdirSync(resources, { recursive: true });
      const packagedManifest = join(
        resources,
        "LekhNeuralTransliterator.manifest.json"
      );
      const packagedVocab = join(
        resources,
        "LekhNeuralTransliterator.vocab.json"
      );
      for (const artifact of source.artifacts) {
        cpSync(artifact.sourcePath, join(resources, artifact.bundleName), {
          recursive: true
        });
      }
      copyFileSync(vocabPath, packagedVocab);
      copyFileSync(manifestPath, packagedManifest);
      const packaged = resolveNeuralArtifactDescriptor({
        repoRoot: bundle,
        manifestPath: packagedManifest,
        vocabPath: packagedVocab,
        artifactDirectory: resources,
        verifyExportArtifacts: false
      });
      expect(packaged.artifactSetSha256).toBe(source.artifactSetSha256);
      expect(packaged.totalCompiledBytes).toBe(source.totalCompiledBytes);
    });
  });
});

function withFixture(kind, callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-neural-descriptor-"));
  const rootAlias = join(parent, "repo");
  mkdirSync(rootAlias, { recursive: true });
  const root = realpathSync(rootAlias);
  try {
    const production = join(
      root,
      "models",
      "macos",
      "LekhNeuralTransliterator.production"
    );
    mkdirSync(production, { recursive: true });
    const manifestPath = join(
      production,
      "LekhNeuralTransliterator.manifest.json"
    );
    const vocabPath = join(
      production,
      "LekhNeuralTransliterator.vocab.json"
    );
    writeFileSync(vocabPath, "{\"schemaVersion\":1}\n");
    const vocabSha256 = sha256File(vocabPath);
    const common = {
      schemaVersion: 2,
      productionEligible: true,
      modelBytes: 0,
      sha256: {
        sourceCheckpoint: "a".repeat(64),
        trainingDatasetManifest: "b".repeat(64),
        vocabMetadata: vocabSha256
      }
    };
    let modelPath;
    if (kind === "baseline" || kind === "ctc") {
      modelPath = join(production, "LekhNeuralTransliterator.mlmodelc");
      writeTree(modelPath, kind);
      const model = inspectContainedDirectoryTree(root, modelPath);
      if (kind === "ctc") {
        common.selectedArtifact = "lekh-open-vocab-ctc-transformer-v2";
        common.architecture = "fixed-shape-transformer-ctc";
        common.runtimeModelContract = "single-transformer-ctc-v1";
        common.tensorContract = {
          inputIds: { shape: [1, 32], dataType: "INT32" },
          logits: { shape: [1, 32, 128], dataType: "FLOAT16" }
        };
      } else {
        common.selectedArtifact = "lekh-open-vocab-seq2seq-v1";
        common.architecture = "gru-encoder-decoder-seq2seq";
      }
      common.modelBytes = model.bytes;
      common.sha256.compiledModel = model.sha256;
    } else {
      common.selectedArtifact = "lekh-open-vocab-bigru-attention-v1";
      common.architecture = "bidirectional-gru-additive-attention-seq2seq";
      common.runtimeModelContract = "split-attention-incremental-v1";
      common.tensorContract = {
        encoder: { inputs: {}, outputs: {} },
        decoderStep: { inputs: {}, outputs: {} }
      };
      common.compiledModels = {};
      common.sha256.compiledModels = {};
      common.sha256.mlpackages = {};
      for (const [role, suffix] of [
        ["encoder", "Encoder"],
        ["decoderStep", "DecoderStep"]
      ]) {
        const compiledModel = join(
          production,
          `LekhNeuralTransliterator${suffix}.mlmodelc`
        );
        const mlpackage = join(
          production,
          `LekhNeuralTransliterator${suffix}.mlpackage`
        );
        writeTree(compiledModel, `compiled-${role}`);
        writeTree(mlpackage, `package-${role}`);
        const compiled = inspectContainedDirectoryTree(root, compiledModel);
        const packageEvidence = inspectContainedDirectoryTree(root, mlpackage);
        common.modelBytes += compiled.bytes;
        common.compiledModels[role] = {
          role,
          compiledModel: portable(root, compiledModel),
          compiledBytes: compiled.bytes,
          compiledSha256: compiled.sha256,
          mlpackage: portable(root, mlpackage),
          mlpackageBytes: packageEvidence.bytes,
          mlpackageSha256: packageEvidence.sha256
        };
        common.sha256.compiledModels[role] = compiled.sha256;
        common.sha256.mlpackages[role] = packageEvidence.sha256;
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(common, null, 2)}\n`);
    callback({
      root,
      manifest: common,
      manifestPath,
      vocabPath,
      modelPath
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function writeTree(path, contents) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "weights.bin"), contents);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
