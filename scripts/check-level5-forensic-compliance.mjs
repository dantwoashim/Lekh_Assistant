#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
  trustedAttestationBindsReport,
  verifyProductionReleaseAttestation
} from "./lib/macos-production-release-attestation.mjs";

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
  ghostHostProbe: "scripts/check-macos-imk-host-ghost.mjs",
  neuralService: "native/macos-imk/skeleton/LekhNeuralCandidateService.swift",
  packageScript: "scripts/package-macos-imk-dev.mjs",
  companionApp: "native/macos-companion/LekhCompanionApp.swift",
  companionModel: "native/macos-companion/LekhCompanionModel.swift",
  companionPackager: "scripts/package-native-macos-companion.mjs",
  contract: "data/engine/lekh-engine-contract.v1.json",
  neuralSota: production ? "reports/neural-sota-worldclass-production-report.json" : "reports/neural-sota-worldclass-report.json",
  neuralDataset: production ? "reports/neural-open-vocab-dataset-production-report.json" : "reports/neural-open-vocab-dataset-report.json",
  qaMatrix: "reports/macos-imk-qa-matrix-report.json",
  updateSecurity: production ? "reports/macos-update-security-production-report.json" : "reports/macos-update-security-report.json"
};

const source = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, readText(path, key === "qaMatrix" || key === "updateSecurity")]));
const neuralSota = readJson(files.neuralSota, false);
const neuralDataset = readJson(files.neuralDataset, false);
const qaMatrix = readJson(files.qaMatrix, false);
const updateSecurity = readJson(files.updateSecurity, false);
const trustedReleaseAttestation = production ? verifyProductionReleaseAttestation({ root }) : null;
const bound = (path) => !production || trustedAttestationBindsReport(trustedReleaseAttestation, path, root);

requireContains(source.forensicReport, "Until every checkbox has evidence, Lekh is not Level 5", "Forensic report must preserve evidence-before-Level-5 release gate.");
requireContains(source.forensicReport, "No hot-path I/O, XPC, network, or synchronous model inference", "Forensic report must retain hot-path no-I/O/model requirement.");
requireContains(source.engineCore, "LekhNativeTypingMode", "Native engine must expose all mode ids.");
requireContains(source.engineCore, "romanized-romanized", "Native engine must include Romanized -> Romanized mode.");
requireContains(source.engineCore, "romanized-traditional", "Native engine must include Romanized -> Nepali mode.");
requireContains(source.engineCore, "traditional-traditional", "Native engine must include Traditional -> Nepali mode.");
requireContains(source.engineCore, "traditional-romanized", "Native engine must include Traditional -> Romanized mode.");
requireContains(source.engineCore, "LekhNeuralCandidateService.shared.status", "Native diagnostics must truthfully report the async Core ML neural tail status.");
requireContains(source.inputController, "IsSecureEventInputEnabled()", "Native controller must check secure input.");
requireContains(source.inputController, "requestAsyncNeuralCandidates", "Native controller must integrate async neural candidate refresh off the deterministic hot path.");
requireContains(source.inputController, "processFailOpenKey", "Native controller must keep fail-open raw typing.");
requireContains(source.inputController, "candidateSelectionExplicit", "Candidate acceptance must be explicit.");
requireContains(source.inputController, "scheduleCompositionSurfaces", "Candidate and ghost surfaces must wait for host marked-range geometry.");
requireContains(source.inputController, "surfaceRenderGeneration", "Deferred composition surfaces must reject stale generations.");
requireContains(source.inputController, "key == lekhArrowRightKey, let suggestion = visibleInlineSuggestion(for: client)", "Right Arrow must accept only an on-screen, current-client inline completion.");
requireContains(source.inputController, "commitCandidateText(suggestion.acceptedText", "Tab/Right Arrow ghost acceptance must commit the engine-owned target.");
requireContains(source.engineCore, "LekhInlineSuggestion", "The native engine must own the inline suggestion contract.");
requireContains(source.ghostHostProbe, "assert-ghost-window", "The host proof must verify a separate on-screen ghost window.");
requireContains(source.ghostHostProbe, "assert-tab-acceptance", "The host proof must verify Tab accepts the ghost without inserting a tab.");
requireContains(source.neuralService, "DispatchQueue(label: \"com.lekh.inputmethod.neural-candidate-tail\"", "Native neural service must run Core ML inference asynchronously.");
requireContains(source.neuralService, "guard !secureInputActive else", "Native neural service must never infer in secure fields.");
requireContains(source.neuralService, "failOpenRawTypingOnError", "Native neural service must fail open on inference errors.");
requireContains(source.neuralService, "LekhExperimentalNeuralTypingEnabled", "Experimental neural typing must be explicit and bundle-gated.");
requireContains(source.packageScript, "LEKH_PACKAGE_NEURAL_MODEL", "Dev packaging must keep Core ML neural resources behind an explicit opt-in flag.");
requireContains(source.packageScript, "neuralPackagingRequested", "Dev packaging must not silently package the Core ML artifact.");
requireContains(source.companionApp, "NavigationSplitView", "The macOS companion must use a native settings hierarchy.");
requireContains(source.companionApp, "accessibilityReduceTransparency", "The native companion must adapt to system accessibility appearance.");
requireContains(source.companionModel, "TISCreateInputSourceList", "The native companion must read real input-source state.");
requireContains(source.companionModel, "LekhExcludedApplicationBundleIdentifiers", "The native companion must expose application-specific learning exclusions.");
requireContains(source.companionPackager, 'for (const arch of ["arm64", "x86_64"])', "The native companion packager must build a universal app.");
if (source.companionPackager.includes("electron-builder")) {
  failures.push("The production macOS companion packager must not embed Electron.");
}
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
  if (contract.candidatePolicy?.commitAuthority?.explicitUserSelection !== true) failures.push("Engine contract must authorize explicit user selection.");
  if (contract.candidatePolicy?.commitAuthority?.untrustedProgrammaticSelection !== false) failures.push("Engine contract must forbid untrusted programmatic candidate commit.");
  if (contract.candidatePolicy?.commitAuthority?.experimentalExactSpaceAuthorization?.productionEligible !== false) {
    failures.push("Engine contract must keep experimental exact-Space authorization out of production.");
  }
}
if (Number(neuralDataset?.totalRows) < 1_000_000) failures.push("Level-5 neural data gate requires >=1,000,000 generated rows.");
if (neuralSota?.status !== "passed-phase10-sota-worldclass-guard" && !production) {
  failures.push(`Level-5 dev compliance requires Phase 10 SOTA guard to pass; got ${neuralSota?.status ?? "missing"}.`);
}
if (production) {
  if (trustedReleaseAttestation?.verified !== true) {
    failures.push(`Production Level-5 requires trusted release attestation; issues: ${trustedReleaseAttestation?.issueCodes?.join(",") || "unverified"}.`);
  }
  if (neuralSota?.status !== "passed-production-phase10-sota-worldclass" || !bound(files.neuralSota)) failures.push("Production Level-5 requires an attested Phase 10 production SOTA pass.");
  if (qaMatrix?.status !== "passed-production" || !bound(files.qaMatrix)) failures.push(`Production Level-5 requires an attested full host QA matrix; got ${qaMatrix?.status ?? "missing"}.`);
  if (updateSecurity?.status !== "passed-production" || !bound(files.updateSecurity)) failures.push(`Production Level-5 requires an attested signing/notary/update security pass; got ${updateSecurity?.status ?? "missing"}.`);
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
  trustedReleaseAttestation: {
    verified: trustedReleaseAttestation?.verified === true,
    issueCodes: trustedReleaseAttestation?.issueCodes ?? []
  },
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
