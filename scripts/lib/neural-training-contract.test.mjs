import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalNeuralTrainingConfigPath,
  canonicalJsonText,
  canonicalJsonSha256,
  configuredNeuralTrainingContract,
  inspectTrainingReportBinding,
  neuralTrainingSampleIdentityDigests,
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
const ctcConfigPath = join(
  process.cwd(),
  "data",
  "neural",
  "training",
  "open-vocab-ctc-transformer-v2.config.json"
);

describe("neural training implementation contract", () => {
  it("resolves architecture-specific sampled-row identities", () => {
    expect(neuralTrainingSampleIdentityDigests({
      trainingSampleIdSha256: "a".repeat(64),
      devSampleIdSha256: "b".repeat(64)
    }, "baseline")).toEqual({
      train: "a".repeat(64),
      dev: "b".repeat(64)
    });
    expect(neuralTrainingSampleIdentityDigests({
      sampledRowDigests: {
        train: "c".repeat(64),
        dev: "d".repeat(64)
      }
    }, "ctc-transformer")).toEqual({
      train: "c".repeat(64),
      dev: "d".repeat(64)
    });
    expect(() => neuralTrainingSampleIdentityDigests({}, "unknown")).toThrow(
      /Unsupported neural training layout kind/u
    );
  });

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

  it("accepts the fixed-shape Transformer-CTC production contract", () => {
    const config = currentCTCConfig();

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([
      "Context language-model rescoring is disabled and not implemented."
    ]);
    expect(config.decoder.maximumCandidates).toBeLessThan(config.decoder.beamWidth);
  });

  it("maps every allowlisted candidate id to its canonical config", () => {
    expect(
      canonicalNeuralTrainingConfigPath(
        "lekh-open-vocab-seq2seq-v1",
        process.cwd()
      )
    ).toBe(configPath);
    expect(
      canonicalNeuralTrainingConfigPath(
        "lekh-open-vocab-bigru-attention-v1",
        process.cwd()
      )
    ).toBe(attentionConfigPath);
    expect(
      canonicalNeuralTrainingConfigPath(
        "lekh-open-vocab-ctc-transformer-v2",
        process.cwd()
      )
    ).toBe(ctcConfigPath);
    expect(() =>
      canonicalNeuralTrainingConfigPath("unregistered-model", process.cwd())
    ).toThrow(/Unsupported neural candidate modelId/u);
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

  it("resolves the Transformer-CTC candidate as one canonical Core ML model", () => {
    const layout = resolveNeuralTrainingLayout(
      currentCTCConfig(),
      ctcConfigPath,
      process.cwd()
    );

    expect(layout).toMatchObject({
      modelId: "lekh-open-vocab-ctc-transformer-v2",
      kind: "ctc-transformer",
      architecture: "fixed-shape-transformer-ctc",
      runtimeModelContract: "single-transformer-ctc-v1",
      successfulExportStatus: "passed-open-vocab-ctc-transformer-candidate",
      predictionsBackend: "coreml-compiled-transformer-ctc",
      candidateRootRelativePath:
        "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2"
    });
    expect(layout.artifacts.map((artifact) => [
      artifact.role,
      artifact.compiledModel.split("/").at(-1),
      artifact.mlpackage.split("/").at(-1)
    ])).toEqual([[
      "model",
      "LekhNeuralTransliterator.mlmodelc",
      "LekhNeuralTransliterator.mlpackage"
    ]]);
  });

  it("mirrors the executable Python CTC training-contract snapshot exactly", () => {
    const contract = configuredNeuralTrainingContract(currentCTCConfig());

    expect(contract).toEqual({
      architecture: {
        family: "fixed-shape-transformer-ctc",
        runtimeModelContract: "single-transformer-ctc-v1",
        modelDimension: 256,
        attentionHeads: 4,
        feedForwardDimension: 1024,
        encoderLayers: 6,
        dropout: 0.2
      },
      decoder: {
        type: "ctc-prefix-beam-search",
        blankId: 0,
        beamWidth: 8,
        maxInputGraphemes: 32,
        outputTimeSteps: 32,
        maximumCandidates: 4
      },
      training: {
        augmentation: {
          enabled: true,
          policy: "augmentation-chat-alias-v1",
          aliases: [
            { from: "chh", to: "x", weightMultiplier: 0.75 },
            { from: "bh", to: "v", weightMultiplier: 0.5 }
          ],
          heldOutCollisionPolicy: "reject",
          conflictingTrainingTargetPolicy: "reject"
        },
        sourceMultipliers: {
          "dictionary-ne-ranked": 1.5,
          "manual-ambiguity": 512,
          "manual-chat-tail": 2048,
          "manual-name": 128,
          "manual-x-ksha": 2048,
          "runtime-names": 4,
          "runtime-words": 1.5
        },
        optimizer: {
          type: "adamw",
          beta1: 0.9,
          beta2: 0.98,
          epsilon: 1e-9,
          weightDecay: 0.0001
        },
        scheduler: {
          type: "linear-warmup-inverse-square-root",
          warmupSteps: 4000
        }
      },
      trainingRun: {
        seed: 42,
        maximumTrainRows: 1_000_000,
        maximumDevRows: 50_000,
        maximumEpochs: 30,
        batchSize: 256,
        peakLearningRate: 0.001,
        gradientClipNorm: 1,
        earlyStopping: {
          enabled: true,
          metric: "dev-weighted-ctc-loss",
          patienceEpochs: 4,
          minimumDelta: 0.0001,
          restoreBestWeights: true
        }
      }
    });
  });

  it("fails closed on Transformer-CTC architecture, decoder, optimizer, and path drift", () => {
    const config = currentCTCConfig();
    config.architecture.runtimeModelContract = "single-seq2seq-v1";
    config.architecture.modelDimension = 255;
    config.decoder.blankId = 1;
    config.decoder.maximumCandidates = 9;
    config.training.samplingPolicy.sourceMultipliers["runtime-names"] = 0;
    config.training.augmentation.aliases[0].to = "chh";
    config.training.optimizer.beta2 = 1;
    config.export.compiledModel = "models/macos/Other.mlmodelc";
    config.trainingRun.earlyStopping.patienceEpochs = 3;

    const result = validateNeuralTrainingConfig(config);

    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("runtimeModelContract"),
      expect.stringContaining("modelDimension"),
      expect.stringContaining("divide evenly"),
      expect.stringContaining("blankId"),
      expect.stringContaining("maximumCandidates"),
      expect.stringContaining("sourceMultipliers"),
      expect.stringContaining("augmentation"),
      expect.stringContaining("optimizer"),
      expect.stringContaining("export.compiledModel"),
      expect.stringContaining("early-stopping patience")
    ]));
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

function currentCTCConfig() {
  return JSON.parse(readFileSync(ctcConfigPath, "utf8"));
}
