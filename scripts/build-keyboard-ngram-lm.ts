import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { convertRomanized } from "../src/engine/romanized";

type ScriptKind = "devanagari" | "romanized";
type Quality = "gold" | "silver" | "bronze";

interface ModelRow {
  k: ScriptKind;
  c: string;
  n: string;
  r?: string;
  q: number;
  f: number;
  s: string;
}

interface PendingRow {
  kind: ScriptKind;
  context: string;
  next: string;
  romanized?: string;
  confidence: number;
  frequency: number;
  source: string;
  quality: Quality;
}

const ROOT = process.cwd();
const STARTED_AT = performance.now();
const OUT_PATH = join(ROOT, "src", "data", "keyboard-packs", "v0.1", "ngram-lm.json");
const REPORT_PATH = join(ROOT, "reports", "keyboard-ngram-lm-report.json");
const PREDICTION_MODEL_PATH = join(ROOT, "src", "data", "keyboard-packs", "v0.1", "prediction-model.json");
const RUNTIME_PACK_PATH = join(ROOT, "src", "data", "keyboard-packs", "v0.1", "runtime-suggestions.json");
const BIGRAM_PATH = join(ROOT, "data", "generated", "frequency", "lekh-bigram-frequency.tsv");
const MAX_ROWS = 35_000;
const MAX_ROWS_PER_CONTEXT = 8;

const PARTICLE_NEXT_BLOCKLIST = new Set([
  "को",
  "मा",
  "ले",
  "लाई",
  "र",
  "पनि",
]);

const LATIN_NEXT_BLOCKLIST = new Set([
  "comment",
  "video",
  "channel",
  "subscribe",
  "youtube",
  "facebook",
  "instagram",
  "best",
  "life",
  "official",
]);

const UNSAFE_ROMANIZED = [
  "lado",
  "muji",
  "mugi",
  "randi",
  "radi",
  "chikne",
  "machikne",
  "khate",
  "khatey",
  "gandu",
];

const ROMANIZED_UNICODE_OVERRIDES: Record<string, string> = {
  naam: "नाम",
  swasthya: "स्वास्थ्य",
  ghar: "घर",
  ho: "हो",
  karyalaya: "कार्यालय",
  sewa: "सेवा",
  bima: "बीमा",
  prashasan: "प्रशासन",
  pramanpatra: "प्रमाणपत्र",
  darta: "दर्ता",
  mantralaya: "मन्त्रालय",
  lagyo: "लाग्यो",
  cha: "छ",
  chha: "छ",
  dherai: "धेरै",
  ramro: "राम्रो",
  kasto: "कस्तो",
  ke: "के",
  k: "के",
  malai: "मलाई",
  thaha: "थाहा",
  chaina: "छैन",
  aaja: "आज",
  bholi: "भोलि",
  bhetumla: "भेटौँला",
  pani: "पानी",
  desh: "देश",
  dai: "दाइ",
  kura: "कुरा",
  lagcha: "लाग्छ",
  thiyo: "थियो",
  chhan: "छन्",
};

const GOLD_SEEDS: Array<{ context: string; next: string; confidence: number; source: string }> = [
  { context: "mero", next: "naam", confidence: 0.95, source: "curated-next-word" },
  { context: "mero", next: "swasthya", confidence: 0.93, source: "curated-next-word" },
  { context: "mero", next: "ghar", confidence: 0.91, source: "curated-next-word" },
  { context: "mero naam", next: "ho", confidence: 0.94, source: "curated-next-word" },
  { context: "swasthya", next: "karyalaya", confidence: 0.96, source: "curated-next-word" },
  { context: "swasthya", next: "sewa", confidence: 0.9, source: "curated-next-word" },
  { context: "swasthya", next: "bima", confidence: 0.89, source: "curated-next-word" },
  { context: "jilla", next: "prashasan", confidence: 0.96, source: "curated-next-word" },
  { context: "jilla prashasan", next: "karyalaya", confidence: 0.95, source: "curated-next-word" },
  { context: "nagarikta", next: "pramanpatra", confidence: 0.95, source: "curated-next-word" },
  { context: "janma", next: "darta", confidence: 0.93, source: "curated-next-word" },
  { context: "mrityu", next: "darta", confidence: 0.93, source: "curated-next-word" },
  { context: "shiksha", next: "mantralaya", confidence: 0.92, source: "curated-next-word" },
  { context: "ramro", next: "lagyo", confidence: 0.93, source: "curated-next-word" },
  { context: "ramro", next: "cha", confidence: 0.92, source: "curated-next-word" },
  { context: "dherai", next: "ramro", confidence: 0.92, source: "curated-next-word" },
  { context: "kasto", next: "cha", confidence: 0.91, source: "curated-next-word" },
  { context: "ke", next: "cha", confidence: 0.9, source: "curated-next-word" },
  { context: "k", next: "cha", confidence: 0.88, source: "curated-next-word" },
  { context: "malai", next: "thaha", confidence: 0.9, source: "curated-next-word" },
  { context: "thaha", next: "chaina", confidence: 0.9, source: "curated-next-word" },
  { context: "aaja", next: "meeting", confidence: 0.86, source: "curated-next-word" },
  { context: "bholi", next: "bhetumla", confidence: 0.9, source: "curated-next-word" },
];

const pendingRows: PendingRow[] = [];
const failures: string[] = [];
const warnings: string[] = [];
const stats = {
  seedRows: 0,
  predictionRows: 0,
  runtimeContextRows: 0,
  bigramRows: 0,
  skippedRows: 0,
  duplicateRows: 0,
  emittedRows: 0,
};

main();

function main() {
  for (const seed of GOLD_SEEDS) {
    addRomanizedContext(seed.context, seed.next, seed.confidence, 80_000, seed.source, "gold");
    stats.seedRows += 1;
  }

  const predictionModel = readJson(PREDICTION_MODEL_PATH) as {
    contextPredictions?: Array<{ c: string; n: string; f?: number; q?: Quality }>;
  };
  for (const row of predictionModel.contextPredictions ?? []) {
    if (stats.predictionRows >= 18_000) break;
    const confidence = clamp(Number(row.f ?? 0.62), 0.5, 0.9);
    addRomanizedContext(row.c, row.n, confidence, Math.round(confidence * 20_000), "trained-aggregate-context", row.q ?? "bronze");
    stats.predictionRows += 1;
  }

  const runtimePack = readJson(RUNTIME_PACK_PATH) as {
    nextContexts?: Array<{ context: string; next: string; confidence?: number; quality?: Quality }>;
  };
  for (const row of runtimePack.nextContexts ?? []) {
    if (stats.runtimeContextRows >= 14_000) break;
    const confidence = clamp(Number(row.confidence ?? 0.6), 0.5, 0.84);
    addRomanizedContext(row.context, row.next, confidence, Math.round(confidence * 12_000), "runtime-next-context", row.quality ?? "bronze");
    stats.runtimeContextRows += 1;
  }

  for (const row of readBigramRows(BIGRAM_PATH, 8_000)) {
    addDevanagariContext(row.context, row.next, row.confidence, row.frequency, "filtered-bigram-frequency", "bronze");
    stats.bigramRows += 1;
  }

  const rows = finalizeRows(pendingRows);
  const model = {
    version: "v0.1-ngram-inline",
    generatedAt: new Date().toISOString(),
    description: "Quantized local n-gram model for inline next-word completion and grey-text prediction.",
    privacy: {
      localOnly: true,
      rawRowsBundled: false,
      payload: "aggregate contexts only; no usernames, URLs, emails, phone numbers, or private text"
    },
    maxContextLength: 4,
    quantization: "uint8 confidence q plus integer frequency f",
    stats: {
      ...stats,
      emittedRows: rows.length,
      uniqueContexts: new Set(rows.map((row) => `${row.k}:${row.c}`)).size,
      durationMs: Math.round(performance.now() - STARTED_AT)
    },
    checksum: checksum(rows),
    rows
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(model)}\n`);
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        status: failures.length === 0 ? "passed" : "failed",
        generatedAt: model.generatedAt,
        output: relative(ROOT, OUT_PATH),
        checksum: model.checksum,
        stats: model.stats,
        validation: {
          failures,
          warnings,
          checks: [
            "NFC normalization",
            "self-loop blocking",
            "unsafe token filtering",
            "duplicate/context conflict dedupe",
            "Romanized-derived row consistency"
          ]
        }
      },
      null,
      2
    )}\n`
  );

  if (failures.length > 0) {
    console.error(JSON.stringify({ status: "failed", failures, report: relative(ROOT, REPORT_PATH) }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "passed", output: relative(ROOT, OUT_PATH), rows: rows.length, report: relative(ROOT, REPORT_PATH) }, null, 2));
}

function addRomanizedContext(context: string, next: string, confidence: number, frequency: number, source: string, quality: Quality) {
  const romanContext = normalizeRomanized(context);
  const romanNext = normalizeRomanized(next);
  if (!validRomanizedContext(romanContext) || !validRomanizedNext(romanNext)) {
    stats.skippedRows += 1;
    return;
  }

  const unicodeContext = romanizedToUnicode(romanContext);
  const unicodeNext = romanizedToUnicode(romanNext);
  if (!validDevanagariContext(unicodeContext) || !validDevanagariNext(unicodeNext)) {
    stats.skippedRows += 1;
    return;
  }

  addPending({
    kind: "romanized",
    context: romanContext,
    next: unicodeNext,
    romanized: romanNext,
    confidence,
    frequency,
    source,
    quality
  });
  addPending({
    kind: "devanagari",
    context: unicodeContext,
    next: unicodeNext,
    romanized: romanNext,
    confidence: Math.min(0.97, confidence + (quality === "gold" ? 0.02 : 0)),
    frequency,
    source,
    quality
  });
}

function addDevanagariContext(context: string, next: string, confidence: number, frequency: number, source: string, quality: Quality) {
  const normalizedContext = normalizeDevanagari(context);
  const normalizedNext = normalizeDevanagari(next);
  if (!validDevanagariContext(normalizedContext) || !validDevanagariNext(normalizedNext)) {
    stats.skippedRows += 1;
    return;
  }
  addPending({
    kind: "devanagari",
    context: normalizedContext,
    next: normalizedNext,
    confidence,
    frequency,
    source,
    quality
  });
}

function addPending(row: PendingRow) {
  if (row.context.split(/\s+/).at(-1) === row.next || row.context === row.next) {
    stats.skippedRows += 1;
    return;
  }
  if (row.context !== row.context.normalize("NFC") || row.next !== row.next.normalize("NFC")) {
    failures.push(`non-NFC row: ${row.context} -> ${row.next}`);
    return;
  }
  pendingRows.push(row);
}

function finalizeRows(sourceRows: PendingRow[]): ModelRow[] {
  const merged = new Map<string, PendingRow>();
  for (const row of sourceRows) {
    const key = `${row.kind}\0${row.context}\0${row.next}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      continue;
    }
    stats.duplicateRows += 1;
    merged.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, row.confidence),
      frequency: existing.frequency + row.frequency,
      source: existing.source === row.source ? row.source : `${existing.source}+${row.source}`,
      quality: qualityRank(row.quality) > qualityRank(existing.quality) ? row.quality : existing.quality,
      romanized: existing.romanized ?? row.romanized
    });
  }

  const byContext = new Map<string, PendingRow[]>();
  for (const row of merged.values()) {
    const key = `${row.kind}\0${row.context}`;
    byContext.set(key, [...(byContext.get(key) ?? []), row]);
  }

  const output: ModelRow[] = [];
  for (const rows of byContext.values()) {
    output.push(
      ...rows
        .sort(comparePending)
        .slice(0, MAX_ROWS_PER_CONTEXT)
        .map((row): ModelRow => ({
          k: row.kind,
          c: row.context,
          n: row.next,
          r: row.romanized,
          q: quantize(row.confidence, row.quality),
          f: Math.max(1, Math.round(row.frequency)),
          s: row.source
        }))
    );
  }
  return output.sort(compareModelRows).slice(0, MAX_ROWS);
}

function readBigramRows(path: string, limit: number) {
  const rows: Array<{ context: string; next: string; confidence: number; frequency: number }> = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (rows.length >= limit) break;
    const [bigram, frequencyRaw] = line.split("\t");
    const [context, next] = normalizeDevanagari(bigram ?? "").split(/\s+/);
    const frequency = Number(frequencyRaw ?? 0);
    if (!context || !next || !Number.isFinite(frequency) || frequency <= 0) continue;
    if (PARTICLE_NEXT_BLOCKLIST.has(next) && frequency < 5_000) continue;
    const confidence = clamp(0.54 + Math.log1p(frequency) / 38, 0.54, 0.8);
    rows.push({ context, next, confidence, frequency });
  }
  return rows;
}

function romanizedToUnicode(value: string): string {
  const override = value
    .split(" ")
    .map((token) => ROMANIZED_UNICODE_OVERRIDES[token])
    .filter(Boolean);
  if (override.length === value.split(" ").filter(Boolean).length) return override.join(" ");

  return convertRomanized(value, {
    mode: "romanized-mixed",
    digitPolicy: "context-dependent"
  }).normalizedOutput.normalize("NFC").trim();
}

function validRomanizedContext(value: string): boolean {
  const tokens = value.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.length <= 4 && tokens.every(validRomanizedToken);
}

function validRomanizedNext(value: string): boolean {
  if (!validRomanizedToken(value)) return false;
  if (LATIN_NEXT_BLOCKLIST.has(value)) return false;
  return true;
}

function validRomanizedToken(value: string): boolean {
  if (!value || value.length > 28 || /^\d+$/.test(value)) return false;
  if (UNSAFE_ROMANIZED.some((token) => value.startsWith(token) && value.length <= token.length + 5)) return false;
  return /^[a-z0-9]+$/.test(value);
}

function validDevanagariContext(value: string): boolean {
  const tokens = value.split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.length <= 4 && tokens.every((token) => validDevanagariToken(token, false));
}

function validDevanagariNext(value: string): boolean {
  if (!validDevanagariToken(value, true)) return false;
  if (PARTICLE_NEXT_BLOCKLIST.has(value)) return false;
  return true;
}

function validDevanagariToken(value: string, next: boolean): boolean {
  if (!value || value.length > 40) return false;
  if (!/^[\u0900-\u097F]+$/.test(value)) return false;
  if (/^[०-९]+$/.test(value)) return false;
  if (next && value.length < 2) return false;
  return true;
}

function normalizeRomanized(value: string): string {
  const tokenMap: Record<string, string> = {
    xa: "chha",
    xaina: "chhaina",
    xan: "chhan",
    xu: "chhu",
    xau: "chhau",
    hunxa: "huncha",
    parxa: "parcha",
    garxa: "garcha",
    garxu: "garchu",
    vayo: "bhayo",
    vayena: "bhayena",
    voli: "bholi",
    paxi: "pachi"
  };
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((token) => tokenMap[token] ?? token)
    .join(" ");
}

function normalizeDevanagari(value: string): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[।॥]+/g, " ")
    .replace(/[^\u0900-\u097F\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparePending(left: PendingRow, right: PendingRow): number {
  return qualityRank(right.quality) - qualityRank(left.quality) ||
    right.confidence - left.confidence ||
    Math.log1p(right.frequency) - Math.log1p(left.frequency) ||
    left.next.localeCompare(right.next, "ne");
}

function compareModelRows(left: ModelRow, right: ModelRow): number {
  return right.q - left.q ||
    Math.log1p(right.f) - Math.log1p(left.f) ||
    left.k.localeCompare(right.k) ||
    left.c.localeCompare(right.c, "ne") ||
    left.n.localeCompare(right.n, "ne");
}

function qualityRank(quality: Quality): number {
  if (quality === "gold") return 3;
  if (quality === "silver") return 2;
  return 1;
}

function quantize(confidence: number, quality: Quality): number {
  const qualityBoost = quality === "gold" ? 0.02 : quality === "silver" ? 0.01 : 0;
  return Math.max(1, Math.min(255, Math.round(clamp(confidence + qualityBoost, 0, 0.98) * 255)));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
