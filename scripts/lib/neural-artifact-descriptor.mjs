import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./neural-artifact-filesystem.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASELINE_MODEL_ID = "lekh-open-vocab-seq2seq-v1";
const ATTENTION_MODEL_ID = "lekh-open-vocab-bigru-attention-v1";
const BASELINE_RUNTIME_CONTRACT = "single-seq2seq-v1";
const ATTENTION_RUNTIME_CONTRACT = "split-attention-incremental-v1";
const BASELINE_BUNDLE_NAME = "LekhNeuralTransliterator.mlmodelc";
const SPLIT_ROLES = Object.freeze(["encoder", "decoderStep"]);
const SPLIT_BUNDLE_NAMES = Object.freeze({
  encoder: "LekhNeuralTransliteratorEncoder.mlmodelc",
  decoderStep: "LekhNeuralTransliteratorDecoderStep.mlmodelc"
});

export class NeuralArtifactDescriptorError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralArtifactDescriptorError";
  }
}

/**
 * Resolve and verify the complete runtime artifact set represented by a neural
 * manifest. The descriptor deliberately excludes export-only .mlpackage paths
 * from its artifact-set identity because those directories are not shipped.
 */
export function resolveNeuralArtifactDescriptor(options) {
  const repoRoot = resolve(options?.repoRoot ?? options?.root ?? process.cwd());
  const manifestPath = resolveRequiredPath(
    repoRoot,
    options?.manifestPath,
    "manifestPath"
  );
  const vocabPath = resolveRequiredPath(
    repoRoot,
    options?.vocabPath,
    "vocabPath"
  );
  const manifest = structuredClone(
    options?.manifest ?? readJson(manifestPath, "Neural manifest")
  );
  requireRecord(manifest, "Neural manifest");
  assertNoSymlinkComponents(repoRoot, manifestPath, "Neural manifest");
  assertNoSymlinkComponents(repoRoot, vocabPath, "Neural vocabulary");

  const manifestEvidence = inspectContainedRegularFile(repoRoot, manifestPath, {
    label: "Neural manifest",
    maxBytes: 4 * 1024 * 1024
  });
  const vocabEvidence = inspectContainedRegularFile(repoRoot, vocabPath, {
    label: "Neural vocabulary",
    maxBytes: 16 * 1024 * 1024
  });
  const expectedVocabSha256 = requireSha256(
    manifest.sha256?.vocabMetadata,
    "manifest.sha256.vocabMetadata"
  );
  if (vocabEvidence.sha256 !== expectedVocabSha256) {
    fail("Neural vocabulary bytes do not match manifest.sha256.vocabMetadata.");
  }
  const artifactDirectory = options?.artifactDirectory === undefined
    ? null
    : resolveRequiredPath(
        repoRoot,
        options.artifactDirectory,
        "artifactDirectory"
      );
  if (artifactDirectory) {
    assertNoSymlinkComponents(
      repoRoot,
      artifactDirectory,
      "Neural artifact directory"
    );
  }
  const verifyExportArtifacts = options?.verifyExportArtifacts !== false;

  const artifacts = manifest.runtimeModelContract === ATTENTION_RUNTIME_CONTRACT ||
    manifest.selectedArtifact === ATTENTION_MODEL_ID
    ? resolveSplitArtifacts(
        repoRoot,
        manifest,
        artifactDirectory,
        verifyExportArtifacts
      )
    : resolveBaselineArtifact(
        repoRoot,
        manifest,
        manifestPath,
        artifactDirectory
      );
  const totalCompiledBytes = artifacts.reduce(
    (total, artifact) => total + artifact.compiledBytes,
    0
  );
  if (!Number.isSafeInteger(manifest.modelBytes) ||
      manifest.modelBytes !== totalCompiledBytes) {
    fail(
      `Manifest modelBytes (${String(manifest.modelBytes)}) does not match ` +
      `the verified compiled artifact set (${totalCompiledBytes}).`
    );
  }

  const runtimeModelContract = manifest.selectedArtifact === ATTENTION_MODEL_ID
    ? ATTENTION_RUNTIME_CONTRACT
    : BASELINE_RUNTIME_CONTRACT;
  const tensorContractSha256 = manifest.tensorContract === undefined
    ? null
    : sha256CanonicalJson(manifest.tensorContract);
  const artifactSetIdentity = {
    version: 1,
    modelId: manifest.selectedArtifact,
    runtimeModelContract,
    vocabSha256: vocabEvidence.sha256,
    tensorContractSha256,
    artifacts: artifacts
      .map((artifact) => ({
        role: artifact.role,
        bundleName: artifact.bundleName,
        compiledSha256: artifact.compiledSha256,
        compiledBytes: artifact.compiledBytes
      }))
      .sort((left, right) => left.role.localeCompare(right.role))
  };

  return deepFreeze({
    schemaVersion: 1,
    modelId: manifest.selectedArtifact,
    runtimeModelContract,
    manifest,
    manifestPath,
    manifestSha256: manifestEvidence.sha256,
    vocabPath,
    vocabSha256: vocabEvidence.sha256,
    tensorContract: manifest.tensorContract ?? null,
    tensorContractSha256,
    artifacts,
    totalCompiledBytes,
    artifactSetIdentity,
    artifactSetSha256: sha256CanonicalJson(artifactSetIdentity)
  });
}

function resolveBaselineArtifact(
  repoRoot,
  manifest,
  manifestPath,
  artifactDirectory
) {
  if (manifest.selectedArtifact !== BASELINE_MODEL_ID ||
      manifest.architecture !== "gru-encoder-decoder-seq2seq" ||
      manifest.runtimeModelContract !== undefined ||
      manifest.tensorContract !== undefined ||
      manifest.compiledModels !== undefined ||
      manifest.sha256?.compiledModels !== undefined ||
      manifest.sha256?.mlpackages !== undefined) {
    fail("Baseline manifest does not satisfy the closed single-seq2seq artifact branch.");
  }
  const expectedSha256 = requireSha256(
    manifest.sha256?.compiledModel,
    "manifest.sha256.compiledModel"
  );
  const sourcePath = resolve(
    artifactDirectory ?? dirname(manifestPath),
    BASELINE_BUNDLE_NAME
  );
  assertNoSymlinkComponents(
    repoRoot,
    sourcePath,
    "Baseline compiled neural model"
  );
  const evidence = inspectContainedDirectoryTree(repoRoot, sourcePath, {
    label: "Baseline compiled neural model",
    maxBytes: 64 * 1024 * 1024,
    maxEntries: 10_000
  });
  if (evidence.sha256 !== expectedSha256) {
    fail("Baseline compiled model bytes do not match manifest.sha256.compiledModel.");
  }
  return [{
    role: "model",
    sourcePath,
    sourceRelativePath: portableRelative(repoRoot, sourcePath),
    bundleName: BASELINE_BUNDLE_NAME,
    compiledSha256: evidence.sha256,
    compiledBytes: evidence.bytes
  }];
}

function resolveSplitArtifacts(
  repoRoot,
  manifest,
  artifactDirectory,
  verifyExportArtifacts
) {
  if (manifest.selectedArtifact !== ATTENTION_MODEL_ID ||
      manifest.architecture !== "bidirectional-gru-additive-attention-seq2seq" ||
      manifest.runtimeModelContract !== ATTENTION_RUNTIME_CONTRACT) {
    fail("Split manifest does not satisfy the attention runtime identity branch.");
  }
  requireRecord(manifest.tensorContract, "manifest.tensorContract");
  requireExactKeys(manifest.compiledModels, SPLIT_ROLES, "manifest.compiledModels");
  requireExactKeys(manifest.sha256?.compiledModels, SPLIT_ROLES, "manifest.sha256.compiledModels");
  requireExactKeys(manifest.sha256?.mlpackages, SPLIT_ROLES, "manifest.sha256.mlpackages");

  const artifacts = [];
  const paths = new Set();
  const bundleNames = new Set();
  for (const role of SPLIT_ROLES) {
    const declared = manifest.compiledModels[role];
    requireRecord(declared, `manifest.compiledModels.${role}`);
    if (declared.role !== role) {
      fail(`manifest.compiledModels.${role}.role must equal ${role}.`);
    }
    const recordedSourcePath = resolveSafeRecordedPath(
      repoRoot,
      declared.compiledModel,
      `manifest.compiledModels.${role}.compiledModel`
    );
    const recordedPackagePath = resolveSafeRecordedPath(
      repoRoot,
      declared.mlpackage,
      `manifest.compiledModels.${role}.mlpackage`
    );
    const sourcePath = artifactDirectory
      ? resolve(artifactDirectory, basename(recordedSourcePath))
      : recordedSourcePath;
    const packagePath = recordedPackagePath;
    const bundleName = basename(sourcePath);
    if (bundleName !== SPLIT_BUNDLE_NAMES[role]) {
      fail(
        `Split ${role} compiled model must use canonical bundle name ` +
        `${SPLIT_BUNDLE_NAMES[role]}; found ${bundleName}.`
      );
    }
    if (paths.has(sourcePath) || bundleNames.has(bundleName)) {
      fail(`Split ${role} duplicates another runtime artifact path or bundle name.`);
    }
    paths.add(sourcePath);
    bundleNames.add(bundleName);

    const compiledEvidence = inspectContainedDirectoryTree(repoRoot, sourcePath, {
      label: `Split ${role} compiled neural model`,
      maxBytes: 64 * 1024 * 1024,
      maxEntries: 10_000
    });
    assertNoSymlinkComponents(
      repoRoot,
      sourcePath,
      `Split ${role} compiled neural model`
    );
    if (verifyExportArtifacts) {
      assertNoSymlinkComponents(
        repoRoot,
        packagePath,
        `Split ${role} Core ML package`
      );
    }
    const packageEvidence = verifyExportArtifacts
      ? inspectContainedDirectoryTree(repoRoot, packagePath, {
          label: `Split ${role} Core ML package`,
          maxBytes: 64 * 1024 * 1024,
          maxEntries: 10_000
        })
      : null;
    const expectedCompiledSha256 = requireSha256(
      declared.compiledSha256,
      `manifest.compiledModels.${role}.compiledSha256`
    );
    const expectedPackageSha256 = requireSha256(
      declared.mlpackageSha256,
      `manifest.compiledModels.${role}.mlpackageSha256`
    );
    if (compiledEvidence.sha256 !== expectedCompiledSha256 ||
        manifest.sha256.compiledModels[role] !== expectedCompiledSha256) {
      fail(`Split ${role} compiled model bytes do not match all manifest identities.`);
    }
    if (manifest.sha256.mlpackages[role] !== expectedPackageSha256 ||
        (packageEvidence && packageEvidence.sha256 !== expectedPackageSha256)) {
      fail(`Split ${role} package bytes do not match all manifest identities.`);
    }
    if (!Number.isSafeInteger(declared.compiledBytes) ||
        declared.compiledBytes !== compiledEvidence.bytes ||
        !Number.isSafeInteger(declared.mlpackageBytes) ||
        declared.mlpackageBytes < 1 ||
        (packageEvidence && declared.mlpackageBytes !== packageEvidence.bytes)) {
      fail(`Split ${role} byte counts do not match the verified artifacts.`);
    }
    artifacts.push({
      role,
      sourcePath,
      sourceRelativePath: portableRelative(repoRoot, sourcePath),
      bundleName,
      compiledSha256: compiledEvidence.sha256,
      compiledBytes: compiledEvidence.bytes,
      mlpackagePath: packagePath,
      mlpackageRelativePath: portableRelative(repoRoot, packagePath),
      mlpackageSha256: expectedPackageSha256,
      mlpackageBytes: declared.mlpackageBytes
    });
  }
  return artifacts;
}

function resolveSafeRecordedPath(repoRoot, value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    fail(`${label} must be a non-empty repository-relative path.`);
  }
  const path = resolve(repoRoot, value);
  const child = relative(repoRoot, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} escapes the repository.`);
  }
  return path;
}

function resolveRequiredPath(repoRoot, value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is required.`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  const child = relative(repoRoot, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} escapes the repository.`);
  }
  return path;
}

function assertNoSymlinkComponents(repoRoot, path, label) {
  const root = resolve(repoRoot);
  const target = resolve(path);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} escapes the repository.`);
  }
  let current = root;
  for (const component of child.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if (!existsSync(current)) {
      fail(`${label} is missing: ${portableRelative(root, current)}.`);
    }
    if (lstatSync(current).isSymbolicLink()) {
      fail(
        `${label} contains a symbolic-link path component: ` +
        `${portableRelative(root, current)}.`
      );
    }
  }
}

function readJson(path, label) {
  const evidence = inspectContainedRegularFile(dirname(path), path, {
    label,
    includeContents: true,
    maxBytes: 4 * 1024 * 1024
  });
  try {
    return JSON.parse(evidence.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function requireExactKeys(value, expected, label) {
  requireRecord(value, label);
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    fail(`${label} must contain exactly ${wanted.join(", ")}.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
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

function portableRelative(parent, candidate) {
  return relative(resolve(parent), resolve(candidate)).split(sep).join("/");
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
  throw new NeuralArtifactDescriptorError(message);
}
