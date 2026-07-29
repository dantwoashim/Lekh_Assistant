import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectContainedDirectoryTree
} from "./lib/neural-artifact-filesystem.mjs";

const root = realpathSync(process.cwd());
const temporaryRoots = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("neural runtime manifest conformance", () => {
  it("accepts a closed experimental Transformer-CTC runtime artifact", () => {
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const temporaryRoot = mkdtempSync(
      join(root, ".tmp", "ctc-runtime-conformance-")
    );
    temporaryRoots.push(temporaryRoot);
    const artifactRoot = join(temporaryRoot, "artifact");
    const compiledModel = join(
      artifactRoot,
      "LekhNeuralTransliterator.mlmodelc"
    );
    mkdirSync(compiledModel, { recursive: true });
    writeFileSync(join(compiledModel, "model.bin"), "ctc-model-fixture\n");
    const compiledEvidence = inspectContainedDirectoryTree(
      root,
      compiledModel,
      {
        label: "CTC fixture model",
        maxBytes: 1024 * 1024,
        maxEntries: 32
      }
    );

    const vocabulary = ctcVocabulary();
    const vocabularyPath = join(
      artifactRoot,
      "LekhNeuralTransliterator.vocab.json"
    );
    const vocabularyBytes = `${JSON.stringify(vocabulary, null, 2)}\n`;
    writeFileSync(vocabularyPath, vocabularyBytes);
    const vocabularySha256 = sha256(vocabularyBytes);
    const manifest = ctcManifest({
      compiledEvidence,
      vocabularySha256
    });
    writeFileSync(
      join(artifactRoot, "LekhNeuralTransliterator.manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    const reportPath = join(temporaryRoot, "report.json");

    const completed = spawnSync(
      process.execPath,
      [
        "scripts/check-neural-runtime-manifest-conformance.mjs",
        "--artifact-root",
        relative(root, artifactRoot),
        "--e2e-report",
        relative(root, join(temporaryRoot, "missing-e2e.json")),
        "--report",
        relative(root, reportPath)
      ],
      {
        cwd: root,
        encoding: "utf8"
      }
    );

    expect(completed.status, completed.stderr).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(report).toMatchObject({
      status: "passed-experimental",
      production: false,
      manifestSchemaVersion: 2,
      trainingRunId: "a".repeat(32),
      exportRunId: "b".repeat(32),
      evaluationBeamWidth: 8,
      nativeRuntimeBeamWidth: 8,
      failures: []
    });
    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0]).toMatchObject({
      role: "model",
      bytes: compiledEvidence.bytes,
      sha256: compiledEvidence.sha256
    });
  });
});

function ctcVocabulary() {
  const inputTokens = ["<pad>", "</s>", "<unk>", "a", "b"];
  const outputTokens = ["<ctc-blank>", "न", "े"];
  return {
    schemaVersion: 2,
    modelId: "lekh-open-vocab-ctc-transformer-v2",
    generatedAt: "2026-07-29T00:00:00Z",
    tokenization: "unicode-scalar-character",
    runtimeModelContract: "single-transformer-ctc-v1",
    input: {
      maxLength: 32,
      tokensById: inputTokens,
      idsByToken: Object.fromEntries(
        inputTokens.map((token, id) => [token, id])
      ),
      padId: 0,
      eosId: 1,
      unkId: 2
    },
    output: {
      timeSteps: 32,
      tokensById: outputTokens,
      idsByToken: Object.fromEntries(
        outputTokens.map((token, id) => [token, id])
      ),
      blankId: 0
    },
    decoder: {
      type: "ctc-prefix-beam-search",
      beamWidth: 8,
      maximumCandidates: 4,
      outputSequenceValidation: "devanagari-word-sequence-v1",
      rejectWhitespaceCandidates: true,
      rejectLatinCandidates: true
    },
    dataset: {
      manifest: "data/generated/neural-open-vocab/manifest.json",
      manifestSha256: "c".repeat(64),
      splitSha256: {
        train: "d".repeat(64),
        dev: "e".repeat(64),
        test: "f".repeat(64)
      }
    },
    nativeRuntimePolicy: {
      asyncOnly: true,
      neverInvokeInSecureFields: true,
      failOpenRawTypingOnError: true,
      neuralTailOnly: true
    }
  };
}

function ctcManifest({ compiledEvidence, vocabularySha256 }) {
  return {
    schemaVersion: 2,
    trainingRunId: "a".repeat(32),
    exportRunId: "b".repeat(32),
    selectedArtifact: "lekh-open-vocab-ctc-transformer-v2",
    runtime: "CoreML",
    runtimeModelContract: "single-transformer-ctc-v1",
    tensorContract: {
      inputIds: {
        shape: [1, 32],
        dataType: "INT32"
      },
      logits: {
        shape: [1, 32, 3],
        dataType: "FLOAT16"
      }
    },
    localOnly: true,
    neuralTailOnly: true,
    productionEligible: false,
    architecture: "fixed-shape-transformer-ctc",
    openVocabulary: true,
    tokenization: "unicode-scalar-character",
    outputSequenceValidation: "devanagari-word-sequence-v1",
    decoder: "ctc-prefix-beam-search",
    beamSearch: {
      enabled: true,
      beamWidth: 8,
      maxOutputGraphemes: 32,
      maxSteps: 32
    },
    modelBytes: compiledEvidence.bytes,
    sha256: {
      compiledModel: compiledEvidence.sha256,
      sourceCheckpoint: "1".repeat(64),
      trainingDatasetManifest: "2".repeat(64),
      vocabMetadata: vocabularySha256
    }
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
