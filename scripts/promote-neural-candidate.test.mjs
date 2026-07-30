import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, it } from "vitest";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  buildNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";
import {
  NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
} from "./lib/neural-runtime-placement-evidence.mjs";
import {
  evaluateNeuralRareScalarEvidence
} from "./lib/neural-rare-scalar-evaluation.mjs";
import {
  CTC_COREML_PARITY_CASE_IDS,
  CTC_COREML_PARITY_POLICY
} from "./lib/neural-ctc-coreml-parity-contract.mjs";
import {
  CTC_FINITE_PATH_DECODER_POLICY
} from "./lib/neural-ctc-finite-path-contract.mjs";
import {
  computeNeuralProductionPromotionId,
  verifyNeuralProductionPromotionReceipt
} from "./lib/neural-production-promotion-receipt.mjs";
import {
  NeuralCandidatePromotionError,
  promoteNeuralCandidate
} from "./promote-neural-candidate.mjs";

const TRAINING_RUN_ID = "0123456789abcdef0123456789abcdef";
const EXPORT_RUN_ID = "fedcba9876543210fedcba9876543210";
const FIXED_TIME = "2026-07-24T00:00:00.000Z";
const sourceRoot = process.cwd();
const phase9Checker = join(
  sourceRoot,
  "scripts",
  "check-neural-production-promotion.mjs"
);
const OFFICIAL_BENCHMARK_MANIFEST_SHA256 =
  "d492040eeb6ddd2883fee50d0f03c051e20a08d1f469da00679b66751136781f";
const OFFICIAL_BENCHMARK_CORPUS_SHA256 =
  "149d44c4e8832b91908c4bccfb67e60abcdf8ed99a1d873dc60ef7d0a130744a";
const REFERENCE_MANIFEST_SHA256 =
  "c3bd96c57a322455026df920dab74dc214113bb2a33aa67f6420805b195c52c6";
const productionManifestValidator = new Ajv2020({
  allErrors: true,
  strict: true
}).compile(readJson(join(
  process.cwd(),
  "data/neural/schema/lekh-neural-manifest.schema.json"
)));

describe("evidence-bound neural candidate promotion", () => {
  it("publishes an immutable single-model candidate as one verified production directory", () => {
    withFixture("baseline", (fixture) => {
      const before = inspectCandidate(fixture);
      const result = promote(fixture);
      const after = inspectCandidate(fixture);

      assert.equal(result.status, "passed-neural-candidate-promotion");
      assert.equal(result.artifactLayout, "single-model");
      assert.equal(after.sha256, before.sha256);
      assert.equal(after.bytes, before.bytes);

      const manifest = readJson(result.manifest);
      const report = readJson(result.report);
      const verification = verifyNeuralProductionPromotionReceipt({
        repoRoot: fixture.root,
        productionDirectory: result.productionDir
      });
      assert.equal(report.schemaVersion, 3);
      assert.equal(verification.promotionId, result.promotionId);
      assert.deepEqual(
        report.artifacts.map((artifact) => artifact.id),
        ["compiledModel", "mlpackage"]
      );
      assert.equal(
        report.artifacts.some((artifact) => artifact.id === "vocabulary"),
        false
      );
      const phase9Report = join(fixture.root, "reports", "phase9.json");
      const phase9 = spawnSync(
        process.execPath,
        [
          phase9Checker,
          "--production",
          "--report",
          phase9Report
        ],
        {
          cwd: fixture.root,
          encoding: "utf8"
        }
      );
      assert.equal(phase9.status, 0, phase9.stderr || phase9.stdout);
      assert.equal(
        readJson(phase9Report).status,
        "passed-production-phase9-promotion"
      );
      assert.equal(
        productionManifestValidator(manifest),
        true,
        JSON.stringify(productionManifestValidator.errors)
      );
      assert.equal(manifest.productionEligible, true);
      assert.deepEqual(manifest.metrics, fixture.evaluation.metrics);
      assert.deepEqual(
        manifest.performance,
        expectedProductionPerformance(fixture.benchmark)
      );
      assert.notDeepEqual(manifest.metrics, fixture.manifest.metrics);
      assert.equal(report.candidateImmutable, true);
      assert.equal(report.trainingRunId, TRAINING_RUN_ID);
      assert.equal(report.exportRunId, EXPORT_RUN_ID);
      assert.equal(report.inputs.predictions.sha256, fixture.identities.predictions.sha256);
      assert.equal(report.inputs.goldManifest.sha256, fixture.identities.goldManifest.sha256);
      assert.equal(report.inputs.goldCorpusSha256, fixture.goldManifest.corpusSha256);
      assert.equal(
        report.inputs.datasetManifest.sha256,
        fixture.identities.datasetManifest.sha256
      );
      assert.equal(
        report.inputs.datasetContentSha256,
        fixture.datasetManifest.datasetContentSha256
      );
      assert.equal(report.productionManifest.metricsSourceSha256, fixture.identities.evaluation.sha256);
      assert.equal(report.productionManifest.performanceSourceSha256, fixture.identities.benchmark.sha256);
      assert.equal(report.inputs.selectionId, fixture.selection.selectionId);
      assert.equal(
        report.inputs.selectionReport.sha256,
        fixture.identities.selection.sha256
      );
      assert.equal(
        report.inputs.comparisonPredictions.sha256,
        fixture.identities.comparisonPredictions.sha256
      );
      assert.equal(
        report.inputs.comparisonBenchmarkManifest.sha256,
        fixture.identities.comparisonBenchmarkManifest.sha256
      );

      assert.equal(
        inspectContainedDirectoryTree(
          fixture.root,
          join(result.productionDir, "LekhNeuralTransliterator.mlmodelc")
        ).sha256,
        fixture.identities.compiledModel.sha256
      );
      assert.equal(
        inspectContainedDirectoryTree(
          fixture.root,
          join(result.productionDir, "LekhNeuralTransliterator.mlpackage")
        ).sha256,
        fixture.identities.mlpackage.sha256
      );
      assert.equal(
        inspectContainedRegularFile(
          fixture.root,
          join(result.productionDir, "LekhNeuralTransliterator.vocab.json")
        ).sha256,
        fixture.identities.vocabulary.sha256
      );
      assert.deepEqual(promotionDebris(fixture), []);
    });
  });

  it("rejects a candidate that already claims production eligibility", () => {
    withFixture("baseline", (fixture) => {
      fixture.manifest.productionEligible = true;
      writeJson(fixture.paths.manifest, fixture.manifest);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /productionEligible=false/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects mismatched run identities before publication", () => {
    withFixture("baseline", (fixture) => {
      fixture.evaluation.exportRunId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      writeJson(fixture.paths.evaluation, fixture.evaluation);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /does not bind the candidate trainingRunId\/exportRunId/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects stale predictions and gold identities", () => {
    withFixture("baseline", (fixture) => {
      fixture.evaluation.predictionsSha256 = "a".repeat(64);
      writeJson(fixture.paths.evaluation, fixture.evaluation);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /exact candidate export predictions/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a single-forward or non-packaged benchmark", () => {
    withFixture("baseline", (fixture) => {
      fixture.benchmark.singleForwardBenchmarkIsConsumerLatency = true;
      fixture.benchmark.devices[0].packagedApp = false;
      writeJson(fixture.paths.benchmark, fixture.benchmark);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /full-candidate service benchmark/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a tampered selection winner or official comparison input", () => {
    withFixture("baseline", (fixture) => {
      const tampered = structuredClone(fixture.selection);
      tampered.winner = tampered.candidates.find((candidate) =>
        candidate.candidateId !== fixture.selection.winner.candidateId
      );
      writeJson(fixture.paths.selection, tampered);
      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof Error &&
          /winner|selectionId|ranking/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });

    withFixture("baseline", (fixture) => {
      write(fixture.paths.comparisonPredictions, `${JSON.stringify({
        id: "official-1",
        input: "nepal",
        candidates: ["नेपाळ"]
      })}\n`);
      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /changed after model selection/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects symbolic links in candidate artifacts", () => {
    withFixture("baseline", (fixture) => {
      const outside = join(fixture.root, "outside-model");
      write(join(outside, "weights.bin"), "outside");
      rmSync(fixture.paths.compiledModel, { recursive: true });
      symlinkSync(outside, fixture.paths.compiledModel);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof Error &&
          /symbolic-link|symbolic link/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects compute-plan preference without observed runtime placement", () => {
    withFixture("baseline", (fixture) => {
      delete fixture.benchmark.computePlacement.runtimePlacement;
      writeJson(fixture.paths.benchmark, fixture.benchmark);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /observed Neural Engine execution/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("restores the prior production directory after failures on either side of the swap", () => {
    withFixture("baseline", (fixture) => {
      write(join(fixture.paths.production, "previous.txt"), "previous-release");
      const previous = inspectContainedDirectoryTree(fixture.root, fixture.paths.production);

      assert.throws(
        () => promote(fixture, {
          hooks: {
            afterBackup() {
              throw new Error("injected after-backup failure");
            }
          }
        }),
        /Promotion failed safely/u
      );
      assert.equal(
        inspectContainedDirectoryTree(fixture.root, fixture.paths.production).sha256,
        previous.sha256
      );
      assert.deepEqual(promotionDebris(fixture), []);

      assert.throws(
        () => promote(fixture, {
          hooks: {
            afterPublish() {
              throw new Error("injected after-publish failure");
            }
          }
        }),
        /Promotion failed safely/u
      );
      assert.equal(
        inspectContainedDirectoryTree(fixture.root, fixture.paths.production).sha256,
        previous.sha256
      );
      assert.deepEqual(promotionDebris(fixture), []);
    });
  });

  it("publishes a split-attention candidate with exact role identities and canonical names", () => {
    withFixture("split", (fixture) => {
      const result = promote(fixture);
      assert.equal(result.artifactLayout, "split-attention");

      const manifest = readJson(result.manifest);
      const receipt = readJson(result.report);
      const verification = verifyNeuralProductionPromotionReceipt({
        repoRoot: fixture.root,
        productionDirectory: result.productionDir
      });
      assert.equal(verification.runtimeModelContract, "split-attention-incremental-v1");
      assert.deepEqual(
        verification.artifacts.map((artifact) => artifact.id),
        [
          "encoder.compiledModel",
          "encoder.mlpackage",
          "decoderStep.compiledModel",
          "decoderStep.mlpackage"
        ]
      );
      assert.equal(
        productionManifestValidator(manifest),
        true,
        JSON.stringify(productionManifestValidator.errors)
      );
      for (const [role, suffix] of [
        ["encoder", "Encoder"],
        ["decoderStep", "DecoderStep"]
      ]) {
        const compiledName = `LekhNeuralTransliterator${suffix}.mlmodelc`;
        const packageName = `LekhNeuralTransliterator${suffix}.mlpackage`;
        assert.equal(
          manifest.compiledModels[role].compiledModel,
          portable(fixture.root, join(result.productionDir, compiledName))
        );
        assert.equal(
          manifest.compiledModels[role].mlpackage,
          portable(fixture.root, join(result.productionDir, packageName))
        );
        assert.equal(
          inspectContainedDirectoryTree(
            fixture.root,
            join(result.productionDir, compiledName)
          ).sha256,
          fixture.identities.compiledModels[role].sha256
        );
        assert.equal(
          inspectContainedDirectoryTree(
            fixture.root,
            join(result.productionDir, packageName)
          ).sha256,
          fixture.identities.mlpackages[role].sha256
        );
      }
      assert.deepEqual(promotionDebris(fixture), []);
    });
  });

  it("publishes a closed Transformer-CTC candidate through the production receipt gate", () => {
    withFixture("ctc", (fixture) => {
      const result = promote(fixture);
      assert.equal(result.artifactLayout, "single-model");

      const manifest = readJson(result.manifest);
      const receipt = readJson(result.report);
      const verification = verifyNeuralProductionPromotionReceipt({
        repoRoot: fixture.root,
        productionDirectory: result.productionDir
      });
      assert.equal(
        verification.runtimeModelContract,
        "single-transformer-ctc-v1"
      );
      assert.deepEqual(
        verification.artifacts.map((artifact) => artifact.id),
        ["compiledModel", "mlpackage"]
      );
      assert.equal(
        productionManifestValidator(manifest),
        true,
        JSON.stringify(productionManifestValidator.errors)
      );
      assert.equal(
        manifest.selectedArtifact,
        "lekh-open-vocab-ctc-transformer-v2"
      );
      assert.equal(manifest.architecture, "fixed-shape-transformer-ctc");
      assert.equal(manifest.decoder, "ctc-prefix-beam-search");
      assert.equal(manifest.beamSearch.beamWidth, 8);
      assert.equal(manifest.beamSearch.maxSteps, 32);
      assert.deepEqual(manifest.tensorContract, ctcTensorContract());
      assert.equal(manifest.compiledModels, undefined);
      assert.equal(receipt.schemaVersion, 3);
      assert.equal(
        receipt.rareScalarEvidence.report.sha256,
        fixture.identities.rareScalarEvaluation.sha256
      );
      assert.deepEqual(manifest.evaluationReports, [
        portable(fixture.root, fixture.paths.evaluation)
      ]);
      assert.equal(
        inspectContainedDirectoryTree(
          fixture.root,
          join(result.productionDir, "LekhNeuralTransliterator.mlmodelc")
        ).sha256,
        fixture.identities.compiledModel.sha256
      );

      const phase9Report = join(fixture.root, "reports", "phase9-ctc.json");
      const phase9 = spawnSync(
        process.execPath,
        [
          phase9Checker,
          "--production",
          "--report",
          phase9Report
        ],
        {
          cwd: fixture.root,
          encoding: "utf8"
        }
      );
      assert.equal(phase9.status, 0, phase9.stderr || phase9.stdout);
      assert.equal(
        readJson(phase9Report).status,
        "passed-production-phase9-promotion"
      );
      assert.deepEqual(promotionDebris(fixture), []);
    });
  });

  it("rejects a Transformer-CTC candidate without exact rare-scalar evidence", () => {
    withFixture("ctc", (fixture) => {
      assert.throws(
        () => promote(fixture, { rareScalarReport: undefined }),
        /requires a passed rare-scalar evaluation report/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a Transformer-CTC export without finite-path decoder evidence", () => {
    withFixture("ctc", (fixture) => {
      const report = readJson(fixture.paths.exportReport);
      delete report.coremlExport.finitePathDecoderPolicy;
      writeJson(fixture.paths.exportReport, report);

      assert.throws(
        () => promote(fixture),
        /lacks the exact finite-path decoder policy/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a Transformer-CTC export without representative parity", () => {
    withFixture("ctc", (fixture) => {
      const report = readJson(fixture.paths.exportReport);
      delete report.coremlExport.representativeParityPolicy;
      writeJson(fixture.paths.exportReport, report);

      assert.throws(
        () => promote(fixture),
        /lacks representative compiled Core ML parity evidence/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a Transformer-CTC rare-scalar report with a spurious top-1 emission", () => {
    withFixture("ctc", (fixture) => {
      const report = readJson(fixture.paths.rareScalarEvaluation);
      report.evaluation.spuriousNonExemplarTop1.push({
        scalar: "ॠ",
        evaluation: "official-benchmark",
        id: "official-1",
        top1: "ॠनेपाल"
      });
      writeJson(fixture.paths.rareScalarEvaluation, report);
      assert.throws(
        () => promote(fixture),
        /rare-scalar production evidence did not pass/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a forged rare-scalar pass that differs from recomputation", () => {
    withFixture("ctc", (fixture) => {
      const report = readJson(fixture.paths.rareScalarEvaluation);
      report.evaluation.byScalar["ऑ"].top1ExactRows += 1;
      writeJson(fixture.paths.rareScalarEvaluation, report);
      assert.throws(
        () => promote(fixture),
        /does not match independent recomputation/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a rehashed retained rare-scalar semantic forgery", () => {
    withFixture("ctc", (fixture) => {
      const result = promote(fixture);
      const rareReport = readJson(fixture.paths.rareScalarEvaluation);
      rareReport.evaluation.byScalar["ऑ"].top1ExactRows += 1;
      writeJson(fixture.paths.rareScalarEvaluation, rareReport);

      const rareEvidence = inspectContainedRegularFile(
        fixture.root,
        fixture.paths.rareScalarEvaluation
      );
      const receipt = readJson(result.report);
      receipt.rareScalarEvidence.report.bytes = rareEvidence.bytes;
      receipt.rareScalarEvidence.report.sha256 = rareEvidence.sha256;
      receipt.promotionId =
        computeNeuralProductionPromotionId(receipt);
      writeJson(result.report, receipt);

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /Retained rare-scalar evaluation does not match independent recomputation/u
      );
    });
  });

  it("rejects a rehashed production manifest whose metrics no longer come from retained evaluation evidence", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const manifest = readJson(result.manifest);
      manifest.metrics.tailTop1Accuracy = 0.9;
      writeJson(result.manifest, manifest);

      const manifestEvidence = inspectContainedRegularFile(
        fixture.root,
        result.manifest
      );
      const receipt = readJson(result.report);
      receipt.productionManifest.sha256 = manifestEvidence.sha256;
      receipt.productionManifest.bytes = manifestEvidence.bytes;
      writeJson(result.report, receipt);

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /exact deterministic promotion/u
      );
    });
  });
});

function withFixture(kind, callback) {
  const parent = mkdtempSync(join(tmpdir(), "lekh-neural-promotion-"));
  const rootAlias = join(parent, "repo");
  mkdirSync(join(rootAlias, "data", "generated", "candidate"), { recursive: true });
  const root = realpathSync(rootAlias);
  mkdirSync(join(root, "data", "neural", "gold"), { recursive: true });
  mkdirSync(join(root, "data", "neural", "schema"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
  mkdirSync(join(root, "models", "macos"), { recursive: true });
  copyFileSync(
    join(sourceRoot, "data/neural/schema/lekh-neural-manifest.schema.json"),
    join(root, "data/neural/schema/lekh-neural-manifest.schema.json")
  );
  try {
    callback(buildFixture(root, kind));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function buildFixture(root, kind) {
  const candidate = join(root, "data", "generated", "candidate");
  const paths = {
    candidate,
    manifest: join(candidate, "LekhNeuralTransliterator.manifest.json"),
    exportReport: join(candidate, "export-report.json"),
    vocabulary: join(candidate, "LekhNeuralTransliterator.vocab.json"),
    checkpoint: join(candidate, "checkpoint.pt"),
    predictions: join(candidate, "gold-predictions.jsonl"),
    rareScalarPredictions: join(candidate, "rare-scalar-predictions.jsonl"),
    rareScalarGeneration: join(
      candidate,
      "rare-scalar-prediction-report.json"
    ),
    rareScalarEvaluation: join(candidate, "rare-scalar-evaluation.json"),
    rareScalarContract: join(
      root,
      "data",
      "neural",
      "eval",
      "ctc-rare-output-scalar-probes-v1.json"
    ),
    rareScalarAudit: join(
      root,
      "data",
      "neural",
      "audits",
      "ctc-transformer-v2-alignment-v1.json"
    ),
    evaluation: join(root, "reports", "evaluation.json"),
    benchmark: join(root, "reports", "benchmark.json"),
    candidateSpecification: join(root, "reports", "candidate-specification.json"),
    comparison: join(root, "reports", "official-comparison.json"),
    comparisonPredictions: join(candidate, "official-benchmark-predictions.jsonl"),
    comparisonBenchmarkManifest: join(
      root,
      "data",
      "neural",
      "benchmarks",
      "aksharantar-nepali-test-v1",
      "manifest.json"
    ),
    selection: join(root, "reports", "model-selection.json"),
    goldManifest: join(root, "data", "neural", "gold", "manifest.json"),
    goldSuite: join(root, "data", "neural", "gold", "suite.jsonl"),
    datasetManifest: join(root, "data", "generated", "neural-open-vocab", "manifest.json"),
    production: join(root, "models", "macos", "LekhNeuralTransliterator.production")
  };
  write(paths.vocabulary, JSON.stringify({
    schemaVersion: 1,
    modelId: kind === "split" ? "attention" : "baseline",
    tokenization: "unicode-scalar-character"
  }));
  write(paths.checkpoint, "safe-tensor-checkpoint");
  write(paths.predictions, `${JSON.stringify({
    id: "gold-1",
    input: "nepal",
    candidates: ["नेपाल"]
  })}\n`);
  write(paths.goldSuite, `${JSON.stringify({
    id: "gold-1",
    input: "nepal",
    split: "test",
    expectedAction: "produce-candidate",
    acceptable: ["नेपाल"]
  })}\n`);

  const goldSuiteEvidence = inspectContainedRegularFile(root, paths.goldSuite, {
    includeContents: true
  });
  const goldSuite = {
    id: "gold-suite",
    path: portable(root, paths.goldSuite),
    sha256: goldSuiteEvidence.sha256,
    rows: 1
  };
  const goldManifest = {
    schemaVersion: 2,
    corpusSha256: goldCorpusSha256([goldSuite]),
    suites: [goldSuite]
  };
  writeJson(paths.goldManifest, goldManifest);
  const datasetManifest = {
    schemaVersion: 2,
    datasetId: "fixture-neural-dataset",
    datasetContentSha256: "c".repeat(64),
    sha256: {
      train: "4".repeat(64),
      dev: "5".repeat(64),
      test: "9".repeat(64)
    },
    totalRows: 1
  };
  writeJson(paths.datasetManifest, datasetManifest);

  const identities = {
    vocabulary: inspectContainedRegularFile(root, paths.vocabulary),
    checkpoint: inspectContainedRegularFile(root, paths.checkpoint),
    predictions: inspectContainedRegularFile(root, paths.predictions),
    goldManifest: inspectContainedRegularFile(root, paths.goldManifest),
    datasetManifest: inspectContainedRegularFile(root, paths.datasetManifest)
  };
  const artifactFixture = kind === "split"
    ? buildSplitArtifacts(root, candidate)
    : kind === "ctc"
      ? buildCTCArtifacts(root, candidate, identities.checkpoint.sha256)
      : buildBaselineArtifacts(root, candidate);
  Object.assign(paths, artifactFixture.paths);
  Object.assign(identities, artifactFixture.identities);

  const candidateMetrics = {
    tailTop1Accuracy: -1,
    tailTop3Accuracy: -1,
    chatConventionTop1Accuracy: -1,
    chatConventionTop3Accuracy: -1,
    namesTop3Accuracy: -1,
    protectedFalseConversionRate: -1,
    singleTokenPhraseExpansionRate: -1,
    secureFieldInferenceCount: -1
  };
  const manifest = {
    schemaVersion: 2,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    selectedArtifact: kind === "split"
      ? "lekh-open-vocab-bigru-attention-v1"
      : kind === "ctc"
        ? "lekh-open-vocab-ctc-transformer-v2"
        : "lekh-open-vocab-seq2seq-v1",
    runtime: "CoreML",
    localOnly: true,
    neuralTailOnly: true,
    productionEligible: false,
    architecture: kind === "split"
      ? "bidirectional-gru-additive-attention-seq2seq"
      : kind === "ctc"
        ? "fixed-shape-transformer-ctc"
        : "gru-encoder-decoder-seq2seq",
    openVocabulary: true,
    tokenization: "unicode-scalar-character",
    outputSequenceValidation: "devanagari-word-sequence-v1",
    decoder: kind === "ctc"
      ? "ctc-prefix-beam-search"
      : "beam-search",
    beamSearch: {
      enabled: true,
      beamWidth: kind === "ctc" ? 8 : 4,
      maxOutputGraphemes: 32,
      maxSteps: kind === "ctc" ? 32 : 31
    },
    languageModelRescorer: { enabled: false, source: "none", weight: 0 },
    contextWindowWords: 0,
    parameterCount: 1_500_000,
    modelBytes: artifactFixture.modelBytes,
    trainingSources: ["ai4bharat-aksharantar-nepali"],
    datasetReports: ["reports/dataset.json"],
    evaluationReports: ["reports/candidate-evaluation.json"],
    benchmarkReports: ["reports/candidate-benchmark.json"],
    metrics: candidateMetrics,
    performance: {
      p50Ms: 999,
      p95Ms: 999,
      p99Ms: 999,
      targetP99Ms: 50,
      measuredOnDevice: false,
      devices: []
    },
    requiredCases: {
      vato: "बाटो",
      bato: "बाटो",
      baato: "बाटो",
      chha: "छ",
      cha: "छ",
      xa: "छ",
      xaina: "छैन"
    },
    sha256: {
      sourceCheckpoint: identities.checkpoint.sha256,
      trainingDatasetManifest: identities.datasetManifest.sha256,
      vocabMetadata: identities.vocabulary.sha256,
      ...artifactFixture.manifestSha256
    },
    limitations: ["Candidate remains experimental until this evidence-bound promotion."]
  };
  if (kind === "split") {
    manifest.runtimeModelContract = "split-attention-incremental-v1";
    manifest.tensorContract = splitTensorContract();
    manifest.compiledModels = artifactFixture.manifestArtifacts;
  } else if (kind === "ctc") {
    manifest.runtimeModelContract = "single-transformer-ctc-v1";
    manifest.tensorContract = ctcTensorContract();
  }
  writeJson(paths.manifest, manifest);
  identities.manifest = inspectContainedRegularFile(root, paths.manifest);
  const artifactDescriptor = resolveNeuralArtifactDescriptor({
    repoRoot: root,
    manifest,
    manifestPath: paths.manifest,
    vocabPath: paths.vocabulary
  });
  const splitSha256 = {
    train: "4".repeat(64),
    dev: "5".repeat(64)
  };
  const trainingIsolation = {
    policy: "official-benchmark-inputs-absent-from-train-and-dev-v1",
    benchmarkInputSha256: "6".repeat(64),
    comparedSplitSha256: splitSha256,
    overlappingInputCount: 0
  };
  const predictionArtifactIdentity = {
    runtimeModelContract: artifactDescriptor.runtimeModelContract,
    compiledArtifacts: Object.fromEntries(
      artifactDescriptor.artifacts.map((artifact) => [
        artifact.role,
        {
          path: portable(root, artifact.sourcePath),
          sha256: artifact.compiledSha256,
          bytes: artifact.compiledBytes
        }
      ])
    )
  };

  const exportReport = {
    status: kind === "split"
      ? "passed-open-vocab-attention-split-candidate"
      : kind === "ctc"
        ? "passed-open-vocab-ctc-transformer-candidate"
        : "passed-open-vocab-seq2seq-candidate",
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    productionEligible: false,
    artifactOverrides: {},
    runtimeArtifactContractIssues: [],
    checkpoint: portable(root, paths.checkpoint),
    checkpointSha256: identities.checkpoint.sha256,
    manifest: portable(root, paths.manifest),
    manifestSha256: identities.manifest.sha256,
    predictions: portable(root, paths.predictions),
    predictionsSha256: identities.predictions.sha256,
    goldManifest: portable(root, paths.goldManifest),
    goldManifestSha256: identities.goldManifest.sha256,
    goldCorpusSha256: goldManifest.corpusSha256,
    goldSuites: [goldSuite],
    goldRows: 1,
    runInputSnapshot: {
      schemaVersion: 1,
      dataset: {
        manifest: portable(root, paths.datasetManifest),
        manifestSha256: identities.datasetManifest.sha256,
        contentSha256: datasetManifest.datasetContentSha256,
        splits: {
          train: { sha256: splitSha256.train },
          dev: { sha256: splitSha256.dev }
        }
      },
      officialBenchmark: {
        trainingIsolation
      }
    },
    comparisonBenchmark: {
      trainingIsolation
    },
    ...artifactFixture.exportFields
  };
  writeJson(paths.exportReport, exportReport);

  const evaluation = {
    status: "passed-production-phase5-evaluation",
    production: true,
    productionEligible: true,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    predictions: portable(root, paths.predictions),
    predictionsSha256: identities.predictions.sha256,
    goldManifest: portable(root, paths.goldManifest),
    goldManifestSha256: identities.goldManifest.sha256,
    goldCorpusSha256: goldManifest.corpusSha256,
    goldRows: 1,
    datasetManifest: portable(root, paths.datasetManifest),
    datasetManifestSha256: identities.datasetManifest.sha256,
    datasetContentSha256: datasetManifest.datasetContentSha256,
    predictionValidation: {
      exactCoverage: true,
      metricsReportable: true,
      issueCodes: []
    },
    metrics: {
      tailTop1Accuracy: 0.91,
      tailTop3Accuracy: 0.98,
      chatConventionTop1Accuracy: 0.95,
      chatConventionTop3Accuracy: 0.99,
      namesTop3Accuracy: 0.94,
      protectedFalseConversionRate: 0,
      singleTokenPhraseExpansionRate: 0,
      secureFieldInferenceCount: 0
    },
    failures: []
  };
  writeJson(paths.evaluation, evaluation);
  identities.evaluation = inspectContainedRegularFile(root, paths.evaluation);

  const devices = [{
    name: "fixture-mac",
    macOS: "26.0",
    architecture: "arm64",
    packagedApp: true,
    secureFieldInferenceCount: 0,
    p50Ms: 10,
    p95Ms: 20,
    p99Ms: 25,
    artifact: "/Applications/Lekh Keyboard.app",
    measurementKind: "full-candidate-generation",
    artifactSetSha256: artifactDescriptor.artifactSetSha256,
    configurationComputeUnits: "all",
    computePlans: Object.fromEntries(
      artifactDescriptor.artifacts.map((artifact) => [
        artifact.role,
        computePlanEvidence(artifact)
      ])
    )
  }];
  const benchmark = {
    status: "passed-candidate-promotion-evidence",
    proofMode: "candidate-promotion",
    singleForwardBenchmarkIsConsumerLatency: false,
    artifactIdentity: {
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
      manifestSha256: identities.manifest.sha256,
      vocabSha256: identities.vocabulary.sha256,
      artifactSetSha256: artifactDescriptor.artifactSetSha256,
      ...artifactFixture.benchmarkIdentity
    },
    devices: structuredClone(devices),
    performance: {
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 25
    },
    computePlacement: {
      architectures: ["arm64"],
      neuralEngineCompatibilityIndicated: true,
      neuralEngineRuntimeObserved: true,
      neuralEngineClaimAllowed: true,
      runtimePlacement: runtimePlacementEvidence(artifactDescriptor)
    },
    failures: []
  };
  writeJson(paths.benchmark, benchmark);
  identities.benchmark = inspectContainedRegularFile(root, paths.benchmark);

  mkdirSync(dirname(paths.comparisonBenchmarkManifest), { recursive: true });
  copyFileSync(
    join(
      sourceRoot,
      "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
    ),
    paths.comparisonBenchmarkManifest
  );
  const officialRows = kind === "ctc"
    ? materializeOfficialBenchmarkRows(root)
    : [{
        id: "official-1",
        input: "nepal",
        acceptable: ["नेपाल"]
      }];
  const officialPredictionRows = officialRows.map((row) => ({
    id: row.id,
    input: row.input,
    candidates: [firstAcceptedTarget(row)]
  }));
  write(
    paths.comparisonPredictions,
    officialPredictionRows
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
  identities.comparisonPredictions = inspectContainedRegularFile(
    root,
    paths.comparisonPredictions
  );
  identities.comparisonBenchmarkManifest = inspectContainedRegularFile(
    root,
    paths.comparisonBenchmarkManifest
  );
  exportReport.comparisonBenchmark = {
    manifest: portable(root, paths.comparisonBenchmarkManifest),
    manifestSha256: identities.comparisonBenchmarkManifest.sha256,
    corpusSha256: OFFICIAL_BENCHMARK_CORPUS_SHA256,
    rows: officialRows.length,
    trainingIsolation,
    predictions: portable(root, paths.comparisonPredictions),
    predictionsSha256: identities.comparisonPredictions.sha256,
    predictionsBackend: kind === "split"
      ? "coreml-compiled-split-attention-models"
      : kind === "ctc"
        ? "coreml-compiled-transformer-ctc"
        : "coreml-compiled-model",
    predictionArtifactIdentity
  };
  writeJson(paths.exportReport, exportReport);
  identities.exportReport = inspectContainedRegularFile(
    root,
    paths.exportReport
  );
  const comparison = {
    schemaVersion: 1,
    status: "passed-official-benchmark-evaluation",
    suite: "neural-official-benchmark-evaluation",
    productionEligible: true,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    candidateManifestSha256: identities.manifest.sha256,
    artifactIdentity: {
      manifestSha256: identities.manifest.sha256,
      vocabSha256: identities.vocabulary.sha256,
      artifactSetSha256: artifactDescriptor.artifactSetSha256
    },
    benchmarkManifest:
      "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
    benchmarkManifestSha256: OFFICIAL_BENCHMARK_MANIFEST_SHA256,
    benchmarkCorpusSha256: OFFICIAL_BENCHMARK_CORPUS_SHA256,
    benchmarkIsolation: trainingIsolation,
    predictions: portable(root, paths.comparisonPredictions),
    predictionsSha256: identities.comparisonPredictions.sha256,
    predictionsBackend: kind === "split"
      ? "coreml-compiled-split-attention-models"
      : kind === "ctc"
        ? "coreml-compiled-transformer-ctc"
        : "coreml-compiled-model",
    predictionArtifactIdentity,
    predictionRows: officialRows.length,
    distinctInputCount: new Set(
      officialRows.map((row) => row.input)
    ).size,
    reference: {
      manifest: "data/neural/benchmarks/indicxlit-v1/manifest.json",
      manifestSha256: REFERENCE_MANIFEST_SHA256
    },
    qualityGate: { passed: true },
    failures: []
  };
  writeJson(paths.comparison, comparison);
  identities.comparison = inspectContainedRegularFile(root, paths.comparison);
  const rareScalar = kind === "ctc"
    ? buildRareScalarEvidenceFixture({
        root,
        paths,
        identities,
        manifest,
        datasetManifest,
        goldManifest,
        artifactDescriptor,
        officialRows
      })
    : null;
  const candidateSpecification = {
    schemaVersion: 1,
    label: kind,
    candidateRoot: portable(root, candidate),
    evaluationReport: portable(root, paths.evaluation),
    benchmarkReport: portable(root, paths.benchmark),
    comparisonReport: portable(root, paths.comparison)
  };
  writeJson(paths.candidateSpecification, candidateSpecification);
  identities.candidateSpecification = inspectContainedRegularFile(
    root,
    paths.candidateSpecification
  );
  const winningCandidate = {
    candidateId: `${kind}:${EXPORT_RUN_ID}`,
    candidateRoot: portable(root, candidate),
    modelId: manifest.selectedArtifact,
    architecture: manifest.architecture,
    eligible: true,
    identity: {
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
      manifestSha256: identities.manifest.sha256,
      exportReportSha256: inspectContainedRegularFile(
        root,
        paths.exportReport
      ).sha256,
      vocabSha256: identities.vocabulary.sha256,
      artifactSetSha256: artifactDescriptor.artifactSetSha256
    },
    evidence: {
      specification: evidence(root, identities.candidateSpecification),
      manifest: evidence(root, identities.manifest),
      exportReport: evidence(
        root,
        inspectContainedRegularFile(root, paths.exportReport)
      ),
      evaluationReport: evidence(root, identities.evaluation),
      datasetManifest: evidence(root, identities.datasetManifest),
      goldManifest: evidence(root, identities.goldManifest),
      benchmarkReport: evidence(root, identities.benchmark),
      comparisonReport: evidence(root, identities.comparison),
      benchmarkManifest: evidence(
        root,
        identities.comparisonBenchmarkManifest
      ),
      comparisonPredictions: evidence(root, identities.comparisonPredictions)
    },
    bindings: {
      datasetManifestSha256: identities.datasetManifest.sha256,
      datasetContentSha256: datasetManifest.datasetContentSha256,
      goldManifestSha256: identities.goldManifest.sha256,
      goldCorpusSha256: goldManifest.corpusSha256,
      benchmarkManifestSha256:
        identities.comparisonBenchmarkManifest.sha256,
      benchmarkCorpusSha256: comparison.benchmarkCorpusSha256
    },
    metrics: {
      officialOverallTop1Accuracy: 0.75,
      officialOverallTop3Accuracy: 0.9,
      officialNativeTop1Accuracy: 0.8,
      officialNameTop1Accuracy: 0.65,
      goldTailTop1Accuracy: evaluation.metrics.tailTop1Accuracy,
      goldTailTop3Accuracy: evaluation.metrics.tailTop3Accuracy,
      latencyP99Ms: benchmark.performance.p99Ms,
      compiledBytes: artifactDescriptor.totalCompiledBytes
    }
  };
  const losingCandidate = structuredClone(winningCandidate);
  losingCandidate.candidateId = `loser:${"b".repeat(32)}`;
  losingCandidate.candidateRoot = "data/generated/losing-candidate";
  losingCandidate.modelId = "losing-fixture";
  losingCandidate.architecture = "fixture";
  losingCandidate.identity.trainingRunId = "a".repeat(32);
  losingCandidate.identity.exportRunId = "b".repeat(32);
  losingCandidate.identity.manifestSha256 = "c".repeat(64);
  losingCandidate.identity.exportReportSha256 = "d".repeat(64);
  losingCandidate.identity.vocabSha256 = "e".repeat(64);
  losingCandidate.identity.artifactSetSha256 = "f".repeat(64);
  losingCandidate.evidence.manifest.sha256 =
    losingCandidate.identity.manifestSha256;
  losingCandidate.evidence.exportReport.sha256 =
    losingCandidate.identity.exportReportSha256;
  losingCandidate.metrics.officialOverallTop1Accuracy = 0.5;
  const selection = buildNeuralSelectionReport({
    candidates: [winningCandidate, losingCandidate],
    generatedAt: FIXED_TIME
  });
  writeJson(paths.selection, selection);
  identities.selection = inspectContainedRegularFile(root, paths.selection);

  return {
    root,
    kind,
    paths,
    identities,
    manifest,
    exportReport,
    evaluation,
    benchmark,
    comparison,
    rareScalar,
    selection,
    goldManifest,
    datasetManifest,
    artifactDescriptor
  };
}

function buildRareScalarEvidenceFixture({
  root,
  paths,
  identities,
  manifest,
  datasetManifest,
  goldManifest,
  artifactDescriptor,
  officialRows
}) {
  const scalarRows = [
    ["ऑ", "U+0911", true, "probe-o", "orbit", "ऑर्बिट"],
    ["ऱ", "U+0931", false, "probe-rra", "rraa", "ऱ"],
    ["ळ", "U+0933", true, "probe-lla", "llaa", "ळ"],
    ["ॠ", "U+0960", false, "probe-rr", "rrig", "ॠ"]
  ];
  const sparseOutputScalarProbes = scalarRows.map(
    ([scalar, codePoint, , id, input, target], index) => ({
      scalar,
      codePoint,
      trainOccurrences: 1,
      probes: [{
        id,
        split: "train",
        input,
        target,
        acceptable: [target],
        rowHash: String(index + 1).repeat(64),
        sourceIds: ["fixture-source"],
        reviewTier: "silver-fixture"
      }]
    })
  );
  const ctcAudit = {
    trainingVocabulary: {
      output: {
        tokens: sparseOutputScalarProbes.map(
          ({ scalar, codePoint, trainOccurrences }) => ({
            token: scalar,
            codePoint,
            count: trainOccurrences
          })
        )
      }
    },
    sparseOutputScalarProbes: structuredClone(sparseOutputScalarProbes)
  };
  writeJson(paths.rareScalarAudit, ctcAudit);
  identities.rareScalarAudit = inspectContainedRegularFile(
    root,
    paths.rareScalarAudit
  );
  const contract = {
    schemaVersion: 1,
    contentIdentity: "lekh-neural-ctc-rare-output-scalar-probes-v1",
    status: "frozen-dataset-derived-diagnostic",
    dataset: {
      id: datasetManifest.datasetId,
      manifest: portable(root, paths.datasetManifest),
      manifestSha256: identities.datasetManifest.sha256,
      contentSha256: datasetManifest.datasetContentSha256,
      splitSha256: structuredClone(datasetManifest.sha256)
    },
    ctcAudit: {
      path: portable(root, paths.rareScalarAudit),
      sha256: identities.rareScalarAudit.sha256
    },
    policy: {
      maximumTrainOccurrences: 5,
      exactProbeMatches:
        "diagnostic-only-silver-derived-no-accuracy-claim",
      nonExemplarSilverScalars:
        "require-zero-unaccepted-top1-emissions-on-locked-gold-and-official-benchmark"
    },
    scalars: scalarRows.map(
      ([
        scalar,
        codePoint,
        cldrNepaliMainExemplar
      ], index) => ({
        scalar,
        codePoint,
        trainOccurrences: 1,
        cldrNepaliMainExemplar,
        treatment: cldrNepaliMainExemplar
          ? "supported-sparse-diagnostic"
          : "non-exemplar-silver-data-risk",
        probes: structuredClone(sparseOutputScalarProbes[index].probes)
      })
    )
  };
  writeJson(paths.rareScalarContract, contract);
  identities.rareScalarContract = inspectContainedRegularFile(
    root,
    paths.rareScalarContract
  );

  const predictionRows = scalarRows.map(
    ([, , , id, input, target]) => ({
      id,
      input,
      candidates: [target]
    })
  );
  write(
    paths.rareScalarPredictions,
    predictionRows.map((row) => JSON.stringify(row)).join("\n") + "\n"
  );
  identities.rareScalarPredictions = inspectContainedRegularFile(
    root,
    paths.rareScalarPredictions
  );
  const compiled = artifactDescriptor.artifacts[0];
  const generation = {
    schemaVersion: 1,
    status: "passed-neural-rare-scalar-prediction-generation",
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    productionEligible: false,
    predictionsBackend: "coreml-compiled-transformer-ctc",
    finitePathDecoderPolicy:
      structuredClone(CTC_FINITE_PATH_DECODER_POLICY),
    contract: {
      path: portable(root, paths.rareScalarContract),
      sha256: identities.rareScalarContract.sha256,
      datasetManifestSha256: identities.datasetManifest.sha256,
      datasetContentSha256: datasetManifest.datasetContentSha256,
      ctcAuditSha256: identities.rareScalarAudit.sha256
    },
    candidate: {
      exportReport: portable(root, paths.exportReport),
      exportReportSha256: identities.exportReport.sha256,
      manifest: portable(root, paths.manifest),
      manifestSha256: identities.manifest.sha256,
      checkpoint: portable(root, paths.checkpoint),
      checkpointSha256: identities.checkpoint.sha256,
      vocabulary: portable(root, paths.vocabulary),
      vocabularySha256: identities.vocabulary.sha256,
      mlpackage: portable(root, paths.mlpackage),
      mlpackageSha256: identities.mlpackage.sha256,
      compiledModel: portable(root, paths.compiledModel),
      compiledModelSha256: identities.compiledModel.sha256
    },
    coremlValidation: {
      status: "passed",
      runtimeModelContract: "single-transformer-ctc-v1",
      mlpackageSha256: identities.mlpackage.sha256,
      compiledModelSha256: identities.compiledModel.sha256,
      tensorContract: ctcTensorContract(),
      knownAnswerInputSha256: "a".repeat(64),
      maximumAbsoluteLogitError: 0,
      relativeTolerance: 0.005,
      absoluteTolerance: 0.005
    },
    predictions: {
      path: portable(root, paths.rareScalarPredictions),
      sha256: identities.rareScalarPredictions.sha256,
      rows: predictionRows.length
    }
  };
  writeJson(paths.rareScalarGeneration, generation);
  identities.rareScalarGeneration = inspectContainedRegularFile(
    root,
    paths.rareScalarGeneration
  );

  const rareEvaluation = evaluateNeuralRareScalarEvidence({
    contract,
    probePredictions: predictionRows,
    lockedEvaluations: [
      {
        label: "gold",
        rows: readJsonLines(paths.goldSuite),
        predictions: readJsonLines(paths.predictions)
      },
      {
        label: "official-benchmark",
        rows: officialRows,
        predictions: readJsonLines(paths.comparisonPredictions)
      }
    ]
  });
  assert.equal(rareEvaluation.productionGatePassed, true);
  const report = {
    schemaVersion: 1,
    status: "passed-neural-rare-scalar-production-gate",
    productionEligible: true,
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    candidateRoot: portable(root, paths.candidate),
    exportReport: fileEvidence(root, identities.exportReport),
    contract: fileEvidence(root, identities.rareScalarContract),
    ctcAudit: fileEvidence(root, identities.rareScalarAudit),
    datasetManifest: {
      ...fileEvidence(root, identities.datasetManifest),
      contentSha256: datasetManifest.datasetContentSha256
    },
    generationReport: fileEvidence(root, identities.rareScalarGeneration),
    probePredictions: {
      ...fileEvidence(root, identities.rareScalarPredictions),
      rows: predictionRows.length
    },
    gold: {
      manifest: fileEvidence(root, identities.goldManifest),
      corpusSha256: goldManifest.corpusSha256,
      predictions: fileEvidence(root, identities.predictions),
      rows: 1
    },
    officialBenchmark: {
      manifest: fileEvidence(
        root,
        identities.comparisonBenchmarkManifest
      ),
      corpusSha256: OFFICIAL_BENCHMARK_CORPUS_SHA256,
      predictions: fileEvidence(root, identities.comparisonPredictions),
      rows: officialRows.length
    },
    artifactIdentity: {
      manifestSha256: identities.manifest.sha256,
      vocabSha256: identities.vocabulary.sha256,
      artifactSetSha256: artifactDescriptor.artifactSetSha256,
      compiledModelSha256: compiled.compiledSha256,
      mlpackageSha256: identities.mlpackage.sha256,
      checkpointSha256: identities.checkpoint.sha256
    },
    evaluation: structuredClone(rareEvaluation),
    failures: [],
    warnings: [...rareEvaluation.warnings]
  };
  writeJson(paths.rareScalarEvaluation, report);
  identities.rareScalarEvaluation = inspectContainedRegularFile(
    root,
    paths.rareScalarEvaluation
  );
  return { contract, ctcAudit, generation, report };
}

function buildBaselineArtifacts(root, candidate) {
  const compiledModel = join(candidate, "LekhNeuralTransliterator.mlmodelc");
  const mlpackage = join(candidate, "LekhNeuralTransliterator.mlpackage");
  write(join(compiledModel, "model.bin"), "compiled-baseline");
  write(join(mlpackage, "Data", "model.bin"), "package-baseline");
  const compiledEvidence = inspectContainedDirectoryTree(root, compiledModel);
  const packageEvidence = inspectContainedDirectoryTree(root, mlpackage);
  return {
    paths: { compiledModel, mlpackage },
    identities: {
      compiledModel: compiledEvidence,
      mlpackage: packageEvidence
    },
    modelBytes: compiledEvidence.bytes,
    manifestSha256: {
      compiledModel: compiledEvidence.sha256
    },
    exportFields: {
      compiledModel: portable(root, compiledModel),
      compiledModelSha256: compiledEvidence.sha256,
      mlpackage: portable(root, mlpackage),
      mlpackageSha256: packageEvidence.sha256,
      coremlExport: {
        status: "passed",
        compiledModel: portable(root, compiledModel),
        compiledSha256: compiledEvidence.sha256,
        mlpackage: portable(root, mlpackage),
        mlpackageSha256: packageEvidence.sha256
      }
    },
    benchmarkIdentity: {
      compiledModelSha256: compiledEvidence.sha256
    }
  };
}

function buildCTCArtifacts(root, candidate, checkpointSha256) {
  const artifact = buildBaselineArtifacts(root, candidate);
  return {
    ...artifact,
    exportFields: {
      ...artifact.exportFields,
      runtimeModelContract: "single-transformer-ctc-v1",
      coremlExport: {
        ...artifact.exportFields.coremlExport,
        runtimeModelContract: "single-transformer-ctc-v1",
        finitePathDecoderPolicy:
          structuredClone(CTC_FINITE_PATH_DECODER_POLICY),
        sourceCheckpointSha256: checkpointSha256,
        ...ctcCoreMLParityEvidence()
      }
    }
  };
}

function buildSplitArtifacts(root, candidate) {
  const roles = {};
  const compiledModels = {};
  const mlpackages = {};
  const manifestArtifacts = {};
  let modelBytes = 0;
  for (const role of ["encoder", "decoderStep"]) {
    const suffix = role === "encoder" ? "Encoder" : "DecoderStep";
    const compiledModel = join(
      candidate,
      `LekhNeuralTransliterator${suffix}.mlmodelc`
    );
    const mlpackage = join(
      candidate,
      `LekhNeuralTransliterator${suffix}.mlpackage`
    );
    write(join(compiledModel, "model.bin"), `compiled-${role}`);
    write(join(mlpackage, "Data", "model.bin"), `package-${role}`);
    const compiledEvidence = inspectContainedDirectoryTree(root, compiledModel);
    const packageEvidence = inspectContainedDirectoryTree(root, mlpackage);
    modelBytes += compiledEvidence.bytes;
    roles[role] = {
      role,
      compiledModel: portable(root, compiledModel),
      compiledBytes: compiledEvidence.bytes,
      compiledSha256: compiledEvidence.sha256,
      mlpackage: portable(root, mlpackage),
      mlpackageBytes: packageEvidence.bytes,
      mlpackageSha256: packageEvidence.sha256
    };
    compiledModels[role] = compiledEvidence;
    mlpackages[role] = packageEvidence;
    manifestArtifacts[role] = structuredClone(roles[role]);
  }
  return {
    paths: {
      encoderCompiled: join(candidate, "LekhNeuralTransliteratorEncoder.mlmodelc"),
      encoderPackage: join(candidate, "LekhNeuralTransliteratorEncoder.mlpackage"),
      decoderCompiled: join(candidate, "LekhNeuralTransliteratorDecoderStep.mlmodelc"),
      decoderPackage: join(candidate, "LekhNeuralTransliteratorDecoderStep.mlpackage")
    },
    identities: { compiledModels, mlpackages },
    modelBytes,
    manifestSha256: {
      compiledModels: Object.fromEntries(
        Object.entries(compiledModels).map(([role, evidence]) => [role, evidence.sha256])
      ),
      mlpackages: Object.fromEntries(
        Object.entries(mlpackages).map(([role, evidence]) => [role, evidence.sha256])
      )
    },
    manifestArtifacts,
    exportFields: {
      runtimeModelContract: "split-attention-incremental-v1",
      compiledModels: structuredClone(roles),
      coremlExport: {
        status: "passed",
        runtimeModelContract: "split-attention-incremental-v1",
        artifacts: structuredClone(roles)
      }
    },
    benchmarkIdentity: {
      compiledModels: Object.fromEntries(
        Object.entries(compiledModels).map(([role, evidence]) => [role, evidence.sha256])
      )
    }
  };
}

function promote(fixture, overrides = {}) {
  return promoteNeuralCandidate({
    repoRoot: fixture.root,
    candidateRoot: fixture.paths.candidate,
    candidateManifest: fixture.paths.manifest,
    exportReport: fixture.paths.exportReport,
    evaluationReport: fixture.paths.evaluation,
    rareScalarReport: fixture.kind === "ctc"
      ? fixture.paths.rareScalarEvaluation
      : undefined,
    benchmarkReport: fixture.paths.benchmark,
    selectionReport: fixture.paths.selection,
    vocabulary: fixture.paths.vocabulary,
    productionDir: fixture.paths.production,
    now: () => FIXED_TIME,
    ...overrides
  });
}

function inspectCandidate(fixture) {
  return inspectContainedDirectoryTree(fixture.root, fixture.paths.candidate, {
    maxBytes: 128 * 1024 * 1024,
    maxEntries: 10_000
  });
}

function existsProduction(fixture) {
  return readdirSync(join(fixture.root, "models", "macos"))
    .includes("LekhNeuralTransliterator.production");
}

function promotionDebris(fixture) {
  return readdirSync(join(fixture.root, "models", "macos"))
    .filter((name) => name.startsWith(".LekhNeuralTransliterator.production."));
}

function expectedProductionPerformance(benchmark) {
  return {
    p50Ms: benchmark.performance.p50Ms,
    p95Ms: benchmark.performance.p95Ms,
    p99Ms: benchmark.performance.p99Ms,
    targetP99Ms: 50,
    measuredOnDevice: true,
    devices: benchmark.devices.map((device) => ({
      name: device.name,
      macOS: device.macOS,
      architecture: device.architecture,
      packagedApp: device.packagedApp,
      secureFieldInferenceCount: device.secureFieldInferenceCount,
      p50Ms: device.p50Ms,
      p95Ms: device.p95Ms,
      p99Ms: device.p99Ms,
      artifact: device.artifact,
      measurementKind: device.measurementKind
    }))
  };
}

function splitTensorContract() {
  const tensor = (shape, dataType = "FLOAT16") => ({ shape, dataType });
  return {
    encoder: {
      inputs: { inputIds: tensor([1, 32], "INT32") },
      outputs: {
        encoderOutputs: tensor([1, 32, 128]),
        encoderEnergy: tensor([1, 32, 64]),
        validMask: tensor([1, 32]),
        initialDecoderHidden: tensor([2, 1, 64])
      }
    },
    decoderStep: {
      inputs: {
        decoderTokenIds: tensor([4, 1], "INT32"),
        decoderHidden: tensor([2, 4, 64]),
        encoderOutputs: tensor([1, 32, 128]),
        encoderEnergy: tensor([1, 32, 64]),
        validMask: tensor([1, 32])
      },
      outputs: {
        stepLogits: tensor([4, 128]),
        nextDecoderHidden: tensor([2, 4, 64])
      }
    }
  };
}

function ctcTensorContract() {
  return {
    inputIds: {
      shape: [1, 32],
      dataType: "INT32"
    },
    logits: {
      shape: [1, 32, 128],
      dataType: "FLOAT16"
    }
  };
}

function ctcCoreMLParityEvidence() {
  const cases = CTC_COREML_PARITY_CASE_IDS.map((caseId, index) => ({
    caseId,
    contentLength: [6, 3, 5, 8, 31][index],
    inputSha256: createHash("sha256")
      .update(`promotion-parity-input-${index}`)
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
    tensorContract: ctcTensorContract(),
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

function computePlanEvidence(artifact) {
  return {
    architecture: "arm64",
    availableComputeDevices: ["cpu", "gpu", "neural-engine"],
    configurationComputeUnits: "all",
    evidenceKind: "coreml-compute-plan-anticipated-device-usage",
    generatedAt: FIXED_TIME,
    macOS: "26.0",
    modelBytes: artifact.compiledBytes,
    modelKinds: ["program"],
    modelPath: artifact.sourcePath,
    modelSha256: artifact.compiledSha256,
    neuralEngineAvailable: true,
    neuralEnginePlanEvidence: true,
    neuralEnginePreferredOperationCount: 12,
    neuralEngineSupportedOperationCount: 20,
    operationCount: 30,
    preferredComputeDeviceCounts: {
      cpu: 8,
      gpu: 0,
      "neural-engine": 12,
      unknown: 0
    },
    recordType: "lekh-neural-compute-plan-evidence",
    schemaVersion: 1,
    status: "passed",
    supportedComputeDeviceCounts: {
      cpu: 20,
      gpu: 15,
      "neural-engine": 20,
      unknown: 0
    },
    usageUnavailableCount: 10
  };
}

function runtimePlacementEvidence(descriptor) {
  const runtimeRoles = {};
  const roleExecutions = {};
  for (const artifact of descriptor.artifacts) {
    runtimeRoles[artifact.role] = {
      bundleName: artifact.bundleName,
      compiledBytes: artifact.compiledBytes,
      compiledSha256: artifact.compiledSha256
    };
    roleExecutions[artifact.role] = {
      bundleName: artifact.bundleName,
      compiledSha256: artifact.compiledSha256,
      neuralEngineComputeObserved: true,
      predictionCount: descriptor.artifacts.length === 1
        ? 40
        : artifact.role === "encoder" ? 40 : 1_200
    };
  }
  const coreMLPredictionCount = Object.values(roleExecutions)
    .reduce((total, role) => total + role.predictionCount, 0);
  return {
    schemaVersion: 1,
    recordType: "lekh-neural-runtime-placement-evidence",
    status: "passed",
    evidenceKind: "instruments-coreml-neural-engine-runtime-trace",
    generatedAt: FIXED_TIME,
    architecture: "arm64",
    macOS: "26.0",
    hardware: {
      chip: "Apple M-series",
      modelIdentifier: "MacFixture1,1"
    },
    capture: {
      tool: "Instruments",
      xcodeVersion: "26.0",
      coreMLInstrument: true,
      neuralEngineInstrument: true,
      traceSha256: "7".repeat(64),
      traceExportSha256: "8".repeat(64)
    },
    artifactIdentity: {
      manifestSha256: descriptor.manifestSha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256,
      runtimeRoles
    },
    workload: {
      ...NEURAL_RUNTIME_PLACEMENT_WORKLOAD_IDENTITY
    },
    correlation: {
      processScoped: true,
      predictionIntervalsCorrelated: true,
      rolePathsResolved: true,
      coreMLComputeLane: true,
      neuralEngineHardwareTrack: true
    },
    observations: {
      coreMLPredictionCount,
      neuralEngineComputeEventCount: coreMLPredictionCount,
      roleExecutions
    }
  };
}

function materializeOfficialBenchmarkRows(root) {
  const manifest = readJson(join(
    root,
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
  ));
  const rows = [];
  for (const suite of manifest.suites) {
    const source = join(sourceRoot, suite.path);
    const destination = join(root, suite.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    rows.push(...readJsonLines(destination));
  }
  return rows;
}

function firstAcceptedTarget(row) {
  const accepted = row.acceptable ?? row.expected;
  assert.ok(
    Array.isArray(accepted) &&
    typeof accepted[0] === "string" &&
    accepted[0].length > 0
  );
  return accepted[0];
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}

function evidence(root, value) {
  return {
    path: portable(root, value.path),
    sha256: value.sha256
  };
}

function fileEvidence(root, value) {
  return {
    path: portable(root, value.path),
    bytes: value.bytes,
    sha256: value.sha256
  };
}

function goldCorpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    for (const [value, terminator] of [
      [suite.id, "\0"],
      [suite.path, "\0"],
      [suite.sha256, "\0"],
      [suite.rows, "\n"]
    ]) {
      hash.update(String(value));
      hash.update(terminator);
    }
  }
  return hash.digest("hex");
}
