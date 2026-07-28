import { describe, expect, it } from "vitest";
import {
  validateNeuralSplitTensorContract
} from "./neural-tensor-contract.mjs";

describe("split neural tensor contract", () => {
  it("derives the exact native runtime feature graph", () => {
    const contract = expectedContract();
    const result = validateNeuralSplitTensorContract({
      config: config(),
      vocabulary: vocabulary(),
      tensorContract: contract
    });

    expect(result.status).toBe(
      "passed-neural-split-tensor-contract"
    );
    expect(result.failures).toEqual([]);
    expect(result.expected).toEqual(contract);
    expect(Object.isFrozen(result.expected.decoderStep.outputs)).toBe(true);
  });

  for (const [label, mutate] of [
    [
      "input length",
      (value) => {
        value.encoder.inputs.inputIds.shape[1] += 1;
      }
    ],
    [
      "beam width",
      (value) => {
        value.decoderStep.inputs.decoderTokenIds.shape[0] += 1;
      }
    ],
    [
      "hidden state",
      (value) => {
        value.decoderStep.outputs.nextDecoderHidden.shape[2] += 1;
      }
    ],
    [
      "output vocabulary",
      (value) => {
        value.decoderStep.outputs.stepLogits.shape[1] += 1;
      }
    ],
    [
      "data type",
      (value) => {
        value.encoder.outputs.encoderEnergy.dataType = "FLOAT32";
      }
    ],
    [
      "open field",
      (value) => {
        value.decoderStep.outputs.untrusted = {
          shape: [1],
          dataType: "FLOAT16"
        };
      }
    ]
  ]) {
    it(`rejects ${label} drift`, () => {
      const contract = expectedContract();
      mutate(contract);
      const result = validateNeuralSplitTensorContract({
        config: config(),
        vocabulary: vocabulary(),
        tensorContract: contract
      });

      expect(result.status).toBe(
        "failed-neural-split-tensor-contract"
      );
      expect(result.failures.join("\n")).toMatch(
        /not the exact native-runtime contract/u
      );
    });
  }

  it("rejects missing and cross-model authorities", () => {
    expect(validateNeuralSplitTensorContract({
      config: null,
      vocabulary: vocabulary(),
      tensorContract: expectedContract()
    }).failures.join("\n")).toMatch(/canonical attention config/u);

    const wrongVocabulary = vocabulary();
    wrongVocabulary.modelId = "lekh-open-vocab-seq2seq-v1";
    expect(validateNeuralSplitTensorContract({
      config: config(),
      vocabulary: wrongVocabulary,
      tensorContract: expectedContract()
    }).failures.join("\n")).toMatch(/attention runtime vocabulary/u);
  });
});

function config() {
  return {
    modelId: "lekh-open-vocab-bigru-attention-v1",
    architecture: {
      decoderLayers: 2,
      hiddenDim: 256,
      attentionDim: 192
    },
    decoder: {
      beamWidth: 4,
      maxInputGraphemes: 32
    }
  };
}

function vocabulary() {
  return {
    modelId: "lekh-open-vocab-bigru-attention-v1",
    input: {
      maxLength: 32
    },
    output: {
      tokensById: [
        "<pad>",
        "<s>",
        "</s>",
        "<unk>",
        "न",
        "े"
      ]
    },
    decoder: {
      beamWidth: 4
    }
  };
}

function expectedContract() {
  return {
    encoder: {
      inputs: {
        inputIds: { shape: [1, 32], dataType: "INT32" }
      },
      outputs: {
        encoderOutputs: {
          shape: [1, 32, 512],
          dataType: "FLOAT16"
        },
        encoderEnergy: {
          shape: [1, 32, 192],
          dataType: "FLOAT16"
        },
        validMask: { shape: [1, 32], dataType: "FLOAT16" },
        initialDecoderHidden: {
          shape: [2, 1, 256],
          dataType: "FLOAT16"
        }
      }
    },
    decoderStep: {
      inputs: {
        decoderTokenIds: { shape: [4, 1], dataType: "INT32" },
        decoderHidden: {
          shape: [2, 4, 256],
          dataType: "FLOAT16"
        },
        encoderOutputs: {
          shape: [1, 32, 512],
          dataType: "FLOAT16"
        },
        encoderEnergy: {
          shape: [1, 32, 192],
          dataType: "FLOAT16"
        },
        validMask: { shape: [1, 32], dataType: "FLOAT16" }
      },
      outputs: {
        stepLogits: { shape: [4, 6], dataType: "FLOAT16" },
        nextDecoderHidden: {
          shape: [2, 4, 256],
          dataType: "FLOAT16"
        }
      }
    }
  };
}
