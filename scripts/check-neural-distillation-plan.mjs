#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { inspectContainedRegularFile } from "./lib/neural-artifact-filesystem.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-distillation-plan-production-report.json" : "neural-distillation-plan-report.json");
const sourceRegistryPath = join(root, "data", "neural", "sources.v1.json");
const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
const datasetReportPath = join(root, "reports", "neural-open-vocab-dataset-report.json");
const trainingConfigPath = join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");
const teacherManifestPath = join(root, "data", "generated", "neural-teacher-models", "ai4bharat-indicxlit", "v1.0", "manifest.json");
const distillationEvidencePath = join(root, "reports", "neural-distillation-run-report.json");
const privateSyubrajPath = join(root, "data", "private", "neural", "syubraj-roman2nepali-transliteration", "syubraj-roman2nepali-transliteration.tsv");
const approvedRunnerContractVersion = 0;

const failures = [];
const warnings = [];
const fileEvidenceCache = new Map();
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SUPERVISION_BYTES = 512 * 1024 * 1024;
const MAX_BOUND_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

const sourceRegistry = readJsonIfExists(sourceRegistryPath, "source registry");
const datasetManifest = readJsonIfExists(datasetManifestPath, "open-vocab dataset manifest");
const datasetReport = readJsonIfExists(datasetReportPath, "open-vocab dataset report");
const trainingConfig = readJsonIfExists(trainingConfigPath, "training config");
const teacherManifest = readJsonIfExists(teacherManifestPath, "teacher model manifest");
const distillationEvidence = readJsonIfExists(distillationEvidencePath, "distillation run evidence");
const privateSyubrajEvidence = inspectFileIfExists(
  privateSyubrajPath,
  "Private Syubraj import",
  MAX_BOUND_ARTIFACT_BYTES
);

let distillationConfig = null;
let distillationConfigurationValid = false;
let distillationEvidenceValid = false;
let distillationImplemented = false;

if (!sourceRegistry) failures.push("Missing data/neural/sources.v1.json.");
if (!datasetManifest) failures.push("Missing data/generated/neural-open-vocab/manifest.json. Run npm run neural:open-vocab:dataset.");
if (!trainingConfig) failures.push("Missing data/neural/training/open-vocab-seq2seq-v1.config.json.");

if (sourceRegistry) {
  const sources = new Map((sourceRegistry.sources ?? []).map((source) => [source.id, source]));
  const teacher = sources.get("ai4bharat-indicxlit");
  if (!teacher) {
    failures.push("Source registry must include ai4bharat-indicxlit as teacher-only.");
  } else {
    if (teacher.status !== "teacher-only") failures.push("ai4bharat-indicxlit must be marked teacher-only.");
    if (teacher.allowedForOpenVocabTokenTraining !== false) failures.push("Teacher checkpoint must not be allowed as direct token-training source.");
    if (teacher.rawDataCommitted !== false) failures.push("Teacher checkpoint/raw files must never be committed.");
  }

  for (const required of sourceRegistry.productionRequiredSources ?? []) {
    const source = sources.get(required);
    if (!source) failures.push(`Source registry missing production required source: ${required}.`);
    const hasCleanRows = Number(datasetReport?.sourceCounts?.[required] ?? 0) > 0;
    if (production && !hasCleanRows) {
      failures.push(`Production Phase 3 requires artifact-backed cleaned rows for ${required}; registry status alone is not import evidence.`);
    }
  }
}

if (trainingConfig) {
  const configurationFailureCount = failures.length;
  if (trainingConfig.modelId !== "lekh-open-vocab-seq2seq-v1") failures.push("Training config modelId must be lekh-open-vocab-seq2seq-v1.");

  distillationConfig = trainingConfig.training?.distillation ?? null;
  if (!distillationConfig || typeof distillationConfig !== "object" || Array.isArray(distillationConfig)) {
    failures.push("Training config must define training.distillation as an object.");
  } else {
    if (typeof distillationConfig.enabled !== "boolean") {
      failures.push("training.distillation.enabled must be a boolean.");
    }
    if (distillationConfig.enabled === false && distillationConfig.status !== "not-implemented") {
      failures.push("Disabled distillation must declare training.distillation.status=not-implemented.");
    }
    if (distillationConfig.enabled === true && distillationConfig.status !== "implemented") {
      failures.push("Enabled distillation must declare training.distillation.status=implemented.");
    }
    if (distillationConfig.teacherPolicy !== "offline-teacher-only-never-packaged") {
      failures.push("training.distillation.teacherPolicy must keep the public teacher offline-only and never packaged.");
    }
    if (!Array.isArray(distillationConfig.teacherSources) || !distillationConfig.teacherSources.includes("ai4bharat-indicxlit")) {
      failures.push("training.distillation.teacherSources must name ai4bharat-indicxlit.");
    }
  }

  distillationConfigurationValid = failures.length === configurationFailureCount;
}

if (datasetManifest) {
  if (datasetManifest.datasetId !== "lekh-open-vocab-cleaned-v1") failures.push("Dataset manifest must identify lekh-open-vocab-cleaned-v1.");
  const rows = Number(datasetManifest.counts?.totalRows ?? datasetManifest.totalRows);
  if (!Number.isFinite(rows) || rows <= 0) failures.push("Dataset manifest must include a positive row count.");
  if (production && rows < 1_000_000) failures.push(`Production Phase 3 requires >=1,000,000 cleaned rows before distillation; found ${rows}.`);
}

if (teacherManifest) {
  if (teacherManifest.role !== "teacher-only-not-shipping") failures.push("Downloaded teacher manifest must declare teacher-only-not-shipping.");
  if (teacherManifest.productionPolicy?.shippingAllowed !== false) failures.push("Downloaded teacher manifest must forbid shipping.");
  if (teacherManifest.productionPolicy?.coreML !== false) failures.push("Downloaded teacher manifest must not be treated as the Core ML artifact.");
} else if (distillationConfig?.enabled === true) {
  failures.push("An enabled distillation run requires the local teacher manifest from npm run neural:teacher:download.");
} else {
  warnings.push("Teacher checkpoint is not downloaded locally; the offline boundary can be checked, but no distillation run can be evidenced.");
}

if (distillationConfig?.enabled !== true) {
  warnings.push("Distillation is an optional offline optimization and is explicitly disabled; the downloaded teacher, if present, is not evidence of a distillation run.");
  if (distillationEvidence) warnings.push("A distillation evidence report exists but is ignored because training.distillation.enabled is false.");
} else if (!distillationEvidence) {
  failures.push("Enabled distillation requires reports/neural-distillation-run-report.json.");
}

if (distillationConfig?.enabled === true && production && distillationConfig?.status !== "implemented") {
  failures.push("Production Phase 3 requires training.distillation.status=implemented.");
}

if (distillationConfig?.enabled === true && distillationEvidence) {
  const evidenceFailureCount = failures.length;
  validateDistillationEvidence(distillationEvidence);
  distillationEvidenceValid = failures.length === evidenceFailureCount;
}

if (distillationConfig?.enabled === true && approvedRunnerContractVersion < 1) {
  failures.push("Distillation evidence is artifact-coexistence only: no approved runner embeds verified teacher, supervision, dataset, and split-disjointness provenance in the student checkpoint.");
}

distillationImplemented = Boolean(
  distillationConfigurationValid
  && distillationConfig?.enabled === true
  && distillationConfig?.status === "implemented"
  && distillationEvidenceValid
  && approvedRunnerContractVersion >= 1
);

if (production && distillationConfig?.enabled === true && !distillationImplemented) {
  failures.push("Production Phase 3 requires a digest-bound teacher/student/dataset distillation run; a teacher manifest alone is insufficient.");
}

const status = failures.length === 0
  ? distillationImplemented
    ? production ? "passed-production-phase3-distillation-evidence" : "passed-phase3-distillation-evidence"
    : production
      ? "passed-production-phase3-distillation-not-required"
      : "passed-phase3-distillation-contract-not-implemented"
  : production ? "failed-production-phase3-distillation-plan" : "failed-phase3-distillation-plan";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 3,
  production,
  sourceRegistry: relative(root, sourceRegistryPath),
  datasetManifest: existsSync(datasetManifestPath) ? relative(root, datasetManifestPath) : null,
  datasetReport: existsSync(datasetReportPath) ? relative(root, datasetReportPath) : null,
  trainingConfig: existsSync(trainingConfigPath) ? relative(root, trainingConfigPath) : null,
  teacherManifest: existsSync(teacherManifestPath) ? relative(root, teacherManifestPath) : null,
  distillationEvidence: existsSync(distillationEvidencePath) ? relative(root, distillationEvidencePath) : null,
  privateSyubrajImport: privateSyubrajEvidence ? relative(root, privateSyubrajPath) : null,
  privateSyubrajImportSha256: privateSyubrajEvidence?.sha256 ?? null,
  teacherDownloaded: Boolean(teacherManifest),
  distillationConfigured: distillationConfig?.enabled === true,
  distillationConfigStatus: distillationConfig?.status ?? null,
  artifactCoexistenceValid: distillationEvidenceValid,
  distillationEvidenceValid: distillationEvidenceValid && approvedRunnerContractVersion >= 1,
  approvedRunnerContractVersion,
  distillationImplemented,
  trainingConfigSha256: existsSync(trainingConfigPath) ? sha256File(trainingConfigPath) : null,
  datasetManifestSha256: existsSync(datasetManifestPath) ? sha256File(datasetManifestPath) : null,
  distillationEvidenceSha256: existsSync(distillationEvidencePath) ? sha256File(distillationEvidencePath) : null,
  failures,
  warnings
});

function validateDistillationEvidence(evidence) {
  if (evidence.schemaVersion !== 1) failures.push("Distillation evidence schemaVersion must be 1.");
  if (evidence.status !== "passed-distillation-run") failures.push("Distillation evidence status must equal passed-distillation-run.");
  if (evidence.distillationImplemented !== true) failures.push("Distillation evidence must declare distillationImplemented=true.");
  if (evidence.modelId !== trainingConfig?.modelId) failures.push("Distillation evidence modelId must match the training config.");

  requireDigestMatch(
    "Distillation evidence trainingConfigSha256",
    evidence.trainingConfigSha256,
    existsSync(trainingConfigPath) ? sha256File(trainingConfigPath) : null
  );
  requireDigestMatch(
    "Distillation evidence dataset.manifestSha256",
    evidence.dataset?.manifestSha256,
    existsSync(datasetManifestPath) ? sha256File(datasetManifestPath) : null
  );
  requireDigestMatch(
    "Distillation evidence dataset.datasetContentSha256",
    evidence.dataset?.datasetContentSha256,
    datasetManifest?.datasetContentSha256
  );

  for (const split of ["train", "dev", "test"]) {
    const splitPath = resolveWorkspaceArtifact(datasetManifest?.splitFiles?.[split], `dataset.splitFiles.${split}`);
    if (splitPath && existsSync(splitPath)) {
      const splitSha256 = sha256File(splitPath);
      requireDigestMatch(`Dataset manifest sha256.${split}`, datasetManifest?.sha256?.[split], splitSha256);
      requireDigestMatch(`Distillation evidence dataset.splitSha256.${split}`, evidence.dataset?.splitSha256?.[split], splitSha256);
    } else if (splitPath) {
      failures.push(`Distillation dataset split does not exist: ${relative(root, splitPath)}.`);
    }
  }

  if (evidence.teacher?.sourceId !== "ai4bharat-indicxlit") {
    failures.push("Distillation evidence teacher.sourceId must equal ai4bharat-indicxlit.");
  }
  requireDigestMatch(
    "Distillation evidence teacher.manifestSha256",
    evidence.teacher?.manifestSha256,
    existsSync(teacherManifestPath) ? sha256File(teacherManifestPath) : null
  );

  const teacherArtifactPath = resolveWorkspaceArtifact(evidence.teacher?.artifactPath, "teacher.artifactPath");
  const manifestTeacherArtifactPath = teacherManifest?.archive?.path;
  if (normalizeRepoPath(evidence.teacher?.artifactPath) !== normalizeRepoPath(manifestTeacherArtifactPath)) {
    failures.push("Distillation evidence teacher.artifactPath must match the downloaded teacher manifest archive path.");
  }
  if (teacherArtifactPath && existsSync(teacherArtifactPath)) {
    const teacherArtifactSha256 = sha256File(teacherArtifactPath);
    requireDigestMatch("Distillation evidence teacher.artifactSha256", evidence.teacher?.artifactSha256, teacherArtifactSha256);
    requireDigestMatch("Downloaded teacher manifest archive.sha256", teacherManifest?.archive?.sha256, teacherArtifactSha256);
  } else if (teacherArtifactPath) {
    failures.push(`Distillation teacher artifact does not exist: ${relative(root, teacherArtifactPath)}.`);
  }

  const supervisionPath = resolveWorkspaceArtifact(evidence.teacherSupervision?.path, "teacherSupervision.path");
  if (supervisionPath && existsSync(supervisionPath)) {
    requireDigestMatch(
      "Distillation evidence teacherSupervision.sha256",
      evidence.teacherSupervision?.sha256,
      sha256File(supervisionPath)
    );
  } else if (supervisionPath) {
    failures.push(`Distillation teacher-supervision artifact does not exist: ${relative(root, supervisionPath)}.`);
  }
  if (!Number.isSafeInteger(evidence.teacherSupervision?.rowCount) || evidence.teacherSupervision.rowCount <= 0) {
    failures.push("Distillation evidence teacherSupervision.rowCount must be a positive safe integer.");
  } else if (supervisionPath && existsSync(supervisionPath)) {
    const actualRows = countNonEmptyLines(supervisionPath);
    if (evidence.teacherSupervision.rowCount !== actualRows) {
      failures.push(`Distillation evidence teacherSupervision.rowCount does not match the artifact; expected ${actualRows}.`);
    }
  }

  const configuredCheckpointPath = trainingConfig?.export?.sourceCheckpoint;
  if (normalizeRepoPath(evidence.student?.checkpointPath) !== normalizeRepoPath(configuredCheckpointPath)) {
    failures.push("Distillation evidence student.checkpointPath must match export.sourceCheckpoint in the training config.");
  }
  const studentCheckpointPath = resolveWorkspaceArtifact(evidence.student?.checkpointPath, "student.checkpointPath");
  if (studentCheckpointPath && existsSync(studentCheckpointPath)) {
    requireDigestMatch(
      "Distillation evidence student.checkpointSha256",
      evidence.student?.checkpointSha256,
      sha256File(studentCheckpointPath)
    );
  } else if (studentCheckpointPath) {
    failures.push(`Distilled student checkpoint does not exist: ${relative(root, studentCheckpointPath)}.`);
  }
}

function parseArgs(argv) {
  const map = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1]?.startsWith("--") ? "1" : argv[index + 1] ?? "1";
    map.set(key, value);
    if (value !== "1") index += 1;
  }
  return map;
}

function normalizeRepoPath(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : null;
}

function resolveWorkspaceArtifact(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value)) {
    failures.push(`Distillation evidence ${label} must be a non-empty repository-relative path.`);
    return null;
  }

  const artifactPath = resolve(root, value);
  const relation = relative(root, artifactPath);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    failures.push(`Distillation evidence ${label} must remain inside the repository.`);
    return null;
  }
  return artifactPath;
}

function requireDigestMatch(label, recorded, actual) {
  if (typeof recorded !== "string" || !/^[a-f0-9]{64}$/u.test(recorded)) {
    failures.push(`${label} must be a lowercase SHA-256 digest.`);
    return;
  }
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/u.test(actual)) {
    failures.push(`${label} cannot be verified because the bound artifact has no valid SHA-256 digest.`);
    return;
  }
  if (recorded !== actual) failures.push(`${label} does not match the bound artifact.`);
}

function readJsonIfExists(path, label) {
  const evidence = inspectFileIfExists(path, label, MAX_JSON_BYTES, true);
  if (!evidence) return null;
  try {
    return JSON.parse(evidence.contents.toString("utf8"));
  } catch (error) {
    failures.push(`Invalid ${label} JSON at ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function sha256File(path) {
  return inspectFileIfExists(path, `Bound artifact ${relative(root, path)}`, MAX_BOUND_ARTIFACT_BYTES)?.sha256 ?? null;
}

function countNonEmptyLines(path) {
  const evidence = inspectFileIfExists(
    path,
    `Teacher supervision ${relative(root, path)}`,
    MAX_SUPERVISION_BYTES,
    true
  );
  if (!evidence) return 0;
  let rows = 0;
  let lineHasContent = false;
  for (const byte of evidence.contents) {
    if (byte === 0x0a) {
      if (lineHasContent) rows += 1;
      lineHasContent = false;
    } else if (byte !== 0x09 && byte !== 0x0d && byte !== 0x20) {
      lineHasContent = true;
    }
  }
  if (lineHasContent) rows += 1;
  return rows;
}

function inspectFileIfExists(path, label, maxBytes, includeContents = false) {
  if (!existsSync(path)) return null;
  const key = `${resolve(path)}\0${maxBytes}\0${includeContents}`;
  if (fileEvidenceCache.has(key)) return fileEvidenceCache.get(key);
  try {
    const evidence = inspectContainedRegularFile(root, path, { label, maxBytes, includeContents });
    fileEvidenceCache.set(key, evidence);
    return evidence;
  } catch (error) {
    failures.push(`Unsafe distillation artifact: ${error instanceof Error ? error.message : String(error)}`);
    fileEvidenceCache.set(key, null);
    return null;
  }
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-distillation-plan.mjs",
    suite: "neural-distillation-plan",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
