import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync
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
