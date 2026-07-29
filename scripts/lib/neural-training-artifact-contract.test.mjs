import { describe, expect, it } from "vitest";
import {
  pinnedNeuralRuntimeVersions
} from "./neural-training-artifact-contract.mjs";

describe("neural training artifact runtime pins", () => {
  it("requires the CPU wheel identity for the macOS export host", () => {
    expect(pinnedNeuralRuntimeVersions("cpu")).toEqual({
      numpy: "1.26.4",
      torch: "2.7.0",
      coremltools: "9.0"
    });
  });

  it("requires the exact CUDA 11.8 wheel identity for remote training", () => {
    expect(pinnedNeuralRuntimeVersions("cuda")).toEqual({
      numpy: "1.26.4",
      torch: "2.7.0+cu118",
      coremltools: "9.0"
    });
  });

  it("rejects an unknown execution device", () => {
    expect(() => pinnedNeuralRuntimeVersions("mps")).toThrow(
      /Unsupported neural training device mps/u
    );
  });
});
