#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import Ajv2020 from "ajv/dist/2020.js";
import {
  inspectContainedDirectoryTree,
  inspectContainedRegularFile
} from "./lib/neural-artifact-filesystem.mjs";
import {
  resolveNeuralArtifactDescriptor
} from "./lib/neural-artifact-descriptor.mjs";
import {
  validateNeuralSelectionReport
} from "./lib/neural-model-selection.mjs";

const ROOT = realpathSync(process.cwd());
const startedAt = performance.now();
const args = parseArgs(process.argv.slice(2));
const production = args.flags.has("production");
const canonicalProductionDirectory = join(
  ROOT,
  "models",
  "macos",
  "LekhNeuralTransliterator.production"
);
const productionDirectory = safePath(
  value(args, "production-dir") ?? canonicalProductionDirectory,
  "Production neural directory"
);
const reportPath = safeOutputPath(
  value(args, "report") ??
    join(
      ROOT,
      "reports",
      production
        ? "neural-production-promotion-production-report.json"
        : "neural-production-promotion-report.json"
    )
);
const failures = [];
const warnings = [];
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{32}$/u;

if (production && productionDirectory !== canonicalProductionDirectory) {
  failures.push(
    "Production Phase 9 forbids --production-dir; the canonical promoted " +
    "directory is mandatory."
  );
}

let verification = null;
if (!existsSync(productionDirectory)) {
  if (production) {
    failures.push(
      "Canonical promoted neural directory is missing; no production receipt exists."
    );
  } else {
    warnings.push(
      "No promoted neural directory exists; the development promotion guard remains active."
    );
  }
} else {
  try {
    verification = verifyProductionBundle();
  } catch (error) {
    failures.push(errorMessage(error));
  }
}

const status = failures.length === 0
  ? production
    ? "passed-production-phase9-promotion"
    : verification
      ? "passed-phase9-promotion-receipt"
      : "passed-phase9-promotion-guard"
  : production
    ? "failed-production-phase9-promotion"
    : "failed-phase9-promotion";
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  command: "node scripts/check-neural-production-promotion.mjs",
  suite: "neural-production-promotion",
  durationMs: Math.round(performance.now() - startedAt),
  phase: 9,
  production,
  status,
  productionDirectory: portable(productionDirectory),
  verification,
  failures,
  warnings
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status,
  report: portable(reportPath),
  promotionId: verification?.promotionId ?? null,
  artifactSetSha256: verification?.artifactSetSha256 ?? null,
  failures,
  warnings
}, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;

function verifyProductionBundle() {
  assertRealDirectory(productionDirectory, "Production neural directory");
  const manifestPath = join(
    productionDirectory,
    "LekhNeuralTransliterator.manifest.json"
  );
  const vocabularyPath = join(
    productionDirectory,
    "LekhNeuralTransliterator.vocab.json"
  );
  const promotionReportPath = join(
    productionDirectory,
    "neural-candidate-promotion-report.json"
  );
  const manifestEvidence = readJsonEvidence(
    manifestPath,
    "Promoted runtime manifest"
  );
  const promotionEvidence = readJsonEvidence(
    promotionReportPath,
    "Neural candidate promotion receipt"
  );
  const manifest = manifestEvidence.value;
  validateManifestSchema(manifest);
  if (manifest.productionEligible !== true ||
      manifest.localOnly !== true ||
      manifest.neuralTailOnly !== true ||
      manifest.openVocabulary !== true) {
    fail(
      "Promoted manifest must be production-eligible, local-only, " +
      "neural-tail-only, and open-vocabulary."
    );
  }
  const descriptor = resolveNeuralArtifactDescriptor({
    repoRoot: ROOT,
    manifest,
    manifestPath,
    vocabPath: vocabularyPath,
    artifactDirectory: productionDirectory,
    verifyExportArtifacts: false
  });
  const receipt = promotionEvidence.value;
  validateReceiptShape({
    receipt,
    descriptor,
    manifestEvidence: manifestEvidence.file,
    promotionReportPath
  });
  enforceClosedWorldBundle(receipt);
  const selectionEvidence = verifyRetainedEvidence(
    receipt.inputs.selectionReport,
    "Retained model-selection report",
    { json: true }
  );
  const selection = validateNeuralSelectionReport(selectionEvidence.value);
  const winner = selection.winner;
  if (winner.identity.trainingRunId !== manifest.trainingRunId ||
      winner.identity.exportRunId !== manifest.exportRunId ||
      winner.identity.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      winner.identity.vocabSha256 !== descriptor.vocabSha256 ||
      winner.identity.manifestSha256 !==
        receipt.inputs.candidateManifest.sha256 ||
      winner.identity.exportReportSha256 !==
        receipt.inputs.exportReport.sha256 ||
      winner.evidence.evaluationReport.sha256 !==
        receipt.inputs.evaluationReport.sha256 ||
      winner.evidence.benchmarkReport.sha256 !==
        receipt.inputs.benchmarkReport.sha256 ||
      winner.evidence.comparisonReport.sha256 !==
        receipt.inputs.comparisonReport.sha256 ||
      winner.evidence.comparisonPredictions.sha256 !==
        receipt.inputs.comparisonPredictions.sha256 ||
      winner.evidence.benchmarkManifest.sha256 !==
        receipt.inputs.comparisonBenchmarkManifest.sha256 ||
      selection.selectionId !== receipt.inputs.selectionId) {
    fail("Promotion receipt is not bound to the deterministic selection winner.");
  }

  const retained = {};
  for (const [name, record] of Object.entries(receipt.inputs)) {
    if (name === "selectionId" ||
        name === "goldCorpusSha256" ||
        name === "datasetContentSha256") {
      continue;
    }
    retained[name] = evidenceSummary(
      verifyRetainedEvidence(
        record,
        `Retained promotion input ${name}`,
        {
          directory: false,
          json: [
            "candidateManifest",
            "exportReport",
            "evaluationReport",
            "benchmarkReport",
            "selectionReport",
            "candidateSpecification",
            "comparisonReport",
            "comparisonBenchmarkManifest",
            "goldManifest",
            "datasetManifest",
            "vocabulary"
          ].includes(name)
        }
      ).file
    );
  }
  if (!SHA256_PATTERN.test(String(receipt.inputs.goldCorpusSha256 ?? "")) ||
      !SHA256_PATTERN.test(String(receipt.inputs.datasetContentSha256 ?? ""))) {
    fail("Promotion receipt stable corpus identities are invalid.");
  }
  if (selectionEvidence.file.sha256 !==
      receipt.inputs.selectionReport.sha256) {
    fail("Retained selection report changed after promotion.");
  }

  const artifactHashes = {};
  for (const artifact of receipt.artifacts) {
    const destination = safePath(
      artifact.destination,
      `Promoted artifact ${artifact.id}`
    );
    if (dirname(destination) !== productionDirectory ||
        basename(destination) !== basename(artifact.destination)) {
      fail(`Promoted artifact ${artifact.id} escapes the production directory.`);
    }
    const evidence = inspectContainedDirectoryTree(ROOT, destination, {
      label: `Promoted artifact ${artifact.id}`,
      maxBytes: 64 * 1024 * 1024,
      maxEntries: 10_000
    });
    if (evidence.sha256 !== artifact.sha256 ||
        evidence.bytes !== artifact.bytes) {
      fail(`Promoted artifact ${artifact.id} differs from its promotion receipt.`);
    }
    artifactHashes[artifact.id] = evidence.sha256;
  }
  for (const artifact of descriptor.artifacts) {
    const id = descriptor.runtimeModelContract ===
      "split-attention-incremental-v1"
      ? `${artifact.role}.compiledModel`
      : "compiledModel";
    if (artifactHashes[id] !== artifact.compiledSha256) {
      fail(`Runtime artifact ${id} is not represented by the promotion receipt.`);
    }
  }

  const reconstructedIdentity = {
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    candidateManifestSha256: receipt.inputs.candidateManifest.sha256,
    exportReportSha256: receipt.inputs.exportReport.sha256,
    evaluationReportSha256: receipt.inputs.evaluationReport.sha256,
    benchmarkReportSha256: receipt.inputs.benchmarkReport.sha256,
    selectionReportSha256: receipt.inputs.selectionReport.sha256,
    selectionId: receipt.inputs.selectionId,
    candidateSpecificationSha256:
      receipt.inputs.candidateSpecification.sha256,
    comparisonReportSha256: receipt.inputs.comparisonReport.sha256,
    comparisonPredictionsSha256:
      receipt.inputs.comparisonPredictions.sha256,
    comparisonBenchmarkManifestSha256:
      receipt.inputs.comparisonBenchmarkManifest.sha256,
    predictionsSha256: receipt.inputs.predictions.sha256,
    goldManifestSha256: receipt.inputs.goldManifest.sha256,
    goldCorpusSha256: receipt.inputs.goldCorpusSha256,
    datasetManifestSha256: receipt.inputs.datasetManifest.sha256,
    datasetContentSha256: receipt.inputs.datasetContentSha256,
    vocabularySha256: receipt.inputs.vocabulary.sha256,
    artifactSetSha256: descriptor.artifactSetSha256,
    checkpointSha256: receipt.inputs.checkpoint.sha256,
    artifacts: Object.fromEntries(
      receipt.artifacts.map((artifact) => [
        artifact.id,
        artifact.sha256
      ])
    )
  };
  const reconstructedPromotionId = sha256CanonicalJson(
    reconstructedIdentity
  );
  if (reconstructedPromotionId !== receipt.promotionId) {
    fail("Promotion ID does not match the complete retained evidence graph.");
  }

  return {
    promotionId: receipt.promotionId,
    selectionId: selection.selectionId,
    trainingRunId: receipt.trainingRunId,
    exportRunId: receipt.exportRunId,
    modelId: descriptor.modelId,
    runtimeModelContract: descriptor.runtimeModelContract,
    artifactSetSha256: descriptor.artifactSetSha256,
    manifest: evidenceSummary(manifestEvidence.file),
    receipt: evidenceSummary(promotionEvidence.file),
    retainedInputs: retained,
    artifacts: receipt.artifacts.map((artifact) => ({
      id: artifact.id,
      sha256: artifact.sha256,
      bytes: artifact.bytes
    })),
    closedWorldInventory: readdirSync(productionDirectory).sort()
  };
}

function validateReceiptShape({
  receipt,
  descriptor,
  manifestEvidence,
  promotionReportPath
}) {
  if (receipt.schemaVersion !== 1 ||
      receipt.status !== "passed-neural-candidate-promotion" ||
      receipt.candidateImmutable !== true ||
      !RUN_ID_PATTERN.test(String(receipt.trainingRunId ?? "")) ||
      !RUN_ID_PATTERN.test(String(receipt.exportRunId ?? "")) ||
      receipt.trainingRunId === receipt.exportRunId ||
      receipt.trainingRunId !== descriptor.manifest.trainingRunId ||
      receipt.exportRunId !== descriptor.manifest.exportRunId ||
      receipt.artifactSetSha256 !== descriptor.artifactSetSha256 ||
      !SHA256_PATTERN.test(String(receipt.promotionId ?? "")) ||
      !Array.isArray(receipt.artifacts) ||
      receipt.artifacts.length < 2 ||
      !receipt.inputs ||
      typeof receipt.inputs !== "object" ||
      Array.isArray(receipt.inputs)) {
    fail("Neural promotion receipt contract is invalid.");
  }
  const expectedLayout = descriptor.runtimeModelContract ===
    "split-attention-incremental-v1"
    ? "split-attention"
    : "single-model";
  if (receipt.artifactLayout !== expectedLayout ||
      resolve(ROOT, receipt.productionDirectory) !== productionDirectory ||
      resolve(ROOT, receipt.productionManifest?.path ?? "") !==
        manifestEvidence.path ||
      receipt.productionManifest.sha256 !== manifestEvidence.sha256 ||
      receipt.productionManifest.bytes !== manifestEvidence.bytes ||
      resolve(promotionReportPath) !==
        join(productionDirectory, "neural-candidate-promotion-report.json")) {
    fail("Promotion receipt does not identify the current production bundle.");
  }
  const requiredInputs = [
    "benchmarkReport",
    "candidateManifest",
    "candidateSpecification",
    "checkpoint",
    "comparisonBenchmarkManifest",
    "comparisonPredictions",
    "comparisonReport",
    "datasetContentSha256",
    "datasetManifest",
    "evaluationReport",
    "exportReport",
    "goldCorpusSha256",
    "goldManifest",
    "predictions",
    "selectionId",
    "selectionReport",
    "vocabulary"
  ];
  if (JSON.stringify(Object.keys(receipt.inputs).sort()) !==
      JSON.stringify(requiredInputs.sort())) {
    fail("Promotion receipt input inventory is incomplete or contains unknown keys.");
  }
}

function enforceClosedWorldBundle(receipt) {
  const expected = new Set([
    "LekhNeuralTransliterator.manifest.json",
    "LekhNeuralTransliterator.vocab.json",
    "neural-candidate-promotion-report.json",
    ...receipt.artifacts.map((artifact) => basename(artifact.destination))
  ]);
  const observed = readdirSync(productionDirectory).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) {
    fail(
      `Production neural directory is not closed-world; expected ` +
      `${wanted.join(", ")}, observed ${observed.join(", ")}.`
    );
  }
}

function verifyRetainedEvidence(record, label, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      typeof record.path !== "string" ||
      !SHA256_PATTERN.test(String(record.sha256 ?? "")) ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1) {
    fail(`${label} receipt record is invalid.`);
  }
  const path = safePath(record.path, label);
  const file = inspectContainedRegularFile(ROOT, path, {
    label,
    includeContents: Boolean(options.json),
    maxBytes: label.includes("checkpoint")
      ? 512 * 1024 * 1024
      : label.includes("predictions")
        ? 256 * 1024 * 1024
        : 32 * 1024 * 1024
  });
  if (file.sha256 !== record.sha256 || file.bytes !== record.bytes) {
    fail(`${label} changed after candidate promotion.`);
  }
  if (!options.json) return { file, value: null };
  let parsed;
  try {
    parsed = JSON.parse(file.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
  return { file, value: parsed };
}

function validateManifestSchema(manifest) {
  const schemaPath = join(
    ROOT,
    "data",
    "neural",
    "schema",
    "lekh-neural-manifest.schema.json"
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = new Ajv2020({
    allErrors: true,
    strict: true
  }).compile(schema);
  if (!validate(manifest)) {
    fail(
      `Promoted manifest violates its closed schema: ` +
      `${JSON.stringify(validate.errors)}.`
    );
  }
}

function readJsonEvidence(path, label) {
  const file = inspectContainedRegularFile(ROOT, safePath(path, label), {
    label,
    includeContents: true,
    maxBytes: 16 * 1024 * 1024
  });
  let value;
  try {
    value = JSON.parse(file.contents.toString("utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain a JSON object.`);
  }
  return { file, value };
}

function assertRealDirectory(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      realpathSync(path) !== resolve(path)) {
    fail(`${label} must be a real canonical directory.`);
  }
}

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--production") {
      if (flags.has("production")) fail("Duplicate --production flag.");
      flags.add("production");
      continue;
    }
    if (!["--production-dir", "--report"].includes(argument)) {
      fail(`Unknown Phase 9 argument ${argument}.`);
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) fail(`Missing value for ${argument}.`);
    if (values.has(name)) fail(`Duplicate ${argument}.`);
    values.set(name, next);
    index += 1;
  }
  return { flags, values };
}

function value(parsed, name) {
  return parsed.values.get(name);
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
  return safePath(value, "Phase 9 report");
}

function evidenceSummary(evidence) {
  return {
    path: portable(evidence.path),
    bytes: evidence.bytes,
    sha256: evidence.sha256
  };
}

function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
