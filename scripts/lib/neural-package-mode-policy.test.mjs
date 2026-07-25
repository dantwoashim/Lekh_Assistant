import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNeuralPackageModePolicy,
  evaluateNeuralPackageModePolicy,
  NeuralPackageModePolicyError
} from "./neural-package-mode-policy.mjs";

const ROOT = resolve("/tmp/lekh-neural-package-mode-policy");
const MODEL_ID = "lekh-open-vocab-bigru-attention-v1";
const PRODUCTION_ROOT = join(
  ROOT,
  "models",
  "macos",
  "LekhNeuralTransliterator.production"
);
const CANDIDATE_ROOT = join(
  ROOT,
  "data",
  "generated",
  "neural-open-vocab-model",
  MODEL_ID
);
const HASHES = Object.freeze({
  artifactSet: "a".repeat(64),
  manifest: "b".repeat(64),
  promotion: "c".repeat(64),
  receipt: "d".repeat(64),
  selection: "e".repeat(64)
});
const RUNS = Object.freeze({
  training: "1".repeat(32),
  export: "2".repeat(32)
});

describe("neural macOS package mode policy", () => {
  it("accepts exactly the three intended packaging states", () => {
    const productionDescriptor = descriptor(PRODUCTION_ROOT, true);
    const production = assertNeuralPackageModePolicy({
      repoRoot: ROOT,
      artifactRoot: PRODUCTION_ROOT,
      descriptor: productionDescriptor,
      mode: "production",
      experimentalEnabled: false,
      promotionReport: promotionReport(productionDescriptor)
    });
    expect(production).toMatchObject({
      valid: true,
      artifactClass: "production",
      productionEligible: true,
      experimentalEnabled: false,
      promotionVerified: true,
      promotionId: HASHES.promotion,
      promotionReceiptSha256: HASHES.receipt
    });

    for (const mode of ["candidate-promotion", "experimental"]) {
      const candidate = assertNeuralPackageModePolicy({
        repoRoot: ROOT,
        artifactRoot: CANDIDATE_ROOT,
        descriptor: descriptor(CANDIDATE_ROOT, false),
        mode,
        experimentalEnabled: true
      });
      expect(candidate).toMatchObject({
        valid: true,
        mode,
        artifactClass: "candidate",
        productionEligible: false,
        experimentalEnabled: true,
        promotionVerified: false,
        promotionId: null,
        promotionReceiptSha256: null
      });
    }
  });

  it("implements an exhaustive root, eligibility, flag, and receipt truth table", () => {
    const modes = ["production", "candidate-promotion", "experimental"];
    const roots = [
      ["production", PRODUCTION_ROOT],
      ["candidate", CANDIDATE_ROOT]
    ];
    for (const mode of modes) {
      for (const [rootKind, artifactRoot] of roots) {
        for (const productionEligible of [false, true]) {
          for (const experimentalEnabled of [false, true]) {
            for (const receiptPresent of [false, true]) {
              const candidateDescriptor = descriptor(
                artifactRoot,
                productionEligible
              );
              const result = evaluateNeuralPackageModePolicy({
                repoRoot: ROOT,
                artifactRoot,
                descriptor: candidateDescriptor,
                mode,
                experimentalEnabled,
                promotionReport: receiptPresent
                  ? promotionReport(candidateDescriptor)
                  : undefined
              });
              const expected = mode === "production"
                ? rootKind === "production" &&
                  productionEligible &&
                  !experimentalEnabled &&
                  receiptPresent
                : rootKind === "candidate" &&
                  !productionEligible &&
                  experimentalEnabled &&
                  !receiptPresent;
              expect({
                key: [
                  mode,
                  rootKind,
                  productionEligible,
                  experimentalEnabled,
                  receiptPresent
                ].join(":"),
                valid: result.valid
              }).toEqual({
                key: [
                  mode,
                  rootKind,
                  productionEligible,
                  experimentalEnabled,
                  receiptPresent
                ].join(":"),
                valid: expected
              });
            }
          }
        }
      }
    }
  });

  it("rejects unknown modes, non-boolean flags, and non-canonical roots", () => {
    const candidateDescriptor = descriptor(CANDIDATE_ROOT, false);
    const unknownMode = evaluateNeuralPackageModePolicy({
      repoRoot: ROOT,
      artifactRoot: CANDIDATE_ROOT,
      descriptor: candidateDescriptor,
      mode: "release",
      experimentalEnabled: true
    });
    expect(unknownMode.issueCodes).toContain("mode.unknown");

    const ambiguousFlag = evaluateNeuralPackageModePolicy({
      repoRoot: ROOT,
      artifactRoot: CANDIDATE_ROOT,
      descriptor: candidateDescriptor,
      mode: "experimental",
      experimentalEnabled: 1
    });
    expect(ambiguousFlag.issueCodes).toEqual(
      expect.arrayContaining([
        "flag.experimental-boolean",
        "flag.experimental-required"
      ])
    );

    const arbitraryRoot = join(ROOT, "models", "macos", "scratch");
    const arbitraryDescriptor = descriptor(arbitraryRoot, false);
    const result = evaluateNeuralPackageModePolicy({
      repoRoot: ROOT,
      artifactRoot: arbitraryRoot,
      descriptor: arbitraryDescriptor,
      mode: "experimental",
      experimentalEnabled: true
    });
    expect(result.issueCodes).toContain("root.candidate-required");
    expect(() => assertNeuralPackageModePolicy({
      repoRoot: ROOT,
      artifactRoot: arbitraryRoot,
      descriptor: arbitraryDescriptor,
      mode: "experimental",
      experimentalEnabled: true
    })).toThrow(NeuralPackageModePolicyError);
  });

  it("rejects stale, failed, incomplete, and cross-artifact promotion metadata", () => {
    const productionDescriptor = descriptor(PRODUCTION_ROOT, true);
    const cases = [
      [
        "failed status",
        (report) => ({ ...report, status: "failed-production-phase9-promotion" }),
        "promotion.report-contract"
      ],
      [
        "recorded failure",
        (report) => ({ ...report, failures: ["receipt changed"] }),
        "promotion.failed"
      ],
      [
        "wrong production directory",
        (report) => ({
          ...report,
          productionDirectory: "models/macos/other.production"
        }),
        "promotion.directory"
      ],
      [
        "missing verification",
        (report) => ({ ...report, verification: null }),
        "promotion.verification"
      ],
      [
        "different artifact set",
        (report) => ({
          ...report,
          verification: {
            ...report.verification,
            artifactSetSha256: "f".repeat(64)
          }
        }),
        "promotion.identity"
      ],
      [
        "different manifest",
        (report) => ({
          ...report,
          verification: {
            ...report.verification,
            manifest: {
              ...report.verification.manifest,
              sha256: "f".repeat(64)
            }
          }
        }),
        "promotion.manifest"
      ],
      [
        "unverified receipt path",
        (report) => ({
          ...report,
          verification: {
            ...report.verification,
            receipt: {
              ...report.verification.receipt,
              path: "reports/copied-promotion-receipt.json"
            }
          }
        }),
        "promotion.receipt"
      ]
    ];

    for (const [label, mutate, expectedIssue] of cases) {
      const result = evaluateNeuralPackageModePolicy({
        repoRoot: ROOT,
        artifactRoot: PRODUCTION_ROOT,
        descriptor: productionDescriptor,
        mode: "production",
        experimentalEnabled: false,
        promotionReport: mutate(promotionReport(productionDescriptor))
      });
      expect({
        label,
        valid: result.valid,
        found: result.issueCodes.includes(expectedIssue)
      }).toEqual({ label, valid: false, found: true });
    }
  });

  it("rejects promotion metadata on either unpromoted mode", () => {
    const candidateDescriptor = descriptor(CANDIDATE_ROOT, false);
    for (const mode of ["candidate-promotion", "experimental"]) {
      const result = evaluateNeuralPackageModePolicy({
        repoRoot: ROOT,
        artifactRoot: CANDIDATE_ROOT,
        descriptor: candidateDescriptor,
        mode,
        experimentalEnabled: true,
        promotionReport: promotionReport(candidateDescriptor)
      });
      expect(result.issueCodes).toContain("promotion.unexpected");
    }
  });

  it("binds the complete resolved descriptor layout to the selected root", () => {
    const valid = descriptor(CANDIDATE_ROOT, false);
    const cases = [
      [
        "wrong runtime contract",
        {
          ...valid,
          runtimeModelContract: "single-seq2seq-v1"
        },
        "descriptor.runtime-contract"
      ],
      [
        "prototype-chain model ID",
        {
          ...valid,
          modelId: "constructor",
          manifest: {
            ...valid.manifest,
            selectedArtifact: "constructor"
          }
        },
        "descriptor.model-id"
      ],
      [
        "missing vocabulary hash",
        {
          ...valid,
          vocabSha256: null
        },
        "descriptor.vocabulary-sha256"
      ],
      [
        "same run ID",
        {
          ...valid,
          manifest: {
            ...valid.manifest,
            exportRunId: RUNS.training
          }
        },
        "descriptor.run-identity"
      ],
      [
        "artifact outside candidate root",
        {
          ...valid,
          artifacts: valid.artifacts.map((artifact) => artifact.role === "encoder"
            ? {
                ...artifact,
                sourcePath: join(ROOT, "scratch", artifact.bundleName)
              }
            : artifact)
        },
        "descriptor.artifact-path"
      ],
      [
        "duplicate role",
        {
          ...valid,
          artifacts: [valid.artifacts[0], valid.artifacts[0]]
        },
        "descriptor.artifacts"
      ],
      [
        "incorrect aggregate bytes",
        {
          ...valid,
          totalCompiledBytes: valid.totalCompiledBytes + 1
        },
        "descriptor.artifact-bytes"
      ]
    ];
    for (const [label, changed, expectedIssue] of cases) {
      const result = evaluateNeuralPackageModePolicy({
        repoRoot: ROOT,
        artifactRoot: CANDIDATE_ROOT,
        descriptor: changed,
        mode: "experimental",
        experimentalEnabled: true
      });
      expect({
        label,
        valid: result.valid,
        found: result.issueCodes.includes(expectedIssue)
      }).toEqual({ label, valid: false, found: true });
    }
  });

  it("accepts the closed baseline descriptor branch", () => {
    const modelId = "lekh-open-vocab-seq2seq-v1";
    const artifactRoot = join(
      ROOT,
      "data",
      "generated",
      "neural-open-vocab-model",
      modelId
    );
    expect(assertNeuralPackageModePolicy({
      repoRoot: ROOT,
      artifactRoot,
      descriptor: descriptor(artifactRoot, false, modelId),
      mode: "experimental",
      experimentalEnabled: true
    })).toMatchObject({
      valid: true,
      modelId,
      artifactClass: "candidate"
    });
  });
});

function descriptor(artifactRoot, productionEligible, modelId = MODEL_ID) {
  const split = modelId === MODEL_ID;
  const artifacts = split
    ? [
        ["encoder", "LekhNeuralTransliteratorEncoder.mlmodelc"],
        ["decoderStep", "LekhNeuralTransliteratorDecoderStep.mlmodelc"]
      ]
    : [["model", "LekhNeuralTransliterator.mlmodelc"]];
  return {
    modelId,
    runtimeModelContract: split
      ? "split-attention-incremental-v1"
      : "single-seq2seq-v1",
    manifestPath: join(
      artifactRoot,
      "LekhNeuralTransliterator.manifest.json"
    ),
    manifestSha256: HASHES.manifest,
    vocabPath: join(
      artifactRoot,
      "LekhNeuralTransliterator.vocab.json"
    ),
    vocabSha256: "9".repeat(64),
    artifacts: artifacts.map(([role, bundleName], index) => ({
      role,
      bundleName,
      sourcePath: join(artifactRoot, bundleName),
      compiledSha256: String(index + 6).repeat(64),
      compiledBytes: (index + 1) * 1024
    })),
    totalCompiledBytes: artifacts.reduce(
      (total, _artifact, index) => total + (index + 1) * 1024,
      0
    ),
    artifactSetSha256: HASHES.artifactSet,
    manifest: {
      selectedArtifact: modelId,
      productionEligible,
      trainingRunId: RUNS.training,
      exportRunId: RUNS.export
    }
  };
}

function promotionReport(candidateDescriptor) {
  return {
    schemaVersion: 2,
    suite: "neural-production-promotion",
    phase: 9,
    production: true,
    status: "passed-production-phase9-promotion",
    productionDirectory: portable(PRODUCTION_ROOT),
    failures: [],
    verification: {
      promotionId: HASHES.promotion,
      selectionId: HASHES.selection,
      trainingRunId: RUNS.training,
      exportRunId: RUNS.export,
      modelId: MODEL_ID,
      runtimeModelContract: "split-attention-incremental-v1",
      artifactSetSha256: candidateDescriptor.artifactSetSha256,
      manifest: {
        path: portable(candidateDescriptor.manifestPath),
        bytes: 4096,
        sha256: candidateDescriptor.manifestSha256
      },
      receipt: {
        path: portable(join(
          PRODUCTION_ROOT,
          "neural-candidate-promotion-report.json"
        )),
        bytes: 8192,
        sha256: HASHES.receipt
      }
    }
  };
}

function portable(path) {
  return relative(ROOT, path).split(sep).join("/");
}
