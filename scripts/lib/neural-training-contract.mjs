import { createHash } from "node:crypto";

const MODEL_ID = "lekh-open-vocab-seq2seq-v1";

export function configuredNeuralTrainingContract(config) {
  return {
    architecture: {
      family: config?.architecture?.family,
      encoderLayers: config?.architecture?.encoderLayers,
      decoderLayers: config?.architecture?.decoderLayers,
      embeddingDim: config?.architecture?.embeddingDim,
      hiddenDim: config?.architecture?.hiddenDim,
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

  requireEqual(config.schemaVersion, 2, "Config schemaVersion must be 2.");
  requireEqual(config.implementationContractVersion, 1, "Config implementationContractVersion must be 1.");
  requireEqual(config.modelId, MODEL_ID, "Config modelId must match the open-vocabulary artifact id.");
  requireEqual(config.artifact?.compiledModel, "models/macos/LekhNeuralTransliterator.mlmodelc", "Config must declare the canonical compiled-model path.");
  requireEqual(config.artifact?.manifest, "models/macos/LekhNeuralTransliterator.manifest.json", "Config must declare the canonical model-manifest path.");
  requireEqual(config.artifact?.runtime, "CoreML", "Config runtime must be CoreML.");
  requireEqual(config.artifact?.localOnly, true, "Config must be local-only.");
  requireEqual(config.artifact?.neuralTailOnly, true, "Config must be neural-tail-only.");
  requireEqual(config.export?.sourceCheckpoint, "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/checkpoint.pt", "Config must declare the canonical source checkpoint path.");
  requireEqual(config.export?.intermediateMLPackage, "data/generated/neural-open-vocab-model/lekh-open-vocab-seq2seq-v1/LekhNeuralTransliterator.mlpackage", "Config must declare the canonical intermediate package path.");
  requireEqual(config.export?.compiledModel, config.artifact?.compiledModel, "Config export.compiledModel must match artifact.compiledModel.");
  requireEqual(config.export?.manifest, config.artifact?.manifest, "Config export.manifest must match artifact.manifest.");

  const architecture = config.architecture;
  requireEqual(architecture?.family, "gru-encoder-decoder-seq2seq", "Config must name the implemented GRU encoder-decoder architecture.");
  requireEqual(architecture?.openVocabulary, true, "Config must describe an open-vocabulary model.");
  requireEqual(architecture?.tokenization, "unicode-grapheme-character", "Config must describe the implemented grapheme tokenizer.");
  requireEqual(architecture?.encoderLayers, 2, "Config encoderLayers must match the implementation contract.");
  requireEqual(architecture?.decoderLayers, 2, "Config decoderLayers must match the implementation contract.");
  requireEqual(architecture?.embeddingDim, 96, "Config embeddingDim must match the implementation contract.");
  requireEqual(architecture?.hiddenDim, 256, "Config hiddenDim must match the implementation contract.");
  requireEqual(architecture?.attention, "none", "Config must not claim an attention mechanism that is not implemented.");
  requireEqual(architecture?.dropout, 0.12, "Config dropout must match the implementation contract.");
  requireEqual(architecture?.minimumParameterCount, 1_000_000, "Config minimumParameterCount must be the frozen 1,000,000 lower bound.");
  requireEqual(architecture?.maximumParameterCount, 5_000_000, "Config maximumParameterCount must be the frozen 5,000,000 upper bound.");
  requireEqual(architecture?.maximumCompiledBytes, 16_777_216, "Config maximumCompiledBytes must be 16,777,216.");

  const decoder = config.decoder;
  requireEqual(decoder?.type, "beam-search", "Config decoder type must be beam-search.");
  requireIntegerInRange(decoder?.beamWidth, 2, 8, "Config beamWidth");
  requireIntegerInRange(decoder?.maxInputGraphemes, 2, 64, "Config maxInputGraphemes");
  requireIntegerInRange(decoder?.maxOutputGraphemes, 2, 64, "Config maxOutputGraphemes");
  requireIntegerInRange(decoder?.maximumCandidates, 1, 8, "Config maximumCandidates");
  if (decoder?.beamWidth !== 2) failures.push("Config beamWidth must equal the latency-evidenced native v1 width of 2.");
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

  const training = config.training;
  requireEqual(training?.datasetManifest, "data/generated/neural-open-vocab/manifest.json", "Config must use the canonical immutable dataset manifest path.");
  requireEqual(training?.normalization, "NFC", "Config normalization must be NFC.");
  requireEqual(training?.splitPolicy, "stable-hash-by-normalized-input", "Config split policy must prevent normalized-input leakage.");
  requireEqual(training?.samplingPolicy?.type, "deterministic-source-stratified-sampling", "Config sampling policy must match the executable source-stratified sampler.");
  requireEqual(training?.samplingPolicy?.version, 1, "Config sampling policy version must be 1.");
  requireEqual(training?.samplingPolicy?.sourceQuotaWeight, "square-root-of-source-row-count", "Config sampling source quota weight must match the implementation.");
  if (!isRecord(training?.samplingPolicy?.sourceMultipliers) || Object.keys(training.samplingPolicy.sourceMultipliers).length !== 0) {
    failures.push("Config sampling sourceMultipliers must be empty; dataset row weight is the sole loss multiplier.");
  }
  for (const source of [
    "lekh-phase1-contract-seed-v1",
    "human-reviewed-lekh-gold-v1",
    "lekh-chat-conventions-v1",
    "lekh-name-lexicon-v1"
  ]) {
    if (!training?.samplingPolicy?.pinnedSources?.includes(source)) {
      failures.push(`Config sampling policy must pin ${source}.`);
    }
  }
  requireEqual(training?.loss, "weighted-label-smoothed-sequence-cross-entropy", "Config loss must describe weighted label-smoothed token loss.");
  requireEqual(training?.optimizer, "adamw", "Config optimizer must be AdamW.");
  for (const requiredSource of [
    "syubraj-roman2nepali-transliteration",
    "human-reviewed-lekh-gold-v1",
    "lekh-chat-conventions-v1",
    "lekh-name-lexicon-v1"
  ]) {
    if (!training?.requiredSources?.includes(requiredSource)) {
      failures.push(`Config missing required training source ${requiredSource}.`);
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
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
