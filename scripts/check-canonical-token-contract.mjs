#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = process.cwd();
const packPath = join(root, "data", "engine", "lekh-token-candidates.v1.json");
const enginePath = join(root, "native", "macos-imk", "skeleton", "LekhEngineCore.swift");
const browserPath = join(root, "src", "engine", "keyboard", "candidates.ts");
const packagePath = join(root, "scripts", "package-macos-imk-dev.mjs");
const reportPath = join(root, "reports", "canonical-token-contract-report.json");
const failures = [];
const source = readFileSync(packPath, "utf8");
const pack = JSON.parse(source);
const engine = readFileSync(enginePath, "utf8");
const browser = readFileSync(browserPath, "utf8");
const packager = readFileSync(packagePath, "utf8");

if (pack.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (pack.scope !== "single-active-token") failures.push("scope must be single-active-token");
if (pack.productionGold !== false) failures.push("repository-curated rows must not claim production gold");
if (pack.reviewTier !== "repository-curated-contract") failures.push("reviewTier must remain honest and explicit");
if (!Array.isArray(pack.rows) || pack.rows.length < 80) failures.push("shared token pack must contain at least 80 inputs");

const inputs = new Set();
let outputs = 0;
for (const [index, row] of (pack.rows ?? []).entries()) {
  const location = `rows[${index}]`;
  if (!/^[a-z][a-z'-]*$/u.test(row.input ?? "")) failures.push(`${location}.input is not a normalized Romanized token`);
  if (inputs.has(row.input)) failures.push(`${location}.input duplicates ${row.input}`);
  inputs.add(row.input);
  if (!Array.isArray(row.outputs) || row.outputs.length === 0 || row.outputs.length > 8) {
    failures.push(`${location}.outputs must contain 1...8 candidates`);
    continue;
  }
  const candidateTexts = new Set();
  let previousConfidence = Infinity;
  for (const [outputIndex, output] of row.outputs.entries()) {
    const outputLocation = `${location}.outputs[${outputIndex}]`;
    outputs += 1;
    if (typeof output.text !== "string" || !/[\u0900-\u097f]/u.test(output.text)) {
      failures.push(`${outputLocation}.text must contain Devanagari`);
    }
    if (/\s/u.test(output.text ?? "")) failures.push(`${outputLocation}.text must remain one token`);
    if (/[A-Za-z]/u.test(output.text ?? "")) failures.push(`${outputLocation}.text must not mix Latin output`);
    if (output.text?.normalize("NFC") !== output.text) failures.push(`${outputLocation}.text must be NFC`);
    if (candidateTexts.has(output.text)) failures.push(`${outputLocation}.text duplicates ${output.text}`);
    candidateTexts.add(output.text);
    if (!Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1) {
      failures.push(`${outputLocation}.confidence must be within 0...1`);
    }
    if (output.confidence > previousConfidence) failures.push(`${location}.outputs must be confidence-descending`);
    previousConfidence = output.confidence;
  }
}

for (const required of ["timi", "tapai", "ramro", "pani", "dhanyabad", "sanchai", "swasthya", "kathmandu"]) {
  if (!inputs.has(required)) failures.push(`missing required regression token ${required}`);
}
if (!engine.includes("lekh-token-candidates.v1")) failures.push("Swift engine does not load the shared token pack");
if (!engine.includes("LEKH_TEST_CANONICAL_TOKEN_PACK_PATH")) failures.push("Swift behavior probe override is missing");
if (!browser.includes('lekh-token-candidates.v1.json')) failures.push("TypeScript engine does not import the shared token pack");
const legacyBlock = browser.match(/const legacyRows:[\s\S]*?\n\s*\];/u)?.[0] ?? "";
for (const match of legacyBlock.matchAll(/input:\s*"([^"]+)"/gu)) {
  if (!match[1].includes(" ") && inputs.has(match[1])) {
    failures.push(`TypeScript legacyRows duplicates shared active token ${match[1]}`);
  }
}
if (!packager.includes("tokenCandidateBundlePath")) failures.push("macOS packager does not bundle the shared token pack");

const report = {
  generatedAt: new Date().toISOString(),
  command: "node scripts/check-canonical-token-contract.mjs",
  suite: "canonical-token-contract",
  status: failures.length === 0 ? "passed" : "failed",
  pack: relative(root, packPath),
  sha256: createHash("sha256").update(source).digest("hex"),
  reviewTier: pack.reviewTier,
  productionGold: pack.productionGold,
  inputRows: inputs.size,
  candidateOutputs: outputs,
  consumers: [relative(root, enginePath), relative(root, browserPath)],
  failures
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
