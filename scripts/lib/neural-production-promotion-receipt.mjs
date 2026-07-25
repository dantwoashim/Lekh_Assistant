import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
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
import Ajv2020 from "ajv/dist/2020.js";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";
import {
  validateNeuralSelectionReport
} from "./neural-model-selection.mjs";

export const NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION = 2;

const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_NAME = "LekhNeuralTransliterator.manifest.json";
const VOCABULARY_NAME = "LekhNeuralTransliterator.vocab.json";
const RECEIPT_NAME = "neural-candidate-promotion-report.json";
const INPUT_KEYS = Object.freeze([
  "benchmarkReport",
  "candidateManifest",
  "candidateSpecification",
  "checkpoint",
  "comparisonBenchmarkManifest",
  "comparisonPredictions",
  "comparisonReport",
  "datasetContentSha256",
  "datasetManifest",
  "evaluationReport",
  "exportReport",
  "goldCorpusSha256",
  "goldManifest",
  "predictions",
  "selectionId",
  "selectionReport",
  "vocabulary"
]);
const JSON_INPUTS = new Set([
  "benchmarkReport",
  "candidateManifest",
  "candidateSpecification",
  "comparisonBenchmarkManifest",
  "comparisonReport",
  "datasetManifest",
  "evaluationReport",
  "exportReport",
  "goldManifest",
  "selectionReport",
  "vocabulary"
]);
const BASELINE_ARTIFACTS = Object.freeze({
  compiledModel: Object.freeze({
    role: "model",
    artifactKind: "compiledModel",
    destinationName: "LekhNeuralTransliterator.mlmodelc"
  }),
  mlpackage: Object.freeze({
    role: "model",
    artifactKind: "mlpackage",
    destinationName: "LekhNeuralTransliterator.mlpackage"
  })
});
const SPLIT_ARTIFACTS = Object.freeze({
  "encoder.compiledModel": Object.freeze({
    role: "encoder",
    artifactKind: "compiledModel",
    destinationName: "LekhNeuralTransliteratorEncoder.mlmodelc"
  }),
  "encoder.mlpackage": Object.freeze({
    role: "encoder",
    artifactKind: "mlpackage",
    destinationName: "LekhNeuralTransliteratorEncoder.mlpackage"
  }),
  "decoderStep.compiledModel": Object.freeze({
    role: "decoderStep",
    artifactKind: "compiledModel",
    destinationName: "LekhNeuralTransliteratorDecoderStep.mlmodelc"
  }),
  "decoderStep.mlpackage": Object.freeze({
    role: "decoderStep",
    artifactKind: "mlpackage",
    destinationName: "LekhNeuralTransliteratorDecoderStep.mlpackage"
  })
});

export class NeuralProductionPromotionReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralProductionPromotionReceiptError";
  }
}

/**
 * Reconstruct the canonical identity hashed by the atomic promoter.
 *
 * Schema v2 deliberately keeps the vocabulary in inputs.vocabulary and only
 * runtime/export model directories in artifacts. This makes the identity and
 * the receipt inventory identical, while artifactSetSha256 continues to bind
 * just the compiled runtime models and vocabulary through the descriptor.
 */
export function buildNeuralProductionPromotionIdentity(receipt) {
  requireRecord(receipt, "Neural promotion receipt");
  requireRecord(receipt.inputs, "Neural promotion receipt inputs");
  if (!Array.isArray(receipt.artifacts)) {
    fail("Neural promotion receipt artifacts must be an array.");
  }
  return deepFreeze({
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    candidateManifestSha256: receipt.inputs.candidateManifest?.sha256,
    exportReportSha256: receipt.inputs.exportReport?.sha256,
    evaluationReportSha256: receipt.inputs.evaluationReport?.sha256,
    benchmarkReportSha256: receipt.inputs.benchmarkReport?.sha256,
    selectionReportSha256: receipt.inputs.selectionReport?.sha256,
    selectionId: receipt.inputs.selectionId,
    candidateSpecificationSha256:
      receipt.inputs.candidateSpecification?.sha256,
    comparisonReportSha256: receipt.inputs.comparisonReport?.sha256,
    comparisonPredictionsSha256:
      receipt.inputs.comparisonPredictions?.sha256,
    comparisonBenchmarkManifestSha256:
      receipt.inputs.comparisonBenchmarkManifest?.sha256,
    predictionsSha256: receipt.inputs.predictions?.sha256,
    goldManifestSha256: receipt.inputs.goldManifest?.sha256,
    goldCorpusSha256: receipt.inputs.goldCorpusSha256,
    datasetManifestSha256: receipt.inputs.datasetManifest?.sha256,
    datasetContentSha256: receipt.inputs.datasetContentSha256,
    vocabularySha256: receipt.inputs.vocabulary?.sha256,
    artifactSetSha256: receipt.artifactSetSha256,
    checkpointSha256: receipt.inputs.checkpoint?.sha256,
    artifacts: Object.fromEntries(
      receipt.artifacts.map((artifact) => [
        artifact?.id,
        artifact?.sha256
      ])
    )
  });
}

export function computeNeuralProductionPromotionId(receipt) {
  return computeNeuralProductionPromotionIdFromIdentity(
    buildNeuralProductionPromotionIdentity(receipt)
  );
}

export function computeNeuralProductionPromotionIdFromIdentity(identity) {
  requireRecord(identity, "Neural production promotion identity");
  return sha256CanonicalJson(identity);
}

/**
 * Live verification of the complete promoted bundle and retained evidence
 * graph. Nothing in the returned summary is trusted from a prior Phase 9
 * report: all files are reopened, rehashed, and semantically cross-checked.
 */
export function verifyNeuralProductionPromotionReceipt(options = {}) {
  const repoRoot = canonicalDirectory(
    options.repoRoot ?? process.cwd(),
    "Repository root"
  );
  const productionDirectory = safePath(
    repoRoot,
    options.productionDirectory ??
      "models/macos/LekhNeuralTransliterator.production",
    "Production neural directory"
  );
  assertRealDirectory(productionDirectory, "Production neural directory");

  const manifestPath = join(productionDirectory, MANIFEST_NAME);
  const vocabularyPath = join(productionDirectory, VOCABULARY_NAME);
  const receiptPath = join(productionDirectory, RECEIPT_NAME);
  const manifestEvidence = readJsonEvidence(
    repoRoot,
    manifestPath,
    "Promoted runtime manifest",
    16 * 1024 * 1024
  );
  const receiptEvidence = readJsonEvidence(
    repoRoot,
    receiptPath,
    "Neural candidate promotion receipt",
    16 * 1024 * 1024
  );
  validateManifestSchema(
    repoRoot,
    manifestEvidence.value,
    options.manifestSchemaPath
  );

  const manifest = manifestEvidence.value;
  if (manifest.productionEligible !== true ||
      manifest.localOnly !== true ||
      manifest.neuralTailOnly !== true ||
      manifest.openVocabulary !== true) {
    fail(
      "Promoted manifest must be production-eligible, local-only, " +
      "neural-tail-only, and open-vocabulary."
    );
  }
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot,
    manifest,
    manifestPath,
    vocabPath: vocabularyPath,
    artifactDirectory: productionDirectory,
    verifyExportArtifacts: false
  });
  const receipt = receiptEvidence.value;
  validateReceiptShape({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    manifestEvidence: manifestEvidence.file,
    receiptPath
  });

  const retained = {};
  const retainedValues = {};
  for (const name of INPUT_KEYS) {
    if (["selectionId", "goldCorpusSha256", "datasetContentSha256"].includes(name)) {
      continue;
    }
    const evidence = verifyRetainedEvidence(
      repoRoot,
      receipt.inputs[name],
      `Retained promotion input ${name}`,
      { json: JSON_INPUTS.has(name) }
    );
    retained[name] = evidenceSummary(repoRoot, evidence.file);
    retainedValues[name] = evidence.value;
  }
  for (const name of ["goldCorpusSha256", "datasetContentSha256"]) {
    requireSha256(receipt.inputs[name], `Promotion receipt inputs.${name}`);
  }
  requireSha256(receipt.inputs.selectionId, "Promotion receipt inputs.selectionId");

  validateRetainedEvidenceGraph({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    manifest,
    retainedValues
  });
  const artifacts = verifyPromotedArtifacts({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    exportReport: retainedValues.exportReport
  });
  enforceClosedWorldBundle(productionDirectory, receipt);
  verifyProductionManifestDerivation({
    repoRoot,
    productionDirectory,
    receipt,
    manifest,
    retainedValues,
    artifacts
  });

  const reconstructedPromotionId =
    computeNeuralProductionPromotionId(receipt);
  if (reconstructedPromotionId !== receipt.promotionId) {
    fail("Promotion ID does not match the complete retained evidence graph.");
  }

  return deepFreeze({
    promotionId: receipt.promotionId,
    selectionId: receipt.inputs.selectionId,
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    modelId: descriptor.modelId,
    runtimeModelContract: descriptor.runtimeModelContract,
    artifactSetSha256: descriptor.artifactSetSha256,
    manifest: evidenceSummary(repoRoot, manifestEvidence.file),
    receipt: evidenceSummary(repoRoot, receiptEvidence.file),
    retainedInputs: retained,
    artifacts: artifacts.map(({ record }) => ({
      id: record.id,
      role: record.role,
      artifactKind: record.artifactKind,
      sha256: record.sha256,
      bytes: record.bytes
    })),
    closedWorldInventory: readdirSync(productionDirectory).sort()
  });
}

function validateReceiptShape({
  repoRoot,
  productionDirectory,
  receipt,
  descriptor,
  manifestEvidence,
  receiptPath
}) {
  requireExactKeys(
    receipt,
    [
      "schemaVersion",
      "status",
      "generatedAt",
      "promotionId",
      "trainingRunId",
      "exportRunId",
      "candidateImmutable",
      "candidateRoot",
      "productionDirectory",
      "artifactLayout",
      "inputs",
      "artifactSetSha256",
      "artifacts",
      "productionManifest"
    ],
    "Neural promotion receipt"
  );
  if (receipt.schemaVersion !==
        NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION ||
      receipt.status !== "passed-neural-candidate-promotion" ||
      receipt.candidateImmutable !== true ||
      !RUN_ID_PATTERN.test(String(receipt.trainingRunId ?? "")) ||
      !RUN_ID_PATTERN.test(String(receipt.exportRunId ?? "")) ||
      receipt.trainingRunId === receipt.exportRunId ||
      receipt.trainingRunId !== descriptor.manifest.trainingRunId ||
      receipt.exportRunId !== descriptor.manifest.exportRunId ||
      receipt.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      !SHA256_PATTERN.test(String(receipt.promotionId ?? "")) ||
      !Array.isArray(receipt.artifacts) ||
      receipt.artifacts.length < 1) {
    fail("Neural promotion receipt contract is invalid.");
  }
  if (!Number.isFinite(Date.parse(receipt.generatedAt))) {
    fail("Neural promotion receipt generatedAt is not an ISO timestamp.");
  }
  requireExactKeys(receipt.inputs, INPUT_KEYS, "Neural promotion receipt inputs");
  requireExactKeys(
    receipt.productionManifest,
    [
      "path",
      "bytes",
      "sha256",
      "metricsSourceSha256",
      "performanceSourceSha256"
    ],
    "Neural promotion receipt productionManifest"
  );

  const candidateRoot = safePath(
    repoRoot,
    receipt.candidateRoot,
    "Promotion candidate root"
  );
  assertRealDirectory(candidateRoot, "Promotion candidate root");
  const candidateManifestPath = safePath(
    repoRoot,
    receipt.inputs.candidateManifest?.path,
    "Receipt candidate manifest"
  );
  if (!isStrictlyWithin(candidateRoot, candidateManifestPath) ||
      isWithin(candidateRoot, productionDirectory) ||
      isWithin(productionDirectory, candidateRoot)) {
    fail(
      "Promotion candidate and production paths are not isolated canonical roots."
    );
  }
  const expectedLayout = descriptor.runtimeModelContract ===
    "split-attention-incremental-v1"
    ? "split-attention"
    : "single-model";
  if (receipt.artifactLayout !== expectedLayout ||
      safePath(
        repoRoot,
        receipt.productionDirectory,
        "Receipt production directory"
      ) !== productionDirectory ||
      safePath(
        repoRoot,
        receipt.productionManifest.path,
        "Receipt production manifest"
      ) !== manifestEvidence.path ||
      receipt.productionManifest.sha256 !== manifestEvidence.sha256 ||
      receipt.productionManifest.bytes !== manifestEvidence.bytes ||
      resolve(receiptPath) !== join(productionDirectory, RECEIPT_NAME)) {
    fail("Promotion receipt does not identify the current production bundle.");
  }
}

function validateRetainedEvidenceGraph({
  repoRoot,
  receipt,
  descriptor,
  manifest,
  retainedValues
}) {
  const selection = validateNeuralSelectionReport(retainedValues.selectionReport);
  const winner = selection.winner;
  const candidateManifest = retainedValues.candidateManifest;
  const exportReport = retainedValues.exportReport;
  const evaluation = retainedValues.evaluationReport;
  const benchmark = retainedValues.benchmarkReport;
  const comparison = retainedValues.comparisonReport;
  const goldManifest = retainedValues.goldManifest;
  const datasetManifest = retainedValues.datasetManifest;

  if (candidateManifest.productionEligible !== false ||
      candidateManifest.trainingRunId !== receipt.trainingRunId ||
      candidateManifest.exportRunId !== receipt.exportRunId ||
      exportReport.trainingRunId !== receipt.trainingRunId ||
      exportReport.exportRunId !== receipt.exportRunId ||
      exportReport.manifestSha256 !== receipt.inputs.candidateManifest.sha256 ||
      exportReport.checkpointSha256 !== receipt.inputs.checkpoint.sha256 ||
      candidateManifest.sha256?.sourceCheckpoint !==
        receipt.inputs.checkpoint.sha256 ||
      candidateManifest.sha256?.trainingDatasetManifest !==
        receipt.inputs.datasetManifest.sha256 ||
      candidateManifest.sha256?.vocabMetadata !==
        receipt.inputs.vocabulary.sha256) {
    fail("Retained candidate manifest/export identities are stale or incomplete.");
  }
  if (safePath(repoRoot, exportReport.manifest, "Export manifest") !==
        safePath(
          repoRoot,
          receipt.inputs.candidateManifest.path,
          "Receipt candidate manifest"
        ) ||
      safePath(repoRoot, exportReport.checkpoint, "Export checkpoint") !==
        safePath(
          repoRoot,
          receipt.inputs.checkpoint.path,
          "Receipt checkpoint"
        )) {
    fail("Retained export paths do not identify the exact promoted candidate inputs.");
  }

  if (selection.selectionId !== receipt.inputs.selectionId ||
      safePath(
        repoRoot,
        winner.candidateRoot,
        "Selection winner candidate root"
      ) !== safePath(
        repoRoot,
        receipt.candidateRoot,
        "Receipt candidate root"
      ) ||
      winner.identity.trainingRunId !== manifest.trainingRunId ||
      winner.identity.exportRunId !== manifest.exportRunId ||
      winner.identity.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      winner.identity.vocabSha256 !== descriptor.vocabSha256 ||
      winner.identity.manifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      winner.identity.exportReportSha256 !==
        receipt.inputs.exportReport.sha256 ||
      winner.evidence.evaluationReport.sha256 !==
        receipt.inputs.evaluationReport.sha256 ||
      winner.evidence.benchmarkReport.sha256 !==
        receipt.inputs.benchmarkReport.sha256 ||
      winner.evidence.comparisonReport.sha256 !==
        receipt.inputs.comparisonReport.sha256 ||
      winner.evidence.comparisonPredictions.sha256 !==
        receipt.inputs.comparisonPredictions.sha256 ||
      winner.evidence.benchmarkManifest.sha256 !==
        receipt.inputs.comparisonBenchmarkManifest.sha256) {
    fail("Promotion receipt is not bound to the deterministic selection winner.");
  }

  if (evaluation.status !== "passed-production-phase5-evaluation" ||
      evaluation.production !== true ||
      evaluation.productionEligible !== true ||
      evaluation.trainingRunId !== receipt.trainingRunId ||
      evaluation.exportRunId !== receipt.exportRunId ||
      evaluation.predictionValidation?.exactCoverage !== true ||
      evaluation.predictionValidation?.metricsReportable !== true ||
      !Array.isArray(evaluation.failures) ||
      evaluation.failures.length !== 0 ||
      evaluation.predictionsSha256 !== receipt.inputs.predictions.sha256 ||
      evaluation.goldManifestSha256 !== receipt.inputs.goldManifest.sha256 ||
      evaluation.goldCorpusSha256 !== receipt.inputs.goldCorpusSha256 ||
      evaluation.datasetManifestSha256 !==
        receipt.inputs.datasetManifest.sha256 ||
      evaluation.datasetContentSha256 !==
        receipt.inputs.datasetContentSha256) {
    fail("Retained production evaluation evidence is stale or incomplete.");
  }
  for (const [value, record, label] of [
    [evaluation.predictions, receipt.inputs.predictions, "evaluation predictions"],
    [evaluation.goldManifest, receipt.inputs.goldManifest, "evaluation gold manifest"],
    [evaluation.datasetManifest, receipt.inputs.datasetManifest, "evaluation dataset manifest"]
  ]) {
    if (safePath(repoRoot, value, label) !==
        safePath(repoRoot, record.path, `receipt ${label}`)) {
      fail(`Retained ${label} path does not match its receipt record.`);
    }
  }

  if (benchmark.status !== "passed-candidate-promotion-evidence" ||
      benchmark.proofMode !== "candidate-promotion" ||
      benchmark.singleForwardBenchmarkIsConsumerLatency !== false ||
      benchmark.artifactIdentity?.trainingRunId !== receipt.trainingRunId ||
      benchmark.artifactIdentity?.exportRunId !== receipt.exportRunId ||
      benchmark.artifactIdentity?.manifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      benchmark.artifactIdentity?.vocabSha256 !== descriptor.vocabSha256 ||
      benchmark.artifactIdentity?.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      benchmark.computePlacement?.neuralEngineClaimAllowed !== true ||
      !Array.isArray(benchmark.failures) ||
      benchmark.failures.length !== 0) {
    fail("Retained packaged benchmark evidence is stale or incomplete.");
  }

  if (comparison.status !== "passed-official-benchmark-evaluation" ||
      comparison.suite !== "neural-official-benchmark-evaluation" ||
      comparison.productionEligible !== true ||
      comparison.trainingRunId !== receipt.trainingRunId ||
      comparison.exportRunId !== receipt.exportRunId ||
      comparison.candidateManifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      comparison.artifactIdentity?.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      comparison.benchmarkManifestSha256 !==
        receipt.inputs.comparisonBenchmarkManifest.sha256 ||
      comparison.predictionsSha256 !==
        receipt.inputs.comparisonPredictions.sha256 ||
      comparison.qualityGate?.passed !== true ||
      !Array.isArray(comparison.failures) ||
      comparison.failures.length !== 0) {
    fail("Retained official benchmark evidence is stale or did not pass.");
  }
  for (const [value, record, label] of [
    [
      comparison.benchmarkManifest,
      receipt.inputs.comparisonBenchmarkManifest,
      "official benchmark manifest"
    ],
    [
      comparison.predictions,
      receipt.inputs.comparisonPredictions,
      "official benchmark predictions"
    ]
  ]) {
    if (safePath(repoRoot, value, label) !==
        safePath(repoRoot, record.path, `receipt ${label}`)) {
      fail(`Retained ${label} path does not match its receipt record.`);
    }
  }

  if (goldManifest.corpusSha256 !== receipt.inputs.goldCorpusSha256 ||
      datasetManifest.datasetContentSha256 !==
        receipt.inputs.datasetContentSha256) {
    fail("Retained corpus identities do not match their manifests.");
  }
}

function verifyPromotedArtifacts({
  repoRoot,
  productionDirectory,
  receipt,
  descriptor,
  exportReport
}) {
  const expected = expectedArtifacts(repoRoot, exportReport, descriptor);
  const expectedIds = Object.keys(expected).sort();
  const observedIds = receipt.artifacts.map((artifact) => artifact?.id).sort();
  if (canonicalJson(expectedIds) !== canonicalJson(observedIds) ||
      new Set(observedIds).size !== observedIds.length) {
    fail(
      "Promotion receipt artifact inventory does not exactly match the " +
      "qualified export."
    );
  }

  const verified = [];
  for (const record of receipt.artifacts) {
    requireExactKeys(
      record,
      [
        "id",
        "role",
        "artifactKind",
        "kind",
        "source",
        "destination",
        "bytes",
        "sha256"
      ],
      `Promotion artifact ${String(record?.id)}`
    );
    const expectedArtifact = expected[record.id];
    const candidateRoot = safePath(
      repoRoot,
      receipt.candidateRoot,
      "Receipt candidate root"
    );
    if (record.role !== expectedArtifact.role ||
        record.artifactKind !== expectedArtifact.artifactKind ||
        record.kind !== "directory" ||
        basename(record.destination) !== expectedArtifact.destinationName ||
        safePath(
          repoRoot,
          record.source,
          `Promoted artifact ${record.id} source`
        ) !== expectedArtifact.sourcePath ||
        record.sha256 !== expectedArtifact.sha256 ||
        record.bytes !== expectedArtifact.bytes ||
        !SHA256_PATTERN.test(String(record.sha256 ?? "")) ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 1) {
      fail(`Promotion artifact ${record.id} metadata is invalid or stale.`);
    }
    if (!isStrictlyWithin(candidateRoot, expectedArtifact.sourcePath)) {
      fail(`Promotion artifact ${record.id} source escapes the candidate root.`);
    }

    const destination = safePath(
      repoRoot,
      record.destination,
      `Promoted artifact ${record.id}`
    );
    if (dirname(destination) !== productionDirectory ||
        basename(destination) !== basename(record.destination)) {
      fail(`Promoted artifact ${record.id} escapes the production directory.`);
    }
    const sourceEvidence = inspectContainedDirectoryTree(
      repoRoot,
      expectedArtifact.sourcePath,
      {
        label: `Retained candidate artifact ${record.id}`,
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 10_000
      }
    );
    const destinationEvidence = inspectContainedDirectoryTree(
      repoRoot,
      destination,
      {
        label: `Promoted artifact ${record.id}`,
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 10_000
      }
    );
    for (const evidence of [sourceEvidence, destinationEvidence]) {
      if (evidence.sha256 !== record.sha256 ||
          evidence.bytes !== record.bytes) {
        fail(`Promoted artifact ${record.id} differs from its promotion receipt.`);
      }
    }
    verified.push({ record, destinationEvidence });
  }

  for (const artifact of descriptor.artifacts) {
    const id = descriptor.runtimeModelContract ===
      "split-attention-incremental-v1"
      ? `${artifact.role}.compiledModel`
      : "compiledModel";
    const receiptArtifact = receipt.artifacts.find((entry) => entry.id === id);
    if (receiptArtifact?.sha256 !== artifact.compiledSha256 ||
        receiptArtifact?.bytes !== artifact.compiledBytes) {
      fail(`Runtime artifact ${id} is not represented by the promotion receipt.`);
    }
  }
  return verified;
}

function expectedArtifacts(repoRoot, exportReport, descriptor) {
  if (descriptor.runtimeModelContract === "split-attention-incremental-v1") {
    const expected = {};
    for (const [id, layout] of Object.entries(SPLIT_ARTIFACTS)) {
      const declared = exportReport.compiledModels?.[layout.role];
      const pathValue = declared?.[layout.artifactKind];
      const hashField = layout.artifactKind === "compiledModel"
        ? "compiledSha256"
        : "mlpackageSha256";
      const bytesField = layout.artifactKind === "compiledModel"
        ? "compiledBytes"
        : "mlpackageBytes";
      expected[id] = {
        ...layout,
        sourcePath: pathValue,
        sha256: declared?.[hashField],
        bytes: declared?.[bytesField]
      };
    }
    return resolveExpectedArtifactPaths(repoRoot, expected);
  }

  const expected = {
    compiledModel: {
      ...BASELINE_ARTIFACTS.compiledModel,
      sourcePath: exportReport.compiledModel,
      sha256: exportReport.compiledModelSha256,
      bytes: descriptor.artifacts[0]?.compiledBytes
    }
  };
  if (exportReport.mlpackage !== null &&
      exportReport.mlpackage !== undefined) {
    expected.mlpackage = {
      ...BASELINE_ARTIFACTS.mlpackage,
      sourcePath: exportReport.mlpackage,
      sha256: exportReport.mlpackageSha256,
      bytes: null
    };
  }
  const resolved = resolveExpectedArtifactPaths(repoRoot, expected);
  if (resolved.mlpackage) {
    const evidence = inspectContainedDirectoryTree(
      repoRoot,
      resolved.mlpackage.sourcePath,
      {
        label: "Retained baseline Core ML package",
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 10_000
      }
    );
    resolved.mlpackage.bytes = evidence.bytes;
  }
  return resolved;
}

function resolveExpectedArtifactPaths(repoRoot, expected) {
  for (const artifact of Object.values(expected)) {
    artifact.sourcePath = safePath(
      repoRoot,
      artifact.sourcePath,
      "Qualified artifact source"
    );
    requireSha256(artifact.sha256, "Qualified artifact SHA-256");
    if (artifact.bytes !== null &&
        (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1)) {
      fail("Qualified artifact byte count is invalid.");
    }
  }
  return expected;
}

function verifyProductionManifestDerivation({
  repoRoot,
  productionDirectory,
  receipt,
  manifest,
  retainedValues
}) {
  const expected = structuredClone(retainedValues.candidateManifest);
  expected.productionEligible = true;
  expected.metrics = structuredClone(retainedValues.evaluationReport.metrics);
  expected.performance = productionPerformanceFromBenchmark(
    retainedValues.benchmarkReport
  );
  expected.evaluationReports = [receipt.inputs.evaluationReport.path];
  expected.benchmarkReports = [receipt.inputs.benchmarkReport.path];
  if (receipt.artifactLayout === "split-attention") {
    for (const artifact of receipt.artifacts) {
      expected.compiledModels[artifact.role][artifact.artifactKind] =
        portableRelative(
          repoRoot,
          join(productionDirectory, basename(artifact.destination))
        );
    }
  }
  if (canonicalJson(expected) !== canonicalJson(manifest)) {
    fail(
      "Production manifest is not the exact deterministic promotion of the " +
      "retained candidate, evaluation metrics, benchmark performance, and " +
      "source-report lists."
    );
  }
  if (receipt.productionManifest.metricsSourceSha256 !==
        receipt.inputs.evaluationReport.sha256 ||
      receipt.productionManifest.performanceSourceSha256 !==
        receipt.inputs.benchmarkReport.sha256) {
    fail("Production manifest source digests are stale.");
  }
}

function productionPerformanceFromBenchmark(benchmarkReport) {
  requireRecord(benchmarkReport.performance, "Benchmark performance");
  const source = benchmarkReport.performance;
  const sourceDevices = Array.isArray(benchmarkReport.devices)
    ? benchmarkReport.devices
    : source.devices;
  if (!Array.isArray(sourceDevices) || sourceDevices.length < 1) {
    fail("Benchmark report does not contain device measurements.");
  }
  return {
    p50Ms: source.p50Ms,
    p95Ms: source.p95Ms,
    p99Ms: source.p99Ms,
    targetP99Ms: 50,
    measuredOnDevice: true,
    devices: sourceDevices.map((device) => ({
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
    }))
  };
}

function enforceClosedWorldBundle(productionDirectory, receipt) {
  const expected = new Set([
    MANIFEST_NAME,
    VOCABULARY_NAME,
    RECEIPT_NAME,
    ...receipt.artifacts.map((artifact) => basename(artifact.destination))
  ]);
  const observed = readdirSync(productionDirectory).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(observed) !== canonicalJson(wanted)) {
    fail(
      `Production neural directory is not closed-world; expected ` +
      `${wanted.join(", ")}, observed ${observed.join(", ")}.`
    );
  }
}

function verifyRetainedEvidence(repoRoot, record, label, options = {}) {
  requireExactKeys(record, ["path", "bytes", "sha256"], `${label} receipt record`);
  if (typeof record.path !== "string" ||
      !SHA256_PATTERN.test(String(record.sha256 ?? "")) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1) {
    fail(`${label} receipt record is invalid.`);
  }
  const file = inspectContainedRegularFile(
    repoRoot,
    safePath(repoRoot, record.path, label),
    {
      label,
      includeContents: Boolean(options.json),
      maxBytes: label.includes("checkpoint")
        ? 512 * 1024 * 1024
        : label.includes("predictions")
          ? 256 * 1024 * 1024
          : 32 * 1024 * 1024
    }
  );
  if (file.sha256 !== record.sha256 || file.bytes !== record.bytes) {
    fail(`${label} changed after candidate promotion.`);
  }
  if (!options.json) return { file, value: null };
  return {
    file,
    value: parseJson(file.contents, label)
  };
}

function validateManifestSchema(repoRoot, manifest, configuredPath) {
  const schemaPath = safePath(
    repoRoot,
    configuredPath ??
      "data/neural/schema/lekh-neural-manifest.schema.json",
    "Neural manifest schema"
  );
  const schema = parseJson(
    inspectContainedRegularFile(repoRoot, schemaPath, {
      label: "Neural manifest schema",
      includeContents: true,
      maxBytes: 2 * 1024 * 1024
    }).contents,
    "Neural manifest schema"
  );
  const validate = new Ajv2020({
    allErrors: true,
    strict: true
  }).compile(schema);
  if (!validate(manifest)) {
    fail(
      `Promoted manifest violates its closed schema: ` +
      `${JSON.stringify(validate.errors)}.`
    );
  }
}

function readJsonEvidence(repoRoot, path, label, maxBytes) {
  const file = inspectContainedRegularFile(
    repoRoot,
    safePath(repoRoot, path, label),
    {
      label,
      includeContents: true,
      maxBytes
    }
  );
  return { file, value: parseJson(file.contents, label) };
}

function parseJson(contents, label) {
  let value;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
  requireRecord(value, label);
  return value;
}

function assertRealDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      realpathSync(path) !== resolve(path)) {
    fail(`${label} must be a real canonical directory.`);
  }
}

function canonicalDirectory(path, label) {
  const resolved = resolve(path);
  assertRealDirectory(resolved, label);
  return realpathSync(resolved);
}

function safePath(repoRoot, value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} path must be a non-empty string.`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  const child = relative(repoRoot, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} path escapes the repository.`);
  }
  return path;
}

function evidenceSummary(repoRoot, evidence) {
  return {
    path: portableRelative(repoRoot, evidence.path),
    bytes: evidence.bytes,
    sha256: evidence.sha256
  };
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function requireExactKeys(value, keys, label) {
  requireRecord(value, label);
  if (canonicalJson(Object.keys(value).sort()) !==
      canonicalJson([...keys].sort())) {
    fail(`${label} has missing or unknown keys.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be exactly 64 lowercase hexadecimal characters.`);
  }
  return value;
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

function portableRelative(parent, candidate) {
  return relative(resolve(parent), resolve(candidate)).split(sep).join("/");
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new NeuralProductionPromotionReceiptError(message);
}
