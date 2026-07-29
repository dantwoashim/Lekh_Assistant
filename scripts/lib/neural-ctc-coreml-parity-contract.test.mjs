import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import {
  CTC_COREML_PARITY_CASE_IDS,
  CTC_COREML_PARITY_POLICY,
  hasCTCCoreMLParityEvidence,
  isCTCCoreMLParityPolicy,
  isCTCCoreMLParitySuite
} from "./neural-ctc-coreml-parity-contract.mjs";

describe("CTC Core ML parity contract", () => {
  it("accepts the exact closed policy and representative suite", () => {
    const exportEvidence = fixture();
    assert.equal(
      isCTCCoreMLParityPolicy(
        structuredClone(CTC_COREML_PARITY_POLICY)
      ),
      true
    );
    assert.equal(
      isCTCCoreMLParitySuite(
        exportEvidence.artifactValidation.representativeParitySuite
      ),
      true
    );
    assert.equal(hasCTCCoreMLParityEvidence(exportEvidence), true);
  });

  it("rejects policy, input-identity, and numerical-evidence forgeries", () => {
    const extraPolicyField = fixture();
    extraPolicyField.representativeParityPolicy.extra = true;
    assert.equal(hasCTCCoreMLParityEvidence(extraPolicyField), false);

    const missingBoundary = fixture();
    missingBoundary.artifactValidation.representativeParitySuite.cases.pop();
    assert.equal(hasCTCCoreMLParityEvidence(missingBoundary), false);

    const forgedIdentity = fixture();
    forgedIdentity.artifactValidation.representativeParitySuite
      .caseIdentitySha256 = "f".repeat(64);
    assert.equal(hasCTCCoreMLParityEvidence(forgedIdentity), false);

    const inconsistentPublication = fixture();
    inconsistentPublication.artifactValidation.representativeParitySuite
      .cases[2].maximumAbsoluteLogitError = 0.006;
    assert.equal(hasCTCCoreMLParityEvidence(inconsistentPublication), false);
  });
});

function fixture() {
  const cases = CTC_COREML_PARITY_CASE_IDS.map((caseId, index) => ({
    caseId,
    contentLength: [6, 3, 5, 8, 31][index],
    inputSha256: createHash("sha256")
      .update(`parity-input-${index}`)
      .digest("hex"),
    maximumAbsoluteLogitError: (index + 1) / 10_000
  }));
  const identities = cases.map((candidate) => ({
    caseId: candidate.caseId,
    contentLength: candidate.contentLength,
    inputSha256: candidate.inputSha256
  }));
  const suite = {
    schemaVersion: 1,
    status: "passed",
    policyId: CTC_COREML_PARITY_POLICY.policyId,
    caseCount: cases.length,
    caseIdentitySha256: createHash("sha256")
      .update(JSON.stringify(identities))
      .digest("hex"),
    maximumAbsoluteLogitError: 0.0005,
    relativeTolerance: 5e-3,
    absoluteTolerance: 5e-3,
    cases
  };
  return {
    tensorContract: {
      inputIds: {
        shape: [1, 32],
        dataType: "INT32"
      }
    },
    representativeParityPolicy: structuredClone(
      CTC_COREML_PARITY_POLICY
    ),
    prePublicationValidation: {
      status: "passed",
      knownAnswerInputSha256: cases[0].inputSha256,
      maximumAbsoluteLogitError:
        cases[0].maximumAbsoluteLogitError,
      relativeTolerance: 5e-3,
      absoluteTolerance: 5e-3,
      representativeParitySuite: structuredClone(suite)
    },
    artifactValidation: {
      status: "passed",
      knownAnswerInputSha256: cases[0].inputSha256,
      maximumAbsoluteLogitError:
        cases[0].maximumAbsoluteLogitError,
      relativeTolerance: 5e-3,
      absoluteTolerance: 5e-3,
      representativeParitySuite: structuredClone(suite)
    }
  };
}
