#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const reportPath = join(root, "reports", production ? "level5-forensic-compliance-production-report.json" : "level5-forensic-compliance-report.json");
const failures = [];
const warnings = [];

const files = {
  forensicReport: "docs/LEKH_LEVEL5_FORENSIC_TRANSFORMATION_REPORT.md",
  engineCore: "native/macos-imk/skeleton/LekhEngineCore.swift",
  inputController: "native/macos-imk/skeleton/LekhInputController.swift",
  packageScript: "scripts/package-macos-imk-dev.mjs",
  contract: "data/engine/lekh-engine-contract.v1.json",
  neuralSota: "reports/neural-sota-worldclass-report.json",
  neuralDataset: "reports/neural-open-vocab-dataset-report.json",
  qaMatrix: "reports/macos-imk-qa-matrix-report.json",
  updateSecurity: production ? "reports/macos-update-security-production-report.json" : "reports/macos-update-security-report.json"
};

const source = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, readText(path, key === "qaMatrix" || key === "updateSecurity")]));
const neuralSota = readJson(files.neuralSota, false);
const neuralDataset = readJson(files.neuralDataset, false);
const qaMatrix = readJson(files.qaMatrix, false);
const updateSecurity = readJson(files.updateSecurity, false);

requireContains(source.forensicReport, "Until every checkbox has evidence, Lekh is not Level 5", "Forensic report must preserve evidence-before-Level-5 release gate.");
requireContains(source.forensicReport, "No hot-path I/O, XPC, network, or synchronous model inference", "Forensic report must retain hot-path no-I/O/model requirement.");
requireContains(source.engineCore, "LekhNativeTypingMode", "Native engine must expose all mode ids.");
requireContains(source.engineCore, "romanized-romanized", "Native engine must include Romanized -> Romanized mode.");
requireContains(source.engineCore, "romanized-traditional", "Native engine must include Romanized -> Nepali mode.");
requireContains(source.engineCore, "traditional-traditional", "Native engine must include Traditional -> Nepali mode.");
requireContains(source.engineCore, "traditional-romanized", "Native engine must include Traditional -> Romanized mode.");
requireContains(source.engineCore, "neural=disabled-until-async-production-model", "Native diagnostics must truthfully keep neural disabled without production artifact.");
requireContains(source.inputController, "IsSecureEventInputEnabled()", "Native controller must check secure input.");
requireContains(source.inputController, "processFailOpenKey", "Native controller must keep fail-open raw typing.");
requireContains(source.inputController, "candidateSelectionExplicit", "Candidate acceptance must be explicit.");
requireContains(source.packageScript, "const neuralModelPackaged = false", "Dev packaging must not package the old Core ML artifact.");
if (existsSync(join(root, "native", "macos-imk", "skeleton", "LekhXpcClient.swift"))) {
  failures.push("LekhXpcClient.swift must remain removed from the native hot path.");
}
if (existsSync(join(root, "native", "macos-imk", "skeleton", "LekhNeuralTransliterator.swift"))) {
  failures.push("Old LekhNeuralTransliterator.swift must remain removed until replaced by verified async Core ML tail.");
}
const contract = readJson(files.contract, false);
if (contract) {
  const modes = new Set(contract.modes ?? []);
  for (const mode of ["romanized-romanized", "romanized-traditional", "traditional-traditional", "traditional-romanized"]) {
    if (!modes.has(mode)) failures.push(`Engine contract missing mode ${mode}.`);
  }
  if (contract.candidatePolicy?.singleTokenMayExpandToPhrase !== false) failures.push("Engine contract must forbid single-token phrase expansion.");
  if (contract.candidatePolicy?.programmaticSelectionMayCommit !== false) failures.push("Engine contract must forbid programmatic candidate commit.");
}
if (Number(neuralDataset?.totalRows) < 1_000_000) failures.push("Level-5 neural data gate requires >=1,000,000 generated rows.");
if (neuralSota?.status !== "passed-phase10-sota-worldclass-guard" && !production) {
  failures.push(`Level-5 dev compliance requires Phase 10 SOTA guard to pass; got ${neuralSota?.status ?? "missing"}.`);
}
if (production) {
  if (neuralSota?.status !== "passed-production-phase10-sota-worldclass") failures.push("Production Level-5 requires Phase 10 production SOTA pass.");
  if (qaMatrix?.status !== "passed-production") failures.push(`Production Level-5 requires full host QA matrix; got ${qaMatrix?.status ?? "missing"}.`);
  if (updateSecurity?.status !== "passed-production") failures.push(`Production Level-5 requires signing/notary/update security pass; got ${updateSecurity?.status ?? "missing"}.`);
}

const status = failures.length === 0
  ? production ? "passed-production-level5-forensic-compliance" : "passed-level5-forensic-compliance-guard"
  : production ? "failed-production-level5-forensic-compliance" : "failed-level5-forensic-compliance";

finish(status, failures.length === 0 ? 0 : 1, {
  production,
  checkedFiles: files,
  neuralSotaStatus: neuralSota?.status ?? null,
  neuralSotaVerdict: neuralSota?.verdict ?? null,
  neuralDatasetRows: neuralDataset?.totalRows ?? null,
  qaMatrixStatus: qaMatrix?.status ?? null,
  updateSecurityStatus: updateSecurity?.status ?? null,
  failures,
  warnings
});

function readText(path, optional = false) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    if (!optional) failures.push(`Missing required file: ${path}.`);
    else warnings.push(`Optional report missing: ${path}.`);
    return "";
  }
  return readFileSync(fullPath, "utf8");
}

function readJson(path, optional) {
  const text = readText(path, optional);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function requireContains(text, needle, message) {
  if (!text.includes(needle)) failures.push(message);
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-level5-forensic-compliance.mjs",
    suite: "level5-forensic-compliance",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
