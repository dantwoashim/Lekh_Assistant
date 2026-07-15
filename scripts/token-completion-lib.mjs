import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const COMPLETION_POLICY = Object.freeze({
  minimumPrefixLength: 4,
  maximumSourceSuffixLength: 12,
  maximumResultsPerPrefix: 3,
  minimumWinnerMargin: 40,
  explicitAcceptanceOnly: true,
  singleTokenOnly: true,
  namesAllowed: false,
  phrasesAllowed: false
});

const ROMAN_TOKEN = /^[a-z][a-z'-]*$/;
const DEVANAGARI_TOKEN = /^\p{Script=Devanagari}+$/u;
const ELIGIBLE_SOURCE_ID = "lekh-repository-curated-completion-v1";
const ELIGIBLE_LICENSE = "MIT";
const ELIGIBLE_REVIEW_TIER = "repository-curated-regression";
const PROTECTED_PREFIXES = new Set([
  "api", "email", "github", "gmail", "http", "https", "icloud", "login",
  "macos", "npm", "openai", "otp", "password", "pdf", "pin", "readme",
  "swiftui", "url", "username", "wifi"
]);

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function normalizeRomanized(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'")
    .trim();
}

export function normalizeTarget(value) {
  return String(value ?? "").normalize("NFC").trim();
}

export function buildCompletionArtifact({ seeds, registry, evaluation }) {
  const failures = [];
  if (seeds?.schemaVersion !== 1) failures.push("Seed schemaVersion must be 1.");
  if (registry?.schemaVersion !== 1) failures.push("Source registry schemaVersion must be 1.");
  if (evaluation?.schemaVersion !== 1) failures.push("Evaluation schemaVersion must be 1.");
  if (seeds?.acceptancePolicy !== "explicit-only") failures.push("Completion seeds must be explicit-only.");

  const eligibleSources = new Map(
    (registry?.sources ?? [])
      .filter((source) => source.runtimeEligible === true && source.redistributionAllowed === true)
      .map((source) => [source.id, source])
  );
  const source = eligibleSources.get(seeds?.sourceId);
  if (!source) failures.push(`Seed source ${seeds?.sourceId ?? "missing"} is not runtime eligible.`);
  if (source?.id !== ELIGIBLE_SOURCE_ID || source?.origin !== "repository-authored") {
    failures.push("Completion source must be the repository-authored v1 allowlist.");
  }
  if (source?.path !== "data/completion/v1/token-completion-seeds.json") {
    failures.push("Completion source registry path must identify the reviewed seed artifact.");
  }
  if (source?.license !== ELIGIBLE_LICENSE || source?.reviewTier !== ELIGIBLE_REVIEW_TIER) {
    failures.push("Completion source license or review tier is missing or unexpected.");
  }
  if (source?.allowedUse !== "explicit-single-token-completion") {
    failures.push("Seed source allowedUse must be explicit-single-token-completion.");
  }
  if (source?.humanRated === true && source?.reviewTier === "repository-curated-regression") {
    failures.push("Repository regression data must not claim human-rated status.");
  }

  const rowIds = new Set();
  const byPrefix = new Map();
  for (const [index, inputRow] of (seeds?.rows ?? []).entries()) {
    const location = `rows[${index}]`;
    const id = String(inputRow?.id ?? "");
    const fullSource = normalizeRomanized(inputRow?.source);
    const target = normalizeTarget(inputRow?.target);
    const rankScore = Number(inputRow?.rankScore);
    const prefixes = Array.isArray(inputRow?.prefixes) ? inputRow.prefixes : [];

    if (!id || rowIds.has(id)) failures.push(`${location} has a missing or duplicate id.`);
    rowIds.add(id);
    if (inputRow?.kind !== "word") failures.push(`${location} kind must be word.`);
    if (!ROMAN_TOKEN.test(fullSource)) failures.push(`${location} source is not a normalized Roman token.`);
    if (inputRow?.source !== fullSource) failures.push(`${location} source is not canonically normalized.`);
    if (!DEVANAGARI_TOKEN.test(target)) failures.push(`${location} target is not a Devanagari-only token.`);
    if (inputRow?.target !== target) failures.push(`${location} target is not canonically normalized.`);
    if (!Number.isInteger(rankScore) || rankScore < 1 || rankScore > 1000) {
      failures.push(`${location} rankScore must be an integer in 1...1000.`);
    }
    if (prefixes.length === 0) failures.push(`${location} must declare at least one reviewed prefix.`);

    for (const rawPrefix of prefixes) {
      const prefix = normalizeRomanized(rawPrefix);
      const suffixLength = fullSource.length - prefix.length;
      if (!ROMAN_TOKEN.test(prefix)) failures.push(`${location} prefix ${JSON.stringify(rawPrefix)} is invalid.`);
      if (prefix !== rawPrefix) failures.push(`${location} prefix ${JSON.stringify(rawPrefix)} is not normalized.`);
      if (prefix.length < COMPLETION_POLICY.minimumPrefixLength) failures.push(`${location} prefix ${prefix} is too short.`);
      if (!fullSource.startsWith(prefix) || fullSource === prefix) failures.push(`${location} prefix ${prefix} does not strictly prefix ${fullSource}.`);
      if (suffixLength < 1 || suffixLength > COMPLETION_POLICY.maximumSourceSuffixLength) {
        failures.push(`${location} completion suffix for ${prefix} is outside the bounded length policy.`);
      }
      if (isProtectedToken(prefix) || isSensitiveLike(prefix)) failures.push(`${location} prefix ${prefix} is protected or sensitive-like.`);

      const candidate = {
        source: fullSource,
        target,
        score: rankScore - suffixLength,
        seedId: id,
        sourceId: source?.id ?? seeds?.sourceId ?? "missing",
        license: source?.license ?? "missing",
        reviewTier: source?.reviewTier ?? "missing"
      };
      const key = `${candidate.source}\0${candidate.target}`;
      const candidates = byPrefix.get(prefix) ?? new Map();
      const previous = candidates.get(key);
      if (!previous || candidate.score > previous.score) candidates.set(key, candidate);
      byPrefix.set(prefix, candidates);
    }
  }

  const entries = [];
  for (const prefix of [...byPrefix.keys()].sort()) {
    const candidates = [...byPrefix.get(prefix).values()].sort(compareCandidates);
    if (candidates.length > COMPLETION_POLICY.maximumResultsPerPrefix) {
      failures.push(`Prefix ${prefix} has more than ${COMPLETION_POLICY.maximumResultsPerPrefix} candidates.`);
    }
    if (candidates.length > 1 && candidates[0].score - candidates[1].score < COMPLETION_POLICY.minimumWinnerMargin) {
      failures.push(`Prefix ${prefix} has an insufficient deterministic winner margin.`);
    }
    entries.push({
      prefix,
      candidates: candidates.slice(0, COMPLETION_POLICY.maximumResultsPerPrefix)
    });
  }

  const artifact = {
    schemaVersion: 1,
    artifactId: "lekh-token-completions-v1",
    normalization: seeds?.normalization ?? "missing",
    runtimePolicy: { ...COMPLETION_POLICY },
    entries
  };
  const evaluationResult = evaluateCompletionArtifact(artifact, evaluation);
  failures.push(...evaluationResult.failures);

  return { artifact, failures, evaluation: evaluationResult };
}

export function evaluateCompletionArtifact(artifact, evaluation) {
  const byPrefix = new Map((artifact?.entries ?? []).map((entry) => [entry.prefix, entry.candidates ?? []]));
  const failures = [];
  let positiveHits = 0;
  let negativeHits = 0;
  for (const row of evaluation?.positive ?? []) {
    const top = byPrefix.get(normalizeRomanized(row.prefix))?.[0];
    if (top?.source === normalizeRomanized(row.expectedSource) && top?.target === normalizeTarget(row.expectedTarget)) {
      positiveHits += 1;
    } else {
      failures.push(`Positive regression ${row.prefix} did not resolve to ${row.expectedSource}.`);
    }
  }
  for (const row of evaluation?.negative ?? []) {
    if ((byPrefix.get(normalizeRomanized(row.prefix)) ?? []).length === 0) {
      negativeHits += 1;
    } else {
      failures.push(`Negative regression ${row.prefix} unexpectedly has a completion.`);
    }
  }
  const positiveCount = evaluation?.positive?.length ?? 0;
  const negativeCount = evaluation?.negative?.length ?? 0;
  return {
    evidenceTier: evaluation?.evidenceTier ?? "unknown",
    positiveCount,
    positiveHits,
    positiveTop1Accuracy: positiveCount === 0 ? 0 : positiveHits / positiveCount,
    negativeCount,
    negativeHits,
    negativeSuppressionRate: negativeCount === 0 ? 0 : negativeHits / negativeCount,
    failures
  };
}

export function validateArtifactShape(artifact) {
  const failures = [];
  if (artifact?.schemaVersion !== 1) failures.push("Artifact schemaVersion must be 1.");
  if (artifact?.artifactId !== "lekh-token-completions-v1") failures.push("Artifact id is invalid.");
  if (artifact?.normalization !== "nfc-lower-ascii-apostrophe-v1") failures.push("Artifact normalization contract is invalid.");
  const policy = artifact?.runtimePolicy ?? {};
  for (const [key, expected] of Object.entries(COMPLETION_POLICY)) {
    if (policy[key] !== expected) failures.push(`Runtime policy ${key} must equal ${expected}.`);
  }
  let previousPrefix = "";
  if (!Array.isArray(artifact?.entries) || artifact.entries.length > 10_000) {
    failures.push("Artifact entries must be an array with at most 10,000 prefixes.");
  }
  for (const [entryIndex, entry] of (artifact?.entries ?? []).entries()) {
    const prefix = normalizeRomanized(entry?.prefix);
    if (!prefix || prefix !== entry.prefix) failures.push(`entries[${entryIndex}] prefix is invalid.`);
    if (previousPrefix && previousPrefix >= prefix) failures.push("Artifact entries must be strictly sorted by prefix.");
    previousPrefix = prefix;
    if (!Array.isArray(entry?.candidates) || entry.candidates.length < 1 || entry.candidates.length > COMPLETION_POLICY.maximumResultsPerPrefix) {
      failures.push(`entries[${entryIndex}] has an invalid candidate count.`);
      continue;
    }
    let previousCandidate = null;
    for (const [candidateIndex, candidate] of entry.candidates.entries()) {
      const location = `entries[${entryIndex}].candidates[${candidateIndex}]`;
      if (!ROMAN_TOKEN.test(candidate?.source ?? "") || !candidate.source.startsWith(prefix) || candidate.source === prefix) {
        failures.push(`${location} source is invalid.`);
      }
      if (!DEVANAGARI_TOKEN.test(candidate?.target ?? "")) failures.push(`${location} target is invalid.`);
      if (String(candidate?.source ?? "").includes(" ") || String(candidate?.target ?? "").includes(" ")) failures.push(`${location} expands to a phrase.`);
      const suffixLength = String(candidate?.source ?? "").length - prefix.length;
      if (suffixLength < 1 || suffixLength > COMPLETION_POLICY.maximumSourceSuffixLength) failures.push(`${location} suffix length is invalid.`);
      if (!Number.isInteger(candidate?.score) || candidate.score < 1 || candidate.score > 1000) failures.push(`${location} score must be an integer in 1...1000.`);
      if (!String(candidate?.seedId ?? "").startsWith("completion-") ||
          candidate?.sourceId !== ELIGIBLE_SOURCE_ID ||
          candidate?.license !== ELIGIBLE_LICENSE ||
          candidate?.reviewTier !== ELIGIBLE_REVIEW_TIER) failures.push(`${location} provenance is incomplete or ineligible.`);
      if (previousCandidate && compareCandidates(previousCandidate, candidate) > 0) failures.push(`${location} candidate ordering is unstable.`);
      previousCandidate = candidate;
    }
    if (entry.candidates.length > 1 &&
        entry.candidates[0].score - entry.candidates[1].score < COMPLETION_POLICY.minimumWinnerMargin) {
      failures.push(`entries[${entryIndex}] winner margin is insufficient.`);
    }
  }
  return failures;
}

export function manifestFor({
  artifactBytes,
  seedsPath,
  registryPath,
  evaluationPath,
  provenancePaths,
  seedCount,
  evaluation
}) {
  const artifact = JSON.parse(artifactBytes);
  const manifestPaths = provenancePaths ?? {
    seedSet: seedsPath,
    sourceRegistry: registryPath,
    regressionEvaluation: evaluationPath
  };
  return {
    schemaVersion: 1,
    manifestId: "lekh-token-completions-v1-manifest",
    artifact: {
      path: "lekh-token-completions.v1.json",
      sha256: sha256(artifactBytes),
      bytes: Buffer.byteLength(artifactBytes),
      schemaVersion: artifact.schemaVersion,
      entryCount: artifact.entries.length,
      candidateCount: artifact.entries.reduce((sum, entry) => sum + entry.candidates.length, 0)
    },
    provenance: {
      seedSet: { path: manifestPaths.seedSet, sha256: sha256File(seedsPath) },
      sourceRegistry: { path: manifestPaths.sourceRegistry, sha256: sha256File(registryPath) },
      regressionEvaluation: {
        path: manifestPaths.regressionEvaluation,
        sha256: sha256File(evaluationPath)
      }
    },
    runtimePolicy: artifact.runtimePolicy,
    quality: {
      seedCount,
      regressionEvidenceTier: evaluation.evidenceTier,
      regressionPositiveTop1Accuracy: evaluation.positiveTop1Accuracy,
      regressionNegativeSuppressionRate: evaluation.negativeSuppressionRate,
      humanRatedHoldoutRows: 0,
      explicitSuggestionRuntimeEligible: evaluation.failures.length === 0,
      productionQualityClaimEligible: false,
      productionBlockers: [
        "No frozen native-speaker-rated completion holdout.",
        "No calibrated useful-versus-harmful suggestion threshold.",
        "No multi-day opt-in pilot acceptance and dismissal evidence."
      ]
    }
  };
}

function compareCandidates(left, right) {
  if (left.score !== right.score) return right.score - left.score;
  if (left.source !== right.source) return compareCodePoints(left.source, right.source);
  return compareCodePoints(left.target, right.target);
}

function compareCodePoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isProtectedToken(value) {
  return PROTECTED_PREFIXES.has(value) || [...PROTECTED_PREFIXES].some((token) => value.startsWith(`${token}-`));
}

function isSensitiveLike(value) {
  return value.includes("@") || /\d{4,}/.test(value) || /^(?:otp|pin|cvv|password|username)/.test(value);
}
