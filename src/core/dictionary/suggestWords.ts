import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import type { Suggestion } from "../types";
import { wordEntries } from "./loadSeedWords";

const DOMAIN_BOOST: Record<Suggestion["domain"], number> = {
  names: 18,
  places: 20,
  government: 35,
  office: 28,
  education: 24,
  legal: 22,
  common: 16
};

const SUGGESTION_CACHE_MAX = 512;
const suggestionCache = new Map<string, Suggestion[]>();
let prefixIndex: PrefixIndex | null = null;

interface IndexedSuggestion extends Suggestion {
  searchRomanized: string;
  searchWord: string;
}

interface PrefixIndex {
  romanizedBuckets: Map<string, IndexedSuggestion[]>;
  devanagariBuckets: Map<string, IndexedSuggestion[]>;
}

export function suggestWords(prefix: string, limit = 8): Suggestion[] {
  const normalizedPrefix = normalizeNepaliText(prefix).trim().toLowerCase();
  if (!normalizedPrefix) return [];
  const cacheKey = `${normalizedPrefix}\u0000${limit}`;
  const cached = suggestionCache.get(cacheKey);
  if (cached) return cached.map((suggestion) => ({ ...suggestion }));

  const index = getPrefixIndex();
  const isDevanagari = /[\u0900-\u097F]/.test(normalizedPrefix);
  const bucket = isDevanagari
    ? index.devanagariBuckets.get(bucketKey(normalizedPrefix)) ?? []
    : index.romanizedBuckets.get(bucketKey(normalizedPrefix)) ?? [];

  const suggestions = bucket
    .filter((entry) => isDevanagari
      ? entry.searchWord.startsWith(normalizedPrefix)
      : entry.searchRomanized.startsWith(normalizedPrefix))
    .sort((a, b) => b.score - a.score || a.normalizedWord.localeCompare(b.normalizedWord))
    .slice(0, limit)
    .map(({ searchRomanized: _searchRomanized, searchWord: _searchWord, ...suggestion }) => suggestion);
  cacheSuggestion(cacheKey, suggestions);
  return suggestions.map((suggestion) => ({ ...suggestion }));
}

function getPrefixIndex(): PrefixIndex {
  if (prefixIndex) return prefixIndex;
  const romanizedBuckets = new Map<string, IndexedSuggestion[]>();
  const devanagariBuckets = new Map<string, IndexedSuggestion[]>();
  for (const entry of wordEntries) {
    const indexed: IndexedSuggestion = {
      word: entry.word,
      normalizedWord: entry.normalizedWord,
      romanized: entry.romanized,
      source: entry.source,
      domain: entry.domain,
      score: entry.frequency + DOMAIN_BOOST[entry.domain] + sourceBoost(entry.source),
      searchRomanized: entry.romanized?.toLowerCase() ?? "",
      searchWord: entry.normalizedWord
    };
    if (indexed.searchRomanized) addToBucket(romanizedBuckets, indexed.searchRomanized, indexed);
    addToBucket(devanagariBuckets, indexed.searchWord, indexed);
  }
  prefixIndex = { romanizedBuckets, devanagariBuckets };
  return prefixIndex;
}

function addToBucket(buckets: Map<string, IndexedSuggestion[]>, searchText: string, suggestion: IndexedSuggestion): void {
  const keys = new Set<string>();
  for (let length = 1; length <= Math.min(2, searchText.length); length += 1) {
    keys.add(searchText.slice(0, length));
  }
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(suggestion);
    } else {
      buckets.set(key, [suggestion]);
    }
  }
}

function bucketKey(value: string): string {
  return value.slice(0, Math.min(2, value.length));
}

function cacheSuggestion(key: string, suggestions: Suggestion[]): void {
  if (suggestionCache.has(key)) suggestionCache.delete(key);
  suggestionCache.set(key, suggestions.map((suggestion) => ({ ...suggestion })));
  if (suggestionCache.size > SUGGESTION_CACHE_MAX) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest) suggestionCache.delete(oldest);
  }
}

function sourceBoost(source: string): number {
  if (source.includes("manual-alias")) return 80;
  if (source.includes("manual-pack")) return 70;
  if (source === "seed" || source.includes("seed")) return 60;
  return 0;
}

export function currentRomanizedToken(input: string): string {
  const match = input.match(/[A-Za-z]+$/);
  return match?.[0] ?? "";
}

export function replaceCurrentRomanizedToken(input: string, replacement: string): string {
  if (!replacement) return input;
  if (/[A-Za-z]+$/.test(input)) {
    return input.replace(/[A-Za-z]+$/, replacement);
  }
  const separator = input.length === 0 || /\s$/.test(input) ? "" : " ";
  return `${input}${separator}${replacement}`;
}

export function currentDevanagariToken(input: string): string {
  const match = normalizeNepaliText(input).match(/[\u0900-\u097F]+$/);
  return match?.[0] ?? "";
}
