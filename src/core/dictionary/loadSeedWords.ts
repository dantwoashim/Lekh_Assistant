import seedWordsRaw from "../../data/wordlists/ne-seed.tsv?raw";
import aliasesRaw from "../../data/aliases/romanized-aliases.tsv?raw";
import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import type { SuggestionDomain, WordEntry } from "../types";

const VALID_DOMAINS: SuggestionDomain[] = ["common", "government", "education", "legal", "office", "names", "places"];

export interface WordlistValidationIssue {
  line: number;
  message: string;
}

interface RomanizedAlias {
  word: string;
  romanized: string;
  frequencyBoost: number;
  domain: SuggestionDomain;
  source: string;
}

export function parseSeedWords(raw = seedWordsRaw): WordEntry[] {
  const [header = "", ...rows] = tsvLines(raw);
  const columns = header.split("\t");
  if (columns.join("|") !== "word|romanized|frequency|domain|source") {
    throw new Error("Seed wordlist header must be word, romanized, frequency, domain, source.");
  }

  return rows.map((line, index) => {
    const [word, romanized, frequencyRaw, domainRaw, source] = line.split("\t");
    const frequency = Number(frequencyRaw);
    const domain = domainRaw as SuggestionDomain;
    return {
      word,
      normalizedWord: normalizeNepaliText(word),
      romanized,
      frequency,
      score: frequency,
      domain,
      source
    };
  });
}

export function validateWordlist(entries = parseSeedWords()): WordlistValidationIssue[] {
  const issues: WordlistValidationIssue[] = [];
  const seenWords = new Set<string>();

  entries.forEach((entry, index) => {
    const line = index + 2;
    if (!entry.word || !entry.romanized || !entry.source) {
      issues.push({ line, message: "word, romanized, and source are required." });
    }
    if (!Number.isFinite(entry.frequency)) {
      issues.push({ line, message: "frequency must be numeric." });
    }
    if (!VALID_DOMAINS.includes(entry.domain)) {
      issues.push({ line, message: `domain must be one of ${VALID_DOMAINS.join(", ")}.` });
    }
    if (!/[\u0900-\u097F]/.test(entry.word)) {
      issues.push({ line, message: "word must contain Devanagari." });
    }
    if (entry.normalizedWord !== normalizeNepaliText(entry.word)) {
      issues.push({ line, message: "normalizedWord does not match normalizeNepaliText(word)." });
    }
    if (seenWords.has(entry.normalizedWord)) {
      issues.push({ line, message: `duplicate normalized word ${entry.normalizedWord}.` });
    }
    seenWords.add(entry.normalizedWord);
  });

  return issues;
}

const seedWords = parseSeedWords();
export function parseRomanizedAliases(raw = aliasesRaw): RomanizedAlias[] {
  const [header = "", ...rows] = tsvLines(raw);
  if (header.split("\t").join("|") !== "word|romanized|frequencyBoost|domain|source") {
    throw new Error("Romanized alias header must be word, romanized, frequencyBoost, domain, source.");
  }

  return rows.map((line) => {
    const [word, romanized, frequencyBoostRaw, domainRaw, source] = line.split("\t");
    const domain = domainRaw as SuggestionDomain;
    return {
      word,
      romanized,
      frequencyBoost: Number(frequencyBoostRaw),
      domain,
      source
    };
  });
}

function tsvLines(raw: string): string[] {
  const normalized = raw.replace(/^\uFEFF/u, "").trim();
  return normalized ? normalized.split(/\r?\n/u) : [];
}

const aliasEntries = parseRomanizedAliases().flatMap((alias) => {
  const entry = seedWords.find((word) => word.normalizedWord === normalizeNepaliText(alias.word));
  if (!entry) return [];
  const frequency = Math.max(1, entry.frequency + (alias.frequencyBoost ?? 0));
  return {
    ...entry,
    romanized: alias.romanized,
    frequency,
    score: frequency,
    domain: alias.domain || entry.domain,
    source: `${alias.source}:alias`
  };
});

export const wordEntries: WordEntry[] = [...seedWords, ...aliasEntries];
export const primaryWordEntries: WordEntry[] = seedWords;

export const wordsByNormalized = new Map<string, WordEntry>();
for (const entry of seedWords) {
  wordsByNormalized.set(entry.normalizedWord, entry);
}

export const wordsByRomanized = new Map<string, WordEntry[]>();
for (const entry of wordEntries) {
  const key = entry.romanized?.toLowerCase();
  if (!key) continue;
  const existing = wordsByRomanized.get(key) ?? [];
  existing.push(entry);
  existing.sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source) || b.frequency - a.frequency);
  wordsByRomanized.set(key, existing);
}

export function lookupByRomanized(romanized: string): WordEntry[] {
  const seen = new Set<string>();
  const matches: WordEntry[] = [];
  for (const key of buildLookupKeys(romanized)) {
    for (const entry of wordsByRomanized.get(key) ?? []) {
      const dedupeKey = `${entry.normalizedWord}:${entry.romanized}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      matches.push(entry);
    }
    if (matches.length > 0) break;
  }
  return matches;
}

export function hasDictionaryWord(word: string): boolean {
  return wordsByNormalized.has(normalizeNepaliText(word));
}

function buildLookupKeys(romanized: string): string[] {
  const key = romanized.toLowerCase();
  const variants = new Set<string>([key]);
  const shToS = key.replace(/sh/g, "s");
  variants.add(shToS);
  variants.add(key.replace(/f/g, "ph"));
  variants.add(key.replace(/w/g, "v"));
  variants.add(key.replace(/b/g, "v"));

  for (const variant of Array.from(variants)) {
    if (!variant.endsWith("a")) variants.add(`${variant}a`);
  }

  return Array.from(variants);
}

function sourcePriority(source: string): number {
  if (source.includes("manual-alias")) return 5;
  if (source.includes("manual-pack")) return 4;
  if (source === "seed" || source.includes("seed")) return 3;
  if (source === "dictionary-ne-ranked" || source.includes("dictionary-ne@2.0.0:ranked-hunspell")) return 2;
  return 1;
}
