import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync
} from "node:fs";
import { extname, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const HUMAN_AUTHORITY_ATTESTATION =
  "I reviewed the listed artifact versions within my stated competence and approve the recorded decisions for release.";

const approvalKeys = Object.freeze([
  "attestations",
  "defects",
  "domains",
  "policySha256",
  "recordType",
  "releaseDecision",
  "reviewId",
  "reviewedAt",
  "reviewers",
  "schemaVersion",
  "sourceRevision",
  "sourceTree"
].sort());
const reviewerKeys = Object.freeze([
  "affiliation",
  "conflictDisclosure",
  "experience",
  "id",
  "name",
  "relationship",
  "roles"
].sort());
const domainKeys = Object.freeze([
  "artifacts",
  "coverage",
  "decision",
  "id",
  "notes",
  "reviewerIds"
].sort());
const artifactKeys = Object.freeze(["itemCount", "path", "sha256"].sort());
const coverageKeys = Object.freeze([
  "acceptedItems",
  "rejectedItems",
  "reviewedItems",
  "totalItems",
  "unresolvedItems"
].sort());
const defectKeys = Object.freeze([
  "description",
  "domain",
  "id",
  "resolution",
  "severity",
  "status"
].sort());
const attestationKeys = Object.freeze([
  "attestedAt",
  "decision",
  "domainIds",
  "reviewerId",
  "statement"
].sort());
const allowedRoles = Object.freeze([
  "accessibility-reviewer",
  "internal-product-owner",
  "nepali-linguist",
  "traditional-typist"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function isShortText(value, maximum = 1000, minimum = 1) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function isHash(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNamedPerson(value) {
  return isShortText(value, 120, 2) && value.trim() === value &&
    !/^(?:example|n\/?a|placeholder|project-curation|tbd|todo|unknown)$/iu.test(value);
}

function isIsoDate(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() + 5 * 60 * 1000;
}

function isSortedUnique(values) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string") &&
    new Set(values).size === values.length &&
    JSON.stringify(values) === JSON.stringify([...values].sort());
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateHumanAuthorityApproval(approval, context) {
  const issues = [];
  const now = context.now ?? new Date();
  const artifactCache = new Map();

  if (!exactKeys(approval, approvalKeys)) {
    issues.push("human-authority-approval.schema-invalid");
    return result();
  }
  if (approval.schemaVersion !== 1 || approval.recordType !== "lekh-human-authority-approval" ||
      !isSlug(approval.reviewId) || approval.releaseDecision !== "approved") {
    issues.push("human-authority-approval.identity-invalid");
  }
  if (!isSha256(approval.policySha256) || approval.policySha256 !== context.policySha256) {
    issues.push("human-authority-approval.policy-identity-invalid");
  }
  if (!isHash(approval.sourceRevision) || !isHash(approval.sourceTree) ||
      approval.sourceRevision !== context.sourceRevision || approval.sourceTree !== context.sourceTree) {
    issues.push("human-authority-approval.source-identity-invalid");
  }
  if (!isIsoDate(approval.reviewedAt, now)) {
    issues.push("human-authority-approval.reviewed-at-invalid");
  }

  const reviewers = validateReviewers(approval.reviewers, issues);
  const domainAssignments = validateDomains(
    approval.domains,
    context.policy,
    context.root,
    reviewers,
    artifactCache,
    issues
  );
  validateDefects(approval.defects, context.policy, issues);
  validateAttestations(approval.attestations, reviewers, domainAssignments, now, issues);

  return result();

  function result() {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...new Set(issues)].sort()),
      artifactCount: artifactCache.size,
      reviewerCount: Array.isArray(approval?.reviewers) ? approval.reviewers.length : 0,
      domainCount: Array.isArray(approval?.domains) ? approval.domains.length : 0
    });
  }
}

export function inspectHumanAuthorityArtifact(root, path) {
  const absolute = resolve(root, path);
  const metadata = lstatSync(absolute);
  const canonicalRoot = realpathSync(resolve(root));
  const canonicalPath = realpathSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
      metadata.size > 1024 * 1024 * 1024 || !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("artifact-file-invalid");
  }

  const extension = extname(path);
  if (extension === ".json") {
    if (metadata.size > 64 * 1024 * 1024) throw new Error("artifact-json-too-large");
    const bytes = readFileSync(canonicalPath);
    const parsed = JSON.parse(bytes.toString("utf8"));
    const itemCount = jsonItemCount(parsed);
    if (itemCount < 1) throw new Error("artifact-empty");
    return Object.freeze({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      itemCount,
      sizeBytes: metadata.size
    });
  }
  if (extension !== ".jsonl" && extension !== ".tsv") {
    throw new Error("artifact-format-invalid");
  }

  const streamed = streamDigestAndLineCount(canonicalPath);
  const itemCount = extension === ".tsv" ? Math.max(0, streamed.nonEmptyLines - 1) : streamed.nonEmptyLines;
  if (itemCount < 1) throw new Error("artifact-empty");
  return Object.freeze({ sha256: streamed.sha256, itemCount, sizeBytes: metadata.size });
}

function validateReviewers(values, issues) {
  const reviewers = new Map();
  if (!Array.isArray(values) || values.length < 3 || values.length > 30 ||
      !values.every((reviewer) => exactKeys(reviewer, reviewerKeys)) ||
      new Set(values.map(({ id }) => id)).size !== values.length) {
    issues.push("human-authority-approval.reviewers-invalid");
    return reviewers;
  }
  for (const reviewer of values) {
    const rolesValid = isSortedUnique(reviewer.roles) &&
      reviewer.roles.every((role) => allowedRoles.includes(role));
    const internalRoleValid = reviewer.roles.includes("internal-product-owner")
      ? reviewer.relationship === "internal"
      : true;
    if (!isSlug(reviewer.id) || !isNamedPerson(reviewer.name) ||
        !isShortText(reviewer.affiliation, 180) ||
        !["external", "internal"].includes(reviewer.relationship) || !rolesValid ||
        !isShortText(reviewer.experience, 1000, 20) ||
        !isShortText(reviewer.conflictDisclosure, 500) || !internalRoleValid) {
      issues.push(`human-authority-approval.reviewer-invalid:${reviewer.id ?? "unknown"}`);
      continue;
    }
    reviewers.set(reviewer.id, reviewer);
  }
  return reviewers;
}

function validateDomains(values, policy, root, reviewers, artifactCache, issues) {
  const assignments = new Map();
  const expectedIds = policy.domains.map(({ id }) => id);
  if (!Array.isArray(values) || values.length !== expectedIds.length || !values.every(isRecord) ||
      JSON.stringify(values.map(({ id }) => id)) !== JSON.stringify(expectedIds)) {
    issues.push("human-authority-approval.domains-invalid");
    return assignments;
  }
  for (const domainApproval of values) {
    const domainPolicy = policy.domains.find(({ id }) => id === domainApproval.id);
    if (!exactKeys(domainApproval, domainKeys) || domainApproval.decision !== "approved" ||
        !isShortText(domainApproval.notes, 2000, 20)) {
      issues.push(`human-authority-approval.domain-invalid:${domainApproval.id}`);
      continue;
    }
    const reviewerIds = domainApproval.reviewerIds;
    const assignedReviewers = Array.isArray(reviewerIds)
      ? reviewerIds.map((id) => reviewers.get(id)).filter(Boolean)
      : [];
    if (!isSortedUnique(reviewerIds) || reviewerIds.length < domainPolicy.minimumReviewers ||
        assignedReviewers.length !== reviewerIds.length ||
        assignedReviewers.filter(({ relationship }) => relationship === "external").length <
          domainPolicy.minimumExternalReviewers) {
      issues.push(`human-authority-approval.domain-reviewers-invalid:${domainApproval.id}`);
    }
    for (const [role, requiredCount] of Object.entries(domainPolicy.requiredRoleCounts)) {
      const actualCount = assignedReviewers.filter(({ roles }) => roles.includes(role)).length;
      if (actualCount < requiredCount) {
        issues.push(`human-authority-approval.domain-role-missing:${domainApproval.id}:${role}`);
      }
    }
    assignments.set(domainApproval.id, new Set(reviewerIds ?? []));
    validateDomainArtifacts(domainApproval, domainPolicy, root, artifactCache, issues);
    validateCoverage(domainApproval, issues);
  }
  return assignments;
}

function validateDomainArtifacts(domainApproval, domainPolicy, root, artifactCache, issues) {
  const artifacts = domainApproval.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== domainPolicy.requiredArtifacts.length ||
      !artifacts.every((artifact) => exactKeys(artifact, artifactKeys)) ||
      JSON.stringify(artifacts.map(({ path }) => path)) !==
        JSON.stringify(domainPolicy.requiredArtifacts)) {
    issues.push(`human-authority-approval.domain-artifacts-invalid:${domainApproval.id}`);
    return;
  }
  for (const artifact of artifacts) {
    let inspected = artifactCache.get(artifact.path);
    if (!inspected) {
      try {
        inspected = inspectHumanAuthorityArtifact(root, artifact.path);
        artifactCache.set(artifact.path, inspected);
      } catch {
        issues.push(`human-authority-approval.artifact-file-invalid:${artifact.path}`);
        continue;
      }
    }
    if (!isSha256(artifact.sha256) || artifact.sha256 !== inspected.sha256 ||
        !safeCount(artifact.itemCount) || artifact.itemCount !== inspected.itemCount) {
      issues.push(`human-authority-approval.artifact-identity-invalid:${artifact.path}`);
    }
  }
}

function validateCoverage(domainApproval, issues) {
  const coverage = domainApproval.coverage;
  const artifacts = Array.isArray(domainApproval.artifacts) ? domainApproval.artifacts : [];
  const declaredTotal = artifacts.reduce((sum, artifact) =>
    sum + (safeCount(artifact?.itemCount) ? artifact.itemCount : 0), 0
  );
  if (!exactKeys(coverage, coverageKeys) || Object.values(coverage).some((count) => !safeCount(count)) ||
      coverage.totalItems < 1 || coverage.totalItems !== declaredTotal ||
      coverage.reviewedItems !== coverage.totalItems || coverage.unresolvedItems !== 0 ||
      coverage.acceptedItems + coverage.rejectedItems !== coverage.reviewedItems) {
    issues.push(`human-authority-approval.coverage-invalid:${domainApproval.id}`);
  }
}

function validateDefects(defects, policy, issues) {
  if (!Array.isArray(defects) || defects.length > 500 || !defects.every((defect) =>
    exactKeys(defect, defectKeys)) ||
    new Set(defects.map(({ id }) => id)).size !== defects.length) {
    issues.push("human-authority-approval.defects-invalid");
    return;
  }
  const domainIds = new Set(policy.domains.map(({ id }) => id));
  const openCounts = { P0: 0, P1: 0 };
  for (const defect of defects) {
    if (!isSlug(defect.id) || !domainIds.has(defect.domain) ||
        !["P0", "P1", "P2", "P3"].includes(defect.severity) ||
        !["open", "resolved"].includes(defect.status) ||
        !isShortText(defect.description, 1000, 10) ||
        !isShortText(defect.resolution, 1000, 5)) {
      issues.push(`human-authority-approval.defect-invalid:${defect.id ?? "unknown"}`);
      continue;
    }
    if (defect.status === "open" && defect.severity in openCounts) openCounts[defect.severity] += 1;
  }
  if (openCounts.P0 > policy.maximumOpenDefects.P0 || openCounts.P1 > policy.maximumOpenDefects.P1) {
    issues.push("human-authority-approval.critical-defect-open");
  }
}

function validateAttestations(values, reviewers, assignments, now, issues) {
  if (!Array.isArray(values) || values.length !== reviewers.size ||
      !values.every((attestation) => exactKeys(attestation, attestationKeys)) ||
      new Set(values.map(({ reviewerId }) => reviewerId)).size !== values.length) {
    issues.push("human-authority-approval.attestations-invalid");
    return;
  }
  for (const attestation of values) {
    const assignedDomains = [...assignments.entries()]
      .filter(([, reviewerIds]) => reviewerIds.has(attestation.reviewerId))
      .map(([domainId]) => domainId)
      .sort();
    if (!reviewers.has(attestation.reviewerId) || !isSortedUnique(attestation.domainIds) ||
        JSON.stringify(attestation.domainIds) !== JSON.stringify(assignedDomains) ||
        attestation.decision !== "approved" || !isIsoDate(attestation.attestedAt, now) ||
        attestation.statement !== HUMAN_AUTHORITY_ATTESTATION) {
      issues.push(`human-authority-approval.attestation-invalid:${attestation.reviewerId ?? "unknown"}`);
    }
  }
}

function streamDigestAndLineCount(path) {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let descriptor;
  let tail = "";
  let nonEmptyLines = 0;
  try {
    descriptor = openSync(path, "r");
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const lines = `${tail}${decoder.write(chunk)}`.split(/\r?\n/u);
      tail = lines.pop() ?? "";
      nonEmptyLines += lines.filter((line) => line.trim().length > 0).length;
    }
    tail += decoder.end();
    if (tail.trim().length > 0) nonEmptyLines += 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), nonEmptyLines };
}

function jsonItemCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!isRecord(value)) return 0;
  const topLevelArrays = Object.values(value).filter(Array.isArray);
  if (topLevelArrays.length > 0) {
    return topLevelArrays.reduce((sum, entries) => sum + entries.length, 0);
  }
  return Object.keys(value).length;
}
