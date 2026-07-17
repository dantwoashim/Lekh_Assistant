import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export const HUMAN_AUTHORITY_POLICY_PATH = "config/human-authority-policy.v1.json";

const APPROVAL_PATH = "data/language-review/v1/human-authority-approval.json";
const REQUIRED_ARTIFACTS = Object.freeze({
  "accessibility-language": [
    "data/language-review/v1/accessibility-language.jsonl"
  ],
  "ambiguous-romanization": [
    "data/language-review/v1/ambiguous-romanization.jsonl",
    "src/data/aliases/romanized-aliases.tsv"
  ],
  "code-mixed-behavior": [
    "data/keyboard-corpus/curated/v0.1/D4_mixed_nepali_english_sentences.v0.1.jsonl",
    "data/keyboard-corpus/runtime/v0.1/mixed-policy.json"
  ],
  "corrections-proofread": [
    "data/keyboard-corpus/curated/v0.1/D5_proofread_error_corrections.v0.1.jsonl",
    "data/keyboard-corpus/runtime/v0.1/proofread-rules.json"
  ],
  "dictionary-meanings": [
    "data/language-review/v1/dictionary-meanings.jsonl",
    "src/data/wordlists/ne-seed.tsv"
  ],
  "names": [
    "data/keyboard-corpus/curated/v0.1/D6_name_surname_variants.v0.1.jsonl",
    "data/keyboard-corpus/runtime/v0.1/name-index.json"
  ],
  "romanized-aliases": [
    "data/keyboard-corpus/curated/v0.1/D1_word_aliases.v0.1.jsonl",
    "data/keyboard-corpus/curated/v0.1/D2_phrase_aliases.v0.1.jsonl",
    "src/data/aliases/romanized-aliases.tsv",
    "src/data/phrases/romanized-phrases.tsv"
  ],
  "traditional-layout": [
    "bench/fixtures/traditional-layout/layout-audit.jsonl",
    "data/layouts/traditional-ltk-compatible.json",
    "data/layouts/traditional-standard.json"
  ]
});
const REQUIRED_ROLES = Object.freeze({
  "accessibility-language": {
    "accessibility-reviewer": 1,
    "internal-product-owner": 1,
    "nepali-linguist": 1
  },
  "ambiguous-romanization": { "internal-product-owner": 1, "nepali-linguist": 2 },
  "code-mixed-behavior": { "internal-product-owner": 1, "nepali-linguist": 2 },
  "corrections-proofread": { "internal-product-owner": 1, "nepali-linguist": 2 },
  "dictionary-meanings": { "internal-product-owner": 1, "nepali-linguist": 2 },
  "names": { "internal-product-owner": 1, "nepali-linguist": 2 },
  "romanized-aliases": { "internal-product-owner": 1, "nepali-linguist": 2 },
  "traditional-layout": {
    "internal-product-owner": 1,
    "nepali-linguist": 1,
    "traditional-typist": 2
  }
});
const policyKeys = Object.freeze([
  "approvalPath",
  "domains",
  "maximumOpenDefects",
  "recordType",
  "schemaVersion"
].sort());
const domainKeys = Object.freeze([
  "id",
  "label",
  "minimumExternalReviewers",
  "minimumReviewers",
  "requiredArtifacts",
  "requiredRoleCounts"
].sort());

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function isShortText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 180 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validRelativePath(value) {
  if (typeof value !== "string" || isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function canonicalRecord(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )));
}

export function readHumanAuthorityPolicy(root) {
  const issues = [];
  const resolvedRoot = resolve(root);
  const path = join(resolvedRoot, HUMAN_AUTHORITY_POLICY_PATH);
  let bytes = null;
  let policy = null;
  try {
    const metadata = lstatSync(path);
    const canonicalRoot = realpathSync(resolvedRoot);
    const canonicalPath = realpathSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
        metadata.size > 128 * 1024 || !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
      issues.push("human-authority-policy.file-invalid");
    } else {
      bytes = readFileSync(canonicalPath);
      policy = JSON.parse(bytes.toString("utf8"));
    }
  } catch {
    issues.push("human-authority-policy.unreadable-or-malformed");
  }

  if (!exactKeys(policy, policyKeys)) {
    issues.push("human-authority-policy.schema-invalid");
  } else {
    if (policy.schemaVersion !== 1 || policy.recordType !== "lekh-human-authority-policy" ||
        policy.approvalPath !== APPROVAL_PATH) {
      issues.push("human-authority-policy.identity-invalid");
    }
    if (!exactKeys(policy.maximumOpenDefects, ["P0", "P1"]) ||
        policy.maximumOpenDefects.P0 !== 0 || policy.maximumOpenDefects.P1 !== 0) {
      issues.push("human-authority-policy.thresholds-invalid");
    }
    validateDomains(policy.domains, issues);
  }

  const valid = issues.length === 0;
  return Object.freeze({
    valid,
    issueCodes: Object.freeze([...new Set(issues)].sort()),
    policy: valid ? Object.freeze(policy) : null,
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    path: HUMAN_AUTHORITY_POLICY_PATH
  });
}

export function inspectHumanAuthorityArtifacts(root, policy) {
  const missing = [];
  const invalid = [];
  const canonicalRoot = realpathSync(resolve(root));
  for (const domain of policy.domains) {
    for (const path of domain.requiredArtifacts) {
      const absolute = resolve(root, path);
      try {
        const metadata = lstatSync(absolute);
        const canonicalPath = realpathSync(absolute);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
            !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
          invalid.push({ domain: domain.id, path });
        }
      } catch {
        missing.push({ domain: domain.id, path });
      }
    }
  }
  return Object.freeze({
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
    required: policy.domains.reduce((sum, domain) => sum + domain.requiredArtifacts.length, 0)
  });
}

function validateDomains(domains, issues) {
  const expectedIds = Object.keys(REQUIRED_ARTIFACTS).sort();
  if (!Array.isArray(domains) || domains.length !== expectedIds.length ||
      !domains.every(isRecord) ||
      JSON.stringify(domains.map(({ id }) => id)) !== JSON.stringify(expectedIds)) {
    issues.push("human-authority-policy.domains-invalid");
    return;
  }
  for (const domain of domains) {
    if (!exactKeys(domain, domainKeys) || !isShortText(domain.label) ||
        domain.minimumReviewers < 3 || domain.minimumExternalReviewers < 2 ||
        domain.minimumExternalReviewers >= domain.minimumReviewers ||
        !Array.isArray(domain.requiredArtifacts) ||
        domain.requiredArtifacts.some((path) => !validRelativePath(path)) ||
        new Set(domain.requiredArtifacts).size !== domain.requiredArtifacts.length ||
        JSON.stringify(domain.requiredArtifacts) !== JSON.stringify(REQUIRED_ARTIFACTS[domain.id]) ||
        !isRecord(domain.requiredRoleCounts) ||
        canonicalRecord(domain.requiredRoleCounts) !== canonicalRecord(REQUIRED_ROLES[domain.id]) ||
        Object.values(domain.requiredRoleCounts).some((count) =>
          !Number.isSafeInteger(count) || count < 1 || count > 10
        )) {
      issues.push(`human-authority-policy.domain-invalid:${domain.id}`);
    }
  }
}
