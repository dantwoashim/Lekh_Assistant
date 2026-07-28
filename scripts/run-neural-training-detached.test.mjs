import { describe, expect, it } from "vitest";
import {
  buildDetachedTrainingCommand
} from "./run-neural-training-detached.mjs";

const root = process.cwd();

describe("detached neural training launcher", () => {
  it("builds a shell-free caffeinated production training command", () => {
    const command = buildDetachedTrainingCommand({
      repoRoot: root,
      configPath:
        `${root}/data/neural/training/` +
        "open-vocab-bigru-attention-v1.config.json",
      pythonPath: `${root}/.tmp/neural-seq2seq-venv/bin/python`,
      restartTraining: false
    });

    expect(command.executable).toBe("/usr/bin/caffeinate");
    expect(command.args.slice(0, 2)).toEqual([
      "-ims",
      `${root}/.tmp/neural-seq2seq-venv/bin/python`
    ]);
    expect(command.args).toContain(
      `${root}/scripts/train-open-vocab-seq2seq-transliterator.py`
    );
    expect(command.args).not.toContain("--restart-training");
  });

  it("adds destructive recovery reset only when explicitly requested", () => {
    const command = buildDetachedTrainingCommand({
      repoRoot: root,
      configPath:
        `${root}/data/neural/training/open-vocab-seq2seq-v1.config.json`,
      pythonPath: `${root}/.tmp/neural-seq2seq-venv/bin/python`,
      restartTraining: true
    });

    expect(command.args.at(-1)).toBe("--restart-training");
  });
});
