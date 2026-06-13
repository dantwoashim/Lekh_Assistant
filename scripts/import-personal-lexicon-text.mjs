#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const inputPath = args.get("input");
const outputPath = args.get("output") ?? join(ROOT, "data", "user-submitted", "redacted", "personal-dictionary-import.json");
const reportPath = args.get("report") ?? join(ROOT, "reports", "personal-lexicon-import-report.json");

if (!inputPath || !existsSync(inputPath)) {
  finish("failed", {
    reason: "missing input text file",
    usage: "node scripts/import-personal-lexicon-text.mjs --input /path/to/my-words.txt --output /path/to/import.json"
  }, 1);
}

const source = readFileSync(inputPath, "utf8").normalize("NFC");
const entries = extractEntries(source);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);

finish("passed", {
  input: inputPath,
  output: relative(ROOT, outputPath),
  entries: entries.length,
  policy: {
    optInFileOnly: true,
    noClipboardRead: true,
    noNotesScan: true,
    localOnly: true
  }
}, 0);

function extractEntries(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const columns = trimmed.split(/\t|,/).map((item) => item.trim()).filter(Boolean);
    const devanagari = columns.find((item) => /[\u0900-\u097F]/.test(item));
    if (!devanagari) {
      for (const token of trimmed.match(/[\u0900-\u097F]+/g) ?? []) addEntry(entries, token, []);
      continue;
    }
    const romanized = columns
      .filter((item) => item !== devanagari && /^[A-Za-z0-9 .,'/-]+$/.test(item))
      .map((item) => item.toLowerCase().replace(/\s+/g, " ").trim());
    addEntry(entries, devanagari, romanized);
  }
  for (const token of text.match(/[\u0900-\u097F]{2,}/g) ?? []) addEntry(entries, token, []);
  return [...entries.values()].sort((a, b) => a.word.localeCompare(b.word, "ne"));
}

function addEntry(entries, word, romanized) {
  const normalizedWord = String(word).trim().normalize("NFC");
  if (!normalizedWord || !/[\u0900-\u097F]/.test(normalizedWord)) return;
  if (hasInvalidDevanagariGrapheme(normalizedWord)) return;
  const key = normalizedWord;
  const now = new Date().toISOString();
  const existing = entries.get(key);
  const aliases = new Set([...(existing?.romanized ?? []), ...romanized.filter(Boolean)]);
  entries.set(key, {
    id: existing?.id ?? `import_${createHash("sha256").update(normalizedWord).digest("hex").slice(0, 16)}`,
    word: normalizedWord,
    romanized: [...aliases].slice(0, 8),
    domains: existing?.domains ?? [],
    source: "import",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    schemaVersion: 1
  });
}

function hasInvalidDevanagariGrapheme(value) {
  if (/[\u093E]\u0947|\u094B\u0947|\u093F\u0940|\u0947{2,}/.test(value)) return true;
  for (const token of String(value).split(/[\s।॥,;:!?()]+/)) {
    if (!token) continue;
    if (/^[\u093A-\u094D\u0951-\u0957\u0962-\u0963]/.test(token)) return true;
    if (/\u094D[\u093E-\u094C\u0962-\u0963]/.test(token)) return true;
  }
  return false;
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/import-personal-lexicon-text.mjs",
    suite: "personal-lexicon-import",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
