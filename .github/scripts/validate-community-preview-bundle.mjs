#!/usr/bin/env node

import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHORT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const NEURAL_RESOURCE_NAMES = [
  "LekhNeuralTransliterator.mlmodelc",
  "LekhNeuralTransliterator.manifest.json",
  "LekhNeuralTransliterator.vocab.json"
];

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateDeterministicCommunityPreviewBundle({
  bundlePath,
  expectedBuildNumber,
  reportPath
}) {
  if (!/^[1-9]\d*$/u.test(expectedBuildNumber ?? "")) {
    throw new Error("Expected build number must be a positive integer.");
  }
  const absoluteBundlePath = resolve(bundlePath);
  const bundleMetadata = await lstat(absoluteBundlePath);
  if (!bundleMetadata.isDirectory() || bundleMetadata.isSymbolicLink()) {
    throw new Error("Community-preview bundle must be a real directory.");
  }
  const [canonicalBundlePath, report, provenance] = await Promise.all([
    realpath(absoluteBundlePath),
    readFile(resolve(reportPath), "utf8").then(JSON.parse),
    readFile(
      join(absoluteBundlePath, "Contents", "Resources", "LekhBuildProvenance.v1.json"),
      "utf8"
    ).then(JSON.parse)
  ]);
  const canonicalReportArtifact = await realpath(report.artifact);
  if (canonicalReportArtifact !== canonicalBundlePath) {
    throw new Error("Package report does not identify the validated preview bundle.");
  }
  if (
    report.status !== "passed-adhoc-release" ||
    report.signed !== "ad-hoc-hardened-runtime" ||
    report.signingClassification !== "ad-hoc-development" ||
    report.productionSigningRequired !== true
  ) {
    throw new Error("Community preview must be an explicitly ad-hoc, non-production package.");
  }
  if (
    report.neuralModelPackaged !== false ||
    report.experimentalNeuralTypingEnabled !== false ||
    report.packagedNeuralModelBytes !== 0
  ) {
    throw new Error("Deterministic-only community preview unexpectedly contains or enables neural typing.");
  }
  const resources = join(absoluteBundlePath, "Contents", "Resources");
  for (const resourceName of NEURAL_RESOURCE_NAMES) {
    if (await pathExists(join(resources, resourceName))) {
      throw new Error(`Deterministic-only community preview contains forbidden neural resource ${resourceName}.`);
    }
  }
  if (
    JSON.stringify(report.buildProvenance) !== JSON.stringify(provenance) ||
    provenance.recordType !== "lekh-imk-build-provenance" ||
    provenance.sourceFilesClean !== true ||
    provenance.buildNumber !== expectedBuildNumber ||
    report.buildNumber !== expectedBuildNumber ||
    !SHORT_VERSION_PATTERN.test(provenance.shortVersion ?? "") ||
    report.shortVersion !== provenance.shortVersion ||
    !GIT_OBJECT_PATTERN.test(provenance.gitRevision ?? "") ||
    !GIT_OBJECT_PATTERN.test(provenance.gitTree ?? "") ||
    !SHA256_PATTERN.test(provenance.packagingScriptSha256 ?? "")
  ) {
    throw new Error("Package report and embedded build provenance are not a closed, current identity match.");
  }
  return {
    buildNumber: expectedBuildNumber,
    bundlePath: canonicalBundlePath,
    neuralPolicy: "deterministic-only-no-model",
    shortVersion: provenance.shortVersion,
    versionInfo: `${provenance.shortVersion}+build.${expectedBuildNumber}`
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (![
      "--bundle",
      "--expected-build-number",
      "--report"
    ].includes(option) || !value) {
      throw new Error(
        "Usage: validate-community-preview-bundle.mjs --bundle PATH --report PATH --expected-build-number NUMBER"
      );
    }
    values[option.slice(2)] = value;
  }
  if (!values.bundle || !values.report || !values["expected-build-number"]) {
    throw new Error(
      "Usage: validate-community-preview-bundle.mjs --bundle PATH --report PATH --expected-build-number NUMBER"
    );
  }
  return values;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await validateDeterministicCommunityPreviewBundle({
      bundlePath: options.bundle,
      expectedBuildNumber: options["expected-build-number"],
      reportPath: options.report
    });
    process.stdout.write(`${JSON.stringify({ status: "passed", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
