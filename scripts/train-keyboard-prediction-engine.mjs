import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, "data", "keyboard-corpus");
const CURATED_DIR = path.join(CORPUS_DIR, "curated", "v0.1");
const RUNTIME_DIR = path.join(CORPUS_DIR, "runtime", "v0.1");
const SRC_RUNTIME_DIR = path.join(ROOT, "src", "data", "keyboard-packs", "v0.1");
const REPORTS_DIR = path.join(CORPUS_DIR, "reports");

const FILES = {
  d1: path.join(CURATED_DIR, "D1_word_aliases.v0.1.jsonl"),
  d2: path.join(CURATED_DIR, "D2_phrase_aliases.v0.1.jsonl"),
  d3: path.join(CURATED_DIR, "D3_casual_romanized_sentences.v0.1.jsonl"),
  d4: path.join(CURATED_DIR, "D4_mixed_nepali_english_sentences.v0.1.jsonl"),
  d7: path.join(CURATED_DIR, "D7_next_word_contexts.v0.1.jsonl"),
  d8: path.join(CURATED_DIR, "D8_blind_v0.1.jsonl"),
};

const MODEL_LIMITS = {
  contextRows: numberFromEnv("LEKH_PREDICTION_CONTEXT_ROWS", 80_000),
  prefixRows: numberFromEnv("LEKH_PREDICTION_PREFIX_ROWS", 60_000),
  maxContextPairsInMemory: numberFromEnv("LEKH_PREDICTION_MAX_CONTEXT_PAIRS", 1_400_000),
  maxPrefixPairsInMemory: numberFromEnv("LEKH_PREDICTION_MAX_PREFIX_PAIRS", 1_000_000),
};

const QUALITY_WEIGHT = {
  gold: 12,
  silver: 5,
  bronze: 1.4,
  synthetic: 0.18,
  blind: 0,
};

const SOURCE_WEIGHT = {
  "hf-boredoom17-nepali-flow-roman": 1.15,
  "hf-boredoom17-nepali-flow-colloquial": 1.1,
  "lekh-ngram-from-corpus": 1.0,
  "lekh-token-aligned-from-open-social": 0.88,
  "hf-syubraj-roman2nepali-transliteration": 0.72,
  "lekh-internal-romanized-phrases": 1.35,
  "lekh-internal-romanized-aliases": 1.25,
};

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "you",
  "your",
  "are",
  "was",
  "were",
  "official",
  "subscribe",
  "channel",
  "video",
  "lyrics",
  "song",
  "full",
  "new",
]);

const PRESERVE_TOKENS = new Set([
  "pdf",
  "nid",
  "pan",
  "vat",
  "url",
  "api",
  "html",
  "css",
  "javascript",
  "github",
  "google",
  "facebook",
  "instagram",
  "youtube",
  "gmail",
  "otp",
  "pin",
  "sms",
  "sim",
  "qr",
  "usb",
  "wifi",
  "vpn",
  "cpu",
  "ram",
]);

const UNSAFE_DEFAULT_SUGGESTION_TOKENS = new Set([
  "lado",
  "muji",
  "mugi",
  "randi",
  "radi",
  "chikne",
  "chikni",
  "machikne",
  "machikney",
  "khate",
  "khatey",
  "gandu",
  "boka",
]);

const contextCounts = new Map();
const prefixCounts = new Map();
const blindKeys = new Set();
const stats = {
  startedAt: new Date().toISOString(),
  rowsRead: {},
  rowsUsed: {},
  rowsSkipped: {},
  contextEvents: 0,
  prefixEvents: 0,
  blindRowsExcluded: 0,
};

await main();

async function main() {
  for (const file of Object.values(FILES)) assertFile(file);
  for (const dir of [RUNTIME_DIR, SRC_RUNTIME_DIR, REPORTS_DIR]) fs.mkdirSync(dir, { recursive: true });

  await loadBlindKeys();
  await trainFromSentences("d3", FILES.d3, "text");
  await trainFromSentences("d4", FILES.d4, "input");
  await trainFromNextContexts();
  await trainPrefixesFromAliases("d1", FILES.d1, "word");
  await trainPrefixesFromAliases("d2", FILES.d2, "phrase");

  const contextPredictions = topRows(contextCounts, MODEL_LIMITS.contextRows).map(toContextPrediction);
  const prefixPredictions = topRows(prefixCounts, MODEL_LIMITS.prefixRows).map(toPrefixPrediction);
  const model = {
    version: "v0.1-trained",
    trainedAt: new Date().toISOString(),
    description: "Aggregate local prediction model trained from redacted public Romanized Nepali corpus rows and curated alias tables.",
    privacy: {
      rawRowsBundled: false,
      trainingRows: "D1/D2/D3/D4/D7 curated rows only; D8 blind rows excluded by holdout key.",
      piiPolicy: "Uses only normalized aggregate contexts and prefixes. No source usernames, URLs, emails, phone numbers, or raw comments are emitted.",
    },
    limits: MODEL_LIMITS,
    stats: {
      ...stats,
      finishedAt: new Date().toISOString(),
      uniqueContextPairs: contextCounts.size,
      uniquePrefixPairs: prefixCounts.size,
      emittedContextPredictions: contextPredictions.length,
      emittedPrefixPredictions: prefixPredictions.length,
      checksum: checksum({ contextPredictions, prefixPredictions }),
    },
    contextPredictions,
    prefixPredictions,
  };
  const runtimeModel = compactRuntimeModel(model);

  writeJson(path.join(RUNTIME_DIR, "prediction-model.json"), model);
  writeJson(path.join(SRC_RUNTIME_DIR, "prediction-model.json"), runtimeModel);
  writeJson(path.join(REPORTS_DIR, "keyboard-prediction-training-report.json"), model.stats);
  fs.writeFileSync(
    path.join(REPORTS_DIR, "KEYBOARD_PREDICTION_TRAINING_REPORT.md"),
    [
      "# Keyboard Prediction Training Report",
      "",
      `Generated: ${model.trainedAt}`,
      "",
      "## Inputs",
      "",
      table([
        ["Dataset", "Rows read", "Rows used", "Rows skipped"],
        ...Object.keys(stats.rowsRead).sort().map((key) => [
          key,
          String(stats.rowsRead[key] ?? 0),
          String(stats.rowsUsed[key] ?? 0),
          String(stats.rowsSkipped[key] ?? 0),
        ]),
      ]),
      "",
      "## Outputs",
      "",
      `- Context predictions: ${contextPredictions.length}`,
      `- Prefix predictions: ${prefixPredictions.length}`,
      `- Unique context pairs observed: ${contextCounts.size}`,
      `- Unique prefix pairs observed: ${prefixCounts.size}`,
      `- Blind rows excluded: ${stats.blindRowsExcluded}`,
      `- Model checksum: ${model.stats.checksum}`,
      "",
      "## Privacy",
      "",
      "- Raw public rows stay in quarantine/generated corpus files and are not bundled as examples.",
      "- Runtime model emits aggregate context/prefix rows only.",
      "- D8 blind rows are excluded before training to avoid leakage.",
      "",
    ].join("\n")
  );

  console.log(JSON.stringify(model.stats, null, 2));
}

async function loadBlindKeys() {
  for await (const row of readJsonl(FILES.d8)) {
    stats.rowsRead.d8 = (stats.rowsRead.d8 ?? 0) + 1;
    const key = holdoutKey(row.task, row.payload ?? {});
    if (key) blindKeys.add(key);
  }
}

async function trainFromSentences(datasetKey, file, field) {
  for await (const row of readJsonl(file)) {
    bump(stats.rowsRead, datasetKey);
    if (row.split === "blind_holdout") {
      stats.blindRowsExcluded += 1;
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    const text = normalizeText(row[field]);
    const tokens = tokenize(text);
    if (tokens.length < 2) {
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    const sourceId = firstSource(row);
    const quality = normalizeQuality(row.quality);
    if (!runtimeEligibleTrainingRow(sourceId, quality)) {
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    const baseWeight = qualityWeight(quality) * sourceWeight(sourceId) * sentenceShapeWeight(tokens);
    if (baseWeight <= 0) {
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    for (let i = 1; i < tokens.length; i += 1) {
      const next = tokens[i];
      if (!validNextToken(next)) continue;
      for (let length = 1; length <= 4; length += 1) {
        if (i - length < 0) continue;
        const contextTokens = tokens.slice(i - length, i);
        if (!validContextTokens(contextTokens)) continue;
        addContext(contextTokens.join(" "), next, baseWeight * (1 + length * 0.12), sourceId, quality);
      }
    }
    trainPrefixFromTokens(tokens, sourceId, quality, baseWeight * 0.48);
    bump(stats.rowsUsed, datasetKey);
  }
}

async function trainFromNextContexts() {
  for await (const row of readJsonl(FILES.d7)) {
    bump(stats.rowsRead, "d7");
    if (row.split === "blind_holdout") {
      stats.blindRowsExcluded += 1;
      bump(stats.rowsSkipped, "d7");
      continue;
    }
    const context = normalizeRoman(row.context);
    const next = normalizeRoman(row.next);
    if (!context || !validNextToken(next) || !validContextTokens(context.split(" "))) {
      bump(stats.rowsSkipped, "d7");
      continue;
    }
    const sourceId = firstSource(row);
    const quality = normalizeQuality(row.quality);
    if (!runtimeEligibleTrainingRow(sourceId, quality)) {
      bump(stats.rowsSkipped, "d7");
      continue;
    }
    const weight = (row.confidence ?? 0.55) * qualityWeight(quality) * sourceWeight(sourceId);
    if (weight <= 0) {
      bump(stats.rowsSkipped, "d7");
      continue;
    }
    addContext(context, next, weight, sourceId, quality);
    addPrefix(next, next, "word", sourceId, quality, weight * 0.35);
    bump(stats.rowsUsed, "d7");
  }
}

async function trainPrefixesFromAliases(datasetKey, file, type) {
  for await (const row of readJsonl(file)) {
    bump(stats.rowsRead, datasetKey);
    if (row.split === "blind_holdout") {
      stats.blindRowsExcluded += 1;
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    const romanized = normalizeRoman(row.romanized);
    const unicode = Array.isArray(row.unicodeCandidates) ? row.unicodeCandidates[0] : undefined;
    if (!romanized || !unicode || !validCompletion(romanized)) {
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    const quality = normalizeQuality(row.quality);
    const sourceId = firstSource(row);
    if (!runtimeEligibleTrainingRow(sourceId, quality) && datasetKey !== "d1") {
      bump(stats.rowsSkipped, datasetKey);
      continue;
    }
    const weight = (row.confidence ?? 0.65) * qualityWeight(quality) * sourceWeight(sourceId);
    addPrefix(romanized, romanized, type, sourceId, quality, weight, unicode);
    bump(stats.rowsUsed, datasetKey);
  }
}

function trainPrefixFromTokens(tokens, sourceId, quality, weight) {
  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = 1; length <= 4; length += 1) {
      const end = start + length;
      if (end > tokens.length) break;
      const completion = tokens.slice(start, end).join(" ");
      if (!validCompletion(completion)) continue;
      addPrefix(completion, completion, length > 1 ? "phrase" : "word", sourceId, quality, weight / length);
    }
  }
}

function addContext(context, next, weight, sourceId, quality) {
  if (contextCounts.size > MODEL_LIMITS.maxContextPairsInMemory && !contextCounts.has(`${context}\t${next}`)) return;
  const key = `${context}\t${next}`;
  const row = contextCounts.get(key) ?? {
    context,
    next,
    score: 0,
    count: 0,
    sources: new Map(),
    qualities: new Map(),
  };
  row.score += weight;
  row.count += 1;
  row.sources.set(sourceId, (row.sources.get(sourceId) ?? 0) + 1);
  row.qualities.set(quality, (row.qualities.get(quality) ?? 0) + 1);
  contextCounts.set(key, row);
  stats.contextEvents += 1;
}

function addPrefix(prefix, completion, type, sourceId, quality, weight, unicode) {
  if (!completion || !validCompletion(completion)) return;
  const maxPrefixLength = Math.min(18, completion.length);
  for (let i = 1; i <= maxPrefixLength; i += 1) {
    const partial = completion.slice(0, i).trim();
    if (partial.length < 1) continue;
    const key = `${partial}\t${completion}`;
    if (prefixCounts.size > MODEL_LIMITS.maxPrefixPairsInMemory && !prefixCounts.has(key)) continue;
    const row = prefixCounts.get(key) ?? {
      prefix: partial,
      completion,
      unicode,
      type,
      score: 0,
      count: 0,
      sources: new Map(),
      qualities: new Map(),
    };
    row.score += weight * (partial === completion ? 0.45 : 1);
    row.count += 1;
    row.sources.set(sourceId, (row.sources.get(sourceId) ?? 0) + 1);
    row.qualities.set(quality, (row.qualities.get(quality) ?? 0) + 1);
    prefixCounts.set(key, row);
    stats.prefixEvents += 1;
  }
}

function topRows(map, limit) {
  return Array.from(map.values())
    .filter((row) => row.score > 0 && row.count > 0)
    .sort((a, b) => b.score - a.score || b.count - a.count || stableSortKey(a).localeCompare(stableSortKey(b)))
    .slice(0, limit);
}

function toContextPrediction(row) {
  const contextLength = row.context.split(" ").length;
  const quality = dominant(row.qualities);
  return {
    context: row.context,
    next: row.next,
    score: round(row.score),
    count: row.count,
    confidence: confidence(row.score, row.count, quality, contextLength),
    quality,
    sources: topMapKeys(row.sources, 3),
  };
}

function toPrefixPrediction(row) {
  const quality = dominant(row.qualities);
  return {
    prefix: row.prefix,
    completion: row.completion,
    unicode: row.unicode,
    type: row.type,
    score: round(row.score),
    count: row.count,
    confidence: confidence(row.score, row.count, quality, row.completion.split(" ").length),
    quality,
    sources: topMapKeys(row.sources, 3),
  };
}

function confidence(score, count, quality, length) {
  const qualityBase = quality === "gold" ? 0.82 : quality === "silver" ? 0.74 : quality === "bronze" ? 0.64 : 0.5;
  const scoreBoost = Math.min(0.18, Math.log1p(score) / 34);
  const countBoost = Math.min(0.08, Math.log1p(count) / 60);
  const lengthBoost = Math.min(0.04, length * 0.01);
  return Math.max(0.42, Math.min(0.965, round(qualityBase + scoreBoost + countBoost + lengthBoost)));
}

function tokenize(value) {
  return normalizeText(value)
    .replace(/[’']/g, "")
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter((token) => token && token.length <= 28 && !/^\d+$/.test(token));
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/@[a-z0-9_]+/gi, " ")
    .replace(/[^\p{Script=Latin}\p{Number}\s.'’-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeRoman(value) {
  return normalizeText(value).replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
}

function validContextTokens(tokens) {
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((token) => validToken(token, { allowShort: true }) && !isUnsafeSuggestionToken(token));
}

function validNextToken(token) {
  return validToken(token, { allowShort: true }) && !STOP_TOKENS.has(token) && !isUnsafeSuggestionToken(token);
}

function validToken(token, { allowShort }) {
  if (!token) return false;
  if (token.length < (allowShort ? 1 : 2) || token.length > 28) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^[a-z]{1}$/.test(token) && !["k", "x", "m"].includes(token)) return false;
  if (/([a-z])\1{4,}/.test(token)) return false;
  return /^[a-z0-9]+$/.test(token);
}

function validCompletion(completion) {
  const tokens = completion.split(" ").filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;
  if (tokens.some((token) => !validToken(token, { allowShort: true }))) return false;
  if (tokens.every((token) => STOP_TOKENS.has(token))) return false;
  if (tokens.some((token) => isUnsafeSuggestionToken(token))) return false;
  if (tokens.some((token) => PRESERVE_TOKENS.has(token)) && tokens.length === 1) return false;
  return true;
}

function isUnsafeSuggestionToken(token) {
  if (UNSAFE_DEFAULT_SUGGESTION_TOKENS.has(token)) return true;
  return ["lado", "muji", "mugi", "randi", "radi", "chikne", "machikne", "khate", "khatey", "gandu"].some(
    (prefix) => token.startsWith(prefix) && token.length <= prefix.length + 5
  );
}

function sentenceShapeWeight(tokens) {
  const romanMarkers = tokens.filter((token) =>
    [
      "ma",
      "mero",
      "malai",
      "tapai",
      "timi",
      "timro",
      "cha",
      "xa",
      "chha",
      "ho",
      "hoina",
      "bhayo",
      "vayo",
      "garna",
      "garnu",
      "parcha",
      "parxa",
      "huncha",
      "hunxa",
      "k",
      "ke",
      "kina",
      "kasari",
      "ramro",
      "dherai",
      "aaja",
      "bholi",
      "voli",
      "pachi",
      "paxi",
    ].includes(token)
  ).length;
  const markerBoost = Math.min(1.4, 0.8 + romanMarkers * 0.12);
  const lengthPenalty = tokens.length > 18 ? 0.75 : 1;
  return markerBoost * lengthPenalty;
}

function firstSource(row) {
  if (Array.isArray(row.sourceIds) && row.sourceIds[0]) return row.sourceIds[0];
  return row.sourceId || "unknown";
}

function sourceWeight(sourceId) {
  return SOURCE_WEIGHT[sourceId] ?? (sourceId.includes("synthetic") ? 0.2 : 0.72);
}

function runtimeEligibleTrainingRow(sourceId, quality) {
  if (quality === "synthetic" || sourceId.includes("generated") || sourceId.includes("synthetic")) return false;
  return true;
}

function normalizeQuality(quality) {
  return QUALITY_WEIGHT[quality] == null ? "bronze" : quality;
}

function qualityWeight(quality) {
  return QUALITY_WEIGHT[quality] ?? 1;
}

function holdoutKey(task, payload) {
  if (task === "romanized-to-unicode-word") {
    return `romanized-to-unicode-word:${normalizeRoman(payload.romanized)}:${normalizeUnicodeCandidates(payload.expected).join("|")}`;
  }
  if (task === "romanized-to-unicode-phrase") {
    return `romanized-to-unicode-phrase:${normalizeRoman(payload.romanized)}:${normalizeUnicodeCandidates(payload.expected).join("|")}`;
  }
  if (task === "casual-romanized-preserve-or-suggest") {
    return `casual-romanized-preserve-or-suggest:${normalizeText(payload.input)}`;
  }
  if (task === "mixed-nepali-english-policy") {
    return `mixed-nepali-english-policy:${normalizeText(payload.input)}`;
  }
  if (task === "next-word-context") {
    return `next-word-context:${normalizeRoman(payload.context)}:${normalizeRoman(payload.next)}`;
  }
  return undefined;
}

function normalizeUnicodeCandidates(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item ?? "").normalize("NFC").trim())
    .filter(Boolean);
}

async function* readJsonl(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed);
  }
}

function assertFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Required corpus file is missing: ${path.relative(ROOT, file)}`);
}

function bump(obj, key) {
  obj[key] = (obj[key] ?? 0) + 1;
}

function topMapKeys(map, limit) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function dominant(map) {
  return topMapKeys(map, 1)[0] ?? "bronze";
}

function stableSortKey(row) {
  return row.context ? `${row.context}\t${row.next}` : `${row.prefix}\t${row.completion}`;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function compactRuntimeModel(model) {
  return {
    version: model.version,
    trainedAt: model.trainedAt,
    checksum: model.stats.checksum,
    contextPredictions: model.contextPredictions.map((row) => ({
      c: row.context,
      n: row.next,
      f: row.confidence,
      q: row.quality,
    })),
    prefixPredictions: model.prefixPredictions.map((row) => ({
      p: row.prefix,
      m: row.completion,
      u: row.unicode,
      t: row.type,
      f: row.confidence,
      q: row.quality,
    })),
  };
}

function table(rows) {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => String(row[index] ?? "").length)));
  return rows
    .map((row, index) => {
      const line = `| ${row.map((cell, col) => String(cell ?? "").padEnd(widths[col])).join(" | ")} |`;
      if (index !== 0) return line;
      return `${line}\n| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
    })
    .join("\n");
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
