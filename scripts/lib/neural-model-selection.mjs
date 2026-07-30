import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

export const NEURAL_SELECTION_ALGORITHM = Object.freeze({
  id: "lekh-neural-production-selection-v1",
  minimumCandidates: 2,
  eligibility: Object.freeze([
    "immutable candidate export passed",
    "locked Lekh gold evaluation passed production thresholds",
    "locked official Aksharantar benchmark quality gate passed",
    "packaged full-candidate p99 latency is below 50 ms",
    "Apple Silicon Neural Engine placement evidence passed"
  ]),
  ranking: Object.freeze([
    Object.freeze({
      field: "officialOverallTop1Accuracy",
      order: "descending"
    }),
    Object.freeze({
      field: "officialNativeTop1Accuracy",
      order: "descending"
    }),
    Object.freeze({
      field: "officialNameTop1Accuracy",
      order: "descending"
    }),
    Object.freeze({
      field: "officialOverallTop3Accuracy",
      order: "descending"
    }),
    Object.freeze({
      field: "goldTailTop1Accuracy",
      order: "descending"
    }),
    Object.freeze({
      field: "latencyP99Ms",
      order: "ascending"
    }),
    Object.freeze({
      field: "compiledBytes",
      order: "ascending"
    }),
    Object.freeze({
      field: "artifactSetSha256",
      order: "ascending"
    })
  ])
});

export class NeuralModelSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "NeuralModelSelectionError";
  }
}

/**
 * Build the immutable decision record used by the promotion publisher.
 *
 * Candidate objects must already have been constructed from verified files by
 * the CLI. This function deliberately validates the complete portable record
 * again so callers cannot bypass ranking or comparability rules.
 */
export function buildNeuralSelectionReport(options) {
  const candidates = validateCandidates(options?.candidates);
  const comparableBindings = sharedComparableBindings(candidates);
  const ranked = [...candidates].sort(compareCandidates);
  const winner = ranked[0];
  const generatedAt = requireTimestamp(
    options?.generatedAt ?? new Date().toISOString(),
    "generatedAt"
  );
  const selectionIdentity = selectionIdentityFor({
    candidates,
    comparableBindings,
    winnerCandidateId: winner.candidateId
  });
  const selectionId = sha256CanonicalJson(selectionIdentity);

  return deepFreeze({
    schemaVersion: 2,
    status: "passed-neural-model-selection",
    generatedAt,
    suite: "neural-model-selection",
    algorithm: structuredClone(NEURAL_SELECTION_ALGORITHM),
    selectionId,
    comparableBindings,
    candidates: candidates
      .map((candidate) => structuredClone(candidate))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    ranking: ranked.map((candidate, index) => ({
      rank: index + 1,
      candidateId: candidate.candidateId
    })),
    winner: structuredClone(winner)
  });
}

/**
 * Recompute every deterministic part of a persisted selection report.
 * Returns the selected candidate only after the report proves self-consistent.
 */
export function validateNeuralSelectionReport(report) {
  requireRecord(report, "Selection report");
  if (report.schemaVersion !== 2 ||
      report.status !== "passed-neural-model-selection" ||
      report.suite !== "neural-model-selection") {
    fail("Selection report has an unsupported schema, suite, or status.");
  }
  requireTimestamp(report.generatedAt, "Selection report generatedAt");
  if (canonicalJson(report.algorithm) !== canonicalJson(NEURAL_SELECTION_ALGORITHM)) {
    fail("Selection report algorithm differs from the frozen production selector.");
  }
  const rebuilt = buildNeuralSelectionReport({
    candidates: report.candidates,
    generatedAt: report.generatedAt
  });
  if (report.selectionId !== rebuilt.selectionId) {
    fail("Selection report selectionId does not match its canonical evidence.");
  }
  if (canonicalJson(report.comparableBindings) !==
      canonicalJson(rebuilt.comparableBindings)) {
    fail("Selection report comparable bindings were altered.");
  }
  if (canonicalJson(report.ranking) !== canonicalJson(rebuilt.ranking)) {
    fail("Selection report ranking was altered or does not follow the frozen algorithm.");
  }
  if (canonicalJson(report.winner) !== canonicalJson(rebuilt.winner)) {
    fail("Selection report winner is not the deterministic winner.");
  }
  return deepFreeze({
    selectionId: rebuilt.selectionId,
    winner: structuredClone(rebuilt.winner),
    candidates: structuredClone(rebuilt.candidates),
    comparableBindings: structuredClone(rebuilt.comparableBindings)
  });
}

export function compareNeuralCandidates(left, right) {
  validateCandidate(left, "left candidate");
  validateCandidate(right, "right candidate");
  return compareCandidates(left, right);
}

export function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateCandidates(value) {
  if (!Array.isArray(value) ||
      value.length < NEURAL_SELECTION_ALGORITHM.minimumCandidates) {
    fail(
      `Production selection requires at least ` +
      `${NEURAL_SELECTION_ALGORITHM.minimumCandidates} independently trained candidates.`
    );
  }
  const candidates = value.map((candidate, index) =>
    validateCandidate(candidate, `candidates[${index}]`)
  );
  const candidateIds = new Set();
  const artifactSets = new Set();
  const exportRuns = new Set();
  const trainingRuns = new Set();
  const sourceCheckpoints = new Set();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId)) {
      fail(`Duplicate selection candidateId: ${candidate.candidateId}.`);
    }
    if (artifactSets.has(candidate.identity.artifactSetSha256)) {
      fail(
        `Candidates must represent distinct compiled artifact sets; duplicate ` +
        `${candidate.identity.artifactSetSha256}.`
      );
    }
    if (exportRuns.has(candidate.identity.exportRunId)) {
      fail(
        `Candidates must have distinct exportRunId values; duplicate ` +
        `${candidate.identity.exportRunId}.`
      );
    }
    if (trainingRuns.has(candidate.identity.trainingRunId)) {
      fail(
        `Candidates must have distinct trainingRunId values; duplicate ` +
        `${candidate.identity.trainingRunId}.`
      );
    }
    if (sourceCheckpoints.has(candidate.identity.sourceCheckpointSha256)) {
      fail(
        `Candidates must represent distinct source checkpoints; duplicate ` +
        `${candidate.identity.sourceCheckpointSha256}.`
      );
    }
    candidateIds.add(candidate.candidateId);
    artifactSets.add(candidate.identity.artifactSetSha256);
    exportRuns.add(candidate.identity.exportRunId);
    trainingRuns.add(candidate.identity.trainingRunId);
    sourceCheckpoints.add(candidate.identity.sourceCheckpointSha256);
  }
  return candidates;
}

function validateCandidate(value, label) {
  requireRecord(value, label);
  requireExactKeys(value, [
    "architecture",
    "bindings",
    "candidateId",
    "candidateRoot",
    "eligible",
    "evidence",
    "identity",
    "metrics",
    "modelId"
  ], label);
  if (typeof value.candidateId !== "string" ||
      !CANDIDATE_ID_PATTERN.test(value.candidateId)) {
    fail(`${label}.candidateId is invalid.`);
  }
  for (const field of ["candidateRoot", "modelId", "architecture"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      fail(`${label}.${field} must be a non-empty string.`);
    }
  }
  if (value.eligible !== true) {
    fail(`${label} is not eligible for production selection.`);
  }

  requireRecord(value.identity, `${label}.identity`);
  requireExactKeys(value.identity, [
    "artifactSetSha256",
    "effectiveTrainingConfigSha256",
    "exportReportSha256",
    "exportRunId",
    "manifestSha256",
    "sourceCheckpointSha256",
    "trainingReportSha256",
    "trainingRunId",
    "trainingSeed",
    "vocabSha256"
  ], `${label}.identity`);
  requireRunId(value.identity.trainingRunId, `${label}.identity.trainingRunId`);
  requireRunId(value.identity.exportRunId, `${label}.identity.exportRunId`);
  if (value.identity.trainingRunId === value.identity.exportRunId) {
    fail(`${label} training and export runs must be distinct.`);
  }
  for (const field of [
    "artifactSetSha256",
    "effectiveTrainingConfigSha256",
    "exportReportSha256",
    "manifestSha256",
    "sourceCheckpointSha256",
    "trainingReportSha256",
    "vocabSha256"
  ]) {
    requireSha256(value.identity[field], `${label}.identity.${field}`);
  }
  if (!Number.isSafeInteger(value.identity.trainingSeed) ||
      value.identity.trainingSeed < 0 ||
      value.identity.trainingSeed > 0xffff_ffff) {
    fail(`${label}.identity.trainingSeed must be a 32-bit unsigned integer.`);
  }

  requireRecord(value.evidence, `${label}.evidence`);
  requireExactKeys(value.evidence, [
    "benchmarkManifest",
    "benchmarkReport",
    "comparisonPredictions",
    "comparisonReport",
    "checkpoint",
    "datasetManifest",
    "evaluationReport",
    "exportReport",
    "goldManifest",
    "manifest",
    "specification",
    "trainingReport"
  ], `${label}.evidence`);
  for (const [name, evidence] of Object.entries(value.evidence)) {
    requireRecord(evidence, `${label}.evidence.${name}`);
    requireExactKeys(evidence, ["path", "sha256"], `${label}.evidence.${name}`);
    if (typeof evidence.path !== "string" || evidence.path.length === 0) {
      fail(`${label}.evidence.${name}.path must be a non-empty portable path.`);
    }
    requireSha256(evidence.sha256, `${label}.evidence.${name}.sha256`);
  }
  if (value.evidence.manifest.sha256 !== value.identity.manifestSha256 ||
      value.evidence.exportReport.sha256 !== value.identity.exportReportSha256) {
    fail(`${label} evidence does not match its candidate identity.`);
  }

  requireRecord(value.bindings, `${label}.bindings`);
  requireExactKeys(value.bindings, [
    "benchmarkCorpusSha256",
    "benchmarkManifestSha256",
    "datasetContentSha256",
    "datasetManifestSha256",
    "goldCorpusSha256",
    "goldManifestSha256"
  ], `${label}.bindings`);
  for (const [name, digest] of Object.entries(value.bindings)) {
    requireSha256(digest, `${label}.bindings.${name}`);
  }

  requireRecord(value.metrics, `${label}.metrics`);
  requireExactKeys(value.metrics, [
    "compiledBytes",
    "goldTailTop1Accuracy",
    "goldTailTop3Accuracy",
    "latencyP99Ms",
    "officialNameTop1Accuracy",
    "officialNativeTop1Accuracy",
    "officialOverallTop1Accuracy",
    "officialOverallTop3Accuracy"
  ], `${label}.metrics`);
  for (const field of [
    "goldTailTop1Accuracy",
    "goldTailTop3Accuracy",
    "officialNameTop1Accuracy",
    "officialNativeTop1Accuracy",
    "officialOverallTop1Accuracy",
    "officialOverallTop3Accuracy"
  ]) {
    requireRate(value.metrics[field], `${label}.metrics.${field}`);
  }
  if (value.metrics.goldTailTop1Accuracy > value.metrics.goldTailTop3Accuracy ||
      value.metrics.officialOverallTop1Accuracy >
        value.metrics.officialOverallTop3Accuracy) {
    fail(`${label} top-1 accuracy cannot exceed top-3 accuracy.`);
  }
  if (!Number.isFinite(value.metrics.latencyP99Ms) ||
      value.metrics.latencyP99Ms < 0 ||
      value.metrics.latencyP99Ms >= 50) {
    fail(`${label}.metrics.latencyP99Ms must be finite and below 50 ms.`);
  }
  if (!Number.isSafeInteger(value.metrics.compiledBytes) ||
      value.metrics.compiledBytes < 1 ||
      value.metrics.compiledBytes > 64 * 1024 * 1024) {
    fail(`${label}.metrics.compiledBytes is outside the supported artifact budget.`);
  }
  return deepFreeze(structuredClone(value));
}

function sharedComparableBindings(candidates) {
  const first = candidates[0].bindings;
  for (const candidate of candidates.slice(1)) {
    if (canonicalJson(candidate.bindings) !== canonicalJson(first)) {
      fail(
        `Candidate ${candidate.candidateId} was not evaluated against the exact ` +
        `same dataset, Lekh gold corpus, and official benchmark bytes.`
      );
    }
  }
  return deepFreeze(structuredClone(first));
}

function compareCandidates(left, right) {
  for (const rule of NEURAL_SELECTION_ALGORITHM.ranking) {
    const leftValue = rule.field === "artifactSetSha256"
      ? left.identity.artifactSetSha256
      : left.metrics[rule.field];
    const rightValue = rule.field === "artifactSetSha256"
      ? right.identity.artifactSetSha256
      : right.metrics[rule.field];
    if (leftValue === rightValue) continue;
    if (typeof leftValue === "string") {
      return rule.order === "ascending"
        ? leftValue.localeCompare(rightValue)
        : rightValue.localeCompare(leftValue);
    }
    return rule.order === "ascending"
      ? leftValue - rightValue
      : rightValue - leftValue;
  }
  return left.candidateId.localeCompare(right.candidateId);
}

function selectionIdentityFor({
  candidates,
  comparableBindings,
  winnerCandidateId
}) {
  return {
    schemaVersion: 2,
    algorithm: structuredClone(NEURAL_SELECTION_ALGORITHM),
    comparableBindings: structuredClone(comparableBindings),
    candidates: candidates
      .map((candidate) => structuredClone(candidate))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    winnerCandidateId
  };
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
  if (canonicalJson(observed) !== canonicalJson(wanted)) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireRunId(value, label) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    fail(`${label} must be a 32-character lowercase hexadecimal run ID.`);
  }
  return value;
}

function requireRate(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite rate from 0 through 1.`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a canonical UTC timestamp.`);
  }
  return value;
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
  if (typeof value === "number" && !Number.isFinite(value)) {
    fail("Canonical selection evidence cannot contain non-finite numbers.");
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(message) {
  throw new NeuralModelSelectionError(message);
}
