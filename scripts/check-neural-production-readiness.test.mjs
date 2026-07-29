import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNeuralProductionGatePlan,
  verifyRetainedSelectionEvidence
} from "./check-neural-production-readiness.mjs";

const root = process.cwd();
let fixtureRoot;

beforeEach(() => {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  fixtureRoot = mkdtempSync(join(root, ".tmp/neural-production-proof-"));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("neural production re-verification plan", () => {
  it("binds every candidate-specific gate to a Transformer-CTC winner", () => {
    const plan = buildNeuralProductionGatePlan({
      repoRoot: root,
      through: "phase0-10",
      configPath:
        `${root}/data/neural/training/open-vocab-ctc-transformer-v2.config.json`,
      candidateRoot:
        `${root}/data/generated/neural-open-vocab-model/` +
        "lekh-open-vocab-ctc-transformer-v2",
      candidateSpecifications: [
        `${root}/reports/baseline-spec.json`,
        `${root}/reports/ctc-spec.json`
      ],
      predictionsPath:
        `${root}/data/generated/neural-open-vocab-model/` +
        "lekh-open-vocab-ctc-transformer-v2/gold-predictions.jsonl",
      exportReportPath:
        `${root}/data/generated/neural-open-vocab-model/` +
        "lekh-open-vocab-ctc-transformer-v2/export-report.json",
      runtimePlacementEvidence:
        `${root}/reports/neural-runtime-placement-evidence.json`,
      bundle: "/tmp/Lekh Keyboard.imkdevbundle"
    });
    const training = plan.find((command) =>
      command.label === "phase4-training-contract"
    );
    const evaluation = plan.find((command) =>
      command.label === "phase5-evaluation"
    );
    const selection = plan.find((command) =>
      command.label === "phase9-model-selection"
    );
    const native = plan.find((command) =>
      command.label === "phase5-native-service"
    );

    expect(training.args.join(" ")).toContain(
      "open-vocab-ctc-transformer-v2.config.json"
    );
    expect(training.args.join(" ")).toContain(
      "lekh-open-vocab-ctc-transformer-v2"
    );
    expect(evaluation.args.join(" ")).toContain(
      "lekh-open-vocab-ctc-transformer-v2/gold-predictions.jsonl"
    );
    expect(selection.args.filter((argument) =>
      argument === "--candidate-spec"
    )).toHaveLength(2);
    expect(native.args).toContain("--runtime-placement-evidence");
    expect(plan.at(-1)?.label).toBe("phase10-final-readiness");
  });

  it("keeps the legacy partial ranges bounded", () => {
    const common = {
      repoRoot: root,
      configPath:
        `${root}/data/neural/training/open-vocab-seq2seq-v1.config.json`,
      candidateRoot:
        `${root}/data/generated/neural-open-vocab-model/` +
        "lekh-open-vocab-seq2seq-v1",
      candidateSpecifications: [
        `${root}/reports/baseline-spec.json`,
        `${root}/reports/attention-spec.json`
      ],
      predictionsPath:
        `${root}/data/generated/neural-open-vocab-model/` +
        "lekh-open-vocab-seq2seq-v1/gold-predictions.jsonl",
      exportReportPath:
        `${root}/data/generated/neural-open-vocab-model/` +
        "lekh-open-vocab-seq2seq-v1/export-report.json",
      runtimePlacementEvidence:
        `${root}/reports/neural-runtime-placement-evidence.json`,
      bundle: "/tmp/Lekh Keyboard.imkdevbundle"
    };

    const phase6 = buildNeuralProductionGatePlan({
      ...common,
      through: "phase3-6"
    });
    const phase9 = buildNeuralProductionGatePlan({
      ...common,
      through: "phase3-9"
    });

    expect(phase6.some((command) =>
      command.label === "phase8-training-run"
    )).toBe(false);
    expect(phase9.some((command) =>
      command.label === "phase9-promotion"
    )).toBe(true);
    expect(phase9.some((command) =>
      command.label === "phase10-final-readiness"
    )).toBe(false);
  });

  it("re-hashes every retained candidate evidence file", () => {
    const baseline = writeEvidence("baseline-spec.json", "baseline\n");
    const attention = writeEvidence("attention-spec.json", "attention\n");
    const selection = {
      candidates: [
        candidate("baseline:11111111111111111111111111111111", baseline),
        candidate("attention:22222222222222222222222222222222", attention)
      ]
    };

    expect(verifyRetainedSelectionEvidence({
      repoRoot: root,
      selection
    })).toEqual([baseline.path, attention.path]);

    writeFileSync(attention.path, "changed\n");
    expect(() => verifyRetainedSelectionEvidence({
      repoRoot: root,
      selection
    })).toThrow(/changed after the retained model selection/u);
  });
});

function writeEvidence(name, contents) {
  const path = join(fixtureRoot, name);
  writeFileSync(path, contents);
  return {
    path,
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

function candidate(candidateId, specification) {
  return {
    candidateId,
    evidence: {
      specification
    }
  };
}
