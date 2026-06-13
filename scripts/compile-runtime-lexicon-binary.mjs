#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.cwd();
const DEFAULT_INPUT = join(ROOT, "release", "native", "macos", "runtime-suggestions.sanitized.json");
const DEFAULT_OUTPUT = join(ROOT, "release", "native", "macos", "runtime-suggestions.lkb");
const DEFAULT_REPORT = join(ROOT, "reports", "runtime-lexicon-binary-report.json");
const MAGIC = Buffer.from("LEKHBLX1", "ascii");
const HEADER_SIZE = 64;
const ENTRY_STRIDE = 24;
const PREFIX_STRIDE = 16;
const MAX_PREFIX_LENGTH = 12;
const MAX_PREFIX_REFS = 64;

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "1" : process.argv[index + 1] ?? "1";
  args.set(key, value);
  if (value !== "1") index += 1;
}

const inputPath = args.get("input") ?? DEFAULT_INPUT;
const outputPath = args.get("output") ?? DEFAULT_OUTPUT;
const reportPath = args.get("report") ?? DEFAULT_REPORT;
const startedAt = performance.now();

function main() {
try {
  const source = readFileSync(inputPath, "utf8");
  const pack = JSON.parse(source);
  const validation = validateRuntimePack(pack);
  if (validation.failures.length > 0) {
    finish("failed", { input: relative(ROOT, inputPath), validation }, 1);
  }

  const compiled = compileLexicon(pack);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, compiled.buffer);

  const benchmark = benchmarkBinaryLookup(compiled.buffer, compiled.queries);
  const failures = [];
  if (compiled.entries.length === 0) failures.push("binary lexicon has no entries");
  if (compiled.buffer.length > 5 * 1024 * 1024) failures.push("binary lexicon is larger than 5 MB");
  if (benchmark.openParseMs > 5) failures.push(`binary lexicon open/parse ${benchmark.openParseMs.toFixed(3)}ms exceeds 5ms`);
  if (benchmark.lookupP99Ms > 1) failures.push(`binary lexicon lookup p99 ${benchmark.lookupP99Ms.toFixed(3)}ms exceeds 1ms`);

  finish(failures.length === 0 ? "passed" : "failed", {
    input: relative(ROOT, inputPath),
    output: relative(ROOT, outputPath),
    format: "LEKHBLX1",
    packHash: createHash("sha256").update(source).digest("hex"),
    binaryHash: createHash("sha256").update(compiled.buffer).digest("hex"),
    counts: {
      entries: compiled.entries.length,
      prefixes: compiled.prefixRows.length,
      refs: compiled.refCount,
      stringBytes: compiled.stringBytes,
      binaryBytes: compiled.buffer.length
    },
    policy: {
      memoryMappedRuntime: true,
      maxPrefixLength: MAX_PREFIX_LENGTH,
      maxPrefixRefs: MAX_PREFIX_REFS,
      coldStartTargetMs: 5,
      perLookupP99TargetMs: 1,
      steadyStateRssTargetMb: 25
    },
    validation,
    benchmark,
    failures
  }, failures.length === 0 ? 0 : 1);
} catch (error) {
  finish("failed", {
    input: relative(ROOT, inputPath),
    step: "compile-runtime-lexicon-binary",
    error: error instanceof Error ? error.message : String(error)
  }, 1);
}
}

function compileLexicon(pack) {
  const sourceRows = [
    ...rowsForKind(pack.phrases ?? [], "phrase", 1, 0),
    ...rowsForKind(pack.words ?? [], "word", 2, 10_000),
    ...rowsForKind(pack.names ?? [], "name", 3, 30_000)
  ];
  const entries = sourceRows
    .sort(compareRows)
    .filter((row, index, rows) => index === 0 || row.romanized !== rows[index - 1].romanized || row.unicode !== rows[index - 1].unicode);

  const strings = new StringTable();
  const entryBuffers = [];
  for (const row of entries) {
    row.romanOffset = strings.add(row.romanized);
    row.romanLength = Buffer.byteLength(row.romanized, "utf8");
    row.unicodeOffset = strings.add(row.unicode);
    row.unicodeLength = Buffer.byteLength(row.unicode, "utf8");
    const entry = Buffer.alloc(ENTRY_STRIDE);
    entry.writeUInt32LE(row.romanOffset, 0);
    entry.writeUInt16LE(row.romanLength, 4);
    entry.writeUInt16LE(row.unicodeLength, 6);
    entry.writeUInt32LE(row.unicodeOffset, 8);
    entry.writeUInt16LE(Math.round(clamp(row.confidence, 0, 1) * 1000), 12);
    entry.writeUInt8(row.kindCode, 14);
    entry.writeUInt8(0, 15);
    entry.writeUInt32LE(row.priority, 16);
    entry.writeUInt32LE(row.sourceIndex, 20);
    entryBuffers.push(entry);
  }

  const prefixes = new Map();
  entries.forEach((row, entryIndex) => {
    for (const prefix of prefixesFor(row.romanized)) {
      const bucket = prefixes.get(prefix) ?? [];
      bucket.push(entryIndex);
      prefixes.set(prefix, bucket);
    }
  });

  const refIndexes = [];
  const prefixRows = [];
  for (const [prefix, indexes] of [...prefixes.entries()].sort(([a], [b]) => asciiCompare(a, b))) {
    const sortedRefs = indexes
      .sort((left, right) => compareRows(entries[left], entries[right]))
      .slice(0, MAX_PREFIX_REFS);
    const startRef = refIndexes.length;
    refIndexes.push(...sortedRefs);
    const prefixOffset = strings.add(prefix);
    const prefixLength = Buffer.byteLength(prefix, "utf8");
    const row = Buffer.alloc(PREFIX_STRIDE);
    row.writeUInt32LE(prefixOffset, 0);
    row.writeUInt16LE(prefixLength, 4);
    row.writeUInt16LE(0, 6);
    row.writeUInt32LE(startRef, 8);
    row.writeUInt32LE(sortedRefs.length, 12);
    prefixRows.push({ prefix, row });
  }

  const entryTable = Buffer.concat(entryBuffers);
  const prefixTable = Buffer.concat(prefixRows.map((item) => item.row));
  const refTable = Buffer.alloc(refIndexes.length * 4);
  refIndexes.forEach((entryIndex, index) => refTable.writeUInt32LE(entryIndex, index * 4));
  const stringTable = strings.toBuffer();
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(HEADER_SIZE, 12);
  header.writeUInt32LE(entries.length, 16);
  header.writeUInt32LE(HEADER_SIZE, 20);
  header.writeUInt32LE(ENTRY_STRIDE, 24);
  header.writeUInt32LE(prefixRows.length, 28);
  header.writeUInt32LE(HEADER_SIZE + entryTable.length, 32);
  header.writeUInt32LE(PREFIX_STRIDE, 36);
  header.writeUInt32LE(refIndexes.length, 40);
  header.writeUInt32LE(HEADER_SIZE + entryTable.length + prefixTable.length, 44);
  header.writeUInt32LE(HEADER_SIZE + entryTable.length + prefixTable.length + refTable.length, 48);
  header.writeUInt32LE(stringTable.length, 52);
  header.writeUInt32LE(MAX_PREFIX_LENGTH, 56);
  header.writeUInt32LE(1, 60);

  const buffer = Buffer.concat([header, entryTable, prefixTable, refTable, stringTable]);
  const queries = [...new Set([
    "swas",
    "swasthya",
    "thapera",
    "niraj",
    "mero",
    "karyalaya",
    ...entries.slice(0, 128).map((row) => row.romanized),
    ...entries.slice(-128).map((row) => row.romanized)
  ])];
  return {
    buffer,
    entries,
    prefixRows,
    refCount: refIndexes.length,
    stringBytes: stringTable.length,
    queries
  };
}

function rowsForKind(rows, kind, kindCode, priorityOffset) {
  return rows
    .filter((row) => typeof row?.romanized === "string" && typeof row?.unicode === "string")
    .map((row, index) => ({
      romanized: normalizeRomanized(row.romanized),
      unicode: row.unicode.trim().normalize("NFC"),
      confidence: Number.isFinite(row.confidence) ? Number(row.confidence) : 0.7,
      kind,
      kindCode,
      priority: priorityOffset + index,
      sourceIndex: index
    }))
    .filter((row) => row.romanized && row.unicode);
}

function prefixesFor(romanized) {
  const prefixes = new Set([romanized]);
  const max = Math.min(MAX_PREFIX_LENGTH, romanized.length);
  for (let length = 1; length <= max; length += 1) {
    prefixes.add(romanized.slice(0, length));
  }
  return prefixes;
}

function compareRows(left, right) {
  return right.confidence - left.confidence ||
    left.priority - right.priority ||
    asciiCompare(left.romanized, right.romanized) ||
    left.unicode.localeCompare(right.unicode, "ne");
}

class StringTable {
  constructor() {
    this.offsets = new Map();
    this.buffers = [];
    this.length = 0;
  }

  add(value) {
    const normalized = String(value).normalize("NFC");
    const existing = this.offsets.get(normalized);
    if (existing !== undefined) return existing;
    const encoded = Buffer.from(normalized, "utf8");
    const offset = this.length;
    this.offsets.set(normalized, offset);
    this.buffers.push(encoded);
    this.length += encoded.length;
    return offset;
  }

  toBuffer() {
    return Buffer.concat(this.buffers, this.length);
  }
}

function validateRuntimePack(pack) {
  const failures = [];
  const warnings = [];
  const seenRows = new Set();
  const romanizedMap = new Map();
  const romanizedMapByKind = new Map();
  const confidenceDiversity = {};

  for (const kind of ["words", "phrases", "names"]) {
    const rows = Array.isArray(pack[kind]) ? pack[kind] : [];
    const kindRomanizedMap = new Map();
    confidenceDiversity[kind] = new Set(rows.map((row) => row.confidence)).size;
    if (rows.length >= 10 && confidenceDiversity[kind] < 10) {
      failures.push(`${kind} confidence diversity too low: ${confidenceDiversity[kind]}`);
    }
    rows.forEach((row, index) => {
      const location = `${kind}[${index}]`;
      if (typeof row?.romanized !== "string" || typeof row?.unicode !== "string") {
        failures.push(`${location} must have romanized and unicode strings`);
        return;
      }
      assertNfc(row.romanized, `${location}.romanized`, failures);
      assertNfc(row.unicode, `${location}.unicode`, failures);
      const romanized = normalizeRomanized(row.romanized);
      const unicode = row.unicode.trim().normalize("NFC");
      if (!/^[a-z0-9 .,'’:;!?()/-]+$/.test(romanized)) {
        failures.push(`${location}.romanized contains unsupported characters`);
      }
      if (!/[\u0900-\u097F]/.test(unicode)) {
        failures.push(`${location}.unicode does not contain Devanagari`);
      }
      validateDevanagariGraphemes(unicode, `${location}.unicode`, failures);
      if ((romanized === "patiko" && unicode === "यतिको") || (romanized.includes("patiko") && unicode.includes("यतिको"))) {
        failures.push(`${location} contains blocked patiko -> यतिको mapping`);
      }
      const duplicateKey = `${kind}\0${romanized}\0${unicode}`;
      if (seenRows.has(duplicateKey)) failures.push(`${location} duplicates ${romanized} -> ${unicode}`);
      seenRows.add(duplicateKey);
      const variants = romanizedMap.get(romanized) ?? new Set();
      variants.add(unicode);
      romanizedMap.set(romanized, variants);
      const kindVariants = kindRomanizedMap.get(romanized) ?? new Set();
      kindVariants.add(unicode);
      kindRomanizedMap.set(romanized, kindVariants);
    });
    romanizedMapByKind.set(kind, kindRomanizedMap);
  }

  validateProofread(pack.proofread ?? [], failures);
  validateNextContexts(pack.nextContexts ?? [], failures);
  validateMixedPolicy(pack.mixedPolicy ?? {}, failures);

  const ambiguousRomanized = [...romanizedMap.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([romanized, variants]) => ({ romanized, candidates: variants.size }))
    .sort((a, b) => b.candidates - a.candidates || a.romanized.localeCompare(b.romanized, "en"));
  if (ambiguousRomanized.length > 0) {
    warnings.push(`multi-candidate romanized keys allowed: ${ambiguousRomanized.length}`);
    validateCandidateRanks(pack, romanizedMapByKind, failures);
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    warnings,
    confidenceDiversity,
    ambiguousRomanizedCount: ambiguousRomanized.length,
    ambiguousRomanizedExamples: ambiguousRomanized.slice(0, 16)
  };
}

function validateProofread(rows, failures) {
  const pairs = new Set();
  const errors = new Set();
  rows.forEach((row, index) => {
    const location = `proofread[${index}]`;
    if (typeof row?.error !== "string" || typeof row?.correction !== "string") {
      failures.push(`${location} must have error and correction strings`);
      return;
    }
    assertNfc(row.error, `${location}.error`, failures);
    assertNfc(row.correction, `${location}.correction`, failures);
    const error = row.error.trim().normalize("NFC");
    const correction = row.correction.trim().normalize("NFC");
    validateDevanagariGraphemes(error, `${location}.error`, failures);
    validateDevanagariGraphemes(correction, `${location}.correction`, failures);
    if (!error || !correction || error === correction) failures.push(`${location} has empty or identity proofread rule`);
    const key = `${error}\0${correction}`;
    if (pairs.has(key)) failures.push(`${location} duplicates proofread rule`);
    pairs.add(key);
    errors.add(error);
  });
  for (const pair of pairs) {
    const [error, correction] = pair.split("\0");
    if (pairs.has(`${correction}\0${error}`)) failures.push(`proofread ping-pong rule ${error} <-> ${correction}`);
    if (errors.has(correction)) failures.push(`proofread correction chain through ${correction}`);
  }
}

function validateNextContexts(rows, failures) {
  const seen = new Set();
  rows.forEach((row, index) => {
    const location = `nextContexts[${index}]`;
    if (typeof row?.context !== "string" || typeof row?.next !== "string") {
      failures.push(`${location} must have context and next strings`);
      return;
    }
    assertNfc(row.context, `${location}.context`, failures);
    assertNfc(row.next, `${location}.next`, failures);
    const context = normalizeRomanized(row.context);
    const next = normalizeRomanized(row.next);
    if (!context || !next) failures.push(`${location} has empty context or next`);
    if (!/^[a-z0-9 .,'’:;!?()/-]+$/.test(`${context} ${next}`)) {
      failures.push(`${location} contains unsupported romanized characters`);
    }
    const key = `${context}\0${next}`;
    if (seen.has(key)) failures.push(`${location} duplicates next context`);
    seen.add(key);
  });
}

function validateMixedPolicy(policy, failures) {
  for (const key of ["preserveAlways", "preferenceTokens"]) {
    const values = Array.isArray(policy[key]) ? policy[key] : [];
    const seen = new Set();
    values.forEach((value, index) => {
      const location = `mixedPolicy.${key}[${index}]`;
      if (typeof value !== "string" || !value.trim()) failures.push(`${location} must be a non-empty string`);
      else assertNfc(value, location, failures);
      const normalized = String(value).trim();
      if (seen.has(normalized)) failures.push(`${location} duplicates ${normalized}`);
      seen.add(normalized);
    });
  }
}

function validateCandidateRanks(pack, romanizedMap, failures) {
  for (const kind of ["words", "phrases", "names"]) {
    const rows = Array.isArray(pack[kind]) ? pack[kind] : [];
    const kindRomanizedMap = romanizedMap.get(kind) ?? new Map();
    const groups = new Map();
    rows.forEach((row, index) => {
      const romanized = normalizeRomanized(row?.romanized ?? "");
      if ((kindRomanizedMap.get(romanized)?.size ?? 0) <= 1) return;
      const group = groups.get(romanized) ?? [];
      group.push({ row, index });
      groups.set(romanized, group);
    });

    for (const [romanized, group] of groups) {
      const expectedSize = kindRomanizedMap.get(romanized)?.size ?? group.length;
      const ranks = new Set();
      for (const { row, index } of group) {
        const location = `${kind}[${index}]`;
        if (!Number.isInteger(row.candidateRank) || row.candidateRank < 1 || row.candidateRank > expectedSize) {
          failures.push(`${location} is in multi-candidate group "${romanized}" but has invalid candidateRank`);
        }
        if (row.candidateGroupSize !== expectedSize) {
          failures.push(`${location} is in multi-candidate group "${romanized}" but candidateGroupSize is not ${expectedSize}`);
        }
        if (ranks.has(row.candidateRank)) {
          failures.push(`${location} duplicates candidateRank ${row.candidateRank} in group "${romanized}"`);
        }
        ranks.add(row.candidateRank);
      }
      for (let rank = 1; rank <= expectedSize; rank += 1) {
        if (!ranks.has(rank)) failures.push(`${kind}.${romanized} missing candidateRank ${rank}`);
      }
    }
  }
}

function validateDevanagariGraphemes(value, location, failures) {
  if (!value) return;
  const malformedMatraSequence = /[\u093E]\u0947|\u094B\u0947|\u093F\u0940|\u0947{2,}/;
  if (malformedMatraSequence.test(value)) {
    failures.push(`${location} contains malformed Devanagari matra sequence`);
  }
  for (const token of String(value).split(/[\s।॥,;:!?()]+/)) {
    if (!token) continue;
    if (/^[\u093A-\u094D\u0951-\u0957\u0962-\u0963]/.test(token)) {
      failures.push(`${location} has orphan Devanagari combining mark at token start: ${token}`);
    }
    if (/\u094D[\u093E-\u094C\u0962-\u0963]/.test(token)) {
      failures.push(`${location} has virama followed directly by a dependent vowel sign: ${token}`);
    }
    for (const cluster of token.split(/(?=[\u0915-\u0939\u0958-\u095F\u0978-\u097F])/u)) {
      if (!cluster) continue;
      const vowelSigns = cluster.match(/[\u093E-\u094C\u0962-\u0963]/g) ?? [];
      if (new Set(vowelSigns).size !== vowelSigns.length) {
        failures.push(`${location} repeats a Devanagari vowel sign in cluster: ${cluster}`);
      }
      if (vowelSigns.length > 1 && !/[\u094D]/.test(cluster)) {
        failures.push(`${location} has conflicting Devanagari vowel signs in cluster: ${cluster}`);
      }
    }
  }
}

function benchmarkBinaryLookup(buffer, queries) {
  const openStart = performance.now();
  const reader = new BinaryReader(buffer);
  const openParseMs = performance.now() - openStart;
  const timings = [];
  const sampleQueries = queries.length > 0 ? queries : ["swasthya"];
  for (let index = 0; index < 6000; index += 1) {
    const query = sampleQueries[index % sampleQueries.length];
    const start = performance.now();
    reader.lookup(query, 8);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return {
    openParseMs: Number(openParseMs.toFixed(4)),
    lookupP50Ms: Number(percentile(timings, 0.5).toFixed(4)),
    lookupP95Ms: Number(percentile(timings, 0.95).toFixed(4)),
    lookupP99Ms: Number(percentile(timings, 0.99).toFixed(4)),
    samples: timings.length
  };
}

class BinaryReader {
  constructor(buffer) {
    if (!buffer.subarray(0, 8).equals(MAGIC)) throw new Error("invalid binary lexicon magic");
    this.buffer = buffer;
    this.entryCount = buffer.readUInt32LE(16);
    this.entryOffset = buffer.readUInt32LE(20);
    this.entryStride = buffer.readUInt32LE(24);
    this.prefixCount = buffer.readUInt32LE(28);
    this.prefixOffset = buffer.readUInt32LE(32);
    this.prefixStride = buffer.readUInt32LE(36);
    this.refOffset = buffer.readUInt32LE(44);
    this.stringOffset = buffer.readUInt32LE(48);
    this.stringBytes = buffer.readUInt32LE(52);
    this.maxPrefixLength = buffer.readUInt32LE(56);
  }

  lookup(query, limit) {
    const normalized = normalizeRomanized(query);
    const exact = this.lookupKey(normalized, limit, true);
    if (exact.length > 0) return exact;
    const prefixKey = normalized.length > this.maxPrefixLength ? normalized.slice(0, this.maxPrefixLength) : normalized;
    return this.lookupKey(prefixKey, limit, false).filter((row) => row.romanized.startsWith(normalized));
  }

  lookupKey(key, limit, exactOnly) {
    let low = 0;
    let high = this.prefixCount - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const current = this.prefixAt(mid);
      if (current === key) {
        const rowOffset = this.prefixOffset + mid * this.prefixStride;
        const start = this.buffer.readUInt32LE(rowOffset + 8);
        const count = this.buffer.readUInt32LE(rowOffset + 12);
        const rows = [];
        for (let index = 0; index < count && rows.length < limit; index += 1) {
          const entryIndex = this.buffer.readUInt32LE(this.refOffset + (start + index) * 4);
          const row = this.entryAt(entryIndex);
          if (!exactOnly || row.romanized === key) rows.push(row);
        }
        return rows;
      }
      if (current < key) low = mid + 1;
      else high = mid - 1;
    }
    return [];
  }

  prefixAt(index) {
    const offset = this.prefixOffset + index * this.prefixStride;
    return this.stringAt(this.buffer.readUInt32LE(offset), this.buffer.readUInt16LE(offset + 4));
  }

  entryAt(index) {
    const offset = this.entryOffset + index * this.entryStride;
    return {
      romanized: this.stringAt(this.buffer.readUInt32LE(offset), this.buffer.readUInt16LE(offset + 4)),
      unicode: this.stringAt(this.buffer.readUInt32LE(offset + 8), this.buffer.readUInt16LE(offset + 6))
    };
  }

  stringAt(offset, length) {
    return this.buffer.toString("utf8", this.stringOffset + offset, this.stringOffset + offset + length);
  }
}

function assertNfc(value, location, failures) {
  if (String(value).normalize("NFC") !== String(value)) failures.push(`${location} is not NFC normalized`);
}

function normalizeRomanized(value) {
  return String(value).toLowerCase().trim().normalize("NFC").replace(/\s+/g, " ");
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function asciiCompare(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function finish(status, details, exitCode) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "node scripts/compile-runtime-lexicon-binary.mjs",
    suite: "runtime-lexicon-binary",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status, report: relative(ROOT, reportPath), ...details }, null, 2));
  process.exit(exitCode);
}

main();
