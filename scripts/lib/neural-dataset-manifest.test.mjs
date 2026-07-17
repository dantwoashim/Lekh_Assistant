import { describe, expect, it } from "vitest";
import {
  computeNeuralDatasetContentSha256,
  validateNeuralDatasetManifest
} from "./neural-dataset-manifest.mjs";

describe("neural dataset manifest content identity", () => {
  it("ignores generatedAt but binds every stable content field", () => {
    const first = manifest();
    const second = { ...first, generatedAt: "2030-01-01T00:00:00.000Z" };
    second.datasetContentSha256 = computeNeuralDatasetContentSha256(second);
    expect(second.datasetContentSha256).toBe(first.datasetContentSha256);
    const tampered = { ...first, counts: { ...first.counts, test: 2 } };
    expect(validateNeuralDatasetManifest(tampered).issueCodes).toContain(
      "neural-dataset-manifest.content-digest-invalid"
    );
  });

  it("rejects malformed split and provenance metadata", () => {
    const invalid = manifest();
    invalid.bytes.train = 0;
    invalid.provenance = null;
    invalid.datasetContentSha256 = computeNeuralDatasetContentSha256(invalid);
    expect(validateNeuralDatasetManifest(invalid).issueCodes).toEqual([
      "neural-dataset-manifest.provenance-invalid",
      "neural-dataset-manifest.split-invalid:train"
    ]);
  });
});

function manifest() {
  const value = {
    schemaVersion: 2,
    generatedAt: "2026-07-17T00:00:00.000Z",
    contentIdentity: "sha256-canonical-json-v1",
    datasetContentSha256: "",
    datasetId: "lekh-open-vocab-cleaned-v1",
    rowSchema: "schema.json",
    sourceRegistry: "sources.json",
    splitFiles: { train: "train.jsonl", dev: "dev.jsonl", test: "test.jsonl" },
    counts: { train: 1, dev: 1, test: 1 },
    totalRows: 3,
    bytes: { train: 10, dev: 10, test: 10 },
    sha256: { train: "a".repeat(64), dev: "b".repeat(64), test: "c".repeat(64) },
    recordIdentityPolicy: "stable-example-id-and-final-record-sha256-v1",
    cleaningPolicy: { noNetworkFetch: true },
    provenance: {
      builder: { path: "builder.mjs", sha256: "d".repeat(64) },
      goldRelease: { path: "gold.json", sha256: "e".repeat(64) },
      inputs: []
    }
  };
  value.datasetContentSha256 = computeNeuralDatasetContentSha256(value);
  return value;
}
