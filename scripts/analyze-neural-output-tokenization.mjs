#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { trainerOutputGraphemes } from "./lib/neural-dataset-quality-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetManifestPath = resolve(root, "data/generated/neural-open-vocab/manifest.json");
const benchmarkManifestPath = resolve(root, "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json");
const reportPath = resolve(root, "data/neural/audits/output-tokenization-analysis-v1.json");
const outputContentCapacity = 30;
const tensorOutputSteps = 31;
const beamWidth = 4;
const outputEmbeddingDimension = 96;
const decoderHiddenDimension = 256;
const inputVocabularyWithSpecialTokens = 30;
const recurrentLayers = 2;
const specialTokenCount = 4;
const baselineFixedParameterCount = baselineFixedParameters();
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const virama = "\u094D";
const joiners = new Set(["\u200C", "\u200D"]);
const combiningMark = /^\p{M}$/u;
const vowelSignCodePoints = new Set([
  ...range(0x093A, 0x093B),
  ...range(0x093E, 0x094C),
  0x094E,
  0x094F,
  ...range(0x0955, 0x0957),
  0x0962,
  0x0963
]);

const schemes = Object.freeze([
  {
    id: "current-base-plus-combining-marks",
    definition: "Historical recurrent-trainer behavior: each base scalar plus following Devanagari marks is one token.",
    tokenize: trainerOutputGraphemes
  },
  {
    id: "unicode-scalars",
    definition: "One Unicode scalar per token after NFC normalization.",
    tokenize: (value) => [...normalize(value)]
  },
  {
    id: "joiner-aware-unicode-scalars",
    definition: "Unicode scalars, except VIRAMA+ZWJ/ZWNJ is kept as one atomic token.",
    tokenize: joinerAwareScalars
  },
  {
    id: "unicode-extended-grapheme-clusters",
    definition: "Unicode extended grapheme clusters from Intl.Segmenter after NFC normalization.",
    tokenize: (value) => [...segmenter.segment(normalize(value))].map(({ segment }) => segment)
  }
]);

const datasetManifest = readJson(datasetManifestPath);
const benchmarkManifest = readJson(benchmarkManifestPath);
const analysis = Object.fromEntries(schemes.map((scheme) => [scheme.id, createSchemeState(scheme)]));
const invalidSequenceRisks = {
  train: createRiskState(),
  dev: createRiskState(),
  test: createRiskState(),
  benchmark: createRiskState()
};

for (const split of ["train", "dev", "test"]) {
  await streamJsonLines(resolve(root, datasetManifest.splitFiles[split]), (row) => {
    if (row.action !== "produce-candidate" || typeof row.target !== "string") return;
    analyzeRow(row, split);
  });
}

const benchmarkRows = [];
for (const suite of benchmarkManifest.suites) {
  await streamJsonLines(resolve(root, suite.path), (row) => benchmarkRows.push(row));
}
for (const row of benchmarkRows) {
  const targets = [...new Set([...(row.expected ?? []), ...(row.acceptable ?? [])].map(normalize).filter(Boolean))];
  const perSchemeRepresentability = Object.fromEntries(schemes.map(({ id }) => [id, []]));
  for (const target of targets) {
    const synthetic = { ...row, target };
    analyzeRow(synthetic, "benchmark");
    for (const scheme of schemes) {
      const tokens = scheme.tokenize(target);
      perSchemeRepresentability[scheme.id].push(tokens.every((token) => analysis[scheme.id].trainVocabulary.has(token)));
    }
  }
  for (const scheme of schemes) {
    const values = perSchemeRepresentability[scheme.id];
    const state = analysis[scheme.id].benchmarkEvaluationUnits;
    state.rows += 1;
    if (values.some(Boolean)) state.rowsWithRepresentableTarget += 1;
    else {
      state.rowsWithNoRepresentableTarget += 1;
      keepExample(state.noRepresentableTargetExamples, { id: row.id, input: row.input, targets });
    }
    if (values.some((value) => !value)) state.rowsWithAnyUnseenTarget += 1;
  }
}

const finalizedSchemes = Object.fromEntries(schemes.map((scheme) => [
  scheme.id,
  finalizeScheme(analysis[scheme.id], scheme)
]));
const current = finalizedSchemes[schemes[0].id];
for (const value of Object.values(finalizedSchemes)) {
  value.coreMLAndRuntime.relativeToCurrent = {
    vocabularyRatio: round(value.vocabulary.trainWithSpecialTokens / current.vocabulary.trainWithSpecialTokens),
    vocabularyDependentParameterRatio: round(value.coreMLAndRuntime.vocabularyDependentParameters / current.coreMLAndRuntime.vocabularyDependentParameters),
    fullDecoderLogitTensorRatio: round(value.coreMLAndRuntime.legacyFullDecoderLogitElements / current.coreMLAndRuntime.legacyFullDecoderLogitElements),
    trainMeanStepRatio: round(value.splits.train.length.mean / current.splits.train.length.mean)
  };
}

const report = {
  schemaVersion: 1,
  contentIdentity: "lekh-neural-output-tokenization-analysis-v1",
  status: "historical-design-analysis-superseded",
  scope: {
    purpose:
      "Historical comparison that selected Unicode-scalar tokenization before the Transformer-CTC implementation existed.",
    architecture:
      "retired-recurrent-seq2seq-and-split-attention-design-snapshot",
    productionEvidence: false,
    datasetSnapshotOnly: true,
    supersededBy:
      "data/neural/audits/ctc-transformer-v2-alignment-v1.json"
  },
  dataset: {
    manifest: relative(datasetManifestPath),
    manifestSha256: sha256(readFileSync(datasetManifestPath)),
    datasetContentSha256: datasetManifest.datasetContentSha256,
    rows: datasetManifest.totalRows,
    splitCounts: datasetManifest.counts
  },
  benchmark: {
    manifest: relative(benchmarkManifestPath),
    manifestSha256: sha256(readFileSync(benchmarkManifestPath)),
    releaseId: benchmarkManifest.releaseId,
    metricUnits: benchmarkRows.length,
    targetVariants: finalizedSchemes[schemes[0].id].splits.benchmark.rows
  },
  constraints: {
    outputTensorLength: 32,
    outputContentCapacity,
    runtimeMaximumSteps: "min(31, input Unicode-character count + 8)",
    beamWidth,
    outputEmbeddingDimension,
    decoderHiddenDimension,
    inputVocabularyWithSpecialTokens,
    recurrentLayers,
    baselineFixedParameterCount
  },
  schemes: finalizedSchemes,
  invalidSequenceRisks: Object.fromEntries(Object.entries(invalidSequenceRisks).map(([split, state]) => [split, finalizeRiskState(state)])),
  invalidSequenceRiskMethod: "Conservative structural heuristics, not linguistic adjudication. Legitimate terminal VIRAMA and VIRAMA before a non-consonant are reported as decoder-sensitive contexts, not invalid rows.",
  sourceInspection: {
    historicalTrainer: "scripts/train-open-vocab-seq2seq-transliterator.py",
    historicalNativeRuntime:
      "native/macos-imk/skeleton/LekhNeuralCandidateService.swift",
    historicalSnapshotBehavior: [
      "The output vocabulary is built from train only; unseen dev/test tokens encode as <unk>.",
      "The native decoder concatenates token strings verbatim.",
      "The native decoder blocks <unk> but does not apply a Unicode-sequence state mask.",
      "The native candidate filter checks NFC and allowed scalars, but not mark/joiner ordering."
    ],
    currentProductionContract: {
      modelId: "lekh-open-vocab-ctc-transformer-v2",
      tokenization: "unicode-scalar-character",
      decoder: "ctc-prefix-beam-search",
      outputSequenceValidation: "devanagari-word-sequence-v1",
      evidence:
        "data/neural/audits/ctc-transformer-v2-alignment-v1.json"
    }
  },
  recommendation: {
    choice: "unicode-scalars-with-decoder-sequence-validation",
    implementationStatus:
      "implemented-in-transformer-ctc-v2-awaiting-final-trained-artifact-quality-and-device-gates",
    currentEvidence:
      "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
    reason: "Scalar tokenization eliminates observed vocabulary OOVs and sharply reduces the Core ML output dimension. A small stateful Unicode validity mask (or equivalent final candidate validator) is required before this is production-safe because combining marks become independently generatable.",
    smallestSafeChange: [
      "Replace output grapheme tokenization with NFC Unicode scalars in training/evaluation metadata.",
      "Keep the 32-token tensor, but replace the inputLength+8 inference cap with the full 31-step decoder cap; scalar targets fit the tensor but some acronym expansions exceed the current dynamic budget.",
      "Reject or mask leading dependent marks, duplicate/multiple vowel signs, and orphan joiners during both Python and Swift decoding; preserve legitimate terminal VIRAMA and explicit halant contexts.",
      "Filter or repair the small set of source targets with unambiguous mark-order defects before retraining.",
      "Retrain and regenerate the checkpoint, Core ML model, vocabulary metadata, manifest hashes, parity evidence, and benchmark results as one atomic artifact set."
    ],
    rejectedAlternatives: {
      current: "Keeps a four-digit output vocabulary and creates train-only atomic mark combinations that make valid dev/test targets unrepresentable.",
      joinerAwareScalars: "Has no measured benefit because the full dataset and official benchmark contain no ZWJ/ZWNJ; it should remain a decoder validity rule, not a distinct vocabulary scheme.",
      unicodeExtendedGraphemes: "Preserves orthographic atoms but expands the sparse vocabulary and OOV surface; it is unsuitable for an open-vocabulary transliterator."
    }
  }
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  report: relative(reportPath),
  schemes: Object.fromEntries(Object.entries(finalizedSchemes).map(([id, value]) => [id, {
    trainVocabulary: value.vocabulary.trainLexicalTokens,
    devUnseenRows: value.splits.dev.unseen.rows,
    testUnseenRows: value.splits.test.unseen.rows,
    benchmarkNoRepresentableRows: value.benchmarkEvaluationUnits.rowsWithNoRepresentableTarget,
    maximumTokens: Math.max(...Object.values(value.splits).map((split) => split.length.max)),
    overCapacityRows: Object.values(value.splits).reduce((sum, split) => sum + split.capacity.rowsOverContentCapacity, 0)
  }]))
}, null, 2));

function analyzeRow(row, split) {
  const target = normalize(row.target);
  analyzeInvalidSequence(row, target, invalidSequenceRisks[split]);
  for (const scheme of schemes) {
    const state = analysis[scheme.id];
    const tokens = scheme.tokenize(target);
    if (tokens.join("") !== target) {
      state.reconstructionMismatches += 1;
      keepExample(state.reconstructionExamples, { id: row.id, input: row.input, target, tokens });
    }
    addSequence(state.splits[split], row, target, tokens, state.trainVocabulary, split === "train");
    if (split === "train") for (const token of tokens) incrementMap(state.trainVocabulary, token);
  }
}

function createSchemeState(scheme) {
  return {
    definition: scheme.definition,
    trainVocabulary: new Map(),
    splits: Object.fromEntries(["train", "dev", "test", "benchmark"].map((split) => [split, createSplitState()])),
    benchmarkEvaluationUnits: {
      rows: 0,
      rowsWithRepresentableTarget: 0,
      rowsWithNoRepresentableTarget: 0,
      rowsWithAnyUnseenTarget: 0,
      noRepresentableTargetExamples: []
    },
    reconstructionMismatches: 0,
    reconstructionExamples: []
  };
}

function createSplitState() {
  return {
    rows: 0,
    totalTokens: 0,
    lengths: new Map(),
    unseenFrequencies: new Map(),
    unseenRows: 0,
    unseenOccurrences: 0,
    unseenExamples: [],
    overCapacityRows: 0,
    atCapacityRows: 0,
    decoderBudgetFailures: 0,
    decoderBudgetExamples: [],
    maximumRequiredRuntimeSlack: Number.NEGATIVE_INFINITY,
    requiredSlackExamples: [],
    longest: []
  };
}

function addSequence(state, row, target, tokens, trainVocabulary, isTrain) {
  state.rows += 1;
  state.totalTokens += tokens.length;
  incrementMap(state.lengths, tokens.length);
  if (tokens.length > outputContentCapacity) state.overCapacityRows += 1;
  if (tokens.length === outputContentCapacity) state.atCapacityRows += 1;
  const runtimeBudget = Math.min(tensorOutputSteps, [...String(row.input ?? "")].length + 8);
  const requiredSlack = tokens.length + 1 - [...String(row.input ?? "")].length;
  if (requiredSlack > state.maximumRequiredRuntimeSlack) state.maximumRequiredRuntimeSlack = requiredSlack;
  keepLargest(state.requiredSlackExamples, { id: row.id, input: row.input, target, tokens: tokens.length, requiredSlack });
  if (tokens.length + 1 > runtimeBudget) {
    state.decoderBudgetFailures += 1;
    keepExample(state.decoderBudgetExamples, { id: row.id, input: row.input, target, tokens: tokens.length, runtimeBudget });
  }
  keepLongest(state.longest, { id: row.id, input: row.input, target, tokens: tokens.length });
  if (isTrain) return;
  const unseen = tokens.filter((token) => !trainVocabulary.has(token));
  if (unseen.length === 0) return;
  state.unseenRows += 1;
  state.unseenOccurrences += unseen.length;
  for (const token of unseen) incrementMap(state.unseenFrequencies, token);
  keepExample(state.unseenExamples, { id: row.id, input: row.input, target, tokens: [...new Set(unseen)] });
}

function finalizeScheme(state, scheme) {
  const lexicalTokens = state.trainVocabulary.size;
  const vocabularyWithSpecial = lexicalTokens + specialTokenCount;
  const standaloneCombining = [...state.trainVocabulary.keys()].filter((token) => [...token].length === 1 && combiningMark.test(token));
  const joinerTokens = [...state.trainVocabulary.keys()].filter((token) => [...token].some((scalar) => joiners.has(scalar)));
  const tokensEndingVirama = [...state.trainVocabulary.keys()].filter((token) => token.endsWith(virama));
  return {
    definition: scheme.definition,
    vocabulary: {
      trainLexicalTokens: lexicalTokens,
      trainWithSpecialTokens: vocabularyWithSpecial,
      trainOccurrences: sumMap(state.trainVocabulary),
      trainSingletons: [...state.trainVocabulary.values()].filter((count) => count === 1).length,
      standaloneCombiningMarkTokens: standaloneCombining.length,
      standaloneCombiningMarkExamples: standaloneCombining.slice(0, 30).map(tokenDescriptor),
      tokensContainingJoiners: joinerTokens.length,
      tokensEndingInVirama: tokensEndingVirama.length
    },
    splits: Object.fromEntries(Object.entries(state.splits).map(([split, value]) => [split, finalizeSplit(value)])),
    benchmarkEvaluationUnits: state.benchmarkEvaluationUnits,
    reconstruction: {
      mismatches: state.reconstructionMismatches,
      examples: state.reconstructionExamples
    },
    coreMLAndRuntime: {
      vocabularyDependentParameters: vocabularyWithSpecial * (outputEmbeddingDimension + decoderHiddenDimension + 1),
      estimatedBaselineTotalParameters: baselineFixedParameterCount + vocabularyWithSpecial * (outputEmbeddingDimension + decoderHiddenDimension + 1),
      estimatedVocabularyDependentFloat32ParameterBytes: vocabularyWithSpecial * (outputEmbeddingDimension + decoderHiddenDimension + 1) * 4,
      estimatedVocabularyDependentFloat16ParameterBytes: vocabularyWithSpecial * (outputEmbeddingDimension + decoderHiddenDimension + 1) * 2,
      legacyFullDecoderLogitElements: tensorOutputSteps * vocabularyWithSpecial,
      legacyFullDecoderFloat32LogitBytes: tensorOutputSteps * vocabularyWithSpecial * 4,
      splitAttentionStepLogitElements: beamWidth * vocabularyWithSpecial,
      implication: "Changing vocabulary size changes model projection weights and Core ML tensor shapes; vocab JSON alone cannot be swapped."
    }
  };
}

function finalizeSplit(state) {
  return {
    rows: state.rows,
    length: summarizeHistogram(state.lengths, state.rows, state.totalTokens),
    capacity: {
      contentCapacity: outputContentCapacity,
      rowsAtContentCapacity: state.atCapacityRows,
      rowsOverContentCapacity: state.overCapacityRows,
      rowsExceedingCurrentRuntimeStepBudget: state.decoderBudgetFailures,
      runtimeStepBudgetExamples: state.decoderBudgetExamples,
      maximumRequiredInputLengthSlack: Number.isFinite(state.maximumRequiredRuntimeSlack) ? state.maximumRequiredRuntimeSlack : null,
      maximumRequiredSlackExamples: state.requiredSlackExamples
    },
    unseen: {
      rows: state.unseenRows,
      occurrences: state.unseenOccurrences,
      distinctTokens: state.unseenFrequencies.size,
      tokens: frequencySummary(state.unseenFrequencies),
      examples: state.unseenExamples
    },
    longest: state.longest
  };
}

function createRiskState() {
  return { rows: 0, rowsWithIssues: 0, counts: {}, examples: {}, contextCounts: {}, contextExamples: {} };
}

function analyzeInvalidSequence(row, target, state) {
  state.rows += 1;
  const scalars = [...target];
  const issues = new Set();
  let baseKind = null;
  let vowelSigns = 0;
  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index];
    const codePoint = scalar.codePointAt(0);
    const previous = scalars[index - 1];
    const next = scalars[index + 1];
    if (joiners.has(scalar)) {
      if (previous !== virama) issues.add("joiner-not-after-virama");
      if (!isDevanagariConsonant(next)) issues.add("joiner-not-before-consonant");
      continue;
    }
    if (scalar === virama) {
      if (baseKind !== "consonant") issues.add("virama-without-consonant");
      if (next === undefined) {
        increment(state.contextCounts, "terminal-virama");
        state.contextExamples["terminal-virama"] ??= [];
        keepExample(state.contextExamples["terminal-virama"], { id: row.id, input: row.input, target });
      } else if (!(isDevanagariConsonant(next) || joiners.has(next))) {
        increment(state.contextCounts, "virama-before-nonconsonant");
        state.contextExamples["virama-before-nonconsonant"] ??= [];
        keepExample(state.contextExamples["virama-before-nonconsonant"], { id: row.id, input: row.input, target });
      }
      baseKind = null;
      vowelSigns = 0;
      continue;
    }
    if (vowelSignCodePoints.has(codePoint)) {
      if (baseKind !== "consonant") issues.add("dependent-vowel-sign-without-consonant");
      vowelSigns += 1;
      if (vowelSigns > 1) issues.add("multiple-vowel-signs-on-base");
      if (scalar === previous) issues.add("duplicate-adjacent-mark");
      continue;
    }
    if (combiningMark.test(scalar)) {
      if (baseKind === null) issues.add("combining-mark-without-base");
      if (scalar === previous) issues.add("duplicate-adjacent-mark");
      continue;
    }
    if (isDevanagariConsonant(scalar)) {
      baseKind = "consonant";
      vowelSigns = 0;
    } else if (/^\p{L}$/u.test(scalar)) {
      baseKind = "other-letter";
      vowelSigns = 0;
    } else {
      baseKind = null;
      vowelSigns = 0;
    }
  }
  if (target !== target.normalize("NFC")) issues.add("not-nfc");
  if (issues.size > 0) state.rowsWithIssues += 1;
  for (const issue of issues) {
    increment(state.counts, issue);
    state.examples[issue] ??= [];
    keepExample(state.examples[issue], { id: row.id, input: row.input, target });
  }
}

function finalizeRiskState(state) {
  return {
    rows: state.rows,
    rowsWithIssues: state.rowsWithIssues,
    shareWithIssues: round(state.rowsWithIssues / Math.max(state.rows, 1)),
    counts: sortedObject(state.counts),
    examples: sortedObject(state.examples),
    validButDecoderSensitiveContextCounts: sortedObject(state.contextCounts),
    validButDecoderSensitiveContextExamples: sortedObject(state.contextExamples)
  };
}

function joinerAwareScalars(value) {
  const scalars = [...normalize(value)];
  const tokens = [];
  for (let index = 0; index < scalars.length; index += 1) {
    if (scalars[index] === virama && joiners.has(scalars[index + 1])) {
      tokens.push(scalars[index] + scalars[index + 1]);
      index += 1;
    } else tokens.push(scalars[index]);
  }
  return tokens;
}

function isDevanagariConsonant(value) {
  if (!value) return false;
  const codePoint = value.codePointAt(0);
  return (codePoint >= 0x0915 && codePoint <= 0x0939) ||
    (codePoint >= 0x0958 && codePoint <= 0x095F) ||
    (codePoint >= 0x0978 && codePoint <= 0x097F);
}

function normalize(value) {
  return String(value ?? "").trim().normalize("NFC");
}

async function streamJsonLines(path, visit) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  const consume = (text, final = false) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (line.trim()) visit(JSON.parse(line));
    }
    if (final && buffered.trim()) visit(JSON.parse(buffered.replace(/\r$/u, "")));
  };
  for await (const chunk of createReadStream(path)) consume(decoder.write(chunk));
  consume(decoder.end(), true);
}

function summarizeHistogram(histogram, rows, total) {
  const values = [...histogram].sort(([left], [right]) => left - right);
  return {
    min: values[0]?.[0] ?? 0,
    mean: round(total / Math.max(rows, 1)),
    p50: quantile(values, rows, 0.5),
    p90: quantile(values, rows, 0.9),
    p95: quantile(values, rows, 0.95),
    p99: quantile(values, rows, 0.99),
    p999: quantile(values, rows, 0.999),
    max: values.at(-1)?.[0] ?? 0,
    tail: Object.fromEntries(values.filter(([length]) => length >= 20))
  };
}

function quantile(values, rows, fraction) {
  const threshold = Math.max(1, Math.ceil(rows * fraction));
  let cumulative = 0;
  for (const [value, count] of values) {
    cumulative += count;
    if (cumulative >= threshold) return value;
  }
  return values.at(-1)?.[0] ?? 0;
}

function frequencySummary(frequencies) {
  const values = [...frequencies].map(([token, count]) => ({ ...tokenDescriptor(token), count }));
  values.sort((left, right) => right.count - left.count || left.token.localeCompare(right.token));
  return values.slice(0, 30);
}

function tokenDescriptor(token) {
  return {
    token,
    codePoints: [...token].map((scalar) => `U+${scalar.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ")
  };
}

function keepLongest(values, candidate, maximum = 10) {
  values.push(candidate);
  values.sort((left, right) => right.tokens - left.tokens || String(left.id).localeCompare(String(right.id)));
  if (values.length > maximum) values.length = maximum;
}

function keepLargest(values, candidate, maximum = 10) {
  values.push(candidate);
  values.sort((left, right) => right.requiredSlack - left.requiredSlack || String(left.id).localeCompare(String(right.id)));
  if (values.length > maximum) values.length = maximum;
}

function keepExample(values, candidate, maximum = 10) {
  if (values.length < maximum && !values.some((value) => value.id === candidate.id && value.target === candidate.target)) values.push(candidate);
}

function increment(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function incrementMap(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sumMap(map) {
  return [...map.values()].reduce((sum, value) => sum + value, 0);
}

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function round(value) {
  return Number(Number(value).toFixed(8));
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function baselineFixedParameters() {
  const gruLayer = (inputDimension) =>
    3 * decoderHiddenDimension * inputDimension +
    3 * decoderHiddenDimension * decoderHiddenDimension +
    6 * decoderHiddenDimension;
  const recurrentStack = gruLayer(outputEmbeddingDimension) +
    (recurrentLayers - 1) * gruLayer(decoderHiddenDimension);
  return inputVocabularyWithSpecialTokens * outputEmbeddingDimension + recurrentStack * 2;
}
