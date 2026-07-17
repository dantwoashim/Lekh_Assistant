#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  captureManualHostEvidenceContext,
  LEKH_INPUT_SOURCE_IDENTIFIER,
  macOSQAMatrixStatus,
  MANUAL_HOST_EVIDENCE_SCHEMA_VERSION,
  MANUAL_HOST_EVIDENCE_SUITE,
  manualHostEvidenceAllowedForMatrix,
  validateManualHostEvidence,
  validateSecureFieldHostEvidence,
  validateSecureFieldHostEvidenceFile
} from "./lib/macos-imk-qa-evidence-validator.mjs";
import {
  PRODUCTION_QA_EVIDENCE_INDEX_PATH,
  verifyProductionIMKBuildAttestation
} from "./lib/macos-production-release-attestation.mjs";
import {
  canonicalMacOSQATuples,
  MACOS_IMK_QA_MATRIX_POLICY_PATH,
  readCanonicalMacOSQAMatrixPolicy
} from "./lib/macos-imk-qa-matrix-policy.mjs";

const root = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const evidenceRoot = join(root, "reports", "qa", "macos-imk");
const reportPath = join(root, "reports", "macos-imk-qa-matrix-report.json");
const matrixPolicyResult = readCanonicalMacOSQAMatrixPolicy(root);
if (!matrixPolicyResult.valid) {
  console.error(JSON.stringify({
    status: "failed-canonical-qa-matrix-policy-invalid",
    policy: MACOS_IMK_QA_MATRIX_POLICY_PATH,
    issueCodes: matrixPolicyResult.issueCodes
  }, null, 2));
  process.exit(1);
}
const matrixPolicy = matrixPolicyResult.policy;
const manualEvidenceContext = captureManualHostEvidenceContext({ root });
const trustedBuildAttestation = production
  ? verifyProductionIMKBuildAttestation({ root })
  : null;

const apps = [...matrixPolicy.apps];
const cases = [...matrixPolicy.cases];
const macTargets = [...matrixPolicy.targets];

const currentMachineTarget = detectCurrentMacTarget();
const smokeEvidence = [
  ...collectTextEditSmokeEvidence(currentMachineTarget),
  ...collectSecureFieldEvidence(currentMachineTarget)
];

const expectedEvidence = canonicalMacOSQATuples(matrixPolicy).map(({ target, app, case: testCase }) => ({
  target,
  app,
  case: testCase,
  evidence: evidenceFiles(app, testCase, target)
}));

const missing = expectedEvidence.filter((row) => row.evidence.length === 0);
const present = expectedEvidence.length - missing.length;
const evidenceIndex = buildEvidenceIndex(expectedEvidence);
const status = production && evidenceIndex.issues.length > 0
  ? "failed-production-evidence-index-invalid"
  : macOSQAMatrixStatus({ production, missingCount: missing.length });

const report = {
  generatedAt: new Date().toISOString(),
  command: production
    ? "node scripts/check-macos-imk-qa-matrix.mjs --production"
    : "node scripts/check-macos-imk-qa-matrix.mjs",
  suite: "macos-imk-host-qa-matrix",
  durationMs: Math.round(performance.now() - startedAt),
  status,
  production,
  apps,
  cases,
  macTargets,
  expectedTestCountPerTarget: apps.length * cases.length,
  expectedTotalAcrossTargets: expectedEvidence.length,
  evidenceRoot: "reports/qa/macos-imk",
  matrixPolicy: {
    path: matrixPolicyResult.path,
    sha256: matrixPolicyResult.sha256,
    tupleOrdering: matrixPolicy.tupleOrdering,
    evidenceReusePolicy: matrixPolicy.evidenceReusePolicy
  },
  currentMachineTarget,
  evidenceSummary: {
    present,
    missing: missing.length,
    total: expectedEvidence.length,
    derivedFromSmokeReports: smokeEvidence.filter((item) => !production || item.productionEligible === true).length,
    smokeReportsCollected: smokeEvidence.length
  },
  evidenceIndex: {
    path: PRODUCTION_QA_EVIDENCE_INDEX_PATH,
    sha256: evidenceIndex.sha256,
    sizeBytes: evidenceIndex.sizeBytes,
    entryCount: evidenceIndex.record.entries.length,
    issueCodes: evidenceIndex.issues
  },
  derivedSmokeEvidence: smokeEvidence,
  requiredEvidenceFormat: {
    path: "reports/qa/macos-imk/<app-slug>/<case-slug>.<target-or-run-id>.json",
    schemaVersion: MANUAL_HOST_EVIDENCE_SCHEMA_VERSION,
    suite: MANUAL_HOST_EVIDENCE_SUITE,
    inputSource: LEKH_INPUT_SOURCE_IDENTIFIER,
    exactTopLevelFields: [
      "schemaVersion", "suite", "generatedAt", "target", "app", "case",
      "macOSVersion", "architecture", "inputSource", "bundleIdentity", "steps",
      "expected", "actual", "pass", "artifacts", "logPaths", "provenance"
    ],
    stepFields: ["action", "expected", "actual", "pass"],
    artifactFields: ["kind", "path", "sha256"],
    bundleIdentityFields: [
      "bundleIdentifier", "shortVersion", "buildVersion", "sourceRevision", "sourceTree",
      "connectionName", "executableSha256", "codeDirectoryHash", "buildProvenanceSha256"
    ],
    provenanceFields: [
      "schemaVersion", "gitRevision", "worktreeClean", "installedSourceRevision", "installedSourceTree",
      "installedBuildProvenanceSha256",
      "installedExecutableSha256", "installedBuildVersion"
    ],
    provenanceScope: "Current Git revision/tree and source worktree, excluding reports/** evidence artifacts."
  },
  manualEvidenceValidation: {
    contextReady: manualEvidenceContext.ready,
    issueCodes: manualEvidenceContext.issueCodes
  },
  manualReleaseGate: "Production release is blocked until every app/case passes on supported macOS and architecture targets with screenshot or video evidence where useful.",
  missing: missing.slice(0, 100)
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (status.startsWith("failed")) {
  console.error(JSON.stringify({ status, report: "reports/macos-imk-qa-matrix-report.json", missing: missing.length }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status, report: "reports/macos-imk-qa-matrix-report.json", evidence: report.evidenceSummary }, null, 2));

function evidenceFiles(app, testCase, target) {
  const dir = join(evidenceRoot, slug(app));
  const derived = derivedSmokeEvidenceFiles(app, testCase, target);
  if (!existsSync(dir)) return derived;
  const caseSlug = slug(testCase);
  const manual = manualHostEvidenceAllowedForMatrix({ production, app, testCase })
    ? readdirSync(dir)
      .filter((file) => file === `${caseSlug}.json` || file.startsWith(`${caseSlug}.`))
      .filter((file) => evidenceMatchesTarget(join(dir, file), { target, app, testCase }))
      .map((file) => join("reports", "qa", "macos-imk", slug(app), file))
    : [];
  return [
    ...manual,
    ...derived
  ];
}

function evidenceMatchesTarget(path, { target, app, testCase }) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 1024 * 1024) {
      return false;
    }
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    return validateManualHostEvidence(evidence, {
      root,
      expectedApp: app,
      expectedCase: testCase,
      expectedTarget: target,
      evidencePath: path,
      context: manualEvidenceContext
    }).valid;
  } catch {
    return false;
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function derivedSmokeEvidenceFiles(app, testCase, target) {
  return smokeEvidence
    .filter((item) =>
      item.app === app &&
      item.case === testCase &&
      item.target === target &&
      (!production || item.productionEligible === true)
    )
    .map((item) => item.report);
}

function collectTextEditSmokeEvidence(target) {
  if (!target) return [];
  const smokeReports = [
    "reports/macos-imk-host-textedit-smoke.json",
    "reports/macos-imk-host-textedit-cgevent-smoke.json",
    "reports/macos-imk-host-ghost-smoke.json",
    "reports/macos-imk-host-interaction-safety.json"
  ];
  const supportedCases = [
    "romanized-word-swasthya",
    "romanized-to-nepali",
    "space-commit"
  ];
  const evidence = [];
  for (const report of smokeReports) {
    const absolute = join(root, report);
    if (!existsSync(absolute)) continue;
    try {
      const parsed = JSON.parse(readFileSync(absolute, "utf8"));
      if (parsed.status !== "passed") continue;
      if (parsed.suite === "macos-imk-host-ghost") {
        evidence.push({
          target,
          app: "TextEdit",
          case: "ghost-tab-accept",
          report,
          sourceSuite: parsed.suite,
          generatedAt: parsed.generatedAt,
          note: "Derived from HID proof of an on-screen suffix window and Tab acceptance."
        });
        continue;
      }
      if (parsed.suite === "macos-imk-host-interaction-safety") {
        const mapping = {
          "uncalibrated-forward-space-raw": ["space-commit"],
          "explicit-down-space": ["romanized-word-swasthya", "romanized-to-nepali", "space-commit"],
          "passive-digit-is-text": ["passive-digit-safety"],
          "option-two-explicit": ["explicit-option-candidate"],
          "two-stage-escape": ["escape-cancel", "two-stage-escape"]
        };
        for (const item of parsed.cases ?? []) {
          if (item.pass !== true) continue;
          for (const testCase of mapping[item.id] ?? []) {
            evidence.push({
              target,
              app: "TextEdit",
              case: testCase,
              report,
              sourceSuite: parsed.suite,
              generatedAt: parsed.generatedAt,
              note: item.proves
            });
          }
        }
        continue;
      }
      if (parsed.expected !== "स्वास्थ्य " || parsed.actual !== "स्वास्थ्य ") continue;
      for (const testCase of supportedCases) {
        evidence.push({
          target,
          app: "TextEdit",
          case: testCase,
          report,
          sourceSuite: parsed.suite,
          generatedAt: parsed.generatedAt,
          note: "Derived from a passing TextEdit host smoke report; production still requires explicit per-case manual evidence."
        });
      }
    } catch {
      // Ignore malformed smoke reports; the explicit matrix evidence path remains authoritative.
    }
  }
  return evidence;
}

function collectSecureFieldEvidence(target) {
  if (!target) return [];
  const report = "reports/macos-imk-host-secure-field.json";
  const absolute = join(root, report);
  if (!existsSync(absolute)) return [];
  try {
    const parsed = production ? null : JSON.parse(readFileSync(absolute, "utf8"));
    const validation = production
      ? validateSecureFieldHostEvidenceFile({ root, trustedBuildAttestation })
      : validateSecureFieldHostEvidence(parsed, { root });
    if (!validation.valid) return [];
    return [{
      target,
      app: "Password Fields",
      case: "secure-field-no-memory",
      report,
      sourceSuite: validation.evidenceMetadata?.suite ?? parsed?.suite,
      generatedAt: validation.evidenceMetadata?.generatedAt ?? parsed?.generatedAt,
      productionEligible: validation.trustedSourceToBinaryAttested === true,
      note: "Derived only from the disposable AppKit NSSecureTextField proof. Local-unattested runs are development evidence; production additionally requires trusted source-to-binary attestation and separate browser/third-party password-control evidence."
    }];
  } catch {
    return [];
  }
}

function detectCurrentMacTarget() {
  if (platform() !== "darwin") return null;
  const machineArchitecture = arch() === "x64" ? "x86_64" : arch();
  const family = machineArchitecture === "x86_64" ? "Intel" : "Apple Silicon";
  try {
    const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    const major = version.split(".")[0];
    return `macOS ${major} ${family}`;
  } catch {
    return null;
  }
}

function buildEvidenceIndex(rows) {
  const issues = [];
  const revision = gitValue(["rev-parse", "HEAD"]);
  const tree = gitValue(["rev-parse", "HEAD^{tree}"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) issues.push("evidence-index.source-revision-invalid");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) issues.push("evidence-index.source-tree-invalid");
  const entries = rows.map((row) => ({
    target: row.target,
    app: row.app,
    case: row.case,
    evidence: [...new Set(row.evidence)].sort().map((path) => indexedEvidenceFile(path, issues))
  }));
  const record = {
    schemaVersion: 1,
    recordType: "lekh-macos-imk-qa-evidence-index",
    generatedAt: new Date().toISOString(),
    sourceRevision: revision || null,
    sourceTree: tree || null,
    matrixPolicySha256: matrixPolicyResult.sha256,
    installerZipSha256: trustedBuildAttestation?.verified === true
      ? trustedBuildAttestation.installerZipSha256
      : null,
    expectedEntryCount: rows.length,
    entries,
    issues: [...new Set(issues)].sort()
  };
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  const absolute = join(root, PRODUCTION_QA_EVIDENCE_INDEX_PATH);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, bytes, { mode: 0o600 });
  return {
    record,
    issues: record.issues,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length
  };
}

function indexedEvidenceFile(path, issues) {
  const file = indexedRegularFile(path, 64 * 1024 * 1024, "evidence-index.evidence", issues);
  const artifacts = [];
  if (file && path.endsWith(".json")) {
    try {
      const parsed = JSON.parse(readFileSync(file.absolute, "utf8"));
      if (Array.isArray(parsed.artifacts)) {
        for (const artifact of parsed.artifacts) {
          if (typeof artifact?.path !== "string") continue;
          const indexed = indexedRegularFile(
            artifact.path,
            256 * 1024 * 1024,
            "evidence-index.artifact",
            issues
          );
          if (indexed) artifacts.push({
            path: artifact.path,
            sha256: indexed.sha256,
            sizeBytes: indexed.sizeBytes
          });
        }
      }
    } catch {
      issues.push("evidence-index.evidence-json-invalid");
    }
  }
  return {
    path,
    sha256: file?.sha256 ?? null,
    sizeBytes: file?.sizeBytes ?? null,
    artifacts: artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  };
}

function indexedRegularFile(path, maximumBytes, issue, issues) {
  if (
    typeof path !== "string" || path.length === 0 || path.length > 1024 ||
    path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    issues.push(`${issue}-path-invalid`);
    return null;
  }
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`) || relative(root, absolute).startsWith("..")) {
    issues.push(`${issue}-path-escape`);
    return null;
  }
  try {
    const metadata = lstatSync(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
      issues.push(`${issue}-file-invalid`);
      return null;
    }
    const bytes = readFileSync(absolute);
    return {
      absolute,
      sizeBytes: metadata.size,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  } catch {
    issues.push(`${issue}-unreadable`);
    return null;
  }
}

function gitValue(args) {
  try {
    return execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
