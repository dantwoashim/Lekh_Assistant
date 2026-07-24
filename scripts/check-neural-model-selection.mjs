#!/usr/bin/env node

import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  NeuralModelSelectionError,
  buildNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";

const ROOT = realpathSync(process.cwd());
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.flags.has("production");
const candidateSpecifications = args.values.get("candidate-spec") ?? [];
const reportPath = canonicalPath(
  singleValue(args, "report") ??
    join(
      ROOT,
      "reports",
      production
        ? "neural-model-selection-production-report.json"
        : "neural-model-selection-report.json"
    )
);
const CANONICAL_TRAINING_SOURCE = "ai4bharat-aksharantar-nepali";
const BLOCKED_MIRROR_SOURCES = Object.freeze([
  "syubraj-roman2nepali-transliteration",
  "saugatkafley-nepali-roman-transliteration"
]);

try {
  if (candidateSpecifications.length === 0) {
    if (production) {
      fail(
        "Production model selection requires at least two --candidate-spec " +
        "evidence dossiers."
      );
    }
    runSourceLineageCompatibilityMode();
  } else {
    if (args.values.has("manifest") || args.values.has("model")) {
      fail(
        "--manifest/--model are source-policy compatibility options and cannot " +
        "be combined with --candidate-spec."
      );
    }
    const candidates = candidateSpecifications.map((path, index) =>
      buildVerifiedCandidate(path, index)
    );
    const report = buildNeuralSelectionReport({ candidates });
    writeReport({
      ...structuredClone(report),
      command: "node scripts/check-neural-model-selection.mjs",
      durationMs: Math.round(performance.now() - startedAt),
      production,
      failures: [],
      warnings: []
    }, 0);
  }
} catch (error) {
  const message = errorMessage(error);
  writeReport({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-model-selection.mjs",
    suite: "neural-model-selection",
    durationMs: Math.round(performance.now() - startedAt),
    status: production
      ? "failed-production-neural-model-selection"
      : "failed-neural-model-selection",
    production,
    failures: [message],
    warnings: []
  }, 1);
}

function buildVerifiedCandidate(specificationPath, index) {
  const specificationEvidence = readJsonEvidence(
    specificationPath,
    `Candidate specification ${index + 1}`
  );
  const specification = specificationEvidence.value;
  requireExactKeys(specification, [
    "benchmarkReport",
    "candidateRoot",
    "comparisonReport",
    "evaluationReport",
    "label",
    "schemaVersion"
  ], `Candidate specification ${index + 1}`);
  if (specification.schemaVersion !== 1) {
    fail(`Candidate specification ${index + 1} must use schemaVersion 1.`);
  }
  if (typeof specification.label !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(specification.label)) {
    fail(`Candidate specification ${index + 1} has an invalid label.`);
  }

  const candidateRoot = containedPath(
    specification.candidateRoot,
    `Candidate ${specification.label} root`
  );
  const candidateRootStat = lstatSync(candidateRoot);
  if (candidateRootStat.isSymbolicLink() || !candidateRootStat.isDirectory() ||
      realpathSync(candidateRoot) !== candidateRoot) {
    fail(
      `Candidate ${specification.label} root must be a real, canonical directory.`
    );
  }
  const manifestPath = join(
    candidateRoot,
    "LekhNeuralTransliterator.manifest.json"
  );
  const vocabularyPath = join(
    candidateRoot,
    "LekhNeuralTransliterator.vocab.json"
  );
  const exportReportPath = join(candidateRoot, "export-report.json");
  const manifestEvidence = readJsonEvidence(
    manifestPath,
    `Candidate ${specification.label} manifest`
  );
  const exportEvidence = readJsonEvidence(
    exportReportPath,
    `Candidate ${specification.label} export report`
  );
  const evaluationEvidence = readJsonEvidence(
    specification.evaluationReport,
    `Candidate ${specification.label} evaluation report`
  );
  const benchmarkEvidence = readJsonEvidence(
    specification.benchmarkReport,
    `Candidate ${specification.label} packaged benchmark report`
  );
  const comparisonEvidence = readJsonEvidence(
    specification.comparisonReport,
    `Candidate ${specification.label} official benchmark report`
  );
  const vocabularyEvidence = inspectContainedRegularFile(
    ROOT,
    vocabularyPath,
    {
      label: `Candidate ${specification.label} vocabulary`,
      maxBytes: 16 * 1024 * 1024
    }
  );
  const manifest = manifestEvidence.value;
  const exportReport = exportEvidence.value;
  const evaluation = evaluationEvidence.value;
  const benchmark = benchmarkEvidence.value;
  const comparison = comparisonEvidence.value;
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: ROOT,
    manifest,
    manifestPath,
    vocabPath: vocabularyPath
  });
  for (const artifact of descriptor.artifacts) {
    assertWithin(
      candidateRoot,
      artifact.sourcePath,
      `Candidate ${specification.label} runtime artifact`
    );
  }

  validateCandidateManifest(manifest, specification.label);
  validateExportReport({
    label: specification.label,
    candidateRoot,
    manifest,
    manifestEvidence: manifestEvidence.file,
    exportReport,
    exportReportPath,
    descriptor
  });
  const evaluationBindings = validateEvaluationReport({
    label: specification.label,
    manifest,
    manifestEvidence: manifestEvidence.file,
    exportEvidence: exportEvidence.file,
    evaluation,
    descriptor
  });
  const latencyP99Ms = validateBenchmarkReport({
    label: specification.label,
    manifest,
    manifestEvidence: manifestEvidence.file,
    benchmark,
    descriptor
  });
  const comparisonMetrics = validateComparisonReport({
    label: specification.label,
    manifest,
    manifestEvidence: manifestEvidence.file,
    comparison,
    descriptor
  });

  const datasetManifestEvidence = inspectBoundFile(
    evaluation.datasetManifest,
    evaluation.datasetManifestSha256,
    `Candidate ${specification.label} dataset manifest`
  );
  const datasetManifest = parseEvidenceJson(
    datasetManifestEvidence,
    `Candidate ${specification.label} dataset manifest`
  );
  if (datasetManifest.datasetContentSha256 !==
      evaluation.datasetContentSha256) {
    fail(
      `Candidate ${specification.label} dataset content identity is inconsistent.`
    );
  }
  const goldManifestEvidence = inspectBoundFile(
    evaluation.goldManifest,
    evaluation.goldManifestSha256,
    `Candidate ${specification.label} gold manifest`
  );
  const goldManifest = parseEvidenceJson(
    goldManifestEvidence,
    `Candidate ${specification.label} gold manifest`
  );
  if (goldManifest.corpusSha256 !== evaluation.goldCorpusSha256) {
    fail(
      `Candidate ${specification.label} gold corpus identity is inconsistent.`
    );
  }
  const benchmarkManifestEvidence = inspectBoundFile(
    comparison.benchmarkManifest,
    comparison.benchmarkManifestSha256,
    `Candidate ${specification.label} official benchmark manifest`
  );
  const benchmarkManifest = parseEvidenceJson(
    benchmarkManifestEvidence,
    `Candidate ${specification.label} official benchmark manifest`
  );
  if (benchmarkManifest.corpusSha256 !== comparison.benchmarkCorpusSha256) {
    fail(
      `Candidate ${specification.label} official benchmark corpus identity is ` +
      "inconsistent."
    );
  }
  const comparisonPredictionsEvidence = inspectBoundFile(
    comparison.predictions,
    comparison.predictionsSha256,
    `Candidate ${specification.label} official benchmark predictions`
  );

  const trainingRunId = requireRunId(
    manifest.trainingRunId,
    `Candidate ${specification.label} trainingRunId`
  );
  const exportRunId = requireRunId(
    manifest.exportRunId,
    `Candidate ${specification.label} exportRunId`
  );
  return {
    candidateId: `${specification.label}:${exportRunId}`,
    candidateRoot: portable(candidateRoot),
    modelId: manifest.selectedArtifact,
    architecture: manifest.architecture,
    eligible: true,
    identity: {
      trainingRunId,
      exportRunId,
      manifestSha256: manifestEvidence.file.sha256,
      exportReportSha256: exportEvidence.file.sha256,
      vocabSha256: vocabularyEvidence.sha256,
      artifactSetSha256: descriptor.artifactSetSha256
    },
    evidence: {
      specification: evidenceRecord(specificationEvidence.file),
      manifest: evidenceRecord(manifestEvidence.file),
      exportReport: evidenceRecord(exportEvidence.file),
      evaluationReport: evidenceRecord(evaluationEvidence.file),
      datasetManifest: evidenceRecord(datasetManifestEvidence),
      goldManifest: evidenceRecord(goldManifestEvidence),
      benchmarkReport: evidenceRecord(benchmarkEvidence.file),
      comparisonReport: evidenceRecord(comparisonEvidence.file),
      benchmarkManifest: evidenceRecord(benchmarkManifestEvidence),
      comparisonPredictions: evidenceRecord(comparisonPredictionsEvidence)
    },
    bindings: {
      datasetManifestSha256: evaluationBindings.datasetManifestSha256,
      datasetContentSha256: evaluationBindings.datasetContentSha256,
      goldManifestSha256: evaluationBindings.goldManifestSha256,
      goldCorpusSha256: evaluationBindings.goldCorpusSha256,
      benchmarkManifestSha256: benchmarkManifestEvidence.sha256,
      benchmarkCorpusSha256: benchmarkManifest.corpusSha256
    },
    metrics: {
      officialOverallTop1Accuracy:
        comparisonMetrics.overall.top1Accuracy,
      officialOverallTop3Accuracy:
        comparisonMetrics.overall.top3Accuracy,
      officialNativeTop1Accuracy:
        comparisonMetrics.native.top1Accuracy,
      officialNameTop1Accuracy:
        comparisonMetrics.namesTop1Accuracy,
      goldTailTop1Accuracy: requireRate(
        evaluation.metrics?.tailTop1Accuracy,
        `Candidate ${specification.label} gold tail top-1`
      ),
      goldTailTop3Accuracy: requireRate(
        evaluation.metrics?.tailTop3Accuracy,
        `Candidate ${specification.label} gold tail top-3`
      ),
      latencyP99Ms,
      compiledBytes: descriptor.totalCompiledBytes
    }
  };
}

function validateCandidateManifest(manifest, label) {
  requireRecord(manifest, `Candidate ${label} manifest`);
  if (manifest.productionEligible !== false ||
      manifest.openVocabulary !== true ||
      manifest.localOnly !== true ||
      manifest.neuralTailOnly !== true) {
    fail(
      `Candidate ${label} manifest must remain an immutable, local-only, ` +
      "open-vocabulary neural-tail candidate."
    );
  }
  const trainingSources = new Set(
    (manifest.trainingSources ?? []).map(String)
  );
  if (!trainingSources.has(CANONICAL_TRAINING_SOURCE)) {
    fail(
      `Candidate ${label} does not bind canonical training source ` +
      `${CANONICAL_TRAINING_SOURCE}.`
    );
  }
  for (const mirror of BLOCKED_MIRROR_SOURCES) {
    if (trainingSources.has(mirror)) {
      fail(
        `Candidate ${label} counts blocked lineage mirror ${mirror} as training ` +
        "evidence."
      );
    }
  }
}

function validateExportReport({
  label,
  candidateRoot,
  manifest,
  manifestEvidence,
  exportReport,
  exportReportPath,
  descriptor
}) {
  if (!String(exportReport.status ?? "").startsWith("passed-") ||
      exportReport.productionEligible !== false ||
      exportReport.coremlExport?.status !== "passed" ||
      !Array.isArray(exportReport.runtimeArtifactContractIssues) ||
      exportReport.runtimeArtifactContractIssues.length !== 0) {
    fail(`Candidate ${label} export report has not passed immutable Core ML export.`);
  }
  assertRunIdentity(label, manifest, exportReport, "export report");
  assertBoundPath(
    exportReport.manifest,
    manifestEvidence.path,
    `Candidate ${label} export manifest`
  );
  if (exportReport.manifestSha256 !== manifestEvidence.sha256) {
    fail(`Candidate ${label} export report does not bind the manifest bytes.`);
  }
  if (exportReport.modelId !== manifest.selectedArtifact) {
    fail(`Candidate ${label} export report modelId differs from its manifest.`);
  }
  if (resolve(exportReportPath) !== join(candidateRoot, "export-report.json")) {
    fail(`Candidate ${label} export report must remain inside its candidate root.`);
  }
  const identity = exportReport.artifactIdentity;
  if (identity !== undefined) {
    if (identity?.artifactSetSha256 !== descriptor.artifactSetSha256 ||
        identity?.manifestSha256 !== manifestEvidence.sha256) {
      fail(`Candidate ${label} export artifact identity is stale.`);
    }
  }
}

function validateEvaluationReport({
  label,
  manifest,
  manifestEvidence,
  exportEvidence,
  evaluation,
  descriptor
}) {
  if (evaluation.status !== "passed-production-phase5-evaluation" ||
      evaluation.production !== true ||
      evaluation.productionEligible !== true ||
      evaluation.predictionValidation?.exactCoverage !== true ||
      evaluation.predictionValidation?.metricsReportable !== true ||
      !Array.isArray(evaluation.failures) ||
      evaluation.failures.length !== 0) {
    fail(`Candidate ${label} has not passed the production gold evaluation.`);
  }
  assertRunIdentity(label, manifest, evaluation, "gold evaluation");
  if (evaluation.candidateManifestSha256 !== manifestEvidence.sha256 ||
      evaluation.exportReportSha256 !== exportEvidence.sha256) {
    fail(`Candidate ${label} gold evaluation is not bound to this exact export.`);
  }
  if (evaluation.artifactIdentity?.manifestSha256 !== manifestEvidence.sha256 ||
      evaluation.artifactIdentity?.vocabSha256 !== descriptor.vocabSha256) {
    fail(`Candidate ${label} gold evaluation has a stale artifact identity.`);
  }
  for (const field of [
    "datasetManifestSha256",
    "datasetContentSha256",
    "goldManifestSha256",
    "goldCorpusSha256"
  ]) {
    requireSha256(
      evaluation[field],
      `Candidate ${label} evaluation ${field}`
    );
  }
  return {
    datasetManifestSha256: evaluation.datasetManifestSha256,
    datasetContentSha256: evaluation.datasetContentSha256,
    goldManifestSha256: evaluation.goldManifestSha256,
    goldCorpusSha256: evaluation.goldCorpusSha256
  };
}

function validateBenchmarkReport({
  label,
  manifest,
  manifestEvidence,
  benchmark,
  descriptor
}) {
  if (benchmark.status !== "passed-candidate-promotion-evidence" ||
      benchmark.proofMode !== "candidate-promotion" ||
      benchmark.singleForwardBenchmarkIsConsumerLatency !== false ||
      !Array.isArray(benchmark.failures) ||
      benchmark.failures.length !== 0 ||
      benchmark.computePlacement?.neuralEngineClaimAllowed !== true ||
      !benchmark.computePlacement?.architectures?.includes("arm64")) {
    fail(
      `Candidate ${label} has not passed the packaged Apple Silicon Neural ` +
      "Engine benchmark."
    );
  }
  const identity = benchmark.artifactIdentity;
  if (identity?.trainingRunId !== manifest.trainingRunId ||
      identity?.exportRunId !== manifest.exportRunId ||
      identity?.manifestSha256 !== manifestEvidence.sha256 ||
      identity?.vocabSha256 !== descriptor.vocabSha256 ||
      identity?.artifactSetSha256 !== descriptor.artifactSetSha256) {
    fail(`Candidate ${label} packaged benchmark identity is stale.`);
  }
  const p99Ms = Number(benchmark.performance?.p99Ms);
  if (!Number.isFinite(p99Ms) || p99Ms < 0 || p99Ms >= 50) {
    fail(`Candidate ${label} packaged p99 latency must be below 50 ms.`);
  }
  return p99Ms;
}

function validateComparisonReport({
  label,
  manifest,
  manifestEvidence,
  comparison,
  descriptor
}) {
  if (comparison.schemaVersion !== 1 ||
      comparison.status !== "passed-official-benchmark-evaluation" ||
      comparison.suite !== "neural-official-benchmark-evaluation" ||
      comparison.productionEligible !== true ||
      comparison.qualityGate?.passed !== true ||
      !Array.isArray(comparison.failures) ||
      comparison.failures.length !== 0) {
    fail(
      `Candidate ${label} has not passed the locked official benchmark quality gate.`
    );
  }
  assertRunIdentity(label, manifest, comparison, "official benchmark");
  if (comparison.candidateManifestSha256 !== manifestEvidence.sha256 ||
      comparison.artifactIdentity?.manifestSha256 !== manifestEvidence.sha256 ||
      comparison.artifactIdentity?.vocabSha256 !== descriptor.vocabSha256 ||
      comparison.artifactIdentity?.artifactSetSha256 !==
        descriptor.artifactSetSha256) {
    fail(`Candidate ${label} official benchmark identity is stale.`);
  }
  requireSha256(
    comparison.benchmarkManifestSha256,
    `Candidate ${label} official benchmark manifest SHA-256`
  );
  requireSha256(
    comparison.benchmarkCorpusSha256,
    `Candidate ${label} official benchmark corpus SHA-256`
  );
  requireSha256(
    comparison.predictionsSha256,
    `Candidate ${label} official predictions SHA-256`
  );

  const overall = validateMetricBucket(
    comparison.metrics?.overall,
    `Candidate ${label} official overall metrics`
  );
  const native = validateMetricBucket(
    comparison.metrics?.byBucket?.["native-frequent"],
    `Candidate ${label} official native metrics`
  );
  const indianNames = validateMetricBucket(
    comparison.metrics?.byBucket?.["indian-name"],
    `Candidate ${label} official Indian-name metrics`
  );
  const foreignNames = validateMetricBucket(
    comparison.metrics?.byBucket?.["foreign-name"],
    `Candidate ${label} official foreign-name metrics`
  );
  if (overall.rows !== native.rows + indianNames.rows + foreignNames.rows ||
      comparison.predictionRows !== overall.rows ||
      comparison.distinctInputCount !== overall.rows) {
    fail(`Candidate ${label} official benchmark coverage is incomplete.`);
  }
  const nameRows = indianNames.rows + foreignNames.rows;
  const namesTop1Accuracy = round(
    (indianNames.top1Hits + foreignNames.top1Hits) / nameRows
  );
  return { overall, native, namesTop1Accuracy };
}

function validateMetricBucket(value, label) {
  requireRecord(value, label);
  requireExactKeys(value, [
    "rows",
    "top1Accuracy",
    "top1Hits",
    "top3Accuracy",
    "top3Hits"
  ], label);
  if (!Number.isSafeInteger(value.rows) || value.rows < 1 ||
      !Number.isSafeInteger(value.top1Hits) ||
      !Number.isSafeInteger(value.top3Hits) ||
      value.top1Hits < 0 ||
      value.top3Hits < value.top1Hits ||
      value.top3Hits > value.rows ||
      requireRate(value.top1Accuracy, `${label}.top1Accuracy`) !==
        round(value.top1Hits / value.rows) ||
      requireRate(value.top3Accuracy, `${label}.top3Accuracy`) !==
        round(value.top3Hits / value.rows)) {
    fail(`${label} counts and rates are inconsistent.`);
  }
  return value;
}

function runSourceLineageCompatibilityMode() {
  const failures = [];
  const warnings = [];
  const manifestPath = resolve(
    ROOT,
    singleValue(args, "manifest") ??
      "models/macos/LekhNeuralTransliterator.manifest.json"
  );
  const modelPath = resolve(
    ROOT,
    singleValue(args, "model") ??
      "models/macos/LekhNeuralTransliterator.mlmodelc"
  );
  const sources = sourcePolicyRecords();
  let manifest = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = readJsonEvidence(manifestPath, "Neural manifest").value;
      const trainingSources = new Set(
        (manifest.trainingSources ?? []).map(String)
      );
      if (!trainingSources.has(CANONICAL_TRAINING_SOURCE)) {
        failures.push(
          `Model manifest must include canonical training source ` +
          `${CANONICAL_TRAINING_SOURCE}.`
        );
      }
      for (const mirror of BLOCKED_MIRROR_SOURCES) {
        if (trainingSources.has(mirror)) {
          failures.push(
            `Model manifest must not count blocked lineage mirror ${mirror} ` +
            "as training evidence."
          );
        }
      }
    } catch (error) {
      failures.push(errorMessage(error));
    }
  } else {
    warnings.push(
      "No candidate manifest is present; production selection remains unavailable."
    );
  }
  if (!existsSync(modelPath)) {
    warnings.push(
      "No compiled candidate was supplied in source-policy compatibility mode."
    );
  }
  writeReport({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: "node scripts/check-neural-model-selection.mjs",
    suite: "neural-model-selection-source-policy",
    durationMs: Math.round(performance.now() - startedAt),
    status: failures.length === 0
      ? "passed-source-lineage-policy"
      : "failed-source-lineage-policy",
    production: false,
    mode: "source-lineage-compatibility",
    sources,
    sourceLineagePolicy: {
      canonicalTrainingSource: CANONICAL_TRAINING_SOURCE,
      blockedMirrorSources: [...BLOCKED_MIRROR_SOURCES]
    },
    model: portable(modelPath),
    manifest: portable(manifestPath),
    modelExists: existsSync(modelPath),
    manifestExists: existsSync(manifestPath),
    candidateManifest: manifest,
    failures,
    warnings
  }, failures.length === 0 ? 0 : 1);
}

function sourcePolicyRecords() {
  return [
    {
      id: CANONICAL_TRAINING_SOURCE,
      role: "primary-training-pairs",
      decision: "selected-canonical-source-after-local-import-and-license-validation",
      rows: null,
      countedTrainingRows: null,
      canonicalTrainingSource: CANONICAL_TRAINING_SOURCE,
      independentEvidence: true,
      rawDataCommitted: false
    },
    ...BLOCKED_MIRROR_SOURCES.map((id) => ({
      id,
      role: "provenance-only-lineage-mirror",
      decision: "blocked-lineage-duplicate",
      rows: 0,
      countedTrainingRows: 0,
      canonicalTrainingSource: CANONICAL_TRAINING_SOURCE,
      independentEvidence: false,
      rawDataCommitted: false
    }))
  ];
}

function readJsonEvidence(path, label) {
  const file = inspectContainedRegularFile(
    ROOT,
    containedPath(path, label),
    {
      label,
      includeContents: true,
      maxBytes: 8 * 1024 * 1024
    }
  );
  return {
    file,
    value: parseEvidenceJson(file, label)
  };
}

function parseEvidenceJson(evidence, label) {
  try {
    return JSON.parse(evidence.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function inspectBoundFile(path, sha256, label) {
  requireSha256(sha256, `${label} declared SHA-256`);
  const evidence = inspectContainedRegularFile(
    ROOT,
    containedPath(path, label),
    {
      label,
      includeContents: true,
      maxBytes: 64 * 1024 * 1024
    }
  );
  if (evidence.sha256 !== sha256) {
    fail(`${label} bytes do not match the declared SHA-256.`);
  }
  return evidence;
}

function assertRunIdentity(label, manifest, report, reportLabel) {
  if (report.trainingRunId !== manifest.trainingRunId ||
      report.exportRunId !== manifest.exportRunId) {
    fail(
      `Candidate ${label} ${reportLabel} does not bind its training/export runs.`
    );
  }
}

function assertBoundPath(declared, expected, label) {
  const observed = containedPath(declared, label);
  if (observed !== resolve(expected)) {
    fail(`${label} path does not match the verified file.`);
  }
}

function evidenceRecord(evidence) {
  return {
    path: portable(evidence.path),
    sha256: evidence.sha256
  };
}

function containedPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} path must be a non-empty string.`);
  }
  const path = canonicalPath(
    isAbsolute(value) ? resolve(value) : resolve(ROOT, value)
  );
  const child = relative(ROOT, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} path escapes the repository.`);
  }
  return path;
}

function canonicalPath(value) {
  const absolute = resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  const suffix = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function assertWithin(parent, candidate, label) {
  const child = relative(resolve(parent), resolve(candidate));
  if (child === "" || child === ".." ||
      child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail(`${label} must remain inside its immutable candidate root.`);
  }
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const allowedValues = new Set([
    "candidate-spec",
    "manifest",
    "model",
    "report"
  ]);
  const allowedFlags = new Set(["production"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      fail(`Unexpected positional argument: ${argument}.`);
    }
    const name = argument.slice(2);
    if (allowedFlags.has(name)) {
      if (flags.has(name)) fail(`Duplicate --${name} flag.`);
      flags.add(name);
      continue;
    }
    if (!allowedValues.has(name)) {
      fail(`Unknown model-selection argument --${name}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${name}.`);
    }
    const entries = values.get(name) ?? [];
    if (name !== "candidate-spec" && entries.length > 0) {
      fail(`Duplicate --${name} argument.`);
    }
    entries.push(value);
    values.set(name, entries);
    index += 1;
  }
  return { flags, values };
}

function singleValue(parsed, name) {
  const values = parsed.values.get(name);
  return values?.[0];
}

function requireExactKeys(value, expected, label) {
  requireRecord(value, label);
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireRunId(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    fail(`${label} must be a 32-character lowercase hexadecimal run ID.`);
  }
  return value;
}

function requireRate(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite rate from 0 through 1.`);
  }
  return value;
}

function portable(path) {
  return relative(ROOT, resolve(path)).split(sep).join("/");
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function writeReport(report, exitCode) {
  const child = relative(ROOT, reportPath);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    process.stderr.write("Model-selection report path escapes the repository.\n");
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    report: portable(reportPath),
    winner: report.winner?.candidateId ?? null,
    failures: report.failures ?? [],
    warnings: report.warnings ?? []
  }, null, 2)}\n`);
  process.exitCode = exitCode;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new NeuralModelSelectionError(message);
}
