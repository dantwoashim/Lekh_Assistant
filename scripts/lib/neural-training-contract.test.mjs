import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonText,
  canonicalJsonSha256,
  configuredNeuralTrainingContract,
  inspectTrainingReportBinding,
  resolveNeuralTrainingLayout,
  sha256Text,
  validateNeuralTrainingConfig
} from "./neural-training-contract.mjs";

const configPath = join(process.cwd(), "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");
const attentionConfigPath = join(
  process.cwd(),
  "data",
  "neural",
  "training",
  "open-vocab-bigru-attention-v1.config.json"
);

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

  it("accepts the implemented split-attention candidate contract", () => {
    const config = JSON.parse(readFileSync(attentionConfigPath, "utf8"));

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      "Context language-model rescoring is disabled and not implemented."
    ]);
    expect(configuredNeuralTrainingContract(config).architecture.attentionDim).toBe(256);
  });

  it("resolves the complete baseline candidate layout", () => {
    const layout = resolveNeuralTrainingLayout(
      currentConfig(),
      configPath,
      process.cwd()
    );

    expect(layout).toMatchObject({
      modelId: "lekh-open-vocab-seq2seq-v1",
      kind: "baseline",
      runtimeModelContract: "single-seq2seq-v1",
      successfulExportStatus: "passed-open-vocab-seq2seq-candidate",
      predictionsBackend: "coreml-compiled-model",
      candidateRootRelativePath:
        "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1"
    });
    expect(layout.artifacts.map((artifact) => artifact.role)).toEqual(["model"]);
    expect(layout.configuredArtifactInputs.officialBenchmarkManifest).toBe(
      "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
    );
  });

  it("resolves both split-attention runtime artifacts from the naming anchor", () => {
    const config = JSON.parse(readFileSync(attentionConfigPath, "utf8"));
    const layout = resolveNeuralTrainingLayout(
      config,
      attentionConfigPath,
      process.cwd()
    );

    expect(layout).toMatchObject({
      modelId: "lekh-open-vocab-bigru-attention-v1",
      kind: "split-attention",
      runtimeModelContract: "split-attention-incremental-v1",
      successfulExportStatus: "passed-open-vocab-attention-split-candidate",
      predictionsBackend: "coreml-compiled-split-attention-models"
    });
    expect(layout.artifacts.map((artifact) => [
      artifact.role,
      artifact.compiledModel.split("/").at(-1),
      artifact.mlpackage.split("/").at(-1)
    ])).toEqual([
      [
        "encoder",
        "LekhNeuralTransliteratorEncoder.mlmodelc",
        "LekhNeuralTransliteratorEncoder.mlpackage"
      ],
      [
        "decoderStep",
        "LekhNeuralTransliteratorDecoderStep.mlmodelc",
        "LekhNeuralTransliteratorDecoderStep.mlpackage"
      ]
    ]);
  });

  it("rejects a supported model config loaded from a non-canonical path", () => {
    expect(() => resolveNeuralTrainingLayout(
      currentConfig(),
      join(process.cwd(), "data", "neural", "training", "renamed.json"),
      process.cwd()
    )).toThrow(/canonical path/u);
  });

  it("rejects unimplemented architecture and optimization claims", () => {
    const config = currentConfig();
    config.architecture.hiddenDim = 192;
    config.architecture.attention = "additive";
    config.decoder.beamWidth = 9;
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
      expect.stringContaining("beamWidth must be an integer in 2..8"),
      expect.stringContaining("maximumCandidates must equal beamWidth"),
      expect.stringContaining("labelSmoothing"),
      expect.stringContaining("restore the best weights"),
      expect.stringContaining("sourceMultipliers must be empty"),
      expect.stringContaining("export.compiledModel"),
      expect.stringContaining("requires context rescoring to remain disabled")
    ]));
  });

  it("rejects a model id paired with another candidate's architecture and paths", () => {
    const config = currentConfig();
    config.modelId = "lekh-open-vocab-bigru-attention-v1";

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("canonical compiled-model path"),
      expect.stringContaining("canonical model-manifest path"),
      expect.stringContaining("architecture family"),
      expect.stringContaining("attention mechanism")
    ]));
  });

  it("requires canonical Aksharantar and rejects same-lineage mirrors", () => {
    const config = currentConfig();
    config.training.requiredSources = config.training.requiredSources
      .filter((source) => source !== "ai4bharat-aksharantar-nepali");
    config.training.requiredSources.push(
      "syubraj-roman2nepali-transliteration",
      "saugatkafley-nepali-roman-transliteration"
    );
    config.training.splitPolicy = "stable-hash-by-normalized-input";

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("connected normalized inputs and targets"),
      expect.stringContaining("missing required training source ai4bharat-aksharantar-nepali"),
      expect.stringContaining("blocked lineage mirror syubraj-roman2nepali-transliteration"),
      expect.stringContaining("blocked lineage mirror saugatkafley-nepali-roman-transliteration")
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
