import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const violations: string[] = [];
const ignoredRawRoots = [
  "data/user-submitted/raw",
  "data/user-submitted/private",
  "bench/private",
  "competitor/raw"
];
const fixtureRoot = join(root, "data/user-submitted/fixtures");
const metadataRoot = join(root, "data/user-submitted/metadata");
const requiredMetadataFields = [
  "documentId",
  "contributorNameOrAlias",
  "consentStatement",
  "consentDate",
  "allowedUse",
  "redistributionPermission",
  "redactionStatus",
  "piiStatus",
  "sourceFontProfile",
  "receivedBy",
  "reviewer",
  "notes"
];

try {
  for (const tracked of gitTrackedFiles(ignoredRawRoots)) {
    if (!tracked.endsWith(".gitignore")) {
      violations.push(`Raw/private user-data path is tracked: ${tracked}`);
    }
  }
} catch (error) {
  violations.push(error instanceof Error ? error.message : String(error));
}

const consentIds = new Set<string>();
if (existsSync(metadataRoot)) {
  for (const file of collectFiles(metadataRoot).filter((path) => path.endsWith(".json") && !path.endsWith("consent.schema.json"))) {
    const data = readJson(file);
    for (const field of requiredMetadataFields) {
      if (!(field in data)) violations.push(`${relative(root, file)} missing consent metadata field: ${field}`);
    }
    if (typeof data.documentId === "string") consentIds.add(data.documentId);
  }
}

if (existsSync(fixtureRoot)) {
  for (const file of collectFiles(fixtureRoot).filter((path) => /\.(json|jsonl|txt)$/i.test(path))) {
    const content = readFileSync(file, "utf8");
    if (hasObviousPii(content)) violations.push(`${relative(root, file)} contains an obvious PII-like pattern.`);
    if (file.endsWith(".jsonl")) {
      for (const line of content.split(/\n/).filter(Boolean)) {
        const fixture = JSON.parse(line) as Record<string, unknown>;
        assertFixtureConsent(file, fixture, consentIds);
      }
    } else if (file.endsWith(".json")) {
      const parsed = JSON.parse(content) as unknown;
      const fixtures = Array.isArray(parsed) ? parsed : [parsed];
      for (const fixture of fixtures) assertFixtureConsent(file, fixture as Record<string, unknown>, consentIds);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("User-data safety check passed: no tracked raw/private files, missing consent references, or obvious fixture PII found.");

function assertFixtureConsent(file: string, fixture: Record<string, unknown>, consentIds: Set<string>) {
  if (Object.keys(fixture).length === 0) return;
  const consentId = fixture.consentId;
  if (typeof consentId !== "string") {
    violations.push(`${relative(root, file)} fixture missing consentId.`);
    return;
  }
  if (!consentIds.has(consentId)) {
    violations.push(`${relative(root, file)} fixture references unknown consentId: ${consentId}`);
  }
}

function gitTrackedFiles(paths: string[]): string[] {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8", stdio: "pipe" });
    return execFileSync("git", ["ls-files", ...paths], { cwd: root, encoding: "utf8" })
      .split(/\n/)
      .filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`User-data safety check requires Git metadata or a release manifest; failing closed because Git inspection failed. ${message}`);
  }
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stat = statSync(path);
    return stat.isDirectory() ? collectFiles(path) : [path];
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function hasObviousPii(content: string): boolean {
  const piiPatterns = [
    /\b(?:98|97)\d{8}\b/,
    /\b\d{2}-\d{2}-\d{2}-\d{5}\b/,
    /\b\d{10,}\b/,
    /citizenship\s*(?:no|number)/i,
    /signature/i
  ];
  return piiPatterns.some((pattern) => pattern.test(content));
}
