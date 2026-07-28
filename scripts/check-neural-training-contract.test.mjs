import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

const root = process.cwd();
const checker = join(root, "scripts", "check-neural-training-contract.mjs");
const baselineConfig =
  "data/neural/training/open-vocab-seq2seq-v1.config.json";
const attentionConfig =
  "data/neural/training/open-vocab-bigru-attention-v1.config.json";

describe("Phase 4 architecture-neutral candidate gate", () => {
  it("accepts the canonical baseline config in development guard mode", () => {
    withWorkspace(({ candidate, report }) => {
      const result = run(
        "--config",
        baselineConfig,
        "--candidate-root",
        candidate,
        "--report",
        report
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const evidence = readJson(report);
      assert.equal(evidence.status, "passed-phase4-training-contract");
      assert.equal(evidence.modelId, "lekh-open-vocab-seq2seq-v1");
      assert.equal(evidence.runtimeModelContract, "single-seq2seq-v1");
      assert.equal(evidence.candidateManifestProductionEligible, null);
      assert.ok(evidence.warnings.some((warning) =>
        warning.includes("Checkpoint is absent")
      ));
    });
  });

  it("accepts the canonical split-attention config in development guard mode", () => {
    withWorkspace(({ candidate, report }) => {
      const result = run(
        "--config",
        attentionConfig,
        "--candidate-root",
        candidate,
        "--report",
        report
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const evidence = readJson(report);
      assert.equal(evidence.status, "passed-phase4-training-contract");
      assert.equal(evidence.modelId, "lekh-open-vocab-bigru-attention-v1");
      assert.equal(
        evidence.runtimeModelContract,
        "split-attention-incremental-v1"
      );
      assert.equal(evidence.candidateManifestProductionEligible, null);
    });
  });

  for (const configPath of [baselineConfig, attentionConfig]) {
    it(`accepts a semantically valid vocabulary for ${configPath}`, () => {
      withWorkspace(({ candidate, report }) => {
        writeCandidateVocabulary(candidate, configPath);
        const command = run(
          "--config",
          configPath,
          "--candidate-root",
          candidate,
          "--report",
          report
        );
        assert.equal(command.status, 0, command.stderr || command.stdout);
        const evidence = readJson(report);
        assert.equal(
          evidence.vocabularyContractStatus,
          "passed-neural-vocabulary-contract"
        );
      });
    });
  }

  it("rejects a present vocabulary with a forged inverse token map", () => {
    withWorkspace(({ candidate, report }) => {
      writeCandidateVocabulary(candidate, baselineConfig, (vocabulary) => {
        vocabulary.output.idsByToken["न"] = 99;
      });
      const command = run(
        "--config",
        baselineConfig,
        "--candidate-root",
        candidate,
        "--report",
        report
      );
      assert.equal(command.status, 1, command.stderr || command.stdout);
      assert.match(
        readJson(report).failures.join("\n"),
        /idsByToken is not the contiguous inverse/u
      );
    });
  });

  it("rejects malformed UTF-8 before parsing candidate JSON", () => {
    withWorkspace(({ candidate, report }) => {
      mkdirSync(candidate, { recursive: true });
      const malformed = Buffer.concat([
        Buffer.from('{"schemaVersion":1,"modelId":"', "utf8"),
        Buffer.from([0xC3, 0x28]),
        Buffer.from('"}\n', "utf8")
      ]);
      writeFileSync(
        join(candidate, "LekhNeuralTransliterator.vocab.json"),
        malformed
      );
      const command = run(
        "--config",
        baselineConfig,
        "--candidate-root",
        candidate,
        "--report",
        report
      );
      assert.equal(command.status, 1, command.stderr || command.stdout);
      assert.match(
        readJson(report).failures.join("\n"),
        /Candidate vocabulary is not valid UTF-8/u
      );
    });
  });

  it("fails closed on a symbolic-link candidate root", () => {
    withWorkspace(({ directory, candidate, report }) => {
      const outside = mkdtempSync(join(directory, "outside-"));
      symlinkSync(outside, candidate);
      const result = run(
        "--config",
        baselineConfig,
        "--candidate-root",
        candidate,
        "--report",
        report
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(readJson(report).failures.some((failure) =>
        failure.includes("symbolic-link path component")
      ));
    });
  });

  it("rejects a copied config outside its model's canonical path", () => {
    withWorkspace(({ candidate, report }) => {
      const result = run(
        "--config",
        "package.json",
        "--candidate-root",
        candidate,
        "--report",
        report
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(
        readJson(report).failures.join("\n"),
        /Unsupported neural candidate modelId|Training config/u
      );
    });
  });
});

describe("Phase 4 command-line authority", () => {
  for (const arguments_ of [
    ["--unknown"],
    ["--production", "--production"],
    ["--config"],
    ["positional"]
  ]) {
    it(`rejects ${arguments_.join(" ")}`, () => {
      const result = run(...arguments_);
      assert.equal(result.status, 2, result.stderr || result.stdout);
    });
  }

  it("rejects a report path outside the repository", () => {
    withWorkspace(({ candidate }) => {
      const outsideDirectory = mkdtempSync(
        join(tmpdir(), "lekh-phase4-output-")
      );
      const outside = join(outsideDirectory, "escaped-report.json");
      try {
        const result = run(
          "--candidate-root",
          candidate,
          "--report",
          outside
        );
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.equal(existsSync(outside), false);
        assert.match(result.stderr, /inside the repository/u);
      } finally {
        rmSync(outsideDirectory, { recursive: true, force: true });
      }
    });
  });

  it("rejects a report path containing a symbolic-link ancestor", () => {
    withWorkspace(({ directory, candidate }) => {
      const outside = mkdtempSync(join(directory, "report-outside-"));
      const link = join(directory, "report-link");
      symlinkSync(outside, link);
      const result = run(
        "--candidate-root",
        candidate,
        "--report",
        join(link, "report.json")
      );
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, /symbolic-link component/u);
    });
  });
});

function withWorkspace(callback) {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(join(root, ".tmp", "phase4-cli-test-"));
  const candidate = join(directory, "candidate");
  const report = join(directory, "report.json");
  try {
    callback({ directory, candidate, report });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function run(...args) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: "utf8"
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeCandidateVocabulary(candidate, configPath, mutate = () => {}) {
  const config = readJson(join(root, configPath));
  const datasetPath = join(root, config.training.datasetManifest);
  const datasetBytes = readFileSync(datasetPath);
  const dataset = JSON.parse(datasetBytes.toString("utf8"));
  const inputTokens = ["<pad>", "<s>", "</s>", "<unk>", "a", "b"];
  const outputTokens = ["<pad>", "<s>", "</s>", "<unk>", "न", "े"];
  const vocabulary = {
    schemaVersion: 1,
    modelId: config.modelId,
    generatedAt: "2026-07-28T00:00:00Z",
    tokenization: "unicode-scalar-character",
    input: vocabularySide(
      inputTokens,
      config.decoder.maxInputGraphemes
    ),
    output: vocabularySide(
      outputTokens,
      config.decoder.maxOutputGraphemes
    ),
    decoder: {
      type: config.decoder.type,
      beamWidth: config.decoder.beamWidth,
      maxSteps: config.decoder.maxOutputGraphemes - 1,
      outputSequenceValidation: "devanagari-word-sequence-v1",
      rejectWhitespaceCandidates: true,
      rejectLatinCandidates: true
    },
    dataset: {
      manifest: config.training.datasetManifest,
      manifestSha256: createHash("sha256")
        .update(datasetBytes)
        .digest("hex"),
      splitSha256: structuredClone(dataset.sha256)
    },
    nativeRuntimePolicy: {
      asyncOnly: true,
      neverInvokeInSecureFields: true,
      failOpenRawTypingOnError: true,
      neuralTailOnly: true
    }
  };
  mutate(vocabulary);
  mkdirSync(candidate, { recursive: true });
  writeFileSync(
    join(candidate, "LekhNeuralTransliterator.vocab.json"),
    `${JSON.stringify(vocabulary, null, 2)}\n`
  );
}

function vocabularySide(tokensById, maxLength) {
  return {
    maxLength,
    tokensById,
    idsByToken: Object.fromEntries(
      tokensById.map((token, id) => [token, id])
    ),
    padId: 0,
    sosId: 1,
    eosId: 2,
    unkId: 3
  };
}
