const BASELINE_RUNTIME_CONTRACT = "single-seq2seq-v1";
const CTC_RUNTIME_CONTRACT = "single-transformer-ctc-v1";
const SPLIT_RUNTIME_CONTRACT = "split-attention-incremental-v1";

/**
 * Resolve the exact tensor contract used by the small packaged-model
 * microbenchmark. The production benchmark remains the native service probe;
 * this helper exists to ensure the lower-level Core ML timing tool can never
 * silently execute a legacy tensor shape against a different selected model.
 */
export function resolveNeuralPackagedBenchmarkContract(options = {}) {
  const descriptor = requireRecord(
    options.descriptor,
    "Packaged neural artifact descriptor"
  );
  const vocabulary = requireRecord(
    options.vocabulary,
    "Packaged neural vocabulary"
  );
  const runtimeModelContract = requireString(
    descriptor.runtimeModelContract,
    "Packaged neural runtime model contract"
  );
  const modelId = requireString(
    descriptor.modelId,
    "Packaged neural model ID"
  );
  if (vocabulary.modelId !== modelId) {
    fail("Packaged neural vocabulary modelId differs from the artifact descriptor.");
  }

  if (runtimeModelContract === SPLIT_RUNTIME_CONTRACT) {
    fail(
      "The single-forward packaged Core ML microbenchmark does not support " +
      "split-attention artifacts; use benchmark-neural-native-service.mjs."
    );
  }
  if (
    runtimeModelContract !== BASELINE_RUNTIME_CONTRACT &&
    runtimeModelContract !== CTC_RUNTIME_CONTRACT
  ) {
    fail(`Unsupported packaged neural runtime contract ${runtimeModelContract}.`);
  }
  if (
    descriptor.artifactLayout !== "single-model" ||
    !Array.isArray(descriptor.artifacts) ||
    descriptor.artifacts.length !== 1 ||
    descriptor.artifacts[0]?.role !== "model"
  ) {
    fail("Packaged neural microbenchmark requires exactly one verified model artifact.");
  }
  const artifactSetSha256 = requireSha256(
    descriptor.artifactSetSha256,
    "Packaged neural artifact-set SHA-256"
  );
  const artifact = requireRecord(
    descriptor.artifacts[0],
    "Packaged neural model artifact"
  );
  requireString(
    artifact.sourcePath,
    "Packaged neural model source path"
  );

  const input = requireRecord(
    vocabulary.input,
    "Packaged neural input vocabulary"
  );
  const output = requireRecord(
    vocabulary.output,
    "Packaged neural output vocabulary"
  );
  const inputLength = requirePositiveInteger(
    input.maxLength,
    "Packaged neural input maxLength"
  );
  const inputVocabularySize = requireTokenTable(
    input.tokensById,
    "Packaged neural input tokensById"
  );
  const probeInputId = requireTokenId(
    input.unkId,
    inputVocabularySize,
    "Packaged neural input unkId"
  );
  const outputVocabularySize = requireTokenTable(
    output.tokensById,
    "Packaged neural output tokensById"
  );

  if (runtimeModelContract === CTC_RUNTIME_CONTRACT) {
    return resolveCTCContract({
      descriptor,
      vocabulary,
      inputLength,
      outputVocabularySize,
      probeInputId,
      artifactSetSha256,
      artifact
    });
  }
  return resolveBaselineContract({
    descriptor,
    vocabulary,
    inputLength,
    outputVocabularySize,
    probeInputId,
    artifactSetSha256,
    artifact
  });
}

function resolveCTCContract({
  descriptor,
  vocabulary,
  inputLength,
  outputVocabularySize,
  probeInputId,
  artifactSetSha256,
  artifact
}) {
  if (
    vocabulary.schemaVersion !== 2 ||
    vocabulary.runtimeModelContract !== CTC_RUNTIME_CONTRACT
  ) {
    fail("CTC packaged benchmark requires the closed schema-v2 CTC vocabulary.");
  }
  const tensorContract = requireRecord(
    descriptor.tensorContract,
    "CTC tensor contract"
  );
  requireExactKeys(tensorContract, ["inputIds", "logits"], "CTC tensor contract");
  const inputTensor = requireTensor(
    tensorContract.inputIds,
    "CTC inputIds tensor",
    "INT32"
  );
  const logitsTensor = requireTensor(
    tensorContract.logits,
    "CTC logits tensor",
    "FLOAT16"
  );
  const outputTimeSteps = requirePositiveInteger(
    vocabulary.output.timeSteps,
    "CTC output timeSteps"
  );
  requireShape(inputTensor.shape, [1, inputLength], "CTC inputIds tensor");
  requireShape(
    logitsTensor.shape,
    [1, outputTimeSteps, outputVocabularySize],
    "CTC logits tensor"
  );
  return freezeContract({
    modelId: descriptor.modelId,
    runtimeModelContract: CTC_RUNTIME_CONTRACT,
    artifactSetSha256,
    artifact,
    inputLength,
    outputSteps: outputTimeSteps,
    outputVocabularySize,
    probeInputId,
    probeDecoderInputId: null,
    inputFeatureNames: ["inputIds"],
    outputFeatureNames: ["logits"],
    measurementKind: "packaged-coreml-ctc-single-forward"
  });
}

function resolveBaselineContract({
  descriptor,
  vocabulary,
  inputLength,
  outputVocabularySize,
  probeInputId,
  artifactSetSha256,
  artifact
}) {
  if (
    vocabulary.schemaVersion !== 1 ||
    descriptor.tensorContract !== null
  ) {
    fail("Baseline packaged benchmark requires the closed schema-v1 vocabulary.");
  }
  const outputLength = requirePositiveInteger(
    vocabulary.output.maxLength,
    "Baseline output maxLength"
  );
  if (outputLength < 2) {
    fail("Baseline output maxLength must leave at least one decoder step.");
  }
  const probeDecoderInputId = requireTokenId(
    vocabulary.output.sosId,
    outputVocabularySize,
    "Baseline output sosId"
  );
  return freezeContract({
    modelId: descriptor.modelId,
    runtimeModelContract: BASELINE_RUNTIME_CONTRACT,
    artifactSetSha256,
    artifact,
    inputLength,
    outputSteps: outputLength - 1,
    outputVocabularySize,
    probeInputId,
    probeDecoderInputId,
    inputFeatureNames: ["decoderInputIds", "inputIds"],
    outputFeatureNames: ["logits"],
    measurementKind: "packaged-coreml-seq2seq-single-forward"
  });
}

function requireTensor(value, label, expectedDataType) {
  const tensor = requireRecord(value, label);
  requireExactKeys(tensor, ["dataType", "shape"], label);
  if (tensor.dataType !== expectedDataType) {
    fail(`${label} dataType must be ${expectedDataType}.`);
  }
  if (
    !Array.isArray(tensor.shape) ||
    tensor.shape.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 1)
  ) {
    fail(`${label} shape must contain only positive safe integers.`);
  }
  return tensor;
}

function requireShape(observed, expected, label) {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail(
      `${label} shape must be ${JSON.stringify(expected)}; ` +
      `found ${JSON.stringify(observed)}.`
    );
  }
}

function requireTokenTable(value, label) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some((token) => typeof token !== "string" || token.length === 0)
  ) {
    fail(`${label} must be a non-empty string array.`);
  }
  return value.length;
}

function requireTokenId(value, vocabularySize, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= vocabularySize
  ) {
    fail(`${label} is outside the vocabulary.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    fail(`${label} must contain exactly ${wanted.join(", ")}.`);
  }
}

function freezeContract(value) {
  return Object.freeze({
    ...value,
    inputFeatureNames: Object.freeze([...value.inputFeatureNames]),
    outputFeatureNames: Object.freeze([...value.outputFeatureNames])
  });
}

function fail(message) {
  throw new Error(message);
}
