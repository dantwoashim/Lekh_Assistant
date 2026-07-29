import { createHash } from "node:crypto";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

const CANONICAL_PUBLIC_SOURCE = "ai4bharat-aksharantar-nepali";
const BLOCKED_MIRROR_SOURCES = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];
const ARCHITECTURE_PROFILES = Object.freeze({
  "lekh-open-vocab-seq2seq-v1": Object.freeze({
    configPath: "data/neural/training/open-vocab-seq2seq-v1.config.json",
    trainerPath: "scripts/train-open-vocab-seq2seq-transliterator.py",
    kind: "baseline",
    family: "gru-encoder-decoder-seq2seq",
    runtimeModelContract: "single-seq2seq-v1",
    successfulExportStatus: "passed-open-vocab-seq2seq-candidate",
    predictionsBackend: "coreml-compiled-model",
    attention: "none",
    encoderLayers: 2,
    decoderLayers: 2,
    embeddingDim: 96,
    hiddenDim: 256,
    attentionDim: 256,
    dropout: 0.12,
    artifact: Object.freeze({
      compiledModel: "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.mlmodelc",
      manifest: "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.manifest.json",
      vocabMetadata: "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.vocab.json"
    }),
    export: Object.freeze({
      sourceCheckpoint: "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/checkpoint.pt",
      intermediateMLPackage: "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.mlpackage"
    })
  }),
  "lekh-open-vocab-bigru-attention-v1": Object.freeze({
    configPath: "data/neural/training/open-vocab-bigru-attention-v1.config.json",
    trainerPath: "scripts/train-open-vocab-seq2seq-transliterator.py",
    kind: "split-attention",
    family: "bidirectional-gru-additive-attention-seq2seq",
    runtimeModelContract: "split-attention-incremental-v1",
    successfulExportStatus: "passed-open-vocab-attention-split-candidate",
    predictionsBackend: "coreml-compiled-split-attention-models",
    attention: "bahdanau-additive",
    encoderLayers: 2,
    decoderLayers: 2,
    embeddingDim: 128,
    hiddenDim: 256,
    attentionDim: 256,
    dropout: 0.15,
    artifact: Object.freeze({
      compiledModel: "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.mlmodelc",
      manifest: "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.manifest.json",
      vocabMetadata: "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.vocab.json"
    }),
    export: Object.freeze({
      sourceCheckpoint: "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/checkpoint.pt",
      intermediateMLPackage: "data/generated/neural-open-vocab-model/lekh-open-vocab-bigru-attention-v1/LekhNeuralTransliterator.mlpackage"
    })
  }),
  "lekh-open-vocab-ctc-transformer-v2": Object.freeze({
    configPath: "data/neural/training/open-vocab-ctc-transformer-v2.config.json",
    trainerPath: "scripts/train-open-vocab-ctc-transformer.py",
    kind: "ctc-transformer",
    family: "fixed-shape-transformer-ctc",
    runtimeModelContract: "single-transformer-ctc-v1",
    successfulExportStatus: "passed-open-vocab-ctc-transformer-candidate",
    predictionsBackend: "coreml-compiled-transformer-ctc",
    modelDimension: 256,
    attentionHeads: 4,
    feedForwardDimension: 1024,
    encoderLayers: 6,
    dropout: 0.2,
    decoder: Object.freeze({
      type: "ctc-prefix-beam-search",
      blankId: 0,
      beamWidth: 8,
      maxInputGraphemes: 32,
      outputTimeSteps: 32,
      maximumCandidates: 4
    }),
    artifact: Object.freeze({
      compiledModel: "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2/LekhNeuralTransliterator.mlmodelc",
      manifest: "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2/LekhNeuralTransliterator.manifest.json",
      vocabMetadata: "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2/LekhNeuralTransliterator.vocab.json"
    }),
    export: Object.freeze({
      sourceCheckpoint: "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2/checkpoint.pt",
      intermediateMLPackage: "data/generated/neural-open-vocab-model/lekh-open-vocab-ctc-transformer-v2/LekhNeuralTransliterator.mlpackage"
    })
  })
});

const CTC_SOURCE_MULTIPLIERS = Object.freeze({
  "dictionary-ne-ranked": 1.5,
  "manual-ambiguity": 512,
  "manual-chat-tail": 2048,
  "manual-name": 128,
  "manual-x-ksha": 2048,
  "runtime-names": 4,
  "runtime-words": 1.5
});

const CTC_AUGMENTATION = Object.freeze({
  enabled: true,
  policy: "augmentation-chat-alias-v1",
  aliases: Object.freeze([
    Object.freeze({ from: "chh", to: "x", weightMultiplier: 0.75 }),
    Object.freeze({ from: "bh", to: "v", weightMultiplier: 0.5 })
  ]),
  heldOutCollisionPolicy: "reject",
  conflictingTrainingTargetPolicy: "reject"
});

const CTC_OPTIMIZER = Object.freeze({
  type: "adamw",
  beta1: 0.9,
  beta2: 0.98,
  epsilon: 1e-9,
  weightDecay: 0.0001
});

const CTC_SCHEDULER = Object.freeze({
  type: "linear-warmup-inverse-square-root",
  warmupSteps: 4000
});

const ARTIFACT_NAMES = Object.freeze({
  checkpoint: "checkpoint.pt",
  trainingReport: "training-report.json",
  exportReport: "export-report.json",
  manifest: "LekhNeuralTransliterator.manifest.json",
  vocabulary: "LekhNeuralTransliterator.vocab.json",
  measurements: "coreml-device-measurements.json",
  goldPredictions: "gold-predictions.jsonl",
  officialBenchmarkPredictions: "official-benchmark-predictions.jsonl",
  baselineCompiledModel: "LekhNeuralTransliterator.mlmodelc",
  baselineMLPackage: "LekhNeuralTransliterator.mlpackage",
  attentionEncoderCompiledModel: "LekhNeuralTransliteratorEncoder.mlmodelc",
  attentionEncoderMLPackage: "LekhNeuralTransliteratorEncoder.mlpackage",
  attentionDecoderCompiledModel: "LekhNeuralTransliteratorDecoderStep.mlmodelc",
  attentionDecoderMLPackage: "LekhNeuralTransliteratorDecoderStep.mlpackage"
});

export class NeuralTrainingLayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralTrainingLayoutError";
  }
}

export function canonicalNeuralTrainingConfigPath(
  modelId,
  repoRoot = process.cwd()
) {
  const profile = ARCHITECTURE_PROFILES[modelId];
  if (!profile) {
    throw new NeuralTrainingLayoutError(
      `Unsupported neural candidate modelId: ${JSON.stringify(modelId)}.`
    );
  }
  return resolve(repoRoot, profile.configPath);
}

export function neuralTrainingSampleIdentityDigests(report, layoutKind) {
  if (!isRecord(report)) {
    throw new NeuralTrainingLayoutError(
      "Training report must be an object."
    );
  }
  if (layoutKind === "ctc-transformer") {
    return {
      train: report.sampledRowDigests?.train,
      dev: report.sampledRowDigests?.dev
    };
  }
  if (layoutKind === "baseline" || layoutKind === "split-attention") {
    return {
      train: report.trainingSampleIdSha256,
      dev: report.devSampleIdSha256
    };
  }
  throw new NeuralTrainingLayoutError(
    `Unsupported neural training layout kind: ${JSON.stringify(layoutKind)}.`
  );
}

/**
 * Resolve the immutable candidate layout from one allowlisted executable
 * training config. The generic compiledModel path in an attention config is a
 * naming anchor; the runtime artifacts are the encoder and decoder-step
 * bundles returned in `artifacts`.
 */
export function resolveNeuralTrainingLayout(config, configPath, repoRoot = process.cwd()) {
  if (!isRecord(config)) {
    throw new NeuralTrainingLayoutError("Training config must be a JSON object.");
  }
  const profile = ARCHITECTURE_PROFILES[config.modelId];
  if (!profile) {
    throw new NeuralTrainingLayoutError(
      `Unsupported neural candidate modelId: ${JSON.stringify(config.modelId)}.`
    );
  }
  const root = resolve(repoRoot);
  const resolvedConfigPath = containedPath(root, configPath, "Training config");
  const expectedConfigPath = resolve(root, profile.configPath);
  if (resolvedConfigPath !== expectedConfigPath) {
    throw new NeuralTrainingLayoutError(
      `Training config ${portable(root, resolvedConfigPath)} does not match ` +
      `${config.modelId}'s canonical path ${profile.configPath}.`
    );
  }

  const candidateRoot = dirname(
    containedRecordedPath(root, config.export?.sourceCheckpoint, "export.sourceCheckpoint")
  );
  const expectedCandidateRoot = resolve(
    root,
    "data",
    "generated",
    "neural-open-vocab-model",
    config.modelId
  );
  if (candidateRoot !== expectedCandidateRoot) {
    throw new NeuralTrainingLayoutError(
      `Candidate root must be data/generated/neural-open-vocab-model/${config.modelId}.`
    );
  }

  const paths = Object.fromEntries(
    Object.entries({
      checkpoint: ARTIFACT_NAMES.checkpoint,
      trainingReport: ARTIFACT_NAMES.trainingReport,
      exportReport: ARTIFACT_NAMES.exportReport,
      manifest: ARTIFACT_NAMES.manifest,
      vocabulary: ARTIFACT_NAMES.vocabulary,
      measurements: ARTIFACT_NAMES.measurements,
      goldPredictions: ARTIFACT_NAMES.goldPredictions,
      officialBenchmarkPredictions: ARTIFACT_NAMES.officialBenchmarkPredictions
    }).map(([key, name]) => [key, join(candidateRoot, name)])
  );
  const expectedConfigBindings = {
    sourceCheckpoint: paths.checkpoint,
    intermediateMLPackage: join(candidateRoot, ARTIFACT_NAMES.baselineMLPackage),
    compiledModel: join(candidateRoot, ARTIFACT_NAMES.baselineCompiledModel),
    manifest: paths.manifest,
    vocabMetadata: paths.vocabulary
  };
  for (const [field, expected] of Object.entries(expectedConfigBindings)) {
    const actual = containedRecordedPath(
      root,
      config.export?.[field],
      `export.${field}`
    );
    if (actual !== expected) {
      throw new NeuralTrainingLayoutError(
        `Config export.${field} must be ${portable(root, expected)}.`
      );
    }
  }
  for (const [field, expected] of Object.entries({
    compiledModel: expectedConfigBindings.compiledModel,
    manifest: expectedConfigBindings.manifest,
    vocabMetadata: expectedConfigBindings.vocabMetadata
  })) {
    const actual = containedRecordedPath(
      root,
      config.artifact?.[field],
      `artifact.${field}`
    );
    if (actual !== expected) {
      throw new NeuralTrainingLayoutError(
        `Config artifact.${field} must be ${portable(root, expected)}.`
      );
    }
  }

  const artifacts = profile.kind === "split-attention"
    ? [
        {
          role: "encoder",
          compiledModel: join(
            candidateRoot,
            ARTIFACT_NAMES.attentionEncoderCompiledModel
          ),
          mlpackage: join(
            candidateRoot,
            ARTIFACT_NAMES.attentionEncoderMLPackage
          )
        },
        {
          role: "decoderStep",
          compiledModel: join(
            candidateRoot,
            ARTIFACT_NAMES.attentionDecoderCompiledModel
          ),
          mlpackage: join(
            candidateRoot,
            ARTIFACT_NAMES.attentionDecoderMLPackage
          )
        }
      ]
    : [{
        role: "model",
        compiledModel: expectedConfigBindings.compiledModel,
        mlpackage: expectedConfigBindings.intermediateMLPackage
      }];
  const datasetManifest = containedRecordedPath(
    root,
    config.training?.datasetManifest,
    "training.datasetManifest"
  );
  const goldManifest = containedRecordedPath(
    root,
    config.evaluation?.goldManifest,
    "evaluation.goldManifest"
  );
  const officialBenchmarkManifest = containedRecordedPath(
    root,
    config.evaluation?.officialBenchmarkManifest,
    "evaluation.officialBenchmarkManifest"
  );
  const configuredArtifactInputs = {
    trainingConfig: portable(root, resolvedConfigPath),
    datasetManifest: portable(root, datasetManifest),
    goldManifest: portable(root, goldManifest),
    officialBenchmarkManifest: portable(root, officialBenchmarkManifest),
    outDir: portable(root, candidateRoot),
    compiledModel: portable(root, expectedConfigBindings.compiledModel),
    manifest: portable(root, paths.manifest),
    vocabMetadata: portable(root, paths.vocabulary)
  };

  return deepFreeze({
    modelId: config.modelId,
    kind: profile.kind,
    architecture: profile.family,
    runtimeModelContract: profile.runtimeModelContract,
    successfulExportStatus: profile.successfulExportStatus,
    predictionsBackend: profile.predictionsBackend,
    root,
    configPath: resolvedConfigPath,
    configRelativePath: portable(root, resolvedConfigPath),
    trainerPath: resolve(root, profile.trainerPath),
    trainerRelativePath: profile.trainerPath,
    candidateRoot,
    candidateRootRelativePath: portable(root, candidateRoot),
    datasetManifest,
    goldManifest,
    officialBenchmarkManifest,
    paths,
    artifacts,
    configuredArtifactInputs
  });
}

export function configuredNeuralTrainingContract(config) {
  const profile = ARCHITECTURE_PROFILES[config?.modelId];
  if (profile?.kind === "ctc-transformer") {
    return {
      architecture: {
        family: config?.architecture?.family,
        runtimeModelContract: config?.architecture?.runtimeModelContract,
        modelDimension: config?.architecture?.modelDimension,
        attentionHeads: config?.architecture?.attentionHeads,
        feedForwardDimension: config?.architecture?.feedForwardDimension,
        encoderLayers: config?.architecture?.encoderLayers,
        dropout: config?.architecture?.dropout
      },
      decoder: {
        type: config?.decoder?.type,
        blankId: config?.decoder?.blankId,
        beamWidth: config?.decoder?.beamWidth,
        maxInputGraphemes: config?.decoder?.maxInputGraphemes,
        outputTimeSteps: config?.decoder?.outputTimeSteps,
        maximumCandidates: config?.decoder?.maximumCandidates
      },
      training: {
        augmentation: structuredClone(config?.training?.augmentation ?? null),
        sourceMultipliers: structuredClone(
          config?.training?.samplingPolicy?.sourceMultipliers ?? null
        ),
        optimizer: structuredClone(config?.training?.optimizer ?? null),
        scheduler: structuredClone(config?.training?.scheduler ?? null)
      },
      trainingRun: structuredClone(config?.trainingRun ?? null)
    };
  }
  return {
    architecture: {
      family: config?.architecture?.family,
      encoderLayers: config?.architecture?.encoderLayers,
      decoderLayers: config?.architecture?.decoderLayers,
      embeddingDim: config?.architecture?.embeddingDim,
      hiddenDim: config?.architecture?.hiddenDim,
      attentionDim: config?.architecture?.attentionDim ?? config?.architecture?.hiddenDim,
      attention: config?.architecture?.attention,
      dropout: config?.architecture?.dropout
    },
    decoder: {
      type: config?.decoder?.type,
      beamWidth: config?.decoder?.beamWidth,
      maxInputGraphemes: config?.decoder?.maxInputGraphemes,
      maxOutputGraphemes: config?.decoder?.maxOutputGraphemes,
      maximumCandidates: config?.decoder?.maximumCandidates
    },
    trainingRun: structuredClone(config?.trainingRun ?? null)
  };
}

export function validateNeuralTrainingConfig(config) {
  const failures = [];
  const warnings = [];

  if (!isRecord(config)) {
    failures.push("Training config must be a JSON object.");
    return result();
  }

  const profile = ARCHITECTURE_PROFILES[config.modelId];
  if (profile?.kind === "ctc-transformer") {
    return validateCTCNeuralTrainingConfig(config, profile);
  }

  requireEqual(config.schemaVersion, 2, "Config schemaVersion must be 2.");
  requireEqual(config.implementationContractVersion, 1, "Config implementationContractVersion must be 1.");
  if (!profile) {
    failures.push(`Config modelId names an unsupported executable candidate: ${JSON.stringify(config.modelId)}.`);
  }
  if (profile) {
    requireEqual(config.artifact?.compiledModel, profile.artifact.compiledModel, "Config must declare the candidate's canonical compiled-model path.");
    requireEqual(config.artifact?.manifest, profile.artifact.manifest, "Config must declare the candidate's canonical model-manifest path.");
    if (config.artifact?.vocabMetadata !== undefined) {
      requireEqual(config.artifact.vocabMetadata, profile.artifact.vocabMetadata, "Config must declare the candidate's canonical vocabulary path.");
    }
  }
  requireEqual(config.artifact?.runtime, "CoreML", "Config runtime must be CoreML.");
  requireEqual(config.artifact?.localOnly, true, "Config must be local-only.");
  requireEqual(config.artifact?.neuralTailOnly, true, "Config must be neural-tail-only.");
  if (profile) {
    requireEqual(config.export?.sourceCheckpoint, profile.export.sourceCheckpoint, "Config must declare the candidate's canonical source checkpoint path.");
    requireEqual(config.export?.intermediateMLPackage, profile.export.intermediateMLPackage, "Config must declare the candidate's canonical intermediate package path.");
    if (config.export?.vocabMetadata !== undefined) {
      requireEqual(config.export.vocabMetadata, profile.artifact.vocabMetadata, "Config export must declare the candidate's canonical vocabulary path.");
    }
  }
  requireEqual(config.export?.compiledModel, config.artifact?.compiledModel, "Config export.compiledModel must match artifact.compiledModel.");
  requireEqual(config.export?.manifest, config.artifact?.manifest, "Config export.manifest must match artifact.manifest.");

  const architecture = config.architecture;
  requireEqual(architecture?.openVocabulary, true, "Config must describe an open-vocabulary model.");
  requireEqual(architecture?.tokenization, "unicode-scalar-character", "Config must describe the implemented Unicode-scalar tokenizer.");
  if (profile) {
    requireEqual(architecture?.family, profile.family, "Config architecture family must match its executable candidate.");
    requireEqual(architecture?.encoderLayers, profile.encoderLayers, "Config encoderLayers must match the implementation contract.");
    requireEqual(architecture?.decoderLayers, profile.decoderLayers, "Config decoderLayers must match the implementation contract.");
    requireEqual(architecture?.embeddingDim, profile.embeddingDim, "Config embeddingDim must match the implementation contract.");
    requireEqual(architecture?.hiddenDim, profile.hiddenDim, "Config hiddenDim must match the implementation contract.");
    requireEqual(architecture?.attentionDim ?? architecture?.hiddenDim, profile.attentionDim, "Config attentionDim must match the implementation contract.");
    requireEqual(architecture?.attention, profile.attention, "Config attention mechanism must match its executable candidate.");
    requireEqual(architecture?.dropout, profile.dropout, "Config dropout must match the implementation contract.");
  }
  requireEqual(architecture?.minimumParameterCount, 1_000_000, "Config minimumParameterCount must be the frozen 1,000,000 lower bound.");
  requireEqual(architecture?.maximumParameterCount, 5_000_000, "Config maximumParameterCount must be the frozen 5,000,000 upper bound.");
  requireEqual(architecture?.maximumCompiledBytes, 16_777_216, "Config maximumCompiledBytes must be 16,777,216.");

  const decoder = config.decoder;
  requireEqual(decoder?.type, "beam-search", "Config decoder type must be beam-search.");
  requireIntegerInRange(decoder?.beamWidth, 2, 8, "Config beamWidth");
  requireIntegerInRange(decoder?.maxInputGraphemes, 2, 64, "Config maxInputGraphemes");
  requireIntegerInRange(decoder?.maxOutputGraphemes, 2, 64, "Config maxOutputGraphemes");
  requireIntegerInRange(decoder?.maximumCandidates, 1, 8, "Config maximumCandidates");
  if (decoder?.maximumCandidates !== decoder?.beamWidth) {
    failures.push("Config maximumCandidates must equal beamWidth so Python evidence and the native runtime expose the same candidate bound.");
  }
  requireEqual(decoder?.rejectWhitespaceOutput, true, "Config must reject whitespace outputs.");
  requireEqual(decoder?.rejectLatinOutput, true, "Config must reject Latin outputs.");
  requireEqual(decoder?.autoCommitEligible, false, "Neural candidates must never be auto-commit eligible.");

  const context = config.context;
  const rescorer = context?.languageModelRescorer;
  requireEqual(rescorer?.enabled, false, "Implementation contract v1 requires context rescoring to remain disabled.");
  requireEqual(rescorer?.status, "not-implemented", "Implementation contract v1 must state that context rescoring is not implemented.");
  requireEqual(context?.previousWords, 0, "Implementation contract v1 must consume zero previous context words.");
  requireEqual(rescorer?.weight, 0, "A disabled context rescorer must have zero weight.");
  if (rescorer?.enabled === false && rescorer?.status === "not-implemented" &&
      context?.previousWords === 0 && rescorer?.weight === 0) {
    warnings.push("Context language-model rescoring is disabled and not implemented.");
  }

  const evaluation = config.evaluation;
  requireEqual(evaluation?.goldManifest, "data/neural/gold/manifest.v3.json", "Config must bind the locked gold manifest.");
  requireEqual(
    evaluation?.officialBenchmarkManifest,
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
    "Config must bind the locked official benchmark manifest."
  );
  requireEqual(
    evaluation?.officialBenchmarkTrainingUse,
    "forbidden-evaluation-only",
    "Config must forbid official benchmark training use."
  );

  const training = config.training;
  requireEqual(training?.datasetManifest, "data/generated/neural-open-vocab/manifest.json", "Config must use the canonical immutable dataset manifest path.");
  requireEqual(training?.normalization, "NFC", "Config normalization must be NFC.");
  requireEqual(
    training?.splitPolicy,
    "connected-normalized-input-and-target-with-heldout-precedence",
    "Config split policy must keep connected normalized inputs and targets together with held-out precedence."
  );
  requireEqual(training?.samplingPolicy?.type, "deterministic-source-stratified-sampling", "Config sampling policy must match the executable source-stratified sampler.");
  requireEqual(training?.samplingPolicy?.version, 1, "Config sampling policy version must be 1.");
  requireEqual(training?.samplingPolicy?.sourceQuotaWeight, "square-root-of-source-row-count", "Config sampling source quota weight must match the implementation.");
  if (!isRecord(training?.samplingPolicy?.sourceMultipliers) || Object.keys(training.samplingPolicy.sourceMultipliers).length !== 0) {
    failures.push("Config sampling sourceMultipliers must be empty; dataset row weight is the sole loss multiplier.");
  }
  for (const source of [
    "manual-ambiguity",
    "manual-chat-tail",
    "manual-name",
    "manual-x-ksha",
    "runtime-names"
  ]) {
    if (!training?.samplingPolicy?.pinnedSources?.includes(source)) {
      failures.push(`Config sampling policy must pin ${source}.`);
    }
  }
  requireEqual(training?.loss, "weighted-label-smoothed-sequence-cross-entropy", "Config loss must describe weighted label-smoothed token loss.");
  requireEqual(training?.optimizer, "adamw", "Config optimizer must be AdamW.");
  for (const requiredSource of [CANONICAL_PUBLIC_SOURCE]) {
    if (!training?.requiredSources?.includes(requiredSource)) {
      failures.push(`Config missing required training source ${requiredSource}.`);
    }
  }
  for (const mirrorSource of BLOCKED_MIRROR_SOURCES) {
    if (training?.requiredSources?.includes(mirrorSource)) {
      failures.push(`Config must not count blocked lineage mirror ${mirrorSource} as a required training source.`);
    }
  }
  for (const suite of [
    "protected-token-gold",
    "non-nepali-pass-through-gold",
    "adversarial-neural-tail-gold"
  ]) {
    if (!training?.admissionSafetyEvaluationSuites?.includes(suite)) {
      failures.push(`Config missing admission safety suite ${suite}.`);
    }
  }

  const run = config.trainingRun;
  requireIntegerInRange(run?.seed, 0, Number.MAX_SAFE_INTEGER, "Config trainingRun.seed");
  requireIntegerInRange(run?.maximumTrainRows, 1, 10_000_000, "Config trainingRun.maximumTrainRows");
  requireIntegerInRange(run?.maximumDevRows, 1, 1_000_000, "Config trainingRun.maximumDevRows");
  requireIntegerInRange(run?.maximumEpochs, 1, 100, "Config trainingRun.maximumEpochs");
  requireIntegerInRange(run?.batchSize, 1, 4096, "Config trainingRun.batchSize");
  requireNumberInRange(run?.learningRate, Number.MIN_VALUE, 0.1, "Config trainingRun.learningRate");
  requireNumberInRange(run?.labelSmoothing, Number.MIN_VALUE, 0.2, "Config trainingRun.labelSmoothing");
  requireNumberInRange(run?.gradientClipNorm, Number.MIN_VALUE, 100, "Config trainingRun.gradientClipNorm");
  requireEqual(run?.earlyStopping?.enabled, true, "Config must enable dev-loss early stopping.");
  requireEqual(run?.earlyStopping?.metric, "dev-weighted-token-cross-entropy", "Config early-stopping metric must be weighted dev token loss.");
  requireIntegerInRange(run?.earlyStopping?.patienceEpochs, 1, 20, "Config early-stopping patienceEpochs");
  requireNumberInRange(run?.earlyStopping?.minimumDelta, 0, 1, "Config early-stopping minimumDelta");
  requireEqual(run?.earlyStopping?.restoreBestWeights, true, "Config early stopping must restore the best weights.");

  return result();

  function requireEqual(actual, expected, message) {
    if (actual !== expected) failures.push(`${message} Got ${JSON.stringify(actual)}.`);
  }

  function requireIntegerInRange(actual, minimum, maximum, label) {
    if (!Number.isInteger(actual) || actual < minimum || actual > maximum) {
      failures.push(`${label} must be an integer in ${minimum}..${maximum}. Got ${JSON.stringify(actual)}.`);
    }
  }

  function requireNumberInRange(actual, minimum, maximum, label) {
    if (typeof actual !== "number" || !Number.isFinite(actual) || actual < minimum || actual > maximum) {
      failures.push(`${label} must be a finite number in ${minimum}..${maximum}. Got ${JSON.stringify(actual)}.`);
    }
  }

  function result() {
    return Object.freeze({ failures: Object.freeze(failures), warnings: Object.freeze(warnings) });
  }
}

function validateCTCNeuralTrainingConfig(config, profile) {
  const failures = [];
  const warnings = [];

  requireEqual(config.schemaVersion, 2, "CTC config schemaVersion must be 2.");
  requireEqual(
    config.implementationContractVersion,
    2,
    "CTC config implementationContractVersion must be 2."
  );
  requireEqual(
    config.modelId,
    "lekh-open-vocab-ctc-transformer-v2",
    "CTC config modelId must name the executable Transformer-CTC candidate."
  );

  requireEqual(
    config.artifact?.compiledModel,
    profile.artifact.compiledModel,
    "CTC config must declare the canonical compiled-model path."
  );
  requireEqual(
    config.artifact?.manifest,
    profile.artifact.manifest,
    "CTC config must declare the canonical model-manifest path."
  );
  requireEqual(
    config.artifact?.vocabMetadata,
    profile.artifact.vocabMetadata,
    "CTC config must declare the canonical vocabulary path."
  );
  requireEqual(config.artifact?.runtime, "CoreML", "CTC config runtime must be CoreML.");
  requireEqual(config.artifact?.localOnly, true, "CTC config must be local-only.");
  requireEqual(
    config.artifact?.neuralTailOnly,
    true,
    "CTC config must remain neural-tail-only."
  );

  requireEqual(
    config.export?.sourceCheckpoint,
    profile.export.sourceCheckpoint,
    "CTC config must declare the canonical source checkpoint path."
  );
  requireEqual(
    config.export?.intermediateMLPackage,
    profile.export.intermediateMLPackage,
    "CTC config must declare the canonical intermediate package path."
  );
  requireEqual(
    config.export?.compiledModel,
    profile.artifact.compiledModel,
    "CTC export.compiledModel must match the canonical compiled-model path."
  );
  requireEqual(
    config.export?.manifest,
    profile.artifact.manifest,
    "CTC export.manifest must match the canonical model-manifest path."
  );
  requireEqual(
    config.export?.vocabMetadata,
    profile.artifact.vocabMetadata,
    "CTC export.vocabMetadata must match the canonical vocabulary path."
  );

  const architecture = config.architecture;
  requireEqual(
    architecture?.family,
    profile.family,
    "CTC architecture family must match the executable candidate."
  );
  requireEqual(
    architecture?.runtimeModelContract,
    profile.runtimeModelContract,
    "CTC runtimeModelContract must match the native single-model runtime."
  );
  requireEqual(
    architecture?.openVocabulary,
    true,
    "CTC config must describe an open-vocabulary model."
  );
  requireEqual(
    architecture?.tokenization,
    "unicode-scalar-character",
    "CTC config must use the implemented Unicode-scalar tokenizer."
  );
  for (const [field, expected] of Object.entries({
    modelDimension: profile.modelDimension,
    attentionHeads: profile.attentionHeads,
    feedForwardDimension: profile.feedForwardDimension,
    encoderLayers: profile.encoderLayers,
    dropout: profile.dropout
  })) {
    requireEqual(
      architecture?.[field],
      expected,
      `CTC architecture ${field} must match the implementation contract.`
    );
  }
  if (
    Number.isInteger(architecture?.modelDimension) &&
    Number.isInteger(architecture?.attentionHeads) &&
    architecture.attentionHeads > 0 &&
    architecture.modelDimension % architecture.attentionHeads !== 0
  ) {
    failures.push("CTC modelDimension must divide evenly by attentionHeads.");
  }
  requireEqual(
    architecture?.minimumParameterCount,
    1_000_000,
    "CTC minimumParameterCount must be the frozen 1,000,000 lower bound."
  );
  requireEqual(
    architecture?.maximumParameterCount,
    5_000_000,
    "CTC maximumParameterCount must be the frozen 5,000,000 upper bound."
  );
  requireEqual(
    architecture?.maximumCompiledBytes,
    16_777_216,
    "CTC maximumCompiledBytes must be 16,777,216."
  );

  const decoder = config.decoder;
  for (const [field, expected] of Object.entries(profile.decoder)) {
    requireEqual(
      decoder?.[field],
      expected,
      `CTC decoder ${field} must match the implementation contract.`
    );
  }
  requireIntegerInRange(decoder?.beamWidth, 2, 16, "CTC decoder beamWidth");
  requireIntegerInRange(
    decoder?.maxInputGraphemes,
    1,
    64,
    "CTC decoder maxInputGraphemes"
  );
  requireIntegerInRange(
    decoder?.outputTimeSteps,
    8,
    48,
    "CTC decoder outputTimeSteps"
  );
  requireIntegerInRange(
    decoder?.maximumCandidates,
    1,
    decoder?.beamWidth,
    "CTC decoder maximumCandidates"
  );
  requireEqual(
    decoder?.outputSequenceValidation,
    "devanagari-word-sequence-v1",
    "CTC decoder must use the native Devanagari output grammar."
  );
  requireEqual(
    decoder?.rejectWhitespaceOutput,
    true,
    "CTC decoder must reject whitespace outputs."
  );
  requireEqual(
    decoder?.rejectLatinOutput,
    true,
    "CTC decoder must reject Latin outputs."
  );
  requireEqual(
    decoder?.autoCommitEligible,
    false,
    "CTC candidates must never be auto-commit eligible."
  );

  const context = config.context;
  const rescorer = context?.languageModelRescorer;
  requireEqual(
    context?.previousWords,
    0,
    "CTC implementation contract v2 must consume zero previous context words."
  );
  requireEqual(
    rescorer?.enabled,
    false,
    "CTC implementation contract v2 requires context rescoring to remain disabled."
  );
  requireEqual(
    rescorer?.status,
    "not-implemented",
    "CTC context rescorer must truthfully state that it is not implemented."
  );
  requireEqual(
    rescorer?.source,
    "none",
    "CTC disabled context rescorer must declare source none."
  );
  requireEqual(rescorer?.weight, 0, "CTC disabled context rescorer must have zero weight.");
  if (
    context?.previousWords === 0 &&
    rescorer?.enabled === false &&
    rescorer?.status === "not-implemented" &&
    rescorer?.source === "none" &&
    rescorer?.weight === 0
  ) {
    warnings.push("Context language-model rescoring is disabled and not implemented.");
  }

  requireDeepEqual(
    config.evaluation,
    {
      goldManifest: "data/neural/gold/manifest.v3.json",
      officialBenchmarkManifest:
        "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
      officialBenchmarkTrainingUse: "forbidden-evaluation-only"
    },
    "CTC evaluation inputs must equal the locked corpora contract."
  );

  const training = config.training;
  requireEqual(
    training?.datasetManifest,
    "data/generated/neural-open-vocab/manifest.json",
    "CTC config must use the canonical immutable dataset manifest."
  );
  requireEqual(training?.normalization, "NFC", "CTC normalization must be NFC.");
  requireEqual(
    training?.splitPolicy,
    "connected-normalized-input-and-target-with-heldout-precedence",
    "CTC split policy must keep connected normalized inputs and targets together with held-out precedence."
  );
  requireEqual(
    training?.samplingPolicy?.type,
    "deterministic-source-stratified-sampling",
    "CTC sampling policy must use the executable deterministic sampler."
  );
  requireEqual(
    training?.samplingPolicy?.version,
    2,
    "CTC sampling policy version must be 2."
  );
  requireEqual(
    training?.samplingPolicy?.sourceQuotaWeight,
    "square-root-of-source-row-count",
    "CTC source quota weighting must match the executable sampler."
  );
  requireDeepEqual(
    training?.samplingPolicy?.sourceMultipliers,
    CTC_SOURCE_MULTIPLIERS,
    "CTC sourceMultipliers must match the frozen production weighting contract."
  );
  requireDeepEqual(
    training?.samplingPolicy?.pinnedSources,
    [
      "manual-ambiguity",
      "manual-chat-tail",
      "manual-name",
      "manual-x-ksha",
      "runtime-names"
    ],
    "CTC pinnedSources must match the frozen tail-preservation contract."
  );
  requireDeepEqual(
    training?.augmentation,
    CTC_AUGMENTATION,
    "CTC augmentation must match the collision-safe production alias contract."
  );
  requireEqual(training?.loss, "weighted-ctc", "CTC config loss must be weighted-ctc.");
  requireEqual(
    training?.lossComputationDevice,
    "cpu-for-deterministic-backward",
    "CTC config must use deterministic CPU CTC-loss computation."
  );
  requireDeepEqual(
    training?.optimizer,
    CTC_OPTIMIZER,
    "CTC optimizer must match the production AdamW contract."
  );
  requireDeepEqual(
    training?.scheduler,
    CTC_SCHEDULER,
    "CTC scheduler must match the production warmup/inverse-square-root contract."
  );
  if (!training?.requiredSources?.includes(CANONICAL_PUBLIC_SOURCE)) {
    failures.push(`CTC config missing required training source ${CANONICAL_PUBLIC_SOURCE}.`);
  }
  for (const mirrorSource of BLOCKED_MIRROR_SOURCES) {
    if (training?.requiredSources?.includes(mirrorSource)) {
      failures.push(
        `CTC config must not count blocked lineage mirror ${mirrorSource} as a required training source.`
      );
    }
  }
  for (const suite of [
    "protected-token-gold",
    "non-nepali-pass-through-gold",
    "adversarial-neural-tail-gold"
  ]) {
    if (!training?.admissionSafetyEvaluationSuites?.includes(suite)) {
      failures.push(`CTC config missing admission safety suite ${suite}.`);
    }
  }

  const run = config.trainingRun;
  requireIntegerInRange(run?.seed, 0, Number.MAX_SAFE_INTEGER, "CTC trainingRun.seed");
  requireIntegerInRange(
    run?.maximumTrainRows,
    1,
    10_000_000,
    "CTC trainingRun.maximumTrainRows"
  );
  requireIntegerInRange(
    run?.maximumDevRows,
    1,
    1_000_000,
    "CTC trainingRun.maximumDevRows"
  );
  requireIntegerInRange(run?.maximumEpochs, 1, 100, "CTC trainingRun.maximumEpochs");
  requireIntegerInRange(run?.batchSize, 1, 4096, "CTC trainingRun.batchSize");
  requireNumberInRange(
    run?.peakLearningRate,
    Number.MIN_VALUE,
    0.1,
    "CTC trainingRun.peakLearningRate"
  );
  requireNumberInRange(
    run?.gradientClipNorm,
    Number.MIN_VALUE,
    100,
    "CTC trainingRun.gradientClipNorm"
  );
  requireEqual(
    run?.earlyStopping?.enabled,
    true,
    "CTC training must enable early stopping."
  );
  requireEqual(
    run?.earlyStopping?.metric,
    "dev-weighted-ctc-loss",
    "CTC early-stopping metric must be weighted dev CTC loss."
  );
  requireEqual(
    run?.earlyStopping?.patienceEpochs,
    4,
    "CTC early-stopping patience must match the production contract."
  );
  requireEqual(
    run?.earlyStopping?.minimumDelta,
    0.0001,
    "CTC early-stopping minimumDelta must match the production contract."
  );
  requireEqual(
    run?.earlyStopping?.restoreBestWeights,
    true,
    "CTC early stopping must restore the best weights."
  );
  if (
    Number.isInteger(run?.maximumEpochs) &&
    Number.isInteger(run?.earlyStopping?.patienceEpochs) &&
    run.maximumEpochs <= run.earlyStopping.patienceEpochs
  ) {
    failures.push(
      "CTC maximumEpochs must exceed early-stopping patience so the policy can execute."
    );
  }

  return Object.freeze({
    failures: Object.freeze(failures),
    warnings: Object.freeze(warnings)
  });

  function requireEqual(actual, expected, message) {
    if (actual !== expected) failures.push(`${message} Got ${JSON.stringify(actual)}.`);
  }

  function requireDeepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      failures.push(`${message} Got ${JSON.stringify(actual)}.`);
    }
  }

  function requireIntegerInRange(actual, minimum, maximum, label) {
    if (
      !Number.isInteger(actual) ||
      actual < minimum ||
      !Number.isInteger(maximum) ||
      actual > maximum
    ) {
      failures.push(
        `${label} must be an integer in ${minimum}..${maximum}. Got ${JSON.stringify(actual)}.`
      );
    }
  }

  function requireNumberInRange(actual, minimum, maximum, label) {
    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      actual < minimum ||
      actual > maximum
    ) {
      failures.push(
        `${label} must be a finite number in ${minimum}..${maximum}. Got ${JSON.stringify(actual)}.`
      );
    }
  }
}

export function inspectTrainingReportBinding({ report, trainingContractSha256, configuredContract }) {
  const issues = [];
  if (!isRecord(report)) {
    issues.push("Training report is absent; no run is bound to the current training contract.");
    return result(false, []);
  }

  if (report.trainingContractSha256 !== trainingContractSha256) {
    issues.push(report.trainingContractSha256
      ? "Training report is stale: trainingContractSha256 does not match the current config file."
      : "Training report does not bind trainingContractSha256.");
  }
  if (!isRecord(report.configuredTrainingConfig)) {
    issues.push("Training report does not record configuredTrainingConfig.");
  } else if (!deepEqual(report.configuredTrainingConfig, configuredContract)) {
    issues.push("Training report configuredTrainingConfig does not match the current config contract.");
  }
  if (!isRecord(report.effectiveTrainingConfig)) {
    issues.push("Training report does not record effectiveTrainingConfig.");
  } else if (typeof report.effectiveTrainingConfigCanonicalJson !== "string") {
    issues.push("Training report does not bind effectiveTrainingConfigCanonicalJson.");
  } else {
    let canonicalValue;
    try {
      canonicalValue = JSON.parse(report.effectiveTrainingConfigCanonicalJson);
    } catch {
      issues.push("Training report effectiveTrainingConfigCanonicalJson is invalid JSON.");
    }
    if (canonicalValue !== undefined && !deepEqual(canonicalValue, report.effectiveTrainingConfig)) {
      issues.push("Training report canonical effective config does not match effectiveTrainingConfig.");
    }
    if (report.effectiveTrainingConfigSha256 !== sha256Text(report.effectiveTrainingConfigCanonicalJson)) {
      issues.push(report.effectiveTrainingConfigSha256
        ? "Training report effectiveTrainingConfigSha256 is invalid."
        : "Training report does not bind effectiveTrainingConfigSha256.");
    }
  }

  const effectiveDifferences = isRecord(report.effectiveTrainingConfig)
    ? differingLeafPaths(configuredContract, report.effectiveTrainingConfig)
    : [];
  const overrides = isRecord(report.trainingOverrides) ? report.trainingOverrides : null;
  if (!overrides) {
    issues.push("Training report does not record trainingOverrides provenance.");
  }
  if (effectiveDifferences.length > 0 && !overrides) {
    issues.push("Training report has effective config differences without trainingOverrides provenance.");
  }
  if (overrides && Object.keys(overrides).length > 0) {
    issues.push(`Training report used explicit config overrides: ${Object.keys(overrides).sort().join(", ")}.`);
  }
  if (overrides) {
    const unrecorded = effectiveDifferences.filter((path) => !Object.hasOwn(overrides, path));
    if (unrecorded.length > 0) {
      issues.push(`Training report omits override provenance for: ${unrecorded.join(", ")}.`);
    }
    const unrelated = Object.keys(overrides).filter((path) => !effectiveDifferences.includes(path));
    if (unrelated.length > 0) {
      issues.push(`Training report claims overrides that did not change effective config: ${unrelated.sort().join(", ")}.`);
    }
    for (const [path, override] of Object.entries(overrides)) {
      if (!isRecord(override) || !("configured" in override) || !("effective" in override) ||
          typeof override.source !== "string" || override.source.length === 0) {
        issues.push(`Training override ${path} lacks configured, effective, or source provenance.`);
        continue;
      }
      if (!deepEqual(override.configured, valueAtPath(configuredContract, path)) ||
          !deepEqual(override.effective, valueAtPath(report.effectiveTrainingConfig, path))) {
        issues.push(`Training override ${path} does not match the configured and effective snapshots.`);
      }
    }
  }

  return result(issues.length === 0, effectiveDifferences);

  function result(bound, effectiveDifferences) {
    return Object.freeze({
      bound,
      issues: Object.freeze(issues),
      effectiveDifferences: Object.freeze(effectiveDifferences)
    });
  }
}

export function canonicalJsonSha256(value) {
  return sha256Text(canonicalJsonText(value));
}

export function canonicalJsonText(value) {
  return JSON.stringify(sortJson(value));
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => isRecord(current) ? current[key] : undefined, value);
}

function differingLeafPaths(expected, actual, prefix = "") {
  if (deepEqual(expected, actual)) return [];
  if (!isRecord(expected) || !isRecord(actual)) return [prefix];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.flatMap((key) => differingLeafPaths(
    expected[key],
    actual[key],
    prefix ? `${prefix}.${key}` : key
  ));
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function containedPath(root, value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new NeuralTrainingLayoutError(`${label} path must be a non-empty string.`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) ||
      isAbsolute(child)) {
    throw new NeuralTrainingLayoutError(`${label} path escapes the repository.`);
  }
  return path;
}

function containedRecordedPath(root, value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) ||
      value.includes("\\") || value.split("/").includes("..") ||
      value.split("/").includes(".")) {
    throw new NeuralTrainingLayoutError(
      `${label} must be a canonical repository-relative POSIX path.`
    );
  }
  const path = containedPath(root, value, label);
  if (portable(root, path) !== value) {
    throw new NeuralTrainingLayoutError(
      `${label} must be a canonical repository-relative POSIX path.`
    );
  }
  return path;
}

function portable(root, path) {
  return relative(root, resolve(path)).split(sep).join("/");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
