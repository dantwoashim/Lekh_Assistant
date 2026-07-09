#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const reportPath = args.get("report") ?? join(ROOT, "reports", production ? "neural-model-selection-production-report.json" : "neural-model-selection-report.json");
const manifestPath = args.get("manifest") ?? join(ROOT, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const modelDir = args.get("model") ?? join(ROOT, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const modelGraphPath = join(modelDir, "model.espresso.net");

const sources = [
  {
    id: "syubraj-roman2nepali-transliteration",
    role: "primary-training-pairs",
    kind: "dataset",
    url: "https://huggingface.co/datasets/syubraj/roman2nepali-transliteration",
    license: "MIT",
    rows: 2_400_218,
    decision: "selected-for-training-after-local-import",
    reason: "Nepali Romanized to Devanagari pairs with train/validation splits and a permissive page license.",
    shippingUse: "train-or-distill-only",
    rawDataCommitted: false
  },
  {
    id: "saugatkafley-nepali-roman-transliteration",
    role: "source-dataset-cross-check",
    kind: "dataset",
    url: "https://huggingface.co/datasets/Saugatkafley/Nepali-Roman-Transliteration",
    license: "MIT",
    rows: 2_400_218,
    decision: "selected-for-source-review-and-dedup",
    reason: "Source dataset for the derived syubraj mirror; useful for provenance review and duplicate checks.",
    shippingUse: "train-or-distill-only",
    rawDataCommitted: false
  },
  {
    id: "ai4bharat-aksharantar-nep",
    role: "benchmark-and-augmentation",
    kind: "dataset",
    url: "https://huggingface.co/datasets/ai4bharat/Aksharantar",
    license: "CC-family-on-Hugging-Face-card",
    rows: 26_000_000,
    decision: "selected-for-benchmark-pending-license-review",
    reason: "Large Indic transliteration benchmark includes Nepali and supports native/foreign/frequent/rare split analysis.",
    shippingUse: "evaluation-or-training-after-license-review",
    rawDataCommitted: false
  },
  {
    id: "ai4bharat-indicxlit",
    role: "teacher-and-regression-oracle",
    kind: "model",
    url: "https://github.com/AI4Bharat/IndicXlit",
    license: "MIT",
    parameterCountApprox: 11_000_000,
    decision: "teacher-only-not-shipping",
    reason: "Strong public transliteration model for Nepali, but it exceeds the 1-5M shipping target and is not a compiled Core ML artifact.",
    shippingUse: "teacher-or-offline-comparison-only",
    rawDataCommitted: false
  },
  {
    id: "nirajan111-nepali-transliteration",
    role: "comparison-only",
    kind: "model",
    url: "https://huggingface.co/nirajan111/nepali-transliteration",
    license: "Apache-2.0",
    parameterCountApprox: 300_000_000,
    decision: "rejected-for-shipping",
    reason: "mT5-sized model is far above the keyboard latency, RSS, and 1-5M parameter budget.",
    shippingUse: "offline-comparison-only",
    rawDataCommitted: false
  },
  {
    id: "dakshina",
    role: "methodology-reference",
    kind: "dataset",
    url: "https://github.com/google-research-datasets/dakshina",
    license: "CC-BY-SA-4.0",
    decision: "not-selected-for-nepali-direct-training",
    reason: "Dakshina is a high-quality South Asian romanization reference, but its published language list does not include Nepali.",
    shippingUse: "methodology-reference-only",
    rawDataCommitted: false
  }
];

const shippingPlan = {
  currentBaselineArtifact: "lekh-small-coreml-student-v1",
  finalProductionArtifact: "lekh-open-vocab-seq2seq-v1",
  targetRuntime: "CoreML .mlmodelc",
  targetParameterCount: "1M-5M",
  targetCompiledBytes: "<=16MB",
  targetP99Ms: "<=3ms",
  hotPathPolicy: "deterministic FST and dictionary first; neural tail reranker only when fast paths are insufficient",
  privacyPolicy: "local inference only; no network inference; no raw text telemetry",
  productionRequirements: {
    openVocabulary: true,
    acceptedArchitectures: ["tiny-transformer-encoder-decoder", "gru-encoder-decoder", "seq2seq"],
    tokenization: "BPE, unigram subword, or character-sequence decoder",
    decoding: "beam-search",
    languageModelRescorer: true,
    contextWindowWords: ">=2",
    measuredOnDevice: true,
    forbiddenCompiledGraphShape: "single inner_product followed by softmax"
  },
  requiredCases: {
    vato: "बाटो",
    bato: "बाटो",
    baato: "बाटो",
    chha: "छ",
    cha: "छ",
    xa: "छ",
    xaina: "छैन",
    thapera: ["थपेर", "थापेर"],
    niraj: ["निरज", "नीरज"]
  }
};

const failures = [];
const warnings = [];

if (!sources.some((source) => source.role === "primary-training-pairs" && source.decision.startsWith("selected"))) {
  failures.push("No primary training-pair source is selected.");
}

for (const source of sources) {
  if (source.kind === "model" && source.decision !== "teacher-only-not-shipping" && source.decision !== "rejected-for-shipping") {
    failures.push(`Model source ${source.id} must not be marked as directly shippable.`);
  }
  if (source.rawDataCommitted) {
    failures.push(`Raw upstream data must not be committed for ${source.id}.`);
  }
}

const manifestExists = existsSync(manifestPath);
const modelExists = existsSync(modelDir);
const modelGraph = inspectCompiledGraph(modelGraphPath);
let manifest = null;
if (manifestExists) {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sourceIds = new Set((manifest.trainingSources ?? []).map(String));
  for (const required of ["syubraj-roman2nepali-transliteration"]) {
    if (!sourceIds.has(required)) failures.push(`Model manifest must include training source ${required}.`);
  }
  if (production) {
    validateProductionModel(manifest, modelGraph);
  } else if (manifest.selectedArtifact !== shippingPlan.currentBaselineArtifact && manifest.selectedArtifact !== shippingPlan.finalProductionArtifact) {
    warnings.push(`Unknown transliteration artifact ${manifest.selectedArtifact}; production gates will require ${shippingPlan.finalProductionArtifact}.`);
  } else if (manifest.productionEligible === false) {
    warnings.push("Current Core ML artifact is an open-vocabulary candidate but is not productionEligible=true; production neural gates intentionally remain blocked.");
  } else if (manifest.openVocabulary === false) {
    warnings.push("Current Core ML artifact is a baseline tail model only; production neural gates intentionally fail until the open-vocabulary seq2seq model ships.");
  }
} else if (production) {
  failures.push("Production neural build requires models/macos/LekhNeuralTransliterator.manifest.json.");
} else {
  warnings.push("No Core ML model manifest present; neural tail is blocked for production but dev fallback remains valid.");
}

if (!modelExists && production) {
  failures.push("Production neural build requires models/macos/LekhNeuralTransliterator.mlmodelc.");
}

finish(failures.length === 0 ? "passed" : "failed", {
  production,
  sources,
  shippingPlan,
  model: relative(ROOT, modelDir),
  manifest: relative(ROOT, manifestPath),
  modelExists,
  manifestExists,
  manifest,
  modelGraph,
  failures,
  warnings
}, failures.length === 0 ? 0 : 1);

function validateProductionModel(candidateManifest, graph) {
  if (candidateManifest.selectedArtifact !== shippingPlan.finalProductionArtifact) {
    failures.push(`Production model selectedArtifact must be ${shippingPlan.finalProductionArtifact}, not ${candidateManifest.selectedArtifact}.`);
  }
  if (candidateManifest.productionEligible !== true) failures.push("Production model manifest must declare productionEligible=true.");
  if (candidateManifest.openVocabulary !== true) failures.push("Production transliteration model must be open-vocabulary, not a fixed 8192-class label softmax.");

  const architecture = String(candidateManifest.architecture ?? candidateManifest.modelFamily ?? "");
  if (!/(transformer|seq2seq|encoder-decoder|gru)/i.test(architecture)) {
    failures.push(`Production model architecture must be tiny Transformer/GRU seq2seq; current architecture is ${architecture || "unspecified"}.`);
  }

  const tokenizer = candidateManifest.subwordModel ?? candidateManifest.tokenizer ?? candidateManifest.tokenization;
  if (!tokenizer || tokenizer === "none") {
    failures.push("Production model must declare a BPE/unigram subword or character-sequence tokenizer.");
  }

  const hasBeamSearch = candidateManifest.decoder === "beam-search" || candidateManifest.beamSearch?.enabled === true;
  if (!hasBeamSearch) failures.push("Production model must use beam search decoding.");

  if (candidateManifest.languageModelRescorer?.enabled !== true) {
    failures.push("Production model must enable language-model rescoring for candidate ranking.");
  }

  if (Number(candidateManifest.contextWindowWords) < 2) {
    failures.push("Production model must rank with at least the previous 2 words of context.");
  }

  if (candidateManifest.performance?.measuredOnDevice !== true) {
    failures.push("Production model latency must be measured on the packaged app, not only estimated.");
  }

  if (graph.closedVocabLinearSoftmax === true) {
    failures.push("Compiled Core ML graph is a closed-vocabulary inner_product + softmax classifier; production requires an open-vocabulary decoder graph.");
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
    command: "node scripts/check-neural-model-selection.mjs",
    suite: "neural-model-selection",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), failures, warnings }, null, 2));
  process.exit(exitCode);
}
