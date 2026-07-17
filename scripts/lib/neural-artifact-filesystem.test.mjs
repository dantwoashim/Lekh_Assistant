import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile,
  NeuralArtifactFilesystemError
} from "./neural-artifact-filesystem.mjs";

describe("neural artifact filesystem boundary", () => {
  it("hashes a contained regular file without following path indirection", () => {
    withFixture(({ root }) => {
      const path = join(root, "evidence.json");
      write(path, "trusted-evidence\n");
      const inspected = inspectContainedRegularFile(root, path, { includeContents: true });
      assert.equal(inspected.sha256, sha256("trusted-evidence\n"));
      assert.equal(inspected.contents.toString("utf8"), "trusted-evidence\n");
    });
  });

  it("rejects a symbolic-link evidence leaf", () => {
    withFixture(({ root, outside }) => {
      const target = join(outside, "checkpoint.pt");
      write(target, "outside");
      const link = join(root, "checkpoint.pt");
      symlinkSync(target, link);
      assert.throws(
        () => inspectContainedRegularFile(root, link),
        (error) => error instanceof NeuralArtifactFilesystemError && /must not be a symbolic link/u.test(error.message)
      );
    });
  });

  it("rejects direct paths outside the canonical repository root", () => {
    withFixture(({ root, outside }) => {
      const path = join(outside, "manifest.json");
      write(path, "{}\n");
      assert.throws(
        () => inspectContainedRegularFile(root, path),
        (error) => error instanceof NeuralArtifactFilesystemError && /escapes the repository root/u.test(error.message)
      );
    });
  });

  it("rejects a compiled-model directory that is itself a symbolic link", () => {
    withFixture(({ root, outside }) => {
      const target = join(outside, "model.mlmodelc");
      write(join(target, "model.espresso.net"), "graph");
      const link = join(root, "model.mlmodelc");
      symlinkSync(target, link);
      assert.throws(
        () => inspectContainedDirectoryTree(root, link),
        (error) => error instanceof NeuralArtifactFilesystemError && /must not be a symbolic link/u.test(error.message)
      );
    });
  });

  it("rejects symbolic links anywhere below the compiled-model directory", () => {
    withFixture(({ root, outside }) => {
      const model = join(root, "model.mlmodelc");
      write(join(model, "model.espresso.net"), "graph");
      const target = join(outside, "weights.bin");
      write(target, "outside-weights");
      symlinkSync(target, join(model, "weights.bin"));
      assert.throws(
        () => inspectContainedDirectoryTree(root, model),
        (error) => error instanceof NeuralArtifactFilesystemError && /contains a symbolic link/u.test(error.message)
      );
    });
  });

  it("rejects a directory where the artifact contract requires a regular file", () => {
    withFixture(({ root }) => {
      const path = join(root, "checkpoint.pt");
      mkdirSync(path);
      assert.throws(
        () => inspectContainedRegularFile(root, path),
        (error) => error instanceof NeuralArtifactFilesystemError && /must be a regular file/u.test(error.message)
      );
    });
  });

  it.skipIf(process.platform === "win32")("rejects a special-file descendant without opening it", () => {
    withFixture(({ root }) => {
      const model = join(root, "model.mlmodelc");
      write(join(model, "model.espresso.net"), "graph");
      const fifo = join(model, "untrusted.pipe");
      const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      assert.throws(
        () => inspectContainedDirectoryTree(root, model),
        (error) => error instanceof NeuralArtifactFilesystemError && /non-regular filesystem entry/u.test(error.message)
      );
    });
  });

  it("bounds compiled-model hashing by bytes and entry count", () => {
    withFixture(({ root }) => {
      const model = join(root, "model.mlmodelc");
      write(join(model, "a.bin"), "1234");
      write(join(model, "b.bin"), "5678");
      assert.throws(() => inspectContainedDirectoryTree(root, model, { maxBytes: 7 }), /verification limit/u);
      assert.throws(() => inspectContainedDirectoryTree(root, model, { maxEntries: 1 }), /entry count/u);
    });
  });

  it("rejects an empty compiled-model directory", () => {
    withFixture(({ root }) => {
      const model = join(root, "model.mlmodelc");
      mkdirSync(model);
      assert.throws(
        () => inspectContainedDirectoryTree(root, model),
        /contains no regular files/u
      );
    });
  });
});

function withFixture(callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-neural-artifact-fs-"));
  const root = join(parent, "repo");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  try {
    callback({ root, outside });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
