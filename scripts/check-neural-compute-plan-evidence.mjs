#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { validateNeuralComputePlanEvidence } from "./lib/neural-compute-plan-evidence.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const production = args.has("production");
const evidencePath = args.get("evidence") ?? join(root, "reports", "neural-compute-plan-evidence.json");
const manifestPath = args.get("manifest") ?? join(root, "models", "macos", "LekhNeuralTransliterator.manifest.json");
const reportPath = args.get("report") ?? join(root, "reports", "neural-compute-plan-validation.json");
const expectedArchitecture = args.get("architecture") ??
  (process.arch === "x64" ? "x86_64" : process.arch);

let evidence;
let manifest;
try {
  evidence = readJsonFile(evidencePath, 2 * 1024 * 1024);
  manifest = readJsonFile(manifestPath, 2 * 1024 * 1024);
} catch (error) {
  console.error(JSON.stringify({
    status: "failed-neural-compute-plan-evidence-input",
    failure: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
}

const validation = validateNeuralComputePlanEvidence(evidence, {
  expectedArchitecture,
  manifest,
  production
});
const status = validation.valid
  ? validation.neuralEngineClaimAllowed
    ? "passed-neural-engine-compute-plan"
    : validation.deterministicFallbackProven
      ? "passed-intel-neural-fallback-compute-plan"
      : validation.environmentCapabilityLimited
        ? "passed-experimental-compute-plan-environment-lacks-neural-engine"
      : "passed-experimental-compute-plan-neural-engine-not-preferred"
  : production
    ? "failed-production-neural-compute-plan"
    : "failed-neural-compute-plan";
const report = {
  schemaVersion: 1,
  recordType: "lekh-neural-compute-plan-validation",
  generatedAt: new Date().toISOString(),
  status,
  production,
  evidence: relative(root, evidencePath),
  manifest: relative(root, manifestPath),
  expectedArchitecture,
  neuralEngineClaimAllowed: validation.neuralEngineClaimAllowed,
  deterministicFallbackProven: validation.deterministicFallbackProven,
  environmentCapabilityLimited: validation.environmentCapabilityLimited,
  issueCodes: validation.issueCodes,
  warnings: validation.warnings
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!validation.valid) process.exit(1);

function readJsonFile(path, maximumBytes) {
  if (!existsSync(path)) throw new Error(`Missing JSON input: ${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 ||
      metadata.size > maximumBytes) throw new Error(`Unsafe JSON input: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : "1";
    values.set(key, value);
    if (value !== "1") index += 1;
  }
  return values;
}
