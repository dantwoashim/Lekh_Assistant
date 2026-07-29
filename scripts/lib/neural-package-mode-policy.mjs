import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const NEURAL_PACKAGE_MODES = Object.freeze([
  "candidate-promotion",
  "experimental",
  "production"
]);

export const NEURAL_PRODUCTION_ROOT = Object.freeze([
  "models",
  "macos",
  "LekhNeuralTransliterator.production"
]);

export const NEURAL_CANDIDATE_ROOT = Object.freeze([
  "data",
  "generated",
  "neural-open-vocab-model"
]);

const MANIFEST_NAME = "LekhNeuralTransliterator.manifest.json";
const VOCABULARY_NAME = "LekhNeuralTransliterator.vocab.json";
const PROMOTION_RECEIPT_NAME = "neural-candidate-promotion-report.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const MODEL_LAYOUTS = Object.freeze({
  "lekh-open-vocab-seq2seq-v1": Object.freeze({
    runtimeModelContract: "single-seq2seq-v1",
    artifacts: Object.freeze({
      model: "LekhNeuralTransliterator.mlmodelc"
    })
  }),
  "lekh-open-vocab-bigru-attention-v1": Object.freeze({
    runtimeModelContract: "split-attention-incremental-v1",
    artifacts: Object.freeze({
      decoderStep: "LekhNeuralTransliteratorDecoderStep.mlmodelc",
      encoder: "LekhNeuralTransliteratorEncoder.mlmodelc"
    })
  }),
  "lekh-open-vocab-ctc-transformer-v2": Object.freeze({
    runtimeModelContract: "single-transformer-ctc-v1",
    artifacts: Object.freeze({
      model: "LekhNeuralTransliterator.mlmodelc"
    })
  })
});

export class NeuralPackageModePolicyError extends Error {
  constructor(result) {
    super(
      "Neural package mode policy rejected the artifact: " +
      result.issues
        .map(({ code, message }) => `[${code}] ${message}`)
        .join(" ")
    );
    this.name = "NeuralPackageModePolicyError";
    this.result = result;
  }
}

/**
 * Evaluate the complete neural packaging mode truth table without reading the
 * filesystem. Callers should first resolve the artifact through
 * resolveNeuralArtifactDescriptor(), then pass that descriptor here.
 */
export function evaluateNeuralPackageModePolicy(options) {
  const issues = [];
  const addIssue = (code, message) => {
    if (!issues.some((issue) => issue.code === code)) {
      issues.push(Object.freeze({ code, message }));
    }
  };
  const repoRoot = resolveInputPath(
    null,
    options?.repoRoot,
    "Repository root",
    "input.repo-root",
    addIssue
  );
  const artifactRoot = resolveInputPath(
    repoRoot,
    options?.artifactRoot,
    "Neural artifact root",
    "input.artifact-root",
    addIssue
  );
  const descriptor = isRecord(options?.descriptor)
    ? options.descriptor
    : null;
  if (!descriptor) {
    addIssue(
      "descriptor.invalid",
      "A resolved neural artifact descriptor is required."
    );
  }

  const modelId = descriptor?.modelId;
  const modelLayout = Object.hasOwn(MODEL_LAYOUTS, modelId)
    ? MODEL_LAYOUTS[modelId]
    : null;
  if (!modelLayout ||
      descriptor?.manifest?.selectedArtifact !== modelId) {
    addIssue(
      "descriptor.model-id",
      "The descriptor must have one supported model ID matching its manifest."
    );
  }
  if (modelLayout &&
      descriptor?.runtimeModelContract !== modelLayout.runtimeModelContract) {
    addIssue(
      "descriptor.runtime-contract",
      "The descriptor runtime contract does not match its selected model."
    );
  }
  const productionEligible = descriptor?.manifest?.productionEligible;
  if (productionEligible !== true && productionEligible !== false) {
    addIssue(
      "descriptor.production-eligible",
      "manifest.productionEligible must be an explicit boolean."
    );
  }
  if (!SHA256_PATTERN.test(String(descriptor?.manifestSha256 ?? ""))) {
    addIssue(
      "descriptor.manifest-sha256",
      "The descriptor manifest SHA-256 is missing or invalid."
    );
  }
  if (!SHA256_PATTERN.test(String(descriptor?.artifactSetSha256 ?? ""))) {
    addIssue(
      "descriptor.artifact-set-sha256",
      "The descriptor artifact-set SHA-256 is missing or invalid."
    );
  }

  const productionRoot = repoRoot
    ? join(repoRoot, ...NEURAL_PRODUCTION_ROOT)
    : null;
  const candidateRoot = repoRoot && validModelId(modelId)
    ? join(repoRoot, ...NEURAL_CANDIDATE_ROOT, modelId)
    : null;
  const expectedManifestPath = artifactRoot
    ? join(artifactRoot, MANIFEST_NAME)
    : null;
  const expectedVocabularyPath = artifactRoot
    ? join(artifactRoot, VOCABULARY_NAME)
    : null;
  const descriptorManifestPath = resolveInputPath(
    repoRoot,
    descriptor?.manifestPath,
    "Descriptor manifest",
    "descriptor.manifest-path",
    addIssue
  );
  if (expectedManifestPath && descriptorManifestPath &&
      expectedManifestPath !== descriptorManifestPath) {
    addIssue(
      "descriptor.manifest-path",
      "The descriptor manifest must be the manifest directly inside the artifact root."
    );
  }
  const descriptorVocabularyPath = resolveInputPath(
    repoRoot,
    descriptor?.vocabPath,
    "Descriptor vocabulary",
    "descriptor.vocabulary-path",
    addIssue
  );
  if (expectedVocabularyPath && descriptorVocabularyPath &&
      expectedVocabularyPath !== descriptorVocabularyPath) {
    addIssue(
      "descriptor.vocabulary-path",
      "The descriptor vocabulary must be directly inside the artifact root."
    );
  }
  if (!SHA256_PATTERN.test(String(descriptor?.vocabSha256 ?? ""))) {
    addIssue(
      "descriptor.vocabulary-sha256",
      "The descriptor vocabulary SHA-256 is missing or invalid."
    );
  }
  validateRunIdentity(descriptor, addIssue);
  validateArtifactLayout({
    artifactRoot,
    descriptor,
    modelLayout,
    repoRoot,
    addIssue
  });

  const artifactClass = artifactRoot === productionRoot
    ? "production"
    : artifactRoot === candidateRoot
      ? "candidate"
      : "unknown";
  const mode = options?.mode;
  if (!NEURAL_PACKAGE_MODES.includes(mode)) {
    addIssue(
      "mode.unknown",
      `Unsupported neural package mode ${JSON.stringify(mode)}.`
    );
  }
  const experimentalEnabled = options?.experimentalEnabled;
  if (experimentalEnabled !== true && experimentalEnabled !== false) {
    addIssue(
      "flag.experimental-boolean",
      "The experimental typing flag must be an explicit boolean."
    );
  }

  let promotion = null;
  if (mode === "production") {
    if (artifactClass !== "production") {
      addIssue(
        "root.production-required",
        "Production packaging requires the canonical promoted artifact root."
      );
    }
    if (productionEligible !== true) {
      addIssue(
        "flag.production-eligible-required",
        "Production packaging requires manifest.productionEligible=true."
      );
    }
    if (experimentalEnabled !== false) {
      addIssue(
        "flag.experimental-forbidden",
        "Production packaging requires the experimental typing flag to be false."
      );
    }
    promotion = validatePromotionReport({
      report: options?.promotionReport,
      repoRoot,
      productionRoot,
      descriptor,
      addIssue
    });
  } else if (mode === "candidate-promotion" || mode === "experimental") {
    if (artifactClass !== "candidate") {
      addIssue(
        "root.candidate-required",
        `${mode} packaging requires the model's canonical candidate root.`
      );
    }
    if (productionEligible !== false) {
      addIssue(
        "flag.production-ineligible-required",
        `${mode} packaging requires manifest.productionEligible=false.`
      );
    }
    if (experimentalEnabled !== true) {
      addIssue(
        "flag.experimental-required",
        `${mode} packaging requires the experimental typing flag to be true.`
      );
    }
    if (options?.promotionReport !== undefined &&
        options.promotionReport !== null) {
      addIssue(
        "promotion.unexpected",
        "Unpromoted candidate packaging must not carry production promotion metadata."
      );
    }
  }

  const valid = issues.length === 0;
  return deepFreeze({
    valid,
    mode: NEURAL_PACKAGE_MODES.includes(mode) ? mode : null,
    artifactClass,
    repoRoot,
    artifactRoot,
    expectedArtifactRoot: mode === "production"
      ? productionRoot
      : mode === "candidate-promotion" || mode === "experimental"
        ? candidateRoot
        : null,
    modelId: validModelId(modelId) ? modelId : null,
    productionEligible: productionEligible === true
      ? true
      : productionEligible === false
        ? false
        : null,
    experimentalEnabled: experimentalEnabled === true
      ? true
      : experimentalEnabled === false
        ? false
        : null,
    promotionVerified: valid && mode === "production",
    promotionId: valid && mode === "production"
      ? promotion?.promotionId ?? null
      : null,
    promotionReceiptSha256: valid && mode === "production"
      ? promotion?.receiptSha256 ?? null
      : null,
    issueCodes: issues.map(({ code }) => code),
    issues
  });
}

export function assertNeuralPackageModePolicy(options) {
  const result = evaluateNeuralPackageModePolicy(options);
  if (!result.valid) throw new NeuralPackageModePolicyError(result);
  return result;
}

function validatePromotionReport({
  report,
  repoRoot,
  productionRoot,
  descriptor,
  addIssue
}) {
  if (!isRecord(report)) {
    addIssue(
      "promotion.required",
      "Production packaging requires verified Phase 9 promotion metadata."
    );
    return null;
  }
  if (report.schemaVersion !== 2 ||
      report.suite !== "neural-production-promotion" ||
      report.phase !== 9 ||
      report.production !== true ||
      report.status !== "passed-production-phase9-promotion") {
    addIssue(
      "promotion.report-contract",
      "Promotion metadata must be a passed production Phase 9 report."
    );
  }
  if (!Array.isArray(report.failures) || report.failures.length !== 0) {
    addIssue(
      "promotion.failed",
      "Promotion metadata must contain an empty failure list."
    );
  }
  const reportedProductionRoot = resolveInputPath(
    repoRoot,
    report.productionDirectory,
    "Promotion report production directory",
    "promotion.directory",
    addIssue
  );
  if (productionRoot && reportedProductionRoot &&
      productionRoot !== reportedProductionRoot) {
    addIssue(
      "promotion.directory",
      "The promotion report does not identify the canonical production root."
    );
  }

  const verification = isRecord(report.verification)
    ? report.verification
    : null;
  if (!verification) {
    addIssue(
      "promotion.verification",
      "The Phase 9 report is missing verified promotion receipt metadata."
    );
    return null;
  }
  if (!SHA256_PATTERN.test(String(verification.promotionId ?? "")) ||
      !SHA256_PATTERN.test(String(verification.selectionId ?? "")) ||
      !RUN_ID_PATTERN.test(String(verification.trainingRunId ?? "")) ||
      !RUN_ID_PATTERN.test(String(verification.exportRunId ?? "")) ||
      verification.trainingRunId === verification.exportRunId ||
      verification.modelId !== descriptor?.modelId ||
      verification.runtimeModelContract !==
        descriptor?.runtimeModelContract ||
      verification.artifactSetSha256 !== descriptor?.artifactSetSha256 ||
      verification.trainingRunId !== descriptor?.manifest?.trainingRunId ||
      verification.exportRunId !== descriptor?.manifest?.exportRunId) {
    addIssue(
      "promotion.identity",
      "Promotion metadata is not bound to this exact neural artifact identity."
    );
  }

  const manifest = verification.manifest;
  const verifiedManifestPath = resolveInputPath(
    repoRoot,
    manifest?.path,
    "Verified promotion manifest",
    "promotion.manifest",
    addIssue
  );
  if (!validEvidenceRecord(manifest) ||
      manifest.sha256 !== descriptor?.manifestSha256 ||
      verifiedManifestPath !== resolve(repoRoot ?? "/", descriptor?.manifestPath ?? "")) {
    addIssue(
      "promotion.manifest",
      "Promotion metadata is not bound to the descriptor manifest bytes."
    );
  }

  const receipt = verification.receipt;
  const expectedReceiptPath = productionRoot
    ? join(productionRoot, PROMOTION_RECEIPT_NAME)
    : null;
  const verifiedReceiptPath = resolveInputPath(
    repoRoot,
    receipt?.path,
    "Verified promotion receipt",
    "promotion.receipt",
    addIssue
  );
  if (!validEvidenceRecord(receipt) ||
      verifiedReceiptPath !== expectedReceiptPath) {
    addIssue(
      "promotion.receipt",
      "Promotion metadata must identify the verified receipt in the production root."
    );
  }

  return SHA256_PATTERN.test(String(verification.promotionId ?? "")) &&
      SHA256_PATTERN.test(String(receipt?.sha256 ?? ""))
    ? {
        promotionId: verification.promotionId,
        receiptSha256: receipt.sha256
      }
    : null;
}

function validateRunIdentity(descriptor, addIssue) {
  const trainingRunId = descriptor?.manifest?.trainingRunId;
  const exportRunId = descriptor?.manifest?.exportRunId;
  if (!RUN_ID_PATTERN.test(String(trainingRunId ?? "")) ||
      !RUN_ID_PATTERN.test(String(exportRunId ?? "")) ||
      trainingRunId === exportRunId) {
    addIssue(
      "descriptor.run-identity",
      "The descriptor manifest requires distinct lowercase training and export run IDs."
    );
  }
}

function validateArtifactLayout({
  artifactRoot,
  descriptor,
  modelLayout,
  repoRoot,
  addIssue
}) {
  if (!modelLayout) return;
  if (!Array.isArray(descriptor?.artifacts)) {
    addIssue(
      "descriptor.artifacts",
      "The descriptor must contain its complete resolved runtime artifact list."
    );
    return;
  }
  const expectedRoles = Object.keys(modelLayout.artifacts).sort();
  const observedRoles = [];
  let totalCompiledBytes = 0;
  for (const artifact of descriptor.artifacts) {
    const role = artifact?.role;
    const expectedBundleName = Object.hasOwn(modelLayout.artifacts, role)
      ? modelLayout.artifacts[role]
      : null;
    if (!expectedBundleName ||
        artifact?.bundleName !== expectedBundleName) {
      addIssue(
        "descriptor.artifacts",
        "The descriptor contains an unknown role or non-canonical bundle name."
      );
      continue;
    }
    observedRoles.push(role);
    const sourcePath = resolveInputPath(
      repoRoot,
      artifact.sourcePath,
      `Descriptor ${role} artifact`,
      "descriptor.artifact-path",
      addIssue
    );
    if (artifactRoot && sourcePath !== join(artifactRoot, expectedBundleName)) {
      addIssue(
        "descriptor.artifact-path",
        "Every runtime artifact must be directly inside the selected artifact root."
      );
    }
    if (!SHA256_PATTERN.test(String(artifact.compiledSha256 ?? "")) ||
        !Number.isSafeInteger(artifact.compiledBytes) ||
        artifact.compiledBytes < 1) {
      addIssue(
        "descriptor.artifact-evidence",
        "Every runtime artifact requires a valid compiled hash and positive byte count."
      );
    } else {
      totalCompiledBytes += artifact.compiledBytes;
    }
  }
  if (JSON.stringify(observedRoles.sort()) !== JSON.stringify(expectedRoles)) {
    addIssue(
      "descriptor.artifacts",
      "The descriptor runtime artifact roles must be complete and unique."
    );
  }
  if (!Number.isSafeInteger(descriptor?.totalCompiledBytes) ||
      descriptor.totalCompiledBytes !== totalCompiledBytes) {
    addIssue(
      "descriptor.artifact-bytes",
      "The descriptor total compiled byte count does not match its artifacts."
    );
  }
}

function resolveInputPath(repoRoot, value, label, code, addIssue) {
  if (typeof value !== "string" || value.length === 0 ||
      /[\u0000\r\n]/u.test(value)) {
    addIssue(code, `${label} must be a non-empty path.`);
    return null;
  }
  const path = isAbsolute(value)
    ? resolve(value)
    : repoRoot
      ? resolve(repoRoot, value)
      : resolve(value);
  if (repoRoot) {
    const child = relative(repoRoot, path);
    if (child === ".." || child.startsWith(`..${sep}`) ||
        isAbsolute(child)) {
      addIssue(code, `${label} must remain inside the repository.`);
      return null;
    }
  }
  return path;
}

function validEvidenceRecord(value) {
  return isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    SHA256_PATTERN.test(String(value.sha256 ?? ""));
}

function validModelId(value) {
  return typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
