#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const evidenceRoot = join(root, "reports", "qa", "macos-imk");
const reportPath = join(root, "reports", "macos-imk-qa-matrix-report.json");

const apps = [
  "TextEdit",
  "Notes",
  "Safari",
  "Chrome",
  "Messages",
  "Mail",
  "WhatsApp Desktop",
  "VS Code",
  "Microsoft Word",
  "Google Docs",
  "Spotlight",
  "Password Fields",
  "Slack",
  "Terminal"
];

const cases = [
  "romanized-word-swasthya",
  "romanized-phrase",
  "mixed-english-nepali",
  "protected-token",
  "traditional-input",
  "backspace-composition",
  "escape-cancel",
  "enter-commit",
  "tab-candidate-or-focus",
  "space-commit",
  "command-shortcuts-pass-through",
  "input-source-switching",
  "daemon-down-fallback",
  "daemon-restart",
  "sleep-wake",
  "app-restart",
  "logout-login",
  "uninstall-reinstall",
  "secure-field-no-memory"
];

const macTargets = [
  "macOS 13 Apple Silicon",
  "macOS 14 Apple Silicon",
  "macOS 15 Apple Silicon",
  "macOS 13 Intel",
  "macOS 14 Intel",
  "macOS 15 Intel"
];

const expectedEvidence = [];
for (const app of apps) {
  for (const testCase of cases) {
    expectedEvidence.push({
      app,
      case: testCase,
      evidence: evidenceFiles(app, testCase)
    });
  }
}

const missing = expectedEvidence.filter((row) => row.evidence.length === 0);
const present = expectedEvidence.length - missing.length;
const status = production && missing.length > 0 ? "failed-missing-host-evidence" : "passed-dev-matrix-defined";

const report = {
  generatedAt: new Date().toISOString(),
  command: production
    ? "node scripts/check-macos-imk-qa-matrix.mjs --production"
    : "node scripts/check-macos-imk-qa-matrix.mjs",
  suite: "macos-imk-host-qa-matrix",
  durationMs: Math.round(performance.now() - startedAt),
  status,
  production,
  apps,
  cases,
  macTargets,
  expectedTestCountPerTarget: apps.length * cases.length,
  expectedTotalAcrossTargets: apps.length * cases.length * macTargets.length,
  evidenceRoot: "reports/qa/macos-imk",
  evidenceSummary: {
    present,
    missing: missing.length,
    total: expectedEvidence.length
  },
  requiredEvidenceFormat: {
    path: "reports/qa/macos-imk/<app-slug>/<case-slug>.json",
    fields: ["app", "case", "macOSVersion", "architecture", "inputSource", "steps", "expected", "actual", "pass", "artifacts", "logPaths"]
  },
  manualReleaseGate: "Production release is blocked until every app/case passes on supported macOS and architecture targets with screenshot or video evidence where useful.",
  missing: missing.slice(0, 100)
};

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (status.startsWith("failed")) {
  console.error(JSON.stringify({ status, report: "reports/macos-imk-qa-matrix-report.json", missing: missing.length }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status, report: "reports/macos-imk-qa-matrix-report.json", evidence: report.evidenceSummary }, null, 2));

function evidenceFiles(app, testCase) {
  const dir = join(evidenceRoot, slug(app));
  if (!existsSync(dir)) return [];
  const caseSlug = slug(testCase);
  return readdirSync(dir)
    .filter((file) => file === `${caseSlug}.json` || file.startsWith(`${caseSlug}.`))
    .map((file) => join("reports", "qa", "macos-imk", slug(app), file));
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
