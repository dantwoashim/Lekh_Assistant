#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", "neural-review-intake-report.json");
const templatePath = join(root, "data", "neural", "review", "private-source-manifest.example.json");
const privateManifestPath = args.get("manifest") ?? join(root, "data", "private", "neural", "review-sources", "manifest.json");
const failures = [];
const warnings = [];

const template = readJson(templatePath, "review intake template");
const privateManifest = existsSync(privateManifestPath)
  ? readJson(privateManifestPath, "private review manifest")
  : null;

validateManifestShape(template, "template");
if (!privateManifest) {
  if (production) failures.push("Production Phase 7 requires data/private/neural/review-sources/manifest.json.");
  else warnings.push("No private review manifest found; Phase 7 contract is ready, but reviewed rows have not been imported.");
} else {
  validateManifestShape(privateManifest, "private manifest");
}

const manifestToCheck = privateManifest ?? template;
const sourceReports = [];
for (const source of manifestToCheck?.sources ?? []) {
  const sourceReport = checkSource(source, Boolean(privateManifest));
  sourceReports.push(sourceReport);
}

const status = failures.length === 0
  ? privateManifest
    ? production ? "passed-production-phase7-review-intake" : "passed-phase7-review-intake-with-private-sources"
    : "passed-phase7-review-intake-contract"
  : production ? "failed-production-phase7-review-intake" : "failed-phase7-review-intake";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 7,
  production,
  template: relative(root, templatePath),
  privateManifest: existsSync(privateManifestPath) ? relative(root, privateManifestPath) : null,
  sourceReports,
  failures,
  warnings
});

function checkSource(source, requireFile) {
  const path = join(root, source.path);
  const report = {
    id: source.id,
    path: source.path,
    exists: existsSync(path),
    rows: 0,
    categories: {},
    reviewTiers: {},
    licenses: {}
  };
  if (!existsSync(path)) {
    if (production || requireFile) failures.push(`Missing private review source file: ${source.path}.`);
    return report;
  }
  for (const [lineIndex, line] of readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      failures.push(`${source.path}:${lineIndex + 1} invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    report.rows += 1;
    bump(report.categories, row.category);
    bump(report.reviewTiers, row.reviewTier);
    bump(report.licenses, row.license);
    if (row.source !== source.id) failures.push(`${source.path}:${lineIndex + 1} source must be ${source.id}.`);
    if (!source.allowedCategories.includes(row.category)) failures.push(`${source.path}:${lineIndex + 1} category ${row.category} is not allowed for ${source.id}.`);
    if (!source.requiredReviewTiers.includes(row.reviewTier)) failures.push(`${source.path}:${lineIndex + 1} reviewTier ${row.reviewTier} is not sufficient for ${source.id}.`);
    if (row.license !== source.license) failures.push(`${source.path}:${lineIndex + 1} license must be ${source.license}.`);
    if (row.input !== String(row.input ?? "").normalize("NFC")) failures.push(`${source.path}:${lineIndex + 1} input must be NFC.`);
    if (/\s/u.test(String(row.input ?? ""))) failures.push(`${source.path}:${lineIndex + 1} input must be a single token.`);
  }
  if (production && report.rows < Number(source.minimumRows)) {
    failures.push(`Production Phase 7 source ${source.id} requires at least ${source.minimumRows} rows; found ${report.rows}.`);
  }
  return report;
}

function validateManifestShape(manifest, label) {
  if (!manifest) return;
  if (manifest.schemaVersion !== 1) failures.push(`${label} schemaVersion must be 1.`);
  if (manifest.phase !== "phase7-human-review-intake") failures.push(`${label} phase must be phase7-human-review-intake.`);
  if (manifest.rawDataCommitted !== false) failures.push(`${label} must declare rawDataCommitted=false.`);
  const ids = new Set();
  for (const source of manifest.sources ?? []) {
    if (ids.has(source.id)) failures.push(`${label} duplicate source id ${source.id}.`);
    ids.add(source.id);
    for (const key of ["id", "path", "minimumRows", "allowedCategories", "requiredReviewTiers", "license"]) {
      if (source[key] === undefined) failures.push(`${label} source ${source.id ?? "<missing>"} missing ${key}.`);
    }
  }
  for (const required of ["human-reviewed-lekh-gold-v1", "lekh-chat-conventions-v1", "lekh-name-lexicon-v1"]) {
    if (!ids.has(required)) failures.push(`${label} missing required source ${required}.`);
  }
}

function parseArgs(argv) {
  const map = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1]?.startsWith("--") ? "1" : argv[index + 1] ?? "1";
    map.set(key, value);
    if (value !== "1") index += 1;
  }
  return map;
}

function readJson(path, label) {
  if (!existsSync(path)) {
    failures.push(`Missing ${label}: ${relative(root, path)}.`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function bump(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-review-intake.mjs",
    suite: "neural-review-intake",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
