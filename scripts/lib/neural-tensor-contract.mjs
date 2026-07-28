const ATTENTION_MODEL_ID = "lekh-open-vocab-bigru-attention-v1";
const ATTENTION_RUNTIME_CONTRACT = "split-attention-incremental-v1";

/**
 * Independently derive the split Core ML feature contract from the canonical
 * training configuration and the vocabulary consumed by the native runtime.
 * Reports and manifests are evidence inputs, not authorities for their own
 * tensor shapes.
 */
export function validateNeuralSplitTensorContract(options = {}) {
  const failures = [];
  const config = options.config;
  const vocabulary = options.vocabulary;
  const tensorContract = options.tensorContract;

  if (!isRecord(config) || config.modelId !== ATTENTION_MODEL_ID) {
    failures.push(
      "Split tensor validation requires the canonical attention config."
    );
    return result(null, failures);
  }
  if (!isRecord(vocabulary) ||
      vocabulary.modelId !== ATTENTION_MODEL_ID) {
    failures.push(
      "Split tensor validation requires the attention runtime vocabulary."
    );
    return result(null, failures);
  }

  const dimensions = {
    maxInputLength: vocabulary.input?.maxLength,
    beamWidth: vocabulary.decoder?.beamWidth,
    decoderLayers: config.architecture?.decoderLayers,
    hiddenWidth: config.architecture?.hiddenDim,
    attentionWidth: config.architecture?.attentionDim,
    vocabularySize: vocabulary.output?.tokensById?.length
  };
  for (const [name, value] of Object.entries(dimensions)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      failures.push(`Split tensor dimension ${name} must be a positive integer.`);
    }
  }
  if (dimensions.maxInputLength !== config.decoder?.maxInputGraphemes) {
    failures.push(
      "Split tensor input length differs between vocabulary and config."
    );
  }
  if (dimensions.beamWidth !== config.decoder?.beamWidth) {
    failures.push(
      "Split tensor beam width differs between vocabulary and config."
    );
  }
  if (failures.length > 0) return result(null, failures);

  const encoderWidth = dimensions.hiddenWidth * 2;
  const tensor = (shape, dataType) => ({ shape, dataType });
  const expected = {
    encoder: {
      inputs: {
        inputIds: tensor(
          [1, dimensions.maxInputLength],
          "INT32"
        )
      },
      outputs: {
        encoderOutputs: tensor(
          [1, dimensions.maxInputLength, encoderWidth],
          "FLOAT16"
        ),
        encoderEnergy: tensor(
          [
            1,
            dimensions.maxInputLength,
            dimensions.attentionWidth
          ],
          "FLOAT16"
        ),
        validMask: tensor(
          [1, dimensions.maxInputLength],
          "FLOAT16"
        ),
        initialDecoderHidden: tensor(
          [dimensions.decoderLayers, 1, dimensions.hiddenWidth],
          "FLOAT16"
        )
      }
    },
    decoderStep: {
      inputs: {
        decoderTokenIds: tensor(
          [dimensions.beamWidth, 1],
          "INT32"
        ),
        decoderHidden: tensor(
          [
            dimensions.decoderLayers,
            dimensions.beamWidth,
            dimensions.hiddenWidth
          ],
          "FLOAT16"
        ),
        encoderOutputs: tensor(
          [1, dimensions.maxInputLength, encoderWidth],
          "FLOAT16"
        ),
        encoderEnergy: tensor(
          [
            1,
            dimensions.maxInputLength,
            dimensions.attentionWidth
          ],
          "FLOAT16"
        ),
        validMask: tensor(
          [1, dimensions.maxInputLength],
          "FLOAT16"
        )
      },
      outputs: {
        stepLogits: tensor(
          [dimensions.beamWidth, dimensions.vocabularySize],
          "FLOAT16"
        ),
        nextDecoderHidden: tensor(
          [
            dimensions.decoderLayers,
            dimensions.beamWidth,
            dimensions.hiddenWidth
          ],
          "FLOAT16"
        )
      }
    }
  };
  if (!deepEqual(tensorContract, expected)) {
    failures.push(
      "Split tensor contract is not the exact native-runtime contract derived " +
      "from the canonical config and vocabulary."
    );
  }
  return result(expected, failures);
}

export const NEURAL_SPLIT_RUNTIME_MODEL_CONTRACT =
  ATTENTION_RUNTIME_CONTRACT;

function result(expected, failures) {
  return deepFreeze({
    status: failures.length === 0
      ? "passed-neural-split-tensor-contract"
      : "failed-neural-split-tensor-contract",
    expected,
    failures: [...new Set(failures)]
  });
}

function isRecord(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return deepEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
