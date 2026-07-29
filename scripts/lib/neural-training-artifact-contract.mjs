import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
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
import { TextDecoder } from "node:util";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";
import {
  scoreOfficialBenchmark
} from "./neural-official-benchmark.mjs";
import {
  validateNeuralPredictionRows
} from "./neural-evaluation.mjs";
import {
  validateNeuralDatasetManifest
} from "./neural-dataset-manifest.mjs";
import {
  canonicalJsonSha256,
  configuredNeuralTrainingContract,
  inspectTrainingReportBinding,
  resolveNeuralTrainingLayout,
  validateNeuralTrainingConfig
} from "./neural-training-contract.mjs";
import {
  validateNeuralSplitTensorContract
} from "./neural-tensor-contract.mjs";
import {
  validateNeuralVocabularyContract
} from "./neural-vocabulary-contract.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const CANONICAL_OFFICIAL_BENCHMARK =
  "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json";
const CANONICAL_OFFICIAL_BENCHMARK_SHA256 =
  "d492040eeb6ddd2883fee50d0f03c051e20a08d1f469da00679b66751136781f";
const OFFICIAL_BUCKETS = Object.freeze([
  "native-frequent",
  "indian-name",
  "foreign-name"
]);
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_EVIDENCE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_DATASET_SPLIT_BYTES = 1024 * 1024 * 1024;
const MAX_DATASET_LINE_CHARACTERS = 1024 * 1024;
const PINNED_RUNTIME_VERSIONS = Object.freeze({
  cpu: Object.freeze({
    numpy: "1.26.4",
    torch: "2.7.0",
    coremltools: "9.0"
  }),
  cuda: Object.freeze({
    numpy: "1.26.4",
    torch: "2.7.0+cu118",
    coremltools: "9.0"
  })
});

export function pinnedNeuralRuntimeVersions(trainingDevice) {
  const versions = PINNED_RUNTIME_VERSIONS[trainingDevice];
  if (!versions) {
    throw new TypeError(
      `Unsupported neural training device ${String(trainingDevice)}.`
    );
  }
  return versions;
}

export function verifyNeuralTrainingCandidate(options = {}) {
  const failures = [];
  const warnings = [];
  const production = options.production === true;
  let root;
  try {
    root = realpathSync(resolve(options.repoRoot ?? process.cwd()));
  } catch (error) {
    return result(null, {
      failures: [`Repository root is unavailable: ${errorMessage(error)}`],
      warnings
    });
  }

  const configPath = safePath(
    root,
    options.configPath ??
      "data/neural/training/open-vocab-seq2seq-v1.config.json",
    "Training config",
    failures
  );
  const configEvidence = inspectRequiredFile(
    root,
    configPath,
    "Training config",
    MAX_JSON_BYTES,
    failures,
    true
  );
  const config = parseJsonEvidence(
    configEvidence,
    "Training config",
    failures
  );
  if (!config) return result(null);

  const configValidation = validateNeuralTrainingConfig(config);
  failures.push(...configValidation.failures);
  warnings.push(...configValidation.warnings);
  let canonicalLayout;
  try {
    canonicalLayout = resolveNeuralTrainingLayout(
      config,
      configPath,
      root
    );
  } catch (error) {
    failures.push(errorMessage(error));
    return result(null);
  }
  const trainerEvidence = inspectRequiredFile(
    root,
    canonicalLayout.trainerPath,
    "Training implementation",
    8 * 1024 * 1024,
    failures,
    true
  );

  const candidateRoot = safePath(
    root,
    options.candidateRoot ?? canonicalLayout.candidateRoot,
    "Candidate root",
    failures
  );
  validateCandidateRoot({
    root,
    candidateRoot,
    canonicalLayout,
    production,
    failures
  });
  const layout = effectiveLayout(canonicalLayout, candidateRoot);
  const trainerText = trainerEvidence?.contents?.toString("utf8") ?? "";
  validateTrainerSource(trainerText, canonicalLayout.kind, failures);

  const dataset = inspectDataset({
    root,
    manifestPath: canonicalLayout.datasetManifest,
    production,
    failures,
    warnings
  });
  const gold = inspectGold({
    root,
    manifestPath: canonicalLayout.goldManifest,
    failures
  });
  const official = inspectOfficialBenchmark({
    root,
    manifestPath: canonicalLayout.officialBenchmarkManifest,
    failures
  });
  validateOfficialTrainingIsolation({
    root,
    production,
    dataset,
    official,
    failures,
    warnings
  });

  const evidence = {
    checkpoint: inspectCandidateFile(
      root,
      layout.paths.checkpoint,
      "Checkpoint",
      MAX_CHECKPOINT_BYTES,
      production,
      failures,
      warnings
    ),
    trainingReport: inspectCandidateFile(
      root,
      layout.paths.trainingReport,
      "Training report",
      MAX_JSON_BYTES,
      production,
      failures,
      warnings,
      true
    ),
    exportReport: inspectCandidateFile(
      root,
      layout.paths.exportReport,
      "Export report",
      MAX_JSON_BYTES,
      production,
      failures,
      warnings,
      true
    ),
    manifest: inspectCandidateFile(
      root,
      layout.paths.manifest,
      "Candidate runtime manifest",
      MAX_JSON_BYTES,
      production,
      failures,
      warnings,
      true
    ),
    vocabulary: inspectCandidateFile(
      root,
      layout.paths.vocabulary,
      "Candidate vocabulary",
      MAX_JSON_BYTES,
      production,
      failures,
      warnings,
      true
    ),
    measurements: inspectCandidateFile(
      root,
      layout.paths.measurements,
      "Core ML measurements",
      MAX_JSON_BYTES,
      production,
      failures,
      warnings,
      true
    ),
    goldPredictions: inspectCandidateFile(
      root,
      layout.paths.goldPredictions,
      "Gold predictions",
      MAX_TEXT_EVIDENCE_BYTES,
      production,
      failures,
      warnings,
      true
    ),
    officialPredictions: inspectCandidateFile(
      root,
      layout.paths.officialBenchmarkPredictions,
      "Official benchmark predictions",
      MAX_TEXT_EVIDENCE_BYTES,
      production,
      failures,
      warnings,
      true
    )
  };
  const trainingReport = parseJsonEvidence(
    evidence.trainingReport,
    "Training report",
    failures
  );
  const exportReport = parseJsonEvidence(
    evidence.exportReport,
    "Export report",
    failures
  );
  const manifest = parseJsonEvidence(
    evidence.manifest,
    "Candidate runtime manifest",
    failures
  );
  const vocabulary = parseJsonEvidence(
    evidence.vocabulary,
    "Candidate vocabulary",
    failures
  );
  const vocabularyValidation = vocabulary
    ? validateNeuralVocabularyContract({
        vocabulary,
        config,
        datasetManifest: dataset?.manifest,
        datasetManifestSha256: dataset?.manifestEvidence?.sha256,
        manifest
      })
    : null;
  if (vocabularyValidation) {
    failures.push(...vocabularyValidation.failures);
  }
  const tensorContractValidation =
    canonicalLayout.kind === "split-attention" &&
    manifest &&
    vocabulary
      ? validateNeuralSplitTensorContract({
          config,
          vocabulary,
          tensorContract: manifest.tensorContract
        })
      : null;
  if (tensorContractValidation) {
    failures.push(...tensorContractValidation.failures);
  }

  let descriptor = null;
  if (manifest && evidence.vocabulary) {
    try {
      descriptor = resolveNeuralArtifactDescriptor({
        repoRoot: root,
        manifest,
        manifestPath: layout.paths.manifest,
        vocabPath: layout.paths.vocabulary,
        verifyExportArtifacts: true
      });
    } catch (error) {
      failures.push(
        `Candidate runtime artifact set is invalid: ${errorMessage(error)}`
      );
    }
  }

  if (trainingReport) {
    validateTrainingReport({
      root,
      production,
      config,
      configEvidence,
      trainerEvidence,
      layout,
      dataset,
      gold,
      official,
      evidence,
      report: trainingReport,
      failures,
      warnings
    });
  }
  if (manifest) {
    validateCandidateManifest({
      config,
      descriptor,
      dataset,
      evidence,
      manifest,
      trainingReport,
      failures
    });
  }
  if (exportReport) {
    validateExportReport({
      root,
      production,
      configEvidence,
      layout,
      dataset,
      gold,
      official,
      evidence,
      descriptor,
      manifest,
      trainingReport,
      report: exportReport,
      failures,
      warnings
    });
  }

  return result({
    modelId: canonicalLayout.modelId,
    kind: canonicalLayout.kind,
    runtimeModelContract: canonicalLayout.runtimeModelContract,
    config: portable(root, configPath),
    candidateRoot: portable(root, candidateRoot),
    canonicalCandidateRoot: canonicalLayout.candidateRootRelativePath,
    trainingContractSha256: configEvidence?.sha256 ?? null,
    trainerSha256: trainerEvidence?.sha256 ?? null,
    artifactSetSha256: descriptor?.artifactSetSha256 ?? null,
    trainingRunId: trainingReport?.trainingRunId ?? null,
    exportRunId: exportReport?.exportRunId ?? null,
    candidateManifestProductionEligible:
      manifest?.productionEligible ?? null,
    vocabularyContractStatus: vocabularyValidation?.status ?? null,
    tensorContractStatus: tensorContractValidation?.status ?? null,
    evidence: evidenceSummary(root, evidence),
    inputEvidence: {
      datasetManifestSha256: dataset?.manifestEvidence?.sha256 ?? null,
      goldManifestSha256: gold?.manifestEvidence?.sha256 ?? null,
      officialBenchmarkManifestSha256:
        official?.manifestEvidence?.sha256 ?? null,
      officialBenchmarkRows: official?.rows?.length ?? null,
      officialBenchmarkInputSha256:
        official?.inputSha256 ?? null
    }
  });

  function result(details, override = {}) {
    const activeFailures = override.failures ?? failures;
    const activeWarnings = override.warnings ?? warnings;
    return Object.freeze({
      status: activeFailures.length === 0
        ? production
          ? "passed-production-phase4-training-contract"
          : "passed-phase4-training-contract"
        : production
          ? "failed-production-phase4-training-contract"
          : "failed-phase4-training-contract",
      production,
      ...(details ?? {}),
      failures: Object.freeze([...new Set(activeFailures)]),
      warnings: Object.freeze([...new Set(activeWarnings)])
    });
  }
}

function validateTrainerSource(source, kind, failures) {
  if (!source) {
    failures.push("Training implementation is empty.");
    return;
  }
  for (const forbidden of [
    "lekh-required-production-case",
    "train.extend([seed] *",
    'row.get("expectedAction") == "no-neural-candidate"'
  ]) {
    if (source.includes(forbidden)) {
      failures.push(
        `Training implementation contains forbidden evidence manipulation marker ${forbidden}.`
      );
    }
  }
  const requiredMarkers = kind === "ctc-transformer"
    ? [
        "validate_executable_config(",
        "configured_training_config(",
        "ctc_prefix_beam_search(",
        "with exclusive_run_lock(args):",
        "load_verified_official_benchmark_rows",
        "load_verified_compiled_ctc_coreml",
        "write_ctc_runtime_manifest(",
        "predictionArtifactIdentity",
        "effectiveArtifactInputsCanonicalJson",
        "effectiveArtifactInputsSha256",
        "artifactOverrides",
        "save_training_recovery(",
        "trainingGeneratorState",
        "cudaRngStates",
        "--training-device",
        "torch.use_deterministic_algorithms(True)",
        "cpu-for-deterministic-backward",
        "run_input_snapshots_share_immutable_inputs",
        "split-host-train-then-macos-export-v1",
        "weights_only=True",
        "clear_training_recovery(args)"
      ]
    : [
        'build_vocab(train_rows, "input")',
        'build_vocab(train_rows, "output")',
        "with exclusive_run_lock(args):",
        "load_verified_official_benchmark_rows",
        "verify_official_benchmark_training_isolation",
        "decode_exact_compiled_candidates",
        "predictionArtifactIdentity",
        "effectiveArtifactInputsCanonicalJson",
        "effectiveArtifactInputsSha256",
        "artifactOverrides",
        "save_training_recovery(",
        "trainingGeneratorState",
        "cudaRngStates",
        "--training-device",
        "CUBLAS_WORKSPACE_CONFIG",
        "run_input_snapshots_share_immutable_inputs",
        "split-host-train-then-macos-export-v1",
        'torch.load(handle, map_location="cpu", weights_only=True)',
        "clear_training_recovery(args)"
      ];
  for (const required of requiredMarkers) {
    if (!source.includes(required)) {
      failures.push(
        `Training implementation is missing required contract marker ${required}.`
      );
    }
  }
}

function validateTrainingReport(context) {
  const {
    root,
    production,
    config,
    configEvidence,
    trainerEvidence,
    layout,
    dataset,
    gold,
    official,
    evidence,
    report,
    failures,
    warnings
  } = context;
  requireEqual(
    report.status,
    "passed-training-checkpoint",
    "Training report status is not passed-training-checkpoint.",
    failures
  );
  requireEqual(
    report.modelId,
    config.modelId,
    "Training report modelId differs from the config.",
    failures
  );
  requireRunId(report.trainingRunId, "Training report trainingRunId", failures);
  requireEqual(
    report.trainingComplete,
    true,
    "Training report does not declare trainingComplete=true.",
    failures
  );
  requireEqual(
    report.trainingConfig,
    layout.configRelativePath,
    "Training report config path is non-canonical.",
    failures
  );
  requireEqual(
    report.trainingContractSha256,
    configEvidence.sha256,
    "Training report config digest is stale.",
    failures
  );
  requireEqual(
    report.trainerSha256,
    trainerEvidence.sha256,
    "Training report trainer digest is stale.",
    failures
  );
  requireEqual(
    report.checkpoint,
    portable(root, layout.paths.checkpoint),
    "Training report checkpoint path is non-canonical.",
    failures
  );
  requireEqual(
    report.checkpointSha256,
    evidence.checkpoint?.sha256,
    "Training report checkpoint digest is stale.",
    failures
  );
  requireEqual(
    report.vocabMetadataSha256,
    evidence.vocabulary?.sha256,
    "Training report vocabulary digest is stale.",
    failures
  );
  requireEqual(
    report.inputDatasetManifest,
    portable(root, layout.datasetManifest),
    "Training report dataset manifest path is non-canonical.",
    failures
  );
  requireEqual(
    report.inputDatasetManifestSha256,
    dataset?.manifestEvidence?.sha256,
    "Training report dataset manifest digest is stale.",
    failures
  );
  requireEqual(
    report.inputDatasetContentSha256,
    dataset?.manifest?.datasetContentSha256,
    "Training report dataset content identity is stale.",
    failures
  );
  requireDeepEqual(
    report.inputDatasetSplitSha256,
    dataset?.manifest?.sha256,
    "Training report dataset split identities are stale.",
    failures
  );
  if (!Number.isSafeInteger(report.parameterCount) ||
      report.parameterCount < config.architecture.minimumParameterCount ||
      report.parameterCount > config.architecture.maximumParameterCount) {
    failures.push("Training report parameterCount is outside the configured runtime contract.");
  }
  for (const source of config.training.requiredSources) {
    if (!Number.isSafeInteger(report.trainingSourceCounts?.[source]) ||
        report.trainingSourceCounts[source] < 1) {
      failures.push(`Training report does not contain required source ${source}.`);
    }
  }

  const binding = inspectTrainingReportBinding({
    report,
    trainingContractSha256: configEvidence.sha256,
    configuredContract: configuredNeuralTrainingContract(config)
  });
  for (const issue of binding.issues) qualificationIssue(
    production,
    issue,
    failures,
    warnings
  );
  validateArtifactInputBinding({
    root,
    production,
    layout,
    configured: report.configuredArtifactInputs,
    effective: report.effectiveArtifactInputs,
    canonicalJson: report.effectiveArtifactInputsCanonicalJson,
    sha256: report.effectiveArtifactInputsSha256,
    overrides: report.artifactOverrides,
    failures,
    warnings
  });
  if (production &&
      (report.trainingExecutionModes?.skipTrain !== false ||
       ![false, true].includes(
         report.trainingExecutionModes?.skipCoreML
       ) ||
       !["cpu", "cuda"].includes(
         report.trainingExecutionModes?.trainingDevice
       ))) {
    failures.push(
      "Production Phase 4 requires fresh CPU/CUDA training with an explicit " +
      "Core ML handoff mode."
    );
  }
  validateTrainingRecoveryReport(report.trainingRecovery, failures);
  validateRunInputSnapshot({
    root,
    snapshot: report.runInputSnapshot,
    layout,
    configEvidence,
    trainerEvidence,
    dataset,
    gold,
    official,
    failures
  });
}

function validateTrainingRecoveryReport(recovery, failures) {
  if (!recovery || typeof recovery !== "object" ||
      Array.isArray(recovery) ||
      recovery.epochRecoveryEnabled !== true ||
      typeof recovery.resumed !== "boolean" ||
      !Number.isSafeInteger(recovery.resumeCount) ||
      recovery.resumeCount < 0 ||
      !Array.isArray(recovery.exportRunIds) ||
      recovery.exportRunIds.length < 1 ||
      recovery.exportRunIds.some((value) =>
        !RUN_ID_PATTERN.test(String(value ?? ""))
      ) ||
      new Set(recovery.exportRunIds).size !==
        recovery.exportRunIds.length) {
    failures.push(
      "Training report does not contain valid atomic epoch-recovery evidence."
    );
    return;
  }
  if (recovery.resumed) {
    if (!Number.isSafeInteger(recovery.resumedFromEpoch) ||
        recovery.resumedFromEpoch < 1 ||
        recovery.resumeCount < 1 ||
        recovery.exportRunIds.length < 2) {
      failures.push(
        "Resumed training report has incomplete epoch-recovery lineage."
      );
    }
  } else if (recovery.resumedFromEpoch !== null ||
      recovery.resumeCount !== 0 ||
      recovery.exportRunIds.length !== 1) {
    failures.push(
      "Uninterrupted training report has inconsistent recovery lineage."
    );
  }
}

function validateExecutionTopology({
  report,
  trainingReport,
  production,
  failures
}) {
  const trainingModes = trainingReport?.trainingExecutionModes;
  const exportModes = report.executionModes;
  requireDeepEqual(
    report.trainingExecutionModes,
    trainingModes,
    "Export report training execution modes are stale.",
    failures
  );
  const trainingPair = [
    trainingModes?.skipTrain,
    trainingModes?.skipCoreML
  ];
  const exportPair = [
    exportModes?.skipTrain,
    exportModes?.skipCoreML
  ];
  const trainingDevice = trainingModes?.trainingDevice;
  const exportDevice = exportModes?.trainingDevice;
  const singleHost =
    JSON.stringify(trainingPair) === JSON.stringify([false, false]) &&
    JSON.stringify(exportPair) === JSON.stringify([false, false]) &&
    trainingDevice === "cpu" &&
    exportDevice === "cpu";
  const splitHost =
    JSON.stringify(trainingPair) === JSON.stringify([false, true]) &&
    JSON.stringify(exportPair) === JSON.stringify([true, false]) &&
    ["cpu", "cuda"].includes(trainingDevice) &&
    exportDevice === "cpu";
  const expectedTopology = singleHost
    ? "single-host-train-and-export-v1"
    : splitHost
      ? "split-host-train-then-macos-export-v1"
      : null;
  requireEqual(
    report.executionTopology,
    expectedTopology,
    "Export report execution topology is invalid.",
    failures
  );
  if (production && expectedTopology === null) {
    failures.push(
      "Production export requires an approved single-host or split-host topology."
    );
  }
  if (production && splitHost && trainingDevice !== "cuda") {
    failures.push(
      "Production split-host training must use the pinned CUDA path."
    );
  }
  validateRuntimeExecutionEvidence({
    snapshot: trainingReport?.runInputSnapshot,
    expectedDevice: trainingDevice,
    role: "training",
    requireMacOS: singleHost,
    production,
    failures
  });
  validateRuntimeExecutionEvidence({
    snapshot: report.runInputSnapshot,
    expectedDevice: exportDevice,
    role: "Core ML export",
    requireMacOS: true,
    production,
    failures
  });
  const lineage = trainingReport?.trainingRecovery?.exportRunIds;
  if (singleHost && !lineage?.includes(report.exportRunId)) {
    failures.push(
      "Single-host export run is absent from the training recovery lineage."
    );
  }
  if (splitHost && lineage?.includes(report.exportRunId)) {
    failures.push(
      "Split-host macOS export must use an identity distinct from every " +
      "training attempt."
    );
  }
}

function validateRuntimeExecutionEvidence({
  snapshot,
  expectedDevice,
  role,
  requireMacOS,
  production,
  failures
}) {
  const runtime = snapshot?.runtime;
  if (!isRecord(runtime)) {
    failures.push(`${role} run snapshot lacks runtime evidence.`);
    return;
  }
  requireEqual(
    runtime.trainingDevice,
    expectedDevice,
    `${role} runtime device differs from its execution mode.`,
    failures
  );
  requireEqual(
    runtime.deterministicAlgorithms,
    true,
    `${role} did not enable deterministic PyTorch algorithms.`,
    failures
  );
  if (requireMacOS &&
      !String(runtime.platform ?? "").startsWith("macOS-")) {
    failures.push(`${role} runtime is not macOS.`);
  }
  if (!production) return;
  const pinnedVersions = pinnedNeuralRuntimeVersions(expectedDevice);
  for (const [actual, expected, message] of [
    [
      runtime.numpy,
      pinnedVersions.numpy,
      `${role} NumPy version is not pinned.`
    ],
    [
      runtime.torch,
      pinnedVersions.torch,
      `${role} PyTorch version is not pinned.`
    ],
    [
      runtime.coremltools,
      pinnedVersions.coremltools,
      `${role} Core ML Tools version is not pinned.`
    ]
  ]) {
    requireEqual(actual, expected, message, failures);
  }
  if (!/^3\.11\.\d+$/u.test(String(runtime.python ?? ""))) {
    failures.push(`${role} Python runtime is outside the pinned 3.11 line.`);
  }
  if (!Number.isSafeInteger(runtime.torchThreads) ||
      runtime.torchThreads < 1 ||
      !Number.isSafeInteger(runtime.torchInteropThreads) ||
      runtime.torchInteropThreads < 1) {
    failures.push(`${role} thread topology is invalid.`);
  }
  if (expectedDevice !== "cuda") return;
  const cuda = runtime.cuda;
  if (!isRecord(cuda) ||
      cuda.available !== true ||
      !Number.isSafeInteger(cuda.deviceCount) ||
      cuda.deviceCount < 1 ||
      !Array.isArray(cuda.deviceNames) ||
      cuda.deviceNames.length !== cuda.deviceCount ||
      cuda.deviceNames.some((value) =>
        typeof value !== "string" || value.length < 1
      ) ||
      typeof cuda.runtimeVersion !== "string" ||
      cuda.runtimeVersion.length < 1 ||
      !Number.isSafeInteger(cuda.cudnnVersion) ||
      cuda.cudnnVersion < 1 ||
      cuda.cublasWorkspaceConfig !== ":4096:8" ||
      cuda.cudnnBenchmark !== false ||
      cuda.cudnnDeterministic !== true) {
    failures.push(
      `${role} CUDA determinism/runtime evidence is incomplete or invalid.`
    );
  }
}

function immutableRunInputSnapshot(snapshot) {
  if (!isRecord(snapshot)) return snapshot;
  const copy = structuredClone(snapshot);
  delete copy.runtime;
  return copy;
}

function validateCandidateManifest(context) {
  const {
    config,
    descriptor,
    dataset,
    evidence,
    manifest,
    trainingReport,
    failures
  } = context;
  for (const [actual, expected, message] of [
    [manifest.schemaVersion, 2, "Candidate manifest schemaVersion must be 2."],
    [manifest.selectedArtifact, config.modelId, "Candidate manifest modelId differs from the config."],
    [manifest.architecture, config.architecture.family, "Candidate manifest architecture differs from the config."],
    [manifest.runtime, "CoreML", "Candidate manifest runtime must be CoreML."],
    [manifest.localOnly, true, "Candidate manifest must be local-only."],
    [manifest.neuralTailOnly, true, "Candidate manifest must be neural-tail-only."],
    [manifest.openVocabulary, true, "Candidate manifest must be open-vocabulary."],
    [manifest.tokenization, "unicode-scalar-character", "Candidate manifest tokenizer is unsupported."],
    [manifest.outputSequenceValidation, "devanagari-word-sequence-v1", "Candidate manifest output validator is unsupported."],
    [manifest.productionEligible, false, "Phase 4 must validate an immutable unpromoted candidate with productionEligible=false."]
  ]) {
    requireEqual(actual, expected, message, failures);
  }
  requireRunId(manifest.trainingRunId, "Candidate manifest trainingRunId", failures);
  requireRunId(manifest.exportRunId, "Candidate manifest exportRunId", failures);
  if (manifest.trainingRunId === manifest.exportRunId) {
    failures.push("Candidate manifest reuses its trainingRunId as exportRunId.");
  }
  requireEqual(
    manifest.trainingRunId,
    trainingReport?.trainingRunId,
    "Candidate manifest trainingRunId differs from the training report.",
    failures
  );
  requireEqual(
    manifest.sha256?.sourceCheckpoint,
    evidence.checkpoint?.sha256,
    "Candidate manifest checkpoint digest is stale.",
    failures
  );
  requireEqual(
    manifest.sha256?.vocabMetadata,
    evidence.vocabulary?.sha256,
    "Candidate manifest vocabulary digest is stale.",
    failures
  );
  requireEqual(
    manifest.sha256?.trainingDatasetManifest,
    dataset?.manifestEvidence?.sha256,
    "Candidate manifest dataset digest is stale.",
    failures
  );
  requireEqual(
    manifest.parameterCount,
    trainingReport?.parameterCount,
    "Candidate manifest parameterCount differs from the training report.",
    failures
  );
  if (descriptor && descriptor.totalCompiledBytes >
      config.architecture.maximumCompiledBytes) {
    failures.push("Candidate compiled artifact set exceeds maximumCompiledBytes.");
  }
}

function validateExportReport(context) {
  const {
    root,
    production,
    configEvidence,
    layout,
    dataset,
    gold,
    official,
    evidence,
    descriptor,
    manifest,
    trainingReport,
    report,
    failures,
    warnings
  } = context;
  requireEqual(
    report.status,
    layout.successfulExportStatus,
    "Export report status does not match the candidate architecture.",
    failures
  );
  requireEqual(
    report.modelId,
    layout.modelId,
    "Export report modelId differs from the config.",
    failures
  );
  requireRunId(report.trainingRunId, "Export report trainingRunId", failures);
  requireRunId(report.exportRunId, "Export report exportRunId", failures);
  if (report.trainingRunId === report.exportRunId) {
    failures.push("Export report reuses its trainingRunId as exportRunId.");
  }
  requireEqual(
    report.trainingRunId,
    trainingReport?.trainingRunId,
    "Export report trainingRunId differs from the training report.",
    failures
  );
  requireEqual(
    report.exportRunId,
    manifest?.exportRunId,
    "Export report exportRunId differs from the candidate manifest.",
    failures
  );
  validateExecutionTopology({ report, trainingReport, production, failures });
  requireEqual(
    report.productionEligible,
    false,
    "Phase 4 export report must remain productionEligible=false.",
    failures
  );
  requireEqual(
    report.trainingContractSha256,
    configEvidence.sha256,
    "Export report config digest is stale.",
    failures
  );
  requireEqual(
    report.effectiveTrainingConfigSha256,
    trainingReport?.effectiveTrainingConfigSha256,
    "Export report effective-training digest differs from the training report.",
    failures
  );
  requireEqual(
    report.effectiveArtifactInputsSha256,
    trainingReport?.effectiveArtifactInputsSha256,
    "Export report effective-artifact digest differs from the training report.",
    failures
  );
  requireDeepEqual(
    report.artifactOverrides,
    trainingReport?.artifactOverrides,
    "Export report artifact overrides differ from the training report.",
    failures
  );
  requireEqual(
    report.checkpoint,
    portable(root, layout.paths.checkpoint),
    "Export report checkpoint path is non-canonical.",
    failures
  );
  requireEqual(
    report.checkpointSha256,
    evidence.checkpoint?.sha256,
    "Export report checkpoint digest is stale.",
    failures
  );
  requireEqual(
    report.trainingReport,
    portable(root, layout.paths.trainingReport),
    "Export report training-report path is non-canonical.",
    failures
  );
  requireEqual(
    report.trainingReportSha256,
    evidence.trainingReport?.sha256,
    "Export report training-report digest is stale.",
    failures
  );
  requireEqual(
    report.manifest,
    portable(root, layout.paths.manifest),
    "Export report candidate-manifest path is non-canonical.",
    failures
  );
  requireEqual(
    report.manifestSha256,
    evidence.manifest?.sha256,
    "Export report candidate-manifest digest is stale.",
    failures
  );
  requireEqual(
    report.measurements,
    portable(root, layout.paths.measurements),
    "Export report measurement path is non-canonical.",
    failures
  );
  requireEqual(
    report.measurementsSha256,
    evidence.measurements?.sha256,
    "Export report measurement digest is stale.",
    failures
  );
  requireEqual(
    report.predictions,
    portable(root, layout.paths.goldPredictions),
    "Export report gold-prediction path is non-canonical.",
    failures
  );
  requireEqual(
    report.predictionsSha256,
    evidence.goldPredictions?.sha256,
    "Export report gold-prediction digest is stale.",
    failures
  );
  requireEqual(
    report.predictionsBackend,
    layout.predictionsBackend,
    "Export report prediction backend differs from the architecture.",
    failures
  );
  requireEqual(
    report.goldManifest,
    portable(root, layout.goldManifest),
    "Export report gold-manifest path is non-canonical.",
    failures
  );
  requireEqual(
    report.goldManifestSha256,
    gold?.manifestEvidence?.sha256,
    "Export report gold-manifest digest is stale.",
    failures
  );
  requireEqual(
    report.goldCorpusSha256,
    gold?.manifest?.corpusSha256,
    "Export report gold-corpus digest is stale.",
    failures
  );
  requireDeepEqual(
    report.goldSuites,
    gold?.suites,
    "Export report gold-suite evidence is stale.",
    failures
  );
  requireEqual(
    report.goldRows,
    gold?.rows.length,
    "Export report gold row count is stale.",
    failures
  );
  if (!Array.isArray(report.runtimeArtifactContractIssues) ||
      report.runtimeArtifactContractIssues.length !== 0) {
    failures.push("Export report runtimeArtifactContractIssues must be empty.");
  }
  requireEqual(
    report.coremlExport?.status,
    "passed",
    "Export report lacks a passed Core ML export.",
    failures
  );
  requireEqual(
    report.coremlExport?.artifactValidation?.status,
    "passed",
    "Export report lacks passed exact-artifact Core ML validation.",
    failures
  );
  requireDeepEqual(
    immutableRunInputSnapshot(report.runInputSnapshot),
    immutableRunInputSnapshot(trainingReport?.runInputSnapshot),
    "Export and training reports bind different immutable input snapshots.",
    failures
  );
  requireEqual(
    report.trainingRunInputSnapshotSha256,
    trainingReport?.runInputSnapshot
      ? canonicalJsonSha256(trainingReport.runInputSnapshot)
      : null,
    "Export report training snapshot digest is stale.",
    failures
  );
  requireEqual(
    report.exportRunInputSnapshotSha256,
    report.runInputSnapshot
      ? canonicalJsonSha256(report.runInputSnapshot)
      : null,
    "Export report export snapshot digest is stale.",
    failures
  );
  validateRunInputSnapshot({
    root,
    snapshot: report.runInputSnapshot,
    layout,
    configEvidence,
    trainerEvidence: {
      sha256: trainingReport?.trainerSha256
    },
    dataset,
    gold,
    official,
    failures
  });
  validateRunInputSnapshot({
    root,
    snapshot: trainingReport?.runInputSnapshot,
    layout,
    configEvidence,
    trainerEvidence: {
      sha256: trainingReport?.trainerSha256
    },
    dataset,
    gold,
    official,
    failures
  });
  validateOfficialComparison({
    root,
    layout,
    official,
    descriptor,
    evidence,
    report,
    failures
  });
  validateGoldPredictions({
    evidence: evidence.goldPredictions,
    gold,
    failures
  });
  validateArchitectureExport({
    root,
    layout,
    descriptor,
    manifest,
    report,
    failures
  });
  if (!descriptor) qualificationIssue(
    production,
    "No complete runtime artifact descriptor could be resolved.",
    failures,
    warnings
  );
}

function validateArchitectureExport({
  root,
  layout,
  descriptor,
  manifest,
  report,
  failures
}) {
  if (!descriptor) return;
  if (layout.kind !== "split-attention") {
    const label = layout.kind === "ctc-transformer" ? "CTC" : "Baseline";
    const artifact = descriptor.artifacts[0];
    requireEqual(
      report.compiledModel,
      portable(root, artifact.sourcePath),
      `${label} export compiled-model path is stale.`,
      failures
    );
    requireEqual(
      report.compiledModelSha256,
      artifact.compiledSha256,
      `${label} export compiled-model digest is stale.`,
      failures
    );
    const packageEvidence = inspectDirectory(
      root,
      layout.artifacts[0].mlpackage,
      `${label} Core ML package`,
      failures
    );
    requireEqual(
      report.mlpackage,
      portable(root, layout.artifacts[0].mlpackage),
      `${label} export package path is stale.`,
      failures
    );
    requireEqual(
      report.mlpackageSha256,
      packageEvidence?.sha256,
      `${label} export package digest is stale.`,
      failures
    );
    requireEqual(
      report.coremlExport?.compiledSha256,
      artifact.compiledSha256,
      `${label} Core ML export digest is stale.`,
      failures
    );
    requireEqual(
      report.coremlExport?.mlpackageSha256,
      packageEvidence?.sha256,
      `${label} Core ML package attestation is stale.`,
      failures
    );
    if (layout.kind === "ctc-transformer") {
      requireEqual(
        report.runtimeModelContract,
        layout.runtimeModelContract,
        "CTC export runtime contract is stale.",
        failures
      );
      requireEqual(
        descriptor.runtimeModelContract,
        layout.runtimeModelContract,
        "CTC descriptor runtime contract differs from the selected layout.",
        failures
      );
      requireDeepEqual(
        descriptor.artifacts.map((candidate) => candidate.role),
        ["model"],
        "CTC descriptor must contain exactly one model artifact.",
        failures
      );
      requireEqual(
        manifest?.runtimeModelContract,
        layout.runtimeModelContract,
        "CTC manifest runtime contract is stale.",
        failures
      );
      requireDeepEqual(
        report.coremlExport?.tensorContract,
        manifest?.tensorContract,
        "CTC tensor contract differs between export and manifest.",
        failures
      );
      requireEqual(
        report.coremlExport?.prePublicationValidation?.status,
        "passed",
        "CTC pre-publication validation did not pass.",
        failures
      );
      requireEqual(
        report.coremlExport?.artifactValidation?.status,
        "passed",
        "CTC published-artifact validation did not pass.",
        failures
      );
      requireEqual(
        report.coremlExport?.sourceCheckpointSha256,
        report.checkpointSha256,
        "CTC export source-checkpoint digest is stale.",
        failures
      );
      requireEqual(
        report.coremlExport?.compiledModel,
        report.compiledModel,
        "CTC Core ML export path differs from the published compiled model.",
        failures
      );
      requireEqual(
        report.coremlExport?.mlpackage,
        report.mlpackage,
        "CTC Core ML package path differs from the published package.",
        failures
      );
    }
    return;
  }

  requireEqual(
    report.runtimeModelContract,
    layout.runtimeModelContract,
    "Attention export runtime contract is stale.",
    failures
  );
  requireEqual(
    descriptor.runtimeModelContract,
    layout.runtimeModelContract,
    "Attention descriptor runtime contract differs from the selected layout.",
    failures
  );
  requireDeepEqual(
    descriptor.artifacts.map((artifact) => artifact.role).sort(),
    layout.artifacts.map((artifact) => artifact.role).sort(),
    "Attention descriptor role inventory is incomplete or unexpected.",
    failures
  );
  requireEqual(
    manifest?.runtimeModelContract,
    layout.runtimeModelContract,
    "Attention manifest runtime contract is stale.",
    failures
  );
  requireDeepEqual(
    report.compiledModels,
    manifest?.compiledModels,
    "Attention export and manifest artifact inventories differ.",
    failures
  );
  requireDeepEqual(
    report.coremlExport?.artifacts,
    manifest?.compiledModels,
    "Attention Core ML export artifact inventory is stale.",
    failures
  );
  requireDeepEqual(
    report.coremlExport?.artifactValidation?.artifacts,
    manifest?.compiledModels,
    "Attention exact-artifact validation inventory is stale.",
    failures
  );
  requireDeepEqual(
    report.tensorContract,
    manifest?.tensorContract,
    "Attention tensor contract differs between export and manifest.",
    failures
  );
  requireDeepEqual(
    report.prePublicationValidation,
    report.coremlExport?.prePublicationValidation,
    "Attention pre-publication validation evidence is stale.",
    failures
  );
  requireEqual(
    report.prePublicationValidation?.status,
    "passed",
    "Attention pre-publication validation did not pass.",
    failures
  );
  requireEqual(
    report.sourceCheckpointSha256,
    report.checkpointSha256,
    "Attention export source-checkpoint digest is stale.",
    failures
  );
  for (const artifact of descriptor.artifacts) {
    const expected = layout.artifacts.find(
      (candidate) => candidate.role === artifact.role
    );
    requireEqual(
      artifact.sourcePath,
      expected?.compiledModel,
      `Attention ${artifact.role} compiled model is outside the candidate layout.`,
      failures
    );
    requireEqual(
      artifact.mlpackagePath,
      expected?.mlpackage,
      `Attention ${artifact.role} Core ML package is outside the candidate layout.`,
      failures
    );
    const declared = report.compiledModels?.[artifact.role];
    requireEqual(
      declared?.compiledModel,
      portable(root, artifact.sourcePath),
      `Attention ${artifact.role} compiled-model path is stale.`,
      failures
    );
    requireEqual(
      declared?.compiledSha256,
      artifact.compiledSha256,
      `Attention ${artifact.role} compiled-model digest is stale.`,
      failures
    );
    requireEqual(
      declared?.compiledBytes,
      artifact.compiledBytes,
      `Attention ${artifact.role} compiled-model byte count is stale.`,
      failures
    );
  }
}

function validateOfficialComparison({
  root,
  layout,
  official,
  descriptor,
  evidence,
  report,
  failures
}) {
  const binding = report.comparisonBenchmark;
  if (!isRecord(binding)) {
    failures.push("Export report is missing comparisonBenchmark evidence.");
    return;
  }
  for (const [actual, expected, message] of [
    [binding.manifest, portable(root, layout.officialBenchmarkManifest), "Official benchmark path is stale."],
    [binding.manifestSha256, official?.manifestEvidence?.sha256, "Official benchmark manifest digest is stale."],
    [binding.corpusSha256, official?.manifest?.corpusSha256, "Official benchmark corpus digest is stale."],
    [binding.rows, official?.rows.length, "Official benchmark row count is stale."],
    [binding.predictions, portable(root, layout.paths.officialBenchmarkPredictions), "Official prediction path is stale."],
    [binding.predictionsSha256, evidence.officialPredictions?.sha256, "Official prediction digest is stale."],
    [binding.predictionsBackend, layout.predictionsBackend, "Official prediction backend is stale."]
  ]) {
    requireEqual(actual, expected, message, failures);
  }
  requireDeepEqual(
    binding.suites,
    official?.suites,
    "Official benchmark suite inventory is stale.",
    failures
  );
  const expectedIsolation = expectedOfficialIsolation(
    official,
    report.runInputSnapshot?.dataset
  );
  requireDeepEqual(
    binding.trainingIsolation,
    expectedIsolation,
    "Official benchmark training-isolation evidence is stale.",
    failures
  );
  requireDeepEqual(
    report.runInputSnapshot?.officialBenchmark?.trainingIsolation,
    expectedIsolation,
    "Run snapshot official benchmark isolation evidence is stale.",
    failures
  );
  if (descriptor) {
    const expectedArtifactIdentity = {
      runtimeModelContract: descriptor.runtimeModelContract,
      compiledArtifacts: Object.fromEntries(
        descriptor.artifacts.map((artifact) => [
          artifact.role,
          {
            path: portable(root, artifact.sourcePath),
            sha256: artifact.compiledSha256,
            bytes: artifact.compiledBytes
          }
        ])
      )
    };
    requireDeepEqual(
      binding.predictionArtifactIdentity,
      expectedArtifactIdentity,
      "Official predictions are not bound to the exact compiled artifact set.",
      failures
    );
  }
  const predictions = parseJsonLinesEvidence(
    evidence.officialPredictions,
    "Official benchmark predictions",
    failures
  );
  if (official && predictions) {
    const score = scoreOfficialBenchmark(official.rows, predictions);
    if (!score.valid || !score.exactCoverage ||
        score.predictionRows !== official.rows.length) {
      failures.push(
        `Official benchmark prediction coverage is invalid: ` +
        `${score.issueCodes.join(", ")}.`
      );
    }
  }
}

function validateGoldPredictions({ evidence, gold, failures }) {
  const predictions = parseJsonLinesEvidence(
    evidence,
    "Gold predictions",
    failures
  );
  if (!gold || !predictions) return;
  const validation = validateNeuralPredictionRows(predictions, gold.rows);
  if (!validation.exactCoverage) {
    failures.push(
      `Gold prediction coverage is invalid: ${validation.issueCodes.join(", ")}.`
    );
  }
}

function validateArtifactInputBinding({
  root,
  production,
  layout,
  configured,
  effective,
  canonicalJson,
  sha256,
  overrides,
  failures,
  warnings
}) {
  requireDeepEqual(
    configured,
    layout.configuredArtifactInputs,
    "Training report configuredArtifactInputs differ from the canonical config graph.",
    failures
  );
  const expectedEffective = {
    ...layout.configuredArtifactInputs,
    outDir: portable(root, layout.candidateRoot),
    compiledModel: portable(
      root,
      join(layout.candidateRoot, "LekhNeuralTransliterator.mlmodelc")
    ),
    manifest: portable(root, layout.paths.manifest),
    vocabMetadata: portable(root, layout.paths.vocabulary)
  };
  requireDeepEqual(
    effective,
    expectedEffective,
    "Training report effectiveArtifactInputs do not match the locked candidate root.",
    failures
  );
  if (!isRecord(effective) ||
      typeof canonicalJson !== "string" ||
      !SHA256_PATTERN.test(String(sha256 ?? ""))) {
    failures.push("Training report effective artifact-input digest is invalid.");
  } else {
    try {
      requireDeepEqual(
        JSON.parse(canonicalJson),
        effective,
        "Training report effective artifact-input canonical JSON is stale.",
        failures
      );
    } catch {
      failures.push("Training report effective artifact-input canonical JSON is invalid.");
    }
    if (createHash("sha256").update(canonicalJson).digest("hex") !== sha256) {
      failures.push("Training report effective artifact-input producer digest is invalid.");
    }
  }
  const differences = Object.keys(expectedEffective).filter((key) =>
    !deepEqual(layout.configuredArtifactInputs[key], expectedEffective[key])
  );
  if (!isRecord(overrides)) {
    failures.push("Training report artifactOverrides must be an object.");
    return;
  }
  const overrideKeys = Object.keys(overrides).sort();
  if (!deepEqual(overrideKeys, differences.sort())) {
    failures.push("Training report artifactOverrides do not exactly describe path differences.");
    return;
  }
  for (const key of differences) {
    const override = overrides[key];
    if (!isRecord(override) ||
        !deepEqual(override.configured, configured[key]) ||
        !deepEqual(override.effective, effective[key])) {
      failures.push(`Artifact override ${key} has stale configured/effective values.`);
      continue;
    }
    const allowedSources = key === "outDir"
      ? ["command-line"]
      : ["command-line", "derived"];
    if (!allowedSources.includes(override.source)) {
      failures.push(`Artifact override ${key} has invalid source provenance.`);
    }
  }
  if (production && differences.length > 0) {
    failures.push("Production Phase 4 forbids candidate artifact path overrides.");
  } else if (differences.length > 0) {
    warnings.push(
      `Development candidate uses explicit artifact paths: ${differences.join(", ")}.`
    );
  }
}

function validateRunInputSnapshot({
  root,
  snapshot,
  layout,
  configEvidence,
  trainerEvidence,
  dataset,
  gold,
  official,
  failures
}) {
  if (!isRecord(snapshot)) {
    failures.push("Run-input snapshot is missing.");
    return;
  }
  requireDeepEqual(
    snapshot.trainer,
    {
      path: layout.trainerRelativePath,
      sha256: trainerEvidence?.sha256
    },
    "Run snapshot trainer identity is stale.",
    failures
  );
  requireDeepEqual(
    snapshot.trainingConfig,
    {
      path: layout.configRelativePath,
      sha256: configEvidence?.sha256
    },
    "Run snapshot training-config identity is stale.",
    failures
  );
  const expectedDataset = dataset && {
    manifest: portable(root, layout.datasetManifest),
    manifestSha256: dataset.manifestEvidence.sha256,
    contentSha256: dataset.manifest.datasetContentSha256,
    splits: dataset.snapshotSplits
  };
  requireDeepEqual(
    snapshot.dataset,
    expectedDataset,
    "Run snapshot dataset identity is stale.",
    failures
  );
  requireDeepEqual(
    snapshot.gold,
    gold?.snapshot,
    "Run snapshot gold evidence is stale.",
    failures
  );
  const expectedOfficial = official && {
    ...official.snapshot,
    trainingIsolation: expectedOfficialIsolation(
      official,
      expectedDataset
    )
  };
  requireDeepEqual(
    snapshot.officialBenchmark,
    expectedOfficial,
    "Run snapshot official benchmark evidence is stale.",
    failures
  );
}

function inspectDataset({
  root,
  manifestPath,
  production,
  failures,
  warnings
}) {
  const manifestEvidence = inspectRequiredFile(
    root,
    manifestPath,
    "Dataset manifest",
    MAX_JSON_BYTES,
    failures,
    true
  );
  const manifest = parseJsonEvidence(
    manifestEvidence,
    "Dataset manifest",
    failures
  );
  if (!manifest) return null;
  const manifestValidation = validateNeuralDatasetManifest(manifest);
  for (const issue of manifestValidation.issueCodes) {
    failures.push(`Dataset manifest is invalid: ${issue}.`);
  }
  const splits = ["train", "dev", "test"];
  const snapshotSplits = {};
  const splitPaths = {};
  for (const split of splits) {
    const recordedPath = manifest.splitFiles?.[split];
    const recordedSha256 = manifest.sha256?.[split];
    const recordedRows = manifest.counts?.[split];
    const recordedBytes = manifest.bytes?.[split];
    const path = canonicalRecordedPath(
      root,
      recordedPath,
      `Dataset ${split} split`,
      failures
    );
    if (!path || !SHA256_PATTERN.test(String(recordedSha256 ?? "")) ||
        !Number.isSafeInteger(recordedRows) || recordedRows < 1 ||
        !Number.isSafeInteger(recordedBytes) || recordedBytes < 1) {
      failures.push(`Dataset ${split} split inventory is invalid.`);
      continue;
    }
    snapshotSplits[split] = {
      path: portable(root, path),
      sha256: recordedSha256,
      bytes: recordedBytes,
      rows: recordedRows
    };
    splitPaths[split] = path;
    if (production) {
      const live = inspectRequiredFile(
        root,
        path,
        `Dataset ${split} split`,
        MAX_DATASET_SPLIT_BYTES,
        failures
      );
      requireEqual(
        live?.sha256,
        recordedSha256,
        `Dataset ${split} split digest is stale.`,
        failures
      );
      requireEqual(
        live?.bytes,
        recordedBytes,
        `Dataset ${split} split byte count is stale.`,
        failures
      );
    }
  }
  if (!production) {
    warnings.push(
      "Development Phase 4 trusts dataset split hashes from the dataset manifest; production rehashes all splits."
    );
  }
  return { manifest, manifestEvidence, snapshotSplits, splitPaths };
}

function validateOfficialTrainingIsolation({
  root,
  production,
  dataset,
  official,
  failures,
  warnings
}) {
  if (!dataset || !official) return;
  if (!production) {
    warnings.push(
      "Development Phase 4 trusts the run's official-benchmark isolation " +
      "attestation; production independently rescans train and dev inputs."
    );
    return;
  }
  const officialInputs = new Set(
    official.rows.map((row) => normalizedInput(row.input))
  );
  const overlappingInputs = new Set();
  for (const split of ["train", "dev"]) {
    const path = dataset.splitPaths[split];
    if (!path) continue;
    let scan;
    try {
      scan = scanJsonLines(root, path, (row, lineNumber) => {
        if (!isRecord(row)) {
          failures.push(
            `Dataset ${split}:${lineNumber} must contain a JSON object.`
          );
          return;
        }
        const input = normalizedInput(row.input);
        if (input.length === 0) {
          failures.push(
            `Dataset ${split}:${lineNumber} has an empty or invalid input.`
          );
        } else if (officialInputs.has(input)) {
          overlappingInputs.add(input);
        }
      }, failures, `Dataset ${split}`);
    } catch (error) {
      failures.push(
        `Dataset ${split} cannot be scanned for benchmark isolation: ` +
        `${errorMessage(error)}`
      );
      continue;
    }
    requireEqual(
      scan.rows,
      dataset.snapshotSplits[split]?.rows,
      `Dataset ${split} live row count differs from its manifest.`,
      failures
    );
    requireEqual(
      scan.bytes,
      dataset.snapshotSplits[split]?.bytes,
      `Dataset ${split} live byte count differs from its manifest.`,
      failures
    );
    requireEqual(
      scan.sha256,
      dataset.snapshotSplits[split]?.sha256,
      `Dataset ${split} live digest differs from its manifest.`,
      failures
    );
  }
  if (overlappingInputs.size > 0) {
    failures.push(
      `Official benchmark isolation failed: ${overlappingInputs.size} ` +
      "normalized benchmark inputs occur in train or dev."
    );
  }
}

function scanJsonLines(root, path, visitor, failures, label) {
  assertNoSymlinkComponents(root, path, label, failures);
  if (failures.some((failure) =>
    failure.startsWith(`${label} contains a symbolic-link`)
  )) {
    throw new TypeError(`${label} cannot be opened through a symbolic link.`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  const before = fstatSync(descriptor);
  assertOpenedFileIdentity(root, path, before, label);
  if (!before.isFile()) {
    closeSync(descriptor);
    throw new TypeError(`${label} must be a regular file.`);
  }
  if (before.size > MAX_DATASET_SPLIT_BYTES) {
    closeSync(descriptor);
    throw new TypeError(`${label} exceeds the maximum allowed byte count.`);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let lineNumber = 0;
  let rows = 0;
  let totalBytes = 0;
  try {
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      const chunk = buffer.subarray(0, bytes);
      totalBytes += bytes;
      hash.update(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        lineNumber += 1;
        if (line.trim().length === 0) continue;
        rows += 1;
        try {
          visitor(JSON.parse(line), lineNumber);
        } catch (error) {
          failures.push(
            `${label}:${lineNumber} is invalid JSON: ${errorMessage(error)}`
          );
        }
      }
      if (pending.length > MAX_DATASET_LINE_CHARACTERS) {
        throw new TypeError(
          `${label}:${lineNumber + 1} exceeds the maximum line length.`
        );
      }
    }
    pending += decoder.decode();
    if (pending.trim().length > 0) {
      lineNumber += 1;
      const line = pending.replace(/\r$/u, "");
      rows += 1;
      try {
        visitor(JSON.parse(line), lineNumber);
      } catch (error) {
        failures.push(
          `${label}:${lineNumber} is invalid JSON: ${errorMessage(error)}`
        );
      }
    }
    const after = fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || totalBytes !== before.size) {
      throw new TypeError(`${label} changed during the isolation scan.`);
    }
    assertOpenedFileIdentity(root, path, after, label);
  } finally {
    closeSync(descriptor);
  }
  return { rows, bytes: totalBytes, sha256: hash.digest("hex") };
}

function assertOpenedFileIdentity(root, path, opened, label) {
  const live = lstatSync(path);
  if (live.isSymbolicLink() || !live.isFile() ||
      live.dev !== opened.dev || live.ino !== opened.ino) {
    throw new TypeError(`${label} path identity changed during inspection.`);
  }
  if (realpathSync(path) !== resolve(path) ||
      !strictlyWithin(root, realpathSync(path))) {
    throw new TypeError(`${label} resolves outside its canonical path.`);
  }
}

function inspectGold({ root, manifestPath, failures }) {
  const manifestEvidence = inspectRequiredFile(
    root,
    manifestPath,
    "Gold manifest",
    MAX_JSON_BYTES,
    failures,
    true
  );
  const manifest = parseJsonEvidence(
    manifestEvidence,
    "Gold manifest",
    failures
  );
  if (!manifest) return null;
  if (manifest.schemaVersion !== 3 || !Array.isArray(manifest.suites) ||
      manifest.suites.length < 1) {
    failures.push("Gold manifest contract is invalid.");
    return null;
  }
  const suites = [];
  const rows = [];
  const suiteIds = new Set();
  for (const suite of manifest.suites) {
    if (!isRecord(suite) || typeof suite.id !== "string" ||
        suite.id.length === 0 || suiteIds.has(suite.id) ||
        !SHA256_PATTERN.test(String(suite.sha256 ?? "")) ||
        !Number.isSafeInteger(suite.rows) || suite.rows < 1) {
      failures.push("Gold suite inventory is invalid or duplicated.");
      continue;
    }
    suiteIds.add(suite.id);
    const path = canonicalRecordedPath(
      root,
      suite.path,
      `Gold suite ${suite.id}`,
      failures
    );
    const evidence = path && inspectRequiredFile(
      root,
      path,
      `Gold suite ${suite.id}`,
      64 * 1024 * 1024,
      failures,
      true
    );
    requireEqual(
      evidence?.sha256,
      suite.sha256,
      `Gold suite ${suite.id} digest is stale.`,
      failures
    );
    const suiteRows = parseJsonLinesEvidence(
      evidence,
      `Gold suite ${suite.id}`,
      failures
    ) ?? [];
    requireEqual(
      suiteRows.length,
      suite.rows,
      `Gold suite ${suite.id} row count is stale.`,
      failures
    );
    suites.push({
      id: suite.id,
      path: suite.path,
      sha256: suite.sha256,
      rows: suite.rows
    });
    rows.push(
      ...suiteRows.map((row) => ({ ...row, suiteId: suite.id }))
    );
  }
  requireEqual(
    manifest.corpusSha256,
    suiteCorpusSha256(suites),
    "Gold manifest corpus digest is stale.",
    failures
  );
  return {
    manifest,
    manifestEvidence,
    suites,
    rows,
    snapshot: {
      goldManifest: portable(root, manifestPath),
      goldManifestSha256: manifestEvidence.sha256,
      goldCorpusSha256: manifest.corpusSha256,
      goldSuites: suites,
      goldRows: rows.length
    }
  };
}

function inspectOfficialBenchmark({ root, manifestPath, failures }) {
  const manifestEvidence = inspectRequiredFile(
    root,
    manifestPath,
    "Official benchmark manifest",
    MAX_JSON_BYTES,
    failures,
    true
  );
  const manifest = parseJsonEvidence(
    manifestEvidence,
    "Official benchmark manifest",
    failures
  );
  if (!manifest) return null;
  if (portable(root, manifestPath) !== CANONICAL_OFFICIAL_BENCHMARK ||
      manifestEvidence.sha256 !== CANONICAL_OFFICIAL_BENCHMARK_SHA256) {
    failures.push("Official benchmark is not the canonical locked v1 release.");
  }
  if (manifest.schemaVersion !== 2 ||
      manifest.status !== "official-public-benchmark-locked" ||
      manifest.trainingUse !== "forbidden-evaluation-only" ||
      manifest.uniqueInputPolicy !==
        "trim-lowercase-NFC-collapse-whitespace" ||
      !Array.isArray(manifest.suites) ||
      manifest.suites.length !== 3) {
    failures.push("Official benchmark manifest contract is invalid.");
    return null;
  }
  const suites = [];
  const rows = [];
  const suiteIds = new Set();
  const buckets = new Set();
  const rowIds = new Set();
  const inputs = new Set();
  for (const suite of manifest.suites) {
    if (!isRecord(suite) || typeof suite.id !== "string" ||
        suite.id.length === 0 || suiteIds.has(suite.id) ||
        !OFFICIAL_BUCKETS.includes(suite.benchmarkBucket) ||
        buckets.has(suite.benchmarkBucket) ||
        !SHA256_PATTERN.test(String(suite.sha256 ?? "")) ||
        !Number.isSafeInteger(suite.rows) || suite.rows < 1) {
      failures.push("Official benchmark suite inventory is invalid or duplicated.");
      continue;
    }
    suiteIds.add(suite.id);
    buckets.add(suite.benchmarkBucket);
    const path = canonicalRecordedPath(
      root,
      suite.path,
      `Official benchmark suite ${suite.id}`,
      failures
    );
    const evidence = path && inspectRequiredFile(
      root,
      path,
      `Official benchmark suite ${suite.id}`,
      64 * 1024 * 1024,
      failures,
      true
    );
    requireEqual(
      evidence?.sha256,
      suite.sha256,
      `Official benchmark suite ${suite.id} digest is stale.`,
      failures
    );
    const suiteRows = parseJsonLinesEvidence(
      evidence,
      `Official benchmark suite ${suite.id}`,
      failures
    ) ?? [];
    requireEqual(
      suiteRows.length,
      suite.rows,
      `Official benchmark suite ${suite.id} row count is stale.`,
      failures
    );
    for (const row of suiteRows) {
      const input = normalizedInput(row?.input);
      if (!isRecord(row) || typeof row.id !== "string" ||
          row.id.length === 0 || rowIds.has(row.id) ||
          input.length === 0 || inputs.has(input) ||
          !Array.isArray(row.acceptable) || row.acceptable.length < 1) {
        failures.push(
          `Official benchmark suite ${suite.id} contains an invalid or duplicate row.`
        );
        continue;
      }
      rowIds.add(row.id);
      inputs.add(input);
      rows.push({ ...row, benchmarkBucket: suite.benchmarkBucket });
    }
    suites.push({
      id: suite.id,
      path: suite.path,
      sha256: suite.sha256,
      rows: suite.rows,
      benchmarkBucket: suite.benchmarkBucket
    });
  }
  requireDeepEqual(
    [...buckets].sort(),
    [...OFFICIAL_BUCKETS].sort(),
    "Official benchmark does not cover every locked bucket.",
    failures
  );
  requireEqual(
    manifest.corpusSha256,
    suiteCorpusSha256(manifest.suites),
    "Official benchmark corpus digest is stale.",
    failures
  );
  const inputSha256 = officialInputSha256(rows);
  return {
    manifest,
    manifestEvidence,
    suites,
    rows,
    inputSha256,
    snapshot: {
      manifest: portable(root, manifestPath),
      manifestSha256: manifestEvidence.sha256,
      corpusSha256: manifest.corpusSha256,
      suites,
      rows: rows.length
    }
  };
}

function expectedOfficialIsolation(official, datasetSnapshot) {
  return official && {
    policy: "official-benchmark-inputs-absent-from-train-and-dev-v1",
    benchmarkInputSha256: official.inputSha256,
    comparedSplitSha256: {
      train: datasetSnapshot?.splits?.train?.sha256,
      dev: datasetSnapshot?.splits?.dev?.sha256
    },
    overlappingInputCount: 0
  };
}

function effectiveLayout(canonical, candidateRoot) {
  const paths = Object.fromEntries(
    Object.entries(canonical.paths).map(([key, path]) => [
      key,
      join(candidateRoot, basename(path))
    ])
  );
  const artifacts = canonical.artifacts.map((artifact) => ({
    role: artifact.role,
    compiledModel: join(candidateRoot, basename(artifact.compiledModel)),
    mlpackage: join(candidateRoot, basename(artifact.mlpackage))
  }));
  return {
    ...canonical,
    candidateRoot,
    candidateRootRelativePath: portable(canonical.root, candidateRoot),
    paths,
    artifacts
  };
}

function validateCandidateRoot({
  root,
  candidateRoot,
  canonicalLayout,
  production,
  failures
}) {
  const generatedRoot = resolve(
    root,
    "data",
    "generated",
    "neural-open-vocab-model"
  );
  const temporaryRoot = resolve(root, ".tmp");
  if (!(candidateRoot === canonicalLayout.candidateRoot ||
        strictlyWithin(generatedRoot, candidateRoot) ||
        strictlyWithin(temporaryRoot, candidateRoot))) {
    failures.push(
      "Candidate root must be canonical or a non-root directory under .tmp " +
      "or data/generated/neural-open-vocab-model."
    );
  }
  if (production && candidateRoot !== canonicalLayout.candidateRoot) {
    failures.push("Production Phase 4 requires the canonical candidate root.");
  }
  assertNoSymlinkComponents(root, candidateRoot, "Candidate root", failures);
}

function inspectCandidateFile(
  root,
  path,
  label,
  maxBytes,
  production,
  failures,
  warnings,
  includeContents = false
) {
  if (!existsSync(path)) {
    qualificationIssue(
      production,
      `${label} is absent: ${portable(root, path)}.`,
      failures,
      warnings
    );
    return null;
  }
  return inspectRequiredFile(
    root,
    path,
    label,
    maxBytes,
    failures,
    includeContents
  );
}

function inspectRequiredFile(
  root,
  path,
  label,
  maxBytes,
  failures,
  includeContents = false
) {
  if (!path) return null;
  try {
    return inspectContainedRegularFile(root, path, {
      label,
      maxBytes,
      includeContents
    });
  } catch (error) {
    failures.push(errorMessage(error));
    return null;
  }
}

function inspectDirectory(root, path, label, failures) {
  try {
    return inspectContainedDirectoryTree(root, path, {
      label,
      maxBytes: MAX_MODEL_BYTES,
      maxEntries: 10_000,
      maxDepth: 64
    });
  } catch (error) {
    failures.push(errorMessage(error));
    return null;
  }
}

function parseJsonEvidence(evidence, label, failures) {
  if (!evidence?.contents) return null;
  const text = decodeUtf8Evidence(evidence.contents, label, failures);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new TypeError("root must be an object");
    return value;
  } catch (error) {
    failures.push(`${label} is invalid JSON: ${errorMessage(error)}`);
    return null;
  }
}

function parseJsonLinesEvidence(evidence, label, failures) {
  if (!evidence?.contents) return null;
  const text = decodeUtf8Evidence(evidence.contents, label, failures);
  if (text === null) return null;
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    try {
      const row = JSON.parse(line);
      if (!isRecord(row)) throw new TypeError("row must be an object");
      rows.push(row);
    } catch (error) {
      failures.push(
        `${label}:${index + 1} is invalid JSON: ${errorMessage(error)}`
      );
    }
  }
  return rows;
}

function decodeUtf8Evidence(contents, label, failures) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    failures.push(
      `${label} is not valid UTF-8: ${errorMessage(error)}`
    );
    return null;
  }
}

function canonicalRecordedPath(root, value, label, failures) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) ||
      value.includes("\\") || value.split("/").some((part) =>
        part === "." || part === ".." || part.length === 0
      )) {
    failures.push(`${label} must use a canonical repository-relative POSIX path.`);
    return null;
  }
  const path = resolve(root, value);
  if (portable(root, path) !== value) {
    failures.push(`${label} path is non-canonical.`);
    return null;
  }
  return path;
}

function safePath(root, value, label, failures) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${label} path must be a non-empty string.`);
    return resolve(root, ".invalid-neural-path");
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) ||
      isAbsolute(child)) {
    failures.push(`${label} path escapes the repository.`);
  }
  return path;
}

function assertNoSymlinkComponents(root, path, label, failures) {
  const child = relative(root, path);
  let current = root;
  for (const component of child.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) break;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        failures.push(`${label} contains a symbolic-link path component: ${portable(root, current)}.`);
        return;
      }
    } catch (error) {
      failures.push(`${label} cannot be inspected: ${errorMessage(error)}`);
      return;
    }
  }
}

function evidenceSummary(root, evidence) {
  return Object.fromEntries(
    Object.entries(evidence).map(([key, value]) => [
      key,
      value
        ? {
            path: portable(root, value.path),
            sha256: value.sha256,
            bytes: value.bytes
          }
        : null
    ])
  );
}

function officialInputSha256(rows) {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(String(row.id));
    hash.update("\0");
    hash.update(normalizedInput(row.input));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function normalizedInput(value) {
  return typeof value === "string"
    ? value.normalize("NFC").trim().toLocaleLowerCase("en-US")
      .replace(/\s+/gu, " ")
    : "";
}

function suiteCorpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    hash.update(String(suite.id));
    hash.update("\0");
    hash.update(String(suite.path));
    hash.update("\0");
    hash.update(String(suite.sha256));
    hash.update("\0");
    hash.update(String(suite.rows));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function requireRunId(value, label, failures) {
  if (!RUN_ID_PATTERN.test(String(value ?? ""))) {
    failures.push(`${label} must be a 32-character lowercase hexadecimal ID.`);
  }
}

function requireEqual(actual, expected, message, failures) {
  if (!Object.is(actual, expected)) failures.push(message);
}

function requireDeepEqual(actual, expected, message, failures) {
  if (!deepEqual(actual, expected)) failures.push(message);
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(left[key], right[key])
    );
}

function qualificationIssue(production, message, failures, warnings) {
  (production ? failures : warnings).push(message);
}

function strictlyWithin(parent, candidate) {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}

function portable(root, path) {
  return relative(root, resolve(path)).split(sep).join("/");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
