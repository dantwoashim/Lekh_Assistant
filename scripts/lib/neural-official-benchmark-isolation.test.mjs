import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";
import {
  OFFICIAL_BENCHMARK_INPUT_NORMALIZATION,
  OFFICIAL_BENCHMARK_ISOLATION_POLICY,
  normalizeOfficialBenchmarkInput,
  verifyOfficialBenchmarkTrainingIsolation
} from "./neural-official-benchmark-isolation.mjs";

describe("official benchmark train/dev isolation", () => {
  it("reopens and verifies both split files before proving zero overlap", () => {
    withFixture({}, (fixture) => {
      const result = verify(fixture);
      expect(result.valid).toBe(true);
      expect(result.issueCodes).toEqual([]);
      expect(result.evidence).toEqual({
        policy: OFFICIAL_BENCHMARK_ISOLATION_POLICY,
        benchmarkInputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        comparedSplitSha256: {
          train: fixture.splitEvidence.train.sha256,
          dev: fixture.splitEvidence.dev.sha256
        },
        overlappingInputCount: 0
      });
      expect(result.comparedSplits.train).toMatchObject({
        path: "data/generated/dataset/train.jsonl",
        bytes: fixture.splitEvidence.train.bytes,
        rows: 2
      });
      expect(result.comparedSplits.dev).toMatchObject({
        path: "data/generated/dataset/dev.jsonl",
        bytes: fixture.splitEvidence.dev.bytes,
        rows: 1
      });
    });
  });

  it("detects leakage only after applying the locked normalization", () => {
    withFixture({
      trainInputs: ["cafe\u0301\tnepal"],
      officialRows: [{
        id: "official-1",
        input: "  CAFÉ   NEPAL "
      }]
    }, (fixture) => {
      expect(
        normalizeOfficialBenchmarkInput("cafe\u0301\tnepal")
      ).toBe("café nepal");
      const result = verify(fixture);
      expect(result.valid).toBe(false);
      expect(result.issueCodes).toContain(
        "official-benchmark-isolation.overlap-detected"
      );
      expect(result.overlappingInputCount).toBe(1);
      expect(result.overlapCounts.train).toBe(1);
      expect(result.overlappingInputExamples).toEqual([
        "café nepal"
      ]);
      expect(result.evidence).toBeNull();
    });
  });

  it("rejects split bytes changed after the dataset manifest was signed", () => {
    withFixture({}, (fixture) => {
      appendFileSync(
        fixture.paths.train,
        `${JSON.stringify(row("train", "tampered"))}\n`
      );
      const result = verify(fixture);
      expect(result.valid).toBe(false);
      expect(result.issueCodes).toContain(
        "official-benchmark-isolation.split-identity-invalid:train"
      );
    });
  });

  it("rejects a dataset manifest not bound by candidate evidence", () => {
    withFixture({}, (fixture) => {
      const result = verifyOfficialBenchmarkTrainingIsolation({
        repoRoot: fixture.root,
        datasetManifestPath: fixture.paths.manifest,
        expectedDatasetManifestSha256: "f".repeat(64),
        officialRows: fixture.officialRows
      });
      expect(result.valid).toBe(false);
      expect(result.issueCodes).toContain(
        "official-benchmark-isolation.dataset-manifest-identity-invalid"
      );
    });
  });

  it("rejects a dataset manifest with a different normalization policy", () => {
    withFixture({
      normalization: "trim lowercase"
    }, (fixture) => {
      const result = verify(fixture);
      expect(result.valid).toBe(false);
      expect(result.issueCodes).toContain(
        "official-benchmark-isolation.dataset-contract-invalid"
      );
    });
  });
});

function withFixture(options, callback) {
  const root = mkdtempSync(
    join(tmpdir(), "lekh-official-isolation-")
  );
  try {
    callback(buildFixture(root, options));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function buildFixture(root, options) {
  const paths = {
    train: join(root, "data/generated/dataset/train.jsonl"),
    dev: join(root, "data/generated/dataset/dev.jsonl"),
    manifest: join(root, "data/generated/dataset/manifest.json")
  };
  const trainInputs =
    options.trainInputs ?? ["kathmandu", "pokhara"];
  const devInputs = options.devInputs ?? ["biratnagar"];
  writeJsonLines(
    paths.train,
    trainInputs.map((input) => row("train", input))
  );
  writeJsonLines(
    paths.dev,
    devInputs.map((input) => row("dev", input))
  );
  const splitEvidence = {
    train: inspectContainedRegularFile(root, paths.train),
    dev: inspectContainedRegularFile(root, paths.dev)
  };
  writeJson(paths.manifest, {
    schemaVersion: 2,
    datasetContentSha256: sha256("fixture-dataset"),
    splitFiles: {
      train: portable(root, paths.train),
      dev: portable(root, paths.dev)
    },
    counts: {
      train: trainInputs.length,
      dev: devInputs.length
    },
    bytes: {
      train: splitEvidence.train.bytes,
      dev: splitEvidence.dev.bytes
    },
    sha256: {
      train: splitEvidence.train.sha256,
      dev: splitEvidence.dev.sha256
    },
    cleaningPolicy: {
      normalizeInput:
        options.normalization ??
        OFFICIAL_BENCHMARK_INPUT_NORMALIZATION
    }
  });
  const manifestEvidence = inspectContainedRegularFile(
    root,
    paths.manifest
  );
  return {
    root,
    paths,
    splitEvidence,
    manifestEvidence,
    officialRows: options.officialRows ?? [{
      id: "official-1",
      input: "nepal"
    }]
  };
}

function verify(fixture) {
  return verifyOfficialBenchmarkTrainingIsolation({
    repoRoot: fixture.root,
    datasetManifestPath: fixture.paths.manifest,
    expectedDatasetManifestSha256:
      fixture.manifestEvidence.sha256,
    officialRows: fixture.officialRows
  });
}

function row(split, input) {
  return {
    schemaVersion: 1,
    split,
    input
  };
}

function writeJsonLines(path, rows) {
  write(
    path,
    `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`
  );
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}
