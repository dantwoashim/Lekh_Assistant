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
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  validateNeuralDeviceMeasurements
} from "./lib/neural-device-measurements.mjs";

const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASELINE_COMPILED_NAME = "LekhNeuralTransliterator.mlmodelc";
const BASELINE_PACKAGE_NAME = "LekhNeuralTransliterator.mlpackage";
const VOCABULARY_NAME = "LekhNeuralTransliterator.vocab.json";
const PRODUCTION_MANIFEST_NAME = "LekhNeuralTransliterator.manifest.json";
const PROMOTION_REPORT_NAME = "neural-candidate-promotion-report.json";
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

  const metrics = exactRecord(evaluationReport.metrics, "Evaluation report metrics");
  const performance = productionPerformanceFromBenchmark(benchmarkReport);
  const productionManifest = structuredClone(candidateManifest);
  productionManifest.productionEligible = true;
  productionManifest.metrics = structuredClone(metrics);
  productionManifest.performance = structuredClone(performance);
  productionManifest.evaluationReports = [portableRelative(repoRoot, evaluationReportPath)];
  productionManifest.benchmarkReports = [portableRelative(repoRoot, benchmarkReportPath)];
  rewriteSplitArtifactPaths(productionManifest, repoRoot, productionDir, artifactSet);

  const promotionIdentity = {
    trainingRunId: candidateManifest.trainingRunId,
    exportRunId: candidateManifest.exportRunId,
    candidateManifestSha256: candidateManifestEvidence.file.sha256,
    exportReportSha256: exportEvidence.file.sha256,
    evaluationReportSha256: evaluationEvidence.file.sha256,
    benchmarkReportSha256: benchmarkEvidence.file.sha256,
    predictionsSha256: goldEvidence.predictions.sha256,
    goldManifestSha256: goldEvidence.manifest.file.sha256,
    goldCorpusSha256: goldEvidence.manifest.value.corpusSha256,
    datasetManifestSha256: goldEvidence.dataset.file.sha256,
    datasetContentSha256: goldEvidence.dataset.value.datasetContentSha256,
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
  const promotionId = sha256CanonicalJson(promotionIdentity);
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
      schemaVersion: 1,
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
        predictions: evidenceRecord(repoRoot, goldEvidence.predictions),
        goldManifest: evidenceRecord(repoRoot, goldEvidence.manifest.file),
        goldCorpusSha256: goldEvidence.manifest.value.corpusSha256,
        datasetManifest: evidenceRecord(repoRoot, goldEvidence.dataset.file),
        datasetContentSha256: goldEvidence.dataset.value.datasetContentSha256,
        checkpoint: evidenceRecord(repoRoot, checkpointEvidence),
        vocabulary: evidenceRecord(repoRoot, vocabularyEvidence)
      },
      artifactSetSha256: artifactDescriptor.artifactSetSha256,
      artifacts: stagedArtifacts.map((artifact) => ({
        id: artifact.id,
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
    { maxBytes: 256 * 1024 * 1024 }
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
  verifyGoldSuites(repoRoot, goldManifest.value, trackedInputs);

  if (!Number.isSafeInteger(evaluationReport.goldRows) || evaluationReport.goldRows < 1 ||
      evaluationReport.goldRows !== exportReport.goldRows) {
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
  return { predictions, manifest: goldManifest, dataset: datasetManifest };
}

function verifyGoldSuites(repoRoot, manifest, trackedInputs) {
  if (!Array.isArray(manifest.suites) || manifest.suites.length < 1) {
    fail("Gold manifest must contain a non-empty suites inventory.");
  }
  if (goldCorpusSha256(manifest.suites) !== manifest.corpusSha256) {
    fail("Gold manifest corpusSha256 does not match its ordered suite inventory.");
  }
  const seen = new Set();
  for (const suite of manifest.suites) {
    if (!suite || typeof suite !== "object" ||
        typeof suite.id !== "string" || suite.id.length === 0 || seen.has(suite.id)) {
      fail("Gold suite IDs must be unique non-empty strings.");
    }
    seen.add(suite.id);
    if (typeof suite.path !== "string" || isAbsolute(suite.path) ||
        suite.path.split(/[\\/]/u).includes("..")) {
      fail(`Gold suite ${suite.id} must use a canonical repository-relative path.`);
    }
    const suitePath = resolve(repoRoot, suite.path);
    const evidence = trackFile(
      repoRoot,
      suitePath,
      `Gold suite ${suite.id}`,
      trackedInputs,
      { maxBytes: 64 * 1024 * 1024, includeContents: true }
    );
    if (evidence.sha256 !== requireSha256(suite.sha256, `Gold suite ${suite.id} sha256`)) {
      fail(`Gold suite ${suite.id} bytes do not match its manifest identity.`);
    }
    const rows = evidence.contents
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .length;
    if (!Number.isSafeInteger(suite.rows) || suite.rows !== rows) {
      fail(`Gold suite ${suite.id} row count does not match its manifest.`);
    }
  }
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
  const deviceValidation = validateNeuralDeviceMeasurements(devices, {
    artifactDescriptor,
    production: true
  });
  if (!deviceValidation.valid ||
      deviceValidation.neuralEngineClaimAllowed !== true) {
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

function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
    "benchmark-report",
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
    benchmarkReport: values.get("benchmark-report"),
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
