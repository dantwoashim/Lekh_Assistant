import { readFileSync } from "node:fs";
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
    const testMetrics = evaluateNeuralPredictions(goldRows, validation, "test");
    const allMetrics = evaluateNeuralPredictions(goldRows, validation, "all");
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
    expect(validation.metricsReportable).toBe(false);
    expect(evaluateNeuralPredictions(goldRows, validation, "test")).toBeNull();
  });

  it("makes metrics unreportable when a normalized prediction input mismatches gold", () => {
    const rows = validPredictionRows();
    rows.find((row) => row.id === "test-one").input = "not-vato";
    const validation = validateNeuralPredictionRows(rows, goldRows);
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-input-mismatch:test-one");
    expect(validation.metricsReportable).toBe(false);
    expect(evaluateNeuralPredictions(goldRows, validation, "test")).toBeNull();
  });

  it("accepts the five intentional repeated assertions in the current gold release", () => {
    const currentGold = loadCurrentGoldRows();
    const duplicateInputs = normalizedDuplicateInputs(currentGold);
    expect(duplicateInputs).toEqual(["mero", "namaste", "nepal", "swasthya", "xaina"]);

    const rows = currentGold.map((row) => ({
      id: row.id,
      input: row.input,
      candidates: row.expectedAction === "produce-candidate" ? row.acceptable.slice(0, 1) : []
    }));
    const validation = validateNeuralPredictionRows(rows, currentGold);
    expect(validation.issueCodes).toEqual([]);
    expect(validation.exactCoverage).toBe(true);

    const metrics = evaluateNeuralPredictions(currentGold, validation, "all");
    expect(metrics).toMatchObject({
      metricUnit: "suite-assertion",
      rowCount: 47,
      suiteAssertionCount: 47,
      distinctInputCount: 42,
      repeatedSuiteAssertionCount: 5
    });

    const missingAlias = validateNeuralPredictionRows(
      rows.filter((row) => row.id !== "gold_romanized_token_000007"),
      currentGold
    );
    expect(missingAlias.issueCodes).toContain(
      "neural-evaluation.prediction-id-missing:gold_romanized_token_000007"
    );
    expect(missingAlias.metricsReportable).toBe(false);
  });

  it("allows cross-suite categories and stricter forbidden-output supersets", () => {
    const duplicateGold = [
      gold("test-general", "vato", "test", "romanized-token", ["बाटो", "वाटो"], ["भाटो"]),
      gold(
        "test-safety",
        " VATO ",
        "test",
        "adversarial-safety",
        ["वाटो", "बाटो"],
        ["भाटो", "बाटोमा"]
      )
    ];
    const rows = [
      { id: "test-general", input: "vato", candidates: ["बाटो", "वाटो"] },
      { id: "test-safety", input: "VATO", candidates: ["बाटो", "वाटो"] }
    ];
    const validation = validateNeuralPredictionRows(rows, duplicateGold);
    expect(validation.issueCodes).toEqual([]);
    expect(evaluateNeuralPredictions(duplicateGold, validation, "test")).toMatchObject({
      metricUnit: "suite-assertion",
      suiteAssertionCount: 2,
      distinctInputCount: 1,
      repeatedSuiteAssertionCount: 1
    });
  });

  it.each([
    {
      name: "target",
      change: { acceptable: ["वाटो"], expected: ["वाटो"] },
      issue: "neural-evaluation.gold-input-duplicate-target-conflict:test-general:test-conflict"
    },
    {
      name: "action",
      change: { expectedAction: "no-neural-candidate", acceptable: [], expected: [] },
      issue: "neural-evaluation.gold-input-duplicate-action-conflict:test-general:test-conflict"
    },
    {
      name: "split",
      change: { split: "dev" },
      issue: "neural-evaluation.gold-input-duplicate-split-conflict:test-general:test-conflict"
    },
    {
      name: "suite identity",
      change: { suiteId: "romanized-token" },
      issue: "neural-evaluation.gold-input-duplicate-same-suite:test-general:test-conflict"
    }
  ])("fails closed on a repeated-input $name conflict", ({ change, issue }) => {
    const baseline = gold("test-general", "vato", "test", "romanized-token", ["बाटो"], []);
    const conflict = {
      ...gold("test-conflict", "VATO", "test", "adversarial-safety", ["बाटो"], ["भाटो"]),
      ...change
    };
    const validation = validateNeuralPredictionRows([
      { id: baseline.id, input: baseline.input, candidates: ["बाटो"] },
      { id: conflict.id, input: conflict.input, candidates: ["बाटो"] }
    ], [baseline, conflict]);
    expect(validation.issueCodes).toContain(issue);
    expect(validation.metricsReportable).toBe(false);
    expect(evaluateNeuralPredictions([baseline, conflict], validation, "test")).toBeNull();
  });

  it("rejects context-dependent gold rows for the token-only model", () => {
    const contextual = {
      ...gold("test-context", "vato", "test", "romanized-token", ["बाटो"], []),
      previousContext: ["mero"]
    };
    const validation = validateNeuralPredictionRows([
      { id: contextual.id, input: contextual.input, candidates: ["बाटो"] }
    ], [contextual]);
    expect(validation.issueCodes).toContain(
      "neural-evaluation.gold-context-unsupported:test-context"
    );
    expect(validation.metricsReportable).toBe(false);
  });

  it.each([
    { name: "content", candidates: ["बाटो"] },
    { name: "ordering", candidates: ["वाटो", "बाटो"] }
  ])("rejects suite-aware candidate $name for compatible assertions", ({ candidates }) => {
    const duplicateGold = [
      gold("test-general", "vato", "test", "romanized-token", ["बाटो", "वाटो"], []),
      gold("test-safety", "VATO", "test", "adversarial-safety", ["वाटो", "बाटो"], ["भाटो"])
    ];
    const validation = validateNeuralPredictionRows([
      { id: "test-general", input: "vato", candidates: ["बाटो", "वाटो"] },
      { id: "test-safety", input: "vato", candidates }
    ], duplicateGold);
    expect(validation.issueCodes).toContain(
      "neural-evaluation.duplicate-assertion-prediction-divergence:test-general:test-safety"
    );
    expect(validation.metricsReportable).toBe(false);
  });

  it("makes metrics unreportable when a prediction is missing", () => {
    const rows = validPredictionRows().filter((row) => row.id !== "test-chat");
    const validation = validateNeuralPredictionRows(rows, goldRows);
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-id-missing:test-chat");
    expect(validation.metricsReportable).toBe(false);
    expect(evaluateNeuralPredictions(goldRows, validation, "test")).toBeNull();
  });

  it("makes metrics unreportable when an extra prediction is present", () => {
    const rows = [...validPredictionRows(), { id: "extra", input: "extra", candidates: [] }];
    const validation = validateNeuralPredictionRows(rows, goldRows);
    expect(validation.issueCodes).toContain("neural-evaluation.prediction-id-unknown:extra");
    expect(validation.metricsReportable).toBe(false);
    expect(evaluateNeuralPredictions(goldRows, validation, "test")).toBeNull();
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
    expect(validation.metricsReportable).toBe(true);
    const metrics = evaluateNeuralPredictions(goldRows, validation, "test");
    expect(validateNeuralEvaluationSafety(metrics).issueCodes).toEqual([
      "neural-evaluation.protected-false-conversion",
      "neural-evaluation.forbidden-candidate",
      "neural-evaluation.adversarial-forbidden-candidate"
    ]);
  });

  it("uses row categories for buckets instead of coupling metrics to suite IDs", () => {
    const categorized = [
      {
        ...gold("public-name", "niraj", "test", "public-indian-name-benchmark", ["निरज"], []),
        category: "name"
      }
    ];
    const predictions = validateNeuralPredictionRows(
      [{ id: "public-name", input: "niraj", candidates: ["निरज"] }],
      categorized
    );

    expect(predictions.metricsReportable).toBe(true);
    expect(evaluateNeuralPredictions(categorized, predictions, "test").namesTop3Accuracy).toBe(1);
  });
});

function gold(id, input, split, suiteId, acceptable, forbiddenOutputs) {
  return {
    id,
    input,
    split,
    suiteId,
    category: suiteId === "names" ? "name" : suiteId,
    expectedAction: "produce-candidate",
    acceptable,
    expected: acceptable.slice(0, 1),
    forbiddenOutputs,
    previousContext: []
  };
}

function loadCurrentGoldRows() {
  const manifest = JSON.parse(
    readFileSync(new URL("../../data/neural/gold/manifest.v3.json", import.meta.url), "utf8")
  );
  return manifest.suites.flatMap((suite) =>
    readFileSync(new URL(`../../${suite.path}`, import.meta.url), "utf8")
      .split(/\n/u)
      .filter(Boolean)
      .map((line) => ({ ...JSON.parse(line), suiteId: suite.id }))
  );
}

function normalizedDuplicateInputs(rows) {
  const counts = new Map();
  for (const row of rows) {
    const input = row.input.normalize("NFC").trim().toLowerCase().replace(/\s+/gu, " ");
    counts.set(input, (counts.get(input) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([input]) => input)
    .sort();
}

function predictions(rows) {
  return rows.map(([id, input, candidates]) => ({ id, input, candidates }));
}

function validPredictionRows() {
  return predictions([
    ["train-one", "bato", ["बाटो"]],
    ["test-one", "vato", ["बाटो"]],
    ["test-chat", "xau", ["छौ"]],
    ["test-name", "niraj", ["नीरज"]],
    ["test-adversarial", "xaina", ["छैन"]],
    ["test-protected", "GitHub", []]
  ]);
}
