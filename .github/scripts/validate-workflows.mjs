#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const workflowsDirectory = join(repositoryRoot, ".github", "workflows");
const fullShaPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*@[a-f0-9]{40}$/u;
const versionCommentPattern = /^v\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?(?:\s|$)/u;
const failures = [];

function fail(file, message, line = null) {
  failures.push(`${file}${line === null ? "" : `:${line}`}: ${message}`);
}

function requireText(file, text, needle, description) {
  if (!text.includes(needle)) fail(file, `missing ${description}: ${JSON.stringify(needle)}`);
}

function actionReferences(file, text) {
  const references = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$/u);
    if (!match) continue;
    const reference = match[1].replace(/^['"]|['"]$/gu, "");
    const comment = match[2]?.trim() ?? "";
    references.push({ comment, line: index + 1, reference });

    if (reference.startsWith("./")) continue;
    if (reference.startsWith("docker://")) {
      if (!/^docker:\/\/[^\s]+@sha256:[a-f0-9]{64}$/u.test(reference)) {
        fail(file, "container action must use an immutable sha256 image digest", index + 1);
      }
      continue;
    }
    if (!fullShaPattern.test(reference)) {
      fail(file, "external action must be pinned to a lowercase, full 40-character commit SHA", index + 1);
    }
    if (!versionCommentPattern.test(comment)) {
      fail(file, "SHA-pinned action must retain a readable version comment such as '# v6.0.3'", index + 1);
    }
  }
  return references;
}

function validateGeneralPolicy(file, text) {
  if (!/^permissions:\s*(?:\{\})?\s*$/mu.test(text)) {
    fail(file, "workflow must declare top-level token permissions");
  }
  if (/^\s*pull_request_target\s*:/mu.test(text)) {
    fail(file, "pull_request_target is prohibited because it combines base-branch privileges with PR input");
  }
  if (/^\s*permissions:\s*(?:write-all|read-all)\s*$/mu.test(text)) {
    fail(file, "blanket token permissions are prohibited");
  }
  if (/\bsecrets\s*\./u.test(text)) {
    fail(file, "workflows in this repository must not depend on repository secrets");
  }

  const references = actionReferences(file, text);
  const checkoutCount = references.filter(({ reference }) => reference.startsWith("actions/checkout@")).length;
  const disabledCredentialCount = (text.match(/^\s*persist-credentials:\s*false\s*$/gmu) ?? []).length;
  if (checkoutCount !== disabledCredentialCount) {
    fail(
      file,
      `each checkout must disable persisted credentials (${checkoutCount} checkout step(s), ${disabledCredentialCount} opt-out(s))`
    );
  }
}

function validateCodeQl(file, text) {
  for (const needle of [
    "pull_request:",
    "push:",
    "schedule:",
    "security-events: write",
    "actions: read",
    "contents: read",
    "language: javascript-typescript",
    "language: actions",
    "language: c-cpp",
    "language: swift",
    "build-mode: manual",
    "swift build --package-path native/macos-imk/skeleton --arch arm64"
  ]) {
    requireText(file, text, needle, "CodeQL contract");
  }
  const codeQlReferences = actionReferences(file, text).filter(({ reference }) =>
    reference.startsWith("github/codeql-action/")
  );
  if (codeQlReferences.length !== 2) {
    fail(file, `expected exactly two CodeQL action steps, found ${codeQlReferences.length}`);
  }
  const revisions = new Set(codeQlReferences.map(({ reference }) => reference.split("@").at(-1)));
  if (revisions.size !== 1) fail(file, "CodeQL init and analyze steps must use the same immutable revision");
}

function validateDependencyReview(file, text) {
  for (const needle of [
    "pull_request:",
    "contents: read",
    "actions/dependency-review-action@",
    "fail-on-severity: moderate",
    "fail-on-scopes: runtime, development"
  ]) {
    requireText(file, text, needle, "dependency-review contract");
  }
  if (/^\s*(?:push|workflow_dispatch|schedule):\s*$/mu.test(text)) {
    fail(file, "dependency review must run only for pull requests");
  }
}

function validateCommunityPreview(file, text) {
  for (const needle of [
    "workflow_dispatch:",
    "github.ref == 'refs/heads/main'",
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
    "Lekh-Keyboard-macOS-Community-Preview-UNSIGNED.zip",
    "generate-community-preview-sbom.mjs",
    "COMMUNITY_PREVIEW_TRUST.md",
    "sbom-path:",
    "SHA256SUMS.txt"
  ]) {
    requireText(file, text, needle, "community-preview provenance contract");
  }
  const references = actionReferences(file, text);
  const attestationCount = references.filter(({ reference }) =>
    reference.startsWith("actions/attest@")
  ).length;
  if (attestationCount !== 2) {
    fail(file, `expected separate provenance and SBOM attestations, found ${attestationCount}`);
  }
  if (/\b(?:APPLE_ID|APPLE_TEAM_ID|LEKH_MAC_DEVELOPER_ID|WINDOWS_CERTIFICATE)\b/u.test(text)) {
    fail(file, "community preview must not request or imply platform-signing credentials");
  }
}

const workflowEntries = (await readdir(workflowsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name, "en"));

if (workflowEntries.length === 0) failures.push(".github/workflows: no workflow files found");

for (const entry of workflowEntries) {
  const text = await readFile(join(workflowsDirectory, entry.name), "utf8");
  validateGeneralPolicy(entry.name, text);
  if (entry.name === "codeql.yml") validateCodeQl(entry.name, text);
  if (entry.name === "dependency-review.yml") validateDependencyReview(entry.name, text);
  if (entry.name === "community-preview-provenance.yml") validateCommunityPreview(entry.name, text);
}

for (const requiredWorkflow of [
  "ci.yml",
  "codeql.yml",
  "community-preview-provenance.yml",
  "dependency-review.yml"
]) {
  if (!workflowEntries.some(({ name }) => name === requiredWorkflow)) {
    failures.push(`.github/workflows: missing required workflow ${requiredWorkflow}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Workflow policy validation failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Workflow policy validation passed for ${workflowEntries.length} workflow file(s).\n`
  );
}
