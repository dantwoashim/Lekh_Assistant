import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonText,
  canonicalJsonSha256,
  configuredNeuralTrainingContract,
  inspectTrainingReportBinding,
  sha256Text,
  validateNeuralTrainingConfig
} from "./neural-training-contract.mjs";

const configPath = join(process.cwd(), "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");

describe("neural training implementation contract", () => {
  it("accepts the truthful schema-v2 candidate config without requiring an estimated parameter count", () => {
    const config = currentConfig();
    delete config.architecture.estimatedParameterCount;

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      "Context language-model rescoring is disabled and not implemented."
    ]);
  });

  it("rejects unimplemented architecture and optimization claims", () => {
    const config = currentConfig();
    config.architecture.hiddenDim = 192;
    config.architecture.attention = "additive";
    config.decoder.beamWidth = 4;
    config.decoder.maximumCandidates = 8;
    config.trainingRun.labelSmoothing = 0;
    config.trainingRun.earlyStopping.restoreBestWeights = false;
    config.training.samplingPolicy.sourceMultipliers["human-reviewed-lekh-gold-v1"] = 10;
    config.export.compiledModel = "models/macos/Other.mlmodelc";
    config.context.previousWords = 2;
    config.context.languageModelRescorer = { enabled: true, status: "implemented", weight: 0.12 };

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("hiddenDim"),
      expect.stringContaining("attention mechanism"),
      expect.stringContaining("native v1 width of 2"),
      expect.stringContaining("maximumCandidates must equal beamWidth"),
      expect.stringContaining("labelSmoothing"),
      expect.stringContaining("restore the best weights"),
      expect.stringContaining("sourceMultipliers must be empty"),
      expect.stringContaining("export.compiledModel"),
      expect.stringContaining("requires context rescoring to remain disabled")
    ]));
  });

  it("accepts a report bound exactly to the current config and effective settings", () => {
    const config = currentConfig();
    const configuredContract = configuredNeuralTrainingContract(config);
    const result = inspectTrainingReportBinding({
      trainingContractSha256: "a".repeat(64),
      configuredContract,
      report: {
        trainingContractSha256: "a".repeat(64),
        configuredTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfigCanonicalJson: canonicalJsonText(configuredContract),
        effectiveTrainingConfigSha256: canonicalJsonSha256(configuredContract),
        trainingOverrides: {}
      }
    });

    expect(result).toEqual({ bound: true, issues: [], effectiveDifferences: [] });
  });

  it("detects a stale report and config differences without override provenance", () => {
    const config = currentConfig();
    const configuredContract = configuredNeuralTrainingContract(config);
    const effectiveTrainingConfig = structuredClone(configuredContract);
    effectiveTrainingConfig.trainingRun.maximumEpochs = 2;

    const result = inspectTrainingReportBinding({
      trainingContractSha256: "a".repeat(64),
      configuredContract,
      report: {
        trainingContractSha256: "b".repeat(64),
        configuredTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfig,
        effectiveTrainingConfigCanonicalJson: canonicalJsonText(effectiveTrainingConfig),
        effectiveTrainingConfigSha256: canonicalJsonSha256(effectiveTrainingConfig)
      }
    });

    expect(result.bound).toBe(false);
    expect(result.effectiveDifferences).toEqual(["trainingRun.maximumEpochs"]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("stale"),
      expect.stringContaining("does not record trainingOverrides"),
      expect.stringContaining("without trainingOverrides provenance")
    ]));
  });

  it("records explicit development overrides without treating them as an unproven difference", () => {
    const config = currentConfig();
    const configuredContract = configuredNeuralTrainingContract(config);
    const effectiveTrainingConfig = structuredClone(configuredContract);
    effectiveTrainingConfig.trainingRun.maximumEpochs = 2;

    const result = inspectTrainingReportBinding({
      trainingContractSha256: "a".repeat(64),
      configuredContract,
      report: {
        trainingContractSha256: "a".repeat(64),
        configuredTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfig,
        effectiveTrainingConfigCanonicalJson: canonicalJsonText(effectiveTrainingConfig),
        effectiveTrainingConfigSha256: canonicalJsonSha256(effectiveTrainingConfig),
        trainingOverrides: {
          "trainingRun.maximumEpochs": {
            configured: 8,
            effective: 2,
            source: "LEKH_NEURAL_EPOCHS"
          }
        }
      }
    });

    expect(result.bound).toBe(false);
    expect(result.issues).toEqual([
      "Training report used explicit config overrides: trainingRun.maximumEpochs."
    ]);
  });

  it("rejects a tampered effective-config digest", () => {
    const config = currentConfig();
    const configuredContract = configuredNeuralTrainingContract(config);
    const result = inspectTrainingReportBinding({
      trainingContractSha256: "a".repeat(64),
      configuredContract,
      report: {
        trainingContractSha256: "a".repeat(64),
        configuredTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfigCanonicalJson: canonicalJsonText(configuredContract),
        effectiveTrainingConfigSha256: "b".repeat(64),
        trainingOverrides: {}
      }
    });

    expect(result.bound).toBe(false);
    expect(result.issues).toEqual(["Training report effectiveTrainingConfigSha256 is invalid."]);
  });

  it("verifies the producer's exponent spelling instead of reserializing numbers", () => {
    const config = currentConfig();
    const configuredContract = configuredNeuralTrainingContract(config);
    const effectiveTrainingConfig = structuredClone(configuredContract);
    effectiveTrainingConfig.trainingRun.learningRate = 1e-7;
    const producerCanonicalJson = canonicalJsonText(effectiveTrainingConfig).replace("1e-7", "1e-07");
    const result = inspectTrainingReportBinding({
      trainingContractSha256: "a".repeat(64),
      configuredContract,
      report: {
        trainingContractSha256: "a".repeat(64),
        configuredTrainingConfig: structuredClone(configuredContract),
        effectiveTrainingConfig,
        effectiveTrainingConfigCanonicalJson: producerCanonicalJson,
        effectiveTrainingConfigSha256: sha256Text(producerCanonicalJson),
        trainingOverrides: {
          "trainingRun.learningRate": {
            configured: configuredContract.trainingRun.learningRate,
            effective: 1e-7,
            source: "command-line"
          }
        }
      }
    });

    expect(result.issues).toEqual(["Training report used explicit config overrides: trainingRun.learningRate."]);
  });
});

function currentConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}
