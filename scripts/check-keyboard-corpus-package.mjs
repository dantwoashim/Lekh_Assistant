import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const requiredGoldRows = production ? 3500 : 1;
const requiredGoldWords = production ? 3000 : 0;
const requiredGoldPhrases = production ? 500 : 0;
const requiredHumanRatedHoldoutRows = production ? 500 : 0;
const minRuntimeSourceK = 3;
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
const goldPromotions = readJsonl(path.join(CORPUS_DIR, "review", "v0.1", "gold_promotions.jsonl"));
const humanRatedHoldout = readJsonl(path.join(CORPUS_DIR, "review", "v0.1", "human_rated_holdout.jsonl"));
const calibrationReport = readJson(path.join(REPORTS_DIR, "confidence-calibration-report.json"));
const humanGoldCore = summarizeHumanGoldCore(goldPromotions);
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
if (production && humanGoldCore.words < requiredGoldWords) {
  violations.push({
    file: "data/keyboard-corpus/review/v0.1/gold_promotions.jsonl",
    reason: "production-human-gold-word-tier-too-small",
    requiredGoldWords,
    actualGoldWords: humanGoldCore.words
  });
}
if (production && humanGoldCore.phrases < requiredGoldPhrases) {
  violations.push({
    file: "data/keyboard-corpus/review/v0.1/gold_promotions.jsonl",
    reason: "production-human-gold-phrase-tier-too-small",
    requiredGoldPhrases,
    actualGoldPhrases: humanGoldCore.phrases
  });
}
if (production && humanRatedHoldout.length < requiredHumanRatedHoldoutRows) {
  violations.push({
    file: "data/keyboard-corpus/review/v0.1/human_rated_holdout.jsonl",
    reason: "production-human-rated-holdout-too-small",
    requiredHumanRatedHoldoutRows,
    actualHumanRatedHoldoutRows: humanRatedHoldout.length
  });
}
if (production && calibrationReport.status !== "passed") {
  violations.push({
    file: "data/keyboard-corpus/reports/confidence-calibration-report.json",
    reason: "production-confidence-calibration-not-passed"
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
const runtimePackViolations = validateRuntimePackFirewall(pack);
violations.push(...runtimePackViolations.map((violation) => ({
  file: "src/data/keyboard-packs/v0.1/runtime-suggestions.json",
  ...violation
})));

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
  requiredGoldWords,
  requiredGoldPhrases,
  requiredHumanRatedHoldoutRows,
  minRuntimeSourceK,
  fixtureCount: sources.length,
  sourceCount: sources.length,
  curatedRows: curation.counters ?? {},
  qualityCounts: curation.qualityCounts ?? {},
  humanReviewedGoldRows: curation.qualityCounts?.gold ?? 0,
  humanGoldCore,
  humanRatedHoldoutRows: humanRatedHoldout.length,
  confidenceCalibrationStatus: calibrationReport.status ?? "missing",
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
  runtimePackFirewall: {
    status: runtimePackViolations.length === 0 ? "passed" : "failed",
    violations: runtimePackViolations.slice(0, 100)
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

function summarizeHumanGoldCore(rows) {
  const summary = {
    words: 0,
    phrases: 0,
    names: 0,
    proofread: 0,
    other: 0,
    total: rows.length
  };
  for (const row of rows) {
    const dataset = String(row.dataset ?? "");
    if (dataset.includes("D1_word_aliases")) summary.words += 1;
    else if (dataset.includes("D2_phrase_aliases")) summary.phrases += 1;
    else if (dataset.includes("D6_name_surname_variants")) summary.names += 1;
    else if (dataset.includes("D5_proofread_error_corrections")) summary.proofread += 1;
    else summary.other += 1;
  }
  return summary;
}

function hasProcessTraceText(content) {
  const lower = content.toLowerCase();
  if (blockedPhraseTerms.some((phrase) => lower.includes(phrase))) return true;
  const tokens = lower.match(/[a-z0-9]+/g) ?? [];
  return tokens.some((token) => blockedTokenTerms.some((term) => token.includes(term)));
}

function validateRuntimePackFirewall(runtimePack) {
  const runtimeViolations = [];
  for (const key of ["words", "phrases", "names"]) {
    const rows = Array.isArray(runtimePack[key]) ? runtimePack[key] : [];
    const seenExact = new Set();
    const romanizedMap = new Map();
    rows.forEach((row, index) => {
      const romanized = normalizeRomanized(row?.romanized ?? "");
      const unicode = normalizeUnicode(row?.unicode ?? "");
      const location = `${key}[${index}]`;
      if (row?.romanized !== String(row?.romanized ?? "").normalize("NFC")) {
        runtimeViolations.push({ reason: "romanized-not-nfc", location });
      }
      if (row?.unicode !== String(row?.unicode ?? "").normalize("NFC")) {
        runtimeViolations.push({ reason: "unicode-not-nfc", location });
      }
      for (const reason of devanagariGraphemeFailures(unicode)) {
        runtimeViolations.push({ reason, location, unicode });
      }
      const exactKey = `${key}\0${romanized}\0${unicode}`;
      if (seenExact.has(exactKey)) runtimeViolations.push({ reason: "exact-duplicate-candidate", location, romanized, unicode });
      seenExact.add(exactKey);
      if (romanized && unicode) {
        const variants = romanizedMap.get(romanized) ?? new Set();
        variants.add(unicode);
        romanizedMap.set(romanized, variants);
      }
      for (const reason of privacyFirewallFailures(row)) {
        runtimeViolations.push({ reason, location, romanized, unicode });
      }
    });
    validateExplicitCandidateRanks(key, rows, romanizedMap, runtimeViolations);
  }
  for (const key of ["nextContexts", "proofread"]) {
    const rows = Array.isArray(runtimePack[key]) ? runtimePack[key] : [];
    rows.forEach((row, index) => {
      const location = `${key}[${index}]`;
      for (const reason of privacyFirewallFailures(row)) {
        runtimeViolations.push({ reason, location });
      }
    });
  }
  return runtimeViolations;
}

function validateExplicitCandidateRanks(key, rows, romanizedMap, runtimeViolations) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const romanized = normalizeRomanized(row?.romanized ?? "");
    const groupSize = romanizedMap.get(romanized)?.size ?? 0;
    if (groupSize <= 1) return;
    const group = groups.get(romanized) ?? [];
    group.push({ row, index, groupSize });
    groups.set(romanized, group);
  });
  for (const [romanized, group] of groups) {
    const expectedRanks = new Set();
    const expectedSize = group[0]?.groupSize ?? group.length;
    for (let rank = 1; rank <= expectedSize; rank += 1) expectedRanks.add(rank);
    const actualRanks = new Set();
    for (const { row, index } of group) {
      const location = `${key}[${index}]`;
      if (!Number.isInteger(row.candidateRank) || !expectedRanks.has(row.candidateRank)) {
        runtimeViolations.push({ reason: "invalid-candidate-rank", location, romanized, expectedSize });
      }
      if (row.candidateGroupSize !== expectedSize) {
        runtimeViolations.push({ reason: "invalid-candidate-group-size", location, romanized, expectedSize });
      }
      if (actualRanks.has(row.candidateRank)) {
        runtimeViolations.push({ reason: "duplicate-candidate-rank", location, romanized, candidateRank: row.candidateRank });
      }
      actualRanks.add(row.candidateRank);
    }
    for (const rank of expectedRanks) {
      if (!actualRanks.has(rank)) runtimeViolations.push({ reason: "missing-candidate-rank", romanized, rank });
    }
  }
}

function devanagariGraphemeFailures(value) {
  const failures = [];
  if (/[\u093E]\u0947|\u094B\u0947|\u093F\u0940|\u0947{2,}/.test(value)) {
    failures.push("malformed-devanagari-matra-sequence");
  }
  for (const token of String(value).split(/[\s।॥,;:!?()]+/)) {
    if (!token) continue;
    if (/^[\u093A-\u094D\u0951-\u0957\u0962-\u0963]/.test(token)) failures.push("orphan-devanagari-combining-mark");
    if (/\u094D[\u093E-\u094C\u0962-\u0963]/.test(token)) failures.push("virama-before-dependent-vowel");
    for (const cluster of token.split(/(?=[\u0915-\u0939\u0958-\u095F\u0978-\u097F])/u)) {
      if (!cluster) continue;
      const vowelSigns = cluster.match(/[\u093E-\u094C\u0962-\u0963]/g) ?? [];
      if (new Set(vowelSigns).size !== vowelSigns.length) failures.push("repeated-devanagari-vowel-sign");
      if (vowelSigns.length > 1 && !/\u094D/.test(cluster)) failures.push("conflicting-devanagari-vowel-signs");
    }
  }
  return [...new Set(failures)];
}

function normalizeRomanized(value) {
  return String(value).toLowerCase().trim().replace(/\s+/g, " ").normalize("NFC");
}

function normalizeUnicode(value) {
  return String(value).trim().normalize("NFC");
}

function privacyFirewallFailures(row) {
  const failures = [];
  if (row?.learned === true || row?.private === true || row?.userGenerated === true) {
    failures.push("runtime-private-source-row");
  }
  const sourceText = [
    row?.source,
    row?.sourceType,
    row?.origin,
    row?.provenance,
    row?.reviewStatus
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/\b(user|personal|private|clipboard|notes|import|learned|local-lexicon|diagnostic)\b/.test(sourceText)) {
    failures.push("runtime-private-source-row");
  }
  for (const key of ["distinctSourceCount", "sourceCount", "sourceK", "kAnonymity", "kAnonymousCount"]) {
    if (!(key in row)) continue;
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0 && value < minRuntimeSourceK) {
      failures.push("runtime-source-k-anonymity-too-low");
    }
  }
  const text = [
    row?.romanized,
    row?.unicode,
    row?.context,
    row?.next,
    row?.error,
    row?.correction
  ]
    .filter((value) => typeof value === "string")
    .join(" ");
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) ||
      /\b(?:\+?977[-\s]?)?(?:98|97)\d{8}\b/.test(text) ||
      /\b\d{6,}\b/.test(text) ||
      /\b(?:otp|pin|pan|password|passcode)[:=\s-]+[a-z0-9]{3,}\b/i.test(text) ||
      /\b[a-z]{2,}\d{3,}[a-z0-9]*\b/i.test(text)) {
    failures.push("runtime-personal-token-like-row");
  }
  return [...new Set(failures)];
}
