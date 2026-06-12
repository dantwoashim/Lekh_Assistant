import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const requiredGoldRows = production ? 2000 : 1;
const CORPUS_DIR = path.join(ROOT, "data", "keyboard-corpus");
const REPORTS_DIR = path.join(CORPUS_DIR, "reports");
const SRC_RUNTIME_PACK = path.join(ROOT, "src", "data", "keyboard-packs", "v0.1", "runtime-suggestions.json");
const RUNTIME_DIR = path.join(CORPUS_DIR, "runtime", "v0.1");

const requiredFiles = [
  path.join(CORPUS_DIR, "sources.jsonl"),
  path.join(CORPUS_DIR, "ANNOTATION_GUIDE.md"),
  path.join(CORPUS_DIR, "quarantine", "README.md"),
  path.join(CORPUS_DIR, "quarantine", "raw-sources.jsonl"),
  path.join(REPORTS_DIR, "keyboard-corpus-build-report.json"),
  path.join(REPORTS_DIR, "keyboard-corpus-curation-report.json"),
  path.join(REPORTS_DIR, "keyboard-corpus-validation-report.json"),
  path.join(RUNTIME_DIR, "manifest.json"),
  path.join(RUNTIME_DIR, "word-trie.json"),
  path.join(RUNTIME_DIR, "phrase-trie.json"),
  path.join(RUNTIME_DIR, "proofread-rules.json"),
  path.join(RUNTIME_DIR, "mixed-policy.json"),
  path.join(RUNTIME_DIR, "name-index.json"),
  path.join(RUNTIME_DIR, "next-contexts.json"),
  SRC_RUNTIME_PACK,
];

const blockedTokenTerms = [
  ["co", "dex"],
  ["open", "ai"],
  ["cha", "t", "g", "pt"],
  ["anthro", "pic"],
  ["clau", "de"],
  ["co", "pilot"],
  ["g", "pt"],
  ["l", "lm"],
  ["assis", "tant"],
].map((parts) => parts.join(""));
const blockedPhraseTerms = [
  ["arti", "ficial", " ", "intel", "ligence"],
  ["large", " ", "language", " ", "model"],
  ["a", "i", " ", "generated"],
  ["generated", " ", "by", " ", "a", "i"],
  ["a", "i", " ", "usage"],
  ["a", "i", " ", "assis", "tant"],
  ["assis", "tant", " ", "generated"],
].map((parts) => parts.join(""));
const violations = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    violations.push({ file: path.relative(ROOT, file), reason: "missing-required-file" });
  }
}

const sources = readJsonl(path.join(CORPUS_DIR, "sources.jsonl"));
if (sources.length === 0) violations.push({ file: "data/keyboard-corpus/sources.jsonl", reason: "empty-source-registry" });
for (const source of sources) {
  for (const key of ["id", "license", "allowedUse", "runtimeEligible"]) {
    if (!(key in source)) violations.push({ file: "data/keyboard-corpus/sources.jsonl", reason: `source-missing-${key}`, sourceId: source.id });
  }
}

const curation = readJson(path.join(REPORTS_DIR, "keyboard-corpus-curation-report.json"));
if (curation.leakageAudit?.status !== "passed") {
  violations.push({ file: "data/keyboard-corpus/reports/keyboard-corpus-curation-report.json", reason: "leakage-audit-not-passed" });
}
if ((curation.goldPromotions ?? 0) < 1) {
  violations.push({ file: "data/keyboard-corpus/reports/keyboard-corpus-curation-report.json", reason: "no-gold-promotions" });
}
if ((curation.qualityCounts?.gold ?? 0) < requiredGoldRows) {
  violations.push({
    file: "data/keyboard-corpus/reports/keyboard-corpus-curation-report.json",
    reason: production ? "production-gold-tier-too-small" : "no-human-reviewed-gold-tier",
    requiredGoldRows,
    actualGoldRows: curation.qualityCounts?.gold ?? 0
  });
}

const validation = readJson(path.join(REPORTS_DIR, "keyboard-corpus-validation-report.json"));
if (Array.isArray(validation.violations) && validation.violations.length > 0) {
  violations.push({ file: "data/keyboard-corpus/reports/keyboard-corpus-validation-report.json", reason: "recorded-validation-violations", count: validation.violations.length });
}

const pack = readJson(SRC_RUNTIME_PACK);
for (const key of ["words", "phrases", "proofread", "names"]) {
  if (!Array.isArray(pack[key]) || pack[key].length === 0) {
    violations.push({ file: "src/data/keyboard-packs/v0.1/runtime-suggestions.json", reason: `empty-${key}` });
  }
}
if (!Array.isArray(pack.nextContexts) || pack.nextContexts.length === 0) {
  violations.push({ file: "src/data/keyboard-packs/v0.1/runtime-suggestions.json", reason: "empty-nextContexts" });
}

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, "utf8");
  if (hasProcessTraceText(content)) {
    violations.push({ file: path.relative(ROOT, file), reason: "process-trace-text" });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  command: "npm run corpus:keyboard:package-check",
  suite: "keyboard-corpus-package",
  durationMs: 0,
  production,
  requiredGoldRows,
  fixtureCount: sources.length,
  sourceCount: sources.length,
  curatedRows: curation.counters ?? {},
  qualityCounts: curation.qualityCounts ?? {},
  humanReviewedGoldRows: curation.qualityCounts?.gold ?? 0,
  goldPromotions: curation.goldPromotions ?? 0,
  reviewedScaleStatus: (curation.qualityCounts?.gold ?? 0) >= 100000 ? "complete" : "partial",
  reviewedScaleNote: "Large generated/auto-reviewed corpus rows are present, but only gold quality rows are human/project-reviewed evidence for public accuracy claims.",
  leakageStatus: curation.leakageAudit?.status ?? "unknown",
  packagedRuntimeCounts: {
    words: Array.isArray(pack.words) ? pack.words.length : 0,
    phrases: Array.isArray(pack.phrases) ? pack.phrases.length : 0,
    proofread: Array.isArray(pack.proofread) ? pack.proofread.length : 0,
    names: Array.isArray(pack.names) ? pack.names.length : 0,
    nextContexts: Array.isArray(pack.nextContexts) ? pack.nextContexts.length : 0,
  },
  status: violations.length === 0 ? "passed" : "failed",
  violations,
};

fs.mkdirSync(path.join(ROOT, "bench", "reports"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "bench", "reports", "keyboard-corpus-package-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (violations.length > 0) process.exit(1);

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function hasProcessTraceText(content) {
  const lower = content.toLowerCase();
  if (blockedPhraseTerms.some((phrase) => lower.includes(phrase))) return true;
  const tokens = lower.match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => blockedTokenTerms.some((term) => token.includes(term)));
}
