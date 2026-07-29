#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import Ajv2020 from "ajv/dist/2020.js";
import { checkNeuralAuditEvidence } from "./check-neural-audit-evidence.mjs";

const root = process.cwd();
const startedAt = performance.now();
const reportPath = join(root, "reports", "neural-production-contract-report.json");

const requiredFiles = [
  "package.json",
  "docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md",
  "docs/neural/REMOTE_CUDA_TRAINING_AND_MACOS_EXPORT.md",
  "docs/neural/TRANSFORMER_CTC_COREML_RESEARCH_REVIEW_2026-07-29.md",
  "docs/neural/CTC_MATHEMATICAL_AUDIT_2026-07-30.md",
  "docs/neural/COREML_CONVERSION_PARITY_AUDIT_2026-07-30.md",
  "data/neural/schema/lekh-neural-manifest.schema.json",
  "data/neural/eval/README.md",
  "data/neural/training/open-vocab-seq2seq-v1.config.json",
  "data/neural/training/open-vocab-bigru-attention-v1.config.json",
  "data/neural/training/open-vocab-ctc-transformer-v2.config.json",
  "data/generated/neural-open-vocab/manifest.json",
  "data/neural/audits/open-vocab-data-quality-v1.json",
  "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
  "data/neural/audits/output-tokenization-analysis-v1.json",
  "data/neural/eval/ctc-rare-output-scalar-probes-v1.json",
  "scripts/train-open-vocab-ctc-transformer.py",
  "scripts/lib/neural_ctc_transformer.py",
  "scripts/lib/neural-ctc-alignment-audit.mjs",
  "scripts/lib/neural-ctc-finite-path-contract.mjs",
  "scripts/lib/neural-ctc-coreml-parity-contract.mjs",
  "scripts/lib/neural_ctc_coreml_parity.py",
  "scripts/lib/neural-audit-evidence.mjs",
  "scripts/lib/neural-rare-scalar-contract.mjs",
  "scripts/lib/neural-rare-scalar-evaluation.mjs",
  "scripts/lib/neural-artifact-filesystem.mjs",
  "scripts/lib/neural-production-promotion-receipt.mjs",
  "scripts/check-neural-audit-evidence.mjs",
  "scripts/analyze-neural-output-tokenization.mjs",
  "scripts/generate-neural-rare-scalar-predictions.py",
  "scripts/export-neural-remote-training-result.py",
  "scripts/evaluate-neural-rare-scalar-evidence.mjs",
  "scripts/lib/neural-artifact-descriptor.mjs",
  "scripts/lib/neural-vocabulary-contract.mjs",
  "scripts/check-neural-training-contract.mjs",
  "scripts/evaluate-neural-open-vocab-model.mjs",
  "scripts/evaluate-neural-official-benchmark.mjs",
  "scripts/lib/neural-official-benchmark.mjs",
  "scripts/benchmark-neural-coreml-device.mjs",
  "scripts/benchmark-neural-native-service.mjs",
  "scripts/benchmark-neural-packaged-app.mjs",
  "scripts/check-neural-runtime-placement-evidence.mjs",
  "scripts/lib/neural-runtime-placement-evidence.mjs",
  "scripts/check-neural-native-integration.mjs",
  "scripts/prepare-neural-training-run.mjs",
  "scripts/check-neural-production-readiness.mjs",
  "scripts/check-neural-production-promotion.mjs",
  "scripts/promote-neural-candidate.mjs",
  "scripts/check-neural-sota-worldclass.mjs",
  "native/macos-imk/skeleton/LekhNeuralCandidateService.swift",
  "native/macos-imk/skeleton/LekhNativePreferences.swift"
];

const failures = [];
const warnings = [];
let auditEvidence = null;

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing Phase 0 neural contract file: ${file}`);
}

try {
  auditEvidence = checkNeuralAuditEvidence();
  for (const failure of auditEvidence.validation.failures) {
    failures.push(`Neural audit evidence: ${failure}`);
  }
} catch (error) {
  failures.push(
    `Neural audit evidence could not be verified: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

const specText = readText("docs/neural/LEKH_OPEN_VOCAB_MODEL_SPEC.md");
const remoteWorkflowText = readText(
  "docs/neural/REMOTE_CUDA_TRAINING_AND_MACOS_EXPORT.md"
);
const evalText = readText("data/neural/eval/README.md");
const ctcTrainerText = readText("scripts/train-open-vocab-ctc-transformer.py");
const rareScalarGeneratorText = readText(
  "scripts/generate-neural-rare-scalar-predictions.py"
);
const remoteExporterText = readText(
  "scripts/export-neural-remote-training-result.py"
);
const coreMLParityExporterText = readText(
  "scripts/lib/neural_ctc_coreml_parity.py"
);
const officialBenchmarkText = readText(
  "scripts/lib/neural-official-benchmark.mjs"
);
const vocabularyContractText = readText(
  "scripts/lib/neural-vocabulary-contract.mjs"
);
const nativeNeuralServiceText = readText(
  "native/macos-imk/skeleton/LekhNeuralCandidateService.swift"
);
const nativePreferencesText = readText(
  "native/macos-imk/skeleton/LekhNativePreferences.swift"
);
const nativeBenchmarkText = readText(
  "scripts/benchmark-neural-native-service.mjs"
);
const packagedBenchmarkText = readText(
  "scripts/benchmark-neural-packaged-app.mjs"
);
const promoterText = readText("scripts/promote-neural-candidate.mjs");
const promotionReceiptText = readText(
  "scripts/lib/neural-production-promotion-receipt.mjs"
);
const artifactFilesystemText = readText(
  "scripts/lib/neural-artifact-filesystem.mjs"
);
const packageJson = readJson("package.json");
const schema = readJson("data/neural/schema/lekh-neural-manifest.schema.json");
const historicalTokenizationAnalysis = readJson(
  "data/neural/audits/output-tokenization-analysis-v1.json"
);

if (historicalTokenizationAnalysis) {
  assert(
    historicalTokenizationAnalysis.status ===
      "historical-design-analysis-superseded",
    "Legacy tokenization analysis must be visibly marked historical and superseded"
  );
  assert(
    historicalTokenizationAnalysis.scope?.productionEvidence === false,
    "Legacy tokenization analysis must not claim current production evidence"
  );
  assert(
    historicalTokenizationAnalysis.scope?.supersededBy ===
      "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
    "Legacy tokenization analysis must point to the active CTC alignment audit"
  );
  assert(
    historicalTokenizationAnalysis.recommendation?.currentEvidence ===
      "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
    "Implemented tokenization recommendation must bind current CTC evidence"
  );
}

requireText(specText, "lekh-open-vocab-seq2seq-v1", "spec must define the baseline artifact id");
requireText(specText, "lekh-open-vocab-bigru-attention-v1", "spec must define the split-attention artifact id");
requireText(specText, "lekh-open-vocab-ctc-transformer-v2", "spec must define the Transformer-CTC artifact id");
requireText(specText, "single-transformer-ctc-v1", "spec must define the Transformer-CTC runtime contract");
requireText(specText, "<ctc-blank>", "spec must define the canonical CTC blank token");
requireText(
  specText,
  "TRANSFORMER_CTC_COREML_RESEARCH_REVIEW_2026-07-29.md",
  "spec must link the current Transformer-CTC research review"
);
requireText(
  specText,
  "CTC_MATHEMATICAL_AUDIT_2026-07-30.md",
  "spec must link the current Transformer-CTC mathematical audit"
);
requireText(
  specText,
  "COREML_CONVERSION_PARITY_AUDIT_2026-07-30.md",
  "spec must link the current Core ML conversion parity audit"
);
requireText(specText, "models/macos/LekhNeuralTransliterator.production", "spec must name the atomic production directory");
requireText(specText, "artifactSetSha256", "spec must define the runtime artifact-set identity");
requireText(
  specText,
  "`MLComputePlan` is anticipated device usage",
  "spec must not treat a compute plan as observed Neural Engine execution"
);
requireText(
  specText,
  "NEURAL_ENGINE_RUNTIME_PLACEMENT.md",
  "spec must define the observed runtime-placement gate"
);
requireText(specText, "no network inference", "spec must forbid network inference");
requireText(specText, "no inference in secure fields", "spec must forbid secure-field inference");
requireText(specText, "autoCommitEligible", "spec must define candidate acceptance safety");
requireText(specText, "generation IDs", "spec must require stale async-result rejection");
requireText(specText, "npm run check:neural-contract", "spec must define its proof command");
requireText(
  specText,
  "ctc-transformer-v2-alignment-v1.json",
  "spec must name the authoritative CTC dataset-alignment evidence"
);
requireText(
  specText,
  "npm run neural:open-vocab:audit",
  "spec must define the single-pass dataset and CTC audit command"
);
requireText(
  specText,
  "npm run check:neural-audit-evidence",
  "spec must define the audit-freshness proof command"
);
requireText(specText, "npm run check:neural-phase3-6", "spec must define the aggregate Phase 3-6 proof command");
requireText(specText, "npm run check:neural-phase3-9", "spec must define the aggregate Phase 3-9 proof command");
requireText(specText, "npm run check:neural-phase0-10", "spec must define the aggregate Phase 0-10 proof command");
requireText(specText, "node scripts/check-neural-training-contract.mjs --production", "spec must define the Phase 4 production proof command");
requireText(specText, "node scripts/evaluate-neural-open-vocab-model.mjs --production", "spec must define the Phase 5 evaluation production proof command");
requireText(specText, "node scripts/benchmark-neural-coreml-device.mjs --production", "spec must define the Phase 5 benchmark production proof command");
requireText(specText, "node scripts/check-neural-native-integration.mjs --production", "spec must define the Phase 6 production proof command");
requireText(specText, "node scripts/prepare-neural-training-run.mjs --production", "spec must define the Phase 8 production proof command");
requireText(specText, "node scripts/check-neural-production-promotion.mjs --production", "spec must define the Phase 9 production proof command");
requireText(specText, "node scripts/check-neural-sota-worldclass.mjs --production", "spec must define the Phase 10 production proof command");
requireText(
  specText,
  "npm run check:neural-phase0-10:production",
  "spec must define the receipt-derived final production re-verification command"
);
requireText(
  specText,
  "--rare-scalar-report",
  "Transformer-CTC promotion must require the rare-scalar evaluation report"
);
requireText(
  specText,
  "--runtime-placement-evidence",
  "production re-verification must require observed Neural Engine placement evidence"
);
requireText(
  remoteExporterText,
  "DEFAULT_CONFIG = CTC_TRANSFORMER_CONFIG",
  "remote macOS export must default to the active Transformer-CTC candidate"
);
requireText(
  remoteExporterText,
  '"policyId": "ctc-finite-path-only-v1"',
  "remote macOS export must exclude zero-probability CTC prefixes"
);
requireText(
  coreMLParityExporterText,
  '"policyId": "ctc-representative-logit-parity-v1"',
  "remote macOS export must replay representative all-logit parity"
);
requireText(
  remoteExporterText,
  "enforce_ctc_representative_coreml_parity",
  "remote macOS export must install the representative parity boundary"
);
requireText(
  remoteWorkflowText,
  "npm run neural:remote:export",
  "remote-training guide must document the macOS export entry point"
);
requireText(
  remoteWorkflowText,
  "data/neural/training/open-vocab-ctc-transformer-v2.config.json",
  "remote-training guide must identify the active Transformer-CTC export default"
);
requireText(
  rareScalarGeneratorText,
  "open_stable_regular_binary",
  "rare-scalar generator must use descriptor-bound stable evidence reads"
);
requireText(
  rareScalarGeneratorText,
  "Parsed rare-scalar JSON changed before artifact binding.",
  "rare-scalar generator must bind parsed JSON to the exact certified bytes"
);
requireText(
  rareScalarGeneratorText,
  '"policyId": "ctc-finite-path-only-v1"',
  "rare-scalar evidence must exclude zero-probability CTC prefixes"
);
requireText(
  officialBenchmarkText,
  "ctc-primary-target-scalar-length-v1",
  "official evaluation must expose target-length-specific CTC quality"
);
for (const bucket of ["short-1-7", "medium-8-13", "long-14-plus"]) {
  requireText(
    officialBenchmarkText,
    bucket,
    `official evaluation must expose the ${bucket} diagnostic bucket`
  );
}
assert(
  packageJson?.scripts?.["neural:remote:export"]?.includes(
    "scripts/export-neural-remote-training-result.py"
  ),
  "neural:remote:export must invoke the production-contracted exporter"
);
requireText(
  promoterText,
  'values.get("rare-scalar-report")',
  "atomic promoter must accept the rare-scalar production-gate report"
);
requireText(
  promoterText,
  "Transformer-CTC promotion requires a passed rare-scalar evaluation report.",
  "atomic promoter must fail closed when Transformer-CTC rare-scalar evidence is absent"
);
requireText(
  promoterText,
  "evaluateNeuralRareScalarEvidence({",
  "atomic promoter must invoke the pure Transformer-CTC rare-scalar evaluator"
);
requireText(
  promoterText,
  "recomputation from locked prediction evidence.",
  "atomic promoter must independently recompute Transformer-CTC rare-scalar semantics"
);
requireText(
  specText,
  "Promotion and live receipt verification independently recompute the pure",
  "spec must forbid trusting a precomputed rare-scalar pass status"
);
requireText(
  promotionReceiptText,
  "NEURAL_PRODUCTION_PROMOTION_RECEIPT_SCHEMA_VERSION = 3",
  "promotion receipt schema must retain the Transformer-CTC rare-scalar evidence graph"
);
requireText(
  promotionReceiptText,
  "Retained rare-scalar evaluation did not pass its production gate.",
  "promotion receipt verifier must revalidate retained rare-scalar production evidence"
);
requireText(
  promotionReceiptText,
  "evaluateNeuralRareScalarEvidence({",
  "promotion receipt verifier must replay the pure rare-scalar evaluator"
);
requireText(
  promotionReceiptText,
  "Retained rare-scalar evaluation does not match independent ",
  "promotion receipt verifier must reject retained semantic forgeries"
);
requireText(
  promotionReceiptText,
  "Retained Transformer-CTC export lacks representative compiled ",
  "promotion receipt verifier must retain representative Core ML parity evidence"
);
requireText(
  artifactFilesystemText,
  "assertNoSymlinkComponents(location, label, true)",
  "neural artifact verifier must reject symlinked evidence path components"
);
requireText(
  artifactFilesystemText,
  "assertPathVersion(",
  "neural artifact verifier must revalidate path identity after hashing"
);
requireText(
  artifactFilesystemText,
  "left.ctimeNs === right.ctimeNs",
  "neural artifact verifier must bind content-change metadata"
);
requireText(
  specText,
  "revalidates the live pathname against the opened inode version",
  "spec must define the race-resistant promotion evidence boundary"
);
requireText(
  ctcTrainerText,
  'CTC_BLANK = "<ctc-blank>"',
  "CTC trainer must emit the canonical blank token"
);
requireText(
  vocabularyContractText,
  'CTC_BLANK_TOKEN = "<ctc-blank>"',
  "JavaScript vocabulary gate must accept the canonical CTC blank token"
);
requireText(
  nativeNeuralServiceText,
  'vocabulary.tokensById[blankId] == "<ctc-blank>"',
  "Swift runtime must require the canonical CTC blank token"
);
requireText(
  nativeNeuralServiceText,
  "minimumTokenLength = 3",
  "Swift admission policy must enforce the evaluated three-character minimum"
);
requireText(
  nativeNeuralServiceText,
  "$0.score.isFinite",
  "Swift CTC runtime must reject zero-probability final prefixes"
);
requireText(
  nativeNeuralServiceText,
  "!LekhMixedScriptPolicy.isProtectedToken(normalizedInput)",
  "Swift admission policy must reject protected Latin tokens itself"
);
assert(
  JSON.stringify(extractProtectedTokens(
    ctcTrainerText,
    /PROTECTED_LATIN_TOKENS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/u
  )) === JSON.stringify(extractProtectedTokens(
    nativePreferencesText,
    /private static let protectedTokens:\s*Set<String>\s*=\s*\[([\s\S]*?)\]/u
  )),
  "Python evaluation and Swift runtime protected-token inventories must match exactly"
);
for (const [text, label] of [
  [nativeBenchmarkText, "native-service benchmark"],
  [packagedBenchmarkText, "packaged-model benchmark"]
]) {
  requireText(
    text,
    "tmpdir()",
    `${label} must keep Swift build state outside the repository`
  );
  requireText(
    text,
    '"--scratch-path"',
    `${label} must set an explicit non-repository Swift scratch path`
  );
  requireText(
    text,
    '"--cache-path"',
    `${label} must set an explicit non-repository Swift package cache`
  );
}
for (const scriptName of [
  "neural:phase4:training-contract",
  "neural:open-vocab:evaluate",
  "neural:open-vocab:benchmark",
  "neural:phase5:evaluate",
  "neural:phase5:benchmark",
  "neural:phase6:native-integration",
  "neural:phase8:training-run"
]) {
  assert(
    packageJson?.scripts?.[scriptName]?.includes(
      "lekh-open-vocab-ctc-transformer-v2"
    ),
    `${scriptName} must target the active Transformer-CTC candidate`
  );
}

for (const suite of [
  "romanized-nepali-token-gold.v1.jsonl",
  "chat-convention-token-only-gold.v2.jsonl",
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
  try {
    new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  } catch (error) {
    failures.push(`Production manifest schema does not compile strictly: ${error.message}`);
  }
  assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "schema must use JSON Schema draft 2020-12");
  assert(schema.$id === "https://lekh.local/schemas/lekh-neural-manifest.schema.json", "schema $id must be stable");
  assert(schema.additionalProperties === false, "schema must reject unexpected top-level production manifest fields");
  assert(propertyConst(schema, "schemaVersion") === 2, "schema must require schemaVersion=2");
  assert(property(schema, "trainingRunId")?.$ref === "#/$defs/runIdentifier", "schema must require a training run identity");
  assert(property(schema, "exportRunId")?.$ref === "#/$defs/runIdentifier", "schema must require an export run identity");
  assert(schema.$defs?.runIdentifier?.pattern === "^[a-f0-9]{32}$", "schema run identities must be lowercase 32-hex values");
  assert(
    [
      "lekh-open-vocab-seq2seq-v1",
      "lekh-open-vocab-bigru-attention-v1",
      "lekh-open-vocab-ctc-transformer-v2"
    ].every(
      (artifact) => property(schema, "selectedArtifact")?.enum?.includes(artifact)
    ),
    "schema must discriminate baseline, split-attention, and Transformer-CTC artifact ids"
  );
  assert(schema.oneOf?.length === 3, "schema must have exactly three closed runtime artifact branches");
  assert(
    [
      "split-attention-incremental-v1",
      "single-transformer-ctc-v1"
    ].every((contract) =>
      property(schema, "runtimeModelContract")?.enum?.includes(contract)
    ),
    "schema must name both explicit runtime model contracts"
  );
  assert(
    JSON.stringify(property(schema, "tensorContract")).includes(
      "#/$defs/tensorContract"
    ) &&
      JSON.stringify(property(schema, "tensorContract")).includes(
        "#/$defs/ctcTensorContract"
      ),
    "schema must bind the split and Transformer-CTC tensor contracts"
  );
  assert(
    property(schema, "compiledModels")?.$ref === "#/$defs/compiledModels",
    "schema must bind the split compiled-model inventory"
  );
  assert(propertyConst(schema, "runtime") === "CoreML", "schema must require CoreML runtime");
  assert(propertyConst(schema, "localOnly") === true, "schema must require localOnly=true");
  assert(propertyConst(schema, "neuralTailOnly") === true, "schema must require neuralTailOnly=true");
  assert(propertyConst(schema, "productionEligible") === true, "schema must require productionEligible=true");
  assert(propertyConst(schema, "openVocabulary") === true, "schema must require openVocabulary=true");
  assert(propertyConst(schema, "tokenization") === "unicode-scalar-character", "schema must require Unicode-scalar output tokens");
  assert(propertyConst(schema, "outputSequenceValidation") === "devanagari-word-sequence-v1", "schema must require the shared Devanagari output validator");
  assert(
    ["beam-search", "ctc-prefix-beam-search"].every((decoder) =>
      property(schema, "decoder")?.enum?.includes(decoder)
    ),
    "schema must allow only the closed autoregressive and CTC decoders"
  );
  assert(property(schema, "beamSearch")?.properties?.maxOutputGraphemes?.const === 32, "schema must bind the output tensor length");
  assert(
    JSON.stringify(property(schema, "beamSearch")?.properties?.maxSteps?.enum) ===
      JSON.stringify([31, 32]),
    "schema must bind the legacy decoder to 31 steps and CTC to 32 time steps"
  );
  assert(property(schema, "parameterCount")?.minimum === 1_000_000, "schema must enforce minimum parameter count");
  assert(property(schema, "parameterCount")?.maximum === 5_000_000, "schema must enforce maximum parameter count");
  assert(property(schema, "modelBytes")?.maximum === 16_777_216, "schema must enforce 16 MB compiled model cap");
  assert(propertyConst(schema, "contextWindowWords") === 0, "schema must bind token-only inference with no context window");
  assert(property(schema, "languageModelRescorer")?.properties?.enabled?.const === false, "schema must forbid an unimplemented context rescorer");
  assert(property(schema, "languageModelRescorer")?.properties?.source?.const === "none", "schema must bind the absent context rescorer to source=none");
  assert(property(schema, "performance")?.properties?.p99Ms?.exclusiveMaximum === 50, "schema must enforce full-candidate p99 < 50ms");
  assert(property(schema, "performance")?.properties?.targetP99Ms?.const === 50, "schema must bind the 50ms full-candidate budget");
  assert(property(schema, "performance")?.properties?.devices?.minItems === 1, "schema must require at least one measured packaged device");
  assert(
    JSON.stringify(property(schema, "performance")?.properties?.devices).includes('"const":"arm64"'),
    "schema must require Apple Silicon device evidence"
  );
  const deviceSchema = property(schema, "performance")?.properties?.devices?.items;
  assert(deviceSchema?.properties?.packagedApp?.const === true, "schema must require packaged-app device evidence");
  assert(deviceSchema?.properties?.secureFieldInferenceCount?.const === 0, "schema must require zero secure-field inference per benchmark device");
  assert(deviceSchema?.properties?.p50Ms?.exclusiveMaximum === 50, "schema must enforce device p50 < 50ms");
  assert(deviceSchema?.properties?.p95Ms?.exclusiveMaximum === 50, "schema must enforce device p95 < 50ms");
  assert(deviceSchema?.properties?.p99Ms?.exclusiveMaximum === 50, "schema must enforce device p99 < 50ms");
  assert(deviceSchema?.properties?.measurementKind?.const === "full-candidate-generation", "schema must require full candidate-generation measurements");
  assert(
    schema.$defs?.baselineHashes?.required?.includes("vocabMetadata") &&
      schema.$defs?.splitHashes?.required?.includes("vocabMetadata"),
    "both artifact branches must require the exact runtime vocabulary digest"
  );
  assert(
    JSON.stringify(schema.$defs?.compiledModels?.required) ===
      JSON.stringify(["encoder", "decoderStep"]),
    "split artifacts must contain exactly encoder and decoderStep"
  );
  assert(
    JSON.stringify(schema.$defs?.splitHashes?.required).includes("compiledModels") &&
      JSON.stringify(schema.$defs?.splitHashes?.required).includes("mlpackages"),
    "split artifacts must bind compiled and export-package hashes"
  );
  assert(
    schema.$defs?.ctcTensorContract?.required?.includes("inputIds") &&
      schema.$defs?.ctcTensorContract?.required?.includes("logits") &&
      JSON.stringify(
        schema.$defs?.ctcTensorContract?.properties?.inputIds?.properties?.shape
          ?.prefixItems
      ).includes('"const":32') &&
      JSON.stringify(
        schema.$defs?.ctcTensorContract?.properties?.logits?.properties?.shape
          ?.prefixItems
      ).includes('"const":32'),
    "Transformer-CTC schema must close the fixed input/logit tensor contract"
  );
  assert(property(schema, "metrics")?.properties?.tailTop1Accuracy?.minimum === 0.88, "schema must enforce tail top1 gate");
  assert(property(schema, "metrics")?.properties?.chatConventionTop1Accuracy?.minimum === 0.92, "schema must enforce chat top1 gate");
  assert(property(schema, "metrics")?.properties?.protectedFalseConversionRate?.const === 0, "schema must require zero protected false conversion");
  assert(property(schema, "metrics")?.properties?.singleTokenPhraseExpansionRate?.const === 0, "schema must require zero phrase expansion");
  assert(property(schema, "metrics")?.properties?.secureFieldInferenceCount?.const === 0, "schema must require zero secure-field inference");

  const required = new Set(schema.required ?? []);
  for (const field of [
    "schemaVersion",
    "trainingRunId",
    "exportRunId",
    "selectedArtifact",
    "runtime",
    "localOnly",
    "neuralTailOnly",
    "productionEligible",
    "architecture",
    "openVocabulary",
    "tokenization",
    "outputSequenceValidation",
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

  for (const source of ["ai4bharat-aksharantar-nepali"]) {
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

function extractProtectedTokens(text, blockPattern) {
  const block = text.match(blockPattern)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1])
    .sort();
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
    auditEvidence: auditEvidence?.evidence ?? null,
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
