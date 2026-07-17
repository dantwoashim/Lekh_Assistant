import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyboardKeyEvent } from "../../src/engine/keyboard/types";
import {
  BEHAVIOR_CONTRACT_VERSION,
  loadBehaviorCorpus,
  runBehaviorContract,
  runKeyPrimitive,
  stableJson
} from "./keyboard-behavior-contract";

const corpusPath = resolve(
  process.cwd(),
  "contracts/keyboard-behavior/v1/lekh-keyboard-behavior.v1.jsonl"
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("keyboard behavior contract", () => {
  it("loads a versioned, unique, representative corpus", () => {
    const cases = loadBehaviorCorpus(corpusPath);
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((row) => row.id)).size).toBe(cases.length);
    expect(new Set(cases.map((row) => row.kind))).toEqual(new Set([
      "edit",
      "key",
      "candidate",
      "protected-span",
      "context-transition",
      "mode-transition",
      "commit",
      "cancel",
      "failure"
    ]));
    expect(cases.every((row) => row.contractVersion === BEHAVIOR_CONTRACT_VERSION)).toBe(true);
  });

  it("passes every case and emits stable evidence", () => {
    const cases = loadBehaviorCorpus(corpusPath);
    const first = runBehaviorContract(cases);
    const second = runBehaviorContract(cases);
    expect(first).toHaveLength(cases.length);
    expect(first.every((row) => row.status === "passed")).toBe(true);
    expect(first.map(stableJson)).toEqual(second.map(stableJson));
  });

  it("rejects duplicate ids, blank records, and unrecognized fields", () => {
    const valid = {
      schemaVersion: 1,
      contractVersion: "1.0.0",
      id: "edit-valid",
      kind: "edit",
      input: { operation: "clamp-caret", text: "कि", caret: 1 },
      expected: { text: "कि", caret: 0 }
    };
    expect(() => loadBehaviorCorpus(writeCorpus([valid, valid]))).toThrow(/duplicate id/i);
    expect(() => loadBehaviorCorpus(writeRaw(`${JSON.stringify(valid)}\n\n${JSON.stringify({ ...valid, id: "edit-second" })}\n`))).toThrow(/blank/i);
    expect(() => loadBehaviorCorpus(writeCorpus([{ ...valid, surprise: true }]))).toThrow(/unknown fields/i);
    expect(() => loadBehaviorCorpus(writeCorpus([{ ...valid, input: { ...valid.input, surprise: true } }]))).toThrow(/unknown fields/i);
  });

  it("preserves grapheme boundaries under deterministic edit mutations", () => {
    const clusters = ["कि", "क्ष", "स्वा", "👨‍👩‍👧‍👦", "👍🏽", "e\u0301"];
    for (const cluster of clusters) {
      const text = `A${cluster}B`;
      const clusterEnd = 1 + cluster.length;
      const backward = runKeyPrimitive(text, clusterEnd, event("Backspace"));
      const forward = runKeyPrimitive(text, 1, event("Delete"));
      expect(backward.text, cluster).toBe("AB");
      expect(backward.caret, cluster).toBe(1);
      expect(forward.text, cluster).toBe("AB");
      expect(forward.caret, cluster).toBe(1);

      for (let caret = 1; caret < clusterEnd; caret += 1) {
        const inserted = runKeyPrimitive(text, caret, event("X"));
        expect(inserted.text, `${cluster}@${caret}`).toBe(`AX${cluster}B`);
        expect(inserted.caret, `${cluster}@${caret}`).toBe(2);
      }
    }
  });
});

function event(key: string): KeyboardKeyEvent {
  return {
    key,
    code: key,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    timestamp: 1,
    platform: "test"
  };
}

function writeCorpus(rows: unknown[]): string {
  return writeRaw(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function writeRaw(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "lekh-behavior-contract-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "corpus.jsonl");
  writeFileSync(path, source, { encoding: "utf8", mode: 0o600 });
  return path;
}
