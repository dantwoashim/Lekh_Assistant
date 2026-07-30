#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  validateNeuralRuntimeManifestVersion
} from "./lib/neural-runtime-manifest-version.mjs";
import {
  validateNeuralRuntimePlacementEvidence
} from "./lib/neural-runtime-placement-evidence.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const artifactRoot = resolve(
  root,
  args.get("artifact-root") ??
    "models/macos/LekhNeuralTransliterator.production"
);
const manifestPath = join(artifactRoot, "LekhNeuralTransliterator.manifest.json");
const vocabPath = join(artifactRoot, "LekhNeuralTransliterator.vocab.json");
const servicePath = join(
  root,
  "native",
  "macos-imk",
  "skeleton",
  "LekhNeuralCandidateService.swift"
);
const decoderContractPath = join(
  root,
  "contracts",
  "neural-decoder",
  "v2",
  "lekh-neural-decoder.v2.json"
);
const datasetManifestPath = join(
  root,
  "data",
  "generated",
  "neural-open-vocab",
  "manifest.json"
);
const promotionReportPath = join(
  artifactRoot,
  "neural-candidate-promotion-report.json"
);
const e2ePath = resolve(
  root,
  args.get("e2e-report") ?? (
    production
      ? "reports/neural-native-service-e2e-production-report.json"
      : "reports/neural-native-service-e2e-report.json"
  )
);
const reportPath = resolve(
  root,
  args.get("report") ?? (
    production
      ? "reports/neural-runtime-manifest-conformance-production-report.json"
      : "reports/neural-runtime-manifest-conformance-report.json"
  )
);
const failures = [];
const warnings = [];
const CTC_MODEL_ID = "lekh-open-vocab-ctc-transformer-v2";
const CTC_RUNTIME_CONTRACT = "single-transformer-ctc-v1";

let descriptor;
try {
  descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: root,
    manifestPath,
    vocabPath
  });
} catch (error) {
  failures.push(`Runtime artifact inventory is invalid: ${error.message}`);
  finishUnavailable();
}

const serviceEvidence = inspectContainedRegularFile(root, servicePath, {
  label: "Native neural service",
  includeContents: true,
  maxBytes: 2 * 1024 * 1024
});
const decoderContractEvidence = inspectContainedRegularFile(
  root,
  decoderContractPath,
  {
    label: "Shared neural decoder contract",
    includeContents: true,
    maxBytes: 1024 * 1024
  }
);
const vocabEvidence = inspectContainedRegularFile(root, vocabPath, {
  label: "Neural vocabulary",
  includeContents: true,
  maxBytes: 16 * 1024 * 1024
});
const manifest = descriptor.manifest;
const vocab = parseJson(vocabEvidence.contents, "Neural vocabulary");
const ctcRuntime = manifest.selectedArtifact === CTC_MODEL_ID;
const service = serviceEvidence.contents.toString("utf8");
const decoderContract = parseJson(
  decoderContractEvidence.contents,
  "Shared neural decoder contract"
);
const datasetManifestEvidence = existsSync(datasetManifestPath)
  ? inspectContainedRegularFile(root, datasetManifestPath, {
      label: "Neural dataset manifest",
      maxBytes: 8 * 1024 * 1024
    })
  : null;
const promotionReport = existsSync(promotionReportPath)
  ? readJsonEvidence(promotionReportPath, "Neural promotion receipt")
  : null;
const e2e = existsSync(e2ePath)
  ? readJsonEvidence(e2ePath, "Neural service benchmark")
  : null;

const manifestVersion = validateNeuralRuntimeManifestVersion(manifest, {
  production
});
failures.push(...manifestVersion.failures);
warnings.push(...manifestVersion.warnings);

require(manifest.runtime === "CoreML", "Manifest runtime must be CoreML.");
require(
  [
    "lekh-open-vocab-seq2seq-v1",
    "lekh-open-vocab-bigru-attention-v1",
    CTC_MODEL_ID
  ]
    .includes(manifest.selectedArtifact),
  "Runtime manifest artifact id is unsupported."
);
require(
  manifest.tokenization === "unicode-scalar-character" &&
    manifest.outputSequenceValidation === "devanagari-word-sequence-v1" &&
    manifest.beamSearch?.maxSteps ===
      manifest.beamSearch?.maxOutputGraphemes - (ctcRuntime ? 0 : 1),
  "Runtime manifest must use complete bounded Unicode-scalar decoding."
);
require(manifest.openVocabulary === true, "Manifest must be open-vocabulary.");
require(manifest.localOnly === true, "Manifest must require local-only inference.");
require(manifest.neuralTailOnly === true, "Manifest must be neural-tail-only.");
require(
  manifest.decoder === (
    ctcRuntime ? "ctc-prefix-beam-search" : "beam-search"
  ),
  "Manifest decoder does not match the selected runtime architecture."
);
if (ctcRuntime) {
  require(
    manifest.runtimeModelContract === CTC_RUNTIME_CONTRACT,
    "CTC manifest runtimeModelContract is unsupported."
  );
  require(
    manifest.architecture === "fixed-shape-transformer-ctc",
    "CTC manifest architecture is unsupported."
  );
}
if (production) {
  require(
    manifest.productionEligible === true,
    "Production conformance requires productionEligible=true."
  );
} else if (manifest.productionEligible === false) {
  warnings.push("Runtime artifact is an unpromoted experimental candidate.");
}

require(
  vocab.nativeRuntimePolicy?.asyncOnly === true,
  "Vocab policy must require async-only inference."
);
require(
  vocab.nativeRuntimePolicy?.neverInvokeInSecureFields === true,
  "Vocab policy must block secure-field inference."
);
require(
  vocab.nativeRuntimePolicy?.failOpenRawTypingOnError === true,
  "Vocab policy must fail open to raw typing."
);
require(
  vocab.nativeRuntimePolicy?.neuralTailOnly === true,
  "Vocab policy must restrict the model to the candidate tail."
);
require(
  vocab.schemaVersion === (ctcRuntime ? 2 : 1),
  `Runtime requires vocab schemaVersion=${ctcRuntime ? 2 : 1} for the selected architecture.`
);
require(
  vocab.modelId === manifest.selectedArtifact,
  "Vocab modelId must match the selected artifact."
);
require(
  vocab.tokenization === manifest.tokenization,
  "Vocab tokenization must match the manifest."
);
if (ctcRuntime) {
  require(
    vocab.runtimeModelContract === CTC_RUNTIME_CONTRACT,
    "CTC vocabulary runtimeModelContract is unsupported."
  );
  require(
    vocab.decoder?.type === manifest.decoder &&
      vocab.decoder?.beamWidth === manifest.beamSearch?.beamWidth &&
      vocab.decoder?.maximumCandidates >= 1 &&
      vocab.decoder?.maximumCandidates <= vocab.decoder?.beamWidth &&
      vocab.decoder?.outputSequenceValidation ===
        "devanagari-word-sequence-v1",
    "CTC vocabulary decoder contract does not match the manifest."
  );
  require(
    vocab.output?.timeSteps === manifest.beamSearch?.maxOutputGraphemes &&
      vocab.output?.timeSteps === manifest.beamSearch?.maxSteps,
    "CTC vocabulary output time dimension must match the manifest."
  );
  requireCTCVocabularyContract(vocab);
  requireCTCTensorContract(manifest.tensorContract, vocab);
} else {
  require(
    vocab.decoder?.type === manifest.decoder &&
      vocab.decoder?.beamWidth === manifest.beamSearch?.beamWidth &&
      vocab.decoder?.maxSteps === vocab.output?.maxLength - 1 &&
      vocab.decoder?.outputSequenceValidation ===
        "devanagari-word-sequence-v1",
    "Vocab decoder contract does not match the manifest."
  );
  require(
    vocab.output?.maxLength === manifest.beamSearch?.maxOutputGraphemes,
    "Vocab output length must match the manifest."
  );
  requireVocabularyContract(vocab.input, "Input vocabulary");
  requireVocabularyContract(vocab.output, "Output vocabulary");
  const specialOutputIds = new Set([
    vocab.output?.padId,
    vocab.output?.sosId,
    vocab.output?.eosId,
    vocab.output?.unkId
  ]);
  require(
    vocab.output?.tokensById?.every((token, index) =>
      specialOutputIds.has(index) || [...token].length === 1
    ) === true,
    "Every non-special output token must contain exactly one Unicode scalar."
  );
}
require(
  descriptor.vocabSha256 === manifest.sha256?.vocabMetadata,
  "Manifest vocabulary digest is stale."
);
require(
  descriptor.totalCompiledBytes === manifest.modelBytes,
  "Manifest modelBytes does not match the runtime artifact set."
);
if (datasetManifestEvidence) {
  if (production) {
    require(
      datasetManifestEvidence.sha256 ===
        manifest.sha256?.trainingDatasetManifest,
      "Production training dataset manifest digest is stale."
    );
  } else if (datasetManifestEvidence.sha256 !==
      manifest.sha256?.trainingDatasetManifest) {
    warnings.push(
      "Current dataset manifest differs from the candidate training snapshot."
    );
  }
} else if (production) {
  failures.push("Production conformance requires the frozen dataset manifest.");
}

verifyNativeSource();
verifyDecoderContract();
verifyPromotionReceipt();
verifyEndToEndEvidence();
finish(manifest, descriptor, e2e, promotionReport);

function verifyNativeSource() {
  const requiredMarkers = [
    ["loadVerifiedArtifact(bundle: bundle)", "Runtime must verify the complete artifact before selecting a mode."],
    ["validateProductionContract(artifact)", "Manifest eligibility alone must not enable inference."],
    ["sha256Directory(modelURL)", "Runtime must verify compiled Core ML directory digests."],
    ["sha256(vocabData) == manifest.sha256.vocabMetadata", "Runtime must verify exact vocabulary bytes."],
    ["validateModelContract(model: model, vocab: vocab)", "Runtime must validate baseline Core ML I/O."],
    ["validateSplitModelContract(", "Runtime must validate split Core ML I/O."],
    ["split-attention-incremental-v1", "Runtime must implement the split-attention contract."],
    ["verifyKnownAnswers(", "Runtime must run semantic known-answer attestation."],
    ["productionAttestationPending", "Production must fail open while attestation is pending."],
    ["guard !secureInputActive else", "Runtime must block secure-field inference."],
    ["public func cancelPending()", "Runtime must expose explicit cancellation."],
    ["let budgetNanoseconds: UInt64 = 45_000_000", "Runtime must enforce its 45 ms decode budget."],
    ["LekhNeuralBeamSearch.rank(", "Runtime must use bounded beam decoding."],
    ["LekhDevanagariOutputSequence.analyze", "Runtime must constrain Devanagari output sequences."]
  ];
  if (ctcRuntime) {
    requiredMarkers.push(
      ["validateCTCModelContract", "Runtime must validate the fixed CTC Core ML I/O contract."],
      [CTC_RUNTIME_CONTRACT, "Runtime must implement the single-transformer-ctc-v1 contract."],
      ["LekhNeuralCTCPrefixBeamSearch.rank(", "Runtime must use deterministic CTC prefix-beam decoding."]
    );
  }
  for (const [needle, message] of requiredMarkers) {
    require(service.includes(needle), message);
  }
  require(
    !service.includes(
      "guard (manifest?.productionEligible == true || experimentalEnabled)"
    ),
    "A manifest boolean must never directly enable Core ML inference."
  );
}

function verifyDecoderContract() {
  require(
    decoderContract.schemaVersion === 2,
    "Decoder contract schemaVersion must be 2."
  );
  if (!ctcRuntime) {
    require(
      decoderContract.score === "accumulated-log-softmax",
      "Decoder contract must use log-softmax scoring."
    );
    require(
      decoderContract.lengthNormalization ===
        "score-divided-by-token-count-including-sos",
      "Decoder length normalization is inconsistent."
    );
    require(
      decoderContract.tokenization === "unicode-scalar-character" &&
        decoderContract.outputSequenceValidation ===
          "devanagari-word-sequence-v1" &&
        decoderContract.maxSteps === "maxOutputLength-minus-1",
      "Decoder contract is not the frozen scalar sequence contract."
    );
  } else {
    require(
      decoderContract.tokenization === "unicode-scalar-character" &&
        decoderContract.outputSequenceValidation ===
          "devanagari-word-sequence-v1",
      "CTC runtime must retain the frozen scalar output grammar."
    );
  }
  require(
    Array.isArray(decoderContract.sequenceCases) &&
      decoderContract.sequenceCases.length >= 35,
    "Decoder contract must retain its cross-language grammar cases."
  );
  const grammarOracle = decoderContract.productionGrammarOracle;
  require(
    grammarOracle?.id === "ctc-output-vocabulary-cartesian-prefixes-v1" &&
      grammarOracle?.enumeration ===
        "ordered-cartesian-product-depth-1-through-3" &&
      grammarOracle?.serialization ===
        "utf8-value-tab-validPrefix-bit-tab-terminable-bit-tab-comma-joined-issueCodes-lf" &&
      grammarOracle?.maxDepth === 3 &&
      grammarOracle?.sequenceCount === 278_915 &&
      grammarOracle?.validPrefixCount === 181_035 &&
      grammarOracle?.terminableCount === 181_035 &&
      /^[a-f0-9]{64}$/.test(grammarOracle?.sha256 ?? "") &&
      Array.isArray(grammarOracle?.tokens) &&
      grammarOracle.tokens.length === 65 &&
      new Set(grammarOracle.tokens).size === grammarOracle.tokens.length &&
      grammarOracle.tokens.every(
        (token) => typeof token === "string" && [...token].length === 1
      ),
    "Decoder contract must retain the exhaustive production-vocabulary grammar oracle."
  );
  require(
    Array.isArray(decoderContract.ctcCases) &&
      decoderContract.ctcCases.length >= 5,
    "Decoder contract must retain its cross-language CTC state-machine cases."
  );
}

function verifyPromotionReceipt() {
  if (!production) return;
  if (!promotionReport) {
    failures.push("Production conformance requires the immutable promotion receipt.");
    return;
  }
  require(
    promotionReport.status === "passed-neural-candidate-promotion",
    "Promotion receipt status is not passed."
  );
  require(
    promotionReport.trainingRunId === manifest.trainingRunId &&
      promotionReport.exportRunId === manifest.exportRunId,
    "Promotion receipt run identities are stale."
  );
  require(
    promotionReport.artifactSetSha256 === descriptor.artifactSetSha256,
    "Promotion receipt artifact-set identity is stale."
  );
  require(
    promotionReport.productionManifest?.sha256 === descriptor.manifestSha256,
    "Promotion receipt production manifest digest is stale."
  );
  require(
    promotionReport.inputs?.checkpoint?.sha256 ===
      manifest.sha256?.sourceCheckpoint,
    "Promotion receipt source checkpoint digest is stale."
  );
  require(
    promotionReport.inputs?.datasetManifest?.sha256 ===
      manifest.sha256?.trainingDatasetManifest,
    "Promotion receipt dataset digest is stale."
  );
}

function verifyEndToEndEvidence() {
  if (!e2e) {
    if (production) {
      failures.push("Production conformance requires a packaged full-service benchmark.");
    } else {
      warnings.push("No local packaged full-service benchmark is present.");
    }
    return;
  }
  const identity = e2e.artifactIdentity;
  require(
    identity?.trainingRunId === manifest.trainingRunId &&
      identity?.exportRunId === manifest.exportRunId &&
      identity?.manifestSha256 === descriptor.manifestSha256 &&
      identity?.vocabSha256 === descriptor.vocabSha256 &&
      identity?.artifactSetSha256 === descriptor.artifactSetSha256,
    "End-to-end report is stale for the selected runtime artifact set."
  );
  require(
    e2e.singleForwardBenchmarkIsConsumerLatency === false,
    "Latency evidence must cover full candidate generation."
  );
  if (production) {
    const placement = validateNeuralRuntimePlacementEvidence(
      e2e.computePlacement?.runtimePlacement,
      { artifactDescriptor: descriptor }
    );
    require(
      e2e.status === "passed-production" &&
        e2e.proofMode === "production",
      "Production conformance requires a production-mode service pass."
    );
    require(
      e2e.computePlacement?.neuralEngineClaimAllowed === true &&
        placement.neuralEngineClaimAllowed === true &&
        e2e.computePlacement?.artifactSetSha256 ===
          descriptor.artifactSetSha256,
      "Production evidence must prove Neural Engine placement for this artifact set."
    );
  }
  require(
    e2e.performance?.p95Ms < 50 && e2e.performance?.p99Ms < 50,
    "Full candidate latency exceeds 50 ms."
  );
  require(
    e2e.singleTokenPhraseExpansionRate === 0 &&
      Array.isArray(e2e.secureFieldCandidates) &&
      e2e.secureFieldCandidates.length === 0,
    "Service safety evidence is incomplete."
  );
  require(
    e2e.latestRequestWins === true &&
      e2e.cancelPendingSuppressesCompletion === true,
    "Cancellation evidence is incomplete."
  );
}

function requireCTCVocabularyContract(vocabulary) {
  const input = vocabulary?.input;
  const output = vocabulary?.output;
  requireClosedVocabularyBijection(input, "CTC input vocabulary", 4);
  requireClosedVocabularyBijection(output, "CTC output vocabulary", 2);
  if (!input || !output) return;

  const inputSpecial = [
    ["<pad>", input.padId],
    ["</s>", input.eosId],
    ["<unk>", input.unkId]
  ];
  require(
    input.sosId === undefined &&
      inputSpecial.every(([token, id]) =>
        Number.isInteger(id) &&
        id >= 0 &&
        id < input.tokensById.length &&
        input.tokensById[id] === token
      ) &&
      new Set(inputSpecial.map(([, id]) => id)).size === inputSpecial.length,
    "CTC input special-token identities must be distinct and exact without SOS."
  );
  const inputSpecialIds = new Set(inputSpecial.map(([, id]) => id));
  require(
    input.tokensById.every((token, index) =>
      inputSpecialIds.has(index) || /^[a-z]$/u.test(token)
    ),
    "Every non-special CTC input token must be one lowercase ASCII letter."
  );
  require(
    output.blankId === 0 &&
      output.tokensById[0] === "<ctc-blank>" &&
      output.idsByToken?.["<ctc-blank>"] === 0,
    "CTC blank token must occupy output class zero."
  );
  require(
    output.tokensById.every((token, index) =>
      index === output.blankId || isSupportedDevanagariScalar(token)
    ),
    "Every non-blank CTC output token must be one supported Devanagari or joiner scalar."
  );
}

function requireClosedVocabularyBijection(vocabulary, label, minimumTokens) {
  const tokens = vocabulary?.tokensById;
  const ids = vocabulary?.idsByToken;
  require(
    Array.isArray(tokens) && tokens.length >= minimumTokens,
    `${label} tokensById must contain a closed token inventory.`
  );
  require(
    ids && typeof ids === "object" && !Array.isArray(ids),
    `${label} idsByToken must be an object.`
  );
  if (!Array.isArray(tokens) ||
      !ids ||
      typeof ids !== "object" ||
      Array.isArray(ids)) return;
  require(new Set(tokens).size === tokens.length, `${label} tokens must be unique.`);
  require(
    Object.keys(ids).length === tokens.length &&
      tokens.every((token, index) => ids[token] === index),
    `${label} token/id mappings must be a complete bijection.`
  );
}

function requireCTCTensorContract(contract, vocabulary) {
  const inputShape = contract?.inputIds?.shape;
  const logitsShape = contract?.logits?.shape;
  require(
    contract &&
      typeof contract === "object" &&
      !Array.isArray(contract) &&
      Object.keys(contract).sort().join(",") === "inputIds,logits",
    "CTC manifest tensorContract must contain only inputIds and logits."
  );
  require(
    Array.isArray(inputShape) &&
      inputShape.length === 2 &&
      inputShape[0] === 1 &&
      inputShape[1] === vocabulary.input?.maxLength &&
      contract?.inputIds?.dataType === "INT32",
    "CTC inputIds tensor shape or data type differs from the vocabulary."
  );
  require(
    Array.isArray(logitsShape) &&
      logitsShape.length === 3 &&
      logitsShape[0] === 1 &&
      logitsShape[1] === vocabulary.output?.timeSteps &&
      logitsShape[2] === vocabulary.output?.tokensById?.length &&
      contract?.logits?.dataType === "FLOAT16",
    "CTC logits tensor shape or data type differs from the vocabulary."
  );
}

function isSupportedDevanagariScalar(value) {
  if (typeof value !== "string") return false;
  const scalars = [...value];
  if (scalars.length !== 1) return false;
  const codePoint = scalars[0].codePointAt(0);
  return (codePoint >= 0x0900 && codePoint <= 0x097F) ||
    codePoint === 0x200C ||
    codePoint === 0x200D;
}

function requireVocabularyContract(vocabulary, label) {
  const tokens = vocabulary?.tokensById;
  const ids = vocabulary?.idsByToken;
  const special = [
    ["<pad>", vocabulary?.padId],
    ["<s>", vocabulary?.sosId],
    ["</s>", vocabulary?.eosId],
    ["<unk>", vocabulary?.unkId]
  ];
  require(
    Array.isArray(tokens) && tokens.length >= 5,
    `${label} tokensById must contain a closed token inventory.`
  );
  require(
    ids && typeof ids === "object" && !Array.isArray(ids),
    `${label} idsByToken must be an object.`
  );
  if (!Array.isArray(tokens) ||
      !ids ||
      typeof ids !== "object" ||
      Array.isArray(ids)) return;
  require(new Set(tokens).size === tokens.length, `${label} tokens must be unique.`);
  require(
    Object.keys(ids).length === tokens.length &&
      tokens.every((token, index) => ids[token] === index),
    `${label} token/id mappings must be a complete bijection.`
  );
  require(
    special.every(([token, id]) =>
      Number.isInteger(id) &&
      id >= 0 &&
      id < tokens.length &&
      tokens[id] === token
    ) &&
      new Set(special.map(([, id]) => id)).size === special.length,
    `${label} special-token identities must be distinct and exact.`
  );
}

function readJsonEvidence(path, label) {
  const evidence = inspectContainedRegularFile(root, path, {
    label,
    includeContents: true,
    maxBytes: 16 * 1024 * 1024
  });
  return parseJson(evidence.contents, label);
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    failures.push(`${label} is invalid JSON: ${error.message}`);
    return {};
  }
}

function require(condition, message) {
  if (!condition) failures.push(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : "1";
    values.set(key, value);
    if (value !== "1") index += 1;
  }
  return values;
}

function finish(manifestValue, descriptorValue, e2eValue, promotionValue) {
  const status = failures.length === 0
    ? production
      ? "passed-production-runtime-conformance"
      : "passed-experimental"
    : "failed";
  const report = {
    generatedAt: new Date().toISOString(),
    command: `node scripts/check-neural-runtime-manifest-conformance.mjs${production ? " --production" : ""}`,
    suite: "neural-runtime-manifest-conformance",
    status,
    production,
    artifactRoot: relative(root, artifactRoot),
    artifactSetSha256: descriptorValue?.artifactSetSha256 ?? null,
    manifest: existsSync(manifestPath) ? relative(root, manifestPath) : null,
    manifestSchemaVersion: manifestValue?.schemaVersion ?? null,
    trainingRunId: manifestValue?.trainingRunId ?? null,
    exportRunId: manifestValue?.exportRunId ?? null,
    productionEligible: manifestValue?.productionEligible ?? null,
    artifacts: descriptorValue?.artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.sourceRelativePath,
      bytes: artifact.compiledBytes,
      sha256: artifact.compiledSha256
    })) ?? [],
    sourceCheckpointSha256:
      promotionValue?.inputs?.checkpoint?.sha256 ?? null,
    trainingDatasetManifestSha256: datasetManifestEvidence?.sha256 ?? null,
    evaluationBeamWidth: manifestValue?.beamSearch?.beamWidth ?? null,
    nativeRuntimeBeamWidth: vocab?.decoder?.beamWidth ?? null,
    decoderContract: relative(root, decoderContractPath),
    decoderContractSha256: decoderContractEvidence?.sha256 ?? null,
    iterativeServiceLatency: e2eValue?.performance ?? null,
    singleForwardBenchmarkIsConsumerLatency: false,
    failures,
    warnings
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  (failures.length === 0 ? console.log : console.error)(
    JSON.stringify(report, null, 2)
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

function finishUnavailable() {
  const report = {
    generatedAt: new Date().toISOString(),
    command: `node scripts/check-neural-runtime-manifest-conformance.mjs${production ? " --production" : ""}`,
    suite: "neural-runtime-manifest-conformance",
    status: "failed",
    production,
    artifactRoot: relative(root, artifactRoot),
    artifactSetSha256: null,
    manifest: existsSync(manifestPath) ? relative(root, manifestPath) : null,
    artifacts: [],
    failures,
    warnings
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
