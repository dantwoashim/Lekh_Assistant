import { resolve } from "node:path";

export const CANONICAL_NEURAL_GOLD_EVIDENCE = Object.freeze({
  manifest: "data/neural/gold/manifest.v3.json",
  manifestSha256:
    "41c9247b8553363b0432342264eba0e9f2ba6ac0d75dea123e94c3d604006c59",
  corpusSha256:
    "d0cb6cef6df9f54b2adb25b4251ef24f4c93679a1c48005a50a0ac6c6519952b"
});

const CANDIDATE_EXPORT_POLICY_BY_MODEL = Object.freeze({
  "lekh-open-vocab-seq2seq-v1": Object.freeze({
    architecture: "gru-encoder-decoder-seq2seq",
    runtimeModelContract: null,
    status: "passed-open-vocab-seq2seq-candidate"
  }),
  "lekh-open-vocab-bigru-attention-v1": Object.freeze({
    architecture: "bidirectional-gru-additive-attention-seq2seq",
    runtimeModelContract: "split-attention-incremental-v1",
    status: "passed-open-vocab-attention-split-candidate"
  }),
  "lekh-open-vocab-ctc-transformer-v2": Object.freeze({
    architecture: "fixed-shape-transformer-ctc",
    runtimeModelContract: "single-transformer-ctc-v1",
    status: "passed-open-vocab-ctc-transformer-candidate"
  })
});

export function expectedNeuralCandidateExportStatus(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const policy = CANDIDATE_EXPORT_POLICY_BY_MODEL[manifest.selectedArtifact];
  if (!policy ||
      manifest.architecture !== policy.architecture ||
      (manifest.runtimeModelContract ?? null) !== policy.runtimeModelContract) {
    return null;
  }
  return policy.status;
}

export function validateCanonicalNeuralGoldEvidence({
  repoRoot,
  manifestPath,
  manifestSha256,
  corpusSha256,
  artifactOverrides
}) {
  const issueCodes = [];
  if (resolve(manifestPath) !==
      resolve(repoRoot, CANONICAL_NEURAL_GOLD_EVIDENCE.manifest)) {
    issueCodes.push("neural-production.gold-manifest-path-not-canonical");
  }
  if (manifestSha256 !==
      CANONICAL_NEURAL_GOLD_EVIDENCE.manifestSha256) {
    issueCodes.push("neural-production.gold-manifest-sha256-not-canonical");
  }
  if (corpusSha256 !== CANONICAL_NEURAL_GOLD_EVIDENCE.corpusSha256) {
    issueCodes.push("neural-production.gold-corpus-sha256-not-canonical");
  }
  if (artifactOverrides &&
      typeof artifactOverrides === "object" &&
      !Array.isArray(artifactOverrides) &&
      Object.prototype.hasOwnProperty.call(artifactOverrides, "goldManifest")) {
    issueCodes.push("neural-production.gold-manifest-override-forbidden");
  }
  return Object.freeze({
    valid: issueCodes.length === 0,
    issueCodes: Object.freeze(issueCodes)
  });
}
