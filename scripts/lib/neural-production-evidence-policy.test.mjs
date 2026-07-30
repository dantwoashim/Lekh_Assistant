import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import {
  CANONICAL_NEURAL_GOLD_EVIDENCE,
  expectedNeuralCandidateExportStatus,
  validateCanonicalNeuralGoldEvidence
} from "./neural-production-evidence-policy.mjs";

describe("neural production evidence policy", () => {
  it("locks production gold evidence to one path, manifest digest, and corpus", () => {
    const repoRoot = resolve("/tmp/lekh-production-policy-fixture");
    const canonical = {
      repoRoot,
      manifestPath: resolve(
        repoRoot,
        CANONICAL_NEURAL_GOLD_EVIDENCE.manifest
      ),
      manifestSha256: CANONICAL_NEURAL_GOLD_EVIDENCE.manifestSha256,
      corpusSha256: CANONICAL_NEURAL_GOLD_EVIDENCE.corpusSha256,
      artifactOverrides: {}
    };
    assert.equal(validateCanonicalNeuralGoldEvidence(canonical).valid, true);

    for (const mutation of [
      { manifestPath: resolve(repoRoot, "data/neural/gold/easy.json") },
      { manifestSha256: "0".repeat(64) },
      { corpusSha256: "0".repeat(64) },
      { artifactOverrides: { goldManifest: null } }
    ]) {
      assert.equal(
        validateCanonicalNeuralGoldEvidence({
          ...canonical,
          ...mutation
        }).valid,
        false
      );
    }
  });

  it("accepts only the exact export status for the manifest architecture", () => {
    const manifest = {
      selectedArtifact: "lekh-open-vocab-ctc-transformer-v2",
      architecture: "fixed-shape-transformer-ctc",
      runtimeModelContract: "single-transformer-ctc-v1"
    };
    assert.equal(
      expectedNeuralCandidateExportStatus(manifest),
      "passed-open-vocab-ctc-transformer-candidate"
    );
    assert.equal(
      expectedNeuralCandidateExportStatus({
        ...manifest,
        architecture: "gru-encoder-decoder-seq2seq"
      }),
      null
    );
    assert.notEqual(
      expectedNeuralCandidateExportStatus(manifest),
      "passed-attacker-controlled-status"
    );
  });
});
