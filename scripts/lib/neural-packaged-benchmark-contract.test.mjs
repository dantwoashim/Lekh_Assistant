import { describe, expect, it } from "vitest";
import {
  resolveNeuralPackagedBenchmarkContract
} from "./neural-packaged-benchmark-contract.mjs";

describe("resolveNeuralPackagedBenchmarkContract", () => {
  it("resolves the fixed-shape Transformer CTC single-forward contract", () => {
    const contract = resolveNeuralPackagedBenchmarkContract({
      descriptor: ctcDescriptor(),
      vocabulary: ctcVocabulary()
    });

    expect(contract).toMatchObject({
      runtimeModelContract: "single-transformer-ctc-v1",
      inputLength: 32,
      outputSteps: 32,
      outputVocabularySize: 4,
      probeInputId: 2,
      probeDecoderInputId: null,
      inputFeatureNames: ["inputIds"],
      outputFeatureNames: ["logits"],
      measurementKind: "packaged-coreml-ctc-single-forward"
    });
  });

  it("resolves the retained baseline seq2seq single-forward contract", () => {
    const contract = resolveNeuralPackagedBenchmarkContract({
      descriptor: baselineDescriptor(),
      vocabulary: baselineVocabulary()
    });

    expect(contract).toMatchObject({
      runtimeModelContract: "single-seq2seq-v1",
      inputLength: 32,
      outputSteps: 31,
      outputVocabularySize: 5,
      probeInputId: 3,
      probeDecoderInputId: 1,
      inputFeatureNames: ["decoderInputIds", "inputIds"],
      outputFeatureNames: ["logits"],
      measurementKind: "packaged-coreml-seq2seq-single-forward"
    });
  });

  it("fails closed when CTC tensor dimensions diverge from the vocabulary", () => {
    const descriptor = ctcDescriptor();
    descriptor.tensorContract.logits.shape = [1, 31, 4];
    expect(() =>
      resolveNeuralPackagedBenchmarkContract({
        descriptor,
        vocabulary: ctcVocabulary()
      })
    ).toThrow(/CTC logits tensor shape must be \[1,32,4\]/u);
  });

  it("fails closed when the packaged artifact-set identity is malformed", () => {
    const descriptor = ctcDescriptor();
    descriptor.artifactSetSha256 = "not-a-digest";
    expect(() =>
      resolveNeuralPackagedBenchmarkContract({
        descriptor,
        vocabulary: ctcVocabulary()
      })
    ).toThrow(/artifact-set SHA-256 must be a lowercase SHA-256 digest/u);
  });

  it("directs split-attention measurements to the full native benchmark", () => {
    expect(() =>
      resolveNeuralPackagedBenchmarkContract({
        descriptor: {
          modelId: "lekh-open-vocab-bigru-attention-v1",
          runtimeModelContract: "split-attention-incremental-v1"
        },
        vocabulary: {
          modelId: "lekh-open-vocab-bigru-attention-v1"
        }
      })
    ).toThrow(/benchmark-neural-native-service\.mjs/u);
  });
});

function ctcDescriptor() {
  return {
    modelId: "lekh-open-vocab-ctc-transformer-v2",
    runtimeModelContract: "single-transformer-ctc-v1",
    artifactLayout: "single-model",
    artifactSetSha256: "a".repeat(64),
    tensorContract: {
      inputIds: { shape: [1, 32], dataType: "INT32" },
      logits: { shape: [1, 32, 4], dataType: "FLOAT16" }
    },
    artifacts: [{
      role: "model",
      sourcePath: "/tmp/LekhNeuralTransliterator.mlmodelc",
      compiledSha256: "b".repeat(64),
      compiledBytes: 123
    }]
  };
}

function ctcVocabulary() {
  return {
    schemaVersion: 2,
    modelId: "lekh-open-vocab-ctc-transformer-v2",
    runtimeModelContract: "single-transformer-ctc-v1",
    input: {
      maxLength: 32,
      tokensById: ["<pad>", "</s>", "<unk>", "a"],
      unkId: 2
    },
    output: {
      timeSteps: 32,
      tokensById: ["<ctc-blank>", "न", "े", "प"]
    }
  };
}

function baselineDescriptor() {
  return {
    modelId: "lekh-open-vocab-seq2seq-v1",
    runtimeModelContract: "single-seq2seq-v1",
    artifactLayout: "single-model",
    artifactSetSha256: "c".repeat(64),
    tensorContract: null,
    artifacts: [{
      role: "model",
      sourcePath: "/tmp/LekhNeuralTransliterator.mlmodelc",
      compiledSha256: "d".repeat(64),
      compiledBytes: 456
    }]
  };
}

function baselineVocabulary() {
  return {
    schemaVersion: 1,
    modelId: "lekh-open-vocab-seq2seq-v1",
    input: {
      maxLength: 32,
      tokensById: ["<pad>", "<s>", "</s>", "<unk>", "a"],
      unkId: 3
    },
    output: {
      maxLength: 32,
      tokensById: ["<pad>", "<s>", "</s>", "<unk>", "न"],
      sosId: 1
    }
  };
}
