import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { TextDecoder } from "node:util";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
const MAX_PREDICTION_BYTES = 256 * 1024 * 1024;
const MAX_MEASUREMENT_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 16_384;
const SPLIT_RUNTIME_CONTRACT = "split-attention-incremental-v1";
const CTC_RUNTIME_CONTRACT = "single-transformer-ctc-v1";
const SINGLE_RUNTIME_CONTRACTS = new Set([
  "single-seq2seq-v1",
  CTC_RUNTIME_CONTRACT
]);
const SPLIT_ROLES = Object.freeze(["encoder", "decoderStep"]);

export class NeuralCandidateEvidenceCustodyError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = "NeuralCandidateEvidenceCustodyError";
  }
}

/**
 * Inspect the complete candidate-owned evidence set and bind it to the
 * candidate manifest and export report.
 *
 * The caller supplies only four trust anchors. Every other path is read from
 * authenticated report bytes, must be canonical repository-relative text,
 * and must resolve beneath the same real candidate directory without any
 * symbolic-link component.
 */
export function inspectNeuralCandidateEvidenceCustody(options = {}) {
  try {
    return inspectCustody(options);
  } catch (error) {
    if (error instanceof NeuralCandidateEvidenceCustodyError) throw error;
    throw new NeuralCandidateEvidenceCustodyError(
      `Neural candidate evidence custody failed: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

function inspectCustody(options) {
  const location = resolveCandidateLocation(
    options.repoRoot ?? process.cwd(),
    options.candidateRoot
  );
  const manifestEvidence = inspectAnchorFile(
    location,
    options.manifestPath ?? options.candidateManifest,
    "Candidate manifest",
    MAX_JSON_BYTES,
    true
  );
  const vocabularyEvidence = inspectAnchorFile(
    location,
    options.vocabPath ?? options.vocabulary,
    "Candidate vocabulary",
    MAX_JSON_BYTES,
    false
  );
  const exportReportEvidence = inspectAnchorFile(
    location,
    options.exportReportPath ?? options.exportReport,
    "Candidate export report",
    MAX_JSON_BYTES,
    true
  );
  assertDistinctEvidence(
    [manifestEvidence, vocabularyEvidence, exportReportEvidence],
    "Candidate trust-anchor files"
  );

  const manifest = parseJsonEvidence(manifestEvidence, "Candidate manifest");
  const exportReport = parseJsonEvidence(
    exportReportEvidence,
    "Candidate export report"
  );
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: location.repoRoot,
    manifest,
    manifestPath: manifestEvidence.path,
    vocabPath: vocabularyEvidence.path
  });

  requirePathBinding(
    location,
    exportReport.manifest,
    manifestEvidence.path,
    "exportReport.manifest"
  );
  requireSha256Binding(
    exportReport.manifestSha256,
    manifestEvidence.sha256,
    "exportReport.manifestSha256"
  );
  requireEqual(
    exportReport.modelId,
    descriptor.modelId,
    "exportReport.modelId does not match the candidate manifest."
  );

  const trainingReportEvidence = inspectDeclaredFile(
    location,
    exportReport.trainingReport,
    "Candidate training report",
    MAX_JSON_BYTES,
    true
  );
  requireSha256Binding(
    exportReport.trainingReportSha256,
    trainingReportEvidence.sha256,
    "exportReport.trainingReportSha256"
  );
  const trainingReport = parseJsonEvidence(
    trainingReportEvidence,
    "Candidate training report"
  );

  const checkpointEvidence = inspectDeclaredFile(
    location,
    exportReport.checkpoint,
    "Candidate checkpoint",
    MAX_CHECKPOINT_BYTES
  );
  requireSha256Binding(
    exportReport.checkpointSha256,
    checkpointEvidence.sha256,
    "exportReport.checkpointSha256"
  );
  requirePathBinding(
    location,
    trainingReport.checkpoint,
    checkpointEvidence.path,
    "trainingReport.checkpoint"
  );
  requireSha256Binding(
    trainingReport.checkpointSha256,
    checkpointEvidence.sha256,
    "trainingReport.checkpointSha256"
  );
  requireSha256Binding(
    manifest.sha256?.sourceCheckpoint,
    checkpointEvidence.sha256,
    "manifest.sha256.sourceCheckpoint"
  );

  if (
    trainingReport.vocabMetadata !== undefined ||
    trainingReport.vocabMetadataSha256 !== undefined
  ) {
    requirePathBinding(
      location,
      trainingReport.vocabMetadata,
      vocabularyEvidence.path,
      "trainingReport.vocabMetadata"
    );
    requireSha256Binding(
      trainingReport.vocabMetadataSha256,
      vocabularyEvidence.sha256,
      "trainingReport.vocabMetadataSha256"
    );
  }
  requireSha256Binding(
    manifest.sha256?.vocabMetadata,
    vocabularyEvidence.sha256,
    "manifest.sha256.vocabMetadata"
  );

  requireEqual(
    exportReport.trainingRunId,
    trainingReport.trainingRunId,
    "Export and training reports bind different trainingRunId values."
  );
  if (trainingReport.modelId !== undefined) {
    requireEqual(
      trainingReport.modelId,
      descriptor.modelId,
      "Training report and manifest bind different modelId values."
    );
  }
  requireEqual(
    exportReport.trainingRunId,
    manifest.trainingRunId,
    "Export report and manifest bind different trainingRunId values."
  );
  requireEqual(
    exportReport.exportRunId,
    manifest.exportRunId,
    "Export report and manifest bind different exportRunId values."
  );

  const goldPredictionsEvidence = inspectDeclaredFile(
    location,
    exportReport.predictions,
    "Candidate gold predictions",
    MAX_PREDICTION_BYTES
  );
  requireSha256Binding(
    exportReport.predictionsSha256,
    goldPredictionsEvidence.sha256,
    "exportReport.predictionsSha256"
  );
  requireEqual(
    exportReport.predictionsBackend,
    descriptor.predictionsBackend,
    "Gold predictions use a backend that does not match the runtime artifact set."
  );

  requireRecord(
    exportReport.comparisonBenchmark,
    "exportReport.comparisonBenchmark"
  );
  const officialPredictionsEvidence = inspectDeclaredFile(
    location,
    exportReport.comparisonBenchmark.predictions,
    "Candidate official-benchmark predictions",
    MAX_PREDICTION_BYTES
  );
  requireSha256Binding(
    exportReport.comparisonBenchmark.predictionsSha256,
    officialPredictionsEvidence.sha256,
    "exportReport.comparisonBenchmark.predictionsSha256"
  );
  requireEqual(
    exportReport.comparisonBenchmark.predictionsBackend,
    descriptor.predictionsBackend,
    "Official predictions use a backend that does not match the runtime artifact set."
  );

  const measurementsEvidence = exportReport.measurements == null
    ? null
    : inspectDeclaredFile(
        location,
        exportReport.measurements,
        "Candidate export measurements",
        MAX_MEASUREMENT_BYTES
      );
  if (measurementsEvidence) {
    requireSha256Binding(
      exportReport.measurementsSha256,
      measurementsEvidence.sha256,
      "exportReport.measurementsSha256"
    );
  } else if (exportReport.measurementsSha256 != null) {
    fail(
      "exportReport.measurementsSha256 is declared without a measurements path."
    );
  }

  const artifactEvidence = inspectArtifactCustody({
    location,
    manifest,
    exportReport,
    descriptor,
    checkpointEvidence
  });
  const retainedFileEvidence = [
    manifestEvidence,
    vocabularyEvidence,
    exportReportEvidence,
    trainingReportEvidence,
    checkpointEvidence,
    goldPredictionsEvidence,
    officialPredictionsEvidence,
    ...(measurementsEvidence ? [measurementsEvidence] : [])
  ];
  assertFilesOutsideArtifactDirectories(
    retainedFileEvidence,
    artifactEvidence.directoryEvidence
  );
  const expectedPredictionArtifactIdentity = {
    runtimeModelContract: descriptor.runtimeModelContract,
    compiledArtifacts: Object.fromEntries(
      descriptor.artifacts.map((artifact) => [
        artifact.role,
        {
          path: portable(location.repoRoot, artifact.sourcePath),
          sha256: artifact.compiledSha256,
          bytes: artifact.compiledBytes
        }
      ])
    )
  };
  requireDeepEqual(
    exportReport.comparisonBenchmark.predictionArtifactIdentity,
    expectedPredictionArtifactIdentity,
    "Official predictions are not bound to the exact compiled artifact set."
  );

  const fileEvidence = {
    manifest: summarizeFile(manifestEvidence),
    vocabulary: summarizeFile(vocabularyEvidence),
    exportReport: summarizeFile(exportReportEvidence),
    trainingReport: summarizeFile(trainingReportEvidence),
    checkpoint: summarizeFile(checkpointEvidence),
    goldPredictions: summarizeFile(goldPredictionsEvidence),
    officialPredictions: summarizeFile(officialPredictionsEvidence),
    ...(measurementsEvidence
      ? { measurements: summarizeFile(measurementsEvidence) }
      : {})
  };
  assertDistinctEvidence(
    retainedFileEvidence,
    "Candidate evidence files"
  );

  const custodySetIdentity = {
    schemaVersion: 1,
    candidateRoot: location.candidateRelativePath,
    modelId: descriptor.modelId,
    runtimeModelContract: descriptor.runtimeModelContract,
    artifactSetSha256: descriptor.artifactSetSha256,
    files: fileEvidence,
    compiledArtifacts: artifactEvidence.compiledArtifacts,
    exportPackages: artifactEvidence.exportPackages
  };

  return deepFreeze({
    schemaVersion: 1,
    candidateRoot: location.candidateRoot,
    candidateRootRelativePath: location.candidateRelativePath,
    modelId: descriptor.modelId,
    runtimeModelContract: descriptor.runtimeModelContract,
    predictionsBackend: descriptor.predictionsBackend,
    trainingRunId: exportReport.trainingRunId,
    exportRunId: exportReport.exportRunId,
    artifactSetSha256: descriptor.artifactSetSha256,
    files: fileEvidence,
    compiledArtifacts: artifactEvidence.compiledArtifacts,
    exportPackages: artifactEvidence.exportPackages,
    custodySetIdentity,
    custodySetSha256: sha256CanonicalJson(custodySetIdentity)
  });
}

function inspectArtifactCustody({
  location,
  manifest,
  exportReport,
  descriptor,
  checkpointEvidence
}) {
  if (descriptor.runtimeModelContract === SPLIT_RUNTIME_CONTRACT) {
    return inspectSplitArtifactCustody({
      location,
      manifest,
      exportReport,
      descriptor,
      checkpointEvidence
    });
  }
  if (!SINGLE_RUNTIME_CONTRACTS.has(descriptor.runtimeModelContract)) {
    fail(
      `Unsupported runtime artifact contract ${descriptor.runtimeModelContract}.`
    );
  }
  return inspectSingleArtifactCustody({
    location,
    manifest,
    exportReport,
    descriptor,
    checkpointEvidence
  });
}

function inspectSingleArtifactCustody({
  location,
  exportReport,
  descriptor,
  checkpointEvidence
}) {
  requireExactRoles(
    descriptor.artifacts.map((artifact) => artifact.role),
    ["model"],
    "Single-model descriptor"
  );
  const descriptorArtifact = descriptor.artifacts[0];
  const compiledPath = resolveRecordedCandidatePath(
    location,
    exportReport.compiledModel,
    "exportReport.compiledModel"
  );
  requireSamePath(
    compiledPath,
    descriptorArtifact.sourcePath,
    "Export report and manifest resolve different compiled models."
  );
  const compiledEvidence = inspectCandidateDirectory(
    location,
    compiledPath,
    "Candidate compiled model"
  );
  requireDirectoryBinding(
    compiledEvidence,
    {
      sha256: exportReport.compiledModelSha256,
      bytes: descriptorArtifact.compiledBytes
    },
    "Candidate compiled model"
  );
  requireSha256Binding(
    descriptorArtifact.compiledSha256,
    compiledEvidence.sha256,
    "Runtime descriptor compiled-model digest"
  );
  requirePathBinding(
    location,
    exportReport.coremlExport?.compiledModel,
    compiledEvidence.path,
    "exportReport.coremlExport.compiledModel"
  );
  requireSha256Binding(
    exportReport.coremlExport?.compiledSha256,
    compiledEvidence.sha256,
    "exportReport.coremlExport.compiledSha256"
  );

  const packageEvidence = inspectDeclaredDirectory(
    location,
    exportReport.mlpackage,
    "Candidate Core ML package"
  );
  requireSha256Binding(
    exportReport.mlpackageSha256,
    packageEvidence.sha256,
    "exportReport.mlpackageSha256"
  );
  requirePathBinding(
    location,
    exportReport.coremlExport?.mlpackage,
    packageEvidence.path,
    "exportReport.coremlExport.mlpackage"
  );
  requireSha256Binding(
    exportReport.coremlExport?.mlpackageSha256,
    packageEvidence.sha256,
    "exportReport.coremlExport.mlpackageSha256"
  );
  requireOptionalByteBinding(
    exportReport.coremlExport?.compiledBytes,
    compiledEvidence.bytes,
    "exportReport.coremlExport.compiledBytes"
  );
  requireOptionalByteBinding(
    exportReport.coremlExport?.mlpackageBytes,
    packageEvidence.bytes,
    "exportReport.coremlExport.mlpackageBytes"
  );
  inspectOptionalSingleArtifactValidation({
    validation: exportReport.coremlExport?.artifactValidation,
    compiledEvidence,
    packageEvidence,
    checkpointEvidence
  });
  assertDistinctDirectoryEvidence(
    [compiledEvidence, packageEvidence],
    "Single-model artifact directories"
  );

  if (descriptor.runtimeModelContract === CTC_RUNTIME_CONTRACT) {
    requireEqual(
      exportReport.runtimeModelContract,
      CTC_RUNTIME_CONTRACT,
      "CTC export report runtimeModelContract is stale."
    );
    requireEqual(
      exportReport.coremlExport?.runtimeModelContract,
      CTC_RUNTIME_CONTRACT,
      "CTC Core ML export runtimeModelContract is stale."
    );
    requireSha256Binding(
      exportReport.coremlExport?.sourceCheckpointSha256,
      checkpointEvidence.sha256,
      "exportReport.coremlExport.sourceCheckpointSha256"
    );
    requireDeepEqual(
      exportReport.coremlExport?.tensorContract,
      descriptor.tensorContract,
      "CTC Core ML export tensorContract differs from the manifest."
    );
  } else if (
    exportReport.runtimeModelContract != null &&
    exportReport.runtimeModelContract !== descriptor.runtimeModelContract
  ) {
    fail("Baseline export report runtimeModelContract is inconsistent.");
  }

  return {
    compiledArtifacts: {
      model: summarizeDirectory(compiledEvidence)
    },
    exportPackages: {
      model: summarizeDirectory(packageEvidence)
    },
    directoryEvidence: [compiledEvidence, packageEvidence]
  };
}

function inspectSplitArtifactCustody({
  location,
  manifest,
  exportReport,
  descriptor,
  checkpointEvidence
}) {
  requireEqual(
    exportReport.runtimeModelContract,
    SPLIT_RUNTIME_CONTRACT,
    "Split export report runtimeModelContract is stale."
  );
  requireEqual(
    exportReport.coremlExport?.runtimeModelContract,
    SPLIT_RUNTIME_CONTRACT,
    "Split Core ML export runtimeModelContract is stale."
  );
  if (exportReport.sourceCheckpointSha256 !== undefined) {
    requireSha256Binding(
      exportReport.sourceCheckpointSha256,
      checkpointEvidence.sha256,
      "exportReport.sourceCheckpointSha256"
    );
  }
  requireExactKeys(
    manifest.compiledModels,
    SPLIT_ROLES,
    "manifest.compiledModels"
  );
  requireExactKeys(
    exportReport.compiledModels,
    SPLIT_ROLES,
    "exportReport.compiledModels"
  );
  requireExactKeys(
    exportReport.coremlExport?.artifacts,
    SPLIT_ROLES,
    "exportReport.coremlExport.artifacts"
  );
  requireDeepEqual(
    exportReport.compiledModels,
    manifest.compiledModels,
    "Split export and manifest artifact declarations differ."
  );
  requireDeepEqual(
    exportReport.coremlExport.artifacts,
    manifest.compiledModels,
    "Split Core ML export and manifest artifact declarations differ."
  );
  if (exportReport.tensorContract !== undefined) {
    requireDeepEqual(
      exportReport.tensorContract,
      descriptor.tensorContract,
      "Split export tensorContract differs from the manifest."
    );
  }
  if (exportReport.coremlExport?.tensorContract !== undefined) {
    requireDeepEqual(
      exportReport.coremlExport.tensorContract,
      descriptor.tensorContract,
      "Split Core ML export tensorContract differs from the manifest."
    );
  }
  if (exportReport.coremlExport?.artifactValidation?.artifacts !== undefined) {
    requireDeepEqual(
      exportReport.coremlExport.artifactValidation.artifacts,
      manifest.compiledModels,
      "Split artifact-validation and manifest declarations differ."
    );
  }
  requireExactRoles(
    descriptor.artifacts.map((artifact) => artifact.role),
    SPLIT_ROLES,
    "Split runtime descriptor"
  );

  const compiledArtifacts = {};
  const exportPackages = {};
  const directories = [];
  for (const role of SPLIT_ROLES) {
    const declared = manifest.compiledModels[role];
    const descriptorArtifact = descriptor.artifacts.find(
      (artifact) => artifact.role === role
    );
    const compiledPath = resolveRecordedCandidatePath(
      location,
      declared.compiledModel,
      `manifest.compiledModels.${role}.compiledModel`
    );
    requireSamePath(
      compiledPath,
      descriptorArtifact.sourcePath,
      `Split ${role} manifest and descriptor resolve different compiled models.`
    );
    const compiledEvidence = inspectCandidateDirectory(
      location,
      compiledPath,
      `Candidate split ${role} compiled model`
    );
    requireDirectoryBinding(
      compiledEvidence,
      {
        sha256: declared.compiledSha256,
        bytes: declared.compiledBytes
      },
      `Candidate split ${role} compiled model`
    );
    requireSha256Binding(
      manifest.sha256?.compiledModels?.[role],
      compiledEvidence.sha256,
      `manifest.sha256.compiledModels.${role}`
    );
    requireSha256Binding(
      descriptorArtifact.compiledSha256,
      compiledEvidence.sha256,
      `Split ${role} runtime descriptor digest`
    );

    const packageEvidence = inspectDeclaredDirectory(
      location,
      declared.mlpackage,
      `Candidate split ${role} Core ML package`
    );
    requireDirectoryBinding(
      packageEvidence,
      {
        sha256: declared.mlpackageSha256,
        bytes: declared.mlpackageBytes
      },
      `Candidate split ${role} Core ML package`
    );
    requireSha256Binding(
      manifest.sha256?.mlpackages?.[role],
      packageEvidence.sha256,
      `manifest.sha256.mlpackages.${role}`
    );
    requireSamePath(
      packageEvidence.path,
      descriptorArtifact.mlpackagePath,
      `Split ${role} manifest and descriptor resolve different packages.`
    );

    compiledArtifacts[role] = summarizeDirectory(compiledEvidence);
    exportPackages[role] = summarizeDirectory(packageEvidence);
    directories.push(compiledEvidence, packageEvidence);
  }
  assertDistinctDirectoryEvidence(
    directories,
    "Split artifact directories"
  );
  return { compiledArtifacts, exportPackages, directoryEvidence: directories };
}

function inspectOptionalSingleArtifactValidation({
  validation,
  compiledEvidence,
  packageEvidence,
  checkpointEvidence
}) {
  if (validation === undefined) return;
  requireRecord(validation, "exportReport.coremlExport.artifactValidation");
  for (const [field, expected] of [
    ["compiledModelSha256", compiledEvidence.sha256],
    ["compiledSha256", compiledEvidence.sha256],
    ["mlpackageSha256", packageEvidence.sha256],
    ["sourceCheckpointSha256", checkpointEvidence.sha256]
  ]) {
    if (validation[field] !== undefined) {
      requireSha256Binding(
        validation[field],
        expected,
        `exportReport.coremlExport.artifactValidation.${field}`
      );
    }
  }
  requireOptionalByteBinding(
    validation.compiledBytes,
    compiledEvidence.bytes,
    "exportReport.coremlExport.artifactValidation.compiledBytes"
  );
  requireOptionalByteBinding(
    validation.mlpackageBytes,
    packageEvidence.bytes,
    "exportReport.coremlExport.artifactValidation.mlpackageBytes"
  );
}

function resolveCandidateLocation(repoRootValue, candidateRootValue) {
  const lexicalRepoRoot = resolve(repoRootValue);
  let repoRoot;
  try {
    repoRoot = realpathSync(lexicalRepoRoot);
  } catch (error) {
    fail(`Repository root is unavailable: ${errorMessage(error)}`);
  }
  if (typeof candidateRootValue !== "string" || candidateRootValue.length === 0) {
    fail("candidateRoot is required.");
  }
  const candidateRoot = isAbsolute(candidateRootValue)
    ? resolve(candidateRootValue)
    : resolve(repoRoot, candidateRootValue);
  assertStrictlyWithin(
    repoRoot,
    candidateRoot,
    "candidateRoot must be strictly inside the repository root."
  );
  assertNoSymlinkComponents(repoRoot, candidateRoot, "Candidate root");
  let stat;
  try {
    stat = lstatSync(candidateRoot);
  } catch (error) {
    fail(`Candidate root is unavailable: ${errorMessage(error)}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("candidateRoot must be a real directory.");
  }
  let realCandidateRoot;
  try {
    realCandidateRoot = realpathSync(candidateRoot);
  } catch (error) {
    fail(`Candidate root cannot be resolved: ${errorMessage(error)}`);
  }
  if (realCandidateRoot !== candidateRoot) {
    fail("candidateRoot must be expressed as its canonical real path.");
  }
  assertStrictlyWithin(
    repoRoot,
    realCandidateRoot,
    "Candidate root resolves outside the repository root."
  );
  return {
    repoRoot,
    candidateRoot,
    realCandidateRoot,
    candidateRelativePath: portable(repoRoot, candidateRoot)
  };
}

function inspectAnchorFile(
  location,
  value,
  label,
  maxBytes,
  includeContents
) {
  const path = resolveAnchorCandidatePath(location, value, label);
  return inspectCandidateFile(
    location,
    path,
    label,
    maxBytes,
    includeContents
  );
}

function inspectDeclaredFile(
  location,
  value,
  label,
  maxBytes,
  includeContents = false
) {
  const path = resolveRecordedCandidatePath(location, value, label);
  return inspectCandidateFile(
    location,
    path,
    label,
    maxBytes,
    includeContents
  );
}

function inspectCandidateFile(
  location,
  path,
  label,
  maxBytes,
  includeContents
) {
  const evidence = inspectContainedRegularFile(location.repoRoot, path, {
    label,
    maxBytes,
    includeContents
  });
  assertStrictlyWithin(
    location.realCandidateRoot,
    evidence.realPath,
    `${label} resolves outside candidateRoot.`
  );
  return evidence;
}

function inspectDeclaredDirectory(location, value, label) {
  const path = resolveRecordedCandidatePath(location, value, label);
  return inspectCandidateDirectory(location, path, label);
}

function inspectCandidateDirectory(location, path, label) {
  const evidence = inspectContainedDirectoryTree(location.repoRoot, path, {
    label,
    maxBytes: MAX_ARTIFACT_BYTES,
    maxEntries: MAX_ARTIFACT_ENTRIES
  });
  assertStrictlyWithin(
    location.realCandidateRoot,
    evidence.realPath,
    `${label} resolves outside candidateRoot.`
  );
  return evidence;
}

function resolveAnchorCandidatePath(location, value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} path is required.`);
  }
  const path = isAbsolute(value)
    ? resolve(value)
    : resolve(location.repoRoot, value);
  assertStrictlyWithin(
    location.candidateRoot,
    path,
    `${label} path must be strictly inside candidateRoot.`
  );
  return path;
}

function resolveRecordedCandidatePath(location, value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    fail(`${label} must be a non-empty repository-relative path.`);
  }
  const path = resolve(location.repoRoot, value);
  assertStrictlyWithin(
    location.candidateRoot,
    path,
    `${label} must resolve strictly inside candidateRoot.`
  );
  const canonical = portable(location.repoRoot, path);
  if (value !== canonical) {
    fail(`${label} is not a canonical repository-relative path.`);
  }
  return path;
}

function requirePathBinding(location, recorded, expectedPath, label) {
  const path = resolveRecordedCandidatePath(location, recorded, label);
  requireSamePath(path, expectedPath, `${label} does not bind the expected file.`);
}

function requireSamePath(actualPath, expectedPath, message) {
  if (resolve(actualPath) !== resolve(expectedPath)) fail(message);
}

function requireDirectoryBinding(evidence, declared, label) {
  requireSha256Binding(
    declared.sha256,
    evidence.sha256,
    `${label} sha256`
  );
  if (!Number.isSafeInteger(declared.bytes) ||
      declared.bytes !== evidence.bytes) {
    fail(`${label} byte count does not match the closed directory tree.`);
  }
}

function requireOptionalByteBinding(actual, expected, label) {
  if (actual !== undefined &&
      (!Number.isSafeInteger(actual) || actual !== expected)) {
    fail(`${label} does not match the verified closed directory tree.`);
  }
}

function requireSha256Binding(actual, expected, label) {
  if (typeof actual !== "string" || actual !== expected) {
    fail(`${label} does not match the verified bytes.`);
  }
}

function requireEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) fail(message);
}

function requireDeepEqual(actual, expected, message) {
  if (!deepEqual(actual, expected)) fail(message);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function requireExactKeys(value, expectedKeys, label) {
  requireRecord(value, label);
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (!deepEqual(actualKeys, expected)) {
    fail(`${label} must contain exactly ${expected.join(", ")}.`);
  }
}

function requireExactRoles(actualRoles, expectedRoles, label) {
  const actual = [...actualRoles].sort();
  const expected = [...expectedRoles].sort();
  if (!deepEqual(actual, expected)) {
    fail(`${label} must contain exactly roles ${expected.join(", ")}.`);
  }
}

function assertDistinctEvidence(evidence, label) {
  const realPaths = evidence.map((item) => item.realPath);
  if (new Set(realPaths).size !== realPaths.length) {
    fail(`${label} must resolve to distinct regular files.`);
  }
}

function assertDistinctDirectoryEvidence(evidence, label) {
  const realPaths = evidence.map((item) => item.realPath);
  if (new Set(realPaths).size !== realPaths.length) {
    fail(`${label} must resolve to distinct closed directories.`);
  }
  for (let leftIndex = 0; leftIndex < evidence.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < evidence.length;
      rightIndex += 1
    ) {
      const left = evidence[leftIndex];
      const right = evidence[rightIndex];
      if (
        isStrictlyWithin(left.realPath, right.realPath) ||
        isStrictlyWithin(right.realPath, left.realPath)
      ) {
        fail(
          `${label} must not contain nested or overlapping artifact trees: ` +
          `${left.relativePath} and ${right.relativePath}.`
        );
      }
    }
  }
}

function assertFilesOutsideArtifactDirectories(files, directories) {
  for (const file of files) {
    for (const directory of directories) {
      if (
        file.realPath === directory.realPath ||
        isStrictlyWithin(directory.realPath, file.realPath) ||
        isStrictlyWithin(file.realPath, directory.realPath)
      ) {
        fail(
          "Candidate retained evidence files and artifact trees must not " +
          `overlap: ${file.relativePath} and ${directory.relativePath}.`
        );
      }
    }
  }
}

function assertNoSymlinkComponents(root, target, label) {
  const child = relative(root, target);
  let current = root;
  for (const component of child.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if (!existsSync(current)) {
      fail(`${label} is missing: ${portable(root, current)}.`);
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      fail(`${label} cannot be inspected: ${errorMessage(error)}`);
    }
    if (stat.isSymbolicLink()) {
      fail(
        `${label} contains a symbolic-link path component: ` +
        `${portable(root, current)}.`
      );
    }
  }
}

function assertStrictlyWithin(parent, candidate, message) {
  if (!isStrictlyWithin(parent, candidate)) fail(message);
}

function isStrictlyWithin(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  return child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}

function parseJsonEvidence(evidence, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      evidence.contents
    );
  } catch (error) {
    fail(`${label} is invalid UTF-8: ${errorMessage(error)}`);
  }
  try {
    const parsed = JSON.parse(text);
    requireRecord(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof NeuralCandidateEvidenceCustodyError) throw error;
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function summarizeFile(evidence) {
  return {
    path: evidence.relativePath,
    sha256: evidence.sha256,
    bytes: evidence.bytes
  };
}

function summarizeDirectory(evidence) {
  return {
    path: evidence.relativePath,
    sha256: evidence.sha256,
    bytes: evidence.bytes,
    entries: evidence.entries
  };
}

function sha256CanonicalJson(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(left[key], right[key])
    );
}

function portable(root, path) {
  return relative(root, resolve(path)).split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function fail(message) {
  throw new NeuralCandidateEvidenceCustodyError(message);
}
