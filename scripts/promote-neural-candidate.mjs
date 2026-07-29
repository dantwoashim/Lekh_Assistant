#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  neuralRuntimeContractMetadata,
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  validateNeuralDeviceMeasurements
} from "./lib/neural-device-measurements.mjs";
import {
  validateNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";
import {
  validateNeuralRuntimePlacementEvidence
} from "./lib/neural-runtime-placement-evidence.mjs";
import {
  computeNeuralProductionPromotionIdFromIdentity,
  NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION
} from "./lib/neural-production-promotion-receipt.mjs";
import {
  validateNeuralRareScalarContract
} from "./lib/neural-rare-scalar-contract.mjs";
import {
  evaluateNeuralRareScalarEvidence
} from "./lib/neural-rare-scalar-evaluation.mjs";
import {
  isCTCFinitePathDecoderPolicy
} from "./lib/neural-ctc-finite-path-contract.mjs";
import {
  hasCTCCoreMLParityEvidence
} from "./lib/neural-ctc-coreml-parity-contract.mjs";

const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CTC_MODEL_ID = "lekh-open-vocab-ctc-transformer-v2";
const CTC_RUNTIME_CONTRACT = "single-transformer-ctc-v1";
const BASELINE_COMPILED_NAME = "LekhNeuralTransliterator.mlmodelc";
const BASELINE_PACKAGE_NAME = "LekhNeuralTransliterator.mlpackage";
const VOCABULARY_NAME = "LekhNeuralTransliterator.vocab.json";
const PRODUCTION_MANIFEST_NAME = "LekhNeuralTransliterator.manifest.json";
const PROMOTION_REPORT_NAME = "neural-candidate-promotion-report.json";
const RARE_SCALAR_STATUS =
  "passed-neural-rare-scalar-production-gate";
const CANONICAL_OFFICIAL_BENCHMARK_MANIFEST =
  "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json";
const CANONICAL_OFFICIAL_BENCHMARK_MANIFEST_SHA256 =
  "d492040eeb6ddd2883fee50d0f03c051e20a08d1f469da00679b66751136781f";
const CANONICAL_REFERENCE_MANIFEST =
  "data/neural/benchmarks/indicxlit-v1/manifest.json";
const CANONICAL_REFERENCE_MANIFEST_SHA256 =
  "c3bd96c57a322455026df920dab74dc214113bb2a33aa67f6420805b195c52c6";
const SPLIT_ARTIFACT_NAMES = Object.freeze({
  encoder: Object.freeze({
    compiledModel: "LekhNeuralTransliteratorEncoder.mlmodelc",
    mlpackage: "LekhNeuralTransliteratorEncoder.mlpackage"
  }),
  decoderStep: Object.freeze({
    compiledModel: "LekhNeuralTransliteratorDecoderStep.mlmodelc",
    mlpackage: "LekhNeuralTransliteratorDecoderStep.mlpackage"
  })
});

export class NeuralCandidatePromotionError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralCandidatePromotionError";
  }
}

/**
 * Promote an already-qualified immutable candidate into one atomic production
 * directory. All metrics and performance values are copied verbatim from the
 * supplied evaluation and packaged full-candidate benchmark evidence.
 */
export function promoteNeuralCandidate(options) {
  const repoRoot = canonicalDirectory(options?.repoRoot ?? process.cwd(), "Repository root");
  const candidateRoot = resolveRequiredPath(repoRoot, options?.candidateRoot, "candidateRoot");
  const productionDir = resolve(
    repoRoot,
    options?.productionDir ?? "models/macos/LekhNeuralTransliterator.production"
  );
  const candidateManifestPath = resolve(
    repoRoot,
    options?.candidateManifest ??
      join(candidateRoot, PRODUCTION_MANIFEST_NAME)
  );
  const exportReportPath = resolve(
    repoRoot,
    options?.exportReport ?? join(candidateRoot, "export-report.json")
  );
  const vocabularyPath = resolve(
    repoRoot,
    options?.vocabulary ?? join(candidateRoot, VOCABULARY_NAME)
  );
  const evaluationReportPath = resolveRequiredPath(
    repoRoot,
    options?.evaluationReport,
    "evaluationReport"
  );
  const benchmarkReportPath = resolveRequiredPath(
    repoRoot,
    options?.benchmarkReport,
    "benchmarkReport"
  );
  const selectionReportPath = resolveRequiredPath(
    repoRoot,
    options?.selectionReport,
    "selectionReport"
  );
  const rareScalarReportPath = options?.rareScalarReport === undefined
    ? null
    : resolveRequiredPath(
        repoRoot,
        options.rareScalarReport,
        "rareScalarReport"
      );
  const now = typeof options?.now === "function"
    ? options.now
    : () => new Date().toISOString();
  const hooks = options?.hooks ?? {};

  assertCandidateRoot(repoRoot, candidateRoot);
  assertProductionDestination(repoRoot, productionDir, candidateRoot);
  for (const [path, label] of [
    [candidateManifestPath, "Candidate manifest"],
    [exportReportPath, "Candidate export report"],
    [vocabularyPath, "Candidate vocabulary"]
  ]) {
    assertWithin(candidateRoot, path, `${label} must remain inside the immutable candidate directory`);
  }

  const trackedInputs = [];
  const candidateManifestEvidence = readJsonEvidence(
    repoRoot,
    candidateManifestPath,
    "Candidate runtime manifest",
    trackedInputs
  );
  const exportEvidence = readJsonEvidence(
    repoRoot,
    exportReportPath,
    "Candidate export report",
    trackedInputs
  );
  const evaluationEvidence = readJsonEvidence(
    repoRoot,
    evaluationReportPath,
    "Production evaluation report",
    trackedInputs
  );
  const benchmarkEvidence = readJsonEvidence(
    repoRoot,
    benchmarkReportPath,
    "Packaged full-candidate benchmark report",
    trackedInputs
  );
  const selectionEvidence = readJsonEvidence(
    repoRoot,
    selectionReportPath,
    "Neural model selection report",
    trackedInputs
  );
  const vocabularyEvidence = trackFile(
    repoRoot,
    vocabularyPath,
    "Candidate vocabulary",
    trackedInputs,
    { maxBytes: 16 * 1024 * 1024 }
  );

  const candidateManifest = candidateManifestEvidence.value;
  const exportReport = exportEvidence.value;
  const evaluationReport = evaluationEvidence.value;
  const benchmarkReport = benchmarkEvidence.value;
  const selectionReport = selectionEvidence.value;
  const artifactDescriptor = resolveNeuralArtifactDescriptor({
    repoRoot,
    manifest: candidateManifest,
    manifestPath: candidateManifestPath,
    vocabPath: vocabularyPath
  });

  validateRunIdentities(candidateManifest, exportReport, evaluationReport, benchmarkReport);
  if (candidateManifest.productionEligible !== false) {
    fail("Candidate manifest must explicitly remain productionEligible=false before promotion.");
  }
  if (exportReport.productionEligible === true) {
    fail("Candidate export report is already productionEligible and cannot be promoted again.");
  }
  requirePassedStatus(exportReport.status, "Candidate export report");
  if (exportReport.coremlExport?.status !== "passed") {
    fail("Candidate export report must bind a passed Core ML export.");
  }
  if (!Array.isArray(exportReport.runtimeArtifactContractIssues) ||
      exportReport.runtimeArtifactContractIssues.length !== 0) {
    fail("Candidate export report must contain an empty runtimeArtifactContractIssues list.");
  }

  verifyDeclaredFileIdentity({
    repoRoot,
    candidateRoot,
    declaredPath: exportReport.manifest,
    declaredSha256: exportReport.manifestSha256,
    expectedPath: candidateManifestPath,
    expectedEvidence: candidateManifestEvidence.file,
    label: "Candidate manifest"
  });
  const expectedVocabularySha256 = requireSha256(
    candidateManifest.sha256?.vocabMetadata,
    "Candidate manifest sha256.vocabMetadata"
  );
  if (vocabularyEvidence.sha256 !== expectedVocabularySha256) {
    fail("Candidate vocabulary bytes do not match manifest sha256.vocabMetadata.");
  }

  const checkpointEvidence = verifyCheckpoint(
    repoRoot,
    candidateRoot,
    candidateManifest,
    exportReport,
    trackedInputs
  );
  const goldEvidence = verifyEvaluationEvidence({
    repoRoot,
    candidateRoot,
    exportReport,
    evaluationReport,
    trackedInputs
  });
  if (requireSha256(
    candidateManifest.sha256?.trainingDatasetManifest,
    "Candidate manifest sha256.trainingDatasetManifest"
  ) !== goldEvidence.dataset.file.sha256) {
    fail("Candidate manifest does not bind the exact training dataset manifest.");
  }
  const artifactSet = discoverAndVerifyArtifacts({
    repoRoot,
    candidateRoot,
    candidateManifest,
    exportReport,
    trackedInputs
  });
  verifyPackagedBenchmarkEvidence({
    benchmarkReport,
    candidateManifestEvidence: candidateManifestEvidence.file,
    vocabularyEvidence,
    artifactSet,
    artifactDescriptor
  });
  const selectionResult = verifySelectionEvidence({
    repoRoot,
    candidateRoot,
    candidateManifest,
    candidateManifestEvidence: candidateManifestEvidence.file,
    exportReport,
    exportEvidence: exportEvidence.file,
    evaluationEvidence: evaluationEvidence.file,
    benchmarkEvidence: benchmarkEvidence.file,
    selectionReport,
    artifactDescriptor,
    goldEvidence,
    trackedInputs
  });
  const rareScalarEvidence = verifyRareScalarEvidence({
    repoRoot,
    candidateRoot,
    reportPath: rareScalarReportPath,
    candidateManifest,
    candidateManifestEvidence: candidateManifestEvidence.file,
    exportReport,
    exportEvidence: exportEvidence.file,
    artifactDescriptor,
    checkpointEvidence,
    goldEvidence,
    selectionResult,
    trackedInputs
  });

  const metrics = exactRecord(evaluationReport.metrics, "Evaluation report metrics");
  const performance = productionPerformanceFromBenchmark(benchmarkReport);
  const productionManifest = structuredClone(candidateManifest);
  productionManifest.productionEligible = true;
  productionManifest.metrics = structuredClone(metrics);
  productionManifest.performance = structuredClone(performance);
  productionManifest.evaluationReports = [
    portableRelative(repoRoot, evaluationReportPath)
  ];
  productionManifest.benchmarkReports = [portableRelative(repoRoot, benchmarkReportPath)];
  rewriteSplitArtifactPaths(productionManifest, repoRoot, productionDir, artifactSet);

  const promotionIdentity = {
    trainingRunId: candidateManifest.trainingRunId,
    exportRunId: candidateManifest.exportRunId,
    candidateManifestSha256: candidateManifestEvidence.file.sha256,
    exportReportSha256: exportEvidence.file.sha256,
    evaluationReportSha256: evaluationEvidence.file.sha256,
    benchmarkReportSha256: benchmarkEvidence.file.sha256,
    selectionReportSha256: selectionEvidence.file.sha256,
    selectionId: selectionResult.selectionId,
    candidateSpecificationSha256: selectionResult.specification.sha256,
    comparisonReportSha256: selectionResult.comparisonReport.sha256,
    comparisonPredictionsSha256: selectionResult.comparisonPredictions.sha256,
    comparisonBenchmarkManifestSha256:
      selectionResult.benchmarkManifest.sha256,
    predictionsSha256: goldEvidence.predictions.sha256,
    goldManifestSha256: goldEvidence.manifest.file.sha256,
    goldCorpusSha256: goldEvidence.manifest.value.corpusSha256,
    datasetManifestSha256: goldEvidence.dataset.file.sha256,
    datasetContentSha256: goldEvidence.dataset.value.datasetContentSha256,
    rareScalarReportSha256:
      rareScalarEvidence?.report.file.sha256 ?? null,
    rareScalarGenerationReportSha256:
      rareScalarEvidence?.generationReport.file.sha256 ?? null,
    rareScalarPredictionsSha256:
      rareScalarEvidence?.predictions.sha256 ?? null,
    rareScalarContractSha256:
      rareScalarEvidence?.contract.file.sha256 ?? null,
    rareScalarCTCAuditSha256:
      rareScalarEvidence?.ctcAudit.file.sha256 ?? null,
    vocabularySha256: vocabularyEvidence.sha256,
    artifactSetSha256: artifactDescriptor.artifactSetSha256,
    checkpointSha256: checkpointEvidence.sha256,
    artifacts: Object.fromEntries(
      artifactSet.artifacts.map((artifact) => [
        artifact.id,
        artifact.evidence.sha256
      ])
    )
  };
  const promotionId =
    computeNeuralProductionPromotionIdFromIdentity(promotionIdentity);
  const parent = dirname(productionDir);
  assertSafeExistingDirectory(repoRoot, parent, "Production artifact parent");
  if (existsSync(productionDir)) {
    assertNoSymlinkComponents(repoRoot, productionDir, "Existing production directory");
    const existing = lstatSync(productionDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      fail("Existing production destination must be a real directory.");
    }
  }

  const nonce = `${process.pid}-${randomUUID()}`;
  const stagingDir = join(parent, `.${basename(productionDir)}.${nonce}.staging`);
  const backupDir = join(parent, `.${basename(productionDir)}.${nonce}.backup`);
  if (existsSync(stagingDir) || existsSync(backupDir)) {
    fail("Promotion staging or backup path unexpectedly already exists.");
  }

  let movedExisting = false;
  let published = false;
  let promotionReport;
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    const stagedArtifacts = stageCanonicalArtifacts(
      repoRoot,
      stagingDir,
      vocabularyEvidence,
      artifactSet
    );
    const stagedManifestPath = join(stagingDir, PRODUCTION_MANIFEST_NAME);
    writeExclusiveJson(stagedManifestPath, productionManifest);
    const stagedManifestEvidence = inspectContainedRegularFile(repoRoot, stagedManifestPath, {
      label: "Staged production manifest",
      includeContents: true,
      maxBytes: 4 * 1024 * 1024
    });

    promotionReport = {
      schemaVersion: NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION,
      status: "passed-neural-candidate-promotion",
      generatedAt: now(),
      promotionId,
      trainingRunId: candidateManifest.trainingRunId,
      exportRunId: candidateManifest.exportRunId,
      candidateImmutable: true,
      candidateRoot: portableRelative(repoRoot, candidateRoot),
      productionDirectory: portableRelative(repoRoot, productionDir),
      artifactLayout: artifactSet.kind,
      inputs: {
        candidateManifest: evidenceRecord(repoRoot, candidateManifestEvidence.file),
        exportReport: evidenceRecord(repoRoot, exportEvidence.file),
        evaluationReport: evidenceRecord(repoRoot, evaluationEvidence.file),
        benchmarkReport: evidenceRecord(repoRoot, benchmarkEvidence.file),
        selectionReport: evidenceRecord(repoRoot, selectionEvidence.file),
        selectionId: selectionResult.selectionId,
        candidateSpecification: evidenceRecord(
          repoRoot,
          selectionResult.specification
        ),
        comparisonReport: evidenceRecord(
          repoRoot,
          selectionResult.comparisonReport
        ),
        comparisonPredictions: evidenceRecord(
          repoRoot,
          selectionResult.comparisonPredictions
        ),
        comparisonBenchmarkManifest: evidenceRecord(
          repoRoot,
          selectionResult.benchmarkManifest
        ),
        predictions: evidenceRecord(repoRoot, goldEvidence.predictions),
        goldManifest: evidenceRecord(repoRoot, goldEvidence.manifest.file),
        goldCorpusSha256: goldEvidence.manifest.value.corpusSha256,
        datasetManifest: evidenceRecord(repoRoot, goldEvidence.dataset.file),
        datasetContentSha256: goldEvidence.dataset.value.datasetContentSha256,
        checkpoint: evidenceRecord(repoRoot, checkpointEvidence),
        vocabulary: evidenceRecord(repoRoot, vocabularyEvidence)
      },
      rareScalarEvidence: rareScalarEvidence
        ? {
            report: evidenceRecord(
              repoRoot,
              rareScalarEvidence.report.file
            ),
            generationReport: evidenceRecord(
              repoRoot,
              rareScalarEvidence.generationReport.file
            ),
            predictions: evidenceRecord(
              repoRoot,
              rareScalarEvidence.predictions
            ),
            contract: evidenceRecord(
              repoRoot,
              rareScalarEvidence.contract.file
            ),
            ctcAudit: evidenceRecord(
              repoRoot,
              rareScalarEvidence.ctcAudit.file
            )
          }
        : null,
      artifactSetSha256: artifactDescriptor.artifactSetSha256,
      artifacts: stagedArtifacts
        .filter((artifact) => artifact.id !== "vocabulary")
        .map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        artifactKind: artifact.artifactKind,
        kind: artifact.kind,
        source: portableRelative(repoRoot, artifact.source),
        destination: portableRelative(
          repoRoot,
          join(productionDir, artifact.destinationName)
        ),
        bytes: artifact.stagedEvidence.bytes,
        sha256: artifact.stagedEvidence.sha256
      })),
      productionManifest: {
        path: portableRelative(repoRoot, join(productionDir, PRODUCTION_MANIFEST_NAME)),
        bytes: stagedManifestEvidence.bytes,
        sha256: stagedManifestEvidence.sha256,
        metricsSourceSha256: evaluationEvidence.file.sha256,
        performanceSourceSha256: benchmarkEvidence.file.sha256
      }
    };
    const stagedPromotionReportPath = join(stagingDir, PROMOTION_REPORT_NAME);
    writeExclusiveJson(stagedPromotionReportPath, promotionReport);
    const stagedPromotionReportEvidence = inspectContainedRegularFile(
      repoRoot,
      stagedPromotionReportPath,
      {
        label: "Staged neural promotion report",
        includeContents: true,
        maxBytes: 4 * 1024 * 1024
      }
    );

    assertTrackedInputsUnchanged(repoRoot, trackedInputs);
    fsyncTree(stagingDir);
    hooks.beforePublish?.({ stagingDir, productionDir, backupDir });
    if (existsSync(productionDir)) {
      renameSync(productionDir, backupDir);
      movedExisting = true;
    }
    hooks.afterBackup?.({ stagingDir, productionDir, backupDir });
    renameSync(stagingDir, productionDir);
    published = true;
    hooks.afterPublish?.({ productionDir, backupDir });

    verifyPublishedBundle({
      repoRoot,
      productionDir,
      artifactSet,
      vocabularyEvidence,
      manifestEvidence: stagedManifestEvidence,
      reportEvidence: stagedPromotionReportEvidence
    });
    assertTrackedInputsUnchanged(repoRoot, trackedInputs);
  } catch (error) {
    const rollbackFailures = [];
    if (published && existsSync(productionDir)) {
      try {
        safeRemoveSiblingDirectory(productionDir, parent);
      } catch (rollbackError) {
        rollbackFailures.push(`remove new production directory: ${errorMessage(rollbackError)}`);
      }
    }
    if (movedExisting && existsSync(backupDir)) {
      try {
        renameSync(backupDir, productionDir);
      } catch (rollbackError) {
        rollbackFailures.push(`restore previous production directory: ${errorMessage(rollbackError)}`);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new NeuralCandidatePromotionError(
        `Promotion failed and rollback was incomplete (${rollbackFailures.join("; ")}): ${errorMessage(error)}`
      );
    }
    throw error instanceof NeuralCandidatePromotionError
      ? error
      : new NeuralCandidatePromotionError(`Promotion failed safely: ${errorMessage(error)}`);
  } finally {
    if (existsSync(stagingDir)) safeRemoveSiblingDirectory(stagingDir, parent);
  }

  if (movedExisting && existsSync(backupDir)) {
    safeRemoveSiblingDirectory(backupDir, parent);
  }
  return Object.freeze({
    status: promotionReport.status,
    promotionId,
    trainingRunId: promotionReport.trainingRunId,
    exportRunId: promotionReport.exportRunId,
    productionDir,
    manifest: join(productionDir, PRODUCTION_MANIFEST_NAME),
    report: join(productionDir, PROMOTION_REPORT_NAME),
    artifactLayout: artifactSet.kind
  });
}

function validateRunIdentities(manifest, exportReport, evaluation, benchmark) {
  const trainingRunId = requireRunId(manifest.trainingRunId, "Candidate manifest trainingRunId");
  const exportRunId = requireRunId(manifest.exportRunId, "Candidate manifest exportRunId");
  if (trainingRunId === exportRunId) {
    fail("Candidate trainingRunId and exportRunId must identify distinct runs.");
  }
  const bindings = [
    ["Candidate export report", exportReport.trainingRunId, exportReport.exportRunId],
    ["Production evaluation report", evaluation.trainingRunId, evaluation.exportRunId],
    [
      "Packaged benchmark artifact identity",
      benchmark.artifactIdentity?.trainingRunId,
      benchmark.artifactIdentity?.exportRunId
    ]
  ];
  for (const [label, observedTrainingRunId, observedExportRunId] of bindings) {
    if (requireRunId(observedTrainingRunId, `${label} trainingRunId`) !== trainingRunId ||
        requireRunId(observedExportRunId, `${label} exportRunId`) !== exportRunId) {
      fail(`${label} does not bind the candidate trainingRunId/exportRunId.`);
    }
  }
}

function verifyCheckpoint(repoRoot, candidateRoot, manifest, exportReport, trackedInputs) {
  const checkpointPath = declaredCandidatePath(
    repoRoot,
    candidateRoot,
    exportReport.checkpoint,
    "Export report checkpoint"
  );
  const checkpoint = trackFile(
    repoRoot,
    checkpointPath,
    "Candidate checkpoint",
    trackedInputs,
    { maxBytes: 512 * 1024 * 1024 }
  );
  const expected = requireSha256(exportReport.checkpointSha256, "Export report checkpointSha256");
  const manifestExpected = requireSha256(
    manifest.sha256?.sourceCheckpoint,
    "Candidate manifest sha256.sourceCheckpoint"
  );
  if (checkpoint.sha256 !== expected || checkpoint.sha256 !== manifestExpected) {
    fail("Candidate checkpoint bytes do not match export and manifest source-checkpoint identities.");
  }
  return checkpoint;
}

function verifyEvaluationEvidence({
  repoRoot,
  candidateRoot,
  exportReport,
  evaluationReport,
  trackedInputs
}) {
  if (evaluationReport.production !== true ||
      evaluationReport.productionEligible !== true ||
      !String(evaluationReport.status ?? "").startsWith("passed-production-")) {
    fail("Evaluation evidence must be a passed production evaluation.");
  }
  if (Array.isArray(evaluationReport.failures) && evaluationReport.failures.length > 0) {
    fail("Evaluation evidence contains unresolved failures.");
  }
  if (evaluationReport.predictionValidation?.exactCoverage !== true ||
      evaluationReport.predictionValidation?.metricsReportable !== true) {
    fail("Evaluation evidence must prove exact, reportable prediction coverage.");
  }

  const predictionsPath = declaredCandidatePath(
    repoRoot,
    candidateRoot,
    evaluationReport.predictions,
    "Evaluation predictions"
  );
  const predictions = trackFile(
    repoRoot,
    predictionsPath,
    "Exact Core ML predictions",
    trackedInputs,
    {
      includeContents: true,
      maxBytes: 256 * 1024 * 1024
    }
  );
  const evaluationPredictionsSha = requireSha256(
    evaluationReport.predictionsSha256,
    "Evaluation predictionsSha256"
  );
  const exportPredictionsSha = requireSha256(
    exportReport.predictionsSha256,
    "Export report predictionsSha256"
  );
  if (predictions.sha256 !== evaluationPredictionsSha ||
      predictions.sha256 !== exportPredictionsSha ||
      resolveDeclaredPath(repoRoot, exportReport.predictions, "Export predictions") !== predictionsPath) {
    fail("Evaluation predictions are not the exact candidate export predictions.");
  }

  const goldManifestPath = resolveDeclaredPath(
    repoRoot,
    evaluationReport.goldManifest,
    "Evaluation gold manifest"
  );
  const goldManifest = readJsonEvidence(
    repoRoot,
    goldManifestPath,
    "Production gold manifest",
    trackedInputs
  );
  const evaluationGoldManifestSha = requireSha256(
    evaluationReport.goldManifestSha256,
    "Evaluation goldManifestSha256"
  );
  const exportGoldManifestSha = requireSha256(
    exportReport.goldManifestSha256,
    "Export report goldManifestSha256"
  );
  if (goldManifest.file.sha256 !== evaluationGoldManifestSha ||
      goldManifest.file.sha256 !== exportGoldManifestSha ||
      resolveDeclaredPath(repoRoot, exportReport.goldManifest, "Export gold manifest") !== goldManifestPath) {
    fail("Evaluation gold manifest is not the exact candidate export gold manifest.");
  }
  const goldCorpusSha256 = requireSha256(
    goldManifest.value.corpusSha256,
    "Gold manifest corpusSha256"
  );
  if (evaluationReport.goldCorpusSha256 !== goldCorpusSha256 ||
      exportReport.goldCorpusSha256 !== goldCorpusSha256) {
    fail("Evaluation and export reports do not bind the gold corpus identity.");
  }
  const rows = loadLockedEvaluationRows({
    repoRoot,
    manifest: goldManifest.value,
    label: "Gold",
    trackedInputs
  });

  if (!Number.isSafeInteger(evaluationReport.goldRows) ||
      evaluationReport.goldRows < 1 ||
      evaluationReport.goldRows !== exportReport.goldRows ||
      evaluationReport.goldRows !== rows.length) {
    fail("Evaluation and export reports must bind the same positive goldRows count.");
  }

  const datasetManifestPath = resolveDeclaredPath(
    repoRoot,
    evaluationReport.datasetManifest,
    "Evaluation dataset manifest"
  );
  const datasetManifest = readJsonEvidence(
    repoRoot,
    datasetManifestPath,
    "Training dataset manifest",
    trackedInputs
  );
  const snapshotDataset = exportReport.runInputSnapshot?.dataset;
  const datasetManifestSha256 = requireSha256(
    evaluationReport.datasetManifestSha256,
    "Evaluation datasetManifestSha256"
  );
  const datasetContentSha256 = requireSha256(
    datasetManifest.value.datasetContentSha256,
    "Dataset manifest datasetContentSha256"
  );
  if (datasetManifest.file.sha256 !== datasetManifestSha256 ||
      resolveDeclaredPath(
        repoRoot,
        snapshotDataset?.manifest,
        "Export dataset snapshot manifest"
      ) !== datasetManifestPath ||
      snapshotDataset?.manifestSha256 !== datasetManifestSha256 ||
      snapshotDataset?.contentSha256 !== datasetContentSha256 ||
      evaluationReport.datasetContentSha256 !== datasetContentSha256) {
    fail("Evaluation dataset identity does not match the candidate run-input snapshot.");
  }
  return {
    predictions,
    manifest: goldManifest,
    dataset: datasetManifest,
    rows
  };
}

function verifyRareScalarEvidence({
  repoRoot,
  candidateRoot,
  reportPath,
  candidateManifest,
  candidateManifestEvidence,
  exportReport,
  exportEvidence,
  artifactDescriptor,
  checkpointEvidence,
  goldEvidence,
  selectionResult,
  trackedInputs
}) {
  const isCTC = candidateManifest.selectedArtifact === CTC_MODEL_ID &&
    candidateManifest.runtimeModelContract === CTC_RUNTIME_CONTRACT;
  if (!isCTC) {
    if (reportPath !== null) {
      fail("Rare-scalar evidence is only valid for the Transformer-CTC candidate.");
    }
    return null;
  }
  if (reportPath === null) {
    fail(
      "Transformer-CTC promotion requires a passed rare-scalar evaluation report."
    );
  }
  assertWithin(
    candidateRoot,
    reportPath,
    "Rare-scalar evaluation report must remain inside the immutable candidate"
  );
  const report = readJsonEvidence(
    repoRoot,
    reportPath,
    "Rare-scalar evaluation report",
    trackedInputs
  );
  const value = report.value;
  const evaluation = exactRecord(
    value.evaluation,
    "Rare-scalar evaluation result"
  );
  if (
    value.schemaVersion !== 1 ||
    value.status !== RARE_SCALAR_STATUS ||
    value.productionEligible !== true ||
    value.modelId !== CTC_MODEL_ID ||
    value.trainingRunId !== candidateManifest.trainingRunId ||
    value.exportRunId !== candidateManifest.exportRunId ||
    !Array.isArray(value.failures) ||
    value.failures.length !== 0 ||
    !Array.isArray(value.warnings) ||
    evaluation.productionGatePassed !== true ||
    evaluation.status !== "passed-neural-rare-scalar-evaluation" ||
    !Array.isArray(evaluation.failures) ||
    evaluation.failures.length !== 0 ||
    !Array.isArray(evaluation.spuriousNonExemplarTop1) ||
    evaluation.spuriousNonExemplarTop1.length !== 0
  ) {
    fail("Transformer-CTC rare-scalar production evidence did not pass.");
  }
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.exportReport,
    expected: exportEvidence,
    label: "Rare-scalar export report"
  });
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.datasetManifest,
    expected: goldEvidence.dataset.file,
    label: "Rare-scalar dataset manifest"
  });
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.gold?.manifest,
    expected: goldEvidence.manifest.file,
    label: "Rare-scalar gold manifest"
  });
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.gold?.predictions,
    expected: goldEvidence.predictions,
    label: "Rare-scalar gold predictions"
  });
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.officialBenchmark?.manifest,
    expected: selectionResult.benchmarkManifest,
    label: "Rare-scalar official benchmark manifest"
  });
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.officialBenchmark?.predictions,
    expected: selectionResult.comparisonPredictions,
    label: "Rare-scalar official benchmark predictions"
  });
  if (
    value.datasetManifest?.contentSha256 !==
      goldEvidence.dataset.value.datasetContentSha256 ||
    value.gold?.corpusSha256 !== goldEvidence.manifest.value.corpusSha256 ||
    value.gold?.rows !== exportReport.goldRows ||
    value.officialBenchmark?.corpusSha256 !==
      exportReport.comparisonBenchmark?.corpusSha256 ||
    value.officialBenchmark?.rows !==
      exportReport.comparisonBenchmark?.rows ||
    evaluation.lockedEvaluationRows !==
      value.gold.rows + value.officialBenchmark.rows
  ) {
    fail("Rare-scalar report locked-corpus identities or row counts are stale.");
  }

  const generationPath = declaredCandidatePath(
    repoRoot,
    candidateRoot,
    value.generationReport?.path,
    "Rare-scalar generation report"
  );
  const generationReport = readJsonEvidence(
    repoRoot,
    generationPath,
    "Rare-scalar generation report",
    trackedInputs
  );
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.generationReport,
    expected: generationReport.file,
    label: "Rare-scalar generation report"
  });
  const predictionsPath = declaredCandidatePath(
    repoRoot,
    candidateRoot,
    value.probePredictions?.path,
    "Rare-scalar probe predictions"
  );
  const predictions = trackFile(
    repoRoot,
    predictionsPath,
    "Rare-scalar probe predictions",
    trackedInputs,
    { includeContents: true, maxBytes: 16 * 1024 * 1024 }
  );
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.probePredictions,
    expected: predictions,
    label: "Rare-scalar probe predictions"
  });

  const contractPath = resolveDeclaredPath(
    repoRoot,
    value.contract?.path,
    "Rare-scalar contract"
  );
  const contract = readJsonEvidence(
    repoRoot,
    contractPath,
    "Rare-scalar contract",
    trackedInputs
  );
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.contract,
    expected: contract.file,
    label: "Rare-scalar contract"
  });
  const ctcAuditPath = resolveDeclaredPath(
    repoRoot,
    value.ctcAudit?.path,
    "Rare-scalar CTC audit"
  );
  const ctcAudit = readJsonEvidence(
    repoRoot,
    ctcAuditPath,
    "Rare-scalar CTC audit",
    trackedInputs
  );
  verifyEmbeddedEvidenceRecord({
    repoRoot,
    record: value.ctcAudit,
    expected: ctcAudit.file,
    label: "Rare-scalar CTC audit"
  });
  const contractValidation = validateNeuralRareScalarContract({
    contract: contract.value,
    ctcAudit: ctcAudit.value,
    ctcAuditPath: portableRelative(repoRoot, ctcAudit.file.path),
    ctcAuditSha256: ctcAudit.file.sha256,
    datasetManifest: goldEvidence.dataset.value,
    datasetManifestPath: portableRelative(
      repoRoot,
      goldEvidence.dataset.file.path
    ),
    datasetManifestSha256: goldEvidence.dataset.file.sha256
  });
  if (!contractValidation.ok) {
    fail(
      "Rare-scalar contract is stale: " +
      contractValidation.failures.join("; ")
    );
  }

  const predictionRows = parsePredictionRows(
    predictions.contents,
    "Rare-scalar predictions"
  );
  const expectedProbes = contract.value.scalars.flatMap((record) =>
    record.probes.map((probe) => ({
      id: probe.id,
      input: probe.input
    }))
  );
  if (
    canonicalJson(predictionRows.map(({ id, input }) => ({ id, input }))) !==
      canonicalJson(expectedProbes) ||
    value.probePredictions?.rows !== predictionRows.length ||
    evaluation.probeRows !== predictionRows.length
  ) {
    fail("Rare-scalar predictions do not exactly cover the frozen probes.");
  }
  const recomputedEvaluation = evaluateNeuralRareScalarEvidence({
    contract: contract.value,
    probePredictions: predictionRows,
    lockedEvaluations: [
      {
        label: "gold",
        rows: goldEvidence.rows,
        predictions: parsePredictionRows(
          goldEvidence.predictions.contents,
          "Gold predictions"
        )
      },
      {
        label: "official-benchmark",
        rows: selectionResult.benchmarkRows,
        predictions: parsePredictionRows(
          selectionResult.comparisonPredictions.contents,
          "Official benchmark predictions"
        )
      }
    ]
  });
  if (
    canonicalJson(recomputedEvaluation) !== canonicalJson(evaluation) ||
    canonicalJson(recomputedEvaluation.warnings) !==
      canonicalJson(value.warnings)
  ) {
    fail(
      "Rare-scalar evaluation report does not match independent " +
      "recomputation from locked prediction evidence."
    );
  }

  const generation = generationReport.value;
  const compiled = artifactDescriptor.artifacts[0];
  if (
    generation.schemaVersion !== 1 ||
    generation.status !==
      "passed-neural-rare-scalar-prediction-generation" ||
    generation.modelId !== CTC_MODEL_ID ||
    generation.trainingRunId !== candidateManifest.trainingRunId ||
    generation.exportRunId !== candidateManifest.exportRunId ||
    generation.productionEligible !== false ||
    generation.predictionsBackend !==
      "coreml-compiled-transformer-ctc" ||
    generation.predictions?.sha256 !== predictions.sha256 ||
    generation.predictions?.rows !== predictionRows.length ||
    resolveDeclaredPath(
      repoRoot,
      generation.predictions?.path,
      "Generated rare-scalar predictions"
    ) !== predictions.path ||
    generation.contract?.sha256 !== contract.file.sha256 ||
    generation.contract?.ctcAuditSha256 !== ctcAudit.file.sha256 ||
    generation.candidate?.exportReportSha256 !== exportEvidence.sha256 ||
    generation.candidate?.manifestSha256 !== candidateManifestEvidence.sha256 ||
    generation.candidate?.checkpointSha256 !== checkpointEvidence.sha256 ||
    generation.candidate?.vocabularySha256 !==
      artifactDescriptor.vocabSha256 ||
    generation.candidate?.compiledModelSha256 !== compiled.compiledSha256 ||
    generation.candidate?.mlpackageSha256 !== exportReport.mlpackageSha256 ||
    generation.coremlValidation?.status !== "passed" ||
    generation.coremlValidation?.runtimeModelContract !==
      CTC_RUNTIME_CONTRACT ||
    generation.coremlValidation?.compiledModelSha256 !==
      compiled.compiledSha256 ||
    generation.coremlValidation?.mlpackageSha256 !==
      exportReport.mlpackageSha256
  ) {
    fail("Rare-scalar generation report is stale or artifact-substitutable.");
  }
  const identity = value.artifactIdentity;
  if (
    identity?.manifestSha256 !== candidateManifestEvidence.sha256 ||
    identity?.vocabSha256 !== artifactDescriptor.vocabSha256 ||
    identity?.artifactSetSha256 !== artifactDescriptor.artifactSetSha256 ||
    identity?.compiledModelSha256 !== compiled.compiledSha256 ||
    identity?.mlpackageSha256 !== exportReport.mlpackageSha256 ||
    identity?.checkpointSha256 !== checkpointEvidence.sha256
  ) {
    fail("Rare-scalar evaluation artifact identity differs from the candidate.");
  }
  return {
    report,
    generationReport,
    predictions,
    contract,
    ctcAudit
  };
}

function verifyEmbeddedEvidenceRecord({
  repoRoot,
  record,
  expected,
  label
}) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    resolveDeclaredPath(repoRoot, record.path, label) !== expected.path ||
    record.sha256 !== expected.sha256 ||
    record.bytes !== expected.bytes
  ) {
    fail(`${label} path, bytes, or SHA-256 is stale.`);
  }
}

function parsePredictionRows(contents, label) {
  const rows = parseJsonLineObjects(contents, label);
  const seen = new Set();
  return rows.map((row, index) => {
    if (
      canonicalJson(Object.keys(row).sort()) !==
        canonicalJson(["candidates", "id", "input"]) ||
      typeof row.id !== "string" ||
      !row.id ||
      seen.has(row.id) ||
      typeof row.input !== "string" ||
      !row.input ||
      !Array.isArray(row.candidates) ||
      row.candidates.length > 4
    ) {
      fail(`${label} row ${index + 1} is invalid.`);
    }
    seen.add(row.id);
    return row;
  });
}

function parseJsonLineObjects(contents, label) {
  const text = contents.toString("utf8");
  if (!text.endsWith("\n")) {
    fail(`${label} must end with a newline.`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) {
    fail(`${label} contains empty or missing rows.`);
  }
  return lines.map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      fail(
        `${label} row ${index + 1} is invalid JSON: ` +
        errorMessage(error)
      );
    }
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    ) {
      fail(`${label} row ${index + 1} must be an object.`);
    }
    return row;
  });
}

function loadLockedEvaluationRows({
  repoRoot,
  manifest,
  label,
  trackedInputs
}) {
  if (!Array.isArray(manifest.suites) || manifest.suites.length < 1) {
    fail(`${label} manifest must contain a non-empty suites inventory.`);
  }
  if (goldCorpusSha256(manifest.suites) !== manifest.corpusSha256) {
    fail(
      `${label} manifest corpusSha256 does not match its ordered suite inventory.`
    );
  }
  const seenSuites = new Set();
  const seenRows = new Set();
  const rows = [];
  for (const suite of manifest.suites) {
    if (!suite || typeof suite !== "object" ||
        typeof suite.id !== "string" || suite.id.length === 0 ||
        seenSuites.has(suite.id)) {
      fail(`${label} suite IDs must be unique non-empty strings.`);
    }
    seenSuites.add(suite.id);
    if (typeof suite.path !== "string" || isAbsolute(suite.path) ||
        suite.path.split(/[\\/]/u).includes("..")) {
      fail(
        `${label} suite ${suite.id} must use a canonical ` +
        "repository-relative path."
      );
    }
    const suitePath = resolve(repoRoot, suite.path);
    const evidence = trackFile(
      repoRoot,
      suitePath,
      `${label} suite ${suite.id}`,
      trackedInputs,
      { maxBytes: 64 * 1024 * 1024, includeContents: true }
    );
    if (
      evidence.sha256 !== requireSha256(
        suite.sha256,
        `${label} suite ${suite.id} sha256`
      )
    ) {
      fail(
        `${label} suite ${suite.id} bytes do not match its manifest identity.`
      );
    }
    const suiteRows = parseJsonLineObjects(
      evidence.contents,
      `${label} suite ${suite.id}`
    );
    if (!Number.isSafeInteger(suite.rows) ||
        suite.rows !== suiteRows.length) {
      fail(
        `${label} suite ${suite.id} row count does not match its manifest.`
      );
    }
    for (const row of suiteRows) {
      if (
        typeof row.id !== "string" ||
        !row.id ||
        seenRows.has(row.id) ||
        typeof row.input !== "string" ||
        !row.input
      ) {
        fail(`${label} suites contain an invalid or duplicate row identity.`);
      }
      seenRows.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

function discoverAndVerifyArtifacts({
  repoRoot,
  candidateRoot,
  candidateManifest,
  exportReport,
  trackedInputs
}) {
  if (candidateManifest.runtimeModelContract === "split-attention-incremental-v1" ||
      candidateManifest.compiledModels !== undefined) {
    return verifySplitArtifacts({
      repoRoot,
      candidateRoot,
      candidateManifest,
      exportReport,
      trackedInputs
    });
  }
  return verifyBaselineArtifacts({
    repoRoot,
    candidateRoot,
    candidateManifest,
    exportReport,
    trackedInputs
  });
}

function verifyBaselineArtifacts({
  repoRoot,
  candidateRoot,
  candidateManifest,
  exportReport,
  trackedInputs
}) {
  const ctcRuntime = candidateManifest.selectedArtifact === CTC_MODEL_ID;
  if (ctcRuntime) {
    if (candidateManifest.runtimeModelContract !== CTC_RUNTIME_CONTRACT ||
        exportReport.runtimeModelContract !== CTC_RUNTIME_CONTRACT ||
        candidateManifest.architecture !== "fixed-shape-transformer-ctc" ||
        !candidateManifest.tensorContract ||
        candidateManifest.compiledModels !== undefined ||
        candidateManifest.sha256?.compiledModels !== undefined ||
        candidateManifest.sha256?.mlpackages !== undefined) {
      fail(
        "Transformer-CTC promotion requires the closed single-transformer-ctc artifact branch."
      );
    }
    if (!isCTCFinitePathDecoderPolicy(
      exportReport.coremlExport?.finitePathDecoderPolicy
    )) {
      fail(
        "Transformer-CTC export lacks the exact finite-path decoder policy."
      );
    }
    if (!hasCTCCoreMLParityEvidence(exportReport.coremlExport)) {
      fail(
        "Transformer-CTC export lacks representative compiled Core ML parity evidence."
      );
    }
    if (canonicalJson(exportReport.coremlExport?.tensorContract) !==
        canonicalJson(candidateManifest.tensorContract) ||
        exportReport.coremlExport?.prePublicationValidation?.status !==
          "passed" ||
        exportReport.coremlExport?.artifactValidation?.status !== "passed" ||
        exportReport.coremlExport?.sourceCheckpointSha256 !==
          exportReport.checkpointSha256) {
      fail(
        "Transformer-CTC export lacks exact tensor, checkpoint, or published-artifact attestation."
      );
    }
  } else if (
    candidateManifest.runtimeModelContract !== undefined ||
    candidateManifest.tensorContract !== undefined ||
    candidateManifest.selectedArtifact !== "lekh-open-vocab-seq2seq-v1"
  ) {
    fail("Baseline promotion requires the closed single-seq2seq artifact branch.");
  }
  const compiledPath = declaredCandidatePath(
    repoRoot,
    candidateRoot,
    exportReport.compiledModel,
    "Export compiled model"
  );
  const compiled = trackDirectory(
    repoRoot,
    compiledPath,
    "Candidate compiled Core ML model",
    trackedInputs
  );
  const expectedCompiledSha = requireSha256(
    exportReport.compiledModelSha256,
    "Export compiledModelSha256"
  );
  if (compiled.sha256 !== expectedCompiledSha ||
      compiled.sha256 !== requireSha256(
        candidateManifest.sha256?.compiledModel,
        "Candidate manifest sha256.compiledModel"
      )) {
    fail("Compiled Core ML model bytes do not match candidate manifest/export identities.");
  }
  if (exportReport.coremlExport?.compiledModel !== exportReport.compiledModel ||
      exportReport.coremlExport?.compiledSha256 !== expectedCompiledSha) {
    fail("Candidate export report top-level and Core ML compiled-model identities differ.");
  }
  if (!Number.isSafeInteger(candidateManifest.modelBytes) ||
      candidateManifest.modelBytes !== compiled.bytes) {
    fail("Candidate manifest modelBytes does not match the compiled model.");
  }

  const artifacts = [{
    id: "compiledModel",
    role: "model",
    artifactKind: "compiledModel",
    kind: "directory",
    source: compiledPath,
    destinationName: BASELINE_COMPILED_NAME,
    evidence: compiled
  }];
  const packagePathValue = exportReport.mlpackage;
  const packageShaValue = exportReport.mlpackageSha256;
  if ((packagePathValue === null || packagePathValue === undefined) !==
      (packageShaValue === null || packageShaValue === undefined)) {
    fail("Export report must declare both mlpackage and mlpackageSha256 or neither.");
  }
  if (packagePathValue !== null && packagePathValue !== undefined) {
    const packagePath = declaredCandidatePath(
      repoRoot,
      candidateRoot,
      packagePathValue,
      "Export Core ML package"
    );
    const packageEvidence = trackDirectory(
      repoRoot,
      packagePath,
      "Candidate Core ML package",
      trackedInputs
    );
    if (packageEvidence.sha256 !== requireSha256(packageShaValue, "Export mlpackageSha256")) {
      fail("Core ML package bytes do not match the export report identity.");
    }
    if (exportReport.coremlExport?.mlpackage !== packagePathValue ||
        exportReport.coremlExport?.mlpackageSha256 !== packageEvidence.sha256) {
      fail("Candidate export report top-level and Core ML package identities differ.");
    }
    artifacts.push({
      id: "mlpackage",
      role: "model",
      artifactKind: "mlpackage",
      kind: "directory",
      source: packagePath,
      destinationName: BASELINE_PACKAGE_NAME,
      evidence: packageEvidence
    });
  }
  return { kind: "single-model", artifacts };
}

function verifySplitArtifacts({
  repoRoot,
  candidateRoot,
  candidateManifest,
  exportReport,
  trackedInputs
}) {
  if (candidateManifest.runtimeModelContract !== "split-attention-incremental-v1" ||
      exportReport.runtimeModelContract !== "split-attention-incremental-v1") {
    fail("Split-attention artifacts require matching split-attention runtime contracts.");
  }
  const roles = Object.keys(SPLIT_ARTIFACT_NAMES);
  if (!sameKeys(candidateManifest.compiledModels, roles) ||
      !sameKeys(exportReport.compiledModels, roles) ||
      !sameKeys(exportReport.coremlExport?.artifacts, roles) ||
      !sameKeys(candidateManifest.sha256?.compiledModels, roles) ||
      !sameKeys(candidateManifest.sha256?.mlpackages, roles)) {
    fail("Split-attention evidence must contain exactly encoder and decoderStep artifacts.");
  }
  const artifacts = [];
  let compiledBytes = 0;
  for (const role of roles) {
    const manifestArtifact = candidateManifest.compiledModels[role];
    const exportArtifact = exportReport.compiledModels[role];
    const coreMLArtifact = exportReport.coremlExport.artifacts[role];
    for (const kind of ["compiledModel", "mlpackage"]) {
      const hashField = kind === "compiledModel" ? "compiledSha256" : "mlpackageSha256";
      const bytesField = kind === "compiledModel" ? "compiledBytes" : "mlpackageBytes";
      const sourcePath = declaredCandidatePath(
        repoRoot,
        candidateRoot,
        manifestArtifact?.[kind],
        `Split ${role} ${kind}`
      );
      if (resolveDeclaredPath(
        repoRoot,
        exportArtifact?.[kind],
        `Export split ${role} ${kind}`
      ) !== sourcePath) {
        fail(`Split ${role} ${kind} path differs between manifest and export report.`);
      }
      const evidence = trackDirectory(
        repoRoot,
        sourcePath,
        `Candidate split ${role} ${kind}`,
        trackedInputs
      );
      const expectedHash = requireSha256(
        manifestArtifact?.[hashField],
        `Split ${role} ${hashField}`
      );
      if (evidence.sha256 !== expectedHash ||
          exportArtifact?.[hashField] !== expectedHash ||
          coreMLArtifact?.[hashField] !== expectedHash ||
          candidateManifest.sha256[kind === "compiledModel" ? "compiledModels" : "mlpackages"][role] !== expectedHash) {
        fail(`Split ${role} ${kind} bytes do not match all declared identities.`);
      }
      if (!Number.isSafeInteger(manifestArtifact?.[bytesField]) ||
          manifestArtifact[bytesField] !== evidence.bytes ||
          exportArtifact?.[bytesField] !== evidence.bytes ||
          coreMLArtifact?.[bytesField] !== evidence.bytes) {
        fail(`Split ${role} ${kind} byte count does not match its evidence.`);
      }
      if (kind === "compiledModel") compiledBytes += evidence.bytes;
      artifacts.push({
        id: `${role}.${kind}`,
        role,
        artifactKind: kind,
        kind: "directory",
        source: sourcePath,
        destinationName: SPLIT_ARTIFACT_NAMES[role][kind],
        evidence
      });
    }
  }
  if (!Number.isSafeInteger(candidateManifest.modelBytes) ||
      candidateManifest.modelBytes !== compiledBytes) {
    fail("Split candidate manifest modelBytes does not match both compiled models.");
  }
  return { kind: "split-attention", artifacts };
}

function verifyPackagedBenchmarkEvidence({
  benchmarkReport,
  candidateManifestEvidence,
  vocabularyEvidence,
  artifactSet,
  artifactDescriptor
}) {
  if (benchmarkReport.status !== "passed-candidate-promotion-evidence" ||
      benchmarkReport.proofMode !== "candidate-promotion" ||
      benchmarkReport.singleForwardBenchmarkIsConsumerLatency !== false) {
    fail(
      "Benchmark evidence must be a passed candidate-promotion full-candidate " +
      "service benchmark."
    );
  }
  if (Array.isArray(benchmarkReport.failures) && benchmarkReport.failures.length > 0) {
    fail("Benchmark evidence contains unresolved failures.");
  }
  const devices = Array.isArray(benchmarkReport.devices)
    ? benchmarkReport.devices
    : benchmarkReport.performance?.devices;
  if (!Array.isArray(devices) || devices.length < 1 ||
      devices.some((device) =>
        device?.packagedApp !== true ||
        device?.measurementKind !== "full-candidate-generation"
      )) {
    fail("Benchmark evidence must contain packaged full-candidate-generation device measurements.");
  }
  if (benchmarkReport.computePlacement?.neuralEngineClaimAllowed !== true ||
      !Array.isArray(benchmarkReport.computePlacement?.architectures) ||
      !benchmarkReport.computePlacement.architectures.includes("arm64")) {
    fail("Candidate benchmark must prove Neural Engine placement on Apple Silicon.");
  }
  const runtimePlacement = validateNeuralRuntimePlacementEvidence(
    benchmarkReport.computePlacement?.runtimePlacement,
    { artifactDescriptor }
  );
  if (!runtimePlacement.neuralEngineClaimAllowed) {
    fail(
      "Candidate benchmark requires observed Neural Engine execution from " +
      "a correlated Core ML Instruments trace for the exact artifact set."
    );
  }
  const deviceValidation = validateNeuralDeviceMeasurements(devices, {
    artifactDescriptor,
    production: true
  });
  if (!deviceValidation.valid ||
      deviceValidation.neuralEngineCompatibilityIndicated !== true) {
    fail(
      `Candidate benchmark device evidence is invalid: ` +
      `${deviceValidation.issueCodes.join(", ")}.`
    );
  }
  const identity = benchmarkReport.artifactIdentity;
  if (!identity || typeof identity !== "object" ||
      identity.manifestSha256 !== candidateManifestEvidence.sha256 ||
      identity.vocabSha256 !== vocabularyEvidence.sha256 ||
      identity.artifactSetSha256 !== artifactDescriptor.artifactSetSha256) {
    fail(
      "Packaged benchmark artifact identity does not bind the candidate " +
      "manifest, vocabulary, and complete runtime artifact set."
    );
  }
  const compiledArtifacts = artifactSet.artifacts.filter((artifact) =>
    artifact.id === "compiledModel" || artifact.artifactKind === "compiledModel"
  );
  if (artifactSet.kind === "single-model") {
    if (identity.compiledModelSha256 !== compiledArtifacts[0].evidence.sha256) {
      fail("Packaged benchmark does not bind the candidate compiled model.");
    }
  } else {
    if (!sameKeys(identity.compiledModels, ["encoder", "decoderStep"])) {
      fail("Packaged benchmark split identity must bind encoder and decoderStep.");
    }
    for (const artifact of compiledArtifacts) {
      const value = identity.compiledModels[artifact.role];
      const observed = typeof value === "string" ? value : value?.compiledSha256;
      if (observed !== artifact.evidence.sha256) {
        fail(`Packaged benchmark does not bind split compiled model ${artifact.role}.`);
      }
    }
  }
}

function verifySelectionEvidence({
  repoRoot,
  candidateRoot,
  candidateManifest,
  candidateManifestEvidence,
  exportReport,
  exportEvidence,
  evaluationEvidence,
  benchmarkEvidence,
  selectionReport,
  artifactDescriptor,
  goldEvidence,
  trackedInputs
}) {
  const validated = validateNeuralSelectionReport(selectionReport);
  const winner = validated.winner;
  if (resolve(repoRoot, winner.candidateRoot) !== candidateRoot) {
    fail("Model-selection winner does not identify this immutable candidate directory.");
  }
  const identity = winner.identity;
  if (identity.trainingRunId !== candidateManifest.trainingRunId ||
      identity.exportRunId !== candidateManifest.exportRunId ||
      identity.manifestSha256 !== candidateManifestEvidence.sha256 ||
      identity.exportReportSha256 !== exportEvidence.sha256 ||
      identity.vocabSha256 !== artifactDescriptor.vocabSha256 ||
      identity.artifactSetSha256 !== artifactDescriptor.artifactSetSha256) {
    fail("Model-selection winner identity does not match this candidate artifact set.");
  }

  verifySelectionEvidenceRecord(
    repoRoot,
    winner.evidence.manifest,
    candidateManifestEvidence,
    "Model-selection winner manifest"
  );
  verifySelectionEvidenceRecord(
    repoRoot,
    winner.evidence.exportReport,
    exportEvidence,
    "Model-selection winner export report"
  );
  verifySelectionEvidenceRecord(
    repoRoot,
    winner.evidence.evaluationReport,
    evaluationEvidence,
    "Model-selection winner evaluation report"
  );
  verifySelectionEvidenceRecord(
    repoRoot,
    winner.evidence.benchmarkReport,
    benchmarkEvidence,
    "Model-selection winner packaged benchmark report"
  );
  verifySelectionEvidenceRecord(
    repoRoot,
    winner.evidence.datasetManifest,
    goldEvidence.dataset.file,
    "Model-selection winner dataset manifest"
  );
  verifySelectionEvidenceRecord(
    repoRoot,
    winner.evidence.goldManifest,
    goldEvidence.manifest.file,
    "Model-selection winner gold manifest"
  );

  const specification = trackSelectionEvidenceFile(
    repoRoot,
    winner.evidence.specification,
    "Winning candidate specification",
    trackedInputs
  );
  const comparisonEvidence = readJsonEvidence(
    repoRoot,
    resolveSelectionEvidencePath(
      repoRoot,
      winner.evidence.comparisonReport,
      "Winning official benchmark report"
    ),
    "Winning official benchmark report",
    trackedInputs
  );
  if (comparisonEvidence.file.sha256 !==
      winner.evidence.comparisonReport.sha256) {
    fail("Winning official benchmark report changed after model selection.");
  }
  const comparison = comparisonEvidence.value;
  if (comparison.status !== "passed-official-benchmark-evaluation" ||
      comparison.suite !== "neural-official-benchmark-evaluation" ||
      comparison.productionEligible !== true ||
      comparison.qualityGate?.passed !== true ||
      !Array.isArray(comparison.failures) ||
      comparison.failures.length !== 0 ||
      comparison.trainingRunId !== candidateManifest.trainingRunId ||
      comparison.exportRunId !== candidateManifest.exportRunId ||
      comparison.candidateManifestSha256 !==
        candidateManifestEvidence.sha256 ||
      comparison.artifactIdentity?.artifactSetSha256 !==
        artifactDescriptor.artifactSetSha256 ||
      comparison.artifactIdentity?.manifestSha256 !==
        candidateManifestEvidence.sha256 ||
      comparison.artifactIdentity?.vocabSha256 !==
        artifactDescriptor.vocabSha256) {
    fail("Winning official benchmark report is stale or no longer production eligible.");
  }
  const expectedBackend = neuralRuntimeContractMetadata(
    artifactDescriptor.runtimeModelContract
  ).predictionsBackend;
  const expectedPredictionArtifactIdentity = {
    runtimeModelContract: artifactDescriptor.runtimeModelContract,
    compiledArtifacts: Object.fromEntries(
      artifactDescriptor.artifacts.map((artifact) => [
        artifact.role,
        {
          path: portableRelative(repoRoot, artifact.sourcePath),
          sha256: artifact.compiledSha256,
          bytes: artifact.compiledBytes
        }
      ])
    )
  };
  const isolation = comparison.benchmarkIsolation;
  if (comparison.benchmarkManifest !==
        CANONICAL_OFFICIAL_BENCHMARK_MANIFEST ||
      comparison.benchmarkManifestSha256 !==
        CANONICAL_OFFICIAL_BENCHMARK_MANIFEST_SHA256 ||
      comparison.reference?.manifest !== CANONICAL_REFERENCE_MANIFEST ||
      comparison.reference?.manifestSha256 !==
        CANONICAL_REFERENCE_MANIFEST_SHA256 ||
      comparison.predictionsBackend !== expectedBackend ||
      canonicalJson(comparison.predictionArtifactIdentity) !==
        canonicalJson(expectedPredictionArtifactIdentity) ||
      canonicalJson(isolation) !== canonicalJson(
        exportReport.comparisonBenchmark?.trainingIsolation
      ) ||
      isolation?.policy !==
        "official-benchmark-inputs-absent-from-train-and-dev-v1" ||
      isolation?.overlappingInputCount !== 0 ||
      canonicalJson(isolation?.comparedSplitSha256) !== canonicalJson({
        train: exportReport.runInputSnapshot?.dataset?.splits?.train?.sha256,
        dev: exportReport.runInputSnapshot?.dataset?.splits?.dev?.sha256
      }) ||
      canonicalJson(
        exportReport.runInputSnapshot?.officialBenchmark?.trainingIsolation
      ) !== canonicalJson(isolation) ||
      exportReport.artifactOverrides?.officialBenchmarkManifest !==
        undefined) {
    fail(
      "Winning official benchmark evidence is substitutable, stale, or not " +
      "bound to the exact compiled candidate and training-isolation proof."
    );
  }

  const comparisonPredictions = trackSelectionEvidenceFile(
    repoRoot,
    winner.evidence.comparisonPredictions,
    "Winning official benchmark predictions",
    trackedInputs,
    {
      includeContents: candidateManifest.selectedArtifact === CTC_MODEL_ID,
      maxBytes: 64 * 1024 * 1024
    }
  );
  let benchmarkRows = null;
  let benchmarkManifest;
  if (candidateManifest.selectedArtifact === CTC_MODEL_ID) {
    const benchmarkManifestPath = resolveSelectionEvidencePath(
      repoRoot,
      winner.evidence.benchmarkManifest,
      "Winning official benchmark manifest"
    );
    const benchmarkManifestEvidence = readJsonEvidence(
      repoRoot,
      benchmarkManifestPath,
      "Winning official benchmark manifest",
      trackedInputs
    );
    benchmarkManifest = benchmarkManifestEvidence.file;
    if (
      benchmarkManifest.sha256 !==
      winner.evidence.benchmarkManifest.sha256
    ) {
      fail(
        "Winning official benchmark manifest changed after model selection."
      );
    }
    benchmarkRows = loadLockedEvaluationRows({
      repoRoot,
      manifest: benchmarkManifestEvidence.value,
      label: "Official benchmark",
      trackedInputs
    });
    if (
      benchmarkRows.length !== comparison.predictionRows ||
      benchmarkRows.length !== exportReport.comparisonBenchmark?.rows
    ) {
      fail(
        "Winning official benchmark row inventory differs from the " +
        "comparison and export evidence."
      );
    }
  } else {
    benchmarkManifest = trackSelectionEvidenceFile(
      repoRoot,
      winner.evidence.benchmarkManifest,
      "Winning official benchmark manifest",
      trackedInputs
    );
  }
  if (resolveDeclaredPath(
    repoRoot,
    comparison.predictions,
    "Official benchmark predictions path"
  ) !== comparisonPredictions.path ||
      comparison.predictionsSha256 !== comparisonPredictions.sha256 ||
      resolveDeclaredPath(
        repoRoot,
        comparison.benchmarkManifest,
        "Official benchmark manifest path"
      ) !== benchmarkManifest.path ||
      comparison.benchmarkManifestSha256 !== benchmarkManifest.sha256 ||
      winner.bindings.benchmarkManifestSha256 !== benchmarkManifest.sha256 ||
      winner.bindings.benchmarkCorpusSha256 !==
        comparison.benchmarkCorpusSha256) {
    fail("Winning official benchmark inputs do not match the selection receipt.");
  }
  if (benchmarkManifest.path !== resolve(
    repoRoot,
    CANONICAL_OFFICIAL_BENCHMARK_MANIFEST
  ) || benchmarkManifest.sha256 !==
      CANONICAL_OFFICIAL_BENCHMARK_MANIFEST_SHA256) {
    fail("Winning official benchmark manifest is not the canonical locked release.");
  }
  return {
    selectionId: validated.selectionId,
    specification,
    comparisonReport: comparisonEvidence.file,
    comparisonPredictions,
    benchmarkManifest,
    benchmarkRows
  };
}

function verifySelectionEvidenceRecord(
  repoRoot,
  record,
  expectedEvidence,
  label
) {
  const path = resolveSelectionEvidencePath(repoRoot, record, label);
  if (path !== expectedEvidence.path ||
      record.sha256 !== expectedEvidence.sha256) {
    fail(`${label} path or SHA-256 differs from the qualified input.`);
  }
}

function trackSelectionEvidenceFile(
  repoRoot,
  record,
  label,
  trackedInputs,
  options = {}
) {
  const path = resolveSelectionEvidencePath(repoRoot, record, label);
  const evidence = trackFile(
    repoRoot,
    path,
    label,
    trackedInputs,
    {
      includeContents: Boolean(options.includeContents),
      maxBytes: options.maxBytes ?? 16 * 1024 * 1024
    }
  );
  if (evidence.sha256 !== record.sha256) {
    fail(`${label} changed after model selection.`);
  }
  return evidence;
}

function resolveSelectionEvidencePath(repoRoot, record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail(`${label} evidence must be an object.`);
  }
  requireSha256(record.sha256, `${label} SHA-256`);
  return resolveDeclaredPath(repoRoot, record.path, label);
}

function productionPerformanceFromBenchmark(benchmarkReport) {
  const source = exactRecord(
    benchmarkReport.performance,
    "Benchmark report performance"
  );
  const p50Ms = Number(source.p50Ms);
  const p95Ms = Number(source.p95Ms);
  const p99Ms = Number(source.p99Ms);
  if (![p50Ms, p95Ms, p99Ms].every((value) =>
    Number.isFinite(value) && value >= 0 && value < 50
  ) || p50Ms > p95Ms || p95Ms > p99Ms) {
    fail("Benchmark percentiles must be ordered finite values below 50 ms.");
  }
  const sourceDevices = Array.isArray(benchmarkReport.devices)
    ? benchmarkReport.devices
    : source.devices;
  if (!Array.isArray(sourceDevices) || sourceDevices.length < 1) {
    fail("Benchmark report does not contain device measurements.");
  }
  const devices = sourceDevices.map((device) => {
    const normalized = {
      name: device?.name,
      macOS: device?.macOS,
      architecture: device?.architecture,
      packagedApp: device?.packagedApp,
      secureFieldInferenceCount: device?.secureFieldInferenceCount,
      p50Ms: device?.p50Ms,
      p95Ms: device?.p95Ms,
      p99Ms: device?.p99Ms,
      artifact: device?.artifact,
      measurementKind: device?.measurementKind
    };
    if (typeof normalized.name !== "string" || normalized.name.length === 0 ||
        typeof normalized.macOS !== "string" || normalized.macOS.length === 0 ||
        !["arm64", "x86_64"].includes(normalized.architecture) ||
        normalized.packagedApp !== true ||
        normalized.secureFieldInferenceCount !== 0 ||
        typeof normalized.artifact !== "string" || normalized.artifact.length === 0 ||
        normalized.measurementKind !== "full-candidate-generation" ||
        ![normalized.p50Ms, normalized.p95Ms, normalized.p99Ms].every((value) =>
          Number.isFinite(value) && value >= 0 && value < 50
        ) ||
        normalized.p50Ms > normalized.p95Ms ||
        normalized.p95Ms > normalized.p99Ms) {
      fail("Benchmark contains a device row that cannot enter the production manifest.");
    }
    return normalized;
  });
  if (!devices.some((device) => device.architecture === "arm64")) {
    fail("Production performance evidence requires an Apple Silicon device.");
  }
  return {
    p50Ms,
    p95Ms,
    p99Ms,
    targetP99Ms: 50,
    measuredOnDevice: true,
    devices
  };
}

function stageCanonicalArtifacts(repoRoot, stagingDir, vocabularyEvidence, artifactSet) {
  const results = [];
  const stagedVocabulary = join(stagingDir, VOCABULARY_NAME);
  copyFileSync(
    vocabularyEvidence.path,
    stagedVocabulary,
    constants.COPYFILE_EXCL
  );
  const stagedVocabularyEvidence = inspectContainedRegularFile(repoRoot, stagedVocabulary, {
    label: "Staged production vocabulary",
    maxBytes: 16 * 1024 * 1024
  });
  if (stagedVocabularyEvidence.sha256 !== vocabularyEvidence.sha256) {
    fail("Staged production vocabulary differs from the qualified candidate.");
  }
  results.push({
    id: "vocabulary",
    kind: "file",
    source: vocabularyEvidence.path,
    destinationName: VOCABULARY_NAME,
    sourceEvidence: vocabularyEvidence,
    stagedEvidence: stagedVocabularyEvidence
  });

  for (const artifact of artifactSet.artifacts) {
    const destination = join(stagingDir, artifact.destinationName);
    cpSync(artifact.source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    });
    const stagedEvidence = inspectContainedDirectoryTree(repoRoot, destination, {
      label: `Staged ${artifact.id}`,
      maxBytes: 64 * 1024 * 1024,
      maxEntries: 10_000
    });
    if (stagedEvidence.sha256 !== artifact.evidence.sha256 ||
        stagedEvidence.bytes !== artifact.evidence.bytes) {
      fail(`Staged ${artifact.id} differs from the qualified candidate.`);
    }
    results.push({
      ...artifact,
      sourceEvidence: artifact.evidence,
      stagedEvidence
    });
  }
  return results;
}

function rewriteSplitArtifactPaths(manifest, repoRoot, productionDir, artifactSet) {
  if (artifactSet.kind !== "split-attention") return;
  for (const artifact of artifactSet.artifacts) {
    manifest.compiledModels[artifact.role][artifact.artifactKind] =
      portableRelative(repoRoot, join(
        productionDir,
        artifact.destinationName
      ));
  }
}

function verifyPublishedBundle({
  repoRoot,
  productionDir,
  artifactSet,
  vocabularyEvidence,
  manifestEvidence,
  reportEvidence
}) {
  const manifest = inspectContainedRegularFile(
    repoRoot,
    join(productionDir, PRODUCTION_MANIFEST_NAME),
    { label: "Published production manifest", maxBytes: 4 * 1024 * 1024 }
  );
  const report = inspectContainedRegularFile(
    repoRoot,
    join(productionDir, PROMOTION_REPORT_NAME),
    { label: "Published promotion report", maxBytes: 4 * 1024 * 1024 }
  );
  const vocabulary = inspectContainedRegularFile(
    repoRoot,
    join(productionDir, VOCABULARY_NAME),
    { label: "Published production vocabulary", maxBytes: 16 * 1024 * 1024 }
  );
  if (manifest.sha256 !== manifestEvidence.sha256 ||
      report.sha256 !== reportEvidence.sha256 ||
      vocabulary.sha256 !== vocabularyEvidence.sha256) {
    fail("Published manifest, report, or vocabulary differs from staging.");
  }
  for (const artifact of artifactSet.artifacts) {
    const published = inspectContainedDirectoryTree(
      repoRoot,
      join(productionDir, artifact.destinationName),
      {
        label: `Published ${artifact.id}`,
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 10_000
      }
    );
    if (published.sha256 !== artifact.evidence.sha256 ||
        published.bytes !== artifact.evidence.bytes) {
      fail(`Published ${artifact.id} differs from the qualified candidate.`);
    }
  }
}

function readJsonEvidence(repoRoot, path, label, trackedInputs) {
  const file = trackFile(
    repoRoot,
    path,
    label,
    trackedInputs,
    { includeContents: true, maxBytes: 16 * 1024 * 1024 }
  );
  let value;
  try {
    value = JSON.parse(file.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain a JSON object.`);
  }
  return { file, value };
}

function trackFile(repoRoot, path, label, trackedInputs, options = {}) {
  assertNoSymlinkComponents(repoRoot, path, label);
  const evidence = inspectContainedRegularFile(repoRoot, path, {
    label,
    includeContents: Boolean(options.includeContents),
    maxBytes: options.maxBytes
  });
  trackedInputs.push({
    kind: "file",
    path,
    label,
    expected: evidence,
    maxBytes: options.maxBytes
  });
  return evidence;
}

function trackDirectory(repoRoot, path, label, trackedInputs) {
  assertNoSymlinkComponents(repoRoot, path, label);
  const evidence = inspectContainedDirectoryTree(repoRoot, path, {
    label,
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 10_000
  });
  trackedInputs.push({
    kind: "directory",
    path,
    label,
    expected: evidence
  });
  return evidence;
}

function assertTrackedInputsUnchanged(repoRoot, trackedInputs) {
  for (const input of trackedInputs) {
    assertNoSymlinkComponents(repoRoot, input.path, input.label);
    const observed = input.kind === "file"
      ? inspectContainedRegularFile(repoRoot, input.path, {
          label: input.label,
          maxBytes: input.maxBytes
        })
      : inspectContainedDirectoryTree(repoRoot, input.path, {
          label: input.label,
          maxBytes: 64 * 1024 * 1024,
          maxEntries: 10_000
        });
    if (observed.sha256 !== input.expected.sha256 ||
        observed.bytes !== input.expected.bytes) {
      fail(`${input.label} changed during promotion; candidate publication was refused.`);
    }
  }
}

function verifyDeclaredFileIdentity({
  repoRoot,
  candidateRoot,
  declaredPath,
  declaredSha256,
  expectedPath,
  expectedEvidence,
  label
}) {
  const observedPath = declaredCandidatePath(repoRoot, candidateRoot, declaredPath, label);
  if (observedPath !== expectedPath ||
      requireSha256(declaredSha256, `${label} SHA-256`) !== expectedEvidence.sha256) {
    fail(`${label} path or SHA-256 does not match the exact candidate input.`);
  }
}

function declaredCandidatePath(repoRoot, candidateRoot, value, label) {
  const path = resolveDeclaredPath(repoRoot, value, label);
  assertWithin(candidateRoot, path, `${label} must remain inside the immutable candidate directory`);
  return path;
}

function resolveDeclaredPath(repoRoot, value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must declare a non-empty path.`);
  }
  const path = resolve(repoRoot, value);
  assertWithin(repoRoot, path, `${label} escapes the repository`);
  return path;
}

function assertCandidateRoot(repoRoot, candidateRoot) {
  const generatedRoot = resolve(repoRoot, "data/generated");
  const temporaryRoot = resolve(repoRoot, ".tmp");
  if (!(isStrictlyWithin(generatedRoot, candidateRoot) ||
        isStrictlyWithin(temporaryRoot, candidateRoot))) {
    fail("Candidate directory must remain below data/generated or .tmp.");
  }
  assertSafeExistingDirectory(repoRoot, candidateRoot, "Candidate directory");
}

function assertProductionDestination(repoRoot, productionDir, candidateRoot) {
  const modelRoot = resolve(repoRoot, "models/macos");
  if (!isStrictlyWithin(modelRoot, productionDir)) {
    fail("Production directory must remain below models/macos.");
  }
  if (isWithin(candidateRoot, productionDir) || isWithin(productionDir, candidateRoot)) {
    fail("Production and immutable candidate directories must not overlap.");
  }
  assertWithin(repoRoot, productionDir, "Production directory escapes the repository");
}

function assertSafeExistingDirectory(repoRoot, path, label) {
  assertNoSymlinkComponents(repoRoot, path, label);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a real directory.`);
  }
}

function assertNoSymlinkComponents(repoRoot, path, label) {
  const root = resolve(repoRoot);
  const target = resolve(path);
  assertWithin(root, target, `${label} escapes the repository`);
  const child = relative(root, target);
  let current = root;
  for (const component of child.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) {
      fail(`${label} is missing: ${portableRelative(root, current)}.`);
    }
    if (lstatSync(current).isSymbolicLink()) {
      fail(`${label} contains a symbolic-link path component: ${portableRelative(root, current)}.`);
    }
  }
}

function canonicalDirectory(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) fail(`${label} does not exist: ${resolved}.`);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory.`);
  return realpathSync(resolved);
}

function resolveRequiredPath(repoRoot, value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} is required.`);
  }
  const path = resolve(repoRoot, value);
  assertWithin(repoRoot, path, `${name} escapes the repository`);
  return path;
}

function exactRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object; promotion never synthesizes missing measurements.`);
  }
  return value;
}

function requireRunId(value, label) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    fail(`${label} must be exactly 32 lowercase hexadecimal characters.`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be exactly 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function requirePassedStatus(value, label) {
  if (typeof value !== "string" || !value.startsWith("passed-")) {
    fail(`${label} must have a passed status.`);
  }
}

function sameKeys(value, expected) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function goldCorpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    for (const [value, terminator] of [
      [suite?.id, "\0"],
      [suite?.path, "\0"],
      [suite?.sha256, "\0"],
      [suite?.rows, "\n"]
    ]) {
      hash.update(String(value));
      hash.update(terminator);
    }
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeExclusiveJson(path, value) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  );
  try {
    const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncTree(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(path);
      continue;
    }
    if (!entry.isFile()) fail(`Staging contains a non-regular entry: ${path}.`);
    const descriptor = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  const descriptor = openSync(root, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function safeRemoveSiblingDirectory(path, approvedParent) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      dirname(resolve(path)) !== resolve(approvedParent)) {
    fail(`Refusing unsafe promotion cleanup path: ${path}.`);
  }
  rmSync(path, { recursive: true, force: false });
}

function evidenceRecord(repoRoot, evidence) {
  return {
    path: portableRelative(repoRoot, evidence.path),
    bytes: evidence.bytes,
    sha256: evidence.sha256
  };
}

function isWithin(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  return child === "" || (
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

function isStrictlyWithin(parent, candidate) {
  return resolve(parent) !== resolve(candidate) && isWithin(parent, candidate);
}

function assertWithin(parent, candidate, message) {
  if (!isWithin(parent, candidate)) fail(`${message}: ${candidate}.`);
}

function portableRelative(parent, candidate) {
  return relative(resolve(parent), resolve(candidate)).split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new NeuralCandidatePromotionError(message);
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`Unexpected positional argument: ${argument}.`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${name}.`);
    if (values.has(name)) fail(`Duplicate --${name} argument.`);
    values.set(name, value);
    index += 1;
  }
  const allowed = new Set([
    "candidate-dir",
    "candidate-manifest",
    "export-report",
    "evaluation-report",
    "rare-scalar-report",
    "benchmark-report",
    "selection-report",
    "vocabulary",
    "production-dir"
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) fail(`Unknown promotion argument --${name}.`);
  }
  return {
    candidateRoot: values.get("candidate-dir"),
    candidateManifest: values.get("candidate-manifest"),
    exportReport: values.get("export-report"),
    evaluationReport: values.get("evaluation-report"),
    rareScalarReport: values.get("rare-scalar-report"),
    benchmarkReport: values.get("benchmark-report"),
    selectionReport: values.get("selection-report"),
    vocabulary: values.get("vocabulary"),
    productionDir: values.get("production-dir")
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = promoteNeuralCandidate({
      repoRoot: process.cwd(),
      ...parseCli(process.argv.slice(2))
    });
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      promotionId: result.promotionId,
      productionDirectory: portableRelative(process.cwd(), result.productionDir),
      manifest: portableRelative(process.cwd(), result.manifest),
      report: portableRelative(process.cwd(), result.report),
      artifactLayout: result.artifactLayout
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
