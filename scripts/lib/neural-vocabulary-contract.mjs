const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GENERATED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const TOP_LEVEL_KEYS = Object.freeze([
  "dataset",
  "decoder",
  "generatedAt",
  "input",
  "modelId",
  "nativeRuntimePolicy",
  "output",
  "schemaVersion",
  "tokenization"
]);
const VOCABULARY_KEYS = Object.freeze([
  "eosId",
  "idsByToken",
  "maxLength",
  "padId",
  "sosId",
  "tokensById",
  "unkId"
]);
const DECODER_KEYS = Object.freeze([
  "beamWidth",
  "maxSteps",
  "outputSequenceValidation",
  "rejectLatinCandidates",
  "rejectWhitespaceCandidates",
  "type"
]);
const DATASET_KEYS = Object.freeze([
  "manifest",
  "manifestSha256",
  "splitSha256"
]);
const SPLIT_KEYS = Object.freeze(["dev", "test", "train"]);
const RUNTIME_POLICY_KEYS = Object.freeze([
  "asyncOnly",
  "failOpenRawTypingOnError",
  "neuralTailOnly",
  "neverInvokeInSecureFields"
]);
const SPECIAL_TOKENS = Object.freeze([
  Object.freeze({ field: "padId", token: "<pad>" }),
  Object.freeze({ field: "sosId", token: "<s>" }),
  Object.freeze({ field: "eosId", token: "</s>" }),
  Object.freeze({ field: "unkId", token: "<unk>" })
]);
const SPECIAL_TOKEN_VALUES = new Set(
  SPECIAL_TOKENS.map(({ token }) => token)
);
const CTC_TOP_LEVEL_KEYS = Object.freeze([
  "dataset",
  "decoder",
  "generatedAt",
  "input",
  "modelId",
  "nativeRuntimePolicy",
  "output",
  "runtimeModelContract",
  "schemaVersion",
  "tokenization"
]);
const CTC_INPUT_KEYS = Object.freeze([
  "eosId",
  "idsByToken",
  "maxLength",
  "padId",
  "tokensById",
  "unkId"
]);
const CTC_OUTPUT_KEYS = Object.freeze([
  "blankId",
  "idsByToken",
  "timeSteps",
  "tokensById"
]);
const CTC_DECODER_KEYS = Object.freeze([
  "beamWidth",
  "maximumCandidates",
  "outputSequenceValidation",
  "rejectLatinCandidates",
  "rejectWhitespaceCandidates",
  "type"
]);
const CTC_INPUT_SPECIAL_TOKENS = Object.freeze([
  Object.freeze({ field: "padId", token: "<pad>" }),
  Object.freeze({ field: "eosId", token: "</s>" }),
  Object.freeze({ field: "unkId", token: "<unk>" })
]);
const CTC_INPUT_SPECIAL_VALUES = new Set(
  CTC_INPUT_SPECIAL_TOKENS.map(({ token }) => token)
);
const CTC_MODEL_ID = "lekh-open-vocab-ctc-transformer-v2";
const CTC_RUNTIME_MODEL_CONTRACT = "single-transformer-ctc-v1";
const CTC_BLANK_TOKEN = "<ctc-blank>";

export const NEURAL_VOCABULARY_SCHEMA_VERSION = 1;
export const NEURAL_CTC_VOCABULARY_SCHEMA_VERSION = 2;
export const NEURAL_TOKENIZATION = "unicode-scalar-character";
export const NEURAL_OUTPUT_SEQUENCE_VALIDATOR =
  "devanagari-word-sequence-v1";

/**
 * Validate the vocabulary as executable native-runtime state, not merely as
 * bytes named by a manifest. This deliberately mirrors the Swift loader's
 * semantic contract and additionally binds the vocabulary to the canonical
 * training config and independently inspected dataset evidence.
 */
export function validateNeuralVocabularyContract(options = {}) {
  const failures = [];
  const vocabulary = options.vocabulary;
  const config = options.config;
  const datasetManifest = options.datasetManifest;
  const datasetManifestSha256 = options.datasetManifestSha256;
  const manifest = options.manifest ?? null;

  if (!isRecord(vocabulary)) {
    failures.push("Neural vocabulary root must be an object.");
    return result(failures);
  }
  if (
    vocabulary.schemaVersion === NEURAL_CTC_VOCABULARY_SCHEMA_VERSION ||
    config?.modelId === CTC_MODEL_ID
  ) {
    return validateCTCVocabularyContract(options);
  }
  requireExactKeys(
    vocabulary,
    TOP_LEVEL_KEYS,
    "Neural vocabulary root",
    failures
  );
  requireEqual(
    vocabulary.schemaVersion,
    NEURAL_VOCABULARY_SCHEMA_VERSION,
    "Neural vocabulary schemaVersion must be 1.",
    failures
  );
  requireEqual(
    vocabulary.modelId,
    config?.modelId,
    "Neural vocabulary modelId differs from the training config.",
    failures
  );
  requireEqual(
    vocabulary.tokenization,
    NEURAL_TOKENIZATION,
    "Neural vocabulary tokenization must be unicode-scalar-character.",
    failures
  );
  requireEqual(
    vocabulary.tokenization,
    config?.architecture?.tokenization,
    "Neural vocabulary tokenization differs from the training config.",
    failures
  );
  validateGeneratedAt(vocabulary.generatedAt, failures);

  const input = validateVocabularySide({
    value: vocabulary.input,
    label: "Neural input vocabulary",
    expectedMaximumLength: config?.decoder?.maxInputGraphemes,
    outputSide: false,
    failures
  });
  const output = validateVocabularySide({
    value: vocabulary.output,
    label: "Neural output vocabulary",
    expectedMaximumLength: config?.decoder?.maxOutputGraphemes,
    outputSide: true,
    failures
  });

  validateDecoder({
    decoder: vocabulary.decoder,
    output,
    config,
    manifest,
    failures
  });
  validateDatasetBinding({
    dataset: vocabulary.dataset,
    config,
    datasetManifest,
    datasetManifestSha256,
    manifest,
    failures
  });
  validateNativeRuntimePolicy(vocabulary.nativeRuntimePolicy, failures);

  if (isRecord(manifest)) {
    requireEqual(
      vocabulary.modelId,
      manifest.selectedArtifact,
      "Neural vocabulary modelId differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.tokenization,
      manifest.tokenization,
      "Neural vocabulary tokenization differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.type,
      manifest.decoder,
      "Neural vocabulary decoder type differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.beamWidth,
      manifest.beamSearch?.beamWidth,
      "Neural vocabulary beam width differs from the runtime manifest.",
      failures
    );
    requireEqual(
      output?.maxLength,
      manifest.beamSearch?.maxOutputGraphemes,
      "Neural vocabulary output length differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.maxSteps,
      manifest.beamSearch?.maxSteps,
      "Neural vocabulary decoder range differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.outputSequenceValidation,
      manifest.outputSequenceValidation,
      "Neural vocabulary output validator differs from the runtime manifest.",
      failures
    );
  }

  return result(failures);
}

function validateCTCVocabularyContract(options) {
  const failures = [];
  const vocabulary = options.vocabulary;
  const config = options.config;
  const manifest = options.manifest ?? null;

  if (!isRecord(vocabulary)) {
    failures.push("CTC vocabulary root must be an object.");
    return result(failures);
  }
  requireExactKeys(
    vocabulary,
    CTC_TOP_LEVEL_KEYS,
    "CTC vocabulary root",
    failures
  );
  requireEqual(
    vocabulary.schemaVersion,
    NEURAL_CTC_VOCABULARY_SCHEMA_VERSION,
    "CTC vocabulary schemaVersion must be 2.",
    failures
  );
  requireEqual(
    vocabulary.modelId,
    CTC_MODEL_ID,
    "CTC vocabulary modelId is unsupported.",
    failures
  );
  requireEqual(
    vocabulary.modelId,
    config?.modelId,
    "CTC vocabulary modelId differs from the training config.",
    failures
  );
  requireEqual(
    vocabulary.runtimeModelContract,
    CTC_RUNTIME_MODEL_CONTRACT,
    "CTC vocabulary runtimeModelContract is unsupported.",
    failures
  );
  requireEqual(
    vocabulary.runtimeModelContract,
    config?.architecture?.runtimeModelContract,
    "CTC vocabulary runtimeModelContract differs from the training config.",
    failures
  );
  requireEqual(
    vocabulary.tokenization,
    NEURAL_TOKENIZATION,
    "CTC vocabulary tokenization must be unicode-scalar-character.",
    failures
  );
  requireEqual(
    vocabulary.tokenization,
    config?.architecture?.tokenization,
    "CTC vocabulary tokenization differs from the training config.",
    failures
  );
  validateGeneratedAt(vocabulary.generatedAt, failures);

  validateCTCInputVocabulary(vocabulary.input, config, failures);
  validateCTCOutputVocabulary(vocabulary.output, config, failures);
  validateCTCDecoder({
    decoder: vocabulary.decoder,
    output: vocabulary.output,
    config,
    manifest,
    failures
  });
  validateDatasetBinding({
    dataset: vocabulary.dataset,
    config,
    datasetManifest: options.datasetManifest,
    datasetManifestSha256: options.datasetManifestSha256,
    manifest,
    failures
  });
  validateNativeRuntimePolicy(vocabulary.nativeRuntimePolicy, failures);

  if (isRecord(manifest)) {
    requireEqual(
      vocabulary.modelId,
      manifest.selectedArtifact,
      "CTC vocabulary modelId differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.runtimeModelContract,
      manifest.runtimeModelContract,
      "CTC vocabulary runtime contract differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.tokenization,
      manifest.tokenization,
      "CTC vocabulary tokenization differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.type,
      manifest.decoder,
      "CTC vocabulary decoder type differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.beamWidth,
      manifest.beamSearch?.beamWidth,
      "CTC vocabulary beam width differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.output?.timeSteps,
      manifest.beamSearch?.maxOutputGraphemes,
      "CTC vocabulary output time dimension differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.output?.timeSteps,
      manifest.beamSearch?.maxSteps,
      "CTC vocabulary decoder range differs from the runtime manifest.",
      failures
    );
    requireEqual(
      vocabulary.decoder?.outputSequenceValidation,
      manifest.outputSequenceValidation,
      "CTC vocabulary output validator differs from the runtime manifest.",
      failures
    );
  }

  return result(failures);
}

function validateCTCInputVocabulary(value, config, failures) {
  if (!isRecord(value)) {
    failures.push("CTC input vocabulary must be an object.");
    return;
  }
  requireExactKeys(value, CTC_INPUT_KEYS, "CTC input vocabulary", failures);
  if (
    !Number.isSafeInteger(value.maxLength) ||
    value.maxLength < 4 ||
    value.maxLength > 128
  ) {
    failures.push("CTC input vocabulary maxLength must be an integer from 4 through 128.");
  }
  requireEqual(
    value.maxLength,
    config?.decoder?.maxInputGraphemes,
    "CTC input vocabulary maxLength differs from the training config.",
    failures
  );
  if (!validateTokenInventory(value, 4, "CTC input vocabulary", failures)) {
    return;
  }
  const specialIds = [];
  for (const { field, token } of CTC_INPUT_SPECIAL_TOKENS) {
    const id = value[field];
    specialIds.push(id);
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      id >= value.tokensById.length ||
      value.tokensById[id] !== token ||
      value.idsByToken?.[token] !== id
    ) {
      failures.push(
        `CTC input vocabulary ${field} does not identify the exact ${token} token.`
      );
    }
  }
  if (new Set(specialIds).size !== CTC_INPUT_SPECIAL_TOKENS.length) {
    failures.push("CTC input vocabulary special-token IDs must be distinct.");
  }
  for (const token of value.tokensById.filter(
    (candidate) => !CTC_INPUT_SPECIAL_VALUES.has(candidate)
  )) {
    if (!/^[a-z]$/u.test(token)) {
      failures.push(
        `CTC input vocabulary lexical token ${JSON.stringify(token)} is not exactly one lowercase ASCII letter.`
      );
    }
  }
}

function validateCTCOutputVocabulary(value, config, failures) {
  if (!isRecord(value)) {
    failures.push("CTC output vocabulary must be an object.");
    return;
  }
  requireExactKeys(value, CTC_OUTPUT_KEYS, "CTC output vocabulary", failures);
  if (
    !Number.isSafeInteger(value.timeSteps) ||
    value.timeSteps < 8 ||
    value.timeSteps > 48
  ) {
    failures.push("CTC output vocabulary timeSteps must be an integer from 8 through 48.");
  }
  requireEqual(
    value.timeSteps,
    config?.decoder?.outputTimeSteps,
    "CTC output vocabulary timeSteps differs from the training config.",
    failures
  );
  if (!validateTokenInventory(value, 2, "CTC output vocabulary", failures)) {
    return;
  }
  requireEqual(
    value.blankId,
    config?.decoder?.blankId,
    "CTC output vocabulary blankId differs from the training config.",
    failures
  );
  if (
    !Number.isSafeInteger(value.blankId) ||
    value.blankId !== 0 ||
    value.tokensById[value.blankId] !== CTC_BLANK_TOKEN ||
    value.idsByToken?.[CTC_BLANK_TOKEN] !== value.blankId
  ) {
    failures.push(
      "CTC output vocabulary blankId must identify <ctc-blank> at class zero."
    );
  }
  for (const [id, token] of value.tokensById.entries()) {
    if (id !== value.blankId && !isSupportedNeuralOutputScalarToken(token)) {
      failures.push(
        `CTC output vocabulary lexical token ${JSON.stringify(token)} is not exactly one supported Devanagari or joiner Unicode scalar.`
      );
    }
  }
}

function validateTokenInventory(value, minimumTokens, label, failures) {
  if (
    !Array.isArray(value.tokensById) ||
    value.tokensById.length < minimumTokens ||
    !value.tokensById.every((token) => typeof token === "string")
  ) {
    failures.push(
      `${label} tokensById must contain its special tokens and at least one lexical token.`
    );
    return false;
  }
  if (new Set(value.tokensById).size !== value.tokensById.length) {
    failures.push(`${label} tokensById contains duplicate tokens.`);
  }
  if (!isRecord(value.idsByToken)) {
    failures.push(`${label} idsByToken must be an object.`);
    return false;
  }
  const tokenKeys = [...value.tokensById].sort();
  const idKeys = Object.keys(value.idsByToken).sort();
  if (!deepEqual(tokenKeys, idKeys)) {
    failures.push(`${label} idsByToken keys are not the exact inverse token inventory.`);
  }
  for (const [id, token] of value.tokensById.entries()) {
    if (
      !Number.isSafeInteger(value.idsByToken[token]) ||
      value.idsByToken[token] !== id
    ) {
      failures.push(`${label} idsByToken is not the contiguous inverse of tokensById.`);
      break;
    }
  }
  return true;
}

function validateCTCDecoder({ decoder, output, config, manifest, failures }) {
  if (!isRecord(decoder)) {
    failures.push("CTC vocabulary decoder must be an object.");
    return;
  }
  requireExactKeys(
    decoder,
    CTC_DECODER_KEYS,
    "CTC vocabulary decoder",
    failures
  );
  requireEqual(
    decoder.type,
    "ctc-prefix-beam-search",
    "CTC vocabulary decoder type must be ctc-prefix-beam-search.",
    failures
  );
  requireEqual(
    decoder.type,
    config?.decoder?.type,
    "CTC vocabulary decoder type differs from the training config.",
    failures
  );
  if (
    !Number.isSafeInteger(decoder.beamWidth) ||
    decoder.beamWidth < 2 ||
    decoder.beamWidth > 16
  ) {
    failures.push("CTC vocabulary beamWidth must be an integer from 2 through 16.");
  }
  requireEqual(
    decoder.beamWidth,
    config?.decoder?.beamWidth,
    "CTC vocabulary beam width differs from the training config.",
    failures
  );
  if (
    !Number.isSafeInteger(decoder.maximumCandidates) ||
    decoder.maximumCandidates < 1 ||
    decoder.maximumCandidates > decoder.beamWidth
  ) {
    failures.push(
      "CTC vocabulary maximumCandidates must be an integer from 1 through beamWidth."
    );
  }
  requireEqual(
    decoder.maximumCandidates,
    config?.decoder?.maximumCandidates,
    "CTC vocabulary maximumCandidates differs from the training config.",
    failures
  );
  requireEqual(
    decoder.outputSequenceValidation,
    NEURAL_OUTPUT_SEQUENCE_VALIDATOR,
    "CTC vocabulary output sequence validator is unsupported.",
    failures
  );
  requireEqual(
    decoder.rejectWhitespaceCandidates,
    true,
    "CTC vocabulary must reject whitespace candidates.",
    failures
  );
  requireEqual(
    decoder.rejectLatinCandidates,
    true,
    "CTC vocabulary must reject Latin candidates.",
    failures
  );
  requireEqual(
    decoder.rejectWhitespaceCandidates,
    config?.decoder?.rejectWhitespaceOutput,
    "CTC vocabulary whitespace policy differs from the training config.",
    failures
  );
  requireEqual(
    decoder.rejectLatinCandidates,
    config?.decoder?.rejectLatinOutput,
    "CTC vocabulary Latin policy differs from the training config.",
    failures
  );
  if (isRecord(manifest)) {
    requireEqual(
      output?.timeSteps,
      manifest.beamSearch?.maxSteps,
      "CTC vocabulary decoder does not cover the manifest output range.",
      failures
    );
  }
}

export function isSupportedNeuralOutputScalarToken(value) {
  if (typeof value !== "string") return false;
  const scalars = [...value];
  if (scalars.length !== 1) return false;
  const codePoint = scalars[0].codePointAt(0);
  return (codePoint >= 0x0900 && codePoint <= 0x097F) ||
    codePoint === 0x200C ||
    codePoint === 0x200D;
}

function validateVocabularySide({
  value,
  label,
  expectedMaximumLength,
  outputSide,
  failures
}) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object.`);
    return null;
  }
  requireExactKeys(value, VOCABULARY_KEYS, label, failures);
  const minimumLength = outputSide ? 8 : 4;
  const maximumLength = outputSide ? 48 : 128;
  if (!Number.isSafeInteger(value.maxLength) ||
      value.maxLength < minimumLength ||
      value.maxLength > maximumLength) {
    failures.push(
      `${label} maxLength must be an integer from ${minimumLength} through ` +
      `${maximumLength}.`
    );
  }
  requireEqual(
    value.maxLength,
    expectedMaximumLength,
    `${label} maxLength differs from the training config.`,
    failures
  );

  if (!Array.isArray(value.tokensById) ||
      value.tokensById.length < SPECIAL_TOKENS.length + 1 ||
      !value.tokensById.every((token) => typeof token === "string")) {
    failures.push(
      `${label} tokensById must contain four special tokens and at least one ` +
      "string lexical token."
    );
    return value;
  }
  if (new Set(value.tokensById).size !== value.tokensById.length) {
    failures.push(`${label} tokensById contains duplicate tokens.`);
  }
  if (!isRecord(value.idsByToken)) {
    failures.push(`${label} idsByToken must be an object.`);
  } else {
    const tokenKeys = [...value.tokensById].sort();
    const idKeys = Object.keys(value.idsByToken).sort();
    if (!deepEqual(tokenKeys, idKeys)) {
      failures.push(
        `${label} idsByToken keys are not the exact inverse token inventory.`
      );
    }
    for (const [id, token] of value.tokensById.entries()) {
      if (!Number.isSafeInteger(value.idsByToken[token]) ||
          value.idsByToken[token] !== id) {
        failures.push(
          `${label} idsByToken is not the contiguous inverse of tokensById.`
        );
        break;
      }
    }
  }

  const specialIds = [];
  for (const { field, token } of SPECIAL_TOKENS) {
    const id = value[field];
    specialIds.push(id);
    if (!Number.isSafeInteger(id) ||
        id < 0 ||
        id >= value.tokensById.length ||
        value.tokensById[id] !== token ||
        value.idsByToken?.[token] !== id) {
      failures.push(
        `${label} ${field} does not identify the exact ${token} token.`
      );
    }
  }
  if (new Set(specialIds).size !== SPECIAL_TOKENS.length) {
    failures.push(`${label} special-token IDs must be distinct.`);
  }

  const lexicalTokens = value.tokensById.filter(
    (token) => !SPECIAL_TOKEN_VALUES.has(token)
  );
  if (lexicalTokens.length === 0) {
    failures.push(`${label} must contain at least one lexical token.`);
  }
  for (const token of lexicalTokens) {
    const valid = outputSide
      ? isSupportedNeuralOutputScalarToken(token)
      : /^[a-z]$/u.test(token);
    if (!valid) {
      failures.push(
        outputSide
          ? `${label} lexical token ${JSON.stringify(token)} is not exactly ` +
            "one supported Devanagari or joiner Unicode scalar."
          : `${label} lexical token ${JSON.stringify(token)} is not exactly ` +
            "one lowercase ASCII letter."
      );
    }
  }
  return value;
}

function validateDecoder({
  decoder,
  output,
  config,
  manifest,
  failures
}) {
  if (!isRecord(decoder)) {
    failures.push("Neural vocabulary decoder must be an object.");
    return;
  }
  requireExactKeys(
    decoder,
    DECODER_KEYS,
    "Neural vocabulary decoder",
    failures
  );
  requireEqual(
    decoder.type,
    "beam-search",
    "Neural vocabulary decoder type must be beam-search.",
    failures
  );
  requireEqual(
    decoder.type,
    config?.decoder?.type,
    "Neural vocabulary decoder type differs from the training config.",
    failures
  );
  if (!Number.isSafeInteger(decoder.beamWidth) ||
      decoder.beamWidth < 2 ||
      decoder.beamWidth > 8) {
    failures.push(
      "Neural vocabulary beamWidth must be an integer from 2 through 8."
    );
  }
  requireEqual(
    decoder.beamWidth,
    config?.decoder?.beamWidth,
    "Neural vocabulary beam width differs from the training config.",
    failures
  );
  if (!Number.isSafeInteger(decoder.maxSteps) ||
      decoder.maxSteps !== output?.maxLength - 1) {
    failures.push(
      "Neural vocabulary decoder maxSteps must expose output.maxLength - 1."
    );
  }
  requireEqual(
    decoder.outputSequenceValidation,
    NEURAL_OUTPUT_SEQUENCE_VALIDATOR,
    "Neural vocabulary output sequence validator is unsupported.",
    failures
  );
  requireEqual(
    decoder.rejectWhitespaceCandidates,
    true,
    "Neural vocabulary must reject whitespace candidates.",
    failures
  );
  requireEqual(
    decoder.rejectLatinCandidates,
    true,
    "Neural vocabulary must reject Latin candidates.",
    failures
  );
  requireEqual(
    decoder.rejectWhitespaceCandidates,
    config?.decoder?.rejectWhitespaceOutput,
    "Neural vocabulary whitespace policy differs from the training config.",
    failures
  );
  requireEqual(
    decoder.rejectLatinCandidates,
    config?.decoder?.rejectLatinOutput,
    "Neural vocabulary Latin policy differs from the training config.",
    failures
  );
  if (isRecord(manifest)) {
    requireEqual(
      decoder.maxSteps,
      manifest.beamSearch?.maxOutputGraphemes - 1,
      "Neural vocabulary decoder does not cover the manifest output range.",
      failures
    );
  }
}

function validateDatasetBinding({
  dataset,
  config,
  datasetManifest,
  datasetManifestSha256,
  manifest,
  failures
}) {
  if (!isRecord(dataset)) {
    failures.push("Neural vocabulary dataset binding must be an object.");
    return;
  }
  requireExactKeys(
    dataset,
    DATASET_KEYS,
    "Neural vocabulary dataset binding",
    failures
  );
  requireEqual(
    dataset.manifest,
    config?.training?.datasetManifest,
    "Neural vocabulary dataset path differs from the training config.",
    failures
  );
  if (!SHA256_PATTERN.test(String(dataset.manifestSha256 ?? ""))) {
    failures.push(
      "Neural vocabulary dataset manifest digest must be lowercase SHA-256."
    );
  }
  requireEqual(
    dataset.manifestSha256,
    datasetManifestSha256,
    "Neural vocabulary dataset manifest digest is stale.",
    failures
  );
  if (!isRecord(dataset.splitSha256)) {
    failures.push(
      "Neural vocabulary dataset split digests must be an object."
    );
  } else {
    requireExactKeys(
      dataset.splitSha256,
      SPLIT_KEYS,
      "Neural vocabulary dataset split digests",
      failures
    );
    for (const split of SPLIT_KEYS) {
      if (!SHA256_PATTERN.test(
        String(dataset.splitSha256[split] ?? "")
      )) {
        failures.push(
          `Neural vocabulary ${split} split digest must be lowercase SHA-256.`
        );
      }
    }
    if (!deepEqual(dataset.splitSha256, datasetManifest?.sha256)) {
      failures.push(
        "Neural vocabulary dataset split digests differ from the inspected " +
        "dataset manifest."
      );
    }
  }
  if (isRecord(manifest)) {
    requireEqual(
      dataset.manifestSha256,
      manifest.sha256?.trainingDatasetManifest,
      "Neural vocabulary dataset digest differs from the runtime manifest.",
      failures
    );
  }
}

function validateNativeRuntimePolicy(policy, failures) {
  if (!isRecord(policy)) {
    failures.push("Neural vocabulary nativeRuntimePolicy must be an object.");
    return;
  }
  requireExactKeys(
    policy,
    RUNTIME_POLICY_KEYS,
    "Neural vocabulary nativeRuntimePolicy",
    failures
  );
  for (const key of RUNTIME_POLICY_KEYS) {
    requireEqual(
      policy[key],
      true,
      `Neural vocabulary nativeRuntimePolicy.${key} must be true.`,
      failures
    );
  }
}

function validateGeneratedAt(value, failures) {
  if (typeof value !== "string" || !GENERATED_AT_PATTERN.test(value)) {
    failures.push(
      "Neural vocabulary generatedAt must be a UTC second-precision ISO timestamp."
    );
    return;
  }
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString().replace(".000Z", "Z")
    : null;
  if (canonical !== value) {
    failures.push("Neural vocabulary generatedAt is not a real UTC timestamp.");
  }
}

function requireExactKeys(value, expected, label, failures) {
  if (!isRecord(value)) {
    failures.push(`${label} must be an object.`);
    return;
  }
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (!deepEqual(actual, canonical)) {
    const missing = canonical.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !canonical.includes(key));
    failures.push(
      `${label} keys are not closed` +
      `${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}` +
      `${unknown.length > 0 ? `; unknown ${unknown.join(", ")}` : ""}.`
    );
  }
}

function requireEqual(actual, expected, message, failures) {
  if (!Object.is(actual, expected)) failures.push(message);
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
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        deepEqual(left[key], right[key])
    );
}

function isRecord(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function result(failures) {
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    status: uniqueFailures.length === 0
      ? "passed-neural-vocabulary-contract"
      : "failed-neural-vocabulary-contract",
    valid: uniqueFailures.length === 0,
    failures: uniqueFailures
  });
}
