#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = args.get("report") ?? join(root, "reports", "neural-training-contract-report.json");
const configPath = args.get("config") ?? join(root, "data", "neural", "training", "open-vocab-seq2seq-v1.config.json");
const manifestPath = args.get("manifest") ?? join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const modelDir = args.get("model") ?? join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const graphPath = join(modelDir, "model.espresso.net");
const failures = [];
const warnings = [];

const config = readJsonIfExists(configPath, "training config");
let manifest = null;
if (!config) failures.push("Missing Phase 4 training/export config.");

if (config) {
  requireEqual(config.modelId, "lekh-open-vocab-seq2seq-v1", "Config modelId must match the frozen production artifact id.");
  requireEqual(config.artifact?.compiledModel, "models/macos/LekhNeuralTransliterator.mlmodelc", "Config must export the compiled model to models/macos/LekhNeuralTransliterator.mlmodelc.");
  requireEqual(config.artifact?.manifest, "models/macos/LekhNeuralTransliterator.manifest.json", "Config must export the production manifest to models/macos/LekhNeuralTransliterator.manifest.json.");
  requireEqual(config.artifact?.runtime, "CoreML", "Config runtime must be CoreML.");
  requireEqual(config.artifact?.localOnly, true, "Config must be local-only.");
  requireEqual(config.artifact?.neuralTailOnly, true, "Config must be neural-tail-only.");
  requireEqual(config.architecture?.openVocabulary, true, "Config must describe an open-vocabulary model.");
  if (!/(gru|transformer|seq2seq|encoder-decoder)/i.test(String(config.architecture?.family ?? ""))) {
    failures.push("Config architecture family must be GRU/Transformer seq2seq.");
  }
  const estimatedParams = Number(config.architecture?.estimatedParameterCount);
  if (!Number.isFinite(estimatedParams) || estimatedParams < 1_000_000 || estimatedParams > 5_000_000) {
    failures.push("Config estimatedParameterCount must be between 1M and 5M.");
  }
  if (Number(config.architecture?.maximumCompiledBytes) !== 16_777_216) failures.push("Config maximumCompiledBytes must be 16,777,216.");
  requireEqual(config.decoder?.type, "beam-search", "Config decoder type must be beam-search.");
  if (Number(config.decoder?.beamWidth) < 2 || Number(config.decoder?.beamWidth) > 8) failures.push("Config beamWidth must be 2..8.");
  requireEqual(config.decoder?.rejectWhitespaceOutput, true, "Config must reject whitespace outputs.");
  requireEqual(config.decoder?.rejectLatinOutput, true, "Config must reject Latin outputs.");
  requireEqual(config.decoder?.autoCommitEligible, false, "Neural candidates must never be auto-commit eligible.");
  if (Number(config.context?.previousWords) < 2) failures.push("Config must include at least 2 previous context words.");
  requireEqual(config.context?.languageModelRescorer?.enabled, true, "Config must enable language model rescoring.");
  for (const requiredSource of ["syubraj-roman2nepali-transliteration", "human-reviewed-lekh-gold-v1", "lekh-chat-conventions-v1", "lekh-name-lexicon-v1"]) {
    if (!config.training?.requiredSources?.includes(requiredSource)) {
      failures.push(`Config missing required training source ${requiredSource}.`);
    }
  }
}

const modelExists = existsSync(modelDir);
const manifestExists = existsSync(manifestPath);
const graph = inspectCompiledGraph(graphPath);
let modelBytes = 0;
let compiledModelSha256 = null;

if (modelExists) {
  modelBytes = directoryBytes(modelDir);
  compiledModelSha256 = directoryDigest(modelDir);
  if (modelBytes > 16_777_216) failures.push("Compiled Core ML model directory exceeds 16 MB.");
}

if (manifestExists) {
  manifest = readJsonIfExists(manifestPath, "production manifest");
  if (manifest) {
    requireEqual(manifest.selectedArtifact, "lekh-open-vocab-seq2seq-v1", "Production manifest selectedArtifact must be lekh-open-vocab-seq2seq-v1.");
    requireEqual(manifest.runtime, "CoreML", "Production manifest runtime must be CoreML.");
    requireEqual(manifest.localOnly, true, "Production manifest must be local-only.");
    requireEqual(manifest.neuralTailOnly, true, "Production manifest must be neural-tail-only.");
    requireEqual(manifest.openVocabulary, true, "Production manifest must be open-vocabulary.");
    if (compiledModelSha256 && manifest.sha256?.compiledModel !== compiledModelSha256) {
      failures.push("Production manifest sha256.compiledModel does not match the compiled model directory digest.");
    }
  }
} else if (production) {
  failures.push("Production Phase 4 requires models/macos/LekhNeuralTransliterator.manifest.json.");
} else {
  warnings.push("Production manifest is absent; Phase 4 export contract is complete, but no production model has been exported.");
}

if (!modelExists && production) failures.push("Production Phase 4 requires models/macos/LekhNeuralTransliterator.mlmodelc.");
if (modelExists && graph.closedVocabLinearSoftmax) {
  const message = "Existing models/macos Core ML graph appears to be a closed-vocabulary classifier, not the production seq2seq decoder.";
  if (production) failures.push(message);
  else warnings.push(message);
}

const status = failures.length === 0
  ? production ? "passed-production-phase4-training-contract" : "passed-phase4-training-contract"
  : production ? "failed-production-phase4-training-contract" : "failed-phase4-training-contract";

finish(status, failures.length === 0 ? 0 : 1, {
  phase: 4,
  production,
  config: relative(root, configPath),
  model: relative(root, modelDir),
  manifest: relative(root, manifestPath),
  modelExists,
  manifestExists,
  modelBytes,
  compiledModelSha256,
  graph,
  manifest,
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

function readJsonIfExists(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`Invalid ${label} JSON at ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) failures.push(`${message} Got ${JSON.stringify(actual)}.`);
}

function directoryBytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + directoryBytes(join(path, entry)), 0);
}

function directoryDigest(dir) {
  const hash = createHash("sha256");
  for (const path of walkFiles(dir).sort()) {
    hash.update(relative(dir, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkFiles(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walkFiles(join(path, entry)));
}

function inspectCompiledGraph(path) {
  if (!existsSync(path)) return { path: relative(root, path), exists: false };
  const bytes = readFileSync(path, "latin1");
  const hasInnerProduct = bytes.includes("inner_product");
  const hasSoftmax = bytes.includes("softmax");
  const hasAttention = /attention|self_attention|multihead|decoder|encoder/i.test(bytes);
  const hasRecurrent = /lstm|gru|recurrent/i.test(bytes);
  return {
    path: relative(root, path),
    exists: true,
    hasInnerProduct,
    hasSoftmax,
    hasAttention,
    hasRecurrent,
    closedVocabLinearSoftmax: hasInnerProduct && hasSoftmax && !hasAttention && !hasRecurrent
  };
}

function finish(status, exitCode, details) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-training-contract.mjs",
    suite: "neural-training-contract",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(root, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
