import { describe, expect, it } from "vitest";
import { validateNeuralAuditEvidence } from "./neural-audit-evidence.mjs";

describe("neural audit evidence freshness", () => {
  it("accepts reports bound to the exact dataset, config, splits, and evals", () => {
    const fixture = validFixture();
    expect(validateNeuralAuditEvidence(fixture)).toEqual({
      ok: true,
      failures: []
    });
  });

  it("rejects stale dataset and config identities", () => {
    const fixture = validFixture();
    fixture.datasetManifest.datasetContentSha256 = "9".repeat(64);
    fixture.ctcConfigSha256 = "8".repeat(64);
    const result = validateNeuralAuditEvidence(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "Dataset quality audit dataset content SHA-256 is stale.",
      "CTC alignment audit dataset content SHA-256 is stale.",
      "CTC alignment audit config SHA-256 is stale."
    ]));
  });

  it("rejects passing labels that hide nonzero incompatibilities", () => {
    const fixture = validFixture();
    fixture.ctcAudit.splits.dev.primaryAlignmentOverflowRows = 1;
    fixture.ctcAudit.summary.datasetPrimaryAlignmentOverflowRows = 1;
    fixture.ctcAudit.evaluation.gold.positiveRowsWithNoRepresentableTarget = 1;
    const result = validateNeuralAuditEvidence(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "CTC alignment audit dev.primaryAlignmentOverflowRows must be zero.",
      "CTC alignment audit gold has unrepresentable positive rows.",
      "CTC alignment audit summary.datasetPrimaryAlignmentOverflowRows must be zero."
    ]));
  });

  it("rejects stale split and evaluation artifact evidence", () => {
    const fixture = validFixture();
    fixture.qualityAudit.artifacts.splits.test.observed.sha256 =
      "7".repeat(64);
    fixture.ctcAudit.artifacts.evaluationReferences.gold.manifestSha256 =
      "6".repeat(64);
    const result = validateNeuralAuditEvidence(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "Dataset quality audit test observed sha256 is stale.",
      "CTC alignment audit gold manifest SHA-256 is stale."
    ]));
  });

  it("rejects substituted evaluation manifest paths", () => {
    const fixture = validFixture();
    fixture.qualityAudit.artifacts.evaluationReferences.gold.manifestPath =
      "substituted-gold.json";
    fixture.ctcAudit.artifacts.evaluationReferences.official.manifestPath =
      "substituted-official.json";
    const result = validateNeuralAuditEvidence(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "Dataset quality audit gold manifest path is stale.",
      "CTC alignment audit official manifest path is stale."
    ]));
  });
});

function validFixture() {
  const hashes = {
    manifest: "a".repeat(64),
    content: "b".repeat(64),
    config: "c".repeat(64),
    train: "d".repeat(64),
    dev: "e".repeat(64),
    test: "f".repeat(64),
    gold: "1".repeat(64),
    official: "2".repeat(64)
  };
  const counts = { train: 2, dev: 1, test: 1 };
  const bytes = { train: 20, dev: 10, test: 10 };
  const splitFiles = {
    train: "train.jsonl",
    dev: "dev.jsonl",
    test: "test.jsonl"
  };
  const datasetManifest = {
    datasetId: "fixture-dataset",
    datasetContentSha256: hashes.content,
    totalRows: 4,
    counts,
    bytes,
    sha256: {
      train: hashes.train,
      dev: hashes.dev,
      test: hashes.test
    },
    splitFiles
  };
  const ctcConfig = {
    implementationContractVersion: 2,
    modelId: "fixture-ctc",
    architecture: {
      runtimeModelContract: "single-transformer-ctc-v1",
      tokenization: "unicode-scalar-character"
    },
    decoder: {
      maxInputGraphemes: 32,
      outputTimeSteps: 32,
      outputSequenceValidation: "devanagari-word-sequence-v1"
    }
  };
  const splitArtifacts = Object.fromEntries(
    Object.keys(counts).map((split) => [
      split,
      {
        path: splitFiles[split],
        expected: {
          bytes: bytes[split],
          rows: counts[split],
          sha256: datasetManifest.sha256[split]
        },
        observed: {
          bytes: bytes[split],
          rows: counts[split],
          sha256: datasetManifest.sha256[split],
          invalidJsonRows: 0
        },
        integrityMatches: true
      }
    ])
  );
  const evaluations = {
    gold: evaluationReference("gold.json", hashes.gold, "gold-v1", 2),
    official: evaluationReference(
      "official.json",
      hashes.official,
      "official-v1",
      3
    )
  };
  const auditEvaluationReferences = Object.fromEntries(
    Object.entries(evaluations).map(([name, value]) => [
      name,
      {
        manifestPath: value.manifestPath,
        manifestSha256: value.manifestSha256,
        releaseId: value.manifest.releaseId,
        rows: value.rows,
        suites: [{
          id: `${name}-suite`,
          path: `${name}.jsonl`,
          expected: {
            rows: value.rows,
            sha256: value.manifest.suites[0].sha256
          },
          observed: {
            bytes: value.rows,
            rows: value.rows,
            sha256: value.manifest.suites[0].sha256,
            invalidJsonRows: 0
          },
          integrityMatches: true
        }]
      }
    ])
  );
  const datasetBinding = {
    id: datasetManifest.datasetId,
    manifestPath: "manifest.json",
    manifestSha256: hashes.manifest,
    declaredContentSha256: hashes.content,
    declaredRows: datasetManifest.totalRows,
    declaredCounts: counts
  };
  const zeroSplit = (split) => ({
    split,
    rows: counts[split],
    candidateRows: counts[split],
    nonCandidateRows: 0,
    invalidJsonRows: 0,
    splitMismatchRows: 0,
    missingPrimaryTargetRows: 0,
    inputInvalidRows: 0,
    inputOverCapacityRows: 0,
    inputUnseenScalarRows: 0,
    primaryInvalidRows: 0,
    primaryScalarOverflowRows: 0,
    primaryAlignmentOverflowRows: 0,
    primaryUnseenScalarRows: 0,
    invalidTargetVariants: 0,
    rowsWithNoRepresentableTarget: 0
  });
  const qualityAudit = {
    schemaVersion: 1,
    contentIdentity: "lekh-neural-open-vocab-data-quality-audit-v1",
    status: "passed-data-quality-audit-with-observations",
    scope: {
      activeCTCRepresentationEvidence:
        "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
      representationWarning:
        "Base-plus-mark warnings are not Transformer-CTC OOV findings."
    },
    dataset: { ...datasetBinding },
    rowsAudited: 4,
    artifacts: {
      splits: structuredClone(splitArtifacts),
      evaluationReferences: structuredClone(auditEvaluationReferences)
    },
    findings: [{ severity: "info", code: "fixture" }]
  };
  const ctcAudit = {
    schemaVersion: 1,
    contentIdentity: "lekh-neural-ctc-alignment-audit-v1",
    status: "passed-ctc-alignment-audit",
    model: {
      id: ctcConfig.modelId,
      configPath: "ctc-config.json",
      configSha256: hashes.config,
      implementationContractVersion:
        ctcConfig.implementationContractVersion,
      runtimeModelContract: ctcConfig.architecture.runtimeModelContract,
      inputTensorLength: 32,
      inputContentCapacity: 31,
      outputTimeSteps: 32,
      outputTokenization: "unicode-scalar-character",
      outputSequenceValidation: "devanagari-word-sequence-v1"
    },
    dataset: { ...datasetBinding },
    artifacts: {
      splits: structuredClone(splitArtifacts),
      evaluationReferences: structuredClone(auditEvaluationReferences)
    },
    splits: {
      train: zeroSplit("train"),
      dev: zeroSplit("dev"),
      test: zeroSplit("test")
    },
    evaluation: {
      gold: evaluationMetrics(2),
      official: evaluationMetrics(3)
    },
    summary: {
      datasetRows: 4,
      datasetInputIncompatibleRows: 0,
      datasetInvalidTargetVariants: 0,
      datasetPrimaryAlignmentOverflowRows: 0,
      heldOutPrimaryUnseenOutputRows: 0,
      datasetRowsWithNoRepresentableTarget: 0,
      evaluationPositiveRowsWithNoRepresentableTarget: 0
    },
    findings: [{ severity: "info", code: "fixture" }]
  };
  return {
    datasetManifest,
    datasetManifestPath: "manifest.json",
    datasetManifestSha256: hashes.manifest,
    qualityAudit,
    ctcAudit,
    ctcConfig,
    ctcConfigPath: "ctc-config.json",
    ctcConfigSha256: hashes.config,
    evaluationManifests: evaluations
  };
}

function evaluationReference(manifestPath, manifestSha256, releaseId, rows) {
  return {
    manifestPath,
    manifestSha256,
    manifest: {
      releaseId,
      suites: [{
        id: `${manifestPath.split(".")[0]}-suite`,
        path: `${manifestPath.split(".")[0]}.jsonl`,
        rows,
        sha256: manifestSha256
      }]
    },
    rows
  };
}

function evaluationMetrics(rows) {
  return {
    rows,
    positiveRows: rows,
    negativeRows: 0,
    positiveRowsWithoutTargets: 0,
    positiveRowsWithNoRepresentableTarget: 0
  };
}
