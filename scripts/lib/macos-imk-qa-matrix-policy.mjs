import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const MACOS_IMK_QA_MATRIX_POLICY_PATH = "config/macos-imk-qa-matrix.v1.json";

const policyKeys = Object.freeze([
  "apps",
  "cases",
  "evidenceReusePolicy",
  "expectedEntryCount",
  "recordType",
  "schemaVersion",
  "targets",
  "tupleOrdering"
].sort());

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === expected.join("\0");
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDimension(values, maximumCount) {
  return Array.isArray(values) && values.length > 0 && values.length <= maximumCount &&
    values.every((value) =>
      typeof value === "string" && value.length > 0 && value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
    ) &&
    new Set(values).size === values.length &&
    JSON.stringify(values) === JSON.stringify([...values].sort(codeUnitCompare));
}

export function canonicalMacOSQATupleKey({ target, app, case: testCase }) {
  return `${target}\0${app}\0${testCase}`;
}

export function canonicalMacOSQATuples(policy) {
  if (!policy) return [];
  const tuples = [];
  for (const target of policy.targets ?? []) {
    for (const app of policy.apps ?? []) {
      for (const testCase of policy.cases ?? []) tuples.push({ target, app, case: testCase });
    }
  }
  return tuples.sort((left, right) =>
    codeUnitCompare(canonicalMacOSQATupleKey(left), canonicalMacOSQATupleKey(right))
  );
}

export function readCanonicalMacOSQAMatrixPolicy(root) {
  const issues = [];
  const resolvedRoot = resolve(root);
  const path = join(resolvedRoot, MACOS_IMK_QA_MATRIX_POLICY_PATH);
  let bytes = null;
  let policy = null;
  try {
    const metadata = lstatSync(path);
    const canonicalRoot = realpathSync(resolvedRoot);
    const canonicalPath = realpathSync(path);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > 64 * 1024 ||
      !canonicalPath.startsWith(`${canonicalRoot}${sep}`)
    ) {
      issues.push("qa-policy.file-invalid");
    } else {
      bytes = readFileSync(canonicalPath);
      policy = JSON.parse(bytes.toString("utf8"));
    }
  } catch {
    issues.push("qa-policy.unreadable-or-malformed");
  }

  if (!exactKeys(policy, policyKeys)) {
    issues.push("qa-policy.schema-invalid");
  } else {
    if (policy.schemaVersion !== 1 || policy.recordType !== "lekh-macos-imk-qa-matrix-policy") {
      issues.push("qa-policy.identity-invalid");
    }
    if (policy.tupleOrdering !== "target-app-case-utf16-code-unit-ascending") {
      issues.push("qa-policy.tuple-ordering-invalid");
    }
    if (policy.evidenceReusePolicy !== "one-evidence-or-artifact-identity-per-tuple") {
      issues.push("qa-policy.evidence-reuse-policy-invalid");
    }
    if (!validDimension(policy.targets, 32) ||
        !policy.targets.every((target) => /^macOS (?:13|14|15|26) (?:Apple Silicon|Intel)$/u.test(target))) {
      issues.push("qa-policy.targets-invalid");
    }
    if (!validDimension(policy.apps, 128)) issues.push("qa-policy.apps-invalid");
    if (!validDimension(policy.cases, 256) ||
        !policy.cases.every((testCase) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(testCase))) {
      issues.push("qa-policy.cases-invalid");
    }
    const expectedEntryCount = policy.targets.length * policy.apps.length * policy.cases.length;
    if (policy.expectedEntryCount !== expectedEntryCount || expectedEntryCount !== 2_730) {
      issues.push("qa-policy.entry-count-invalid");
    }
  }

  const valid = issues.length === 0;
  return Object.freeze({
    valid,
    issueCodes: Object.freeze([...new Set(issues)]),
    policy: valid ? Object.freeze({
      ...policy,
      targets: Object.freeze([...policy.targets]),
      apps: Object.freeze([...policy.apps]),
      cases: Object.freeze([...policy.cases])
    }) : null,
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    path: MACOS_IMK_QA_MATRIX_POLICY_PATH
  });
}
