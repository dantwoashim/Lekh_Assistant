#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildCompletionArtifact,
  manifestFor,
  readJson,
  serializeJson,
  validateArtifactShape
} from "./token-completion-lib.mjs";

const ROOT = process.cwd();
const startedAt = performance.now();
const seedsPath = join(ROOT, "data/completion/v1/token-completion-seeds.json");
const registryPath = join(ROOT, "data/completion/v1/source-registry.json");
const evaluationPath = join(ROOT, "data/completion/v1/eval-regression.json");
const artifactPath = join(ROOT, "data/completion/runtime/v1/lekh-token-completions.v1.json");
const manifestPath = join(ROOT, "data/completion/runtime/v1/lekh-token-completions.v1.manifest.json");
const reportPath = join(ROOT, "reports/token-completion-build-report.json");

const seeds = readJson(seedsPath);
const registry = readJson(registryPath);
const evaluation = readJson(evaluationPath);
const result = buildCompletionArtifact({ seeds, registry, evaluation });
const artifactFailures = validateArtifactShape(result.artifact);
const failures = [...result.failures, ...artifactFailures];
if (failures.length > 0) finish("failed", failures);

const artifactBytes = serializeJson(result.artifact);
const manifest = manifestFor({
  artifactBytes,
  seedsPath,
  registryPath,
  evaluationPath,
  provenancePaths: {
    seedSet: relative(ROOT, seedsPath),
    sourceRegistry: relative(ROOT, registryPath),
    regressionEvaluation: relative(ROOT, evaluationPath)
  },
  seedCount: seeds.rows.length,
  evaluation: result.evaluation
});
const manifestBytes = serializeJson(manifest);
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, artifactBytes);
writeFileSync(manifestPath, manifestBytes);
finish("passed", []);

function finish(status, failures) {
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/build-token-completion-index.mjs",
    suite: "token-completion-index-build",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    artifact: relative(ROOT, artifactPath),
    manifest: relative(ROOT, manifestPath),
    seedRows: seeds?.rows?.length ?? 0,
    entryCount: result?.artifact?.entries?.length ?? 0,
    candidateCount: result?.artifact?.entries?.reduce((sum, entry) => sum + entry.candidates.length, 0) ?? 0,
    evaluation: result?.evaluation ?? null,
    failures
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console[status === "passed" ? "log" : "error"](JSON.stringify(report, null, 2));
  if (status !== "passed") process.exit(1);
}
