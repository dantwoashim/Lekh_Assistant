#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  inspectHumanAuthorityArtifacts,
  readHumanAuthorityPolicy
} from "./lib/human-authority-policy.mjs";

const root = process.cwd();
const production = process.argv.includes("--production");
const result = readHumanAuthorityPolicy(root);
if (!result.valid) {
  console.error(JSON.stringify({
    status: "failed-human-authority-policy",
    policy: result.path,
    issueCodes: result.issueCodes
  }, null, 2));
  process.exit(1);
}

const artifacts = inspectHumanAuthorityArtifacts(root, result.policy);
const approvalPresent = existsSync(join(root, result.policy.approvalPath));
const semanticValidationImplemented = false;
const productionReady = semanticValidationImplemented && approvalPresent &&
  artifacts.missing.length === 0 && artifacts.invalid.length === 0;
const status = production
  ? productionReady
    ? "passed-production-human-authority-artifact-contract"
    : "failed-production-human-authority-artifact-contract"
  : "passed-human-authority-contract-review-pending";
const report = {
  schemaVersion: 1,
  recordType: "lekh-human-authority-report",
  generatedAt: new Date().toISOString(),
  status,
  production,
  policy: result.path,
  policySha256: result.sha256,
  approval: {
    path: result.policy.approvalPath,
    present: approvalPresent,
    semanticValidation: "not-yet-implemented-production-blocked"
  },
  artifacts: {
    required: artifacts.required,
    present: artifacts.required - artifacts.missing.length - artifacts.invalid.length,
    missing: artifacts.missing,
    invalid: artifacts.invalid
  },
  releaseRule: "No approval is inferred from generated, synthetic, auto-reviewed, or project-curation labels."
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(
  join(root, "reports", "human-authority-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 }
);

const summary = {
  status,
  report: "reports/human-authority-report.json",
  approvalPresent,
  requiredArtifacts: artifacts.required,
  missingArtifacts: artifacts.missing.length,
  invalidArtifacts: artifacts.invalid.length
};
if (production && !productionReady) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));
