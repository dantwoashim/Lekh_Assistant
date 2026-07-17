import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalMacOSQATupleKey,
  canonicalMacOSQATuples,
  MACOS_IMK_QA_MATRIX_POLICY_PATH,
  readCanonicalMacOSQAMatrixPolicy
} from "./macos-imk-qa-matrix-policy.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policyFixture(mutate = (policy) => policy) {
  const root = mkdtempSync(join(tmpdir(), "lekh-qa-policy-"));
  roots.push(root);
  const source = JSON.parse(readFileSync(join(process.cwd(), MACOS_IMK_QA_MATRIX_POLICY_PATH), "utf8"));
  const policy = mutate(source);
  const path = join(root, MACOS_IMK_QA_MATRIX_POLICY_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
  return root;
}

describe("canonical macOS IMK QA matrix policy", () => {
  it("defines one sorted closed set of all 2,730 host tuples", () => {
    const result = readCanonicalMacOSQAMatrixPolicy(process.cwd());
    expect(result.valid).toBe(true);
    const tuples = canonicalMacOSQATuples(result.policy);
    expect(tuples).toHaveLength(2_730);
    expect(tuples.map(canonicalMacOSQATupleKey)).toEqual(
      [...tuples.map(canonicalMacOSQATupleKey)].sort()
    );
    expect(new Set(tuples.map(canonicalMacOSQATupleKey)).size).toBe(2_730);
  });

  it("rejects schema extension, reordered dimensions, and fabricated targets", () => {
    const extended = policyFixture((policy) => ({ ...policy, optionalTargets: [] }));
    expect(readCanonicalMacOSQAMatrixPolicy(extended).issueCodes).toContain("qa-policy.schema-invalid");

    const reordered = policyFixture((policy) => ({
      ...policy,
      apps: [...policy.apps].reverse()
    }));
    expect(readCanonicalMacOSQAMatrixPolicy(reordered).issueCodes).toContain("qa-policy.apps-invalid");

    const fabricated = policyFixture((policy) => ({
      ...policy,
      targets: policy.targets.map((_, index) => `target-${index}`)
    }));
    expect(readCanonicalMacOSQAMatrixPolicy(fabricated).issueCodes).toContain("qa-policy.targets-invalid");
  });
});
