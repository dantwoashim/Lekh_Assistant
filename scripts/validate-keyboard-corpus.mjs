import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, "data", "keyboard-corpus");
const GENERATED_DIR = path.join(CORPUS_DIR, "generated");
const REPORT_PATH = path.join(CORPUS_DIR, "reports", "keyboard-corpus-build-report.json");
const CURATION_REPORT_PATH = path.join(CORPUS_DIR, "reports", "keyboard-corpus-curation-report.json");

const FILES = {
  wordAliases: "word-aliases.auto-reviewed.jsonl",
  phraseAliases: "phrase-aliases.auto-reviewed.jsonl",
  casualSentences: "casual-romanized-sentences.pii-screened.jsonl",
  mixedSentences: "mixed-nepali-english-sentences.pii-screened.jsonl",
  proofreadPairs: "proofread-error-corrections.synthetic-silver.jsonl",
  nameVariants: "name-surname-variants.synthetic-silver.jsonl",
  nextWordContexts: "next-word-phrase-contexts.auto-reviewed.jsonl",
  blindTest: "frozen-blind-test.v1.jsonl",
};

const SOCIAL_METADATA_PATTERNS = [
  /\bpublished\s+by\b/i,
  /\bsinger\b/i,
  /\blyrics?\b/i,
  /\balbum\b/i,
  /\brecordings?\b/i,
  /\bcomposer\b/i,
  /\bofficial\b/i,
  /\bsubscribe\b/i,
  /\b[A-Za-z][A-Za-z]+_[A-Za-z][A-Za-z]+\b/,
];

const BLOCKED_LOCAL_IDENTITY_PATTERNS = [
  /\brohan\s+basnet\b/i,
  /रोहन\s+बस्नेत/u,
];

const PII_PATTERNS = [
  /https?:\/\/\S+/i,
  /www\.\S+/i,
  /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
  /\+?\d[\d\s().-]{7,}\d/,
];

const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
const summary = {
  generatedAt: new Date().toISOString(),
  buildReportGeneratedAt: report.generatedAt,
  files: {},
  curation: undefined,
  violations: [],
};

for (const [key, filename] of Object.entries(FILES)) {
  const file = path.join(GENERATED_DIR, filename);
  if (!fs.existsSync(file)) {
    summary.violations.push({ file: filename, reason: "missing-file" });
    continue;
  }

  let count = 0;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      summary.violations.push({ file: filename, line: index + 1, reason: "invalid-json", detail: error.message });
      continue;
    }
    count += 1;
    for (const value of extractUserTextFields(row)) {
      validateTextValue({ file: filename, line: index + 1, value });
    }
  }

  const target = report.targets?.[key] || 0;
  summary.files[key] = {
    file: filename,
    count,
    target,
    status: count >= target ? "met" : "short",
  };
  if (count < target) {
    summary.violations.push({ file: filename, reason: "target-short", count, target });
  }
}

validateCurationLayer();

const outPath = path.join(CORPUS_DIR, "reports", "keyboard-corpus-validation-report.json");
fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log(JSON.stringify(summary, null, 2));
if (summary.violations.length > 0) process.exit(1);

function validateCurationLayer() {
  if (!fs.existsSync(CURATION_REPORT_PATH)) {
    summary.violations.push({ file: "keyboard-corpus-curation-report.json", reason: "missing-curation-report" });
    return;
  }
  const curation = JSON.parse(fs.readFileSync(CURATION_REPORT_PATH, "utf8"));
  summary.curation = {
    generatedAt: curation.generatedAt,
    leakageAudit: curation.leakageAudit,
    reviewQueueRows: curation.reviewQueueRows,
    goldPromotions: curation.goldPromotions,
    runtimePackDir: curation.runtimePackDir,
    bundledRuntimePack: curation.bundledRuntimePack,
  };
  if (curation.leakageAudit?.status !== "passed") {
    summary.violations.push({ file: "keyboard-corpus-curation-report.json", reason: "leakage-audit-not-passed" });
  }
  for (const required of [
    "sources.jsonl",
    "curated/v0.1/D8_blind_v0.1.jsonl",
    "quarantine/raw-sources.jsonl",
    "review/v0.1/review_queue.jsonl",
    "review/v0.1/gold_promotions.jsonl",
    "runtime/v0.1/manifest.json",
    "../src/data/keyboard-packs/v0.1/runtime-suggestions.json",
  ]) {
    const file = required.startsWith("../src/")
      ? path.join(ROOT, required.replace("../", ""))
      : path.join(CORPUS_DIR, required);
    if (!fs.existsSync(file)) {
      summary.violations.push({ file: required, reason: "missing-curation-artifact" });
    }
  }
}

function validateTextValue({ file, line, value }) {
  const text = String(value || "");
  if (!text) return;
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(text)) {
      summary.violations.push({ file, line, reason: "pii-like-text", value: truncate(text) });
      return;
    }
  }
  if (isSentenceDataset(file)) {
    for (const pattern of SOCIAL_METADATA_PATTERNS) {
      if (pattern.test(text)) {
        summary.violations.push({ file, line, reason: "social-metadata-like-text", value: truncate(text) });
        return;
      }
    }
  }
  for (const pattern of BLOCKED_LOCAL_IDENTITY_PATTERNS) {
    if (pattern.test(text)) {
      summary.violations.push({ file, line, reason: "blocked-local-identity", value: truncate(text) });
      return;
    }
  }
}

function isSentenceDataset(file) {
  return file.includes("casual-romanized-sentences") || file.includes("mixed-nepali-english-sentences");
}

function extractUserTextFields(row) {
  const values = [];
  collect(row, values, new Set());
  return values;
}

function collect(value, values, seen) {
  if (value == null) return;
  if (typeof value === "string") {
    values.push(value);
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collect(item, values, seen);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isMetadataKey(key)) continue;
    collect(item, values, seen);
  }
}

function isMetadataKey(key) {
  return [
    "id",
    "sourceId",
    "sourceRowId",
    "sourcePlatform",
    "license",
    "reviewStatus",
    "sourceId",
    "splitSeed",
    "frozenAt",
    "reusable",
    "privacy",
  ].includes(key);
}

function truncate(value) {
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}
