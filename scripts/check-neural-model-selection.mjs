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
const canonicalTrainingSource = "ai4bharat-aksharantar-nepali";
const blockedMirrorSources = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];

const sources = [
  {
    id: canonicalTrainingSource,
    role: "primary-training-pairs",
    kind: "dataset",
    url: "https://huggingface.co/datasets/ai4bharat/Aksharantar",
    license: "mixed-public-license-by-upstream-row-family",
    rows: null,
    decision: "selected-canonical-source-after-local-import-and-license-validation",
    reason: "Official Aksharantar Nepali is the canonical public lineage source; upstream validation/test rows remain evaluation-only and training uses the declared local train selection.",
    shippingUse: "train-or-distill-only",
    rawDataCommitted: false,
    lineageId: "aksharantar-nepali-public-lineage",
    canonicalTrainingSource,
    independentEvidence: true
  },
  {
    id: "syubraj-roman2nepali-transliteration",
    role: "provenance-only-lineage-mirror",
    kind: "dataset",
    url: "https://huggingface.co/datasets/syubraj/roman2nepali-transliteration",
    license: "MIT",
    rows: 0,
    observedLocalMirrorRows: 2_400_218,
    countedTrainingRows: 0,
    decision: "blocked-lineage-duplicate",
    reason: "This mirror overlaps the canonical Aksharantar Nepali lineage and cannot add training rows, weight, corroboration, or independent evidence.",
    shippingUse: "local-provenance-review-only",
    rawDataCommitted: false,
    lineageId: "aksharantar-nepali-public-lineage",
    canonicalTrainingSource,
    independentEvidence: false
  },
  {
    id: "saugatkafley-nepali-roman-transliteration",
    role: "provenance-only-lineage-mirror",
    kind: "dataset",
    url: "https://huggingface.co/datasets/Saugatkafley/Nepali-Roman-Transliteration",
    license: "MIT",
    rows: 0,
    observedLocalMirrorRows: 2_400_218,
    countedTrainingRows: 0,
    decision: "blocked-lineage-duplicate",
    reason: "This source belongs to the same mirror lineage and is retained only for local provenance investigation.",
    shippingUse: "local-provenance-review-only",
    rawDataCommitted: false,
    lineageId: "aksharantar-nepali-public-lineage",
    canonicalTrainingSource,
    independentEvidence: false
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

if (!sources.some((source) => source.id === canonicalTrainingSource && source.role === "primary-training-pairs" && source.decision.startsWith("selected"))) {
  failures.push(`Canonical primary training-pair source ${canonicalTrainingSource} is not selected.`);
}

for (const source of sources) {
  if (source.kind === "model" && source.decision !== "teacher-only-not-shipping" && source.decision !== "rejected-for-shipping") {
    failures.push(`Model source ${source.id} must not be marked as directly shippable.`);
  }
  if (source.rawDataCommitted) {
    failures.push(`Raw upstream data must not be committed for ${source.id}.`);
  }
}
for (const mirrorSource of blockedMirrorSources) {
  const source = sources.find((candidate) => candidate.id === mirrorSource);
  if (!source || source.decision !== "blocked-lineage-duplicate" || source.independentEvidence !== false ||
      source.canonicalTrainingSource !== canonicalTrainingSource || source.countedTrainingRows !== 0) {
    failures.push(`Mirror source ${mirrorSource} must remain blocked behind canonical source ${canonicalTrainingSource}.`);
  }
}

const manifestExists = existsSync(manifestPath);
const modelExists = existsSync(modelDir);
const modelGraph = inspectCompiledGraph(modelGraphPath);
let manifest = null;
if (manifestExists) {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sourceIds = new Set((manifest.trainingSources ?? []).map(String));
  if (!sourceIds.has(canonicalTrainingSource)) {
    failures.push(`Model manifest must include canonical training source ${canonicalTrainingSource}.`);
  }
  for (const mirrorSource of blockedMirrorSources) {
    if (sourceIds.has(mirrorSource)) {
      failures.push(`Model manifest must not count blocked lineage mirror ${mirrorSource} as training evidence.`);
    }
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
  sourceLineagePolicy: {
    canonicalTrainingSource,
    blockedMirrorSources
  },
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
