import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalNativeHostScenarios, readNativeHostRiskMatrixPolicy } from "./native-host-risk-matrix.mjs";
import { validateNativeHostRiskEvidence } from "./native-host-risk-evidence.mjs";

const roots = [];
const sourceRevision = "1".repeat(40);
const sourceTree = "2".repeat(40);
const now = new Date("2026-07-17T08:00:00.000Z");
const { policy } = readNativeHostRiskMatrixPolicy(process.cwd());
const scenario = canonicalNativeHostScenarios(policy)[0];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lekh-native-risk-evidence-"));
  roots.push(root);
  const artifactPath = "reports/qa/native-host-risk/artifacts/proof.log";
  const artifactBytes = Buffer.from("source-bound native host proof\n", "utf8");
  mkdirSync(join(root, artifactPath, ".."), { recursive: true });
  writeFileSync(join(root, artifactPath), artifactBytes);
  const evidence = {
    schemaVersion: 1,
    recordType: "lekh-native-host-risk-evidence",
    scenarioId: scenario.id,
    generatedAt: "2026-07-17T07:00:00.000Z",
    sourceRevision,
    sourceTree,
    installedBuild: {
      artifactSha256: "3".repeat(64),
      buildVersion: "0.1.0-176",
      sourceRevision,
      sourceTree
    },
    environment: {
      architecture: scenario.target.architecture,
      application: scenario.host.application,
      hardwareModel: "QA hardware",
      inputSourceVersion: "0.1.0-176",
      locale: "ne-NP",
      osFamily: scenario.target.osFamily,
      osVersion: scenario.target.osVersion
    },
    mode: scenario.mode.id,
    operator: {
      name: "Niraj Tester",
      organization: "Independent QA",
      role: "host compatibility operator"
    },
    steps: [
      { id: "activate", action: "Activate Lekh.", expected: "Lekh is active.", actual: "Lekh was active.", pass: true },
      { id: "compose", action: "Compose the fixture.", expected: "Text is marked safely.", actual: "Text was marked safely.", pass: true },
      { id: "commit", action: "Commit the fixture.", expected: "Text commits once.", actual: "Text committed once.", pass: true }
    ],
    riskResults: scenario.host.riskCases.map((riskCase) => ({
      notes: `${riskCase} passed with retained evidence.`,
      pass: true,
      riskCase
    })),
    artifacts: [{
      kind: "log",
      path: artifactPath,
      sha256: createHash("sha256").update(artifactBytes).digest("hex")
    }],
    defects: [],
    reviewedBy: [{
      decision: "approved",
      name: "Maya QA",
      reviewedAt: "2026-07-17T07:30:00.000Z",
      role: "qa-owner"
    }],
    pass: true
  };
  return { root, evidence, artifactPath };
}

function validate(root, evidence) {
  return validateNativeHostRiskEvidence(evidence, {
    root,
    scenario,
    sourceRevision,
    sourceTree,
    now
  });
}

describe("native host risk evidence", () => {
  it("accepts exact, source-bound, reviewed evidence with retained artifacts", () => {
    const { root, evidence } = fixture();
    const result = validate(root, evidence);
    expect(result.valid).toBe(true);
    expect(result.issueCodes).toEqual([]);
    expect(result.artifactIdentities).toHaveLength(1);
  });

  it("rejects stale source identity, target drift, missing risks, and open critical defects", () => {
    const { root, evidence } = fixture();
    evidence.sourceRevision = "4".repeat(40);
    evidence.environment.architecture = evidence.environment.architecture === "arm64" ? "x86_64" : "arm64";
    evidence.riskResults.pop();
    evidence.defects.push({ id: "lost-text", severity: "P1", status: "open", title: "Text can be lost." });

    const result = validate(root, evidence);
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      "native-risk-evidence.critical-defect-open",
      "native-risk-evidence.environment-invalid",
      "native-risk-evidence.risk-results-invalid",
      "native-risk-evidence.source-identity-invalid"
    ]));
  });

  it("rejects placeholder approvals, digest mismatch, traversal, and symlink artifacts", () => {
    const first = fixture();
    first.evidence.reviewedBy[0].name = "TBD";
    first.evidence.artifacts[0].sha256 = "0".repeat(64);
    expect(validate(first.root, first.evidence).issueCodes).toEqual(expect.arrayContaining([
      "native-risk-evidence.artifact-digest-invalid",
      "native-risk-evidence.review-invalid"
    ]));

    const second = fixture();
    second.evidence.artifacts[0].path = "reports/qa/native-host-risk/artifacts/../../escape.log";
    expect(validate(second.root, second.evidence).issueCodes)
      .toContain("native-risk-evidence.artifacts-invalid");

    const third = fixture();
    const linkPath = "reports/qa/native-host-risk/artifacts/link.log";
    symlinkSync(join(third.root, third.artifactPath), join(third.root, linkPath));
    third.evidence.artifacts[0].path = linkPath;
    expect(validate(third.root, third.evidence).issueCodes)
      .toContain("native-risk-evidence.artifact-file-invalid");
  });
});
