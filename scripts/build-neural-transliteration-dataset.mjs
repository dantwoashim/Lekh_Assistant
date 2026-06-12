#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const runtimePackPath = args.get("runtime-pack") ?? join(ROOT, "release", "native", "macos", "runtime-suggestions.sanitized.json");
const dictionaryPath = args.get("dictionary-ranked") ?? join(ROOT, "data", "generated", "wordlists", "dictionary-ne-ranked.tsv");
const dakshinaPath = args.get("dakshina-tsv");
const outDir = args.get("out-dir") ?? join(ROOT, "data", "generated", "neural-transliteration");
const reportPath = args.get("report") ?? join(ROOT, "reports", "neural-transliteration-dataset-report.json");

const manualPairs = [
  ["vato", "बाटो", "manual-chat-tail"],
  ["bato", "बाटो", "manual-chat-tail"],
  ["baato", "बाटो", "manual-chat-tail"],
  ["chha", "छ", "manual-chat-tail"],
  ["cha", "छ", "manual-chat-tail"],
  ["xa", "छ", "manual-chat-tail"],
  ["xaina", "छैन", "manual-chat-tail"],
  ["xau", "छौ", "manual-chat-tail"],
  ["xu", "छु", "manual-chat-tail"],
  ["xan", "छन्", "manual-chat-tail"],
  ["xas", "छस्", "manual-chat-tail"],
  ["xetra", "क्षेत्र", "manual-x-ksha"],
  ["niraj", "निरज", "manual-name"],
  ["niraj", "नीरज", "manual-name"],
  ["thapera", "थपेर", "manual-ambiguity"],
  ["thapera", "थापेर", "manual-ambiguity"]
];

try {
  const pairs = new Map();
  const countsBySource = {};
  for (const [romanized, devanagari, source] of manualPairs) {
    addPair(pairs, countsBySource, romanized, devanagari, source);
  }

  try {
    const pack = JSON.parse(readFileSync(runtimePackPath, "utf8"));
    for (const kind of ["words", "phrases", "names"]) {
      for (const row of pack[kind] ?? []) {
        addPair(pairs, countsBySource, row.romanized, row.unicode, `runtime-${kind}`);
      }
    }
  } catch {
    countsBySource["runtime-pack-missing"] = 1;
  }

  try {
    const lines = readFileSync(dictionaryPath, "utf8").split(/\r?\n/).filter(Boolean);
    const header = lines[0].split("\t");
    const wordIndex = header.indexOf("word");
    const romanizedIndex = header.indexOf("romanized");
    for (const line of lines.slice(1)) {
      const columns = line.split("\t");
      addPair(pairs, countsBySource, columns[romanizedIndex], columns[wordIndex], "dictionary-ne-ranked");
    }
  } catch {
    countsBySource["dictionary-ranked-missing"] = 1;
  }

  if (dakshinaPath) {
    const lines = readFileSync(dakshinaPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const columns = line.split(/\t|,/).map((value) => value.trim());
      const romanized = columns.find((value) => /^[a-zA-Z .,'/-]+$/.test(value));
      const devanagari = columns.find((value) => /[\u0900-\u097F]/.test(value));
      addPair(pairs, countsBySource, romanized, devanagari, "dakshina-style-local");
    }
  }

  const rows = [...pairs.values()]
    .sort((a, b) => a.romanized.localeCompare(b.romanized, "en") || a.devanagari.localeCompare(b.devanagari, "ne"));
  const splits = splitRows(rows);
  mkdirSync(outDir, { recursive: true });
  for (const [split, splitRowsValue] of Object.entries(splits)) {
    writeFileSync(join(outDir, `${split}.tsv`), [
      "romanized\tdevanagari\tsource",
      ...splitRowsValue.map((row) => `${row.romanized}\t${row.devanagari}\t${row.source}`)
    ].join("\n") + "\n");
  }

  const report = {
    status: "passed",
    outDir: relative(ROOT, outDir),
    counts: Object.fromEntries(Object.entries(splits).map(([key, value]) => [key, value.length])),
    total: rows.length,
    countsBySource,
    policy: {
      localOnly: true,
      privateDakshinaInputOptional: Boolean(dakshinaPath),
      noNetworkFetch: true,
      targetModelParams: "1-5M",
      targetRuntime: "Core ML .mlmodelc on-device tail reranker"
    }
  };
  finish("passed", report, 0);
} catch (error) {
  finish("failed", { error: error instanceof Error ? error.message : String(error) }, 1);
}

function addPair(pairs, countsBySource, romanized, devanagari, source) {
  const r = normalizeRomanized(romanized);
  const d = String(devanagari ?? "").trim().normalize("NFC");
  if (!r || !d || !/^[a-z0-9 .,'/-]+$/.test(r) || !/[\u0900-\u097F]/.test(d)) return;
  const key = `${r}\0${d}`;
  if (!pairs.has(key)) {
    pairs.set(key, { romanized: r, devanagari: d, source });
    countsBySource[source] = (countsBySource[source] ?? 0) + 1;
  }
}

function normalizeRomanized(value) {
  return String(value ?? "").toLowerCase().trim().normalize("NFC").replace(/\s+/g, " ");
}

function splitRows(rows) {
  const train = [];
  const dev = [];
  const test = [];
  rows.forEach((row) => {
    const bucket = hash(row.romanized + "\0" + row.devanagari) % 100;
    if (bucket < 8) test.push(row);
    else if (bucket < 16) dev.push(row);
    else train.push(row);
  });
  return { train, dev, test };
}

function hash(value) {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/build-neural-transliteration-dataset.mjs",
    suite: "neural-transliteration-dataset",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}
