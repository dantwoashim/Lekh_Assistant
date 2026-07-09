#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const production = process.argv.includes("--production");
const reportPath = join(root, "reports", production ? "level5-proof-matrix-production-report.json" : "level5-proof-matrix-report.json");

const reports = {
  neuralSota: readJson("reports/neural-sota-worldclass-report.json"),
  neuralDataset: readJson("reports/neural-open-vocab-dataset-report.json"),
  neuralGoldProduction: readJson("reports/neural-gold-eval-production-report.json", true),
  nativePackage: readJson("reports/macos-imk-dev-package-report.json", true),
  unsignedCompanion: readJson("reports/macos-unsigned-package-report.json", true),
  qaMatrix: readJson("reports/macos-imk-qa-matrix-report.json", true),
  updateSecurity: readJson(production ? "reports/macos-update-security-production-report.json" : "reports/macos-update-security-report.json", true),
  level5Forensic: readJson("reports/level5-forensic-compliance-report.json", true),
  privacy: readJson("reports/native-imk-privacy-security-report.json", true)
};

const source = {
  report: readText("docs/LEKH_LEVEL5_FORENSIC_TRANSFORMATION_REPORT.md"),
  engine: readText("native/macos-imk/skeleton/LekhEngineCore.swift"),
  controller: readText("native/macos-imk/skeleton/LekhInputController.swift"),
  neuralService: readText("native/macos-imk/skeleton/LekhNeuralCandidateService.swift"),
  candidatePanel: readText("native/macos-imk/skeleton/LekhCandidatePanel.swift"),
  candidateController: readText("native/macos-imk/skeleton/LekhCandidateController.swift"),
  packageScript: readText("scripts/package-macos-imk-dev.mjs"),
  companionPackager: readText("scripts/package-macos-companion.mjs"),
  contract: readText("data/engine/lekh-engine-contract.v1.json")
};

const contract = parseJson(source.contract, "data/engine/lekh-engine-contract.v1.json");
const productionNeuralVerified = reports.neuralSota?.status === "passed-production-phase10-sota-worldclass";
const fullHostMatrix = reports.qaMatrix?.status === "passed-production";
const releaseSigning = reports.updateSecurity?.status === "passed-production";
const datasetRows = Number(reports.neuralDataset?.totalRows ?? 0);
const nativeUniversal = /x86_64 arm64/u.test(String(reports.nativePackage?.archs ?? ""));
const deterministicP99 = Number(reports.nativePackage?.deterministicP99Nanoseconds);

const items = [
  pass("architecture.hotPathEngine", "IMK hot path uses LekhEngineCore, not fake XPC or TypeScript daemon.", !exists("native/macos-imk/skeleton/LekhXpcClient.swift") && includes(source.controller, "LekhNativeEngineClient")),
  pass("architecture.contractDigest", "Canonical engine contract is bundled and checked.", exists("data/engine/lekh-engine-contract.v1.json") && includes(source.packageScript, "lekh-engine-contract.v1.json")),
  blocked("architecture.differentialConformance", "Differential Swift/TypeScript conformance is not yet exhaustive across shared event JSONL.", "Need generated Swift/TypeScript byte-identical event corpus and CI gate."),
  pass("architecture.noHotPathXpcNetworkModel", "No hot-path XPC/network/synchronous model inference is present.", !exists("native/macos-imk/skeleton/LekhNeuralTransliterator.swift") && includes(source.engine, "neural=async-coreml-tail-gated") && includes(source.neuralService, "DispatchQueue(label: \"com.lekh.inputmethod.neural-candidate-tail\"")),

  pass("typing.romanizedNepali", "Romanized to Nepali deterministic token path is present and gated.", includes(source.engine, "LekhRomanizedComposer") && includes(source.engine, "ruleCandidates(for:")),
  pass("typing.romanizedRomanized", "Romanized to Romanized mode is distinct and does not emit Devanagari by default.", contract?.modes?.includes("romanized-romanized") && includes(source.engine, "case .romanizedRomanized")),
  pass("typing.traditionalNepali", "Traditional to Nepali uses macOS layout translation/source-of-truth path.", includes(source.controller, "LekhKeyboardLayoutTranslator.shared") && exists("native/macos-imk/skeleton/LekhKeyboardLayoutTranslator.swift")),
  pass("typing.traditionalRomanized", "Traditional to Romanized reverse path is implemented.", contract?.modes?.includes("traditional-romanized") && includes(source.engine, "LekhDevanagariRomanizer")),
  pass("typing.safeStateTransitions", "State transitions are explicit and traced without raw text logging.", includes(source.controller, "lekhNativeLog") && includes(source.controller, "privacy: .private")),
  pass("typing.safeKeys", "Space/Return/Tab/Escape use guarded commit/cancel behavior.", includes(source.controller, "candidateSelectionExplicit") && includes(source.engine, "smartPunctuation(for:")),
  pass("typing.userOnlySelection", "Candidate selection origin is user-only.", includes(source.controller, "candidateSelectionExplicit") && includes(source.candidateController, "candidateForShortcut")),
  pass("typing.noPhraseAutoCommit", "Token to phrase auto-commit is forbidden.", contract?.candidatePolicy?.singleTokenMayExpandToPhrase === false && includes(source.engine, "trimmedCandidate.contains(\" \")")),
  blocked("typing.threeCandidateGold", "Three-candidate guarantee is not production-proven against a gold lexicon.", "Need reviewed gold cases declaring three legitimate alternatives."),
  pass("typing.candidateA11y", "Candidate UI has accessibility role/label/help/selected state and keyboard navigation.", includes(source.candidatePanel, "setAccessibilityRole(.button)") && includes(source.candidatePanel, "setAccessibilityLabel") && includes(source.controller, "handleCandidateCommand")),

  pass("engine.largeDataset", "Open-vocabulary dataset has >=1,000,000 generated rows.", datasetRows >= 1_000_000),
  pass("engine.modelDisabledTruthful", "Model is truly open-vocabulary with proven invocation, or gated and not marketed as production.", productionNeuralVerified || (includes(source.engine, "neural=async-coreml-tail-gated") && includes(source.packageScript, "LEKH_PACKAGE_NEURAL_MODEL"))),
  blocked("engine.productionModel", "Production neural model/data provenance and immutable hashes are incomplete.", "Need trained open-vocabulary Core ML model, manifest, hashes, predictions, and two-device benchmark."),
  blocked("engine.blindEvaluation", "Blind evaluation is not production-complete.", "Need production gold counts and leakage-audited blind evaluation."),

  pass("privacy.secureFields", "Secure fields are designed to generate no UI/model/log/persistence.", includes(source.controller, "IsSecureEventInputEnabled()") && reports.privacy?.status === "passed"),
  pass("privacy.personalizationControls", "Native personalization pause/exclusions are present.", includes(source.engine, "allowPersonalization") && includes(source.engine, "LekhUserLexiconStore")),
  blocked("privacy.packModelAdversarial", "Pack/model rollback-floor/key-rotation adversarial evidence is incomplete.", "Need LKB2/model pack adversarial test corpus and production signatures."),
  blocked("privacy.gitHistorySecrets", "No-secrets Git history scan is not recorded in this workspace report.", "Need git history/archive secret scan evidence."),

  blocked("qa.fullHostMatrix", "Required host matrix is incomplete.", `Current status: ${reports.qaMatrix?.status ?? "missing"}.`),
  nativeUniversal
    ? pass("qa.universalTargets", "Intel and Apple Silicon dev targets pass as universal package evidence.", true)
    : blocked("qa.universalTargets", "Intel and Apple Silicon dev targets pass as universal package evidence.", `Current local package archs: ${reports.nativePackage?.archs ?? "missing"}; run package with LEKH_MAC_ARCHS=arm64,x86_64 for universal evidence.`),
  blocked("qa.lifecycleRecovery", "Input-source switching/focus/sleep/wake/relaunch/crash recovery are not fully host-proven.", "Need retained host-matrix/manual evidence."),
  blocked("qa.soakPilot", "72-hour soak and multi-day pilot are not complete.", "Need 72-hour soak plus private pilot evidence."),

  blocked("release.teamIdentity", "Companion and IMK production Team ID/designated requirements are unavailable.", "Need Apple Developer ID credentials."),
  blocked("release.notarization", "Developer ID, hardened runtime, timestamp, notarization, stapling, Gatekeeper are not complete.", "Need signed/notarized production artifacts."),
  pass("release.stagedDevInstall", "Dev install/package path is staged and clearly non-production.", reports.nativePackage?.status === "passed-adhoc-release"),
  blocked("release.updateRollbackUninstall", "Production update/rollback/uninstall evidence is incomplete.", "Need signed N-1 to N update, forced rollback, uninstall evidence."),
  pass("release.abcRecovery", "ABC/system keyboard recovery scripts are present.", exists("native/macos-imk/skeleton/restore-system-keyboard.sh")),
  blocked("release.sbomClaims", "Production SBOM/licenses/public claims are not final for a shipped artifact.", "Need final signed artifact SBOM and release manifest.")
];

const failed = items.filter((item) => item.status === "failed");
const blockedItems = items.filter((item) => item.status === "blocked");
const productionFailures = production ? [...failed, ...blockedItems] : failed;
const status = productionFailures.length === 0
  ? production ? "passed-production-level5-proof-matrix" : "passed-level5-proof-matrix-with-blockers"
  : production ? "failed-production-level5-proof-matrix" : "failed-level5-proof-matrix";

finish(status, productionFailures.length === 0 ? 0 : 1, {
  production,
  summary: {
    total: items.length,
    passed: items.filter((item) => item.status === "passed").length,
    blocked: blockedItems.length,
    failed: failed.length
  },
  deterministicP99Nanoseconds: Number.isFinite(deterministicP99) ? deterministicP99 : null,
  datasetRows,
  productionNeuralVerified,
  fullHostMatrix,
  releaseSigning,
  items
});

function pass(id, requirement, condition, evidence = "") {
  return condition
    ? { id, requirement, status: "passed", evidence: evidence || "source/report evidence present" }
    : { id, requirement, status: "failed", evidence: evidence || "required source/report marker missing" };
}

function blocked(id, requirement, blocker) {
  return { id, requirement, status: "blocked", blocker };
}

function exists(path) {
  return existsSync(join(root, path));
}

function includes(text, needle) {
  return String(text ?? "").includes(needle);
}

function readText(path) {
  const fullPath = join(root, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function readJson(path, optional = false) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    if (!optional) return null;
    return null;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: label };
  }
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-level5-proof-matrix.mjs",
    suite: "level5-proof-matrix",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status,
    report: relative(root, reportPath),
    summary: report.summary
  }, null, 2));
  process.exit(exitCode);
}
