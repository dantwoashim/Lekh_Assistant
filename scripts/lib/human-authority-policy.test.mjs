import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HUMAN_AUTHORITY_POLICY_PATH,
  inspectHumanAuthorityArtifacts,
  readHumanAuthorityPolicy
} from "./human-authority-policy.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function policyFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), "lekh-human-authority-policy-"));
  roots.push(root);
  const source = JSON.parse(readFileSync(join(process.cwd(), HUMAN_AUTHORITY_POLICY_PATH), "utf8"));
  const path = join(root, HUMAN_AUTHORITY_POLICY_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(mutate(source), null, 2)}\n`);
  return root;
}

describe("human authority policy", () => {
  it("requires all eight language and accessibility review domains", () => {
    const result = readHumanAuthorityPolicy(process.cwd());
    expect(result.valid).toBe(true);
    expect(result.policy.domains.map(({ id }) => id)).toEqual([
      "accessibility-language",
      "ambiguous-romanization",
      "code-mixed-behavior",
      "corrections-proofread",
      "dictionary-meanings",
      "names",
      "romanized-aliases",
      "traditional-layout"
    ]);
    expect(result.policy.domains.every(({ minimumExternalReviewers }) =>
      minimumExternalReviewers >= 2
    )).toBe(true);
  });

  it("reports unavailable review artifacts without treating them as approved", () => {
    const { policy } = readHumanAuthorityPolicy(process.cwd());
    const status = inspectHumanAuthorityArtifacts(process.cwd(), policy);
    expect(status.required).toBe(18);
    expect(status.missing.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "data/language-review/v1/accessibility-language.jsonl",
      "data/language-review/v1/dictionary-meanings.jsonl",
      "data/layouts/traditional-ltk-compatible.json"
    ]));
  });

  it("rejects removed domains, weaker role counts, path substitution, and schema extension", () => {
    const removed = policyFixture((policy) => ({
      ...policy,
      domains: policy.domains.slice(1)
    }));
    expect(readHumanAuthorityPolicy(removed).issueCodes)
      .toContain("human-authority-policy.domains-invalid");

    const weakened = policyFixture((policy) => ({
      ...policy,
      domains: policy.domains.map((domain) => domain.id === "traditional-layout"
        ? { ...domain, requiredRoleCounts: { ...domain.requiredRoleCounts, "traditional-typist": 1 } }
        : domain)
    }));
    expect(readHumanAuthorityPolicy(weakened).issueCodes)
      .toContain("human-authority-policy.domain-invalid:traditional-layout");

    const substituted = policyFixture((policy) => ({
      ...policy,
      domains: policy.domains.map((domain) => domain.id === "dictionary-meanings"
        ? { ...domain, requiredArtifacts: ["README.md"] }
        : domain)
    }));
    expect(readHumanAuthorityPolicy(substituted).issueCodes)
      .toContain("human-authority-policy.domain-invalid:dictionary-meanings");

    const extended = policyFixture((policy) => ({ ...policy, optionalDomains: [] }));
    expect(readHumanAuthorityPolicy(extended).issueCodes)
      .toContain("human-authority-policy.schema-invalid");
  });
});
