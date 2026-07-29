#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateNeuralAuditEvidence } from "./lib/neural-audit-evidence.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const paths = Object.freeze({
  datasetManifest: "data/generated/neural-open-vocab/manifest.json",
  qualityAudit: "data/neural/audits/open-vocab-data-quality-v1.json",
  ctcAudit: "data/neural/audits/ctc-transformer-v2-alignment-v1.json",
  ctcConfig: "data/neural/training/open-vocab-ctc-transformer-v2.config.json",
  goldManifest: "data/neural/gold/manifest.v3.json",
  benchmarkManifest:
    "data/neural/benchmarks/aksharantar-nepali-test-v1/manifest.json",
  report: "reports/neural-audit-evidence-report.json"
});

export function checkNeuralAuditEvidence() {
  const dataset = readJsonEvidence(paths.datasetManifest, "dataset manifest");
  const qualityAudit = readJsonEvidence(
    paths.qualityAudit,
    "dataset quality audit"
  );
  const ctcAudit = readJsonEvidence(paths.ctcAudit, "CTC alignment audit");
  const ctcConfig = readJsonEvidence(paths.ctcConfig, "CTC training config");
  const evaluationManifests = Object.fromEntries([
    ["gold-foundation", paths.goldManifest],
    ["aksharantar-official-benchmark", paths.benchmarkManifest]
  ].map(([name, path]) => {
    const evidence = readJsonEvidence(path, `${name} manifest`);
    return [name, {
      manifestPath: path,
      manifestSha256: evidence.sha256,
      manifest: evidence.value,
      rows: (evidence.value.suites ?? []).reduce(
        (sum, suite) => sum + Number(suite.rows ?? 0),
        0
      )
    }];
  }));
  const validation = validateNeuralAuditEvidence({
    datasetManifest: dataset.value,
    datasetManifestPath: paths.datasetManifest,
    datasetManifestSha256: dataset.sha256,
    qualityAudit: qualityAudit.value,
    ctcAudit: ctcAudit.value,
    ctcConfig: ctcConfig.value,
    ctcConfigPath: paths.ctcConfig,
    ctcConfigSha256: ctcConfig.sha256,
    evaluationManifests
  });
  return {
    validation,
    evidence: {
      datasetManifest: {
        path: paths.datasetManifest,
        sha256: dataset.sha256,
        datasetContentSha256:
          dataset.value.datasetContentSha256 ?? null,
        rows: dataset.value.totalRows ?? null
      },
      ctcConfig: {
        path: paths.ctcConfig,
        sha256: ctcConfig.sha256,
        modelId: ctcConfig.value.modelId ?? null
      },
      audits: {
        quality: {
          path: paths.qualityAudit,
          status: qualityAudit.value.status ?? null
        },
        ctcAlignment: {
          path: paths.ctcAudit,
          status: ctcAudit.value.status ?? null
        }
      },
      evaluationManifests: Object.fromEntries(
        Object.entries(evaluationManifests).map(([name, value]) => [
          name,
          {
            path: value.manifestPath,
            sha256: value.manifestSha256,
            rows: value.rows
          }
        ])
      )
    }
  };
}

function readJsonEvidence(relativePath, label) {
  const path = resolve(root, relativePath);
  requireRepoContainment(path, label);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `Refusing non-regular or symbolic-link ${label}: ${relativePath}`
    );
  }
  const canonical = realpathSync(path);
  requireRepoContainment(canonical, label);
  const bytes = readFileSync(canonical);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${relativePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return {
    path: canonical,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    value
  };
}

function requireRepoContainment(path, label) {
  const candidate = relative(root, path);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    throw new Error(`Refusing ${label} outside repository root: ${path}`);
  }
}

function writeReport(payload) {
  const path = resolve(root, paths.report);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        `Refusing non-regular or symbolic-link report: ${paths.report}`
      );
    }
  }
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkNeuralAuditEvidence();
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: "node scripts/check-neural-audit-evidence.mjs",
      suite: "neural-audit-evidence",
      status: result.validation.ok ? "passed" : "failed",
      evidence: result.evidence,
      failures: result.validation.failures
    };
    writeReport(report);
    const output = {
      status: report.status,
      report: relative(root, resolve(root, paths.report)),
      failures: report.failures
    };
    if (result.validation.ok) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.error(JSON.stringify(output, null, 2));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
