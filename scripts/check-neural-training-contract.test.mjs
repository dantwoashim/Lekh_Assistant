import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";

const sourceRoot = process.cwd();
const checkerPath = join(sourceRoot, "scripts", "check-neural-training-contract.mjs");
const inputOverrides = [
  "config",
  "trainer",
  "training-report",
  "manifest",
  "model",
  "checkpoint",
  "export-report",
  "measurements",
  "predictions",
  "vocab",
  "dataset-manifest",
  "gold-manifest"
];

describe("Phase 4 artifact graph filesystem boundary", () => {
  it("rejects a symbolic-link graph leaf", () => {
    withFixture(({ root, outside }) => {
      const target = join(outside, "checkpoint.pt");
      write(target, "outside-checkpoint");
      link(target, canonical(root).checkpoint);
      const { result, report } = runChecker(root);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes("Checkpoint must not be a symbolic link")));
    });
  });

  it("rejects a compiled-model root symbolic link", () => {
    withFixture(({ root, outside }) => {
      const target = join(outside, "LekhNeuralTransliterator.mlmodelc");
      write(join(target, "model.espresso.net"), "graph");
      link(target, canonical(root).model);
      const { result, report } = runChecker(root);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes("Compiled Core ML model must not be a symbolic link")));
    });
  });

  it("rejects a symbolic-link descendant in the compiled model", () => {
    withFixture(({ root, outside }) => {
      write(join(canonical(root).model, "model.espresso.net"), "graph");
      const target = join(outside, "weights.bin");
      write(target, "outside-weights");
      link(target, join(canonical(root).model, "weights.bin"));
      const { result, report } = runChecker(root);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes("Compiled Core ML model contains a symbolic link")));
    });
  });

  it("rejects the wrong filesystem type for a graph leaf", () => {
    withFixture(({ root }) => {
      mkdirSync(canonical(root).checkpoint, { recursive: true });
      const { result, report } = runChecker(root);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes("Checkpoint must be a regular file")));
    });
  });

  it("rejects an input path that escapes the repository root", () => {
    withFixture(({ root, outside }) => {
      const manifest = join(outside, "runtime-manifest.json");
      const { result, report } = runChecker(root, "--manifest", manifest);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.ok(report.failures.some((failure) => failure.includes("Runtime manifest path escapes the repository root")));
    });
  });

  it("requires exact compiled-model prediction, gold-corpus, and run identity evidence", () => {
    withFixture(({ root }) => {
      writeJson(canonical(root).exportReport, {});
      const { result, report } = runChecker(root);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const issues = report.artifactGraphBinding.issues.join("\n");
      assert.match(issues, /valid exportRunId/u);
      assert.match(issues, /trainingRunId does not match/u);
      assert.match(issues, /predictionsBackend must be coreml-compiled-model/u);
      assert.match(issues, /gold-manifest path is non-canonical/u);
      assert.match(issues, /gold-manifest digest is stale/u);
      assert.match(issues, /gold-corpus digest is stale/u);
      assert.match(issues, /gold-suite evidence/u);
    });
  });
});

describe("Phase 4 production input authority", () => {
  for (const option of inputOverrides) {
    it(`rejects the --${option} input override`, () => {
      withFixture(({ root }) => {
        const paths = canonical(root);
        const value = paths[optionToPathKey(option)] ?? join(root, "unused-input");
        const reportPath = join(root, "reports", `${option}-production.json`);
        const { result, report } = runChecker(root, "--production", `--${option}`, value, "--report", reportPath);
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.ok(report.failures.includes(`Production Phase 4 forbids the --${option} input override; only --report may be overridden.`));
      });
    });
  }

  it("allows --report as the sole production override", () => {
    withFixture(({ root }) => {
      const reportPath = join(root, "custom-output", "phase4-production.json");
      const { report } = runChecker(root, "--production", "--report", reportPath);
      assert.ok(!report.failures.some((failure) => failure.includes("forbids the --report")));
    });
  });
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-phase4-artifact-test-"));
  const root = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  copy(join(sourceRoot, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json"), canonical(root).config);
  copy(join(sourceRoot, "scripts", "train-open-vocab-seq2seq-transliterator.py"), canonical(root).trainer);
  try {
    callback({ root, outside });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function runChecker(root, ...args) {
  const result = spawnSync(process.execPath, [checkerPath, ...args], { cwd: root, encoding: "utf8" });
  const reportOption = args.indexOf("--report");
  const production = args.includes("--production");
  const reportPath = reportOption >= 0
    ? args[reportOption + 1]
    : join(root, "reports", production ? "neural-training-contract-production-report.json" : "neural-training-contract-report.json");
  return { result, report: readJson(reportPath) };
}

function canonical(root) {
  const out = join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1");
  return {
    config: join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json"),
    trainer: join(root, "scripts", "train-open-vocab-seq2seq-transliterator.py"),
    trainingReport: join(out, "training-report.json"),
    checkpoint: join(out, "checkpoint.pt"),
    exportReport: join(out, "export-report.json"),
    measurements: join(out, "coreml-device-measurements.json"),
    predictions: join(out, "gold-predictions.jsonl"),
    vocab: join(root, "models", "macos", "LekhNeuralTransliterator.vocab.json"),
    datasetManifest: join(root, "data", "generated", "neural-open-vocab", "manifest.json"),
    goldManifest: join(root, "data", "neural", "gold", "manifest.v2.json"),
    manifest: join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json"),
    model: join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc")
  };
}

function optionToPathKey(option) {
  return {
    "training-report": "trainingReport",
    "export-report": "exportReport",
    "dataset-manifest": "datasetManifest",
    "gold-manifest": "goldManifest"
  }[option] ?? option;
}

function copy(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function link(target, path) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
