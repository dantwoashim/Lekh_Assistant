#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  evaluateNeuralRareScalarEvidence
} from "./lib/neural-rare-scalar-evaluation.mjs";
import {
  validateNeuralRareScalarContract
} from "./lib/neural-rare-scalar-contract.mjs";

const MODEL_ID = "lekh-open-vocab-ctc-transformer-v2";
const RUNTIME_MODEL_CONTRACT = "single-transformer-ctc-v1";
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_JSONL_BYTES = 256 * 1024 * 1024;
const CANONICAL_PATHS = Object.freeze({
  contract: "data/neural/eval/ctc-rare-output-scalar-probes-v1.json",
  ctcAudit: "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
  datasetManifest: "data/generated/neural-open-vocab/manifest.json",
  goldManifest: "data/neural/gold/manifest.v3.json",
  officialManifest:
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json"
});

export function runNeuralRareScalarEvaluation(options = {}) {
  const root = canonicalDirectory(options.root ?? process.cwd(), "Repository root");
  const startedAt = performance.now();
  const exportReportPath = safePath(
    root,
    options.exportReport ??
      "data/generated/neural-open-vocab-model/" +
      "lekh-open-vocab-ctc-transformer-v2/export-report.json",
    "Candidate export report"
  );
  const candidateRoot = dirname(exportReportPath);
  const probePredictionsPath = safeCandidatePath(
    root,
    candidateRoot,
    options.probePredictions ??
      join(candidateRoot, "rare-scalar-predictions.jsonl"),
    "Rare-scalar predictions"
  );
  const generationReportPath = safeCandidatePath(
    root,
    candidateRoot,
    options.generationReport ??
      join(candidateRoot, "rare-scalar-prediction-report.json"),
    "Rare-scalar generation report"
  );
  const reportPath = safeOutputPath(
    root,
    options.report ??
      join(candidateRoot, "rare-scalar-evaluation.json")
  );
  const failures = [];
  const warnings = [];
  let details = {};

  try {
    details = evaluateEvidence({
      root,
      candidateRoot,
      exportReportPath,
      probePredictionsPath,
      generationReportPath,
      failures,
      warnings
    });
  } catch (error) {
    failures.push(errorMessage(error));
  }
  const uniqueFailures = [...new Set(failures)];
  const uniqueWarnings = [...new Set(warnings)];
  const passed = uniqueFailures.length === 0 &&
    details.evaluation?.productionGatePassed === true;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: "node scripts/evaluate-neural-rare-scalar-evidence.mjs",
    suite: "neural-rare-scalar-evaluation",
    durationMs: Math.round(performance.now() - startedAt),
    status: passed
      ? "passed-neural-rare-scalar-production-gate"
      : "failed-neural-rare-scalar-production-gate",
    productionEligible: passed,
    ...details,
    failures: uniqueFailures,
    warnings: uniqueWarnings
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  });
  return Object.freeze({
    report,
    reportPath,
    exitCode: passed ? 0 : 1
  });
}

function evaluateEvidence({
  root,
  candidateRoot,
  exportReportPath,
  probePredictionsPath,
  generationReportPath,
  failures,
  warnings
}) {
  const contractEvidence = readJsonEvidence(
    root,
    safePath(root, CANONICAL_PATHS.contract, "Rare-scalar contract"),
    "Rare-scalar contract"
  );
  const ctcAuditEvidence = readJsonEvidence(
    root,
    safePath(root, CANONICAL_PATHS.ctcAudit, "CTC alignment audit"),
    "CTC alignment audit"
  );
  const datasetEvidence = readJsonEvidence(
    root,
    safePath(root, CANONICAL_PATHS.datasetManifest, "Dataset manifest"),
    "Dataset manifest"
  );
  const contractValidation = validateNeuralRareScalarContract({
    contract: contractEvidence.value,
    ctcAudit: ctcAuditEvidence.value,
    ctcAuditPath: portable(root, ctcAuditEvidence.file.path),
    ctcAuditSha256: ctcAuditEvidence.file.sha256,
    datasetManifest: datasetEvidence.value,
    datasetManifestPath: portable(root, datasetEvidence.file.path),
    datasetManifestSha256: datasetEvidence.file.sha256
  });
  if (!contractValidation.ok) {
    failures.push(...contractValidation.failures);
  }

  const exportEvidence = readJsonEvidence(
    root,
    exportReportPath,
    "Candidate export report"
  );
  const exportReport = exportEvidence.value;
  const candidateEvidence = validateCandidateExport({
    root,
    candidateRoot,
    exportReport,
    exportEvidence: exportEvidence.file,
    contract: contractEvidence.value,
    datasetEvidence: datasetEvidence.file
  });

  const generationEvidence = readJsonEvidence(
    root,
    generationReportPath,
    "Rare-scalar generation report"
  );
  const probePredictionEvidence = readTextEvidence(
    root,
    probePredictionsPath,
    "Rare-scalar predictions",
    MAX_JSONL_BYTES
  );
  validateGenerationBinding({
    root,
    candidateRoot,
    exportReport,
    exportEvidence: exportEvidence.file,
    contractEvidence: contractEvidence.file,
    contract: contractEvidence.value,
    candidateEvidence,
    generationReport: generationEvidence.value,
    predictionEvidence: probePredictionEvidence.file
  });
  const probePredictions = parseJsonLines(
    probePredictionEvidence.contents,
    "Rare-scalar predictions"
  );
  if (probePredictions.length !== generationEvidence.value.predictions.rows) {
    fail("Rare-scalar prediction row count differs from its generation report.");
  }

  const goldManifestEvidence = readJsonEvidence(
    root,
    safePath(root, CANONICAL_PATHS.goldManifest, "Gold manifest"),
    "Gold manifest"
  );
  const goldRows = loadSuiteRows({
    root,
    manifest: goldManifestEvidence.value,
    label: "gold"
  });
  const goldPredictionsPath = safeCandidatePath(
    root,
    candidateRoot,
    exportReport.predictions,
    "Gold predictions"
  );
  const goldPredictionEvidence = readTextEvidence(
    root,
    goldPredictionsPath,
    "Gold predictions",
    MAX_JSONL_BYTES
  );
  validateGoldBinding({
    root,
    exportReport,
    manifestEvidence: goldManifestEvidence.file,
    manifest: goldManifestEvidence.value,
    predictionEvidence: goldPredictionEvidence.file,
    rows: goldRows
  });
  const goldPredictions = parseJsonLines(
    goldPredictionEvidence.contents,
    "Gold predictions"
  );

  const officialManifestEvidence = readJsonEvidence(
    root,
    safePath(
      root,
      CANONICAL_PATHS.officialManifest,
      "Official benchmark manifest"
    ),
    "Official benchmark manifest"
  );
  const officialRows = loadSuiteRows({
    root,
    manifest: officialManifestEvidence.value,
    label: "official benchmark"
  });
  const officialPredictionsPath = safeCandidatePath(
    root,
    candidateRoot,
    exportReport.comparisonBenchmark?.predictions,
    "Official benchmark predictions"
  );
  const officialPredictionEvidence = readTextEvidence(
    root,
    officialPredictionsPath,
    "Official benchmark predictions",
    MAX_JSONL_BYTES
  );
  validateOfficialBinding({
    root,
    exportReport,
    manifestEvidence: officialManifestEvidence.file,
    manifest: officialManifestEvidence.value,
    predictionEvidence: officialPredictionEvidence.file,
    rows: officialRows
  });
  const officialPredictions = parseJsonLines(
    officialPredictionEvidence.contents,
    "Official benchmark predictions"
  );

  const evaluation = evaluateNeuralRareScalarEvidence({
    contract: contractEvidence.value,
    probePredictions,
    lockedEvaluations: [
      {
        label: "gold",
        rows: goldRows,
        predictions: goldPredictions
      },
      {
        label: "official-benchmark",
        rows: officialRows,
        predictions: officialPredictions
      }
    ]
  });
  failures.push(...evaluation.failures);
  warnings.push(...evaluation.warnings);

  return {
    modelId: MODEL_ID,
    trainingRunId: exportReport.trainingRunId,
    exportRunId: exportReport.exportRunId,
    candidateRoot: portable(root, candidateRoot),
    exportReport: evidenceRecord(root, exportEvidence.file),
    contract: evidenceRecord(root, contractEvidence.file),
    ctcAudit: evidenceRecord(root, ctcAuditEvidence.file),
    datasetManifest: {
      ...evidenceRecord(root, datasetEvidence.file),
      contentSha256: datasetEvidence.value.datasetContentSha256
    },
    generationReport: evidenceRecord(root, generationEvidence.file),
    probePredictions: {
      ...evidenceRecord(root, probePredictionEvidence.file),
      rows: probePredictions.length
    },
    gold: {
      manifest: evidenceRecord(root, goldManifestEvidence.file),
      corpusSha256: goldManifestEvidence.value.corpusSha256,
      predictions: evidenceRecord(root, goldPredictionEvidence.file),
      rows: goldRows.length
    },
    officialBenchmark: {
      manifest: evidenceRecord(root, officialManifestEvidence.file),
      corpusSha256: officialManifestEvidence.value.corpusSha256,
      predictions: evidenceRecord(root, officialPredictionEvidence.file),
      rows: officialRows.length
    },
    artifactIdentity: {
      manifestSha256: candidateEvidence.manifest.file.sha256,
      vocabSha256: candidateEvidence.descriptor.vocabSha256,
      artifactSetSha256: candidateEvidence.descriptor.artifactSetSha256,
      compiledModelSha256:
        candidateEvidence.descriptor.artifacts[0].compiledSha256,
      mlpackageSha256: candidateEvidence.mlpackage.sha256,
      checkpointSha256: candidateEvidence.checkpoint.sha256
    },
    evaluation
  };
}

function validateCandidateExport({
  root,
  candidateRoot,
  exportReport,
  exportEvidence,
  contract,
  datasetEvidence
}) {
  if (
    exportReport.status !==
      "passed-open-vocab-ctc-transformer-candidate" ||
    exportReport.modelId !== MODEL_ID ||
    exportReport.runtimeModelContract !== RUNTIME_MODEL_CONTRACT ||
    exportReport.productionEligible !== false ||
    exportReport.coremlExport?.status !== "passed" ||
    !Array.isArray(exportReport.runtimeArtifactContractIssues) ||
    exportReport.runtimeArtifactContractIssues.length !== 0
  ) {
    fail("Rare-scalar evaluation requires a passed immutable CTC candidate.");
  }
  if (
    !RUN_ID_PATTERN.test(String(exportReport.trainingRunId ?? "")) ||
    !RUN_ID_PATTERN.test(String(exportReport.exportRunId ?? "")) ||
    exportReport.trainingRunId === exportReport.exportRunId
  ) {
    fail("Candidate training/export run identities are invalid.");
  }
  if (dirname(exportEvidence.path) !== candidateRoot) {
    fail("Candidate export report is outside its immutable candidate root.");
  }
  const manifestPath = safeCandidatePath(
    root,
    candidateRoot,
    exportReport.manifest,
    "Candidate manifest"
  );
  const manifestEvidence = readJsonEvidence(
    root,
    manifestPath,
    "Candidate manifest"
  );
  if (
    exportReport.manifestSha256 !== manifestEvidence.file.sha256 ||
    manifestEvidence.value.selectedArtifact !== MODEL_ID ||
    manifestEvidence.value.runtimeModelContract !== RUNTIME_MODEL_CONTRACT ||
    manifestEvidence.value.trainingRunId !== exportReport.trainingRunId ||
    manifestEvidence.value.exportRunId !== exportReport.exportRunId ||
    manifestEvidence.value.productionEligible !== false
  ) {
    fail("Candidate export report does not bind the exact CTC manifest.");
  }
  const vocabularyPath = safeCandidatePath(
    root,
    candidateRoot,
    join(candidateRoot, "LekhNeuralTransliterator.vocab.json"),
    "Candidate vocabulary"
  );
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: root,
    manifest: manifestEvidence.value,
    manifestPath,
    vocabPath: vocabularyPath
  });
  if (
    descriptor.runtimeModelContract !== RUNTIME_MODEL_CONTRACT ||
    descriptor.artifactLayout !== "single-model" ||
    descriptor.predictionsBackend !== "coreml-compiled-transformer-ctc" ||
    descriptor.artifacts.length !== 1 ||
    descriptor.artifacts[0].compiledSha256 !==
      exportReport.compiledModelSha256
  ) {
    fail("Candidate runtime artifact descriptor differs from its export report.");
  }
  const checkpointPath = safeCandidatePath(
    root,
    candidateRoot,
    exportReport.checkpoint,
    "Candidate checkpoint"
  );
  const checkpoint = inspectContainedRegularFile(root, checkpointPath, {
    label: "Candidate checkpoint",
    maxBytes: 512 * 1024 * 1024
  });
  if (checkpoint.sha256 !== exportReport.checkpointSha256) {
    fail("Candidate checkpoint bytes differ from the export report.");
  }
  const mlpackagePath = safeCandidatePath(
    root,
    candidateRoot,
    exportReport.mlpackage,
    "Candidate Core ML package"
  );
  const mlpackage = inspectContainedDirectoryTree(root, mlpackagePath, {
    label: "Candidate Core ML package",
    maxBytes: 32 * 1024 * 1024
  });
  if (mlpackage.sha256 !== exportReport.mlpackageSha256) {
    fail("Candidate Core ML package bytes differ from the export report.");
  }
  if (
    contract.dataset?.manifestSha256 !== datasetEvidence.sha256 ||
    exportReport.runInputSnapshot?.dataset?.manifestSha256 !==
      datasetEvidence.sha256 ||
    exportReport.runInputSnapshot?.dataset?.contentSha256 !==
      contract.dataset?.contentSha256
  ) {
    fail("Candidate export does not bind the rare-scalar training dataset.");
  }
  return {
    manifest: manifestEvidence,
    descriptor,
    checkpoint,
    mlpackage
  };
}

function validateGenerationBinding({
  root,
  candidateRoot,
  exportReport,
  exportEvidence,
  contractEvidence,
  contract,
  candidateEvidence,
  generationReport,
  predictionEvidence
}) {
  const candidate = generationReport.candidate;
  const generatedContract = generationReport.contract;
  const predictions = generationReport.predictions;
  if (
    generationReport.schemaVersion !== 1 ||
    generationReport.status !==
      "passed-neural-rare-scalar-prediction-generation" ||
    generationReport.modelId !== MODEL_ID ||
    generationReport.trainingRunId !== exportReport.trainingRunId ||
    generationReport.exportRunId !== exportReport.exportRunId ||
    generationReport.productionEligible !== false ||
    generationReport.predictionsBackend !==
      "coreml-compiled-transformer-ctc" ||
    generationReport.coremlValidation?.status !== "passed"
  ) {
    fail("Rare-scalar generation report identity is invalid.");
  }
  if (
    safeCandidatePath(
      root,
      candidateRoot,
      candidate?.exportReport,
      "Generated export-report binding"
    ) !== exportEvidence.path ||
    candidate?.exportReportSha256 !== exportEvidence.sha256 ||
    safePath(
      root,
      generatedContract?.path,
      "Generated rare-scalar contract binding"
    ) !== contractEvidence.path ||
    generatedContract?.sha256 !== contractEvidence.sha256 ||
    safeCandidatePath(
      root,
      candidateRoot,
      predictions?.path,
      "Generated prediction binding"
    ) !== predictionEvidence.path ||
    predictions?.sha256 !== predictionEvidence.sha256 ||
    !Number.isSafeInteger(predictions?.rows) ||
    predictions.rows < 1
  ) {
    fail("Rare-scalar generation report contains stale evidence bindings.");
  }
  if (
    generatedContract?.datasetManifestSha256 !==
      contract.dataset?.manifestSha256 ||
    generatedContract?.datasetContentSha256 !==
      contract.dataset?.contentSha256 ||
    generatedContract?.ctcAuditSha256 !== contract.ctcAudit?.sha256
  ) {
    fail("Rare-scalar generation report binds a different probe contract.");
  }
  for (const [field, label] of [
    ["manifestSha256", "manifest"],
    ["checkpointSha256", "checkpoint"],
    ["vocabularySha256", "vocabulary"],
    ["mlpackageSha256", "Core ML package"],
    ["compiledModelSha256", "compiled model"]
  ]) {
    if (!SHA256_PATTERN.test(String(candidate?.[field] ?? ""))) {
      fail(`Rare-scalar generation ${label} SHA-256 is invalid.`);
    }
  }
  if (
    candidate?.compiledModelSha256 !== exportReport.compiledModelSha256 ||
    candidate?.mlpackageSha256 !== exportReport.mlpackageSha256 ||
    candidate?.checkpointSha256 !== exportReport.checkpointSha256 ||
    candidate?.manifestSha256 !== exportReport.manifestSha256
  ) {
    fail("Rare-scalar generation used artifacts other than the candidate export.");
  }
  const descriptor = candidateEvidence.descriptor;
  const compiledArtifact = descriptor.artifacts[0];
  if (
    safeCandidatePath(
      root,
      candidateRoot,
      candidate?.manifest,
      "Generated manifest binding"
    ) !== candidateEvidence.manifest.file.path ||
    safeCandidatePath(
      root,
      candidateRoot,
      candidate?.checkpoint,
      "Generated checkpoint binding"
    ) !== candidateEvidence.checkpoint.path ||
    safeCandidatePath(
      root,
      candidateRoot,
      candidate?.vocabulary,
      "Generated vocabulary binding"
    ) !== descriptor.vocabPath ||
    safeCandidatePath(
      root,
      candidateRoot,
      candidate?.compiledModel,
      "Generated compiled-model binding"
    ) !== compiledArtifact.sourcePath ||
    safeCandidatePath(
      root,
      candidateRoot,
      candidate?.mlpackage,
      "Generated Core ML package binding"
    ) !== candidateEvidence.mlpackage.path ||
    candidate?.vocabularySha256 !== descriptor.vocabSha256 ||
    candidate?.compiledModelSha256 !== compiledArtifact.compiledSha256 ||
    candidate?.mlpackageSha256 !== candidateEvidence.mlpackage.sha256 ||
    candidate?.checkpointSha256 !== candidateEvidence.checkpoint.sha256
  ) {
    fail("Rare-scalar generation report artifact paths or bytes are stale.");
  }
  const generatedValidation = generationReport.coremlValidation;
  const exportedValidation = exportReport.coremlExport?.artifactValidation;
  if (
    generatedValidation.runtimeModelContract !== RUNTIME_MODEL_CONTRACT ||
    generatedValidation.compiledModelSha256 !==
      compiledArtifact.compiledSha256 ||
    generatedValidation.mlpackageSha256 !== candidateEvidence.mlpackage.sha256 ||
    JSON.stringify(generatedValidation.tensorContract) !==
      JSON.stringify(exportReport.coremlExport?.tensorContract) ||
    generatedValidation.knownAnswerInputSha256 !==
      exportedValidation?.knownAnswerInputSha256 ||
    generatedValidation.relativeTolerance !==
      exportedValidation?.relativeTolerance ||
    generatedValidation.absoluteTolerance !==
      exportedValidation?.absoluteTolerance
  ) {
    fail("Rare-scalar generation did not revalidate the exact Core ML artifact.");
  }
}

function validateGoldBinding({
  root,
  exportReport,
  manifestEvidence,
  manifest,
  predictionEvidence,
  rows
}) {
  if (
    safePath(root, exportReport.goldManifest, "Export gold manifest") !==
      manifestEvidence.path ||
    exportReport.goldManifestSha256 !== manifestEvidence.sha256 ||
    exportReport.goldCorpusSha256 !== manifest.corpusSha256 ||
    exportReport.predictionsSha256 !== predictionEvidence.sha256 ||
    !Number.isSafeInteger(exportReport.goldRows) ||
    exportReport.goldRows !== rows.length
  ) {
    fail("Candidate export does not bind the exact locked gold evidence.");
  }
}

function validateOfficialBinding({
  root,
  exportReport,
  manifestEvidence,
  manifest,
  predictionEvidence,
  rows
}) {
  const binding = exportReport.comparisonBenchmark;
  if (
    !binding ||
    safePath(root, binding.manifest, "Export official manifest") !==
      manifestEvidence.path ||
    binding.manifestSha256 !== manifestEvidence.sha256 ||
    binding.corpusSha256 !== manifest.corpusSha256 ||
    binding.predictionsSha256 !== predictionEvidence.sha256 ||
    binding.rows !== rows.length ||
    binding.trainingIsolation?.overlappingInputCount !== 0 ||
    binding.predictionsBackend !== "coreml-compiled-transformer-ctc"
  ) {
    fail("Candidate export does not bind the exact official benchmark evidence.");
  }
}

function loadSuiteRows({ root, manifest, label }) {
  if (
    !Array.isArray(manifest?.suites) ||
    manifest.suites.length === 0 ||
    !SHA256_PATTERN.test(String(manifest.corpusSha256 ?? ""))
  ) {
    fail(`${label} manifest suite inventory is invalid.`);
  }
  if (suiteCorpusSha256(manifest.suites) !== manifest.corpusSha256) {
    fail(`${label} manifest corpus SHA-256 is stale.`);
  }
  const rows = [];
  const seenIds = new Set();
  for (const suite of manifest.suites) {
    if (
      typeof suite?.id !== "string" ||
      !suite.id ||
      typeof suite.path !== "string" ||
      !SHA256_PATTERN.test(String(suite.sha256 ?? "")) ||
      !Number.isSafeInteger(suite.rows) ||
      suite.rows < 1
    ) {
      fail(`${label} manifest contains an invalid suite.`);
    }
    const suiteEvidence = readTextEvidence(
      root,
      safePath(root, suite.path, `${label} suite ${suite.id}`),
      `${label} suite ${suite.id}`,
      MAX_JSONL_BYTES
    );
    if (suiteEvidence.file.sha256 !== suite.sha256) {
      fail(`${label} suite ${suite.id} SHA-256 is stale.`);
    }
    const suiteRows = parseJsonLines(
      suiteEvidence.contents,
      `${label} suite ${suite.id}`
    );
    if (suiteRows.length !== suite.rows) {
      fail(`${label} suite ${suite.id} row count is stale.`);
    }
    for (const row of suiteRows) {
      if (
        typeof row?.id !== "string" ||
        !row.id ||
        seenIds.has(row.id) ||
        typeof row.input !== "string" ||
        !row.input
      ) {
        fail(`${label} rows contain an invalid or duplicate identity.`);
      }
      seenIds.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}

function readJsonEvidence(root, path, label) {
  const evidence = readTextEvidence(root, path, label, MAX_JSON_BYTES);
  let value;
  try {
    value = JSON.parse(evidence.contents);
  } catch (error) {
    fail(`${label} is not strict JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) fail(`${label} must be a JSON object.`);
  return { file: evidence.file, value };
}

function readTextEvidence(root, path, label, maximumBytes) {
  const canonical = canonicalRegularFile(path, label);
  const metadata = lstatSync(canonical);
  if (
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    fail(`${label} size is outside its accepted evidence bound.`);
  }
  const contents = readFileSync(canonical, "utf8");
  if (Buffer.byteLength(contents, "utf8") !== metadata.size) {
    fail(`${label} is not strict UTF-8 evidence.`);
  }
  return {
    file: {
      path: canonical,
      bytes: metadata.size,
      sha256: sha256Text(contents)
    },
    contents
  };
}

function parseJsonLines(contents, label) {
  if (!contents.endsWith("\n")) {
    fail(`${label} must end with a newline.`);
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) {
    fail(`${label} contains empty or missing rows.`);
  }
  return lines.map((line, index) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail(`${label} row ${index + 1} is invalid JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(value)) {
      fail(`${label} row ${index + 1} must be an object.`);
    }
    return value;
  });
}

function safeCandidatePath(root, candidateRoot, value, label) {
  const path = safePath(root, value, label);
  const child = relative(candidateRoot, path);
  if (
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    fail(`${label} escapes the immutable candidate directory.`);
  }
  return path;
}

function safePath(root, value, label) {
  if (typeof value !== "string" || !value) {
    fail(`${label} path must be a non-empty string.`);
  }
  const path = resolve(root, value);
  const child = relative(root, path);
  if (
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    fail(`${label} path escapes the repository.`);
  }
  return path;
}

function safeOutputPath(root, value) {
  const path = safePath(root, value, "Rare-scalar evaluation report");
  const parent = dirname(path);
  const child = relative(root, parent);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail("Rare-scalar evaluation report parent escapes the repository.");
  }
  return path;
}

function canonicalDirectory(value, label) {
  const path = realpathSync(resolve(value));
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory.`);
  }
  return path;
}

function canonicalRegularFile(value, label) {
  const path = realpathSync(resolve(value));
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a real regular file.`);
  }
  return path;
}

function evidenceRecord(root, evidence) {
  return {
    path: portable(root, evidence.path),
    bytes: evidence.bytes,
    sha256: evidence.sha256
  };
}

function portable(root, path) {
  return relative(root, resolve(path)).split(sep).join("/");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function suiteCorpusSha256(suites) {
  const digest = createHash("sha256");
  for (const suite of suites) {
    for (const [value, terminator] of [
      [suite?.id, "\0"],
      [suite?.path, "\0"],
      [suite?.sha256, "\0"],
      [suite?.rows, "\n"]
    ]) {
      digest.update(String(value));
      digest.update(terminator);
    }
  }
  return digest.digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (![
      "--export-report",
      "--probe-predictions",
      "--generation-report",
      "--report"
    ].includes(argument)) {
      fail(`Unknown rare-scalar evaluation argument: ${argument}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${argument}.`);
    }
    const name = argument.slice(2);
    if (values.has(name)) fail(`Duplicate ${argument} argument.`);
    values.set(name, value);
    index += 1;
  }
  return {
    exportReport: values.get("export-report"),
    probePredictions: values.get("probe-predictions"),
    generationReport: values.get("generation-report"),
    report: values.get("report")
  };
}

function isMainModule() {
  return Boolean(process.argv[1]) &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = runNeuralRareScalarEvaluation({
      root: process.cwd(),
      ...parseArgs(process.argv.slice(2))
    });
    process.stdout.write(`${JSON.stringify({
      status: result.report.status,
      report: portable(process.cwd(), result.reportPath),
      productionEligible: result.report.productionEligible,
      probeRows: result.report.evaluation?.probeRows ?? null,
      lockedEvaluationRows:
        result.report.evaluation?.lockedEvaluationRows ?? null,
      failures: result.report.failures,
      warnings: result.report.warnings
    }, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
