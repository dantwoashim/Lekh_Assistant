import { describe, expect, it } from "vitest";
import {
  evaluateNeuralRareScalarEvidence
} from "./neural-rare-scalar-evaluation.mjs";

describe("Transformer-CTC rare scalar evaluation", () => {
  it("passes complete evidence without unaccepted non-exemplar top-1 output", () => {
    const fixture = evaluationFixture();
    const result = evaluateNeuralRareScalarEvidence(fixture);
    expect(result).toMatchObject({
      status: "passed-neural-rare-scalar-evaluation",
      probeRows: 4,
      lockedEvaluationRows: 2,
      spuriousNonExemplarTop1: [],
      failures: [],
      productionGatePassed: true
    });
    expect(result.byScalar["ऑ"]).toMatchObject({
      heldOutProbeRows: 1,
      heldOutTop4ExactRows: 1,
      top4ScalarEmissionRows: 1
    });
  });

  it("fails an unaccepted non-exemplar sparse scalar at locked top-1", () => {
    const fixture = evaluationFixture();
    fixture.lockedEvaluations[1].predictions[0].candidates = ["ॠम्रो"];
    const result = evaluateNeuralRareScalarEvidence(fixture);
    expect(result.productionGatePassed).toBe(false);
    expect(result.failures).toContain(
      "neural-rare-scalar.unaccepted-non-exemplar-top1-emission"
    );
    expect(result.spuriousNonExemplarTop1).toEqual([
      expect.objectContaining({
        scalar: "ॠ",
        evaluation: "official-benchmark",
        id: "official-1",
        top1: "ॠम्रो"
      })
    ]);
  });

  it("keeps weak silver exact-match results diagnostic", () => {
    const fixture = evaluationFixture();
    fixture.probePredictions[0].candidates = ["ओर्बिट"];
    const result = evaluateNeuralRareScalarEvidence(fixture);
    expect(result.productionGatePassed).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "neural-rare-scalar.no-heldout-exact-match:U+0911",
      "neural-rare-scalar.supported-scalar-not-emitted:U+0911"
    ]));
  });

  it("fails closed on missing or unsafe prediction evidence", () => {
    const fixture = evaluationFixture();
    fixture.probePredictions.pop();
    fixture.lockedEvaluations[0].predictions[0].candidates = ["bad latin"];
    const result = evaluateNeuralRareScalarEvidence(fixture);
    expect(result.productionGatePassed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "neural-rare-scalar.rare-probe-prediction-missing:probe-rr",
      "neural-rare-scalar.gold-candidate-invalid:gold-1"
    ]));
  });
});

function evaluationFixture() {
  const scalarRows = [
    ["ऑ", true, "probe-o", "dev", "orbit", "ऑर्बिट"],
    ["ऱ", false, "probe-rra", "train", "rra", "ऱ"],
    ["ळ", true, "probe-lla", "train", "lla", "ळ"],
    ["ॠ", false, "probe-rr", "train", "rr", "ॠ"]
  ];
  const scalars = scalarRows.map(
    ([scalar, cldrNepaliMainExemplar, id, split, input, target]) => ({
      scalar,
      codePoint: codePointLabel(scalar),
      cldrNepaliMainExemplar,
      treatment: cldrNepaliMainExemplar
        ? "supported-sparse-diagnostic"
        : "non-exemplar-silver-data-risk",
      probes: [{
        id,
        split,
        input,
        target,
        acceptable: [target]
      }]
    })
  );
  return {
    contract: { scalars },
    probePredictions: scalarRows.map(
      ([, , id, , input, target]) => ({
        id,
        input,
        candidates: [target]
      })
    ),
    lockedEvaluations: [
      {
        label: "gold",
        rows: [{
          id: "gold-1",
          input: "namaste",
          expected: ["नमस्ते"]
        }],
        predictions: [{
          id: "gold-1",
          input: "namaste",
          candidates: ["नमस्ते"]
        }]
      },
      {
        label: "official-benchmark",
        rows: [{
          id: "official-1",
          input: "ramro",
          acceptable: ["राम्रो"]
        }],
        predictions: [{
          id: "official-1",
          input: "ramro",
          candidates: ["राम्रो"]
        }]
      }
    ]
  };
}

function codePointLabel(value) {
  return `U+${value
    .codePointAt(0)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0")}`;
}
