import { describe, expect, it } from "vitest";
import { validateNeuralRareScalarContract } from "./neural-rare-scalar-contract.mjs";

describe("Transformer-CTC rare scalar contract", () => {
  it("accepts an exact dataset, audit, vocabulary, and probe binding", () => {
    expect(validateNeuralRareScalarContract(validFixture())).toEqual({
      ok: true,
      failures: []
    });
  });

  it("rejects a stale audit and substituted probe row", () => {
    const fixture = validFixture();
    fixture.ctcAuditSha256 = "f".repeat(64);
    fixture.contract.scalars[0].probes[0].rowHash = "e".repeat(64);
    const result = validateNeuralRareScalarContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "Rare-scalar probe contract CTC audit SHA-256 is stale.",
      "Rare-scalar probes differ from the exact rows retained by the CTC audit."
    ]));
  });

  it("rejects relabeling a non-exemplar silver scalar as supported", () => {
    const fixture = validFixture();
    fixture.contract.scalars[1].cldrNepaliMainExemplar = true;
    fixture.contract.scalars[1].treatment = "supported-sparse-diagnostic";
    const result = validateNeuralRareScalarContract(fixture);
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "Rare scalar ऱ CLDR Nepali classification is stale.",
      "Rare scalar ऱ production treatment is stale."
    ]));
  });
});

function validFixture() {
  const datasetManifestSha256 = "a".repeat(64);
  const ctcAuditSha256 = "b".repeat(64);
  const datasetManifest = {
    datasetId: "fixture-dataset",
    datasetContentSha256: "c".repeat(64),
    sha256: {
      train: "d".repeat(64),
      dev: "e".repeat(64),
      test: "f".repeat(64)
    }
  };
  const scalarRows = [
    ["ऑ", "U+0911", 1, true, "orbit", "ऑर्बिट"],
    ["ऱ", "U+0931", 1, false, "rra", "ऱ"],
    ["ळ", "U+0933", 1, true, "lla", "ळ"],
    ["ॠ", "U+0960", 1, false, "rr", "ॠ"]
  ];
  const sparseOutputScalarProbes = scalarRows.map(
    ([scalar, codePoint, trainOccurrences, , input, target], index) => ({
      scalar,
      codePoint,
      trainOccurrences,
      probes: [{
        id: `probe-${index}`,
        split: "train",
        input,
        target,
        acceptable: [target],
        rowHash: String(index + 1).repeat(64),
        sourceIds: ["fixture-source"],
        reviewTier: "silver-fixture"
      }]
    })
  );
  const ctcAudit = {
    trainingVocabulary: {
      output: {
        tokens: scalarRows.map(
          ([scalar, codePoint, trainOccurrences]) => ({
            token: scalar,
            codePoint,
            count: trainOccurrences
          })
        )
      }
    },
    sparseOutputScalarProbes: structuredClone(sparseOutputScalarProbes)
  };
  const contract = {
    schemaVersion: 1,
    contentIdentity: "lekh-neural-ctc-rare-output-scalar-probes-v1",
    status: "frozen-dataset-derived-diagnostic",
    dataset: {
      id: datasetManifest.datasetId,
      manifest: "manifest.json",
      manifestSha256: datasetManifestSha256,
      contentSha256: datasetManifest.datasetContentSha256,
      splitSha256: structuredClone(datasetManifest.sha256)
    },
    ctcAudit: {
      path: "ctc-audit.json",
      sha256: ctcAuditSha256
    },
    policy: {
      maximumTrainOccurrences: 5,
      exactProbeMatches:
        "diagnostic-only-silver-derived-no-accuracy-claim",
      nonExemplarSilverScalars:
        "require-zero-unaccepted-top1-emissions-on-locked-gold-and-official-benchmark"
    },
    scalars: scalarRows.map(
      ([
        scalar,
        codePoint,
        trainOccurrences,
        cldrNepaliMainExemplar
      ], index) => ({
        scalar,
        codePoint,
        trainOccurrences,
        cldrNepaliMainExemplar,
        treatment: cldrNepaliMainExemplar
          ? "supported-sparse-diagnostic"
          : "non-exemplar-silver-data-risk",
        probes: structuredClone(sparseOutputScalarProbes[index].probes)
      })
    )
  };
  return {
    contract,
    ctcAudit,
    ctcAuditPath: "ctc-audit.json",
    ctcAuditSha256,
    datasetManifest,
    datasetManifestPath: "manifest.json",
    datasetManifestSha256
  };
}
