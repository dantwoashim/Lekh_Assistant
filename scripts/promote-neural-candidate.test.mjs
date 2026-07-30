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
import { describe, it, vi } from "vitest";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT
} from "./lib/neural-native-service-benchmark-evidence.mjs";
import {
  buildNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";
import {
  recomputeNeuralGoldEvaluationEvidence,
  recomputeOfficialBenchmarkEvaluationEvidence
} from "./lib/neural-metric-recomputation.mjs";
import {
  verifyOfficialBenchmarkTrainingIsolation
} from "./lib/neural-official-benchmark-isolation.mjs";
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
  NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION,
  verifyNeuralProductionPromotionReceipt
} from "./lib/neural-production-promotion-receipt.mjs";
import {
  NeuralCandidatePromotionError,
  promoteNeuralCandidate
} from "./promote-neural-candidate.mjs";

// Raw xctrace custody and semantic fail-closed behavior have their own
// dedicated tests. Promotion fixtures isolate the remaining publication
// graph by substituting only that already-verified boundary.
vi.mock(
  "./lib/neural-runtime-trace-provenance.mjs",
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      matchNeuralRuntimeTraceProvenance: () => Object.freeze({
        valid: true,
        issueCode: null
      })
    };
  }
);

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
      assert.equal(
        report.schemaVersion,
        NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION
      );
      assert.match(report.candidateCustodySetSha256, /^[a-f0-9]{64}$/u);
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
      assert.equal(phase9.status, 1, phase9.stderr || phase9.stdout);
      assert.equal(
        readJson(phase9Report).status,
        "failed-production-phase9-promotion"
      );
      assert.ok(
        readJson(phase9Report).failures.some((failure) =>
          /lacks observed Neural Engine runtime placement/u.test(failure)
        )
      );
      assert.equal(
        productionManifestValidator(manifest),
        true,
        JSON.stringify(productionManifestValidator.errors)
      );
      assert.equal(manifest.productionEligible, true);
      assert.deepEqual(
        manifest.metrics,
        expectedProductionMetrics(fixture)
      );
      assert.deepEqual(
        manifest.performance,
        expectedProductionPerformance(fixture.benchmark)
      );
      assert.notDeepEqual(manifest.metrics, fixture.manifest.metrics);
      assert.equal(report.candidateEvidenceStable, true);
      assert.equal(report.trainingRunId, TRAINING_RUN_ID);
      assert.equal(report.exportRunId, EXPORT_RUN_ID);
      assert.deepEqual(report.trainingIdentity, {
        trainingRunId: TRAINING_RUN_ID,
        sourceCheckpointSha256: fixture.identities.checkpoint.sha256,
        trainingReportSha256: fixture.identities.trainingReport.sha256,
        effectiveTrainingConfigSha256:
          fixture.exportReport.effectiveTrainingConfigSha256,
        trainingSeed: 42
      });
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

  it("rejects forged passed-prefix export and evaluation statuses", () => {
    for (const mutate of [
      (fixture) => {
        fixture.exportReport.status = "passed-forged-candidate";
        writeJson(fixture.paths.exportReport, fixture.exportReport);
      },
      (fixture) => {
        fixture.evaluation.status = "passed-production-forged-evaluation";
        writeJson(fixture.paths.evaluation, fixture.evaluation);
      }
    ]) {
      withFixture("baseline", (fixture) => {
        mutate(fixture);
        assert.throws(
          () => promote(fixture),
          (error) =>
            error instanceof NeuralCandidatePromotionError &&
            /exact passed status|passed production evaluation/u.test(
              error.message
            )
        );
        assert.equal(existsProduction(fixture), false);
      });
    }
  });

  it("rejects a production gold-manifest override", () => {
    withFixture("baseline", (fixture) => {
      fixture.exportReport.artifactOverrides.goldManifest = {
        configured: "data/neural/gold/manifest.v3.json",
        effective: "data/neural/gold/manifest.v3.json",
        source: "command-line"
      };
      writeJson(fixture.paths.exportReport, fixture.exportReport);
      refreshEvaluationExportBinding(fixture);

      assert.throws(
        () => promote(fixture),
        (error) =>
          error instanceof NeuralCandidatePromotionError &&
          /gold-manifest-override-forbidden/u.test(error.message)
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("reverifies the retained winner training report after promotion", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      fixture.trainingReport.effectiveTrainingConfig.trainingRun.seed = 43;
      writeJson(fixture.paths.trainingReport, fixture.trainingReport);

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /changed after candidate promotion/u
      );
    });
  });

  it("rejects a rehashed forged candidate-custody identity", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const receipt = readJson(result.report);
      receipt.candidateCustodySetSha256 = "f".repeat(64);
      receipt.promotionId =
        computeNeuralProductionPromotionId(receipt);
      writeJson(result.report, receipt);

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /candidate evidence custody does not match/u
      );
    });
  });

  it("binds canonical event metadata into the promotion identity", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const receipt = readJson(result.report);
      receipt.generatedAt = "2026-07-24T00:00:01.000Z";
      writeJson(result.report, receipt);

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /Promotion ID does not match/u
      );
    });
  });

  it("rejects fully rehashed retained gold metrics that differ from replay", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const evaluation = readJson(fixture.paths.evaluation);
      evaluation.metrics.protectedFalseConversionRate = 0.25;
      writeJson(fixture.paths.evaluation, evaluation);
      const evaluationEvidence = inspectContainedRegularFile(
        fixture.root,
        fixture.paths.evaluation
      );
      const selection = rehashSelectionEvidence(
        fixture,
        (winner) => {
          winner.evidence.evaluationReport.sha256 =
            evaluationEvidence.sha256;
        }
      );
      rehashPromotionReceipt({
        fixture,
        result,
        selection,
        evidenceUpdates: {
          evaluationReport: evaluationEvidence
        },
        metricsSourceSha256: evaluationEvidence.sha256
      });

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /gold metrics do not match independent recomputation/u
      );
    });
  });

  it("rejects fully rehashed retained official metrics that differ from replay", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const comparison = readJson(fixture.paths.comparison);
      comparison.metrics.overall.top1Accuracy = 0.5;
      writeJson(fixture.paths.comparison, comparison);
      const comparisonEvidence = inspectContainedRegularFile(
        fixture.root,
        fixture.paths.comparison
      );
      const selection = rehashSelectionEvidence(
        fixture,
        (winner) => {
          winner.evidence.comparisonReport.sha256 =
            comparisonEvidence.sha256;
        }
      );
      rehashPromotionReceipt({
        fixture,
        result,
        selection,
        evidenceUpdates: {
          comparisonReport: comparisonEvidence
        }
      });

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /official benchmark metrics do not match independent recomputation/u
      );
    });
  });

  it("rejects a fully rehashed forged selection-winner metric", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const selection = rehashSelectionEvidence(
        fixture,
        (winner) => {
          winner.metrics.goldTailTop1Accuracy = 0.99;
        }
      );
      rehashPromotionReceipt({ fixture, result, selection });

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /Selection winner metrics do not match independent/u
      );
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

  it("fails promotion closed on missing, excessive, or inconsistent memory evidence", () => {
    for (const mutate of [
      (benchmark) => {
        delete benchmark.memory;
      },
      (benchmark) => {
        const memory = postExportMemoryEvidence(134_217_729);
        benchmark.memory = structuredClone(memory);
        benchmark.devices[0].memory = structuredClone(memory);
      },
      (benchmark) => {
        benchmark.memory.peakIncreaseFromBaselineBytes += 1;
        benchmark.devices[0].memory =
          structuredClone(benchmark.memory);
      }
    ]) {
      withFixture("baseline", (fixture) => {
        mutate(fixture.benchmark);
        writeJson(fixture.paths.benchmark, fixture.benchmark);
        assert.throws(
          () => promote(fixture),
          /memory|device evidence is invalid/u
        );
        assert.equal(existsProduction(fixture), false);
      });
    }
  });

  it("accepts the inclusive 128 MiB memory boundary", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const manifest = readJson(result.manifest);
      const boundary = postExportMemoryEvidence(134_217_728);
      assert.deepEqual(manifest.performance.memory, boundary);
      assert.deepEqual(
        manifest.performance.devices[0].memory,
        boundary
      );
    });
  });

  it("rejects manually aggregated multi-device native-service reports", () => {
    withFixture("baseline", (fixture) => {
      const lowerDevice = structuredClone(
        fixture.benchmark.devices[0]
      );
      lowerDevice.name = "fixture-mac-lower-memory";
      lowerDevice.memory =
        postExportMemoryEvidence(100 * 1024 * 1024);
      fixture.benchmark.devices.push(lowerDevice);
      writeJson(fixture.paths.benchmark, fixture.benchmark);

      assert.throws(
        () => promote(fixture),
        /native workload|secure-field-invalid/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects an observed root memory row below another device peak", () => {
    withFixture("baseline", (fixture) => {
      const lowerMemory =
        postExportMemoryEvidence(100 * 1024 * 1024);
      const lowerDevice = structuredClone(
        fixture.benchmark.devices[0]
      );
      lowerDevice.name = "fixture-mac-lower-memory";
      lowerDevice.memory = structuredClone(lowerMemory);
      fixture.benchmark.devices.push(lowerDevice);
      fixture.benchmark.memory = structuredClone(lowerMemory);
      writeJson(fixture.paths.benchmark, fixture.benchmark);

      assert.throws(
        () => promote(fixture),
        /exact worst observed|summary-not-worst/u
      );
      assert.equal(existsProduction(fixture), false);
    });
  });

  it("rejects a benchmark summary/device memory mismatch", () => {
    withFixture("baseline", (fixture) => {
      fixture.benchmark.devices[0].memory =
        postExportMemoryEvidence(100 * 1024 * 1024);
      writeJson(fixture.paths.benchmark, fixture.benchmark);

      assert.throws(
        () => promote(fixture),
        /memory-mismatch|cannot enter the production manifest/u
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

  it("rolls back a published bundle that is not closed-world", () => {
    withFixture("baseline", (fixture) => {
      assert.throws(
        () => promote(fixture, {
          hooks: {
            afterPublish({ productionDir }) {
              write(
                join(productionDir, "unexpected.txt"),
                "must-not-survive"
              );
            }
          }
        }),
        /not closed-world/u
      );
      assert.equal(existsProduction(fixture), false);
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
      assert.equal(
        receipt.schemaVersion,
        NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION
      );
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
      assert.equal(phase9.status, 1, phase9.stderr || phase9.stdout);
      assert.equal(
        readJson(phase9Report).status,
        "failed-production-phase9-promotion"
      );
      assert.ok(
        readJson(phase9Report).failures.some((failure) =>
          /lacks observed Neural Engine runtime placement/u.test(failure)
        )
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
      refreshEvaluationExportBinding(fixture);

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
      refreshEvaluationExportBinding(fixture);

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

  it("rejects a fully rehashed rare-scalar contract policy forgery", () => {
    withFixture("ctc", (fixture) => {
      const result = promote(fixture);
      const contract = readJson(fixture.paths.rareScalarContract);
      contract.scalars[0].cldrNepaliMainExemplar =
        !contract.scalars[0].cldrNepaliMainExemplar;
      writeJson(fixture.paths.rareScalarContract, contract);
      const contractEvidence = inspectContainedRegularFile(
        fixture.root,
        fixture.paths.rareScalarContract
      );

      const generation = readJson(fixture.paths.rareScalarGeneration);
      generation.contract.sha256 = contractEvidence.sha256;
      writeJson(fixture.paths.rareScalarGeneration, generation);
      const generationEvidence = inspectContainedRegularFile(
        fixture.root,
        fixture.paths.rareScalarGeneration
      );

      const rareReport = readJson(fixture.paths.rareScalarEvaluation);
      rareReport.contract.bytes = contractEvidence.bytes;
      rareReport.contract.sha256 = contractEvidence.sha256;
      rareReport.generationReport.bytes = generationEvidence.bytes;
      rareReport.generationReport.sha256 = generationEvidence.sha256;
      writeJson(fixture.paths.rareScalarEvaluation, rareReport);
      const rareReportEvidence = inspectContainedRegularFile(
        fixture.root,
        fixture.paths.rareScalarEvaluation
      );

      const receipt = readJson(result.report);
      receipt.rareScalarEvidence.contract.bytes = contractEvidence.bytes;
      receipt.rareScalarEvidence.contract.sha256 = contractEvidence.sha256;
      receipt.rareScalarEvidence.generationReport.bytes =
        generationEvidence.bytes;
      receipt.rareScalarEvidence.generationReport.sha256 =
        generationEvidence.sha256;
      receipt.rareScalarEvidence.report.bytes = rareReportEvidence.bytes;
      receipt.rareScalarEvidence.report.sha256 = rareReportEvidence.sha256;
      receipt.promotionId =
        computeNeuralProductionPromotionId(receipt);
      writeJson(result.report, receipt);

      assert.throws(
        () => verifyNeuralProductionPromotionReceipt({
          repoRoot: fixture.root,
          productionDirectory: result.productionDir
        }),
        /rare-scalar contract does not match the independently reopened/u
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

  it("rejects rehashed production memory tampering through deterministic reconstruction", () => {
    withFixture("baseline", (fixture) => {
      const result = promote(fixture);
      const manifest = readJson(result.manifest);
      const changedMemory =
        postExportMemoryEvidence(100 * 1024 * 1024);
      manifest.performance.memory = structuredClone(changedMemory);
      manifest.performance.devices[0].memory =
        structuredClone(changedMemory);
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
    trainingReport: join(candidate, "training-report.json"),
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
    goldManifest: join(root, "data", "neural", "gold", "manifest.v3.json"),
    datasetManifest: join(root, "data", "generated", "neural-open-vocab", "manifest.json"),
    datasetTrain: join(root, "data", "generated", "neural-open-vocab", "train.jsonl"),
    datasetDev: join(root, "data", "generated", "neural-open-vocab", "dev.jsonl"),
    datasetTest: join(root, "data", "generated", "neural-open-vocab", "test.jsonl"),
    referenceManifest: join(
      root,
      "data",
      "neural",
      "benchmarks",
      "indicxlit-v1",
      "manifest.json"
    ),
    production: join(root, "models", "macos", "LekhNeuralTransliterator.production")
  };
  write(paths.vocabulary, JSON.stringify({
    schemaVersion: 1,
    modelId: kind === "split" ? "attention" : "baseline",
    tokenization: "unicode-scalar-character"
  }));
  write(paths.checkpoint, "safe-tensor-checkpoint");
  const goldManifest = readJson(
    join(sourceRoot, "data/neural/gold/manifest.v3.json")
  );
  mkdirSync(dirname(paths.goldManifest), { recursive: true });
  copyFileSync(
    join(sourceRoot, "data/neural/gold/manifest.v3.json"),
    paths.goldManifest
  );
  const goldRows = [];
  for (const suite of goldManifest.suites) {
    const destination = join(root, suite.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(sourceRoot, suite.path), destination);
    goldRows.push(...readJsonLines(destination).map((row) => ({
      ...row,
      suiteId: suite.id,
      suitePath: suite.path
    })));
  }
  assert.equal(goldRows.length, 47);
  write(
    paths.predictions,
    goldRows.map((row) => JSON.stringify({
      id: row.id,
      input: row.input,
      candidates: row.expectedAction === "no-neural-candidate"
        ? []
        : [firstAcceptedTarget(row)]
    })).join("\n") + "\n"
  );
  const datasetRows = {
    train: [{
      id: "fixture-train-1",
      input: "fixturetrainingonlyalpha",
      output: "फिक्स्चर",
      split: "train"
    }],
    dev: [{
      id: "fixture-dev-1",
      input: "fixturedevelopmentonlybeta",
      output: "विकास",
      split: "dev"
    }],
    test: [{
      id: "fixture-test-1",
      input: "fixturetestonlygamma",
      output: "परीक्षण",
      split: "test"
    }]
  };
  writeJsonLines(paths.datasetTrain, datasetRows.train);
  writeJsonLines(paths.datasetDev, datasetRows.dev);
  writeJsonLines(paths.datasetTest, datasetRows.test);
  const datasetSplitEvidence = {
    train: inspectContainedRegularFile(root, paths.datasetTrain),
    dev: inspectContainedRegularFile(root, paths.datasetDev),
    test: inspectContainedRegularFile(root, paths.datasetTest)
  };
  const datasetManifest = {
    schemaVersion: 2,
    datasetId: "fixture-neural-dataset",
    cleaningPolicy: {
      normalizeInput: "trim lowercase NFC collapse-whitespace"
    },
    splitFiles: Object.fromEntries(
      Object.entries(datasetSplitEvidence).map(([split, value]) => [
        split,
        portable(root, value.path)
      ])
    ),
    sha256: Object.fromEntries(
      Object.entries(datasetSplitEvidence).map(([split, value]) => [
        split,
        value.sha256
      ])
    ),
    bytes: Object.fromEntries(
      Object.entries(datasetSplitEvidence).map(([split, value]) => [
        split,
        value.bytes
      ])
    ),
    counts: Object.fromEntries(
      Object.entries(datasetRows).map(([split, rows]) => [
        split,
        rows.length
      ])
    ),
    datasetContentSha256: sha256CanonicalJson(
      Object.fromEntries(
        Object.entries(datasetSplitEvidence).map(([split, value]) => [
          split,
          value.sha256
        ])
      )
    ),
    totalRows: Object.values(datasetRows)
      .reduce((total, rows) => total + rows.length, 0)
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
    train: datasetSplitEvidence.train.sha256,
    dev: datasetSplitEvidence.dev.sha256
  };
  let trainingIsolation = null;
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
  const effectiveTrainingConfig = {
    trainingRun: {
      seed: 42
    }
  };
  const effectiveTrainingConfigCanonicalJson =
    JSON.stringify(effectiveTrainingConfig);
  const effectiveTrainingConfigSha256 = createHash("sha256")
    .update(effectiveTrainingConfigCanonicalJson)
    .digest("hex");
  const trainingReport = {
    status: "passed-training-checkpoint",
    trainingComplete: true,
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    checkpoint: portable(root, paths.checkpoint),
    checkpointSha256: identities.checkpoint.sha256,
    effectiveTrainingConfig,
    effectiveTrainingConfigCanonicalJson,
    effectiveTrainingConfigSha256
  };
  writeJson(paths.trainingReport, trainingReport);
  identities.trainingReport = inspectContainedRegularFile(
    root,
    paths.trainingReport
  );

  const exportReport = {
    status: kind === "split"
      ? "passed-open-vocab-attention-split-candidate"
      : kind === "ctc"
        ? "passed-open-vocab-ctc-transformer-candidate"
        : "passed-open-vocab-seq2seq-candidate",
    modelId: manifest.selectedArtifact,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    effectiveTrainingConfigSha256,
    productionEligible: false,
    artifactOverrides: {},
    runtimeArtifactContractIssues: [],
    checkpoint: portable(root, paths.checkpoint),
    checkpointSha256: identities.checkpoint.sha256,
    trainingReport: portable(root, paths.trainingReport),
    trainingReportSha256: identities.trainingReport.sha256,
    manifest: portable(root, paths.manifest),
    manifestSha256: identities.manifest.sha256,
    predictions: portable(root, paths.predictions),
    predictionsSha256: identities.predictions.sha256,
    predictionsBackend: artifactDescriptor.predictionsBackend,
    goldManifest: portable(root, paths.goldManifest),
    goldManifestSha256: identities.goldManifest.sha256,
    goldCorpusSha256: goldManifest.corpusSha256,
    goldSuites: lockedSuiteEvidence(goldManifest),
    goldRows: goldRows.length,
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
    goldRows: goldRows.length,
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

  const memory = postExportMemoryEvidence();
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
    memory: structuredClone(memory),
    computePlans: Object.fromEntries(
      artifactDescriptor.artifacts.map((artifact) => [
        artifact.role,
        computePlanEvidence(artifact)
      ])
    )
  }];
  const benchmarkContract =
    NEURAL_NATIVE_SERVICE_BENCHMARK_CONTRACT;
  const latencySamples = [
    ...Array(120).fill(10),
    ...Array(108).fill(20),
    ...Array(12).fill(25)
  ];
  const byTokenMs = Object.fromEntries(
    benchmarkContract.orderedTokens.map((token, index) => [
      token,
      latencySamples.slice(index * 48, (index + 1) * 48)
    ])
  );
  const candidateResultsByToken = Object.fromEntries(
    benchmarkContract.orderedTokens.map((token) => [
      token,
      Array.from(
        { length: benchmarkContract.measuredPasses },
        () => ["नेपाली"]
      )
    ])
  );
  const measuredInferenceCount =
    benchmarkContract.orderedTokens.length *
    (
      benchmarkContract.warmupPasses +
      benchmarkContract.measuredPasses
    );
  const benchmark = {
    suite: "native-neural-service-e2e",
    status: "passed-candidate-promotion-evidence",
    proofMode: "candidate-promotion",
    serviceStatus:
      "experimental-async-coreml-tail-artifact-verified-ready",
    serviceInitializationMs: 1,
    singleForwardBenchmarkIsConsumerLatency: false,
    placementCapture: false,
    workloadTokens: [...benchmarkContract.orderedTokens],
    benchmarkPasses:
      benchmarkContract.warmupPasses +
      benchmarkContract.measuredPasses,
    warmupPasses: benchmarkContract.warmupPasses,
    measuredPasses: benchmarkContract.measuredPasses,
    warmupRequests:
      benchmarkContract.orderedTokens.length *
      benchmarkContract.warmupPasses,
    steadyStateSamples:
      benchmarkContract.orderedTokens.length *
      benchmarkContract.measuredPasses,
    byTokenMs,
    targetP95Ms: benchmarkContract.targetP95Ms,
    candidateResultsByToken,
    predictions: Object.fromEntries(
      benchmarkContract.orderedTokens.map((token) => [
        token,
        ["नेपाली"]
      ])
    ),
    artifactIdentity: {
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
      manifestSha256: identities.manifest.sha256,
      vocabSha256: identities.vocabulary.sha256,
      artifactSetSha256: artifactDescriptor.artifactSetSha256,
      ...artifactFixture.benchmarkIdentity
    },
    devices: structuredClone(devices),
    memory: structuredClone(memory),
    performance: {
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 25
    },
    singleTokenPhraseExpansionRate: 0,
    secureFieldProbeToken: benchmarkContract.secureFieldProbeToken,
    secureFieldCandidates: [],
    secureFieldInferenceCount: 0,
    deterministicExactBypassToken:
      benchmarkContract.deterministicExactBypassToken,
    deterministicExactBypassCandidates: [],
    deterministicExactBypassInferenceCount: 0,
    protectedLatinBypassCandidates: Object.fromEntries(
      benchmarkContract.protectedLatinTokens.map((token) => [token, []])
    ),
    protectedLatinBypassInferenceCount: 0,
    predictorInvocationEvidence: {
      beforeDeterministicBypass: 0,
      afterDeterministicBypass: 0,
      beforeProtectedBypass: 0,
      afterProtectedBypass: 0,
      beforeSecureField: measuredInferenceCount,
      afterSecureField: measuredInferenceCount
    },
    latestRequestTokens: [...benchmarkContract.latestRequestTokens],
    latestRequestCompletions: [
      benchmarkContract.latestRequestTokens.at(-1)
    ],
    latestRequestWins: true,
    cancelledCompletionCalled: false,
    cancelPendingSuppressesCompletion: true,
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
  const officialManifest = readJson(paths.comparisonBenchmarkManifest);
  const officialRows = materializeOfficialBenchmarkRows(root);
  assert.equal(officialRows.length, 4_085);
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
  const isolationReplay = verifyOfficialBenchmarkTrainingIsolation({
    repoRoot: root,
    datasetManifestPath: paths.datasetManifest,
    expectedDatasetManifestSha256: identities.datasetManifest.sha256,
    officialRows
  });
  assert.equal(
    isolationReplay.valid,
    true,
    isolationReplay.issueCodes.join(", ")
  );
  assert.ok(isolationReplay.evidence);
  trainingIsolation = structuredClone(isolationReplay.evidence);
  mkdirSync(dirname(paths.referenceManifest), { recursive: true });
  copyFileSync(
    join(
      sourceRoot,
      "data/neural/benchmarks/indicxlit-v1/manifest.json"
    ),
    paths.referenceManifest
  );
  const referenceManifest = readJson(paths.referenceManifest);
  paths.referencePredictions = join(
    root,
    referenceManifest.predictionArtifact.path
  );
  mkdirSync(dirname(paths.referencePredictions), { recursive: true });
  copyFileSync(
    join(sourceRoot, referenceManifest.predictionArtifact.path),
    paths.referencePredictions
  );
  identities.referenceManifest = inspectContainedRegularFile(
    root,
    paths.referenceManifest
  );
  identities.referencePredictions = inspectContainedRegularFile(
    root,
    paths.referencePredictions
  );
  assert.equal(
    identities.referenceManifest.sha256,
    REFERENCE_MANIFEST_SHA256
  );
  assert.equal(
    identities.referencePredictions.sha256,
    referenceManifest.predictionArtifact.sha256
  );
  const referencePredictionRows = readJsonLines(
    paths.referencePredictions
  );
  const goldPredictionRows = readJsonLines(paths.predictions);
  const goldReplay = recomputeNeuralGoldEvaluationEvidence({
    goldRows,
    predictionRows: goldPredictionRows
  });
  assert.equal(goldReplay.valid, true, goldReplay.issueCodes.join(", "));
  const officialReplay =
    recomputeOfficialBenchmarkEvaluationEvidence({
      benchmarkRows: officialRows,
      candidatePredictionRows: officialPredictionRows,
      referencePredictionRows
    });
  assert.equal(
    officialReplay.valid,
    true,
    officialReplay.issueCodes.join(", ")
  );
  const goldSuites = lockedSuiteEvidence(goldManifest);
  const officialSuites = lockedSuiteEvidence(officialManifest);
  const officialBenchmarkSnapshot = {
    manifest: portable(root, paths.comparisonBenchmarkManifest),
    manifestSha256: identities.comparisonBenchmarkManifest.sha256,
    corpusSha256: officialManifest.corpusSha256,
    suites: officialSuites,
    rows: officialRows.length,
    trainingIsolation
  };
  const runInputSnapshot = {
    schemaVersion: 1,
    dataset: {
      manifest: portable(root, paths.datasetManifest),
      manifestSha256: identities.datasetManifest.sha256,
      contentSha256: datasetManifest.datasetContentSha256,
      splits: structuredClone(isolationReplay.comparedSplits)
    },
    gold: {
      goldManifest: portable(root, paths.goldManifest),
      goldManifestSha256: identities.goldManifest.sha256,
      goldCorpusSha256: goldManifest.corpusSha256,
      goldSuites,
      goldRows: goldRows.length
    },
    officialBenchmark: officialBenchmarkSnapshot
  };
  trainingReport.runInputSnapshot = structuredClone(runInputSnapshot);
  writeJson(paths.trainingReport, trainingReport);
  identities.trainingReport = inspectContainedRegularFile(
    root,
    paths.trainingReport
  );
  writeJson(paths.benchmark, benchmark);
  identities.benchmark = inspectContainedRegularFile(
    root,
    paths.benchmark
  );
  exportReport.trainingReportSha256 =
    identities.trainingReport.sha256;
  exportReport.goldSuites = goldSuites;
  exportReport.runInputSnapshot = structuredClone(runInputSnapshot);
  exportReport.trainingRunInputSnapshotSha256 =
    sha256CanonicalJson(trainingReport.runInputSnapshot);
  exportReport.exportRunInputSnapshotSha256 =
    sha256CanonicalJson(exportReport.runInputSnapshot);
  exportReport.comparisonBenchmark = {
    manifest: portable(root, paths.comparisonBenchmarkManifest),
    manifestSha256: identities.comparisonBenchmarkManifest.sha256,
    corpusSha256: officialManifest.corpusSha256,
    suites: officialSuites,
    rows: officialRows.length,
    trainingIsolation,
    predictions: portable(root, paths.comparisonPredictions),
    predictionsSha256: identities.comparisonPredictions.sha256,
    predictionsBackend: artifactDescriptor.predictionsBackend,
    predictionArtifactIdentity
  };
  writeJson(paths.exportReport, exportReport);
  identities.exportReport = inspectContainedRegularFile(
    root,
    paths.exportReport
  );
  Object.assign(evaluation, {
    ...replayReportFields(goldReplay),
    candidateManifest: portable(root, paths.manifest),
    candidateManifestSha256: identities.manifest.sha256,
    exportReport: portable(root, paths.exportReport),
    exportReportSha256: identities.exportReport.sha256,
    artifactIdentity: {
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
      manifestSha256: identities.manifest.sha256,
      vocabSha256: artifactDescriptor.vocabSha256,
      compiledModelSha256: manifest.sha256?.compiledModel ?? null,
      compiledModels: manifest.sha256?.compiledModels ?? null
    }
  });
  writeJson(paths.evaluation, evaluation);
  identities.evaluation = inspectContainedRegularFile(root, paths.evaluation);
  const {
    reference: officialReference,
    ...officialReplayFields
  } = replayReportFields(officialReplay);
  const comparison = {
    schemaVersion: 1,
    status: "passed-official-benchmark-evaluation",
    suite: "neural-official-benchmark-evaluation",
    productionEligible: true,
    trainingRunId: TRAINING_RUN_ID,
    exportRunId: EXPORT_RUN_ID,
    candidateManifestSha256: identities.manifest.sha256,
    exportReport: portable(root, paths.exportReport),
    exportReportSha256: identities.exportReport.sha256,
    artifactIdentity: {
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
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
    predictionsBackend: artifactDescriptor.predictionsBackend,
    predictionArtifactIdentity,
    reference: {
      manifest: portable(root, paths.referenceManifest),
      manifestSha256: identities.referenceManifest.sha256,
      predictions: portable(root, paths.referencePredictions),
      predictionsSha256: identities.referencePredictions.sha256,
      ...officialReference
    },
    ...officialReplayFields,
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
        goldRows,
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
  const officialMetrics = officialReplay.metrics;
  const indianNameMetrics =
    officialMetrics.byBucket["indian-name"];
  const foreignNameMetrics =
    officialMetrics.byBucket["foreign-name"];
  const officialNameRows =
    indianNameMetrics.rows + foreignNameMetrics.rows;
  assert.ok(officialNameRows > 0);
  const replayDerivedWinnerMetrics = {
    officialOverallTop1Accuracy:
      officialMetrics.overall.top1Accuracy,
    officialOverallTop3Accuracy:
      officialMetrics.overall.top3Accuracy,
    officialNativeTop1Accuracy:
      officialMetrics.byBucket["native-frequent"].top1Accuracy,
    officialNameTop1Accuracy: roundMetric(
      (indianNameMetrics.top1Hits + foreignNameMetrics.top1Hits) /
        officialNameRows
    ),
    goldTailTop1Accuracy: goldReplay.metrics.tailTop1Accuracy,
    goldTailTop3Accuracy: goldReplay.metrics.tailTop3Accuracy,
    latencyP99Ms: benchmark.performance.p99Ms,
    compiledBytes: artifactDescriptor.totalCompiledBytes
  };
  const winningCandidate = {
    candidateId: `${kind}:${EXPORT_RUN_ID}`,
    candidateRoot: portable(root, candidate),
    modelId: manifest.selectedArtifact,
    architecture: manifest.architecture,
    eligible: true,
    identity: {
      trainingRunId: TRAINING_RUN_ID,
      exportRunId: EXPORT_RUN_ID,
      sourceCheckpointSha256: identities.checkpoint.sha256,
      trainingReportSha256: identities.trainingReport.sha256,
      effectiveTrainingConfigSha256,
      trainingSeed: effectiveTrainingConfig.trainingRun.seed,
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
      checkpoint: evidence(root, identities.checkpoint),
      trainingReport: evidence(root, identities.trainingReport),
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
    metrics: replayDerivedWinnerMetrics
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
  losingCandidate.identity.sourceCheckpointSha256 = "1".repeat(64);
  losingCandidate.identity.trainingReportSha256 = "2".repeat(64);
  losingCandidate.identity.effectiveTrainingConfigSha256 = "3".repeat(64);
  losingCandidate.identity.trainingSeed = 43;
  losingCandidate.evidence.manifest.sha256 =
    losingCandidate.identity.manifestSha256;
  losingCandidate.evidence.exportReport.sha256 =
    losingCandidate.identity.exportReportSha256;
  losingCandidate.evidence.checkpoint.sha256 =
    losingCandidate.identity.sourceCheckpointSha256;
  losingCandidate.evidence.trainingReport.sha256 =
    losingCandidate.identity.trainingReportSha256;
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
    trainingReport,
    evaluation,
    benchmark,
    comparison,
    rareScalar,
    selection,
    goldManifest,
    goldRows,
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
  goldRows,
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
        rows: goldRows,
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
      rows: goldRows.length
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
        artifactValidation: { status: "passed" },
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
        artifactValidation: { status: "passed" },
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

function refreshBenchmarkSelectionEvidence(fixture) {
  const benchmarkIdentity = inspectContainedRegularFile(
    fixture.root,
    fixture.paths.benchmark
  );
  fixture.identities.benchmark = benchmarkIdentity;
  const candidates = structuredClone(fixture.selection.candidates);
  const winnerId = fixture.selection.winner.candidateId;
  const winner = candidates.find(
    (candidate) => candidate.candidateId === winnerId
  );
  assert.ok(winner);
  winner.evidence.benchmarkReport = evidence(
    fixture.root,
    benchmarkIdentity
  );
  fixture.selection = buildNeuralSelectionReport({
    candidates,
    generatedAt: FIXED_TIME
  });
  writeJson(fixture.paths.selection, fixture.selection);
  fixture.identities.selection = inspectContainedRegularFile(
    fixture.root,
    fixture.paths.selection
  );
}

function refreshEvaluationExportBinding(fixture) {
  const exportIdentity = inspectContainedRegularFile(
    fixture.root,
    fixture.paths.exportReport
  );
  fixture.exportReport = readJson(fixture.paths.exportReport);
  fixture.identities.exportReport = exportIdentity;
  fixture.evaluation.exportReportSha256 = exportIdentity.sha256;
  writeJson(fixture.paths.evaluation, fixture.evaluation);
  fixture.identities.evaluation = inspectContainedRegularFile(
    fixture.root,
    fixture.paths.evaluation
  );
}

function rehashSelectionEvidence(fixture, mutateWinner) {
  const current = readJson(fixture.paths.selection);
  const candidates = structuredClone(current.candidates);
  const winner = candidates.find(
    (candidate) => candidate.candidateId === current.winner.candidateId
  );
  assert.ok(winner);
  mutateWinner(winner);
  const selection = buildNeuralSelectionReport({
    candidates,
    generatedAt: current.generatedAt
  });
  writeJson(fixture.paths.selection, selection);
  return {
    report: selection,
    evidence: inspectContainedRegularFile(
      fixture.root,
      fixture.paths.selection
    )
  };
}

function rehashPromotionReceipt({
  fixture,
  result,
  selection,
  evidenceUpdates = {},
  metricsSourceSha256
}) {
  const receipt = readJson(result.report);
  for (const [key, value] of Object.entries(evidenceUpdates)) {
    receipt.inputs[key].bytes = value.bytes;
    receipt.inputs[key].sha256 = value.sha256;
  }
  receipt.inputs.selectionReport.bytes = selection.evidence.bytes;
  receipt.inputs.selectionReport.sha256 = selection.evidence.sha256;
  receipt.inputs.selectionId = selection.report.selectionId;
  if (metricsSourceSha256 !== undefined) {
    receipt.productionManifest.metricsSourceSha256 =
      metricsSourceSha256;
  }
  receipt.promotionId = computeNeuralProductionPromotionId(receipt);
  writeJson(result.report, receipt);
  fixture.selection = selection.report;
  fixture.identities.selection = selection.evidence;
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
    memory: structuredClone(benchmark.memory),
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
      measurementKind: device.measurementKind,
      memory: structuredClone(device.memory)
    }))
  };
}

function expectedProductionMetrics(fixture) {
  const metrics = fixture.evaluation.metrics;
  return {
    tailTop1Accuracy: metrics.tailTop1Accuracy,
    tailTop3Accuracy: metrics.tailTop3Accuracy,
    chatConventionTop1Accuracy:
      metrics.chatConventionTop1Accuracy,
    chatConventionTop3Accuracy:
      metrics.chatConventionTop3Accuracy,
    namesTop3Accuracy: metrics.namesTop3Accuracy,
    protectedFalseConversionRate:
      metrics.protectedFalseConversionRate,
    singleTokenPhraseExpansionRate:
      metrics.singleTokenPhraseExpansionRate,
    secureFieldInferenceCount: fixture.benchmark.devices.reduce(
      (total, device) =>
        total + device.secureFieldInferenceCount,
      0
    )
  };
}

function postExportMemoryEvidence(
  lifetimePeakPhysicalFootprintBytes = 128 * 1024 * 1024
) {
  const baselinePhysicalFootprintBytes = 40 * 1024 * 1024;
  return {
    schemaVersion: 1,
    measurementKind: "isolated-process-physical-footprint-v1",
    api: "proc_pid_rusage:RUSAGE_INFO_V4",
    units: "bytes",
    baselinePhysicalFootprintBytes,
    lifetimePeakPhysicalFootprintBytes,
    peakIncreaseFromBaselineBytes:
      lifetimePeakPhysicalFootprintBytes -
      baselinePhysicalFootprintBytes
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
    rows.push(...readJsonLines(destination).map((row) => ({
      ...row,
      suiteId: suite.id,
      suitePath: suite.path,
      benchmarkBucket: suite.benchmarkBucket
    })));
  }
  return rows;
}

function lockedSuiteEvidence(manifest) {
  return manifest.suites.map((suite) => ({
    id: suite.id,
    path: suite.path,
    sha256: suite.sha256,
    rows: suite.rows,
    ...(suite.benchmarkBucket === undefined
      ? {}
      : { benchmarkBucket: suite.benchmarkBucket })
  }));
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

function writeJsonLines(path, rows) {
  write(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
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

function replayReportFields(replay) {
  const {
    valid: _valid,
    issueCodes: _issueCodes,
    ...fields
  } = replay;
  return structuredClone(fields);
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}
