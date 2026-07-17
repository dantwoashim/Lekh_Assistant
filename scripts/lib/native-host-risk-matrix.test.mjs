import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeNativeHostPairwiseCoverage,
  canonicalNativeHostScenarios,
  NATIVE_HOST_RISK_MATRIX_POLICY_PATH,
  readNativeHostRiskMatrixPolicy
} from "./native-host-risk-matrix.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policyFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), "lekh-native-risk-policy-"));
  roots.push(root);
  const source = JSON.parse(readFileSync(
    join(process.cwd(), NATIVE_HOST_RISK_MATRIX_POLICY_PATH),
    "utf8"
  ));
  const path = join(root, NATIVE_HOST_RISK_MATRIX_POLICY_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(mutate(source), null, 2)}\n`);
  return root;
}

describe("native host risk matrix", () => {
  it("covers every target-host, target-mode, and host-mode pair with 25% of the Cartesian cases", () => {
    const result = readNativeHostRiskMatrixPolicy(process.cwd());
    expect(result.valid).toBe(true);
    const scenarios = canonicalNativeHostScenarios(result.policy);
    const coverage = analyzeNativeHostPairwiseCoverage(result.policy, scenarios);

    expect(scenarios).toHaveLength(70);
    expect(new Set(scenarios.map(({ id }) => id)).size).toBe(70);
    expect(coverage.cartesianCount).toBe(280);
    expect(coverage.cartesianFraction).toBe(0.25);
    expect(coverage.targetHostMissing).toEqual([]);
    expect(coverage.targetModeMissing).toEqual([]);
    expect(coverage.hostModeMissing).toEqual([]);
  });

  it("binds each scenario to a concrete platform host and declared risk cases", () => {
    const { policy } = readNativeHostRiskMatrixPolicy(process.cwd());
    const scenarios = canonicalNativeHostScenarios(policy);

    expect(scenarios.every(({ host }) => host.application.length > 0)).toBe(true);
    expect(scenarios.every(({ host }) => host.riskCases.length >= 3)).toBe(true);
    expect(scenarios.some(({ target, host }) =>
      target.osFamily === "Windows" && host.id === "secure-field"
    )).toBe(true);
    expect(scenarios.some(({ target, host }) =>
      target.osFamily === "macOS" && host.id === "accessibility-client"
    )).toBe(true);
  });

  it("rejects weakened dimensions, thresholds, order, and schema extensions", () => {
    const missingSecureField = policyFixture((policy) => ({
      ...policy,
      hosts: policy.hosts.filter(({ id }) => id !== "secure-field"),
      expectedScenarioCount: 60
    }));
    expect(readNativeHostRiskMatrixPolicy(missingSecureField).issueCodes)
      .toContain("native-risk-policy.hosts-invalid");

    const relaxedThreshold = policyFixture((policy) => ({
      ...policy,
      productionPassRate: 0.95
    }));
    expect(readNativeHostRiskMatrixPolicy(relaxedThreshold).issueCodes)
      .toContain("native-risk-policy.thresholds-invalid");

    const reordered = policyFixture((policy) => ({
      ...policy,
      modes: [...policy.modes].reverse()
    }));
    expect(readNativeHostRiskMatrixPolicy(reordered).issueCodes)
      .toContain("native-risk-policy.modes-invalid");

    const extended = policyFixture((policy) => ({ ...policy, optionalHosts: [] }));
    expect(readNativeHostRiskMatrixPolicy(extended).issueCodes)
      .toContain("native-risk-policy.schema-invalid");
  });
});
