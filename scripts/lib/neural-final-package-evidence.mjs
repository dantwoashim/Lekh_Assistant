import { basename, dirname, join, resolve } from "node:path";
import {
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./neural-artifact-descriptor.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const RECORD_TYPE = "lekh-final-packaged-neural-evidence";
const MANIFEST_NAME = "LekhNeuralTransliterator.manifest.json";
const VOCABULARY_NAME = "LekhNeuralTransliterator.vocab.json";
const SINGLE_RUNTIME_CONTRACT = "single-seq2seq-v1";
const SPLIT_RUNTIME_CONTRACT = "split-attention-incremental-v1";
const EVIDENCE_KEYS = Object.freeze([
  "artifactSetSha256",
  "artifacts",
  "exportRunId",
  "manifestSha256",
  "modelId",
  "promotion",
  "productionEligible",
  "recordType",
  "runtimeModelContract",
  "schemaVersion",
  "trainingRunId",
  "vocabSha256"
]);
const ARTIFACT_KEYS = Object.freeze([
  "bundleName",
  "compiledBytes",
  "compiledSha256",
  "role"
]);
const PROMOTION_KEYS = Object.freeze([
  "promotionId",
  "receiptSha256"
]);
const EXPECTED_ARTIFACTS = Object.freeze({
  [SINGLE_RUNTIME_CONTRACT]: Object.freeze({
    model: "LekhNeuralTransliterator.mlmodelc"
  }),
  [SPLIT_RUNTIME_CONTRACT]: Object.freeze({
    decoderStep: "LekhNeuralTransliteratorDecoderStep.mlmodelc",
    encoder: "LekhNeuralTransliteratorEncoder.mlmodelc"
  })
});
const EXPECTED_MODEL_IDS = Object.freeze({
  [SINGLE_RUNTIME_CONTRACT]: "lekh-open-vocab-seq2seq-v1",
  [SPLIT_RUNTIME_CONTRACT]: "lekh-open-vocab-bigru-attention-v1"
});

export class NeuralFinalPackageEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NeuralFinalPackageEvidenceError";
  }
}

/**
 * Build a deterministic identity block from the exact neural bytes inside a
 * final app's Contents/Resources directory.
 *
 * A promotion receipt is optional because candidate/experimental packages do
 * not have one. When supplied, this helper hashes the receipt itself and binds
 * its promotion, run, manifest, and artifact-set identities to the packaged
 * bytes. Full promotion-policy verification remains the responsibility of the
 * Phase 9 verifier.
 */
export function buildFinalPackagedNeuralEvidence(options) {
  try {
    const resourcesDirectory = requiredAbsoluteDirectory(
      options?.resourcesDirectory
    );
    const descriptor = resolveNeuralArtifactDescriptor({
      repoRoot: resourcesDirectory,
      manifestPath: join(resourcesDirectory, MANIFEST_NAME),
      vocabPath: join(resourcesDirectory, VOCABULARY_NAME),
      artifactDirectory: resourcesDirectory,
      verifyExportArtifacts: false
    });
    const trainingRunId = requireRunId(
      descriptor.manifest.trainingRunId,
      "Packaged neural manifest trainingRunId"
    );
    const exportRunId = requireRunId(
      descriptor.manifest.exportRunId,
      "Packaged neural manifest exportRunId"
    );
    if (trainingRunId === exportRunId) {
      fail("Packaged neural trainingRunId and exportRunId must be distinct.");
    }

    const evidence = {
      schemaVersion: 1,
      recordType: RECORD_TYPE,
      modelId: descriptor.modelId,
      runtimeModelContract: descriptor.runtimeModelContract,
      trainingRunId,
      exportRunId,
      manifestSha256: descriptor.manifestSha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256,
      productionEligible: requireBoolean(
        descriptor.manifest.productionEligible,
        "Packaged neural manifest productionEligible"
      ),
      artifacts: descriptor.artifacts
        .map((artifact) => ({
          role: artifact.role,
          bundleName: artifact.bundleName,
          compiledSha256: artifact.compiledSha256,
          compiledBytes: artifact.compiledBytes
        }))
        .sort((left, right) => compareText(left.role, right.role)),
      promotion: resolvePromotionEvidence(options, descriptor)
    };
    validateClosedEvidence(evidence);
    return deepFreeze(evidence);
  } catch (error) {
    if (error instanceof NeuralFinalPackageEvidenceError) throw error;
    throw new NeuralFinalPackageEvidenceError(
      `Unable to build final packaged neural evidence: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

/**
 * Re-resolve every shipped neural byte and require it to reproduce an existing
 * closed evidence block exactly. Any manifest, vocabulary, compiled-model, or
 * supplied promotion-receipt drift fails closed.
 */
export function verifyFinalPackagedNeuralEvidence(options) {
  const expected = validateClosedEvidence(options?.evidence);
  const observed = buildFinalPackagedNeuralEvidence(options);
  if (!deepEqual(expected, observed)) {
    fail(
      "Final packaged neural evidence no longer matches the shipped bytes or " +
      "promotion receipt."
    );
  }
  return observed;
}

function resolvePromotionEvidence(options, descriptor) {
  const receiptPath = options?.promotionReceiptPath;
  if (receiptPath === undefined || receiptPath === null) {
    if (descriptor.manifest.productionEligible === true) {
      fail(
        "A production-eligible packaged neural manifest requires its exact " +
        "promotion receipt."
      );
    }
    return null;
  }
  if (descriptor.manifest.productionEligible !== true) {
    fail(
      "An unpromoted packaged neural manifest must not carry a production " +
      "promotion receipt."
    );
  }
  if (typeof receiptPath !== "string" || receiptPath.length === 0) {
    fail("promotionReceiptPath must be a non-empty path when supplied.");
  }
  const resolvedReceiptPath = resolve(
    options?.promotionReceiptRoot ?? process.cwd(),
    receiptPath
  );
  const receiptRoot = resolve(
    options?.promotionReceiptRoot ?? dirname(resolvedReceiptPath)
  );
  if (basename(resolvedReceiptPath) !== "neural-candidate-promotion-report.json") {
    fail(
      "The neural promotion receipt must use its canonical filename."
    );
  }
  const receiptEvidence = inspectContainedRegularFile(
    receiptRoot,
    resolvedReceiptPath,
    {
      label: "Neural promotion receipt",
      includeContents: true,
      maxBytes: 4 * 1024 * 1024
    }
  );
  let receipt;
  try {
    receipt = JSON.parse(receiptEvidence.contents.toString("utf8"));
  } catch (error) {
    fail(`Neural promotion receipt is invalid JSON: ${errorMessage(error)}`);
  }
  requireRecord(receipt, "Neural promotion receipt");
  const promotionId = requireSha256(
    receipt.promotionId,
    "Neural promotion receipt promotionId"
  );
  if (receipt.schemaVersion !== 1 ||
      receipt.status !== "passed-neural-candidate-promotion" ||
      receipt.candidateImmutable !== true ||
      receipt.trainingRunId !== descriptor.manifest.trainingRunId ||
      receipt.exportRunId !== descriptor.manifest.exportRunId ||
      receipt.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      receipt.productionManifest?.sha256 !== descriptor.manifestSha256) {
    fail(
      "Neural promotion receipt is not bound to the exact packaged manifest, " +
      "run identities, and artifact set."
    );
  }
  return {
    promotionId,
    receiptSha256: receiptEvidence.sha256
  };
}

function validateClosedEvidence(value) {
  requireExactKeys(value, EVIDENCE_KEYS, "Final packaged neural evidence");
  if (value.schemaVersion !== 1 || value.recordType !== RECORD_TYPE) {
    fail("Final packaged neural evidence record identity is invalid.");
  }
  requireBoolean(
    value.productionEligible,
    "Final packaged neural evidence productionEligible"
  );
  const expectedArtifacts = Object.hasOwn(
    EXPECTED_ARTIFACTS,
    value.runtimeModelContract
  )
    ? EXPECTED_ARTIFACTS[value.runtimeModelContract]
    : null;
  if (!expectedArtifacts) {
    fail("Final packaged neural evidence runtimeModelContract is invalid.");
  }
  if (value.modelId !== EXPECTED_MODEL_IDS[value.runtimeModelContract]) {
    fail(
      "Final packaged neural evidence modelId does not match its runtime contract."
    );
  }
  requireRunId(value.trainingRunId, "Final packaged neural evidence trainingRunId");
  requireRunId(value.exportRunId, "Final packaged neural evidence exportRunId");
  if (value.trainingRunId === value.exportRunId) {
    fail("Final packaged neural evidence run identities must be distinct.");
  }
  requireSha256(
    value.manifestSha256,
    "Final packaged neural evidence manifestSha256"
  );
  requireSha256(
    value.vocabSha256,
    "Final packaged neural evidence vocabSha256"
  );
  requireSha256(
    value.artifactSetSha256,
    "Final packaged neural evidence artifactSetSha256"
  );
  if (!Array.isArray(value.artifacts)) {
    fail("Final packaged neural evidence artifacts must be an array.");
  }
  const expectedRoles = Object.keys(expectedArtifacts).sort(compareText);
  const observedRoles = [];
  for (const artifact of value.artifacts) {
    requireExactKeys(
      artifact,
      ARTIFACT_KEYS,
      "Final packaged neural evidence artifact"
    );
    if (typeof artifact.role !== "string" ||
        expectedArtifacts[artifact.role] !== artifact.bundleName) {
      fail("Final packaged neural evidence artifact role or bundle name is invalid.");
    }
    requireSha256(
      artifact.compiledSha256,
      `Final packaged neural evidence ${artifact.role} compiledSha256`
    );
    if (!Number.isSafeInteger(artifact.compiledBytes) ||
        artifact.compiledBytes < 1) {
      fail(
        `Final packaged neural evidence ${artifact.role} compiledBytes is invalid.`
      );
    }
    observedRoles.push(artifact.role);
  }
  if (!deepEqual(observedRoles, expectedRoles)) {
    fail(
      "Final packaged neural evidence artifact roles must be complete, unique, " +
      "and canonically ordered."
    );
  }
  if (value.promotion !== null) {
    requireExactKeys(
      value.promotion,
      PROMOTION_KEYS,
      "Final packaged neural evidence promotion"
    );
    requireSha256(
      value.promotion.promotionId,
      "Final packaged neural evidence promotionId"
    );
    requireSha256(
      value.promotion.receiptSha256,
      "Final packaged neural evidence receiptSha256"
    );
  }
  if (value.productionEligible !== (value.promotion !== null)) {
    fail(
      "Final packaged neural evidence must carry promotion metadata exactly " +
      "when its manifest is production-eligible."
    );
  }
  return value;
}

function requiredAbsoluteDirectory(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("resourcesDirectory is required.");
  }
  return resolve(value);
}

function requireRunId(value, label) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    fail(`${label} must be a lowercase 32-character run ID.`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (value !== true && value !== false) {
    fail(`${label} must be an explicit boolean.`);
  }
  return value;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function requireExactKeys(value, expected, label) {
  requireRecord(value, label);
  const observed = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (!deepEqual(observed, wanted)) {
    fail(`${label} must contain exactly ${wanted.join(", ")}.`);
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (!left || !right ||
      typeof left !== "object" ||
      typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return deepEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new NeuralFinalPackageEvidenceError(message);
}
