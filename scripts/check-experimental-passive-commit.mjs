#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { build } from "esbuild";

const root = process.cwd();
const policyPath = join(root, "data", "engine", "lekh-experimental-passive-commit.v1.json");
const schemaPath = join(root, "data", "engine", "lekh-experimental-passive-commit.schema.json");
const sourcePath = join(root, "data", "engine", "lekh-token-candidates.v1.json");
const contractPath = join(root, "data", "engine", "lekh-engine-contract.v1.json");
const policy = readJson(policyPath);
const schema = readJson(schemaPath);
const source = readJson(sourcePath);
const contract = readJson(contractPath);
const failures = [];

const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
if (!validateSchema(policy)) {
  for (const issue of validateSchema.errors ?? []) {
    failures.push(`JSON Schema ${issue.instancePath || "/"} ${issue.message ?? "validation failed"}`);
  }
}

requireExactKeys(policy, [
  "schemaVersion", "recordType", "id", "sourceContract", "productionEligible", "activation",
  "policy", "notes", "normalization", "delimiter", "minimumConfidence", "minimumInputCodePoints",
  "evidenceRequirements", "entries"
], "policy");
requireValue(policy.schemaVersion === 1, "policy.schemaVersion must be 1");
requireValue(policy.recordType === "lekh-experimental-passive-commit-policy", "policy.recordType is invalid");
requireValue(policy.id === "lekh-experimental-passive-commit-v1", "policy.id is invalid");
requireValue(policy.productionEligible === false, "experimental passive commit must remain production-ineligible");
requireValue(policy.activation === "opaque-test-build-capability-only", "policy activation must require an opaque test-build capability");
requireValue(policy.policy === "exact-single-output-repository-contract", "policy selection rule is invalid");
requireValue(policy.normalization === "NFC-lowercase-ascii-input", "policy normalization is invalid");
requireValue(policy.delimiter === " ", "policy delimiter must be exactly one space");
requireValue(Number.isFinite(policy.minimumConfidence) && policy.minimumConfidence >= 0 && policy.minimumConfidence <= 1,
  "policy.minimumConfidence must be within 0...1");
requireValue(Number.isSafeInteger(policy.minimumInputCodePoints) &&
  policy.minimumInputCodePoints >= 4 && policy.minimumInputCodePoints <= 64,
  "policy.minimumInputCodePoints must be within 4...64");

requireExactKeys(policy.sourceContract, ["id", "path", "sha256", "canonicalJsonSha256"], "policy.sourceContract");
requireValue(policy.sourceContract?.id === source.id, "source contract id does not match the candidate pack");
requireValue(policy.sourceContract?.path === "data/engine/lekh-token-candidates.v1.json", "source contract path is invalid");
requireValue(policy.sourceContract?.sha256 === sha256(sourcePath), "source contract SHA-256 is stale");
requireValue(policy.sourceContract?.canonicalJsonSha256 === sha256Text(JSON.stringify(source)),
  "source contract canonical JSON SHA-256 is stale");

requireExactKeys(policy.evidenceRequirements, [
  "humanRatedSamplesPerEntry", "maximumAmbiguityRate", "maximumUndoRate", "requiredNegativeCorpora"
], "policy.evidenceRequirements");
requireValue(Number.isSafeInteger(policy.evidenceRequirements?.humanRatedSamplesPerEntry) &&
  policy.evidenceRequirements.humanRatedSamplesPerEntry >= 1, "human-rated sample requirement is invalid");
for (const key of ["maximumAmbiguityRate", "maximumUndoRate"]) {
  const value = policy.evidenceRequirements?.[key];
  requireValue(Number.isFinite(value) && value >= 0 && value <= 1, `${key} must be within 0...1`);
}
requireValue(JSON.stringify(policy.evidenceRequirements?.requiredNegativeCorpora) ===
  JSON.stringify(["english", "names", "mixed-language"]), "required negative corpora are incomplete or reordered");

const sourceRows = new Map((source.rows ?? []).map((row) => [row.input, row]));
const inputs = new Set();
requireValue(Array.isArray(policy.entries) && policy.entries.length > 0 && policy.entries.length <= 256,
  "policy.entries must contain 1...256 rows");
for (const [index, entry] of (policy.entries ?? []).entries()) {
  const location = `policy.entries[${index}]`;
  requireExactKeys(entry, ["input", "output", "evidence"], location);
  requireValue(typeof entry.input === "string" && /^[a-z]+$/u.test(entry.input) &&
    [...entry.input].length >= policy.minimumInputCodePoints && [...entry.input].length <= 64 &&
    entry.input.normalize("NFC") === entry.input,
  `${location}.input must be normalized lowercase ASCII and meet the minimum length`);
  requireValue(typeof entry.output === "string" && entry.output.length > 0 &&
    [...entry.output].length <= 128 && entry.output.normalize("NFC") === entry.output &&
    /[\u0900-\u097f]/u.test(entry.output) &&
    !/[A-Za-z\s]/u.test(entry.output), `${location}.output must be one NFC Devanagari token`);
  requireValue(!inputs.has(entry.input), `${location}.input duplicates ${entry.input}`);
  inputs.add(entry.input);

  requireExactKeys(entry.evidence, [
    "provenance", "humanRatedSamples", "observedAmbiguityRate", "observedUndoRate"
  ], `${location}.evidence`);
  requireValue(entry.evidence?.provenance === "repository-curated-contract", `${location}.evidence provenance is invalid`);
  requireValue(entry.evidence?.humanRatedSamples === 0 && entry.evidence?.observedAmbiguityRate === null &&
    entry.evidence?.observedUndoRate === null, `${location}.evidence must truthfully remain uncalibrated`);

  const row = sourceRows.get(entry.input);
  requireValue(row?.outputs?.length === 1 && row.outputs[0]?.text === entry.output &&
    row.outputs[0]?.confidence >= policy.minimumConfidence,
  `${location} is not an exact single-output high-confidence source row`);
}

for (const quarantined of ["le", "ko", "cha", "ho", "xa", "lai", "ani", "aba", "nepal", "nepali"]) {
  requireValue(!inputs.has(quarantined), `ambiguous or ordinary-Latin token must remain quarantined: ${quarantined}`);
}

const authority = contract.candidatePolicy?.commitAuthority;
requireValue(authority?.explicitUserSelection === true, "engine contract must authorize explicit user selection");
requireValue(authority?.untrustedProgrammaticSelection === false,
  "engine contract must forbid untrusted programmatic selection");
requireValue(authority?.experimentalExactSpaceAuthorization?.policyId === policy.id,
  "engine contract must bind the exact experimental policy id");
requireValue(authority?.experimentalExactSpaceAuthorization?.productionEligible === false,
  "engine contract must forbid experimental exact-Space authorization in production");
requireValue(authority?.experimentalExactSpaceAuthorization?.activation === policy.activation,
  "engine contract and policy activation authorities differ");

const trustedActivationConsumers = new Set([
  "scripts/check-experimental-passive-commit.mjs",
  "src/engine/keyboard/experimentalPassiveCommitEngine.test-support.ts",
  "src/engine/keyboard/passiveCommit.test.ts"
]);
for (const directory of ["src", "native", "electron", "scripts"]) {
  for (const path of sourceFiles(join(root, directory))) {
    const sourceText = readFileSync(path, "utf8");
    if (!["experimentalPassiveCommitPolicyId", "EXPERIMENTAL_ENGINE_AUTHORITY", "createExperimentalKeyboardEngineForPolicyTests"]
      .some((identifier) => sourceText.includes(identifier))) continue;
    const localPath = relative(root, path);
    requireValue(trustedActivationConsumers.has(localPath),
      `experimental passive-commit authority escaped its closed construction/test files: ${localPath}`);
  }
}

const productionEntries = [
  ["browser keyboard engine", join(root, "src", "engine", "keyboard", "index.ts"), "browser"],
  ["native daemon", join(root, "native", "daemon", "src", "daemonCli.ts"), "node"]
];
const forbiddenProductionMarkers = [
  "lekh-experimental-passive-commit-policy",
  "humanRatedSamplesPerEntry",
  "createExperimentalKeyboardEngineForPolicyTests",
  "experimentalPassiveSpaceCandidate",
  "commitCandidateWithoutLearning"
];
for (const [label, entryPoint, platform] of productionEntries) {
  const bundle = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform,
    format: "esm",
    target: "es2022",
    treeShaking: true,
    logLevel: "silent",
    plugins: [rawQueryPlugin()]
  });
  const output = bundle.outputFiles.map((file) => file.text).join("\n");
  for (const marker of forbiddenProductionMarkers) {
    requireValue(!output.includes(marker), `${label} production bundle contains experimental authority marker ${marker}`);
  }
}

if (failures.length > 0) {
  console.error(`Experimental passive-commit policy failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Experimental passive-commit policy passed (${inputs.size} authorized test rows; production bundles exclude it).`);

function requireExactKeys(value, expected, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${location} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(wanted), `${location} fields are not exact`);
}

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFiles(directory) {
  const output = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (name !== "node_modules" && name !== ".build" && name !== "dist") output.push(...sourceFiles(path));
      continue;
    }
    if (/\.(?:[cm]?[jt]s|tsx)$/u.test(name)) output.push(path);
  }
  return output;
}

function rawQueryPlugin() {
  return {
    name: "lekh-policy-check-raw-query",
    setup(buildContext) {
      buildContext.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: join(args.resolveDir, args.path.replace(/\?raw$/, "")),
        namespace: "lekh-policy-raw"
      }));
      buildContext.onLoad({ filter: /.*/, namespace: "lekh-policy-raw" }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, "utf8"))};`,
        loader: "js"
      }));
    }
  };
}
