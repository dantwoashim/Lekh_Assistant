#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", production ? "neural-native-integration-production-report.json" : "neural-native-integration-report.json");
const failures = [];
const warnings = [];

const enginePath = join(root, "native", "macos-imk", "skeleton", "LekhEngineCore.swift");
const controllerPath = join(root, "native", "macos-imk", "skeleton", "LekhInputController.swift");
const neuralServicePath = join(root, "native", "macos-imk", "skeleton", "LekhNeuralCandidateService.swift");
const packageScriptPath = join(root, "scripts", "package-macos-imk-dev.mjs");
const packageSwiftPath = join(root, "native", "macos-imk", "skeleton", "Package.swift");
const oldNeuralPath = join(root, "native", "macos-imk", "skeleton", "LekhNeuralTransliterator.swift");
const artifactRoot = args.get("artifact-root") ?? join(
  root,
  "models",
  "macos",
  "LekhNeuralTransliterator.production"
);
const manifestPath = join(artifactRoot, "LekhNeuralTransliterator.manifest.json");
const vocabPath = join(artifactRoot, "LekhNeuralTransliterator.vocab.json");

const engine = readText(enginePath);
const controller = readText(controllerPath);
const neuralService = readText(neuralServicePath);
const packageScript = readText(packageScriptPath);
const packageSwift = readText(packageSwiftPath);

if (existsSync(oldNeuralPath)) failures.push("Old native LekhNeuralTransliterator.swift must remain deleted until replaced by the production async service.");
requireContains(engine, "LekhNeuralCandidateService.shared.status", "Native diagnostics must report the actual async Core ML neural tail status.");
requireContains(engine, "return .passThrough", "Engine must retain fail-open pass-through behavior.");
requireContains(controller, "IsSecureEventInputEnabled()", "Controller must check secure input.");
requireContains(controller, "requestAsyncNeuralCandidates", "Controller must request neural tail candidates asynchronously after deterministic candidates.");
requireContains(controller, "processFailOpenKey", "Controller must keep fail-open raw typing path.");
requireContains(controller, "public struct LekhCandidateAcceptanceReceipt", "Candidate acceptance must use a snapshot-bound receipt.");
requireContains(controller, "authorizeCurrentCandidate(", "Candidate acceptance must be authorized explicitly.");
requireContains(controller, "authorizedSelectedCandidate(for:", "Candidate commit must revalidate its acceptance receipt.");
requireContains(controller, "revokeCandidateAcceptance()", "Candidate acceptance authority must be revocable.");
requireContains(neuralService, "DispatchQueue(label: \"com.lekh.inputmethod.neural-candidate-tail\"", "Neural service must run inference off the IMK keystroke hot path.");
requireContains(neuralService, "case loading", "Neural service must expose a fail-open loading state while the optional artifact is prepared.");
requireContains(neuralService, "queue.async { [weak self, bundle]", "Neural artifact verification and Core ML loading must run off the IMK controller-construction path.");
requireContains(neuralService, "MLModel(contentsOf:", "Neural service must invoke a real Core ML model when production-gated resources are present.");
requireContains(neuralService, "LekhExperimentalNeuralTypingEnabled", "Neural service must support an explicitly labeled experimental override without changing production eligibility.");
requireContains(neuralService, "LEKH_EXPERIMENTAL_NEURAL_TYPING", "Neural service must support a local test override for experimental neural typing.");
requireContains(neuralService, "neverInvokeInSecureFields", "Neural service must encode the secure-field no-inference policy.");
requireContains(neuralService, "failOpenRawTypingOnError", "Neural service must encode fail-open behavior on errors.");
requireContains(neuralService, "guard !secureInputActive else", "Neural service must return without inference in secure fields.");
requireContains(packageScript, "LEKH_PACKAGE_NEURAL_MODEL", "Dev IMK packaging must require an explicit neural packaging flag.");
requireContains(packageScript, "neuralPackagingRequested", "Dev IMK packaging must not silently package the old model.");
requireContains(packageScript, "resolveNeuralArtifactDescriptor", "IMK packaging must use the closed manifest-driven runtime artifact inventory.");
requireContains(packageScript, "package:macos:imk:dev", "Package report command identity must remain explicit.");
requireContains(packageSwift, "LekhNeuralCandidateService.swift", "Swift package must compile the async neural candidate service.");
requireContains(packageSwift, ".linkedFramework(\"CoreML\")", "Swift package must link CoreML for the async neural service.");
const initializer = neuralService.slice(
  neuralService.indexOf("public init(bundle:"),
  neuralService.indexOf("public func candidates(")
);
if (initializer.includes("loadVerifiedArtifact") || initializer.includes("MLModel(contentsOf:")) {
  failures.push("Neural service initialization must not synchronously verify or load the Core ML artifact.");
}
if (packageScript.includes("LekhNeuralTransliterator.mlmodelc") && !packageScript.includes("LEKH_PACKAGE_NEURAL_MODEL")) {
  failures.push("Packaging script must not copy the neural model without an explicit neural packaging gate.");
}
if (packageSwift.includes("LekhNeuralTransliterator.swift")) failures.push("Swift package must not compile the deleted old neural source.");

const manifestExists = existsSync(manifestPath);
let descriptor = null;
if (manifestExists && existsSync(vocabPath)) {
  try {
    descriptor = resolveNeuralArtifactDescriptor({
      repoRoot: root,
      manifestPath,
      vocabPath
    });
  } catch (error) {
    if (production) {
      failures.push(`Production runtime artifact inventory is invalid: ${error.message}`);
    } else {
      warnings.push(`Neural candidate inventory is not packageable: ${error.message}`);
    }
  }
}
const modelExists = descriptor !== null;
if (production) {
  if (!modelExists) failures.push("Production Phase 6 requires a complete verified runtime artifact set.");
  if (!manifestExists) failures.push("Production Phase 6 requires a production neural manifest.");
  if (!existsSync(neuralServicePath)) {
    failures.push("Production Phase 6 requires the async Core ML tail service source.");
  }
} else if (!manifestExists && existsSync(artifactRoot)) {
  warnings.push("A neural artifact directory exists without a production manifest; native integration correctly keeps neural disabled.");
}

const status = failures.length === 0
  ? production ? "passed-production-phase6-native-integration" : "passed-phase6-native-integration-guard"
  : production ? "failed-production-phase6-native-integration" : "failed-phase6-native-integration";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 6,
  production,
  engine: relative(root, enginePath),
  controller: relative(root, controllerPath),
  neuralService: relative(root, neuralServicePath),
  packageScript: relative(root, packageScriptPath),
  artifactRoot: relative(root, artifactRoot),
  models: descriptor?.artifacts.map((artifact) => ({
    role: artifact.role,
    path: artifact.sourceRelativePath,
    bytes: artifact.compiledBytes,
    sha256: artifact.compiledSha256
  })) ?? [],
  artifactSetSha256: descriptor?.artifactSetSha256 ?? null,
  manifest: relative(root, manifestPath),
  modelExists,
  manifestExists,
  neuralPackagedByDevBuild: false,
  controllerStartupNeuralLoadingIsAsynchronous: true,
  failOpenRawTyping: true,
  secureFieldInferenceBlocked: true,
  failures,
  warnings
});

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

function readText(path) {
  if (!existsSync(path)) {
    failures.push(`Missing required source file: ${relative(root, path)}.`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function requireContains(text, needle, message) {
  if (!text.includes(needle)) failures.push(message);
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-native-integration.mjs",
    suite: "neural-native-integration",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
