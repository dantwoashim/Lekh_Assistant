#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "neural-production-contract-report.json");

const requiredFiles = [
  "docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md",
  "data/neural/schema/lekh-neural-manifest.schema.json",
  "data/neural/eval/README.md"
];

const failures = [];
const warnings = [];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing Phase 0 neural contract file: ${file}`);
}

const specText = readText("docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md");
const evalText = readText("data/neural/eval/README.md");
const schema = readJson("data/neural/schema/lekh-neural-manifest.schema.json");

requireText(specText, "lekh-open-vocab-seq2seq-v1", "spec must freeze production artifact id");
requireText(specText, "models/macos/LekhNeuralTransliterator.mlmodelc", "spec must name compiled Core ML artifact path");
requireText(specText, "models/macos/LekhNeuralTransliterator.manifest.json", "spec must name production manifest path");
requireText(specText, "no network inference", "spec must forbid network inference");
requireText(specText, "no inference in secure fields", "spec must forbid secure-field inference");
requireText(specText, "autoCommitEligible", "spec must define candidate acceptance safety");
requireText(specText, "generation IDs", "spec must require stale async-result rejection");
requireText(specText, "npm run check:neural-contract", "spec must define its proof command");

for (const suite of [
  "romanized-nepali-token-gold.v1.jsonl",
  "chat-convention-gold.v1.jsonl",
  "names-gold.v1.jsonl",
  "ambiguity-gold.v1.jsonl",
  "non-nepali-pass-through-gold.v1.jsonl",
  "protected-token-gold.v1.jsonl",
  "adversarial-neural-tail-gold.v1.jsonl"
]) {
  requireText(evalText, suite, `eval README must define ${suite}`);
}

for (const metric of [
  "Tail token top-1 acceptable accuracy",
  "Chat convention top-1 accuracy",
  "Protected false-conversion rate",
  "Single-token phrase expansion rate",
  "Secure-field inference count"
]) {
  requireText(evalText, metric, `eval README must define metric: ${metric}`);
}

if (schema) {
  assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema must use JSON Schema draft 2020-12");
  assert(schema.$id === "https://lekh.local/schemas/lekh-neural-manifest.schema.json", "schema $id must be stable");
  assert(schema.additionalProperties === false, "schema must reject unexpected top-level production manifest fields");
  assert(propertyConst(schema, "schemaVersion") === 1, "schema must require schemaVersion=1");
  assert(propertyConst(schema, "selectedArtifact") === "lekh-open-vocab-seq2seq-v1", "schema must require production artifact id");
  assert(propertyConst(schema, "runtime") === "CoreML", "schema must require CoreML runtime");
  assert(propertyConst(schema, "localOnly") === true, "schema must require localOnly=true");
  assert(propertyConst(schema, "neuralTailOnly") === true, "schema must require neuralTailOnly=true");
  assert(propertyConst(schema, "productionEligible") === true, "schema must require productionEligible=true");
  assert(propertyConst(schema, "openVocabulary") === true, "schema must require openVocabulary=true");
  assert(propertyConst(schema, "decoder") === "beam-search", "schema must require beam-search decoder");
  assert(property(schema, "parameterCount")?.minimum === 1_000_000, "schema must enforce minimum parameter count");
  assert(property(schema, "parameterCount")?.maximum === 5_000_000, "schema must enforce maximum parameter count");
  assert(property(schema, "modelBytes")?.maximum === 16_777_216, "schema must enforce 16 MB compiled model cap");
  assert(property(schema, "contextWindowWords")?.minimum === 2, "schema must require at least two context tokens");
  assert(property(schema, "performance")?.properties?.p99Ms?.maximum === 3, "schema must enforce p99 <= 3ms");
  assert(property(schema, "metrics")?.properties?.tailTop1Accuracy?.minimum === 0.88, "schema must enforce tail top1 gate");
  assert(property(schema, "metrics")?.properties?.chatConventionTop1Accuracy?.minimum === 0.92, "schema must enforce chat top1 gate");
  assert(property(schema, "metrics")?.properties?.protectedFalseConversionRate?.const === 0, "schema must require zero protected false conversion");
  assert(property(schema, "metrics")?.properties?.singleTokenPhraseExpansionRate?.const === 0, "schema must require zero phrase expansion");
  assert(property(schema, "metrics")?.properties?.secureFieldInferenceCount?.const === 0, "schema must require zero secure-field inference");

  const required = new Set(schema.required ?? []);
  for (const field of [
    "schemaVersion",
    "selectedArtifact",
    "runtime",
    "localOnly",
    "neuralTailOnly",
    "productionEligible",
    "architecture",
    "openVocabulary",
    "tokenization",
    "decoder",
    "beamSearch",
    "languageModelRescorer",
    "contextWindowWords",
    "parameterCount",
    "modelBytes",
    "trainingSources",
    "datasetReports",
    "evaluationReports",
    "benchmarkReports",
    "metrics",
    "performance",
    "requiredCases",
    "sha256",
    "limitations"
  ]) {
    assert(required.has(field), `schema required[] must include ${field}`);
  }

  for (const source of [
    "syubraj-roman2nepali-transliteration",
    "human-reviewed-lekh-gold-v1",
    "lekh-chat-conventions-v1",
    "lekh-name-lexicon-v1"
  ]) {
    assert(JSON.stringify(property(schema, "trainingSources")).includes(source), `schema must require training source ${source}`);
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
    assert(property(schema, "requiredCases")?.properties?.[input]?.const === expected, `schema must require case ${input} -> ${expected}`);
  }
}

finish(failures.length === 0 ? "passed" : "failed", failures.length === 0 ? 0 : 1);

function readText(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return "";
  return readFileSync(absolute, "utf8");
}

function readJson(path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return null;
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    failures.push(`Invalid JSON in ${path}: ${error.message}`);
    return null;
  }
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) failures.push(message);
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function property(schemaObject, name) {
  return schemaObject?.properties?.[name];
}

function propertyConst(schemaObject, name) {
  return property(schemaObject, name)?.const;
}

function finish(status, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-production-contract.mjs",
    suite: "neural-production-contract",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    files: requiredFiles.map((file) => ({
      path: file,
      exists: existsSync(join(root, file))
    })),
    schema: "data/neural/schema/lekh-neural-manifest.schema.json",
    spec: "docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md",
    evaluationProtocol: "data/neural/eval/README.md",
    failures,
    warnings
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const payload = { status, report: relative(root, reportPath), failures, warnings };
  if (exitCode === 0) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(JSON.stringify(payload, null, 2));
  }
  process.exit(exitCode);
}
