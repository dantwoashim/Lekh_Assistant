#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  inspectHumanAuthorityArtifacts,
  readHumanAuthorityPolicy
} from "./lib/human-authority-policy.mjs";
import { validateHumanAuthorityApproval } from "./lib/human-authority-approval.mjs";

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
const approvalPath = join(root, result.policy.approvalPath);
const approvalPresent = existsSync(approvalPath);
const sourceRevision = gitValue(["rev-parse", "HEAD"]);
const sourceTree = gitValue(["rev-parse", "HEAD^{tree}"]);
const worktreeClean = gitValue(["status", "--porcelain", "--untracked-files=no"]) === "";
const approvalValidation = approvalPresent
  ? readAndValidateApproval()
  : { valid: false, issueCodes: ["human-authority-approval.missing"] };
const productionReady = approvalValidation.valid && worktreeClean &&
  artifacts.missing.length === 0 && artifacts.invalid.length === 0;
const developmentReady = !approvalPresent || approvalValidation.valid;
const status = production
  ? productionReady
    ? "passed-production-human-authority"
    : "failed-production-human-authority"
  : developmentReady
    ? approvalValidation.valid
      ? "passed-human-authority-review"
      : "passed-human-authority-contract-review-pending"
    : "failed-human-authority-approval";
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
    valid: approvalValidation.valid,
    issueCodes: approvalValidation.issueCodes,
    reviewerCount: approvalValidation.reviewerCount ?? 0,
    domainCount: approvalValidation.domainCount ?? 0,
    artifactCount: approvalValidation.artifactCount ?? 0
  },
  sourceIdentity: { sourceRevision, sourceTree, worktreeClean },
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
  approvalValid: approvalValidation.valid,
  requiredArtifacts: artifacts.required,
  missingArtifacts: artifacts.missing.length,
  invalidArtifacts: artifacts.invalid.length,
  worktreeClean
};
if ((production && !productionReady) || (!production && !developmentReady)) {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));

function readAndValidateApproval() {
  try {
    const metadata = lstatSync(approvalPath);
    const canonicalRoot = realpathSync(resolve(root));
    const canonicalPath = realpathSync(approvalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
        metadata.size > 2 * 1024 * 1024 || !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
      throw new Error("approval-file-invalid");
    }
    const approval = JSON.parse(readFileSync(canonicalPath, "utf8"));
    return validateHumanAuthorityApproval(approval, {
      root,
      policy: result.policy,
      policySha256: result.sha256,
      sourceRevision,
      sourceTree
    });
  } catch {
    return {
      valid: false,
      issueCodes: ["human-authority-approval.file-unreadable-or-malformed"]
    };
  }
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
