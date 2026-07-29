import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  CTC_FINITE_PATH_DECODER_POLICY,
  isCTCFinitePathDecoderPolicy
} from "./neural-ctc-finite-path-contract.mjs";

describe("CTC finite-path decoder contract", () => {
  it("accepts only the exact closed policy", () => {
    assert.equal(
      isCTCFinitePathDecoderPolicy(
        structuredClone(CTC_FINITE_PATH_DECODER_POLICY)
      ),
      true
    );
    assert.equal(
      isCTCFinitePathDecoderPolicy({
        ...CTC_FINITE_PATH_DECODER_POLICY,
        extra: true
      }),
      false
    );
    assert.equal(
      isCTCFinitePathDecoderPolicy({
        ...CTC_FINITE_PATH_DECODER_POLICY,
        rule: "target-length-only"
      }),
      false
    );
  });
});
