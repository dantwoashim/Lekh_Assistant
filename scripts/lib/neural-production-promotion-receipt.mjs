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
  inspectNeuralCandidateEvidenceCustody
} from "./neural-candidate-evidence-custody.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";
import {
  validateNeuralDeviceMeasurements
} from "./neural-device-measurements.mjs";
import {
  validateNeuralSelectionReport
} from "./neural-model-selection.mjs";
import {
  validateNeuralRuntimePlacementEvidence
} from "./neural-runtime-placement-evidence.mjs";
import {
  evaluateNeuralRareScalarEvidence
} from "./neural-rare-scalar-evaluation.mjs";
import {
  validateNeuralRareScalarContract
} from "./neural-rare-scalar-contract.mjs";
import {
  CTC_FINITE_PATH_DECODER_POLICY,
  isCTCFinitePathDecoderPolicy
} from "./neural-ctc-finite-path-contract.mjs";
import {
  hasCTCCoreMLParityEvidence
} from "./neural-ctc-coreml-parity-contract.mjs";
import {
  validateCanonicalNeuralMemorySummary,
  validateNeuralPostExportMemoryEvidence
} from "./neural-post-export-memory-evidence.mjs";
import {
  validateNeuralTrainingCandidateIdentity
} from "./neural-training-candidate-identity.mjs";
import {
  expectedNeuralCandidateExportStatus,
  validateCanonicalNeuralGoldEvidence
} from "./neural-production-evidence-policy.mjs";
import {
  validateRecomputedNeuralGoldEvaluation,
  validateRecomputedOfficialBenchmarkEvaluation
} from "./neural-metric-recomputation.mjs";
import {
  projectNeuralProductionManifestMetrics
} from "./neural-production-metrics.mjs";
import {
  verifyOfficialBenchmarkTrainingIsolation
} from "./neural-official-benchmark-isolation.mjs";
import {
  replayRetainedNeuralNativeServiceBenchmarkEvidence
} from "./neural-native-service-benchmark-evidence.mjs";

export const NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION = 5;

const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MANIFEST_NAME = "LekhNeuralTransliterator.manifest.json";
const VOCABULARY_NAME = "LekhNeuralTransliterator.vocab.json";
const RECEIPT_NAME = "neural-candidate-promotion-report.json";
const CANONICAL_OFFICIAL_BENCHMARK_MANIFEST =
  "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json";
const CANONICAL_OFFICIAL_BENCHMARK_MANIFEST_SHA256 =
  "d492040eeb6ddd2883fee50d0f03c051e20a08d1f469da00679b66751136781f";
const CANONICAL_REFERENCE_MANIFEST =
  "data/neural/benchmarks/indicxlit-v1/manifest.json";
const CANONICAL_REFERENCE_MANIFEST_SHA256 =
  "c3bd96c57a322455026df920dab74dc214113bb2a33aa67f6420805b195c52c6";
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
  "trainingReport",
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
  "trainingReport",
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
 * Schema v5 keeps the vocabulary in inputs.vocabulary and only
 * runtime/export model directories in artifacts. This makes the identity and
 * the receipt inventory identical, while artifactSetSha256 continues to bind
 * just the compiled runtime models and vocabulary through the descriptor.
 * Transformer-CTC receipts additionally retain the closed sparse-output
 * contract, predictions, generation attestation, audit, and evaluation.
 */
export function buildNeuralProductionPromotionIdentity(receipt) {
  requireRecord(receipt, "Neural promotion receipt");
  requireRecord(receipt.inputs, "Neural promotion receipt inputs");
  if (!Array.isArray(receipt.artifacts)) {
    fail("Neural promotion receipt artifacts must be an array.");
  }
  return deepFreeze({
    generatedAt: receipt.generatedAt,
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    candidateEvidenceStable: receipt.candidateEvidenceStable,
    candidateRoot: receipt.candidateRoot,
    productionDirectory: receipt.productionDirectory,
    artifactLayout: receipt.artifactLayout,
    candidateCustodySetSha256: receipt.candidateCustodySetSha256,
    trainingIdentity: structuredClone(receipt.trainingIdentity),
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
    rareScalarReportSha256:
      receipt.rareScalarEvidence?.report?.sha256 ?? null,
    rareScalarGenerationReportSha256:
      receipt.rareScalarEvidence?.generationReport?.sha256 ?? null,
    rareScalarPredictionsSha256:
      receipt.rareScalarEvidence?.predictions?.sha256 ?? null,
    rareScalarContractSha256:
      receipt.rareScalarEvidence?.contract?.sha256 ?? null,
    rareScalarCTCAuditSha256:
      receipt.rareScalarEvidence?.ctcAudit?.sha256 ?? null,
    vocabularySha256: receipt.inputs.vocabulary?.sha256,
    artifactSetSha256: receipt.artifactSetSha256,
    checkpointSha256: receipt.inputs.checkpoint?.sha256,
    artifacts: [...receipt.artifacts]
      .sort((left, right) =>
        String(left?.id).localeCompare(String(right?.id))
      )
      .map((artifact) => structuredClone(artifact)),
    productionManifest: structuredClone(receipt.productionManifest)
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
  const vocabularyEvidence = inspectContainedRegularFile(
    repoRoot,
    vocabularyPath,
    {
      label: "Promoted neural vocabulary",
      maxBytes: 16 * 1024 * 1024
    }
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
  const retainedFiles = {};
  const retainedValues = {};
  for (const name of INPUT_KEYS) {
    if (["selectionId", "goldCorpusSha256", "datasetContentSha256"].includes(name)) {
      continue;
    }
    const evidence = verifyRetainedEvidence(
      repoRoot,
      receipt.inputs[name],
      `Retained promotion input ${name}`,
      {
        includeContents: [
          "comparisonPredictions",
          "predictions"
        ].includes(name),
        json: JSON_INPUTS.has(name)
      }
    );
    retained[name] = evidenceSummary(repoRoot, evidence.file);
    retainedFiles[name] = evidence.file;
    retainedValues[name] = evidence.value;
  }
  for (const name of ["goldCorpusSha256", "datasetContentSha256"]) {
    requireSha256(receipt.inputs[name], `Promotion receipt inputs.${name}`);
  }
  requireSha256(receipt.inputs.selectionId, "Promotion receipt inputs.selectionId");
  const retainedRare = verifyRetainedRareScalarEvidence({
    repoRoot,
    receipt,
    descriptor
  });
  const candidateCustody = verifyCandidateEvidenceCustody({
    repoRoot,
    receipt,
    descriptor,
    retainedFiles
  });
  assertRetainedEvidenceOutsideCandidateArtifactTrees({
    repoRoot,
    candidateCustody,
    retainedFiles,
    retainedRareFiles: retainedRare?.files ?? null
  });

  const retainedEvidenceGraph = validateRetainedEvidenceGraph({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    manifest,
    retainedFiles,
    retainedValues,
    retainedRareFiles: retainedRare?.files ?? null,
    retainedRareValues: retainedRare?.values ?? null
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
    artifacts,
    productionMetrics: retainedEvidenceGraph.productionMetrics
  });

  const reconstructedPromotionId =
    computeNeuralProductionPromotionId(receipt);
  if (reconstructedPromotionId !== receipt.promotionId) {
    fail("Promotion ID does not match the complete retained evidence graph.");
  }
  assertLiveReceiptGraphUnchanged({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    manifest,
    manifestEvidence: manifestEvidence.file,
    receiptEvidence: receiptEvidence.file,
    vocabularyEvidence,
    retainedFiles,
    retainedValues,
    retainedRareFiles: retainedRare?.files ?? null,
    retainedRareValues: retainedRare?.values ?? null,
    expectedProductionMetrics: retainedEvidenceGraph.productionMetrics,
    expectedCandidateCustodySetSha256:
      candidateCustody.custodySetSha256
  });

  return deepFreeze({
    promotionId: receipt.promotionId,
    selectionId: receipt.inputs.selectionId,
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    modelId: descriptor.modelId,
    runtimeModelContract: descriptor.runtimeModelContract,
    artifactSetSha256: descriptor.artifactSetSha256,
    candidateCustodySetSha256: candidateCustody.custodySetSha256,
    manifest: evidenceSummary(repoRoot, manifestEvidence.file),
    receipt: evidenceSummary(repoRoot, receiptEvidence.file),
    retainedInputs: {
      ...retained,
      rareScalarEvidence: retainedRare?.summaries ?? null
    },
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

function assertLiveReceiptGraphUnchanged({
  repoRoot,
  productionDirectory,
  receipt,
  descriptor,
  manifest,
  manifestEvidence,
  receiptEvidence,
  vocabularyEvidence,
  retainedFiles,
  retainedValues,
  retainedRareFiles,
  retainedRareValues,
  expectedProductionMetrics,
  expectedCandidateCustodySetSha256
}) {
  for (const [name, evidence] of Object.entries(retainedFiles)) {
    assertFileSnapshotUnchanged(
      repoRoot,
      evidence,
      `Final retained promotion input ${name}`,
      retainedEvidenceByteLimit(name)
    );
  }
  for (const [name, evidence] of Object.entries(
    retainedRareFiles ?? {}
  )) {
    assertFileSnapshotUnchanged(
      repoRoot,
      evidence,
      `Final retained rare-scalar input ${name}`,
      retainedEvidenceByteLimit(name)
    );
  }

  const finalCustody = verifyCandidateEvidenceCustody({
    repoRoot,
    receipt,
    descriptor,
    retainedFiles
  });
  assertRetainedEvidenceOutsideCandidateArtifactTrees({
    repoRoot,
    candidateCustody: finalCustody,
    retainedFiles,
    retainedRareFiles
  });
  if (
    finalCustody.custodySetSha256 !==
      expectedCandidateCustodySetSha256
  ) {
    fail(
      "Candidate evidence custody changed during live promotion-receipt " +
      "verification."
    );
  }

  const replayedGraph = validateRetainedEvidenceGraph({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    manifest,
    retainedFiles,
    retainedValues,
    retainedRareFiles,
    retainedRareValues
  });
  if (
    canonicalJson(replayedGraph.productionMetrics) !==
      canonicalJson(expectedProductionMetrics)
  ) {
    fail(
      "Retained evidence graph changed during live promotion-receipt " +
      "verification."
    );
  }
  const finalArtifacts = verifyPromotedArtifacts({
    repoRoot,
    productionDirectory,
    receipt,
    descriptor,
    exportReport: retainedValues.exportReport
  });
  verifyProductionManifestDerivation({
    repoRoot,
    productionDirectory,
    receipt,
    manifest,
    retainedValues,
    artifacts: finalArtifacts,
    productionMetrics: replayedGraph.productionMetrics
  });

  for (const [evidence, label, maxBytes] of [
    [
      manifestEvidence,
      "Final promoted runtime manifest",
      16 * 1024 * 1024
    ],
    [
      receiptEvidence,
      "Final neural promotion receipt",
      16 * 1024 * 1024
    ],
    [
      vocabularyEvidence,
      "Final promoted neural vocabulary",
      16 * 1024 * 1024
    ]
  ]) {
    assertFileSnapshotUnchanged(
      repoRoot,
      evidence,
      label,
      maxBytes
    );
  }
  enforceClosedWorldBundle(productionDirectory, receipt);
}

function assertFileSnapshotUnchanged(
  repoRoot,
  expected,
  label,
  maxBytes
) {
  const observed = inspectContainedRegularFile(
    repoRoot,
    expected.path,
    { label, maxBytes }
  );
  if (
    observed.realPath !== expected.realPath ||
    observed.sha256 !== expected.sha256 ||
    observed.bytes !== expected.bytes
  ) {
    fail(`${label} changed during live promotion-receipt verification.`);
  }
}

function retainedEvidenceByteLimit(name) {
  if (name === "checkpoint") return 512 * 1024 * 1024;
  if (
    name === "predictions" ||
    name === "comparisonPredictions"
  ) {
    return 256 * 1024 * 1024;
  }
  return 32 * 1024 * 1024;
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
      "trainingIdentity",
      "candidateEvidenceStable",
      "candidateCustodySetSha256",
      "candidateRoot",
      "productionDirectory",
      "artifactLayout",
      "inputs",
      "rareScalarEvidence",
      "artifactSetSha256",
      "artifacts",
      "productionManifest"
    ],
    "Neural promotion receipt"
  );
  if (receipt.schemaVersion !==
        NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION ||
      receipt.status !== "passed-neural-candidate-promotion" ||
      receipt.candidateEvidenceStable !== true ||
      !RUN_ID_PATTERN.test(String(receipt.trainingRunId ?? "")) ||
      !RUN_ID_PATTERN.test(String(receipt.exportRunId ?? "")) ||
      receipt.trainingRunId === receipt.exportRunId ||
      receipt.trainingRunId !== descriptor.manifest.trainingRunId ||
      receipt.exportRunId !== descriptor.manifest.exportRunId ||
      receipt.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      !SHA256_PATTERN.test(String(
        receipt.candidateCustodySetSha256 ?? ""
      )) ||
      !SHA256_PATTERN.test(String(receipt.promotionId ?? "")) ||
      !Array.isArray(receipt.artifacts) ||
      receipt.artifacts.length < 1) {
    fail("Neural promotion receipt contract is invalid.");
  }
  if (
    typeof receipt.generatedAt !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(receipt.generatedAt) ||
    !Number.isFinite(Date.parse(receipt.generatedAt))
  ) {
    fail(
      "Neural promotion receipt generatedAt is not a canonical UTC " +
      "timestamp."
    );
  }
  requireExactKeys(receipt.inputs, INPUT_KEYS, "Neural promotion receipt inputs");
  requireExactKeys(receipt.trainingIdentity, [
    "effectiveTrainingConfigSha256",
    "sourceCheckpointSha256",
    "trainingReportSha256",
    "trainingRunId",
    "trainingSeed"
  ], "Neural promotion receipt trainingIdentity");
  if (receipt.trainingIdentity.trainingRunId !== receipt.trainingRunId ||
      !SHA256_PATTERN.test(String(
        receipt.trainingIdentity.sourceCheckpointSha256 ?? ""
      )) ||
      !SHA256_PATTERN.test(String(
        receipt.trainingIdentity.trainingReportSha256 ?? ""
      )) ||
      !SHA256_PATTERN.test(String(
        receipt.trainingIdentity.effectiveTrainingConfigSha256 ?? ""
      )) ||
      !Number.isSafeInteger(receipt.trainingIdentity.trainingSeed) ||
      receipt.trainingIdentity.trainingSeed < 0 ||
      receipt.trainingIdentity.trainingSeed > 0xffff_ffff) {
    fail("Neural promotion receipt training identity is invalid.");
  }
  if (descriptor.modelId === "lekh-open-vocab-ctc-transformer-v2") {
    requireRecord(
      receipt.rareScalarEvidence,
      "Transformer-CTC rare-scalar receipt evidence"
    );
    requireExactKeys(
      receipt.rareScalarEvidence,
      [
        "report",
        "generationReport",
        "predictions",
        "contract",
        "ctcAudit"
      ],
      "Transformer-CTC rare-scalar receipt evidence"
    );
  } else if (receipt.rareScalarEvidence !== null) {
    fail("Non-CTC promotion receipts must not contain rare-scalar evidence.");
  }
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

function verifyCandidateEvidenceCustody({
  repoRoot,
  receipt,
  descriptor,
  retainedFiles
}) {
  const candidateRoot = safePath(
    repoRoot,
    receipt.candidateRoot,
    "Promotion candidate root"
  );
  let custody;
  try {
    custody = inspectNeuralCandidateEvidenceCustody({
      repoRoot,
      candidateRoot,
      manifestPath: retainedFiles.candidateManifest.path,
      vocabPath: retainedFiles.vocabulary.path,
      exportReportPath: retainedFiles.exportReport.path
    });
  } catch (error) {
    fail(`Retained candidate evidence custody is invalid: ${errorMessage(error)}`);
  }
  if (
    custody.custodySetSha256 !== receipt.candidateCustodySetSha256 ||
    custody.candidateRoot !== candidateRoot ||
    custody.modelId !== descriptor.modelId ||
    custody.runtimeModelContract !== descriptor.runtimeModelContract ||
    custody.predictionsBackend !== descriptor.predictionsBackend ||
    custody.trainingRunId !== receipt.trainingRunId ||
    custody.exportRunId !== receipt.exportRunId ||
    custody.artifactSetSha256 !== descriptor.artifactSetSha256
  ) {
    fail(
      "Retained candidate evidence custody does not match the promotion " +
      "receipt, runtime contract, or exact promoted artifact set."
    );
  }
  for (const [custodyName, retainedName] of [
    ["manifest", "candidateManifest"],
    ["vocabulary", "vocabulary"],
    ["exportReport", "exportReport"],
    ["trainingReport", "trainingReport"],
    ["checkpoint", "checkpoint"],
    ["goldPredictions", "predictions"],
    ["officialPredictions", "comparisonPredictions"]
  ]) {
    const summary = custody.files[custodyName];
    const retained = retainedFiles[retainedName];
    if (
      summary?.path !== portableRelative(repoRoot, retained.path) ||
      summary?.sha256 !== retained.sha256 ||
      summary?.bytes !== retained.bytes
    ) {
      fail(
        `Retained candidate custody ${custodyName} does not match its ` +
        "independently reopened receipt input."
      );
    }
  }
  return custody;
}

function assertRetainedEvidenceOutsideCandidateArtifactTrees({
  repoRoot,
  candidateCustody,
  retainedFiles,
  retainedRareFiles
}) {
  const artifactRoots = [
    ...Object.values(candidateCustody.compiledArtifacts),
    ...Object.values(candidateCustody.exportPackages)
  ].map((record) => safePath(
    repoRoot,
    record.path,
    "Candidate custody artifact root"
  ));
  for (const [name, evidence] of Object.entries({
    ...retainedFiles,
    ...(retainedRareFiles ?? {})
  })) {
    if (
      artifactRoots.some((artifactRoot) =>
        isWithin(artifactRoot, evidence.path)
      )
    ) {
      fail(
        `Retained evidence ${name} must remain outside every candidate ` +
        "compiled-model and Core ML package tree."
      );
    }
  }
}

function verifyRetainedRareScalarEvidence({
  repoRoot,
  receipt,
  descriptor
}) {
  if (descriptor.modelId !== "lekh-open-vocab-ctc-transformer-v2") {
    return null;
  }
  const records = receipt.rareScalarEvidence;
  const jsonNames = new Set([
    "report",
    "generationReport",
    "contract",
    "ctcAudit"
  ]);
  const summaries = {};
  const files = {};
  const values = {};
  for (const name of [
    "report",
    "generationReport",
    "predictions",
    "contract",
    "ctcAudit"
  ]) {
    const evidence = verifyRetainedEvidence(
      repoRoot,
      records[name],
      `Retained rare-scalar ${name}`,
      {
        includeContents: name === "predictions",
        json: jsonNames.has(name)
      }
    );
    summaries[name] = evidenceSummary(repoRoot, evidence.file);
    files[name] = evidence.file;
    values[name] = evidence.value;
  }
  return { files, summaries, values };
}

function validateRetainedEvidenceGraph({
  repoRoot,
  receipt,
  descriptor,
  manifest,
  retainedFiles,
  retainedValues,
  retainedRareFiles,
  retainedRareValues
}) {
  const selection = validateNeuralSelectionReport(retainedValues.selectionReport);
  const winner = selection.winner;
  const candidateManifest = retainedValues.candidateManifest;
  const exportReport = retainedValues.exportReport;
  const evaluation = retainedValues.evaluationReport;
  const benchmark = retainedValues.benchmarkReport;
  const trainingReport = retainedValues.trainingReport;
  const comparison = retainedValues.comparisonReport;
  const goldManifest = retainedValues.goldManifest;
  const datasetManifest = retainedValues.datasetManifest;
  const expectedExportStatus =
    expectedNeuralCandidateExportStatus(candidateManifest);

  if (expectedExportStatus === null ||
      exportReport.status !== expectedExportStatus ||
      exportReport.modelId !== candidateManifest.selectedArtifact ||
      exportReport.productionEligible !== false ||
      exportReport.coremlExport?.status !== "passed" ||
      exportReport.coremlExport?.artifactValidation?.status !== "passed" ||
      !Array.isArray(exportReport.runtimeArtifactContractIssues) ||
      exportReport.runtimeArtifactContractIssues.length !== 0 ||
      candidateManifest.productionEligible !== false ||
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
    fail(
      "Retained candidate manifest/export status or identity is stale or " +
      "incomplete."
    );
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
        ) ||
      safePath(
        repoRoot,
        exportReport.trainingReport,
        "Export training report"
      ) !== safePath(
        repoRoot,
        receipt.inputs.trainingReport.path,
        "Receipt training report"
      ) ||
      safePath(
        repoRoot,
        exportReport.predictions,
        "Export gold predictions"
      ) !== safePath(
        repoRoot,
        receipt.inputs.predictions.path,
        "Receipt gold predictions"
      ) ||
      safePath(
        repoRoot,
        exportReport.goldManifest,
        "Export gold manifest"
      ) !== safePath(
        repoRoot,
        receipt.inputs.goldManifest.path,
        "Receipt gold manifest"
      )) {
    fail("Retained export paths do not identify the exact promoted candidate inputs.");
  }
  const exportDataset = exportReport.runInputSnapshot?.dataset;
  const datasetTrainSha256 = requireSha256(
    datasetManifest.sha256?.train,
    "Retained dataset train SHA-256"
  );
  const datasetDevSha256 = requireSha256(
    datasetManifest.sha256?.dev,
    "Retained dataset dev SHA-256"
  );
  if (
    exportReport.runInputSnapshot?.schemaVersion !== 1 ||
    exportReport.predictionsSha256 !== receipt.inputs.predictions.sha256 ||
    exportReport.predictionsBackend !== descriptor.predictionsBackend ||
    exportReport.goldManifestSha256 !== receipt.inputs.goldManifest.sha256 ||
    exportReport.goldCorpusSha256 !== receipt.inputs.goldCorpusSha256 ||
    safePath(
      repoRoot,
      exportDataset?.manifest,
      "Export dataset snapshot manifest"
    ) !== safePath(
      repoRoot,
      receipt.inputs.datasetManifest.path,
      "Receipt dataset manifest"
    ) ||
    exportDataset?.manifestSha256 !== receipt.inputs.datasetManifest.sha256 ||
    exportDataset?.contentSha256 !== receipt.inputs.datasetContentSha256 ||
    exportDataset?.splits?.train?.sha256 !== datasetTrainSha256 ||
    exportDataset?.splits?.dev?.sha256 !== datasetDevSha256
  ) {
    fail(
      "Retained export gold predictions, gold corpus, or dataset snapshot " +
      "does not match the promoted evidence."
    );
  }
  if (
    canonicalJson(immutableRunInputSnapshot(exportReport.runInputSnapshot)) !==
      canonicalJson(immutableRunInputSnapshot(trainingReport.runInputSnapshot)) ||
    exportReport.trainingRunInputSnapshotSha256 !==
      sha256CanonicalJson(trainingReport.runInputSnapshot) ||
    exportReport.exportRunInputSnapshotSha256 !==
      sha256CanonicalJson(exportReport.runInputSnapshot)
  ) {
    fail(
      "Retained training and export reports do not bind the same immutable " +
      "run-input snapshot and exact snapshot digests."
    );
  }
  const trainingIdentityValidation =
    validateNeuralTrainingCandidateIdentity({
      manifest: candidateManifest,
      exportReport,
      trainingReport,
      checkpointSha256: retainedFiles.checkpoint.sha256,
      trainingReportSha256: retainedFiles.trainingReport.sha256
    });
  if (!trainingIdentityValidation.valid ||
      canonicalJson(trainingIdentityValidation.identity) !==
        canonicalJson(receipt.trainingIdentity)) {
    fail(
      "Retained candidate training identity is stale or does not match the " +
      "promotion receipt."
    );
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
      winner.identity.sourceCheckpointSha256 !==
        receipt.trainingIdentity.sourceCheckpointSha256 ||
      winner.identity.trainingReportSha256 !==
        receipt.trainingIdentity.trainingReportSha256 ||
      winner.identity.effectiveTrainingConfigSha256 !==
        receipt.trainingIdentity.effectiveTrainingConfigSha256 ||
      winner.identity.trainingSeed !== receipt.trainingIdentity.trainingSeed ||
      winner.evidence.checkpoint.sha256 !==
        receipt.inputs.checkpoint.sha256 ||
      winner.evidence.trainingReport.sha256 !==
        receipt.inputs.trainingReport.sha256 ||
      winner.evidence.evaluationReport.sha256 !==
        receipt.inputs.evaluationReport.sha256 ||
      winner.evidence.benchmarkReport.sha256 !==
        receipt.inputs.benchmarkReport.sha256 ||
      winner.evidence.comparisonReport.sha256 !==
        receipt.inputs.comparisonReport.sha256 ||
      winner.evidence.comparisonPredictions.sha256 !==
        receipt.inputs.comparisonPredictions.sha256 ||
      winner.evidence.benchmarkManifest.sha256 !==
        receipt.inputs.comparisonBenchmarkManifest.sha256 ||
      winner.bindings.datasetManifestSha256 !==
        receipt.inputs.datasetManifest.sha256 ||
      winner.bindings.datasetContentSha256 !==
        receipt.inputs.datasetContentSha256 ||
      winner.bindings.goldManifestSha256 !==
        receipt.inputs.goldManifest.sha256 ||
      winner.bindings.goldCorpusSha256 !== receipt.inputs.goldCorpusSha256 ||
      winner.bindings.benchmarkManifestSha256 !==
        receipt.inputs.comparisonBenchmarkManifest.sha256) {
    fail("Promotion receipt is not bound to the deterministic selection winner.");
  }

  const expectedEvaluationArtifactIdentity = {
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    manifestSha256: receipt.inputs.candidateManifest.sha256,
    vocabSha256: descriptor.vocabSha256,
    compiledModelSha256:
      candidateManifest.sha256?.compiledModel ?? null,
    compiledModels:
      candidateManifest.sha256?.compiledModels ?? null
  };
  if (evaluation.status !== "passed-production-phase5-evaluation" ||
      evaluation.production !== true ||
      evaluation.productionEligible !== true ||
      evaluation.trainingRunId !== receipt.trainingRunId ||
      evaluation.exportRunId !== receipt.exportRunId ||
      evaluation.candidateManifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      evaluation.exportReportSha256 !== receipt.inputs.exportReport.sha256 ||
      canonicalJson(evaluation.artifactIdentity) !==
        canonicalJson(expectedEvaluationArtifactIdentity) ||
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
    [
      evaluation.candidateManifest,
      receipt.inputs.candidateManifest,
      "evaluation candidate manifest"
    ],
    [
      evaluation.exportReport,
      receipt.inputs.exportReport,
      "evaluation export report"
    ],
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
  const runtimePlacement = validateNeuralRuntimePlacementEvidence(
    benchmark.computePlacement?.runtimePlacement,
    {
      artifactDescriptor: {
        ...descriptor,
        manifestSha256: receipt.inputs.candidateManifest.sha256
      }
    }
  );
  if (!runtimePlacement.neuralEngineClaimAllowed) {
    fail(
      "Retained packaged benchmark lacks observed Neural Engine runtime " +
      "placement for the exact promoted artifact set."
    );
  }
  const candidateArtifactDescriptor = {
    ...descriptor,
    manifest: candidateManifest,
    manifestSha256: receipt.inputs.candidateManifest.sha256
  };
  const benchmarkDevices = Array.isArray(benchmark.devices)
    ? benchmark.devices
    : benchmark.performance?.devices;
  const deviceValidation = validateNeuralDeviceMeasurements(
    benchmarkDevices,
    {
      artifactDescriptor: candidateArtifactDescriptor,
      memoryEvidence: benchmark.memory,
      production: true
    }
  );
  if (!deviceValidation.valid ||
      deviceValidation.neuralEngineCompatibilityIndicated !== true) {
    fail(
      "Retained packaged benchmark device evidence is invalid: " +
      `${deviceValidation.issueCodes.join(", ")}.`
    );
  }
  const nativeBenchmarkReplay =
    replayRetainedNeuralNativeServiceBenchmarkEvidence(
      benchmark,
      {
        artifactDescriptor: candidateArtifactDescriptor,
        expectedProofMode: "candidate-promotion"
      }
    );
  if (!nativeBenchmarkReplay.valid || !nativeBenchmarkReplay.evidence) {
    fail(
      "Retained packaged benchmark cannot be independently replayed from " +
      "its exact native workload, latency samples, invocation deltas, and " +
      `artifact identity: ${nativeBenchmarkReplay.issueCodes.join(", ")}.`
    );
  }

  const expectedComparisonArtifactIdentity = {
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    manifestSha256: receipt.inputs.candidateManifest.sha256,
    vocabSha256: descriptor.vocabSha256,
    artifactSetSha256: descriptor.artifactSetSha256
  };
  if (comparison.schemaVersion !== 1 ||
      comparison.status !== "passed-official-benchmark-evaluation" ||
      comparison.suite !== "neural-official-benchmark-evaluation" ||
      comparison.productionEligible !== true ||
      comparison.trainingRunId !== receipt.trainingRunId ||
      comparison.exportRunId !== receipt.exportRunId ||
      comparison.candidateManifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      comparison.exportReportSha256 !== receipt.inputs.exportReport.sha256 ||
      canonicalJson(comparison.artifactIdentity) !==
        canonicalJson(expectedComparisonArtifactIdentity) ||
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
      comparison.exportReport,
      receipt.inputs.exportReport,
      "official benchmark export report"
    ],
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

  const canonicalGold = validateCanonicalNeuralGoldEvidence({
    repoRoot,
    manifestPath: retainedFiles.goldManifest.path,
    manifestSha256: retainedFiles.goldManifest.sha256,
    corpusSha256: goldManifest.corpusSha256,
    artifactOverrides: exportReport.artifactOverrides
  });
  if (!canonicalGold.valid) {
    fail(
      "Retained production evaluation does not use the canonical gold " +
      `corpus: ${canonicalGold.issueCodes.join(", ")}.`
    );
  }
  const goldRows = loadLockedEvaluationRows({
    repoRoot,
    manifest: goldManifest,
    label: "Retained gold"
  });
  const expectedGoldSuites = goldManifest.suites.map((suite) => ({
    id: suite.id,
    path: suite.path,
    sha256: suite.sha256,
    rows: suite.rows
  }));
  const expectedGoldSnapshot = {
    goldManifest: portableRelative(
      repoRoot,
      retainedFiles.goldManifest.path
    ),
    goldManifestSha256: retainedFiles.goldManifest.sha256,
    goldCorpusSha256: goldManifest.corpusSha256,
    goldSuites: expectedGoldSuites,
    goldRows: goldRows.length
  };
  if (exportReport.goldRows !== goldRows.length ||
      evaluation.goldRows !== goldRows.length ||
      canonicalJson(exportReport.goldSuites) !==
        canonicalJson(expectedGoldSuites) ||
      canonicalJson(exportReport.runInputSnapshot?.gold) !==
        canonicalJson(expectedGoldSnapshot)) {
    fail(
      "Retained export gold suite inventory, row count, or immutable run " +
      "snapshot does not match the canonical gold manifest."
    );
  }
  const goldMetricReplay = validateRecomputedNeuralGoldEvaluation({
    report: evaluation,
    goldRows,
    predictionRows: parseJsonLineObjects(
      retainedFiles.predictions.contents,
      "Retained gold predictions"
    )
  });
  if (!goldMetricReplay.valid) {
    fail(
      "Retained gold metrics do not match independent recomputation from " +
      `locked predictions: ${goldMetricReplay.issueCodes.join(", ")}.`
    );
  }
  const productionMetricsProjection =
    projectNeuralProductionManifestMetrics({
      recomputedGoldEvaluation: goldMetricReplay.recomputed,
      nativeBenchmarkDevices: benchmarkDevices
    });
  if (!productionMetricsProjection.valid) {
    fail(
      "Retained production metrics cannot be reconstructed from " +
      "independently verified gold and native benchmark evidence: " +
      `${productionMetricsProjection.issueCodes.join(", ")}.`
    );
  }

  const officialManifestFile =
    retainedFiles.comparisonBenchmarkManifest;
  if (
    officialManifestFile.path !==
      safePath(
        repoRoot,
        CANONICAL_OFFICIAL_BENCHMARK_MANIFEST,
        "Canonical official benchmark manifest"
      ) ||
    officialManifestFile.sha256 !==
      CANONICAL_OFFICIAL_BENCHMARK_MANIFEST_SHA256
  ) {
    fail(
      "Retained official benchmark manifest is not the canonical locked " +
      "release."
    );
  }
  const officialRows = loadLockedEvaluationRows({
    repoRoot,
    manifest: retainedValues.comparisonBenchmarkManifest,
    label: "Retained official benchmark"
  });
  const officialManifest = retainedValues.comparisonBenchmarkManifest;
  const exportOfficial = exportReport.comparisonBenchmark;
  const snapshotOfficial =
    exportReport.runInputSnapshot?.officialBenchmark;
  const expectedOfficialSuites = officialManifest.suites.map((suite) => ({
    id: suite.id,
    path: suite.path,
    sha256: suite.sha256,
    rows: suite.rows,
    benchmarkBucket: suite.benchmarkBucket
  }));
  const expectedPredictionArtifactIdentity =
    retainedPredictionArtifactIdentity({
      repoRoot,
      candidateRoot: safePath(
        repoRoot,
        receipt.candidateRoot,
        "Receipt candidate root"
      ),
      exportReport,
      descriptor
    });
  const isolationReplay = verifyOfficialBenchmarkTrainingIsolation({
    repoRoot,
    datasetManifestPath: retainedFiles.datasetManifest.path,
    expectedDatasetManifestSha256: retainedFiles.datasetManifest.sha256,
    officialRows
  });
  if (!isolationReplay.valid || !isolationReplay.evidence) {
    fail(
      "Retained official benchmark training isolation does not survive an " +
      `independent split rescan: ${isolationReplay.issueCodes.join(", ")}.`
    );
  }
  const isolation = isolationReplay.evidence;
  const expectedOfficialSnapshot = {
    manifest: portableRelative(repoRoot, officialManifestFile.path),
    manifestSha256: officialManifestFile.sha256,
    corpusSha256: officialManifest.corpusSha256,
    suites: expectedOfficialSuites,
    rows: officialRows.length,
    trainingIsolation: isolation
  };
  const expectedExportOfficial = {
    ...expectedOfficialSnapshot,
    predictions: portableRelative(
      repoRoot,
      retainedFiles.comparisonPredictions.path
    ),
    predictionsSha256: retainedFiles.comparisonPredictions.sha256,
    predictionsBackend: descriptor.predictionsBackend,
    predictionArtifactIdentity: expectedPredictionArtifactIdentity
  };
  if (
    officialManifest.corpusSha256 !== comparison.benchmarkCorpusSha256 ||
    officialManifest.corpusSha256 !==
      winner.bindings.benchmarkCorpusSha256 ||
    comparison.predictionRows !== officialRows.length ||
    canonicalJson(exportOfficial) !==
      canonicalJson(expectedExportOfficial) ||
    canonicalJson(snapshotOfficial) !==
      canonicalJson(expectedOfficialSnapshot) ||
    comparison.predictionsBackend !== descriptor.predictionsBackend ||
    canonicalJson(exportOfficial?.predictionArtifactIdentity) !==
      canonicalJson(expectedPredictionArtifactIdentity) ||
    canonicalJson(comparison.predictionArtifactIdentity) !==
      canonicalJson(expectedPredictionArtifactIdentity) ||
    canonicalJson(comparison.benchmarkIsolation) !==
      canonicalJson(isolation) ||
    Object.prototype.hasOwnProperty.call(
      exportReport.artifactOverrides ?? {},
      "officialBenchmarkManifest"
    )
  ) {
    fail(
      "Retained official benchmark corpus, predictions, compiled-artifact " +
      "identity, or training-isolation evidence is stale."
    );
  }
  const referenceManifest = readJsonEvidence(
    repoRoot,
    CANONICAL_REFERENCE_MANIFEST,
    "Canonical IndicXlit reference manifest",
    16 * 1024 * 1024
  );
  if (
    referenceManifest.file.sha256 !==
      CANONICAL_REFERENCE_MANIFEST_SHA256 ||
    safePath(
      repoRoot,
      comparison.reference?.manifest,
      "Retained official benchmark reference manifest"
    ) !== referenceManifest.file.path ||
    comparison.reference?.manifestSha256 !==
      referenceManifest.file.sha256
  ) {
    fail(
      "Retained official benchmark reference manifest is not the canonical " +
      "locked release."
    );
  }
  const referenceArtifact = referenceManifest.value.predictionArtifact;
  if (
    referenceManifest.value.benchmark?.manifest !==
      CANONICAL_OFFICIAL_BENCHMARK_MANIFEST ||
    referenceManifest.value.benchmark?.manifestSha256 !==
      officialManifestFile.sha256 ||
    referenceManifest.value.benchmark?.corpusSha256 !==
      officialManifest.corpusSha256 ||
    referenceManifest.value.benchmark?.rows !== officialRows.length
  ) {
    fail(
      "Canonical IndicXlit reference metadata does not bind the retained " +
      "official benchmark release."
    );
  }
  const referencePredictions = inspectContainedRegularFile(
    repoRoot,
    safePath(
      repoRoot,
      referenceArtifact?.path,
      "Canonical IndicXlit reference predictions"
    ),
    {
      label: "Canonical IndicXlit reference predictions",
      includeContents: true,
      maxBytes: 64 * 1024 * 1024
    }
  );
  if (
    referencePredictions.sha256 !== referenceArtifact?.sha256 ||
    referencePredictions.bytes !== referenceArtifact?.bytes ||
    referenceArtifact?.rows !== officialRows.length ||
    safePath(
      repoRoot,
      comparison.reference?.predictions,
      "Retained official benchmark reference predictions"
    ) !== referencePredictions.path ||
    comparison.reference?.predictionsSha256 !==
      referencePredictions.sha256
  ) {
    fail(
      "Retained official benchmark reference predictions are stale or not " +
      "the canonical locked artifact."
    );
  }
  const officialMetricReplay =
    validateRecomputedOfficialBenchmarkEvaluation({
      report: comparison,
      benchmarkRows: officialRows,
      candidatePredictionRows: parseJsonLineObjects(
        retainedFiles.comparisonPredictions.contents,
        "Retained official benchmark predictions"
      ),
      referencePredictionRows: parseJsonLineObjects(
        referencePredictions.contents,
        "Canonical IndicXlit reference predictions"
      )
    });
  if (!officialMetricReplay.valid) {
    fail(
      "Retained official benchmark metrics do not match independent " +
      `recomputation: ${officialMetricReplay.issueCodes.join(", ")}.`
    );
  }
  const expectedWinnerMetrics = retainedWinnerMetrics({
    goldReplay: goldMetricReplay.recomputed,
    officialReplay: officialMetricReplay.recomputed,
    benchmarkP99Ms:
      nativeBenchmarkReplay.evidence.performance.p99Ms,
    descriptor
  });
  if (canonicalJson(winner.metrics) !==
      canonicalJson(expectedWinnerMetrics)) {
    fail(
      "Selection winner metrics do not match independent gold, official " +
      "benchmark, latency, and compiled-size recomputation."
    );
  }

  if (descriptor.modelId === "lekh-open-vocab-ctc-transformer-v2") {
    const rare = retainedRareValues?.report;
    const generation = retainedRareValues?.generationReport;
    const contract = retainedRareValues?.contract;
    const records = receipt.rareScalarEvidence;
    const rareEvaluation = rare?.evaluation;
    if (!isCTCFinitePathDecoderPolicy(
      exportReport.coremlExport?.finitePathDecoderPolicy
    )) {
      fail("Retained Transformer-CTC export lacks finite-path decoder evidence.");
    }
    if (!hasCTCCoreMLParityEvidence(exportReport.coremlExport)) {
      fail(
        "Retained Transformer-CTC export lacks representative compiled " +
        "Core ML parity evidence."
      );
    }
    if (
      rare?.schemaVersion !== 1 ||
      rare?.status !== "passed-neural-rare-scalar-production-gate" ||
      rare?.productionEligible !== true ||
      rare?.modelId !== descriptor.modelId ||
      rare?.trainingRunId !== receipt.trainingRunId ||
      rare?.exportRunId !== receipt.exportRunId ||
      !Array.isArray(rare?.failures) ||
      rare.failures.length !== 0 ||
      !Array.isArray(rare?.warnings) ||
      rareEvaluation?.status !==
        "passed-neural-rare-scalar-evaluation" ||
      rareEvaluation?.productionGatePassed !== true ||
      !Array.isArray(rareEvaluation?.failures) ||
      rareEvaluation.failures.length !== 0 ||
      !Array.isArray(rareEvaluation?.spuriousNonExemplarTop1) ||
      rareEvaluation.spuriousNonExemplarTop1.length !== 0
    ) {
      fail("Retained rare-scalar evaluation did not pass its production gate.");
    }
    for (const [observed, expected, label] of [
      [rare.exportReport, receipt.inputs.exportReport, "export report"],
      [rare.datasetManifest, receipt.inputs.datasetManifest, "dataset manifest"],
      [rare.gold?.manifest, receipt.inputs.goldManifest, "gold manifest"],
      [rare.gold?.predictions, receipt.inputs.predictions, "gold predictions"],
      [
        rare.officialBenchmark?.manifest,
        receipt.inputs.comparisonBenchmarkManifest,
        "official benchmark manifest"
      ],
      [
        rare.officialBenchmark?.predictions,
        receipt.inputs.comparisonPredictions,
        "official benchmark predictions"
      ],
      [rare.generationReport, records.generationReport, "generation report"],
      [rare.probePredictions, records.predictions, "probe predictions"],
      [rare.contract, records.contract, "probe contract"],
      [rare.ctcAudit, records.ctcAudit, "CTC audit"]
    ]) {
      if (
        observed?.path !== expected?.path ||
        observed?.bytes !== expected?.bytes ||
        observed?.sha256 !== expected?.sha256
      ) {
        fail(`Retained rare-scalar ${label} evidence is stale.`);
      }
    }
    if (
      rare.datasetManifest.contentSha256 !==
        receipt.inputs.datasetContentSha256 ||
      rare.gold?.corpusSha256 !== receipt.inputs.goldCorpusSha256 ||
      rare.gold?.rows !== evaluation.goldRows ||
      rare.officialBenchmark?.corpusSha256 !==
        comparison.benchmarkCorpusSha256 ||
      rare.officialBenchmark?.rows !== comparison.predictionRows ||
      rareEvaluation.lockedEvaluationRows !==
        rare.gold.rows + rare.officialBenchmark.rows ||
      rareEvaluation.probeRows !== rare.probePredictions.rows ||
      rare.artifactIdentity?.manifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      rare.artifactIdentity?.vocabSha256 !== descriptor.vocabSha256 ||
      rare.artifactIdentity?.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      rare.artifactIdentity?.checkpointSha256 !==
        receipt.inputs.checkpoint.sha256
    ) {
      fail("Retained rare-scalar corpus or artifact identity is stale.");
    }
    if (
      generation?.schemaVersion !== 1 ||
      generation?.status !==
        "passed-neural-rare-scalar-prediction-generation" ||
      generation?.modelId !== descriptor.modelId ||
      generation?.trainingRunId !== receipt.trainingRunId ||
      generation?.exportRunId !== receipt.exportRunId ||
      generation?.productionEligible !== false ||
      generation?.predictionsBackend !==
        "coreml-compiled-transformer-ctc" ||
      canonicalJson(generation?.finitePathDecoderPolicy) !==
        canonicalJson(CTC_FINITE_PATH_DECODER_POLICY) ||
      generation?.predictions?.path !== records.predictions.path ||
      generation?.predictions?.sha256 !== records.predictions.sha256 ||
      generation?.predictions?.rows !== rare.probePredictions.rows ||
      generation?.contract?.path !== records.contract.path ||
      generation?.contract?.sha256 !== records.contract.sha256 ||
      generation?.contract?.ctcAuditSha256 !== records.ctcAudit.sha256 ||
      generation?.candidate?.exportReportSha256 !==
        receipt.inputs.exportReport.sha256 ||
      generation?.candidate?.manifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      generation?.candidate?.checkpointSha256 !==
        receipt.inputs.checkpoint.sha256 ||
      generation?.candidate?.vocabularySha256 !== descriptor.vocabSha256 ||
      generation?.coremlValidation?.status !== "passed" ||
      generation?.coremlValidation?.runtimeModelContract !==
        descriptor.runtimeModelContract
    ) {
      fail("Retained rare-scalar generation attestation is stale.");
    }
    if (
      contract?.schemaVersion !== 1 ||
      contract?.contentIdentity !==
        "lekh-neural-ctc-rare-output-scalar-probes-v1" ||
      contract?.status !== "frozen-dataset-derived-diagnostic" ||
      contract?.dataset?.manifest !== receipt.inputs.datasetManifest.path ||
      contract?.dataset?.manifestSha256 !==
        receipt.inputs.datasetManifest.sha256 ||
      contract?.dataset?.contentSha256 !==
        receipt.inputs.datasetContentSha256 ||
      contract?.ctcAudit?.path !== records.ctcAudit.path ||
      contract?.ctcAudit?.sha256 !== records.ctcAudit.sha256 ||
      !Array.isArray(contract?.scalars) ||
      contract.scalars.length < 1
    ) {
      fail("Retained rare-scalar contract is stale.");
    }
    const rareScalarContractValidation =
      validateNeuralRareScalarContract({
        contract,
        ctcAudit: retainedRareValues.ctcAudit,
        ctcAuditPath: records.ctcAudit.path,
        ctcAuditSha256: records.ctcAudit.sha256,
        datasetManifest,
        datasetManifestPath: receipt.inputs.datasetManifest.path,
        datasetManifestSha256: receipt.inputs.datasetManifest.sha256
      });
    if (!rareScalarContractValidation.ok) {
      fail(
        "Retained rare-scalar contract does not match the independently " +
        "reopened dataset and CTC audit: " +
        `${rareScalarContractValidation.failures.join(" ")}`
      );
    }
    const recomputedRareEvaluation = evaluateNeuralRareScalarEvidence({
      contract,
      probePredictions: parsePredictionRows(
        retainedRareFiles.predictions.contents,
        "Retained rare-scalar predictions"
      ),
      lockedEvaluations: [
        {
          label: "gold",
          rows: goldRows,
          predictions: parsePredictionRows(
            retainedFiles.predictions.contents,
            "Retained gold predictions"
          )
        },
        {
          label: "official-benchmark",
          rows: officialRows,
          predictions: parsePredictionRows(
            retainedFiles.comparisonPredictions.contents,
            "Retained official benchmark predictions"
          )
        }
      ]
    });
    if (
      goldRows.length !== rare.gold.rows ||
      officialRows.length !== rare.officialBenchmark.rows ||
      canonicalJson(recomputedRareEvaluation) !==
        canonicalJson(rareEvaluation) ||
      canonicalJson(recomputedRareEvaluation.warnings) !==
        canonicalJson(rare.warnings)
    ) {
      fail(
        "Retained rare-scalar evaluation does not match independent " +
        "recomputation from locked prediction evidence."
      );
    }
  } else if (retainedRareValues !== null) {
    fail("Non-CTC promotion retained unexpected rare-scalar evidence.");
  }

  if (goldManifest.corpusSha256 !== receipt.inputs.goldCorpusSha256 ||
      datasetManifest.datasetContentSha256 !==
        receipt.inputs.datasetContentSha256) {
    fail("Retained corpus identities do not match their manifests.");
  }
  return {
    productionMetrics: productionMetricsProjection.metrics
  };
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

function retainedPredictionArtifactIdentity({
  repoRoot,
  candidateRoot,
  exportReport,
  descriptor
}) {
  const compiledArtifacts = {};
  if (descriptor.runtimeModelContract ===
      "split-attention-incremental-v1") {
    for (const artifact of descriptor.artifacts) {
      const declared = exportReport.compiledModels?.[artifact.role];
      const sourcePath = safePath(
        repoRoot,
        declared?.compiledModel,
        `Export ${artifact.role} compiled model`
      );
      const sha256 = requireSha256(
        declared?.compiledSha256,
        `Export ${artifact.role} compiled model SHA-256`
      );
      const bytes = declared?.compiledBytes;
      if (!isStrictlyWithin(candidateRoot, sourcePath) ||
          !Number.isSafeInteger(bytes) ||
          bytes !== artifact.compiledBytes ||
          sha256 !== artifact.compiledSha256) {
        fail(
          `Export ${artifact.role} compiled model identity differs from the ` +
          "promoted artifact."
        );
      }
      const sourceEvidence = inspectContainedDirectoryTree(
        repoRoot,
        sourcePath,
        {
          label: `Retained candidate ${artifact.role} compiled model`,
          maxBytes: 64 * 1024 * 1024,
          maxEntries: 10_000
        }
      );
      if (sourceEvidence.sha256 !== sha256 ||
          sourceEvidence.bytes !== bytes) {
        fail(
          `Retained candidate ${artifact.role} compiled model bytes differ ` +
          "from the export identity."
        );
      }
      compiledArtifacts[artifact.role] = {
        path: portableRelative(repoRoot, sourcePath),
        sha256,
        bytes
      };
    }
  } else {
    if (descriptor.artifacts.length !== 1) {
      fail("Single-model export must resolve exactly one compiled artifact.");
    }
    const artifact = descriptor.artifacts[0];
    const sourcePath = safePath(
      repoRoot,
      exportReport.compiledModel,
      "Export compiled model"
    );
    const sha256 = requireSha256(
      exportReport.compiledModelSha256,
      "Export compiled model SHA-256"
    );
    if (!isStrictlyWithin(candidateRoot, sourcePath) ||
        sha256 !== artifact.compiledSha256) {
      fail(
        "Export compiled model identity differs from the promoted artifact."
      );
    }
    const sourceEvidence = inspectContainedDirectoryTree(
      repoRoot,
      sourcePath,
      {
        label: "Retained candidate compiled model",
        maxBytes: 64 * 1024 * 1024,
        maxEntries: 10_000
      }
    );
    if (sourceEvidence.sha256 !== sha256 ||
        sourceEvidence.bytes !== artifact.compiledBytes) {
      fail(
        "Retained candidate compiled model bytes differ from the export " +
        "identity."
      );
    }
    compiledArtifacts[artifact.role] = {
      path: portableRelative(repoRoot, sourcePath),
      sha256,
      bytes: sourceEvidence.bytes
    };
  }
  return {
    runtimeModelContract: descriptor.runtimeModelContract,
    compiledArtifacts
  };
}

function retainedWinnerMetrics({
  goldReplay,
  officialReplay,
  benchmarkP99Ms,
  descriptor
}) {
  const goldMetrics = goldReplay.metrics;
  const officialMetrics = officialReplay.metrics;
  const indianNames = officialMetrics?.byBucket?.["indian-name"];
  const foreignNames = officialMetrics?.byBucket?.["foreign-name"];
  const nameRows = indianNames?.rows + foreignNames?.rows;
  const nameTop1Hits =
    indianNames?.top1Hits + foreignNames?.top1Hits;
  if (!goldMetrics || !officialMetrics ||
      !Number.isSafeInteger(nameRows) || nameRows < 1 ||
      !Number.isSafeInteger(nameTop1Hits) ||
      nameTop1Hits < 0 || nameTop1Hits > nameRows ||
      !Number.isFinite(benchmarkP99Ms) ||
      benchmarkP99Ms < 0 ||
      benchmarkP99Ms >= 50) {
    fail("Recomputed selection metrics are incomplete.");
  }
  return {
    officialOverallTop1Accuracy:
      officialMetrics.overall.top1Accuracy,
    officialOverallTop3Accuracy:
      officialMetrics.overall.top3Accuracy,
    officialNativeTop1Accuracy:
      officialMetrics.byBucket["native-frequent"].top1Accuracy,
    officialNameTop1Accuracy:
      roundMetric(nameTop1Hits / nameRows),
    goldTailTop1Accuracy: goldMetrics.tailTop1Accuracy,
    goldTailTop3Accuracy: goldMetrics.tailTop3Accuracy,
    latencyP99Ms: benchmarkP99Ms,
    compiledBytes: descriptor.totalCompiledBytes
  };
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function verifyProductionManifestDerivation({
  repoRoot,
  productionDirectory,
  receipt,
  manifest,
  retainedValues,
  productionMetrics
}) {
  const expected = structuredClone(retainedValues.candidateManifest);
  expected.productionEligible = true;
  expected.metrics = structuredClone(productionMetrics);
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
  const memory = structuredClone(benchmarkReport.memory);
  const memoryValidation =
    validateNeuralPostExportMemoryEvidence(memory);
  if (!memoryValidation.valid) {
    fail(
      `Retained benchmark process-memory evidence is invalid: ` +
      `${memoryValidation.issueCodes.join(", ")}.`
    );
  }
  const devices = sourceDevices.map((device) => {
    const deviceMemory = structuredClone(device?.memory);
    const deviceMemoryValidation =
      validateNeuralPostExportMemoryEvidence(deviceMemory);
    if (!deviceMemoryValidation.valid) {
      fail(
        "Retained benchmark device memory is invalid: " +
        `${deviceMemoryValidation.issueCodes.join(", ")}.`
      );
    }
    return {
      name: device?.name,
      macOS: device?.macOS,
      architecture: device?.architecture,
      packagedApp: device?.packagedApp,
      secureFieldInferenceCount: device?.secureFieldInferenceCount,
      p50Ms: device?.p50Ms,
      p95Ms: device?.p95Ms,
      p99Ms: device?.p99Ms,
      artifact: device?.artifact,
      measurementKind: device?.measurementKind,
      memory: deviceMemory
    };
  });
  const canonicalMemoryValidation =
    validateCanonicalNeuralMemorySummary(
      memory,
      devices.map((device) => device.memory)
    );
  if (!canonicalMemoryValidation.valid) {
    fail(
      "Retained benchmark process-memory summary is not the exact worst " +
      `observed device row: ${
        canonicalMemoryValidation.issueCodes.join(", ")
      }.`
    );
  }
  return {
    p50Ms: source.p50Ms,
    p95Ms: source.p95Ms,
    p99Ms: source.p99Ms,
    targetP99Ms: 50,
    measuredOnDevice: true,
    memory,
    devices
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

function loadLockedEvaluationRows({
  repoRoot,
  manifest,
  label
}) {
  if (
    !Array.isArray(manifest?.suites) ||
    manifest.suites.length < 1 ||
    suiteCorpusSha256(manifest.suites) !== manifest.corpusSha256
  ) {
    fail(`${label} manifest suite inventory is stale or invalid.`);
  }
  const seenSuites = new Set();
  const seenRows = new Set();
  const rows = [];
  for (const suite of manifest.suites) {
    if (
      !suite ||
      typeof suite !== "object" ||
      typeof suite.id !== "string" ||
      !suite.id ||
      seenSuites.has(suite.id) ||
      typeof suite.path !== "string" ||
      !suite.path ||
      isAbsolute(suite.path) ||
      suite.path.split(/[\\/]/u).includes("..") ||
      !SHA256_PATTERN.test(String(suite.sha256 ?? "")) ||
      !Number.isSafeInteger(suite.rows) ||
      suite.rows < 1
    ) {
      fail(`${label} manifest contains an invalid suite record.`);
    }
    seenSuites.add(suite.id);
    const suiteEvidence = inspectContainedRegularFile(
      repoRoot,
      safePath(
        repoRoot,
        suite.path,
        `${label} suite ${suite.id}`
      ),
      {
        label: `${label} suite ${suite.id}`,
        includeContents: true,
        maxBytes: 64 * 1024 * 1024
      }
    );
    if (suiteEvidence.sha256 !== suite.sha256) {
      fail(`${label} suite ${suite.id} bytes are stale.`);
    }
    const suiteRows = parseJsonLineObjects(
      suiteEvidence.contents,
      `${label} suite ${suite.id}`
    );
    if (suiteRows.length !== suite.rows) {
      fail(`${label} suite ${suite.id} row count is stale.`);
    }
    for (const row of suiteRows) {
      if (
        typeof row.id !== "string" ||
        !row.id ||
        seenRows.has(row.id) ||
        typeof row.input !== "string" ||
        !row.input
      ) {
        fail(`${label} contains an invalid or duplicate row identity.`);
      }
      seenRows.add(row.id);
      rows.push({
        ...row,
        suiteId: suite.id,
        suitePath: suite.path,
        ...(suite.benchmarkBucket === undefined
          ? {}
          : { benchmarkBucket: suite.benchmarkBucket })
      });
    }
  }
  return rows;
}

function parsePredictionRows(contents, label) {
  const rows = parseJsonLineObjects(contents, label);
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
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
  }
  return rows;
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
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      fail(`${label} row ${index + 1} must be an object.`);
    }
    return row;
  });
}

function suiteCorpusSha256(suites) {
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
      includeContents: Boolean(
        options.includeContents || options.json
      ),
      maxBytes: label.includes("checkpoint")
        ? 512 * 1024 * 1024
        : label.toLowerCase().includes("predictions")
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

function immutableRunInputSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return snapshot;
  }
  const immutable = structuredClone(snapshot);
  delete immutable.runtime;
  return immutable;
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
