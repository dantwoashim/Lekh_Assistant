#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import {
  createEvaluationIdentityIndex,
  NeuralDatasetQualityAccumulator
} from "./lib/neural-dataset-quality-audit.mjs";
import { NeuralCTCAlignmentAccumulator } from "./lib/neural-ctc-alignment-audit.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const defaults = Object.freeze({
  datasetManifest: "data/generated/neural-open-vocab/manifest.json",
  goldManifest: "data/neural/gold/manifest.v3.json",
  benchmarkManifest: "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
  report: "data/neural/audits/open-vocab-data-quality-v1.json",
  ctcConfig: "data/neural/training/open-vocab-ctc-transformer-v2.config.json",
  ctcReport: "data/neural/audits/ctc-transformer-v2-alignment-v1.json"
});

export async function auditNeuralOpenVocabularyDataset(options = {}) {
  const paths = {
    datasetManifest: resolveRepoRegularFile(options.datasetManifest ?? defaults.datasetManifest, "dataset manifest"),
    goldManifest: resolveRepoRegularFile(options.goldManifest ?? defaults.goldManifest, "gold manifest"),
    benchmarkManifest: resolveRepoRegularFile(options.benchmarkManifest ?? defaults.benchmarkManifest, "benchmark manifest"),
    report: resolveRepoOutputFile(options.report ?? defaults.report),
    ctcConfig: resolveRepoRegularFile(options.ctcConfig ?? defaults.ctcConfig, "CTC training config"),
    ctcReport: resolveRepoOutputFile(options.ctcReport ?? defaults.ctcReport)
  };
  const datasetManifest = readJson(paths.datasetManifest);
  const ctcConfigBytes = readFileSync(paths.ctcConfig);
  const ctcConfig = JSON.parse(ctcConfigBytes.toString("utf8"));
  const evaluation = {
    "gold-foundation": await readEvaluationRelease(paths.goldManifest),
    "aksharantar-official-benchmark": await readEvaluationRelease(paths.benchmarkManifest)
  };
  const accumulator = new NeuralDatasetQualityAccumulator({
    evaluationIndexes: Object.entries(evaluation).map(([name, release]) =>
      createEvaluationIdentityIndex(name, release.rows))
  });
  const ctcAccumulator = new NeuralCTCAlignmentAccumulator({
    maxInputLength: Number(ctcConfig.decoder?.maxInputGraphemes),
    outputTimeSteps: Number(ctcConfig.decoder?.outputTimeSteps)
  });
  const splitArtifacts = {};
  for (const split of ["train", "dev", "test"]) {
    const declaredPath = datasetManifest.splitFiles?.[split];
    if (typeof declaredPath !== "string" || !declaredPath) {
      throw new Error(`Dataset manifest is missing splitFiles.${split}.`);
    }
    splitArtifacts[split] = await streamDatasetSplit({
      accumulator,
      ctcAccumulator,
      split,
      path: resolveRepoRegularFile(declaredPath, `${split} dataset split`),
      expected: {
        bytes: datasetManifest.bytes?.[split],
        rows: datasetManifest.counts?.[split],
        sha256: datasetManifest.sha256?.[split]
      }
    });
    if (split === "train") ctcAccumulator.finishTrainingSplit();
  }
  const manifestBytes = readFileSync(paths.datasetManifest);
  for (const [name, release] of Object.entries(evaluation)) {
    ctcAccumulator.addEvaluationRelease(name, release.rows);
  }
  const evaluationReferences = Object.fromEntries(Object.entries(evaluation).map(([name, release]) => [name, {
    manifestPath: relativePath(release.manifestPath),
    manifestSha256: release.manifestSha256,
    releaseId: release.manifest.releaseId ?? null,
    rows: release.rows.length,
    suites: release.artifacts
  }]));
  const report = accumulator.finalize({
    dataset: {
      id: datasetManifest.datasetId ?? null,
      manifestPath: relativePath(paths.datasetManifest),
      manifestSha256: sha256(manifestBytes),
      declaredContentSha256: datasetManifest.datasetContentSha256 ?? null,
      declaredRows: datasetManifest.totalRows ?? null,
      declaredCounts: datasetManifest.counts ?? null
    },
    artifacts: {
      splits: splitArtifacts,
      evaluationReferences
    }
  });
  report.scope = {
    purpose:
      "Dataset integrity, provenance, balance, Unicode, leakage, and conservative historical representation diagnostics.",
    activeCTCRepresentationEvidence:
      relativePath(paths.ctcReport),
    representationWarning:
      "Base-plus-mark vocabulary warnings in this general report are not Transformer-CTC OOV findings; the bound CTC alignment report is authoritative for active-model representability."
  };
  const ctcReport = ctcAccumulator.finalize({
    model: {
      id: ctcConfig.modelId ?? null,
      configPath: relativePath(paths.ctcConfig),
      configSha256: sha256(ctcConfigBytes),
      implementationContractVersion:
        ctcConfig.implementationContractVersion ?? null,
      runtimeModelContract:
        ctcConfig.architecture?.runtimeModelContract ?? null
    },
    dataset: {
      id: datasetManifest.datasetId ?? null,
      manifestPath: relativePath(paths.datasetManifest),
      manifestSha256: sha256(manifestBytes),
      declaredContentSha256:
        datasetManifest.datasetContentSha256 ?? null,
      declaredRows: datasetManifest.totalRows ?? null,
      declaredCounts: datasetManifest.counts ?? null
    },
    artifacts: {
      splits: splitArtifacts,
      evaluationReferences
    }
  });
  mkdirSync(dirname(paths.report), { recursive: true });
  requireRepoContainment(realpathSync(dirname(paths.report)), "audit report directory");
  mkdirSync(dirname(paths.ctcReport), { recursive: true });
  requireRepoContainment(realpathSync(dirname(paths.ctcReport)), "CTC audit report directory");
  writeJsonReport(paths.report, report);
  writeJsonReport(paths.ctcReport, ctcReport);
  return {
    report,
    reportPath: paths.report,
    ctcReport,
    ctcReportPath: paths.ctcReport
  };
}

async function streamDatasetSplit({
  accumulator,
  ctcAccumulator,
  split,
  path,
  expected
}) {
  const artifact = await streamJsonLines(path, (row, line, error) => {
    const location = `${relativePath(path)}:${line}`;
    if (error) {
      accumulator.addInvalidJson(split, location, error.message);
      ctcAccumulator.addInvalidJson(split, location, error.message);
    } else {
      accumulator.add(row, split, location);
      ctcAccumulator.add(row, split, location);
    }
  });
  const expectedValues = {
    bytes: Number(expected.bytes),
    rows: Number(expected.rows),
    sha256: String(expected.sha256 ?? "")
  };
  return {
    path: relativePath(path),
    expected: expectedValues,
    observed: artifact,
    integrityMatches:
      artifact.bytes === expectedValues.bytes &&
      artifact.rows === expectedValues.rows &&
      artifact.sha256 === expectedValues.sha256 &&
      artifact.invalidJsonRows === 0
  };
}

async function readEvaluationRelease(manifestPath) {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const rows = [];
  const artifacts = [];
  for (const suite of manifest.suites ?? []) {
    if (typeof suite.path !== "string" || !suite.path) {
      throw new Error(`Evaluation manifest ${relativePath(manifestPath)} has a suite without a path.`);
    }
    const path = resolveRepoRegularFile(suite.path, `evaluation suite ${suite.id ?? "<unknown>"}`);
    const artifact = await streamJsonLines(path, (row, _line, error) => {
      if (error) throw new Error(`Invalid JSON in ${relativePath(path)}: ${error.message}`);
      rows.push(row);
    });
    const expected = {
      rows: Number(suite.rows),
      sha256: String(suite.sha256 ?? "")
    };
    artifacts.push({
      id: suite.id ?? null,
      path: relativePath(path),
      expected,
      observed: artifact,
      integrityMatches:
        artifact.rows === expected.rows &&
        artifact.sha256 === expected.sha256 &&
        artifact.invalidJsonRows === 0
    });
  }
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    rows,
    artifacts
  };
}

async function streamJsonLines(path, visit) {
  const digest = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let bytes = 0;
  let rows = 0;
  let invalidJsonRows = 0;
  let line = 0;

  const consume = (text, final = false) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const current = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      processLine(current);
    }
    if (final && buffered.length > 0) {
      processLine(buffered.replace(/\r$/u, ""));
      buffered = "";
    }
  };
  const processLine = (value) => {
    line += 1;
    if (!value.trim()) return;
    rows += 1;
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      invalidJsonRows += 1;
      visit(null, line, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    visit(parsed, line, null);
  };

  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength;
    digest.update(chunk);
    consume(decoder.write(chunk));
  }
  consume(decoder.end(), true);
  return { bytes, rows, sha256: digest.digest("hex"), invalidJsonRows };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonReport(path, value) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Refusing non-regular or symbolic-link audit report: ${relativePath(path)}`
      );
    }
  }
  const staging = resolve(
    dirname(path),
    `.${basename(path)}.${process.pid}.${process.hrtime.bigint()}.tmp`
  );
  let descriptor;
  try {
    descriptor = openSync(staging, "wx", 0o644);
    writeFileSync(
      descriptor,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8"
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(staging, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original report-write failure.
      }
    }
    if (existsSync(staging)) {
      const metadata = lstatSync(staging);
      if (!metadata.isSymbolicLink() && metadata.isFile()) {
        unlinkSync(staging);
      }
    }
    throw error;
  }
}

export function resolveRepoRegularFile(candidate, label = "input") {
  const lexicalPath = resolve(root, String(candidate));
  requireRepoContainment(lexicalPath, label);
  const metadata = lstatSync(lexicalPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Refusing non-regular or symbolic-link ${label}: ${relativePath(lexicalPath)}`);
  }
  const canonicalPath = realpathSync(lexicalPath);
  requireRepoContainment(canonicalPath, label);
  return canonicalPath;
}

function resolveRepoOutputFile(candidate) {
  const lexicalPath = resolve(root, String(candidate));
  requireRepoContainment(lexicalPath, "audit report");
  if (existsSync(lexicalPath)) {
    const metadata = lstatSync(lexicalPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Refusing non-regular or symbolic-link audit report: ${relativePath(lexicalPath)}`);
    }
  }
  return lexicalPath;
}

function requireRepoContainment(path, label) {
  if (!isRepoContained(path)) {
    throw new Error(`Refusing ${label} outside repository root: ${path}`);
  }
}

function isRepoContained(path) {
  const candidate = relative(root, path);
  return (
    candidate === "" ||
    (
      candidate !== ".." &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate)
    )
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativePath(path) {
  return isRepoContained(path) ? relative(root, path) || "." : path;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    const key = {
      "--dataset-manifest": "datasetManifest",
      "--gold-manifest": "goldManifest",
      "--benchmark-manifest": "benchmarkManifest",
      "--report": "report",
      "--ctc-config": "ctcConfig",
      "--ctc-report": "ctcReport"
    }[option];
    if (!key) throw new Error(`Unknown option: ${option}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${option}.`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/audit-neural-open-vocab-dataset.mjs [options]",
    "",
    `  --dataset-manifest <path>   default: ${defaults.datasetManifest}`,
    `  --gold-manifest <path>      default: ${defaults.goldManifest}`,
    `  --benchmark-manifest <path> default: ${defaults.benchmarkManifest}`,
    `  --report <path>             default: ${defaults.report}`,
    `  --ctc-config <path>         default: ${defaults.ctcConfig}`,
    `  --ctc-report <path>         default: ${defaults.ctcReport}`
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const {
        report,
        reportPath,
        ctcReport,
        ctcReportPath
      } = await auditNeuralOpenVocabularyDataset(options);
      console.log(JSON.stringify({
        dataQualityStatus: report.status,
        ctcAlignmentStatus: ctcReport.status,
        rowsAudited: report.rowsAudited,
        findings: report.findings.map(({ severity, code, message }) => ({ severity, code, message })),
        ctcFindings: ctcReport.findings.map(
          ({ severity, code, message }) => ({ severity, code, message })
        ),
        report: relativePath(reportPath),
        ctcReport: relativePath(ctcReportPath)
      }, null, 2));
      if (
        report.status === "failed-data-quality-audit" ||
        ctcReport.status === "failed-ctc-alignment-audit"
      ) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
