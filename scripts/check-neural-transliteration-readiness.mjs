#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const production = args.has("production");
const modelDir = args.get("model") ?? join(ROOT, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const manifestPath = args.get("manifest") ?? join(ROOT, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const datasetDir = args.get("dataset-dir") ?? join(ROOT, "data", "generated", "neural-transliteration");
const reportPath = args.get("report") ?? join(ROOT, "reports", production ? "neural-transliteration-readiness-production-report.json" : "neural-transliteration-readiness-report.json");
const modelGraphPath = join(modelDir, "model.espresso.net");
const baselineArtifact = "lekh-small-coreml-student-v1";
const productionArtifact = "lekh-open-vocab-seq2seq-v1";
const canonicalTrainingSource = "ai4bharat-aksharantar-nepali";
const blockedMirrorSources = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];
const failures = [];
const warnings = [];

if (!existsSync(datasetDir)) {
  failures.push("Neural transliteration dataset is missing. Run npm run neural:dataset.");
} else {
  for (const split of ["train.tsv", "dev.tsv", "test.tsv"]) {
    const path = join(datasetDir, split);
    if (!existsSync(path)) failures.push(`Dataset split missing: ${relative(ROOT, path)}`);
  }
}

const modelExists = existsSync(modelDir);
const manifestExists = existsSync(manifestPath);
const modelGraph = inspectCompiledGraph(modelGraphPath);
let manifest = null;

if (!modelExists) {
  const message = "Core ML model is missing: models/macos/LekhNeuralTransliterator.mlmodelc";
  if (production) failures.push(message);
  else warnings.push(message);
}

if (!manifestExists) {
  const message = "Core ML model manifest is missing: models/macos/LekhNeuralTransliterator.manifest.json";
  if (production) failures.push(message);
  else warnings.push(message);
} else {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const params = Number(manifest.parameterCount);
  if (!Number.isFinite(params) || params < 1_000_000 || params > 5_000_000) {
    failures.push("Model parameterCount must be between 1M and 5M.");
  }
  if (manifest.runtime !== "CoreML") failures.push("Model manifest runtime must be CoreML.");
  if (production) {
    validateProductionManifest(manifest, modelGraph);
  } else if (manifest.selectedArtifact !== baselineArtifact && manifest.selectedArtifact !== productionArtifact) {
    warnings.push(`Unknown model artifact ${manifest.selectedArtifact}; production requires ${productionArtifact}.`);
  } else if (manifest.productionEligible === false) {
    warnings.push("Current model is an open-vocabulary Core ML candidate but is not productionEligible=true.");
  } else if (manifest.openVocabulary === false) {
    warnings.push("Current model is a baseline Core ML tail artifact only; production neural readiness intentionally fails until the open-vocabulary seq2seq model ships.");
  }
  if (manifest.localOnly !== true) failures.push("Model manifest must declare localOnly=true.");
  const trainingSources = new Set((manifest.trainingSources ?? []).map(String));
  if (!trainingSources.has(canonicalTrainingSource)) {
    failures.push(`Model manifest trainingSources must include canonical source ${canonicalTrainingSource}.`);
  }
  for (const mirrorSource of blockedMirrorSources) {
    if (trainingSources.has(mirrorSource)) {
      failures.push(`Model manifest must not count blocked lineage mirror ${mirrorSource} as training evidence.`);
    }
  }
  if (manifest.neuralTailOnly !== true) failures.push("Model manifest must declare neuralTailOnly=true.");
  const enforceProductionMetrics = production || manifest.productionEligible === true;
  if (Number(manifest.metrics?.tailTop1Accuracy) < 0.82) {
    if (enforceProductionMetrics) failures.push("tailTop1Accuracy must be >= 0.82.");
    else warnings.push("Candidate model tailTop1Accuracy is below the production readiness floor.");
  }
  if (Number(manifest.metrics?.chatConventionTop1Accuracy) < 0.90) {
    if (enforceProductionMetrics) failures.push("chatConventionTop1Accuracy must be >= 0.90.");
    else warnings.push("Candidate model chatConventionTop1Accuracy is below the production readiness floor.");
  }
  if (Number(manifest.performance?.p99Ms) > 3) {
    if (enforceProductionMetrics) failures.push("Core ML p99 latency must be <= 3ms.");
    else warnings.push("Candidate model p99 latency is not production-ready.");
  }
  if (production && manifest.performance?.measuredOnDevice !== true) {
    failures.push("Production Core ML p99 latency must be measured on device.");
  }
  for (const [input, expected] of Object.entries({
    vato: "बाटो",
    bato: "बाटो",
    baato: "बाटो",
    chha: "छ",
    cha: "छ",
    xa: "छ",
    xaina: "छैन"
  })) {
    if (manifest.requiredCases?.[input] !== expected) {
      failures.push(`Model manifest missing required case ${input} -> ${expected}.`);
    }
  }
}

let modelBytes = 0;
if (modelExists) {
  modelBytes = directoryBytes(modelDir);
  if (modelBytes > 16 * 1024 * 1024) failures.push("Compiled Core ML model must stay under 16 MB.");
}

const report = {
  status: failures.length === 0 ? (modelExists ? "passed" : "passed-no-model-dev") : "failed",
  production,
  model: relative(ROOT, modelDir),
  manifest: relative(ROOT, manifestPath),
  datasetDir: relative(ROOT, datasetDir),
  modelExists,
  manifestExists,
  modelBytes,
  modelGraph,
  manifest,
  failures,
  warnings,
  policy: {
    deterministicFastPathFirst: true,
    neuralTailOnly: true,
    noNetworkInference: true,
    noTextTelemetry: true,
    canonicalTrainingSource,
    blockedMirrorSources
  }
};

finish(report.status, report, failures.length === 0 ? 0 : 1);

function directoryBytes(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + directoryBytes(join(path, entry)), 0);
}

function validateProductionManifest(candidateManifest, graph) {
  if (candidateManifest.selectedArtifact !== productionArtifact) {
    failures.push(`Production model selectedArtifact must be ${productionArtifact}, not ${candidateManifest.selectedArtifact}.`);
  }
  if (candidateManifest.productionEligible !== true) failures.push("Production model manifest must declare productionEligible=true.");
  if (candidateManifest.openVocabulary !== true) failures.push("Production transliteration model must be open-vocabulary.");

  const architecture = String(candidateManifest.architecture ?? candidateManifest.modelFamily ?? "");
  if (!/(transformer|seq2seq|encoder-decoder|gru)/i.test(architecture)) {
    failures.push(`Production architecture must be tiny Transformer/GRU seq2seq; current architecture is ${architecture || "unspecified"}.`);
  }

  const tokenizer = candidateManifest.subwordModel ?? candidateManifest.tokenizer ?? candidateManifest.tokenization;
  if (!tokenizer || tokenizer === "none") {
    failures.push("Production model must declare a BPE/unigram subword or character-sequence tokenizer.");
  }

  const hasBeamSearch = candidateManifest.decoder === "beam-search" || candidateManifest.beamSearch?.enabled === true;
  if (!hasBeamSearch) failures.push("Production model must use beam search decoding.");

  if (candidateManifest.languageModelRescorer?.enabled !== true) {
    failures.push("Production model must enable language-model rescoring.");
  }

  if (Number(candidateManifest.contextWindowWords) < 2) {
    failures.push("Production model must use at least a 2-word context window.");
  }

  if (graph.closedVocabLinearSoftmax === true) {
    failures.push("Compiled model graph is inner_product + softmax only; this is a closed-vocabulary classifier, not the production transliterator.");
  }
}

function inspectCompiledGraph(path) {
  if (!existsSync(path)) {
    return { path: relative(ROOT, path), exists: false };
  }
  const bytes = readFileSync(path, "latin1");
  const hasInnerProduct = bytes.includes("inner_product");
  const hasSoftmax = bytes.includes("softmax");
  const hasAttention = /attention|self_attention|multihead|decoder|encoder/i.test(bytes);
  const hasRecurrent = /lstm|gru|recurrent/i.test(bytes);
  return {
    path: relative(ROOT, path),
    exists: true,
    hasInnerProduct,
    hasSoftmax,
    hasAttention,
    hasRecurrent,
    closedVocabLinearSoftmax: hasInnerProduct && hasSoftmax && !hasAttention && !hasRecurrent
  };
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-transliteration-readiness.mjs",
    suite: "neural-transliteration-readiness",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
