import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  isSupportedNeuralOutputScalarToken,
  validateNeuralVocabularyContract
} from "./neural-vocabulary-contract.mjs";

const DATASET_SHA256 = "a".repeat(64);
const SPLIT_SHA256 = Object.freeze({
  train: "b".repeat(64),
  dev: "c".repeat(64),
  test: "d".repeat(64)
});

describe("neural vocabulary semantic contract", () => {
  for (const modelId of [
    "lekh-open-vocab-seq2seq-v1",
    "lekh-open-vocab-bigru-attention-v1"
  ]) {
    it(`accepts the complete ${modelId} runtime vocabulary`, () => {
      const validation = validateNeuralVocabularyContract(
        fixture({ modelId })
      );
      assert.equal(validation.status, "passed-neural-vocabulary-contract");
      assert.deepEqual(validation.failures, []);
    });
  }

  it("requires distinct special IDs that point at exact special tokens", () => {
    const options = fixture();
    options.vocabulary.input.padId = options.vocabulary.input.sosId;
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /padId does not identify|special-token IDs must be distinct/u
    );
  });

  it("requires contiguous inverse token maps without extra keys", () => {
    const options = fixture();
    options.vocabulary.output.idsByToken["न"] = 99;
    options.vocabulary.output.idsByToken.unlisted = 5;
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /exact inverse token inventory|contiguous inverse/u
    );
  });

  it("rejects duplicate token rows even if an inverse map was edited", () => {
    const options = fixture();
    options.vocabulary.input.tokensById[5] = "a";
    delete options.vocabulary.input.idsByToken.b;
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(validation.failures.join("\n"), /duplicate tokens/u);
  });

  for (const invalidToken of [
    "क्ष",
    "a",
    "😀",
    "\uD800",
    "\uFFFD"
  ]) {
    it(`rejects invalid output scalar token ${JSON.stringify(invalidToken)}`, () => {
      const options = fixture();
      replaceToken(options.vocabulary.output, 4, invalidToken);
      const validation = validateNeuralVocabularyContract(options);
      assert.equal(validation.valid, false);
      assert.match(
        validation.failures.join("\n"),
        /not exactly one supported Devanagari or joiner Unicode scalar/u
      );
    });
  }

  it("accepts both Unicode joiners as individual output tokens", () => {
    assert.equal(isSupportedNeuralOutputScalarToken("\u200C"), true);
    assert.equal(isSupportedNeuralOutputScalarToken("\u200D"), true);
  });

  it("rejects non-lowercase or multi-scalar input tokens", () => {
    for (const token of ["A", "ch", "१"]) {
      const options = fixture();
      replaceToken(options.vocabulary.input, 4, token);
      const validation = validateNeuralVocabularyContract(options);
      assert.equal(validation.valid, false);
      assert.match(
        validation.failures.join("\n"),
        /not exactly one lowercase ASCII letter/u
      );
    }
  });

  it("binds lengths, beam width, and decoder range to config and manifest", () => {
    const options = fixture();
    options.vocabulary.input.maxLength = 31;
    options.vocabulary.output.maxLength = 33;
    options.vocabulary.decoder.beamWidth = 5;
    options.vocabulary.decoder.maxSteps = 30;
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /maxLength differs|beam width differs|maxSteps must expose|decoder range differs/u
    );
  });

  it("binds canonical dataset path and all live dataset hashes", () => {
    const options = fixture();
    options.vocabulary.dataset.manifest = "data/other/manifest.json";
    options.vocabulary.dataset.manifestSha256 = "e".repeat(64);
    options.vocabulary.dataset.splitSha256.dev = "f".repeat(64);
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /dataset path differs|manifest digest is stale|split digests differ/u
    );
  });

  it("requires the complete fail-closed native runtime policy", () => {
    const options = fixture();
    options.vocabulary.nativeRuntimePolicy.neverInvokeInSecureFields = false;
    options.vocabulary.nativeRuntimePolicy.unreviewed = true;
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /keys are not closed|neverInvokeInSecureFields must be true/u
    );
  });

  it("rejects open schemas and impossible producer timestamps", () => {
    const options = fixture();
    options.vocabulary.generatedAt = "2026-02-30T00:00:00Z";
    options.vocabulary.unreviewed = true;
    options.vocabulary.decoder.unreviewed = true;
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /keys are not closed|not a real UTC timestamp/u
    );
  });

  it("binds vocabulary semantics to the runtime manifest", () => {
    const options = fixture();
    options.manifest.selectedArtifact = "other-model";
    options.manifest.beamSearch.maxOutputGraphemes = 31;
    options.manifest.outputSequenceValidation = "other-validator";
    const validation = validateNeuralVocabularyContract(options);
    assert.equal(validation.valid, false);
    assert.match(
      validation.failures.join("\n"),
      /modelId differs|output length differs|output validator differs/u
    );
  });
});

function fixture({
  modelId = "lekh-open-vocab-seq2seq-v1"
} = {}) {
  const inputTokens = ["<pad>", "<s>", "</s>", "<unk>", "a", "b"];
  const outputTokens = ["<pad>", "<s>", "</s>", "<unk>", "न", "े"];
  const config = {
    modelId,
    architecture: {
      tokenization: "unicode-scalar-character"
    },
    decoder: {
      type: "beam-search",
      beamWidth: 4,
      maxInputGraphemes: 32,
      maxOutputGraphemes: 32,
      rejectWhitespaceOutput: true,
      rejectLatinOutput: true
    },
    training: {
      datasetManifest:
        "data/generated/neural-open-vocab/manifest.json"
    }
  };
  const vocabulary = {
    schemaVersion: 1,
    modelId,
    generatedAt: "2026-07-28T00:00:00Z",
    tokenization: "unicode-scalar-character",
    input: vocabularySide(inputTokens, 32),
    output: vocabularySide(outputTokens, 32),
    decoder: {
      type: "beam-search",
      beamWidth: 4,
      maxSteps: 31,
      outputSequenceValidation: "devanagari-word-sequence-v1",
      rejectWhitespaceCandidates: true,
      rejectLatinCandidates: true
    },
    dataset: {
      manifest: config.training.datasetManifest,
      manifestSha256: DATASET_SHA256,
      splitSha256: { ...SPLIT_SHA256 }
    },
    nativeRuntimePolicy: {
      asyncOnly: true,
      neverInvokeInSecureFields: true,
      failOpenRawTypingOnError: true,
      neuralTailOnly: true
    }
  };
  const manifest = {
    selectedArtifact: modelId,
    tokenization: "unicode-scalar-character",
    decoder: "beam-search",
    outputSequenceValidation: "devanagari-word-sequence-v1",
    beamSearch: {
      beamWidth: 4,
      maxOutputGraphemes: 32,
      maxSteps: 31
    },
    sha256: {
      trainingDatasetManifest: DATASET_SHA256
    }
  };
  return {
    vocabulary,
    config,
    datasetManifest: {
      sha256: { ...SPLIT_SHA256 }
    },
    datasetManifestSha256: DATASET_SHA256,
    manifest
  };
}

function vocabularySide(tokensById, maxLength) {
  return {
    maxLength,
    tokensById: [...tokensById],
    idsByToken: Object.fromEntries(
      tokensById.map((token, id) => [token, id])
    ),
    padId: 0,
    sosId: 1,
    eosId: 2,
    unkId: 3
  };
}

function replaceToken(side, id, token) {
  const previous = side.tokensById[id];
  side.tokensById[id] = token;
  delete side.idsByToken[previous];
  side.idsByToken[token] = id;
}
