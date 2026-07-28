#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  validateNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";
import {
  validateNeuralRuntimePlacementEvidence
} from "./lib/neural-runtime-placement-evidence.mjs";

const ROOT = realpathSync(process.cwd());
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const reportPath = safePath(
  args.get("report") ??
    join(
      ROOT,
      "reports",
      production
        ? "neural-sota-worldclass-production-report.json"
        : "neural-sota-worldclass-report.json"
    ),
  "Final neural readiness report"
);
const productionDirectory = join(
  ROOT,
  "models",
  "macos",
  "LekhNeuralTransliterator.production"
);
const canonicalTrainingSource = "ai4bharat-aksharantar-nepali";
const blockedMirrorSources = [
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
];
const failures = [];
const warnings = [];

const datasetReportPath = join(
  ROOT,
  "reports",
  production
    ? "neural-open-vocab-dataset-production-report.json"
    : "neural-open-vocab-dataset-report.json"
);
const datasetReport = readOptionalJson(
  datasetReportPath,
  "Open-vocabulary dataset report"
);
const datasetRows = Number(datasetReport?.value?.totalRows ?? 0);
const aksharantarRows = Number(
  datasetReport?.value?.sourceCounts?.[canonicalTrainingSource] ?? 0
);
const blockedMirrorRows = Object.fromEntries(
  blockedMirrorSources.map((source) => [
    source,
    Number(datasetReport?.value?.sourceCounts?.[source] ?? 0)
  ])
);
validateSourceCounts();

let verification = null;
if (production) {
  try {
    verification = verifyProductionReadiness();
  } catch (error) {
    failures.push(errorMessage(error));
  }
} else {
  validateDevelopmentLineageManifest();
  if (!existsSync(productionDirectory)) {
    warnings.push(
      "No promoted neural production directory exists; this is a development " +
      "readiness guard, not a production claim."
    );
  } else {
    warnings.push(
      "A promoted bundle exists, but production evidence was not requested; " +
      "run this checker with --production."
    );
  }
}

const status = failures.length === 0
  ? production
    ? "passed-production-phase10-neural-readiness"
    : "passed-phase10-neural-readiness-guard"
  : production
    ? "failed-production-phase10-neural-readiness"
    : "failed-phase10-neural-readiness";
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  command: "node scripts/check-neural-sota-worldclass.mjs",
  suite: "neural-production-readiness",
  durationMs: Math.round(performance.now() - startedAt),
  phase: 10,
  production,
  status,
  productionDirectory: relative(ROOT, productionDirectory).split(sep).join("/"),
  datasetRows,
  aksharantarRows,
  sourceLineagePolicy: {
    canonicalTrainingSource,
    blockedMirrorRows
  },
  verification,
  verdict: production && failures.length === 0
    ? "production-neural-evidence-complete-no-sota-claim"
    : "production-neural-model-not-yet-verified",
  failures,
  warnings
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status,
  report: portable(reportPath),
  verdict: report.verdict,
  artifactSetSha256: verification?.artifactSetSha256 ?? null,
  officialBenchmark: verification?.officialBenchmark ?? null,
  failures,
  warnings
}, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;

function verifyProductionReadiness() {
  if (!existsSync(productionDirectory)) {
    fail("Canonical promoted neural production directory is missing.");
  }
  const manifestPath = join(
    productionDirectory,
    "LekhNeuralTransliterator.manifest.json"
  );
  const vocabularyPath = join(
    productionDirectory,
    "LekhNeuralTransliterator.vocab.json"
  );
  const promotionReceiptPath = join(
    productionDirectory,
    "neural-candidate-promotion-report.json"
  );
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: ROOT,
    manifestPath,
    vocabPath: vocabularyPath,
    artifactDirectory: productionDirectory,
    verifyExportArtifacts: false
  });
  const manifest = descriptor.manifest;
  if (manifest.productionEligible !== true ||
      manifest.localOnly !== true ||
      manifest.neuralTailOnly !== true ||
      manifest.openVocabulary !== true) {
    fail("Production manifest eligibility and privacy contract is incomplete.");
  }
  validateManifestSources(manifest, "Production neural manifest");

  const receipt = readRequiredJson(
    promotionReceiptPath,
    "Atomic neural promotion receipt"
  );
  if (receipt.value.status !== "passed-neural-candidate-promotion" ||
      receipt.value.trainingRunId !== manifest.trainingRunId ||
      receipt.value.exportRunId !== manifest.exportRunId ||
      receipt.value.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      receipt.value.productionManifest?.sha256 !== descriptor.manifestSha256) {
    fail("Atomic promotion receipt is stale for the production artifact set.");
  }

  const phase9 = readRequiredJson(
    join(ROOT, "reports", "neural-production-promotion-production-report.json"),
    "Phase 9 receipt verification"
  );
  if (phase9.value.status !== "passed-production-phase9-promotion" ||
      phase9.value.verification?.promotionId !== receipt.value.promotionId ||
      phase9.value.verification?.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      phase9.value.verification?.manifest?.sha256 !==
        descriptor.manifestSha256) {
    fail("Phase 9 did not verify this exact atomic promotion receipt.");
  }

  const selectionEvidence = readEvidenceRecord(
    receipt.value.inputs?.selectionReport,
    "Retained model-selection report"
  );
  const selection = validateNeuralSelectionReport(selectionEvidence.value);
  if (selection.selectionId !== receipt.value.inputs?.selectionId ||
      selection.winner.identity.trainingRunId !== manifest.trainingRunId ||
      selection.winner.identity.exportRunId !== manifest.exportRunId ||
      selection.winner.identity.artifactSetSha256 !==
        descriptor.artifactSetSha256) {
    fail("Production artifact is not the deterministic model-selection winner.");
  }

  const evaluation = readEvidenceRecord(
    receipt.value.inputs?.evaluationReport,
    "Retained production gold evaluation"
  );
  if (evaluation.value.status !== "passed-production-phase5-evaluation" ||
      evaluation.value.productionEligible !== true ||
      evaluation.value.predictionValidation?.exactCoverage !== true ||
      evaluation.value.predictionValidation?.metricsReportable !== true ||
      !Array.isArray(evaluation.value.failures) ||
      evaluation.value.failures.length !== 0 ||
      canonicalJson(evaluation.value.metrics) !==
        canonicalJson(manifest.metrics)) {
    fail("Production metrics are not copied from one exact passed gold evaluation.");
  }

  const comparison = readEvidenceRecord(
    receipt.value.inputs?.comparisonReport,
    "Retained official benchmark evaluation"
  );
  if (comparison.value.status !== "passed-official-benchmark-evaluation" ||
      comparison.value.productionEligible !== true ||
      comparison.value.qualityGate?.passed !== true ||
      comparison.value.artifactIdentity?.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      comparison.value.benchmarkManifestSha256 !==
        receipt.value.inputs?.comparisonBenchmarkManifest?.sha256 ||
      comparison.value.predictionsSha256 !==
        receipt.value.inputs?.comparisonPredictions?.sha256) {
    fail("Official benchmark evidence is stale or did not pass its quality floor.");
  }

  const productionE2E = readRequiredJson(
    join(ROOT, "reports", "neural-native-service-e2e-production-report.json"),
    "Packaged production full-service benchmark"
  );
  verifyProductionE2E(productionE2E.value, descriptor, manifest);

  const coreMLBenchmark = readRequiredJson(
    join(ROOT, "reports", "neural-coreml-device-benchmark-production.json"),
    "Production Core ML device benchmark"
  );
  if (coreMLBenchmark.value.status !==
        "passed-production-phase5-coreml-benchmark" ||
      coreMLBenchmark.value.productionEligible !== true ||
      coreMLBenchmark.value.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      coreMLBenchmark.value.computePlacement?.neuralEngineClaimAllowed !== true ||
      !Number.isFinite(coreMLBenchmark.value.performance?.p99Ms) ||
      coreMLBenchmark.value.performance.p99Ms >= 50) {
    fail("Production device benchmark is stale, incomplete, or too slow.");
  }

  const nativeIntegration = readRequiredJson(
    join(ROOT, "reports", "neural-native-integration-production-report.json"),
    "Production native integration report"
  );
  if (nativeIntegration.value.status !==
        "passed-production-phase6-native-integration" ||
      nativeIntegration.value.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      nativeIntegration.value.failOpenRawTyping !== true ||
      nativeIntegration.value.secureFieldInferenceBlocked !== true) {
    fail("Native integration did not pass for this production artifact set.");
  }

  const runtimeConformance = readRequiredJson(
    join(
      ROOT,
      "reports",
      "neural-runtime-manifest-conformance-production-report.json"
    ),
    "Production runtime conformance report"
  );
  if (runtimeConformance.value.status !==
        "passed-production-runtime-conformance" ||
      runtimeConformance.value.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      runtimeConformance.value.trainingRunId !== manifest.trainingRunId ||
      runtimeConformance.value.exportRunId !== manifest.exportRunId ||
      runtimeConformance.value.productionEligible !== true ||
      !Array.isArray(runtimeConformance.value.failures) ||
      runtimeConformance.value.failures.length !== 0) {
    fail("Runtime conformance did not pass for this production artifact set.");
  }

  const datasetManifest = readEvidenceRecord(
    receipt.value.inputs?.datasetManifest,
    "Retained training dataset manifest"
  );
  if (datasetManifest.value.datasetContentSha256 !==
        receipt.value.inputs?.datasetContentSha256 ||
      datasetManifest.value.totalRows < 1_000_000 ||
      Number(datasetManifest.value.sourceCounts?.[canonicalTrainingSource] ?? 0) <
        1_000_000) {
    fail("Retained production training dataset identity or row floor is invalid.");
  }
  for (const source of blockedMirrorSources) {
    if (Number(datasetManifest.value.sourceCounts?.[source] ?? 0) !== 0) {
      fail(`Retained dataset counts blocked lineage mirror ${source}.`);
    }
  }

  return {
    promotionId: receipt.value.promotionId,
    selectionId: selection.selectionId,
    trainingRunId: manifest.trainingRunId,
    exportRunId: manifest.exportRunId,
    modelId: descriptor.modelId,
    runtimeModelContract: descriptor.runtimeModelContract,
    manifestSha256: descriptor.manifestSha256,
    artifactSetSha256: descriptor.artifactSetSha256,
    totalCompiledBytes: descriptor.totalCompiledBytes,
    goldMetrics: manifest.metrics,
    officialBenchmark: {
      corpusSha256: comparison.value.benchmarkCorpusSha256,
      metrics: comparison.value.metrics,
      reference: comparison.value.reference?.metrics ?? null,
      qualityGate: comparison.value.qualityGate
    },
    packagedPerformance: productionE2E.value.performance,
    neuralEngineClaimAllowed:
      productionE2E.value.computePlacement.neuralEngineClaimAllowed,
    dataset: {
      totalRows: datasetManifest.value.totalRows,
      canonicalRows:
        datasetManifest.value.sourceCounts[canonicalTrainingSource],
      contentSha256: datasetManifest.value.datasetContentSha256
    }
  };
}

function verifyProductionE2E(reportValue, descriptor, manifest) {
  const identity = reportValue.artifactIdentity;
  const placement = validateNeuralRuntimePlacementEvidence(
    reportValue.computePlacement?.runtimePlacement,
    { artifactDescriptor: descriptor }
  );
  if (reportValue.status !== "passed-production" ||
      reportValue.proofMode !== "production" ||
      reportValue.singleForwardBenchmarkIsConsumerLatency !== false ||
      identity?.trainingRunId !== manifest.trainingRunId ||
      identity?.exportRunId !== manifest.exportRunId ||
      identity?.manifestSha256 !== descriptor.manifestSha256 ||
      identity?.vocabSha256 !== descriptor.vocabSha256 ||
      identity?.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      reportValue.computePlacement?.neuralEngineClaimAllowed !== true ||
      placement.neuralEngineClaimAllowed !== true ||
      reportValue.computePlacement?.artifactSetSha256 !==
        descriptor.artifactSetSha256 ||
      !Number.isFinite(reportValue.performance?.p99Ms) ||
      reportValue.performance.p99Ms >= 50 ||
      reportValue.singleTokenPhraseExpansionRate !== 0 ||
      !Array.isArray(reportValue.secureFieldCandidates) ||
      reportValue.secureFieldCandidates.length !== 0 ||
      reportValue.latestRequestWins !== true ||
      reportValue.cancelPendingSuppressesCompletion !== true) {
    fail("Packaged production full-service evidence is stale or incomplete.");
  }
}

function validateSourceCounts() {
  if (!datasetReport) {
    if (production) {
      failures.push("Production readiness requires the current dataset report.");
    } else {
      warnings.push("Development dataset report is absent.");
    }
    return;
  }
  if (!Number.isFinite(datasetRows) || datasetRows < 1_000_000) {
    failures.push(
      `Neural readiness requires at least 1,000,000 cleaned rows; found ` +
      `${datasetRows || 0}.`
    );
  }
  if (!Number.isFinite(aksharantarRows) || aksharantarRows < 1_000_000) {
    failures.push(
      `Neural readiness requires at least 1,000,000 canonical ` +
      `${canonicalTrainingSource} rows; found ${aksharantarRows || 0}.`
    );
  }
  for (const [source, count] of Object.entries(blockedMirrorRows)) {
    if (!Number.isFinite(count) || count !== 0) {
      failures.push(
        `Neural readiness requires blocked lineage mirror ${source} to ` +
        `contribute 0 rows; found ${Number.isFinite(count) ? count : "invalid"}.`
      );
    }
  }
}

function validateDevelopmentLineageManifest() {
  const path = join(
    ROOT,
    "models",
    "macos",
    "LekhNeuralTransliterator.manifest.json"
  );
  if (!existsSync(path)) return;
  const manifest = readRequiredJson(path, "Development neural manifest").value;
  validateManifestSources(manifest, "Development neural manifest");
}

function validateManifestSources(manifest, label) {
  const sources = new Set((manifest.trainingSources ?? []).map(String));
  if (!sources.has(canonicalTrainingSource)) {
    failures.push(`${label} omits canonical source ${canonicalTrainingSource}.`);
  }
  for (const mirror of blockedMirrorSources) {
    if (sources.has(mirror)) {
      failures.push(`${label} counts blocked lineage mirror ${mirror}.`);
    }
  }
}

function readEvidenceRecord(record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      typeof record.path !== "string" ||
      !/^[a-f0-9]{64}$/u.test(String(record.sha256 ?? "")) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1) {
    fail(`${label} receipt record is invalid.`);
  }
  const evidence = readRequiredJson(
    safePath(record.path, label),
    label
  );
  if (evidence.file.sha256 !== record.sha256 ||
      evidence.file.bytes !== record.bytes) {
    fail(`${label} bytes differ from the atomic promotion receipt.`);
  }
  return evidence;
}

function readRequiredJson(path, label) {
  const file = inspectContainedRegularFile(ROOT, safePath(path, label), {
    label,
    includeContents: true,
    maxBytes: 32 * 1024 * 1024
  });
  let parsed;
  try {
    parsed = JSON.parse(file.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
  return { file, value: parsed };
}

function readOptionalJson(path, label) {
  if (!existsSync(path)) return null;
  try {
    return readRequiredJson(path, label);
  } catch (error) {
    failures.push(errorMessage(error));
    return null;
  }
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--production") {
      if (values.has("production")) fail("Duplicate --production.");
      values.set("production", "1");
      continue;
    }
    if (argument !== "--report") {
      fail(`Unknown final-readiness argument ${argument}.`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) fail("Missing value for --report.");
    if (values.has("report")) fail("Duplicate --report.");
    values.set("report", next);
    index += 1;
  }
  return values;
}

function safePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} path must be a non-empty string.`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(ROOT, value);
  const child = relative(ROOT, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} path escapes the repository.`);
  }
  return path;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function portable(path) {
  return relative(ROOT, resolve(path)).split(sep).join("/");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(message);
}
