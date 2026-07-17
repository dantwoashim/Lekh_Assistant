import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHumanAuthorityPolicy } from "./human-authority-policy.mjs";
import {
  HUMAN_AUTHORITY_ATTESTATION,
  validateHumanAuthorityApproval
} from "./human-authority-approval.mjs";

const roots = [];
const sourceRevision = "1".repeat(40);
const sourceTree = "2".repeat(40);
const policySha256 = "3".repeat(64);
const now = new Date("2026-07-17T08:00:00.000Z");
const { policy } = readHumanAuthorityPolicy(process.cwd());
const allDomainIds = policy.domains.map(({ id }) => id);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lekh-human-authority-approval-"));
  roots.push(root);
  const artifactRecords = new Map();
  for (const domain of policy.domains) {
    for (const path of domain.requiredArtifacts) {
      if (artifactRecords.has(path)) continue;
      const bytes = path.endsWith(".jsonl")
        ? Buffer.from('{"id":"reviewed-item"}\n', "utf8")
        : path.endsWith(".tsv")
          ? Buffer.from("id\tvalue\nreviewed-item\taccepted\n", "utf8")
          : Buffer.from('[{"id":"reviewed-item"}]\n', "utf8");
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), bytes);
      artifactRecords.set(path, {
        itemCount: 1,
        path,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
  }

  const reviewerIds = ["owner", "reviewer-one", "reviewer-two"];
  const approval = {
    schemaVersion: 1,
    recordType: "lekh-human-authority-approval",
    reviewId: "release-review-v1",
    policySha256,
    sourceRevision,
    sourceTree,
    reviewedAt: "2026-07-17T07:30:00.000Z",
    releaseDecision: "approved",
    reviewers: [
      {
        affiliation: "Lekh",
        conflictDisclosure: "Product ownership disclosed.",
        experience: "Owns the release decision and accepted product behavior.",
        id: "owner",
        name: "Release Owner",
        relationship: "internal",
        roles: ["internal-product-owner"]
      },
      {
        affiliation: "Independent language review",
        conflictDisclosure: "No conflict disclosed.",
        experience: "Experienced Nepali writer, Traditional typist, and accessibility reviewer.",
        id: "reviewer-one",
        name: "Reviewer One",
        relationship: "external",
        roles: ["accessibility-reviewer", "nepali-linguist", "traditional-typist"]
      },
      {
        affiliation: "Independent language review",
        conflictDisclosure: "No conflict disclosed.",
        experience: "Experienced Nepali editor, Traditional typist, and accessibility reviewer.",
        id: "reviewer-two",
        name: "Reviewer Two",
        relationship: "external",
        roles: ["accessibility-reviewer", "nepali-linguist", "traditional-typist"]
      }
    ],
    domains: policy.domains.map((domain) => ({
      artifacts: domain.requiredArtifacts.map((path) => artifactRecords.get(path)),
      coverage: {
        acceptedItems: domain.requiredArtifacts.length,
        rejectedItems: 0,
        reviewedItems: domain.requiredArtifacts.length,
        totalItems: domain.requiredArtifacts.length,
        unresolvedItems: 0
      },
      decision: "approved",
      id: domain.id,
      notes: "Every declared item and artifact version was reviewed within the assigned roles.",
      reviewerIds
    })),
    defects: [],
    attestations: reviewerIds.map((reviewerId) => ({
      attestedAt: "2026-07-17T07:30:00.000Z",
      decision: "approved",
      domainIds: allDomainIds,
      reviewerId,
      statement: HUMAN_AUTHORITY_ATTESTATION
    }))
  };
  return { root, approval };
}

function validate(root, approval) {
  return validateHumanAuthorityApproval(approval, {
    root,
    policy,
    policySha256,
    sourceRevision,
    sourceTree,
    now
  });
}

describe("human authority approval", () => {
  it("accepts complete source-bound review with named roles, exact coverage, and attestations", () => {
    const { root, approval } = fixture();
    const result = validate(root, approval);
    expect(result.valid).toBe(true);
    expect(result.issueCodes).toEqual([]);
    expect(result.domainCount).toBe(8);
    expect(result.reviewerCount).toBe(3);
    expect(result.artifactCount).toBe(17);
  });

  it("rejects changed artifacts, unresolved coverage, weakened roles, and critical defects", () => {
    const { root, approval } = fixture();
    const firstArtifact = approval.domains[0].artifacts[0].path;
    writeFileSync(join(root, firstArtifact), '{"id":"changed-after-review"}\n');
    approval.domains[1].coverage.unresolvedItems = 1;
    approval.reviewers[2].roles = ["accessibility-reviewer", "traditional-typist"];
    approval.defects.push({
      description: "A reviewed correction can lose user text.",
      domain: "corrections-proofread",
      id: "lost-text",
      resolution: "Pending remediation before release.",
      severity: "P1",
      status: "open"
    });

    const result = validate(root, approval);
    expect(result.issueCodes).toEqual(expect.arrayContaining([
      `human-authority-approval.artifact-identity-invalid:${firstArtifact}`,
      "human-authority-approval.coverage-invalid:ambiguous-romanization",
      "human-authority-approval.critical-defect-open",
      "human-authority-approval.domain-role-missing:ambiguous-romanization:nepali-linguist"
    ]));
  });

  it("rejects generic curation labels, incomplete attestations, and stale source identity", () => {
    const { root, approval } = fixture();
    approval.attestations[0].domainIds = approval.attestations[0].domainIds.slice(1);
    approval.sourceTree = "9".repeat(40);

    const staleResult = validate(root, approval);
    expect(staleResult.issueCodes).toEqual(expect.arrayContaining([
      "human-authority-approval.attestation-invalid:owner",
      "human-authority-approval.source-identity-invalid"
    ]));

    approval.reviewers[1].name = "project-curation";
    const genericResult = validate(root, approval);
    expect(genericResult.issueCodes).toEqual(expect.arrayContaining([
      "human-authority-approval.attestations-invalid",
      "human-authority-approval.reviewer-invalid:reviewer-one"
    ]));
  });
});
