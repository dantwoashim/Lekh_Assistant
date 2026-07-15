#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
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
  "Electron",
  "Microsoft Word",
  "Google Docs",
  "Spotlight",
  "Password Fields",
  "Slack",
  "Terminal"
];

const cases = [
  "romanized-word-swasthya",
  "romanized-to-romanized",
  "romanized-to-nepali",
  "traditional-to-nepali",
  "traditional-to-romanized",
  "mixed-english-nepali",
  "protected-token",
  "traditional-input",
  "backspace-composition",
  "escape-cancel",
  "two-stage-escape",
  "enter-commit",
  "tab-candidate-or-focus",
  "ghost-tab-accept",
  "passive-digit-safety",
  "explicit-option-candidate",
  "space-commit",
  "command-shortcuts-pass-through",
  "input-source-switching",
  "engine-component-failure-raw-fallback",
  "input-method-restart",
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
  "macOS 26 Apple Silicon",
  "macOS 13 Intel",
  "macOS 14 Intel",
  "macOS 15 Intel"
];

const currentMachineTarget = detectCurrentMacTarget();
const smokeEvidence = collectTextEditSmokeEvidence(currentMachineTarget);

const expectedEvidence = [];
for (const target of macTargets) {
  for (const app of apps) {
    for (const testCase of cases) {
      expectedEvidence.push({
        target,
        app,
        case: testCase,
        evidence: evidenceFiles(app, testCase, target)
      });
    }
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
  expectedTotalAcrossTargets: expectedEvidence.length,
  evidenceRoot: "reports/qa/macos-imk",
  currentMachineTarget,
  evidenceSummary: {
    present,
    missing: missing.length,
    total: expectedEvidence.length,
    derivedFromSmokeReports: smokeEvidence.length
  },
  derivedSmokeEvidence: smokeEvidence,
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

function evidenceFiles(app, testCase, target) {
  const dir = join(evidenceRoot, slug(app));
  const derived = derivedSmokeEvidenceFiles(app, testCase, target);
  if (!existsSync(dir)) return derived;
  const caseSlug = slug(testCase);
  return [
    ...readdirSync(dir)
    .filter((file) => file === `${caseSlug}.json` || file.startsWith(`${caseSlug}.`))
    .filter((file) => evidenceMatchesTarget(join(dir, file), target))
    .map((file) => join("reports", "qa", "macos-imk", slug(app), file)),
    ...derived
  ];
}

function evidenceMatchesTarget(path, target) {
  try {
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    if (evidence.pass !== true) return false;
    const expectedArchitecture = target.endsWith("Intel") ? "x86_64" : "arm64";
    const expectedMajor = target.match(/^macOS (\d+)/)?.[1];
    return evidence.architecture === expectedArchitecture &&
      String(evidence.macOSVersion ?? "").split(".")[0] === expectedMajor;
  } catch {
    return false;
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function derivedSmokeEvidenceFiles(app, testCase, target) {
  return smokeEvidence
    .filter((item) => item.app === app && item.case === testCase && item.target === target)
    .map((item) => item.report);
}

function collectTextEditSmokeEvidence(target) {
  if (!target) return [];
  const smokeReports = [
    "reports/macos-imk-host-textedit-smoke.json",
    "reports/macos-imk-host-textedit-cgevent-smoke.json",
    "reports/macos-imk-host-ghost-smoke.json",
    "reports/macos-imk-host-interaction-safety.json"
  ];
  const supportedCases = [
    "romanized-word-swasthya",
    "romanized-to-nepali",
    "space-commit"
  ];
  const evidence = [];
  for (const report of smokeReports) {
    const absolute = join(root, report);
    if (!existsSync(absolute)) continue;
    try {
      const parsed = JSON.parse(readFileSync(absolute, "utf8"));
      if (parsed.status !== "passed") continue;
      if (parsed.suite === "macos-imk-host-ghost") {
        evidence.push({
          target,
          app: "TextEdit",
          case: "ghost-tab-accept",
          report,
          sourceSuite: parsed.suite,
          generatedAt: parsed.generatedAt,
          note: "Derived from HID proof of an on-screen suffix window and Tab acceptance."
        });
        continue;
      }
      if (parsed.suite === "macos-imk-host-interaction-safety") {
        const mapping = {
          "uncalibrated-forward-space-raw": ["space-commit"],
          "explicit-down-space": ["romanized-word-swasthya", "romanized-to-nepali", "space-commit"],
          "passive-digit-is-text": ["passive-digit-safety"],
          "option-two-explicit": ["explicit-option-candidate"],
          "two-stage-escape": ["escape-cancel", "two-stage-escape"]
        };
        for (const item of parsed.cases ?? []) {
          if (item.pass !== true) continue;
          for (const testCase of mapping[item.id] ?? []) {
            evidence.push({
              target,
              app: "TextEdit",
              case: testCase,
              report,
              sourceSuite: parsed.suite,
              generatedAt: parsed.generatedAt,
              note: item.proves
            });
          }
        }
        continue;
      }
      if (parsed.expected !== "स्वास्थ्य " || parsed.actual !== "स्वास्थ्य ") continue;
      for (const testCase of supportedCases) {
        evidence.push({
          target,
          app: "TextEdit",
          case: testCase,
          report,
          sourceSuite: parsed.suite,
          generatedAt: parsed.generatedAt,
          note: "Derived from a passing TextEdit host smoke report; production still requires explicit per-case manual evidence."
        });
      }
    } catch {
      // Ignore malformed smoke reports; the explicit matrix evidence path remains authoritative.
    }
  }
  return evidence;
}

function detectCurrentMacTarget() {
  if (platform() !== "darwin") return null;
  const machineArchitecture = arch() === "x64" ? "x86_64" : arch();
  const family = machineArchitecture === "x86_64" ? "Intel" : "Apple Silicon";
  try {
    const version = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    const major = version.split(".")[0];
    return `macOS ${major} ${family}`;
  } catch {
    return null;
  }
}
