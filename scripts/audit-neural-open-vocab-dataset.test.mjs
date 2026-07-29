import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditNeuralOpenVocabularyDataset } from "./audit-neural-open-vocab-dataset.mjs";

describe("combined neural dataset and CTC audit", () => {
  it("streams one frozen inventory into both bound reports", async () => {
    mkdirSync(resolve(process.cwd(), ".tmp"), { recursive: true });
    const temporaryRoot = mkdtempSync(
      resolve(process.cwd(), ".tmp/neural-combined-audit-")
    );
    try {
      const splits = {
        train: [datasetRow("train-a", "lekhaka", "लेख", "train")],
        dev: [datasetRow("dev-a", "kala", "खेल", "dev")],
        test: [datasetRow("test-a", "hala", "लेखले", "test")]
      };
      const splitEvidence = {};
      for (const [split, rows] of Object.entries(splits)) {
        const path = resolve(temporaryRoot, `${split}.jsonl`);
        const bytes = Buffer.from(
          `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
        );
        writeFileSync(path, bytes);
        splitEvidence[split] = {
          path,
          bytes: bytes.byteLength,
          rows: rows.length,
          sha256: sha256(bytes)
        };
      }

      const datasetManifestPath = resolve(temporaryRoot, "manifest.json");
      writeJson(datasetManifestPath, {
        schemaVersion: 2,
        datasetId: "fixture-open-vocab",
        datasetContentSha256: "a".repeat(64),
        totalRows: 3,
        counts: Object.fromEntries(
          Object.entries(splitEvidence).map(([split, value]) => [
            split,
            value.rows
          ])
        ),
        bytes: Object.fromEntries(
          Object.entries(splitEvidence).map(([split, value]) => [
            split,
            value.bytes
          ])
        ),
        sha256: Object.fromEntries(
          Object.entries(splitEvidence).map(([split, value]) => [
            split,
            value.sha256
          ])
        ),
        splitFiles: Object.fromEntries(
          Object.entries(splitEvidence).map(([split, value]) => [
            split,
            relativeFixturePath(value.path)
          ])
        )
      });

      const goldManifestPath = evaluationRelease(
        temporaryRoot,
        "gold",
        "gold-fixture",
        [evaluationRow("gold-a", "kala", "खेल")]
      );
      const benchmarkManifestPath = evaluationRelease(
        temporaryRoot,
        "benchmark",
        "benchmark-fixture",
        [evaluationRow("benchmark-a", "hala", "लेखले")]
      );
      const ctcConfigPath = resolve(temporaryRoot, "ctc-config.json");
      writeJson(ctcConfigPath, {
        implementationContractVersion: 2,
        modelId: "fixture-ctc",
        architecture: {
          runtimeModelContract: "single-transformer-ctc-v1"
        },
        decoder: {
          maxInputGraphemes: 8,
          outputTimeSteps: 8
        }
      });
      const qualityReportPath = resolve(temporaryRoot, "quality.json");
      const ctcReportPath = resolve(temporaryRoot, "ctc.json");

      const result = await auditNeuralOpenVocabularyDataset({
        datasetManifest: relativeFixturePath(datasetManifestPath),
        goldManifest: relativeFixturePath(goldManifestPath),
        benchmarkManifest: relativeFixturePath(benchmarkManifestPath),
        ctcConfig: relativeFixturePath(ctcConfigPath),
        report: relativeFixturePath(qualityReportPath),
        ctcReport: relativeFixturePath(ctcReportPath)
      });

      expect(result.report.status)
        .toBe("passed-data-quality-audit-with-observations");
      expect(result.ctcReport.status).toBe("passed-ctc-alignment-audit");
      expect(result.ctcReport).toMatchObject({
        model: {
          id: "fixture-ctc",
          inputTensorLength: 8,
          inputContentCapacity: 7,
          outputTimeSteps: 8
        },
        summary: {
          datasetRows: 3,
          datasetRowsWithNoRepresentableTarget: 0,
          evaluationPositiveRowsWithNoRepresentableTarget: 0
        }
      });
      expect(JSON.parse(readFileSync(qualityReportPath, "utf8")).status)
        .toBe(result.report.status);
      expect(JSON.parse(readFileSync(ctcReportPath, "utf8")).status)
        .toBe(result.ctcReport.status);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

function datasetRow(id, input, target, split) {
  return {
    schemaVersion: 1,
    id,
    split,
    action: "produce-candidate",
    input,
    target,
    acceptable: [target],
    category: "romanized-token",
    sourceIds: ["fixture"],
    sourceTier: "fixture",
    reviewTier: "fixture",
    weight: 1
  };
}

function evaluationRow(id, input, target) {
  return {
    id,
    input,
    expectedAction: "produce-candidate",
    expected: [target],
    acceptable: []
  };
}

function evaluationRelease(root, stem, releaseId, rows) {
  const suitePath = resolve(root, `${stem}.jsonl`);
  const suiteBytes = Buffer.from(
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
  writeFileSync(suitePath, suiteBytes);
  const manifestPath = resolve(root, `${stem}-manifest.json`);
  writeJson(manifestPath, {
    releaseId,
    suites: [{
      id: `${stem}-suite`,
      path: relativeFixturePath(suitePath),
      rows: rows.length,
      sha256: sha256(suiteBytes)
    }]
  });
  return manifestPath;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeFixturePath(path) {
  return path.slice(process.cwd().length + 1);
}
