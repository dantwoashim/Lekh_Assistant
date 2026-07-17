import { describe, expect, it } from "vitest";
import {
  evaluateNeuralPredictions,
  validateNeuralEvaluationSafety,
  validateNeuralPredictionRows
} from "./neural-evaluation.mjs";

const goldRows = [
  gold("train-one", "bato", "train", "romanized-token", ["बाटो"], ["भाटो"]),
  gold("test-one", "vato", "test", "romanized-token", ["बाटो"], ["भाटो"]),
  gold("test-chat", "xau", "test", "chat-convention", ["छौ"], ["क्षौ"]),
  gold("test-name", "niraj", "test", "names", ["निरज", "नीरज"], ["निराज"]),
  gold("test-adversarial", "xaina", "test", "adversarial-safety", ["छैन"], ["क्षैना"]),
  {
    ...gold("test-protected", "GitHub", "test", "protected-token", [], ["गिटहब"]),
    expectedAction: "no-neural-candidate"
  }
];

describe("neural evaluation", () => {
  it("uses only the frozen test split for promotion metrics", () => {
    const rows = predictions([
      ["train-one", "bato", ["गलत"]],
      ["test-one", "vato", ["बाटो"]],
      ["test-chat", "xau", ["छौ"]],
      ["test-name", "niraj", ["नीरज"]],
      ["test-adversarial", "xaina", ["छैन"]],
      ["test-protected", "GitHub", []]
    ]);
    const validation = validateNeuralPredictionRows(rows, goldRows);
    expect(validation.issueCodes).toEqual([]);
    const testMetrics = evaluateNeuralPredictions(goldRows, validation.predictionsById, "test");
    const allMetrics = evaluateNeuralPredictions(goldRows, validation.predictionsById, "all");
    expect(testMetrics.tailTop1Accuracy).toBe(1);
    expect(allMetrics.tailTop1Accuracy).toBe(0.8);
    expect(testMetrics.evaluatedBuckets.adversarial).toBe(1);
  });

  it("rejects duplicate IDs, mismatched inputs, malformed candidates, and missing coverage", () => {
    const validation = validateNeuralPredictionRows([
      { id: "test-one", input: "wrong", candidates: ["बाटो", "बाटो"] },
      { id: "test-one", input: "vato", candidates: ["बाटो"] },
      { id: "unknown", input: "unknown", candidates: [] }
    ], goldRows);
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-id-duplicate:test-one");
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-input-mismatch:test-one");
    expect(validation.issueCodes).toContain("neural-evaluation.candidate-duplicate:test-one");
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-id-unknown:unknown");
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-id-missing:test-chat");
  });

  it("turns forbidden and protected candidates into hard safety failures", () => {
    const rows = predictions([
      ["train-one", "bato", ["बाटो"]],
      ["test-one", "vato", ["भाटो"]],
      ["test-chat", "xau", ["छौ"]],
      ["test-name", "niraj", ["नीरज"]],
      ["test-adversarial", "xaina", ["क्षैना"]],
      ["test-protected", "GitHub", ["गिटहब"]]
    ]);
    const validation = validateNeuralPredictionRows(rows, goldRows);
    expect(validation.issueCodes).toContain("neural-evaluation.protected-row-produced-candidate:test-protected");
    const metrics = evaluateNeuralPredictions(goldRows, validation.predictionsById, "test");
    expect(validateNeuralEvaluationSafety(metrics).issueCodes).toEqual([
      "neural-evaluation.protected-false-conversion",
      "neural-evaluation.forbidden-candidate",
      "neural-evaluation.adversarial-forbidden-candidate"
    ]);
  });
});

function gold(id, input, split, suiteId, acceptable, forbiddenOutputs) {
  return {
    id,
    input,
    split,
    suiteId,
    expectedAction: "produce-candidate",
    acceptable,
    expected: acceptable.slice(0, 1),
    forbiddenOutputs
  };
}

function predictions(rows) {
  return rows.map(([id, input, candidates]) => ({ id, input, candidates }));
}
