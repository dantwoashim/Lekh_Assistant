import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const evidenceKeys = Object.freeze([
  "artifacts",
  "defects",
  "environment",
  "generatedAt",
  "installedBuild",
  "mode",
  "operator",
  "pass",
  "recordType",
  "reviewedBy",
  "riskResults",
  "scenarioId",
  "schemaVersion",
  "sourceRevision",
  "sourceTree",
  "steps"
].sort());
const installedBuildKeys = Object.freeze([
  "artifactSha256",
  "buildVersion",
  "sourceRevision",
  "sourceTree"
].sort());
const environmentKeys = Object.freeze([
  "application",
  "architecture",
  "hardwareModel",
  "inputSourceVersion",
  "locale",
  "osFamily",
  "osVersion"
].sort());
const operatorKeys = Object.freeze(["name", "organization", "role"].sort());
const stepKeys = Object.freeze(["action", "actual", "expected", "id", "pass"].sort());
const riskResultKeys = Object.freeze(["notes", "pass", "riskCase"].sort());
const artifactKeys = Object.freeze(["kind", "path", "sha256"].sort());
const defectKeys = Object.freeze(["id", "severity", "status", "title"].sort());
const reviewerKeys = Object.freeze(["decision", "name", "reviewedAt", "role"].sort());
const reviewerRoles = Object.freeze([
  "accessibility-owner",
  "native-input-owner",
  "qa-owner",
  "security-owner"
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function isShortText(value, maximum = 500) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
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
  return isShortText(value, 120) && value.trim() === value &&
    !/^(?:example|n\/?a|placeholder|tbd|todo|unknown)$/iu.test(value);
}

function isIsoDate(value, now) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now.getTime() + 5 * 60 * 1000;
}

function uniqueBy(values, select) {
  return new Set(values.map(select)).size === values.length;
}

export function validateNativeHostRiskEvidence(evidence, context) {
  const issues = [];
  const artifactIdentities = [];
  const openDefects = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const now = context.now ?? new Date();

  if (!exactKeys(evidence, evidenceKeys)) {
    issues.push("native-risk-evidence.schema-invalid");
    return result();
  }
  if (evidence.schemaVersion !== 1 || evidence.recordType !== "lekh-native-host-risk-evidence") {
    issues.push("native-risk-evidence.identity-invalid");
  }
  if (evidence.scenarioId !== context.scenario.id) {
    issues.push("native-risk-evidence.scenario-invalid");
  }
  if (!isIsoDate(evidence.generatedAt, now)) {
    issues.push("native-risk-evidence.generated-at-invalid");
  }
  if (!isHash(evidence.sourceRevision) || !isHash(evidence.sourceTree) ||
      evidence.sourceRevision !== context.sourceRevision || evidence.sourceTree !== context.sourceTree) {
    issues.push("native-risk-evidence.source-identity-invalid");
  }

  validateInstalledBuild(evidence.installedBuild, evidence, issues);
  validateEnvironment(evidence.environment, context.scenario, issues);
  if (evidence.mode !== context.scenario.mode.id) {
    issues.push("native-risk-evidence.mode-invalid");
  }
  validateOperator(evidence.operator, issues);
  validateSteps(evidence.steps, issues);
  validateRiskResults(evidence.riskResults, context.scenario.host.riskCases, issues);
  validateArtifacts(evidence.artifacts, context.root, artifactIdentities, issues);
  validateDefects(evidence.defects, openDefects, issues);
  validateReviewers(evidence.reviewedBy, now, issues);
  if (evidence.pass !== true) issues.push("native-risk-evidence.not-passing");

  return result();

  function result() {
    return Object.freeze({
      valid: issues.length === 0,
      issueCodes: Object.freeze([...new Set(issues)].sort()),
      artifactIdentities: Object.freeze([...artifactIdentities]),
      openDefects: Object.freeze({ ...openDefects })
    });
  }
}

function validateInstalledBuild(build, evidence, issues) {
  if (!exactKeys(build, installedBuildKeys) || !isSha256(build.artifactSha256) ||
      !isShortText(build.buildVersion, 80) || !isHash(build.sourceRevision) ||
      !isHash(build.sourceTree) || build.sourceRevision !== evidence.sourceRevision ||
      build.sourceTree !== evidence.sourceTree) {
    issues.push("native-risk-evidence.installed-build-invalid");
  }
}

function validateEnvironment(environment, scenario, issues) {
  if (!exactKeys(environment, environmentKeys) ||
      environment.architecture !== scenario.target.architecture ||
      environment.application !== scenario.host.application ||
      environment.osFamily !== scenario.target.osFamily ||
      typeof environment.osVersion !== "string" ||
      environment.osVersion.split(".")[0] !== scenario.target.osVersion ||
      !isShortText(environment.hardwareModel, 120) ||
      !isShortText(environment.inputSourceVersion, 80) ||
      typeof environment.locale !== "string" ||
      !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(environment.locale)) {
    issues.push("native-risk-evidence.environment-invalid");
  }
}

function validateOperator(operator, issues) {
  if (!exactKeys(operator, operatorKeys) || !isNamedPerson(operator.name) ||
      !isShortText(operator.organization, 160) || !isShortText(operator.role, 120)) {
    issues.push("native-risk-evidence.operator-invalid");
  }
}

function validateSteps(steps, issues) {
  if (!Array.isArray(steps) || steps.length < 3 || steps.length > 100 ||
      !uniqueBy(steps, (step) => step?.id) || steps.some((step) =>
        !exactKeys(step, stepKeys) || !isSlug(step.id) || !isShortText(step.action) ||
        !isShortText(step.expected) || !isShortText(step.actual) || step.pass !== true)) {
    issues.push("native-risk-evidence.steps-invalid");
  }
}

function validateRiskResults(results, requiredRiskCases, issues) {
  const required = [...requiredRiskCases].sort();
  if (!Array.isArray(results) || results.length !== required.length ||
      !uniqueBy(results, (item) => item?.riskCase) || results.some((item) =>
        !exactKeys(item, riskResultKeys) || !isSlug(item.riskCase) ||
        !isShortText(item.notes) || item.pass !== true) ||
      JSON.stringify(results.map(({ riskCase }) => riskCase)) !== JSON.stringify(required)) {
    issues.push("native-risk-evidence.risk-results-invalid");
  }
}

function validateArtifacts(artifacts, root, identities, issues) {
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 20 ||
      !uniqueBy(artifacts, (artifact) => artifact?.path)) {
    issues.push("native-risk-evidence.artifacts-invalid");
    return;
  }
  for (const artifact of artifacts) {
    if (!exactKeys(artifact, artifactKeys) ||
        !["accessibility-transcript", "log", "screenshot", "video"].includes(artifact.kind) ||
        !validArtifactPath(artifact.path) || !isSha256(artifact.sha256)) {
      issues.push("native-risk-evidence.artifacts-invalid");
      continue;
    }
    const absolute = resolve(root, artifact.path);
    try {
      const metadata = lstatSync(absolute);
      const canonicalRoot = realpathSync(resolve(root));
      const canonicalArtifact = realpathSync(absolute);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
          metadata.size > 64 * 1024 * 1024 ||
          !canonicalArtifact.startsWith(`${canonicalRoot}${sep}`)) {
        issues.push("native-risk-evidence.artifact-file-invalid");
        continue;
      }
      const actualSha256 = createHash("sha256").update(readFileSync(canonicalArtifact)).digest("hex");
      if (actualSha256 !== artifact.sha256) {
        issues.push("native-risk-evidence.artifact-digest-invalid");
        continue;
      }
      identities.push(`${artifact.sha256}\0${artifact.kind}`);
    } catch {
      issues.push("native-risk-evidence.artifact-file-invalid");
    }
  }
}

function validArtifactPath(value) {
  if (typeof value !== "string" || isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return value.startsWith("reports/qa/native-host-risk/artifacts/") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function validateDefects(defects, openDefects, issues) {
  if (!Array.isArray(defects) || defects.length > 100 ||
      !uniqueBy(defects, (defect) => defect?.id) || defects.some((defect) =>
        !exactKeys(defect, defectKeys) || !isSlug(defect.id) ||
        !["P0", "P1", "P2", "P3"].includes(defect.severity) ||
        !["open", "resolved"].includes(defect.status) || !isShortText(defect.title))) {
    issues.push("native-risk-evidence.defects-invalid");
    return;
  }
  for (const defect of defects) {
    if (defect.status === "open") openDefects[defect.severity] += 1;
  }
  if (openDefects.P0 > 0 || openDefects.P1 > 0) {
    issues.push("native-risk-evidence.critical-defect-open");
  }
}

function validateReviewers(reviewers, now, issues) {
  if (!Array.isArray(reviewers) || reviewers.length < 1 || reviewers.length > 10 ||
      !uniqueBy(reviewers, (reviewer) => `${reviewer?.name}\0${reviewer?.role}`) ||
      reviewers.some((reviewer) => !exactKeys(reviewer, reviewerKeys) ||
        !isNamedPerson(reviewer.name) || !reviewerRoles.includes(reviewer.role) ||
        reviewer.decision !== "approved" || !isIsoDate(reviewer.reviewedAt, now)) ||
      !reviewers.some(({ role }) => role === "native-input-owner" || role === "qa-owner")) {
    issues.push("native-risk-evidence.review-invalid");
  }
}
