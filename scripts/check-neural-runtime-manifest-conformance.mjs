#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = process.cwd();
const production = process.argv.includes("--production");
const manifestPath = join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const vocabPath = join(root, "models", "macos", "LekhNeuralTransliterator.vocab.json");
const modelPath = join(root, "models", "macos", "LekhNeuralTransliterator.mlmodelc");
const checkpointPath = join(root, "data", "generated", "neural-open-vocab-model", "lekh-open-vocab-seq2seq-v1", "checkpoint.pt");
const datasetManifestPath = join(root, "data", "generated", "neural-open-vocab", "manifest.json");
const servicePath = join(root, "native", "macos-imk", "skeleton", "LekhNeuralCandidateService.swift");
const e2ePath = join(root, "reports", "neural-native-service-e2e-report.json");
const reportPath = join(root, "reports", "neural-runtime-manifest-conformance-report.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const vocabSource = readFileSync(vocabPath, "utf8");
const vocab = JSON.parse(vocabSource);
const service = readFileSync(servicePath, "utf8");
const modelDigest = directoryDigest(modelPath);
const modelBytes = directoryBytes(modelPath);
const checkpointDigest = existsSync(checkpointPath) ? fileDigest(checkpointPath) : null;
const datasetManifestDigest = existsSync(datasetManifestPath) ? fileDigest(datasetManifestPath) : null;
const e2e = existsSync(e2ePath) ? JSON.parse(readFileSync(e2ePath, "utf8")) : undefined;
const failures = [];
const warnings = [];

function require(condition, message) {
  if (!condition) failures.push(message);
}

require(manifest.runtime === "CoreML", "Manifest runtime must be CoreML.");
require(manifest.schemaVersion === 1, "Runtime supports only neural manifest schemaVersion=1.");
require(manifest.selectedArtifact === "lekh-open-vocab-seq2seq-v1", "Runtime manifest artifact id is unsupported.");
require(manifest.architecture === "gru-encoder-decoder-seq2seq", "Runtime manifest architecture is unsupported.");
require(manifest.tokenization === "unicode-grapheme-character", "Runtime manifest tokenization is unsupported.");
require(manifest.openVocabulary === true, "Runtime manifest must declare open-vocabulary decoding.");
require(manifest.localOnly === true, "Manifest must require local-only inference.");
require(manifest.neuralTailOnly === true, "Manifest must describe a neural-tail-only artifact.");
require(
  manifest.productionEligible === production,
  production
    ? "Production runtime conformance requires manifest.productionEligible=true."
    : "Current artifact must remain productionEligible=false until production evidence exists."
);
require(vocab.nativeRuntimePolicy?.asyncOnly === true, "Vocab policy must require async-only inference.");
require(vocab.nativeRuntimePolicy?.neverInvokeInSecureFields === true, "Vocab policy must block secure-field inference.");
require(vocab.nativeRuntimePolicy?.failOpenRawTypingOnError === true, "Vocab policy must fail open to raw typing.");
require(vocab.nativeRuntimePolicy?.neuralTailOnly === true, "Vocab policy must restrict the model to the candidate tail.");
require(vocab.schemaVersion === 1, "Runtime supports only neural vocab schemaVersion=1.");
require(vocab.modelId === manifest.selectedArtifact, "Vocab modelId must match the selected manifest artifact.");
require(vocab.tokenization === manifest.tokenization, "Vocab tokenization must match the manifest.");
require(vocab.decoder?.beamWidth === manifest.beamSearch?.beamWidth, "Training/evaluation beam width must agree between manifest and vocab.");
require(
  createHash("sha256").update(vocabSource).digest("hex") === manifest.sha256?.vocabMetadata,
  "Manifest vocabMetadata SHA-256 is stale."
);
require(modelDigest === manifest.sha256?.compiledModel, "Manifest compiledModel SHA-256 is stale.");
require(modelBytes === manifest.modelBytes, "Manifest modelBytes does not match the compiled model tree.");
if (production) {
  require(checkpointDigest === manifest.sha256?.sourceCheckpoint, "Production sourceCheckpoint SHA-256 is missing or stale.");
  require(datasetManifestDigest === manifest.sha256?.trainingDatasetManifest, "Production trainingDatasetManifest SHA-256 is missing or stale.");
} else if (datasetManifestDigest !== manifest.sha256?.trainingDatasetManifest) {
  warnings.push("Regenerated training dataset manifest does not reproduce the model's recorded trainingDatasetManifest digest; production provenance remains blocked.");
}
require(service.includes("loadVerifiedArtifact(bundle: bundle)"), "Runtime must verify the complete artifact before selecting a mode.");
require(service.includes("validateProductionContract(artifact)"), "productionEligible alone must not enable inference.");
require(service.includes("sha256Directory(modelURL)"), "Runtime must verify the compiled Core ML directory digest.");
require(service.includes("sha256(vocabData) == manifest.sha256.vocabMetadata"), "Runtime must verify exact vocabulary bytes.");
require(service.includes("validateModelContract(model: model, vocab: vocab)"), "Runtime must validate exact Core ML feature names, shapes, and types.");
require(service.includes("verifyKnownAnswers("), "Runtime must run semantic known-answer attestation before production readiness.");
require(service.includes("productionAttestationPending"), "Production inference must fail open while semantic attestation is pending.");
require(service.includes("experimental-async-coreml-tail-artifact-verified-ready"), "Experimental override must remain explicitly labeled.");
require(!service.includes("guard (manifest?.productionEligible == true || experimentalEnabled)"), "A manifest boolean must never directly enable Core ML inference.");
const contextRescorerVerified = service.includes("verifiedContextRescorerContractVersion: Int? = 1");
if (production) {
  require(contextRescorerVerified, "Production neural enablement requires a proven native context-rescorer handoff.");
} else if (manifest.languageModelRescorer?.enabled && !contextRescorerVerified) {
  warnings.push("Manifest claims runtime context rescoring, but the native neural-tail handoff is not yet verified; production remains fail-closed.");
}
require(service.includes("DispatchQueue(label: \"com.lekh.inputmethod.neural-candidate-tail\""), "Runtime inference must remain off the IMK hot path.");
require(service.includes("neverInvokeInSecureFields"), "Runtime must enforce the secure-field policy from vocab metadata.");
require(service.includes("public func cancelPending()"), "Runtime must expose explicit pending-inference cancellation.");
require(
  service.includes("runtime.inputAdmissionPolicy.accepts(normalized)") &&
    service.includes("!deterministicTokenInputs.contains(normalizedInput)") &&
    service.includes("deterministicTokenPackUnavailable"),
  "Runtime must bypass neural inference for exact shared deterministic tokens."
);
require(service.includes("let budgetNanoseconds: UInt64 = 45_000_000"), "Runtime must enforce the measured 45 ms decode budget.");
require(
  service.includes("inputTokens.count < maxLength") &&
    service.includes("guard chars.count < vocab.input.maxLength"),
  "Runtime must reserve an EOS slot instead of silently truncating neural input."
);
require(
  service.includes("inputTokens.allSatisfy { representableTokens.contains($0) }") &&
    service.includes("return tokenId != vocab.input.unkId"),
  "Runtime must reject unknown-token-heavy inputs."
);
const nativeBeamCap = Number(service.match(/min\((\d+), vocab\.decoder\.beamWidth\)/u)?.[1]);
require(Number.isInteger(nativeBeamCap) && nativeBeamCap >= 1, "Native runtime beam cap could not be proven from source.");
require(nativeBeamCap <= manifest.beamSearch?.beamWidth, "Native beam cap must not exceed the evaluated manifest beam width.");
require(
  !(manifest.limitations ?? []).some((item) => /replaces disabled neural diagnostics/iu.test(item)),
  "Manifest still claims the implemented native async service is missing."
);

if (e2e) {
  require(e2e.singleForwardBenchmarkIsConsumerLatency === false, "End-to-end report must distinguish full service latency from one Core ML forward.");
  require(e2e.status === "passed-experimental", "End-to-end service report must remain explicitly experimental.");
  require(e2e.performance?.p95Ms < e2e.targetP95Ms, "End-to-end neural service p95 exceeds its budget.");
  require(e2e.singleTokenPhraseExpansionRate === 0, "End-to-end neural service emitted a phrase for a token.");
  require(Array.isArray(e2e.secureFieldCandidates) && e2e.secureFieldCandidates.length === 0, "Secure-field neural candidates must remain empty.");
  require(
    Array.isArray(e2e.deterministicExactBypassCandidates) && e2e.deterministicExactBypassCandidates.length === 0,
    "Shared deterministic exact inputs must bypass the neural candidate service."
  );
  require(
    e2e.protectedLatinBypassCandidates &&
      Object.values(e2e.protectedLatinBypassCandidates).every((candidates) => Array.isArray(candidates) && candidates.length === 0),
    "Reviewed protected Latin inputs must bypass the neural candidate service."
  );
  require(e2e.latestRequestWins === true, "Latest-request-wins cancellation evidence is missing.");
  require(e2e.cancelPendingSuppressesCompletion === true, "Explicit cancellation evidence is missing.");
} else if (production) {
  failures.push("Production conformance requires reports/neural-native-service-e2e-report.json.");
} else {
  warnings.push("No local end-to-end service report; run npm run neural:native-service:benchmark for device evidence.");
}

const report = {
  generatedAt: new Date().toISOString(),
  command: `node scripts/check-neural-runtime-manifest-conformance.mjs${production ? " --production" : ""}`,
  suite: "neural-runtime-manifest-conformance",
  status: failures.length === 0 ? "passed-experimental" : "failed",
  production,
  manifest: relative(root, manifestPath),
  productionEligible: manifest.productionEligible,
  compiledModelSha256: modelDigest,
  compiledModelBytes: modelBytes,
  sourceCheckpointSha256: checkpointDigest,
  trainingDatasetManifestSha256: datasetManifestDigest,
  evaluationBeamWidth: manifest.beamSearch?.beamWidth,
  nativeRuntimeBeamWidthCap: nativeBeamCap,
  iterativeServiceLatency: e2e?.performance,
  singleForwardBenchmarkIsConsumerLatency: false,
  failures,
  warnings
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);

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

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walkFiles(join(path, entry)));
}
