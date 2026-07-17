import { lookupByRomanized, wordsByNormalized } from "../../core/dictionary/loadSeedWords";
import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import { loadLexicalAuthority } from "../lexicon";
import { queryLexiconByRomanized, queryRuntimeDictionary } from "../lexicon/authority";
import { isSecureContext } from "./modes";
import type { DictionaryResult, TypingContext } from "./types";

const LOOKUP_CACHE_MAX = 512;
const lookupCache = new Map<string, DictionaryResult[]>();

export function lookupKeyboardDictionary(query: string, context?: TypingContext): DictionaryResult[] {
  const trimmed = query.trim();
  if (!trimmed || (context ? isSecureContext(context) : false)) return [];

  const normalized = normalizeNepaliText(trimmed);
  const cacheKey = `${normalized}\u0000${trimmed.toLowerCase()}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached.map((row) => ({ ...row, romanized: row.romanized?.slice(), variants: row.variants?.slice(), domains: row.domains?.slice() }));

  const byRomanized = [
    ...queryRuntimeDictionary(trimmed),
    ...queryLexiconByRomanized(loadLexicalAuthority(), trimmed)
  ];
  const byUnicode = wordsByNormalized.get(normalized);
  const rows = byUnicode
    ? [{
      query: trimmed,
      word: byUnicode.normalizedWord,
      romanized: byUnicode.romanized ? [byUnicode.romanized] : [],
      domains: [byUnicode.domain],
      source: byUnicode.source,
      confidence: 0.94
    }]
    : byRomanized.map((entry) => ({
      query: trimmed,
      word: entry.word,
      romanized: entry.romanizations,
      domains: entry.domains,
      source: entry.source,
      confidence: entry.reviewStatus === "reviewed" ? 0.92 : 0.72
    }));

  const fallback = lookupByRomanized(trimmed).map((entry) => ({
    query: trimmed,
    word: entry.normalizedWord,
    romanized: entry.romanized ? [entry.romanized] : [],
    domains: [entry.domain],
    source: entry.source,
    confidence: entry.source.includes("dictionary-ne") ? 0.68 : 0.88
  }));

  const result = dedupe([...rows, ...fallback]).slice(0, 8);
  cacheLookup(cacheKey, result);
  return result.map((row) => ({ ...row, romanized: row.romanized?.slice(), variants: row.variants?.slice(), domains: row.domains?.slice() }));
}

function dedupe(rows: DictionaryResult[]): DictionaryResult[] {
  const seen = new Set<string>();
  const result: DictionaryResult[] = [];
  for (const row of rows) {
    const key = row.word.normalize("NFC");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result.sort((a, b) => b.confidence - a.confidence || a.word.localeCompare(b.word, "ne"));
}

function cacheLookup(key: string, rows: DictionaryResult[]): void {
  if (lookupCache.has(key)) lookupCache.delete(key);
  lookupCache.set(key, rows.map((row) => ({ ...row, romanized: row.romanized?.slice(), variants: row.variants?.slice(), domains: row.domains?.slice() })));
  if (lookupCache.size > LOOKUP_CACHE_MAX) {
    const oldest = lookupCache.keys().next().value;
    if (oldest) lookupCache.delete(oldest);
  }
}
