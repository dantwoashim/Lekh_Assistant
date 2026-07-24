#!/usr/bin/env node

import { createHash } from "node:crypto";
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
  evaluateOfficialBenchmarkQuality,
  scoreOfficialBenchmark
} from "./lib/neural-official-benchmark.mjs";

const ROOT = realpathSync(process.cwd());
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const predictionsPath = requiredPath(args, "predictions");
const exportReportPath = safePath(
  args.get("export-report") ?? join(dirname(predictionsPath), "export-report.json"),
  "Candidate export report"
);
const benchmarkManifestPath = safePath(
  args.get("benchmark-manifest") ??
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
  "Official benchmark manifest"
);
const referenceManifestPath = safePath(
  args.get("reference-manifest") ??
    "data/neural/benchmarks/indicxlit-v1/manifest.json",
  "Reference benchmark manifest"
);
const reportPath = safeOutputPath(
  args.get("report") ??
    "reports/neural-official-benchmark-evaluation.json"
);
const failures = [];
const warnings = [];

let details;
try {
  details = evaluate();
} catch (error) {
  failures.push(errorMessage(error));
  details = {};
}
const qualityPassed = details.qualityGate?.passed === true;
if (details.qualityGate &&
    !qualityPassed) {
  for (const check of details.qualityGate.checks.filter((value) =>
    value.passed !== true
  )) {
    failures.push(
      `${check.metric} must be >=${check.minimum} (reference ` +
      `${check.reference}, candidate ${check.candidate}).`
    );
  }
}
const passed = failures.length === 0 && qualityPassed;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  command: "node scripts/evaluate-neural-official-benchmark.mjs",
  suite: "neural-official-benchmark-evaluation",
  durationMs: Math.round(performance.now() - startedAt),
  status: passed
    ? "passed-official-benchmark-evaluation"
    : "failed-official-benchmark-evaluation",
  productionEligible: passed,
  ...details,
  failures: [...new Set(failures)],
  warnings
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status: report.status,
  report: portable(reportPath),
  metrics: report.metrics ?? null,
  qualityGatePassed: report.qualityGate?.passed ?? false,
  failures: report.failures,
  warnings
}, null, 2)}\n`);
process.exitCode = passed ? 0 : 1;

function evaluate() {
  const exportEvidence = readJsonEvidence(
    exportReportPath,
    "Candidate export report"
  );
  const exportReport = exportEvidence.value;
  const manifestPath = safePath(
    exportReport.manifest,
    "Candidate manifest"
  );
  const manifestEvidence = readJsonEvidence(
    manifestPath,
    "Candidate manifest"
  );
  const manifest = manifestEvidence.value;
  const candidateRoot = dirname(exportReportPath);
  if (dirname(manifestPath) !== candidateRoot) {
    fail("Candidate manifest and export report must share one immutable root.");
  }
  const vocabularyPath = join(
    candidateRoot,
    "LekhNeuralTransliterator.vocab.json"
  );
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: ROOT,
    manifest,
    manifestPath,
    vocabPath: vocabularyPath
  });
  validateExportIdentity({
    exportReport,
    exportEvidence: exportEvidence.file,
    manifest,
    manifestEvidence: manifestEvidence.file,
    descriptor
  });

  const benchmarkEvidence = readJsonEvidence(
    benchmarkManifestPath,
    "Official benchmark manifest"
  );
  const benchmarkRows = loadBenchmarkRows(
    benchmarkEvidence.value,
    benchmarkEvidence.file
  );
  const predictionEvidence = readTextEvidence(
    predictionsPath,
    "Candidate official benchmark predictions",
    64 * 1024 * 1024
  );
  validateCandidateComparisonBinding({
    exportReport,
    benchmarkEvidence: benchmarkEvidence.file,
    benchmarkManifest: benchmarkEvidence.value,
    predictionEvidence,
    benchmarkRows
  });
  const predictions = parseJsonLines(
    predictionEvidence.contents,
    "Candidate official benchmark predictions"
  );
  const candidateScore = scoreOfficialBenchmark(
    benchmarkRows,
    predictions
  );
  failures.push(...candidateScore.issueCodes);

  const referenceEvidence = readJsonEvidence(
    referenceManifestPath,
    "IndicXlit reference manifest"
  );
  const reference = referenceEvidence.value;
  validateReferenceManifest({
    reference,
    benchmarkEvidence: benchmarkEvidence.file,
    benchmarkManifest: benchmarkEvidence.value,
    benchmarkRows
  });
  const referencePredictionsPath = safePath(
    reference.predictionArtifact.path,
    "IndicXlit reference predictions"
  );
  const referencePredictionEvidence = readTextEvidence(
    referencePredictionsPath,
    "IndicXlit reference predictions",
    64 * 1024 * 1024
  );
  if (referencePredictionEvidence.sha256 !==
      reference.predictionArtifact.sha256 ||
      referencePredictionEvidence.bytes !==
        reference.predictionArtifact.bytes) {
    fail("IndicXlit reference prediction bytes differ from their locked manifest.");
  }
  const referencePredictions = parseJsonLines(
    referencePredictionEvidence.contents,
    "IndicXlit reference predictions"
  );
  const referenceScore = scoreOfficialBenchmark(
    benchmarkRows,
    referencePredictions,
    { allowReferenceAnnotations: true }
  );
  if (!referenceScore.valid ||
      !referenceScore.exactCoverage ||
      referenceScore.predictionRows !== benchmarkRows.length) {
    fail(
      `Locked IndicXlit reference is invalid: ` +
      `${referenceScore.issueCodes.join(", ")}.`
    );
  }
  const qualityGate = candidateScore.valid &&
    candidateScore.exactCoverage &&
    candidateScore.metrics
    ? evaluateOfficialBenchmarkQuality(
        candidateScore.metrics,
        referenceScore.metrics
      )
    : null;

  return {
    trainingRunId: manifest.trainingRunId,
    exportRunId: manifest.exportRunId,
    candidateManifest: portable(manifestPath),
    candidateManifestSha256: manifestEvidence.file.sha256,
    exportReport: portable(exportReportPath),
    exportReportSha256: exportEvidence.file.sha256,
    artifactIdentity: {
      trainingRunId: manifest.trainingRunId,
      exportRunId: manifest.exportRunId,
      manifestSha256: manifestEvidence.file.sha256,
      vocabSha256: descriptor.vocabSha256,
      artifactSetSha256: descriptor.artifactSetSha256
    },
    benchmarkManifest: portable(benchmarkManifestPath),
    benchmarkManifestSha256: benchmarkEvidence.file.sha256,
    benchmarkCorpusSha256: benchmarkEvidence.value.corpusSha256,
    predictions: portable(predictionsPath),
    predictionsSha256: predictionEvidence.sha256,
    predictionRows: candidateScore.predictionRows,
    distinctInputCount: candidateScore.distinctInputCount,
    exactCoverage: candidateScore.exactCoverage,
    metrics: candidateScore.metrics,
    reference: {
      manifest: portable(referenceManifestPath),
      manifestSha256: referenceEvidence.file.sha256,
      predictions: portable(referencePredictionsPath),
      predictionsSha256: referencePredictionEvidence.sha256,
      runtimeFilteredInvalidCandidateCount:
        referenceScore.filteredInvalidCandidateCount,
      metrics: referenceScore.metrics
    },
    qualityGate
  };
}

function validateExportIdentity({
  exportReport,
  exportEvidence,
  manifest,
  manifestEvidence,
  descriptor
}) {
  if (!String(exportReport.status ?? "").startsWith("passed-") ||
      exportReport.productionEligible !== false ||
      exportReport.coremlExport?.status !== "passed" ||
      !Array.isArray(exportReport.runtimeArtifactContractIssues) ||
      exportReport.runtimeArtifactContractIssues.length !== 0 ||
      manifest.productionEligible !== false ||
      manifest.openVocabulary !== true) {
    fail("Official evaluation requires a passed immutable Core ML candidate export.");
  }
  const runIdPattern = /^[a-f0-9]{32}$/u;
  if (!runIdPattern.test(String(manifest.trainingRunId ?? "")) ||
      !runIdPattern.test(String(manifest.exportRunId ?? "")) ||
      manifest.trainingRunId === manifest.exportRunId ||
      exportReport.trainingRunId !== manifest.trainingRunId ||
      exportReport.exportRunId !== manifest.exportRunId) {
    fail("Candidate training/export run identities are invalid or inconsistent.");
  }
  if (resolve(ROOT, exportReport.manifest) !== manifestEvidence.path ||
      exportReport.manifestSha256 !== manifestEvidence.sha256 ||
      exportReport.modelId !== manifest.selectedArtifact) {
    fail("Candidate export report does not bind the exact runtime manifest.");
  }
  if (exportReport.artifactIdentity !== undefined &&
      (exportReport.artifactIdentity?.manifestSha256 !==
        manifestEvidence.sha256 ||
        exportReport.artifactIdentity?.vocabSha256 !==
          descriptor.vocabSha256 ||
        exportReport.artifactIdentity?.artifactSetSha256 !==
          descriptor.artifactSetSha256)) {
    fail("Candidate export report contains a stale artifact identity.");
  }
  if (!/^[a-f0-9]{64}$/u.test(exportEvidence.sha256)) {
    fail("Candidate export report evidence is not hashable.");
  }
}

function validateCandidateComparisonBinding({
  exportReport,
  benchmarkEvidence,
  benchmarkManifest,
  predictionEvidence,
  benchmarkRows
}) {
  const binding = exportReport.comparisonBenchmark;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail(
      "Candidate export report must bind comparisonBenchmark before official " +
      "metrics can be reported."
    );
  }
  if (resolve(ROOT, binding.manifest) !== benchmarkEvidence.path ||
      binding.manifestSha256 !== benchmarkEvidence.sha256 ||
      binding.corpusSha256 !== benchmarkManifest.corpusSha256 ||
      resolve(ROOT, binding.predictions) !== predictionEvidence.path ||
      binding.predictionsSha256 !== predictionEvidence.sha256 ||
      binding.rows !== benchmarkRows.length) {
    fail(
      "Candidate export report does not bind the exact official benchmark and " +
      "prediction bytes."
    );
  }
}

function validateReferenceManifest({
  reference,
  benchmarkEvidence,
  benchmarkManifest,
  benchmarkRows
}) {
  if (reference.schemaVersion !== 1 ||
      reference.status !== "measured-external-comparison" ||
      reference.trainingUse !== "forbidden-comparison-only" ||
      reference.benchmark?.manifestSha256 !== benchmarkEvidence.sha256 ||
      reference.benchmark?.corpusSha256 !== benchmarkManifest.corpusSha256 ||
      reference.benchmark?.rows !== benchmarkRows.length ||
      reference.predictionArtifact?.rows !== benchmarkRows.length) {
    fail("IndicXlit comparison manifest does not bind the active locked benchmark.");
  }
}

function loadBenchmarkRows(manifest, manifestEvidence) {
  if (manifest.schemaVersion !== 2 ||
      manifest.status !== "official-public-benchmark-locked" ||
      manifest.trainingUse !== "forbidden-evaluation-only" ||
      !Array.isArray(manifest.suites) ||
      manifest.suites.length !== 3 ||
      !/^[a-f0-9]{64}$/u.test(String(manifest.corpusSha256 ?? ""))) {
    fail("Official benchmark manifest contract is invalid.");
  }
  if (benchmarkCorpusSha256(manifest.suites) !== manifest.corpusSha256) {
    fail("Official benchmark corpusSha256 does not match its suite inventory.");
  }
  const rows = [];
  const suiteIds = new Set();
  const buckets = new Set();
  for (const suite of manifest.suites) {
    if (!suite || typeof suite !== "object" ||
        typeof suite.id !== "string" ||
        suiteIds.has(suite.id) ||
        !["native-frequent", "indian-name", "foreign-name"].includes(
          suite.benchmarkBucket
        ) ||
        buckets.has(suite.benchmarkBucket) ||
        !Number.isSafeInteger(suite.rows) ||
        suite.rows < 1 ||
        !/^[a-f0-9]{64}$/u.test(String(suite.sha256 ?? ""))) {
      fail("Official benchmark suite inventory is invalid or duplicated.");
    }
    suiteIds.add(suite.id);
    buckets.add(suite.benchmarkBucket);
    const suitePath = safePath(suite.path, `Official benchmark suite ${suite.id}`);
    const suiteEvidence = readTextEvidence(
      suitePath,
      `Official benchmark suite ${suite.id}`,
      64 * 1024 * 1024
    );
    if (suiteEvidence.sha256 !== suite.sha256) {
      fail(`Official benchmark suite ${suite.id} bytes changed.`);
    }
    const suiteRows = parseJsonLines(
      suiteEvidence.contents,
      `Official benchmark suite ${suite.id}`
    );
    if (suiteRows.length !== suite.rows) {
      fail(`Official benchmark suite ${suite.id} row count changed.`);
    }
    rows.push(...suiteRows.map((row) => ({
      ...row,
      benchmarkBucket: suite.benchmarkBucket
    })));
  }
  if (manifestEvidence.sha256 !== sha256File(benchmarkManifestPath)) {
    fail("Official benchmark manifest changed while being loaded.");
  }
  return rows;
}

function readJsonEvidence(path, label) {
  const file = readTextEvidence(path, label, 16 * 1024 * 1024);
  try {
    const value = JSON.parse(file.contents.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must contain a JSON object.`);
    }
    return { file, value };
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function readTextEvidence(path, label, maxBytes) {
  return inspectContainedRegularFile(ROOT, safePath(path, label), {
    label,
    includeContents: true,
    maxBytes
  });
}

function parseJsonLines(contents, label) {
  const rows = [];
  for (const [index, line] of contents.toString("utf8").split(/\n/u).entries()) {
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      fail(`${label}:${index + 1} is invalid JSON: ${errorMessage(error)}`);
    }
  }
  return rows;
}

function benchmarkCorpusSha256(suites) {
  const hash = createHash("sha256");
  for (const suite of suites) {
    for (const [value, terminator] of [
      [suite.id, "\0"],
      [suite.path, "\0"],
      [suite.sha256, "\0"],
      [suite.rows, "\n"]
    ]) {
      hash.update(String(value));
      hash.update(terminator);
    }
  }
  return hash.digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set([
    "benchmark-manifest",
    "export-report",
    "predictions",
    "reference-manifest",
    "report"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      fail(`Unexpected positional argument: ${argument}.`);
    }
    const name = argument.slice(2);
    if (!allowed.has(name)) fail(`Unknown official-evaluation argument --${name}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${name}.`);
    if (values.has(name)) fail(`Duplicate --${name} argument.`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function requiredPath(values, name) {
  const value = values.get(name);
  if (!value) fail(`--${name} is required.`);
  return safePath(value, name);
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

function safeOutputPath(value) {
  const path = safePath(value, "Official evaluation report");
  const parent = dirname(path);
  if (!existsSync(parent)) {
    const ancestor = nearestExistingAncestor(parent);
    const child = relative(ROOT, ancestor);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      fail("Official evaluation report parent escapes the repository.");
    }
  }
  return path;
}

function nearestExistingAncestor(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
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
