#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { readJson, sha256File } from "./token-completion-lib.mjs";

const ROOT = process.cwd();
const startedAt = performance.now();
const registryPath = join(ROOT, "data/completion/v1/source-registry.json");
const seedsPath = join(ROOT, "data/completion/v1/token-completion-seeds.json");
const dispositionsPath = join(ROOT, "data/completion/quarantine/source-dispositions.v1.json");
const reportPath = join(ROOT, "reports/token-completion-source-audit.json");
const failures = [];

for (const path of [registryPath, seedsPath, dispositionsPath]) {
  if (!existsSync(path)) failures.push(`Missing completion policy input: ${relative(ROOT, path)}.`);
}

const registry = failures.length === 0 ? readJson(registryPath) : {};
const seeds = failures.length === 0 ? readJson(seedsPath) : {};
const quarantine = failures.length === 0 ? readJson(dispositionsPath) : {};
if (registry.schemaVersion !== 1 || seeds.schemaVersion !== 1 || quarantine.schemaVersion !== 1) {
  failures.push("Completion registry, seeds, and quarantine policy must all use schemaVersion 1.");
}
if (registry.registryId !== "lekh-token-completion-sources-v1" ||
    quarantine.policyId !== "lekh-token-completion-quarantine-v1") {
  failures.push("Completion registry or quarantine policy id is invalid.");
}
const eligibleSources = new Set(
  (registry.sources ?? [])
    .filter((source) => source.runtimeEligible === true && source.redistributionAllowed === true)
    .map((source) => source.id)
);
if (!eligibleSources.has(seeds.sourceId)) failures.push("Completion seeds do not reference an eligible source registry row.");
for (const source of registry.sources ?? []) {
  if (source.runtimeEligible !== true) continue;
  if (source.id !== "lekh-repository-curated-completion-v1" ||
      source.origin !== "repository-authored" ||
      source.path !== "data/completion/v1/token-completion-seeds.json" ||
      source.license !== "MIT" ||
      source.allowedUse !== "explicit-single-token-completion" ||
      source.reviewTier !== "repository-curated-regression" ||
      source.humanRated !== false ||
      source.redistributionAllowed !== true) {
    failures.push(`Runtime-eligible completion source has an invalid provenance contract: ${source.id ?? "missing"}.`);
  }
  const sourcePath = join(ROOT, source.path ?? "");
  if (!existsSync(sourcePath)) failures.push(`Runtime-eligible completion source is missing: ${source.path ?? "missing"}.`);
}
const repositoryLicensePath = join(ROOT, "LICENSE");
if (!existsSync(repositoryLicensePath) ||
    !readFileSync(repositoryLicensePath, "utf8").startsWith("MIT License")) {
  failures.push("Repository-authored completion seeds require the repository MIT license evidence.");
}

const dispositionPaths = new Set();
for (const disposition of quarantine.dispositions ?? []) {
  const absolute = join(ROOT, disposition.path ?? "");
  if (!disposition.path || dispositionPaths.has(disposition.path)) failures.push(`Duplicate or missing quarantine path: ${disposition.path ?? "missing"}.`);
  dispositionPaths.add(disposition.path);
  // Quarantined corpora are intentionally allowed to be absent from a
  // distributable checkout; only runtime-eligible sources must be present.
  if (!Array.isArray(disposition.reasons) || disposition.reasons.length === 0) failures.push(`Quarantine row has no reasons: ${disposition.path}.`);
  if (String(disposition.status).includes("eligible")) failures.push(`Quarantine row may not be runtime eligible: ${disposition.path}.`);
}

const runtimePath = join(ROOT, "src/data/keyboard-packs/v0.1/runtime-suggestions.json");
const canonicalPath = join(ROOT, "data/engine/lekh-token-candidates.v1.json");
const runtime = existsSync(runtimePath) ? readJson(runtimePath) : {};
const canonical = existsSync(canonicalPath) ? readJson(canonicalPath) : {};
const curatedStats = {};
for (const disposition of quarantine.dispositions ?? []) {
  if (!String(disposition.path).endsWith(".jsonl")) continue;
  const absolute = join(ROOT, disposition.path);
  if (!existsSync(absolute)) continue;
  const rows = readFileSync(absolute, "utf8").split(/\r?\n/).filter(Boolean);
  let invalidJsonRows = 0;
  let externalRows = 0;
  let nonGoldRows = 0;
  let phraseLikeRows = 0;
  for (const line of rows) {
    try {
      const row = JSON.parse(line);
      if ((row.sourceIds ?? []).some((id) => String(id).startsWith("hf-")) || String(row.sourcePlatform ?? "").includes("youtube")) externalRows += 1;
      if (!String(row.quality ?? "").toLowerCase().includes("gold")) nonGoldRows += 1;
      const romanized = String(row.romanized ?? row.context ?? row.text ?? row.input ?? "");
      if (/\s/u.test(romanized.trim())) phraseLikeRows += 1;
    } catch {
      invalidJsonRows += 1;
    }
  }
  curatedStats[disposition.path] = { rows: rows.length, invalidJsonRows, externalRows, nonGoldRows, phraseLikeRows };
  if (invalidJsonRows > 0) failures.push(`${disposition.path} contains invalid JSONL rows.`);
}

const runtimeRows = [
  ...(runtime.words ?? []), ...(runtime.phrases ?? []), ...(runtime.names ?? [])
];
const runtimeRowsMissingProvenance = runtimeRows.filter((row) =>
  !row.sourceId || !row.license || !row.reviewTier
).length;
const report = {
  generatedAt: new Date().toISOString(),
  command: "node scripts/audit-token-completion-sources.mjs",
  suite: "token-completion-source-audit",
  durationMs: Math.round(performance.now() - startedAt),
  status: failures.length === 0 ? "passed-quarantine-enforced" : "failed",
  eligibleCompletionSources: [...eligibleSources].sort(),
  seedSourceId: seeds.sourceId ?? null,
  seedRows: seeds.rows?.length ?? 0,
  quarantinedSourceCount: quarantine.dispositions?.length ?? 0,
  contaminationInventory: {
    bundledRuntimePack: {
      path: relative(ROOT, runtimePath),
      sha256: existsSync(runtimePath) ? sha256File(runtimePath) : null,
      words: runtime.words?.length ?? 0,
      phrases: runtime.phrases?.length ?? 0,
      names: runtime.names?.length ?? 0,
      proofread: runtime.proofread?.length ?? 0,
      nextContexts: runtime.nextContexts?.length ?? 0,
      rowsMissingCompletionProvenance: runtimeRowsMissingProvenance,
      disposition: "quarantined-from-token-completion"
    },
    canonicalTokenContract: {
      path: relative(ROOT, canonicalPath),
      sha256: existsSync(canonicalPath) ? sha256File(canonicalPath) : null,
      rows: canonical.rows?.length ?? 0,
      productionGold: canonical.productionGold === true,
      disposition: "evidence-only-for-token-completion"
    },
    curatedStats
  },
  policy: {
    copiedRawData: false,
    directSocialRowsAllowed: false,
    phraseRowsAllowed: false,
    nameRowsAllowed: false,
    missingRowProvenanceAllowed: false,
    onlyExplicitRegistrySourcesAllowed: true
  },
  failures
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exit(1);
