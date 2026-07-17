#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeNativeHostPairwiseCoverage,
  canonicalNativeHostScenarios,
  readNativeHostRiskMatrixPolicy
} from "./lib/native-host-risk-matrix.mjs";
import { validateNativeHostRiskEvidence } from "./lib/native-host-risk-evidence.mjs";

const root = process.cwd();
const production = process.argv.includes("--production");
const result = readNativeHostRiskMatrixPolicy(process.cwd());
if (!result.valid) {
  console.error(JSON.stringify({
    status: "failed-native-host-risk-policy",
    policy: result.path,
    issueCodes: result.issueCodes
  }, null, 2));
  process.exit(1);
}

const scenarios = canonicalNativeHostScenarios(result.policy);
const coverage = analyzeNativeHostPairwiseCoverage(result.policy, scenarios);
const sourceRevision = gitValue(["rev-parse", "HEAD"]);
const sourceTree = gitValue(["rev-parse", "HEAD^{tree}"]);
const worktreeClean = gitValue(["status", "--porcelain", "--untracked-files=no"]) === "";
const artifactOwners = new Map();
const missing = [];
const invalid = [];
let passing = 0;

for (const scenario of scenarios) {
  const relativePath = `reports/qa/native-host-risk/${scenario.id}.json`;
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    missing.push({ scenarioId: scenario.id, evidence: relativePath });
    continue;
  }
  try {
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
        metadata.size > 1024 * 1024) throw new Error("evidence-file-invalid");
    const evidence = JSON.parse(readFileSync(absolutePath, "utf8"));
    const validation = validateNativeHostRiskEvidence(evidence, {
      root,
      scenario,
      sourceRevision,
      sourceTree
    });
    const duplicateArtifacts = [];
    for (const identity of validation.artifactIdentities) {
      const previousOwner = artifactOwners.get(identity);
      if (previousOwner && previousOwner !== scenario.id) duplicateArtifacts.push(identity);
      else artifactOwners.set(identity, scenario.id);
    }
    if (!validation.valid || duplicateArtifacts.length > 0) {
      invalid.push({
        scenarioId: scenario.id,
        evidence: relativePath,
        issueCodes: [
          ...validation.issueCodes,
          ...(duplicateArtifacts.length > 0 ? ["native-risk-evidence.artifact-reused"] : [])
        ]
      });
      continue;
    }
    passing += 1;
  } catch {
    invalid.push({
      scenarioId: scenario.id,
      evidence: relativePath,
      issueCodes: ["native-risk-evidence.file-unreadable-or-malformed"]
    });
  }
}

const passRate = scenarios.length === 0 ? 0 : passing / scenarios.length;
const productionPassed = production && worktreeClean && missing.length === 0 &&
  invalid.length === 0 && passRate === result.policy.productionPassRate;
const developmentPassed = !production && invalid.length === 0;
const status = productionPassed
  ? "passed-production-native-host-risk-matrix"
  : developmentPassed
    ? "passed-native-host-risk-contract-evidence-pending"
    : production
      ? "failed-production-native-host-risk-matrix"
      : "failed-native-host-risk-evidence";
const report = {
  schemaVersion: 1,
  recordType: "lekh-native-host-risk-matrix-report",
  generatedAt: new Date().toISOString(),
  status,
  production,
  policy: result.path,
  policySha256: result.sha256,
  pairingStrategy: result.policy.pairingStrategy,
  scenarioCount: coverage.scenarioCount,
  fullCartesianCount: coverage.cartesianCount,
  cartesianFraction: coverage.cartesianFraction,
  pairwiseCoverage: {
    targetHostMissing: coverage.targetHostMissing.length,
    targetModeMissing: coverage.targetModeMissing.length,
    hostModeMissing: coverage.hostModeMissing.length
  },
  sourceIdentity: { sourceRevision, sourceTree, worktreeClean },
  evidence: {
    passing,
    missing: missing.length,
    invalid: invalid.length,
    required: scenarios.length,
    passRate,
    requiredPassRate: result.policy.productionPassRate
  },
  missing,
  invalid
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(
  join(root, "reports", "native-host-risk-matrix-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 }
);

const summary = {
  status,
  report: "reports/native-host-risk-matrix-report.json",
  evidence: report.evidence,
  worktreeClean
};
if (!productionPassed && !developmentPassed) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
