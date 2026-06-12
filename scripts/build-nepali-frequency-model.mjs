#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const startedAt = performance.now();
const outputDir = join(ROOT, "data", "generated", "frequency");
const reportPath = join(ROOT, "reports", "nepali-frequency-model-report.json");
const unigramPath = join(outputDir, "lekh-unigram-frequency.tsv");
const bigramPath = join(outputDir, "lekh-bigram-frequency.tsv");
const args = parseArgs(process.argv.slice(2));
const maxUnigrams = positiveIntArg(args["max-unigrams"], 250_000);
const maxBigrams = positiveIntArg(args["max-bigrams"], 250_000);

const sources = [
  {
    id: "nepali-wikipedia-frequency",
    kind: "precomputed-unigram",
    path: join(ROOT, "data", "generated", "frequency", "nepali-wikipedia-frequency.tsv")
  },
  {
    id: "dictionary-ne-ranked",
    kind: "precomputed-unigram",
    path: join(ROOT, "data", "generated", "wordlists", "dictionary-ne-ranked.tsv")
  },
  {
    id: "keyboard-curated-corpus",
    kind: "text-tree",
    path: join(ROOT, "data", "keyboard-corpus", "curated", "v0.1")
  },
  {
    id: "keyboard-generated-corpus",
    kind: "text-tree",
    path: join(ROOT, "data", "keyboard-corpus", "generated")
  },
  {
    id: "local-reviewed-raw-corpus",
    kind: "text-tree",
    path: join(ROOT, "data", "keyboard-corpus", "quarantine", "raw")
  }
];

const unigrams = new Map();
const bigrams = new Map();
const sourceReports = [];

for (const source of sources) {
  if (!existsSync(source.path)) {
    sourceReports.push({ id: source.id, path: relative(ROOT, source.path), status: "missing", tokens: 0, rows: 0 });
    continue;
  }
  if (source.kind === "precomputed-unigram") {
    const rows = parsePrecomputedUnigrams(readFileSync(source.path, "utf8"));
    for (const row of rows) add(unigrams, row.word, row.frequency);
    sourceReports.push({ id: source.id, path: relative(ROOT, source.path), status: "loaded", rows: rows.length, tokens: 0 });
    continue;
  }
  const files = listCorpusFiles(source.path);
  let tokenCount = 0;
  for (const file of files) {
    const tokens = devangariTokens(extractText(readFileSync(file, "utf8"), extname(file)));
    tokenCount += tokens.length;
    for (const token of tokens) add(unigrams, token, 1);
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      add(bigrams, `${tokens[index]} ${tokens[index + 1]}`, 1);
    }
  }
  sourceReports.push({ id: source.id, path: relative(ROOT, source.path), status: "loaded", files: files.length, tokens: tokenCount });
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(unigramPath, toTsv("word", unigrams, "lekh-frequency-model"));
writeFileSync(bigramPath, toTsv("bigram", bigrams, "lekh-frequency-model", maxBigrams));
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  reportPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      command: "node scripts/build-nepali-frequency-model.mjs",
      suite: "nepali-frequency-model",
      durationMs: Math.round(performance.now() - startedAt),
      status: "passed",
      outputs: {
        unigrams: relative(ROOT, unigramPath),
        bigrams: relative(ROOT, bigramPath)
      },
      counts: {
        unigrams: unigrams.size,
        bigrams: bigrams.size,
        writtenUnigrams: Math.min(unigrams.size, maxUnigrams),
        writtenBigrams: Math.min(bigrams.size, maxBigrams)
      },
      sources: sourceReports,
      note: "External corpora such as OSCAR-ne, NepBERTa, Kantipur, and Setopati must be dropped into reviewed local source paths after license/privacy review; this script will ingest local text/jsonl/tsv drops without network access."
    },
    null,
    2
  )}\n`
);

console.log(JSON.stringify({
  status: "passed",
  unigrams: relative(ROOT, unigramPath),
  bigrams: relative(ROOT, bigramPath),
  counts: { unigrams: unigrams.size, bigrams: bigrams.size },
  written: {
    unigrams: Math.min(unigrams.size, maxUnigrams),
    bigrams: Math.min(bigrams.size, maxBigrams)
  },
  report: relative(ROOT, reportPath)
}, null, 2));

function parsePrecomputedUnigrams(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  const wordIndex = header.indexOf("word");
  const frequencyIndexes = [
    header.indexOf("wikipediaFrequency"),
    header.indexOf("frequency"),
    header.indexOf("count")
  ].filter((index) => index >= 0);
  if (wordIndex < 0 || frequencyIndexes.length === 0) return [];

  const rows = [];
  for (const line of lines.slice(1)) {
    const columns = line.split("\t");
    const word = normalizeToken(columns[wordIndex] ?? "");
    if (!isValidToken(word)) continue;
    const frequency = Math.max(
      ...frequencyIndexes.map((index) => Number(columns[index] ?? 0)).filter((value) => Number.isFinite(value))
    );
    if (!Number.isFinite(frequency) || frequency <= 0) continue;
    rows.push({ word, frequency });
  }
  return rows;
}

function listCorpusFiles(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return supportedFile(path) ? [path] : [];
  const output = [];
  for (const entry of readdirSync(path)) {
    output.push(...listCorpusFiles(join(path, entry)));
  }
  return output;
}

function supportedFile(path) {
  return [".txt", ".jsonl", ".json", ".tsv", ".csv"].includes(extname(path).toLowerCase()) && basename(path) !== ".gitignore";
}

function extractText(text, extension) {
  if (extension === ".jsonl") {
    return text
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) return "";
        try {
          return flattenJsonText(JSON.parse(line)).join(" ");
        } catch {
          return line;
        }
      })
      .join(" ");
  }
  if (extension === ".json") {
    try {
      return flattenJsonText(JSON.parse(text)).join(" ");
    } catch {
      return text;
    }
  }
  return text;
}

function flattenJsonText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenJsonText);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenJsonText);
  return [];
}

function devangariTokens(text) {
  return (text.match(/[\u0900-\u097F]+/g) ?? []).map(normalizeToken).filter(isValidToken);
}

function normalizeToken(token) {
  return token.normalize("NFC").replace(/[।॥]+$/g, "").trim();
}

function isValidToken(token) {
  if (token.length < 2 || token.length > 40) return false;
  if (!/^[\u0900-\u097F]+$/.test(token)) return false;
  if (/^[०-९]+$/.test(token)) return false;
  return true;
}

function add(map, key, amount) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function toTsv(keyName, map, sourceId, limit = maxUnigrams) {
  const rows = [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ne"))
    .slice(0, limit)
    .map(([key, frequency]) => `${key}\t${frequency}\tcommon\t${sourceId}`);
  return [`${keyName}\tfrequency\tdomain\tsource`, ...rows, ""].join("\n");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    parsed[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function positiveIntArg(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected positive integer, received ${value}`);
  }
  return parsed;
}
