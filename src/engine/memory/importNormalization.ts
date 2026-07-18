import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import { normalizeCorrectionInput } from "../../core/transliteration/localCorrectionMemory";
import { sha256Hex } from "../util/sha256";
import { isWellFormedUtf16 } from "../util/utf16";
import {
  MAX_CORRECTION_MEMORY_DECAY_WEIGHT,
  MIN_CORRECTION_MEMORY_DECAY_WEIGHT,
  privacySafeCorrectionMemoryDomain
} from "./types";
import type { CorrectionMemoryEntry, CorrectionMemorySource } from "./types";

const MAXIMUM_MEMORY_IMPORT_ENTRIES = 500;
const MAXIMUM_INPUT_LENGTH = 1024;
const MAXIMUM_OUTPUT_LENGTH = 2048;
const MAXIMUM_REJECTED_ALTERNATIVES = 32;
const MAXIMUM_TIMESTAMP_LENGTH = 64;
const MAXIMUM_PROJECTED_CONTEXT_LENGTH = 16_384;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const CORRECTION_MEMORY_SOURCES = new Set<CorrectionMemorySource>([
  "user-accept",
  "user-edit",
  "user-add-dictionary",
  "proofread-accept",
  "import"
]);

export interface CorrectionMemoryImportOptions {
  defaultTimestamp?: string;
  requireTimestamps?: boolean;
  requireKnownSource?: boolean;
  scoringPolicy?: "clamp" | "strict";
  minimumFrequency?: 0 | 1;
}

/**
 * Identity is derived only from canonical commit semantics. Imported IDs are
 * never trusted because the same supplied ID could otherwise alias unrelated
 * corrections in an ID-keyed JSON or SQLite store.
 */
export function canonicalCorrectionMemoryId(
  normalizedInput: string,
  normalizedOutput: string,
  domain?: string
): string {
  const digest = sha256Hex(JSON.stringify([normalizedInput, normalizedOutput, domain ?? ""]));
  return `kbd-memory-${digest.slice(0, 40)}`;
}

export function normalizeCorrectionMemoryImportEntry(
  value: unknown,
  options: CorrectionMemoryImportOptions = {}
): CorrectionMemoryEntry {
  if (!isRecord(value)) throw new Error("Correction-memory import entry must be an object.");

  const inputRomanized = optionalText(value.inputRomanized, MAXIMUM_INPUT_LENGTH, "inputRomanized", "NFKC");
  const inputPreeti = optionalText(value.inputPreeti, MAXIMUM_INPUT_LENGTH, "inputPreeti", "NFC");
  const suppliedNormalizedInput = optionalText(
    value.normalizedInput,
    MAXIMUM_INPUT_LENGTH,
    "normalizedInput",
    "NFKC"
  );
  // Validate an imported normalizedOutput even though it is recomputed from
  // chosenOutput. This prevents malformed hidden fields from crossing stores.
  optionalText(value.normalizedOutput, MAXIMUM_OUTPUT_LENGTH, "normalizedOutput", "NFC");
  const chosenOutput = requiredText(value.chosenOutput, MAXIMUM_OUTPUT_LENGTH, "chosenOutput", "NFC");
  const normalizedInput = normalizeCorrectionInput(inputRomanized ?? inputPreeti ?? suppliedNormalizedInput ?? "");
  const normalizedOutput = normalizeNepaliText(chosenOutput);
  if (!normalizedInput || normalizedInput.length > MAXIMUM_INPUT_LENGTH || !isWellFormedUtf16(normalizedInput)) {
    throw new Error("Correction-memory import has no valid canonical input.");
  }
  if (!normalizedOutput || normalizedOutput.length > MAXIMUM_OUTPUT_LENGTH || !isWellFormedUtf16(normalizedOutput)) {
    throw new Error("Correction-memory import has no valid canonical output.");
  }

  const context = value.context === undefined ? {} : requiredRecord(value.context, "context");
  validateProjectedContextText(context.leftWindow, "context.leftWindow");
  validateProjectedContextText(context.rightWindow, "context.rightWindow");
  if (context.domain !== undefined && typeof context.domain !== "string") {
    throw new Error("Correction-memory import context.domain must be a string.");
  }
  if (typeof context.domain === "string" && !isWellFormedUtf16(context.domain)) {
    throw new Error("Correction-memory import context.domain contains malformed UTF-16.");
  }
  const domain = privacySafeCorrectionMemoryDomain(context.domain);

  const timestamps = normalizeImportTimestamps(value.timestamps, options);
  const scoringPolicy = options.scoringPolicy ?? "clamp";
  const minimumFrequency = options.minimumFrequency ?? 1;
  const frequency = normalizeFrequency(value.frequency, scoringPolicy, minimumFrequency);
  const confidenceAtSelection = normalizeConfidence(value.confidenceAtSelection, scoringPolicy);
  const decayWeight = normalizeDecayWeight(value.decayWeight, scoringPolicy);
  const knownSource = typeof value.source === "string" &&
    CORRECTION_MEMORY_SOURCES.has(value.source as CorrectionMemorySource);
  if (options.requireKnownSource && !knownSource) {
    throw new Error("Correction-memory import source is invalid.");
  }
  const source = knownSource ? value.source as CorrectionMemorySource : "import";
  const rejectedAlternatives = normalizeRejectedAlternatives(value.rejectedAlternatives, normalizedOutput);

  return {
    id: canonicalCorrectionMemoryId(normalizedInput, normalizedOutput, domain),
    ...(inputRomanized ? { inputRomanized } : {}),
    ...(inputPreeti ? { inputPreeti } : {}),
    chosenOutput: normalizedOutput,
    normalizedInput,
    normalizedOutput,
    rejectedAlternatives,
    context: { leftWindow: "", rightWindow: "", ...(domain ? { domain } : {}) },
    source,
    frequency,
    confidenceAtSelection,
    timestamps,
    ...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}),
    ...(typeof value.blocked === "boolean" ? { blocked: value.blocked } : {}),
    decayWeight
  };
}

export function normalizeCorrectionMemoryImportEntries(
  values: unknown,
  options: CorrectionMemoryImportOptions = {}
): CorrectionMemoryEntry[] {
  if (!Array.isArray(values)) throw new Error("Correction-memory import entries must be an array.");
  if (values.length > MAXIMUM_MEMORY_IMPORT_ENTRIES) {
    throw new Error(`Correction-memory import exceeds ${MAXIMUM_MEMORY_IMPORT_ENTRIES} entries.`);
  }

  const byId = new Map<string, CorrectionMemoryEntry>();
  for (const value of values) {
    const entry = normalizeCorrectionMemoryImportEntry(value, options);
    const previous = byId.get(entry.id);
    if (!previous) {
      byId.set(entry.id, entry);
      continue;
    }
    if (correctionMemorySemanticKey(previous) !== correctionMemorySemanticKey(entry)) {
      throw new Error("Correction-memory import produced a canonical ID collision.");
    }
    byId.set(entry.id, mergeDuplicateImport(previous, entry));
  }
  return [...byId.values()];
}

export function canonicalIsoTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, MAXIMUM_TIMESTAMP_LENGTH, label, "NFC");
  const match = ISO_INSTANT.exec(text);
  if (!match) throw new Error(`Correction-memory import ${label} must be an ISO 8601 instant.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] ? Number(match[10]) : 0;
  const offsetMinute = match[9] ? Number(match[11]) : 0;
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw new Error(`Correction-memory import ${label} is not a valid ISO 8601 instant.`);
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Correction-memory import ${label} is not a valid ISO 8601 instant.`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizeImportTimestamps(
  value: unknown,
  options: CorrectionMemoryImportOptions
): CorrectionMemoryEntry["timestamps"] {
  const requireTimestamps = options.requireTimestamps ?? false;
  const fallback = options.defaultTimestamp === undefined
    ? new Date().toISOString()
    : canonicalIsoTimestamp(options.defaultTimestamp, "defaultTimestamp");
  if (value === undefined && requireTimestamps) {
    throw new Error("Correction-memory import timestamps are required.");
  }
  const timestamps = value === undefined ? {} : requiredRecord(value, "timestamps");
  if (requireTimestamps && (timestamps.firstSeen === undefined || timestamps.lastUsed === undefined)) {
    throw new Error("Correction-memory import requires firstSeen and lastUsed timestamps.");
  }
  const firstSeen = canonicalIsoTimestamp(timestamps.firstSeen ?? fallback, "timestamps.firstSeen");
  const lastUsed = canonicalIsoTimestamp(timestamps.lastUsed ?? fallback, "timestamps.lastUsed");
  if (firstSeen > lastUsed) {
    throw new Error("Correction-memory import firstSeen must not be later than lastUsed.");
  }
  return { firstSeen, lastUsed };
}

function normalizeFrequency(value: unknown, policy: "clamp" | "strict", minimum: 0 | 1): number {
  if (policy === "strict") {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      throw new Error("Correction-memory import frequency is out of range.");
    }
    return value as number;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
    : Math.max(1, minimum);
}

function normalizeConfidence(value: unknown, policy: "clamp" | "strict"): number {
  if (policy === "strict") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("Correction-memory import confidence is out of range.");
    }
    return value;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.8;
}

function normalizeDecayWeight(value: unknown, policy: "clamp" | "strict"): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (policy === "strict") throw new Error("Correction-memory import decay weight is invalid.");
    return 1;
  }
  if (
    policy === "strict" &&
    (value < MIN_CORRECTION_MEMORY_DECAY_WEIGHT || value > MAX_CORRECTION_MEMORY_DECAY_WEIGHT)
  ) {
    throw new Error("Correction-memory import decay weight is out of range.");
  }
  return Math.max(MIN_CORRECTION_MEMORY_DECAY_WEIGHT, Math.min(MAX_CORRECTION_MEMORY_DECAY_WEIGHT, value));
}

function normalizeRejectedAlternatives(value: unknown, chosenOutput: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_REJECTED_ALTERNATIVES) {
    throw new Error("Correction-memory import rejectedAlternatives is out of range.");
  }
  const alternatives = value.map((item) => {
    const normalized = normalizeNepaliText(requiredText(
      item,
      MAXIMUM_OUTPUT_LENGTH,
      "rejectedAlternatives item",
      "NFC"
    ));
    if (!normalized) throw new Error("Correction-memory import rejectedAlternatives contains an empty value.");
    return normalized;
  });
  return [...new Set(alternatives)].filter((item) => item !== chosenOutput);
}

function mergeDuplicateImport(
  previous: CorrectionMemoryEntry,
  incoming: CorrectionMemoryEntry
): CorrectionMemoryEntry {
  const latest = incoming.timestamps.lastUsed >= previous.timestamps.lastUsed ? incoming : previous;
  return {
    ...latest,
    id: previous.id,
    inputRomanized: latest.inputRomanized ?? previous.inputRomanized,
    inputPreeti: latest.inputPreeti ?? previous.inputPreeti,
    rejectedAlternatives: [...new Set([
      ...previous.rejectedAlternatives,
      ...incoming.rejectedAlternatives
    ])].slice(0, MAXIMUM_REJECTED_ALTERNATIVES),
    frequency: Math.max(previous.frequency, incoming.frequency),
    confidenceAtSelection: Math.max(previous.confidenceAtSelection, incoming.confidenceAtSelection),
    timestamps: {
      firstSeen: previous.timestamps.firstSeen < incoming.timestamps.firstSeen
        ? previous.timestamps.firstSeen
        : incoming.timestamps.firstSeen,
      lastUsed: previous.timestamps.lastUsed > incoming.timestamps.lastUsed
        ? previous.timestamps.lastUsed
        : incoming.timestamps.lastUsed
    },
    pinned: Boolean(previous.pinned || incoming.pinned),
    blocked: Boolean(previous.blocked || incoming.blocked),
    decayWeight: Math.max(previous.decayWeight ?? 1, incoming.decayWeight ?? 1)
  };
}

function correctionMemorySemanticKey(entry: CorrectionMemoryEntry): string {
  return JSON.stringify([
    entry.normalizedInput,
    entry.normalizedOutput,
    entry.context.domain ?? ""
  ]);
}

function requiredText(
  value: unknown,
  maximumLength: number,
  label: string,
  normalization: "NFC" | "NFKC"
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`Correction-memory import ${label} must be a non-empty bounded string.`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new Error(`Correction-memory import ${label} contains malformed UTF-16.`);
  }
  const normalized = value.normalize(normalization);
  if (!normalized || normalized.length > maximumLength || !isWellFormedUtf16(normalized)) {
    throw new Error(`Correction-memory import ${label} is invalid after Unicode normalization.`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  maximumLength: number,
  label: string,
  normalization: "NFC" | "NFKC"
): string | undefined {
  return value === undefined ? undefined : requiredText(value, maximumLength, label, normalization);
}

function validateProjectedContextText(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length > MAXIMUM_PROJECTED_CONTEXT_LENGTH ||
    !isWellFormedUtf16(value)
  ) {
    throw new Error(`Correction-memory import ${label} must be bounded, well-formed UTF-16.`);
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Correction-memory import ${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
