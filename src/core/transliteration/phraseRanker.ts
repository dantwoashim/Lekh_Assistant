import phrasesRaw from "../../data/phrases/romanized-phrases.tsv?raw";
import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import type { Candidate } from "../types";
import { normalizeCorrectionInput } from "./localCorrectionMemory";

interface PhraseOverride {
  input: string;
  output: string;
  frequency: number;
  domain: string;
  source: string;
  reason: string;
}

const PHRASE_SCORE_BASE = 2200;
const PHRASE_OVERRIDES = parsePhraseOverrides();
const PHRASES_BY_INPUT = new Map(PHRASE_OVERRIDES.map((entry) => [normalizeCorrectionInput(entry.input), entry]));
const MAX_PHRASE_WINDOW = 5;

export interface PhraseMatch {
  input: string;
  output: string;
  normalizedOutput: string;
  range: [number, number];
  tokenRange: [number, number];
  score: number;
  domain: string;
  frequency: number;
  source: string;
  reason: string;
}

export function phraseCandidatesForInput(input: string): Candidate[] {
  if (/\r?\n/.test(input)) return [];
  const normalizedInput = normalizeCorrectionInput(input);
  return PHRASE_OVERRIDES
    .filter((entry) => normalizeCorrectionInput(entry.input) === normalizedInput)
    .map((entry) => ({
      text: entry.output,
      normalizedText: normalizeNepaliText(entry.output),
      score: PHRASE_SCORE_BASE + Math.floor(entry.frequency / 10),
      source: "dictionary",
      reason: entry.reason
    }));
}

export function parsePhraseOverrides(raw = phrasesRaw): PhraseOverride[] {
  const normalized = raw.replace(/^\uFEFF/u, "").trim();
  const [header = "", ...rows] = normalized ? normalized.split(/\r?\n/u) : [];
  if (header.split("\t").join("|") !== "input|output|domain|frequency|source") {
    throw new Error("Phrase pack header must be input, output, domain, frequency, source.");
  }

  return rows.map((line) => {
    const [input, output, domain, frequencyRaw, source] = line.split("\t");
    return {
      input,
      output,
      domain,
      source,
      frequency: Number(frequencyRaw),
      reason: source.includes("mixed") ? "Reviewed mixed English phrase override" : `Reviewed ${domain} phrase override`
    };
  });
}

export function findPhraseMatches(input: string, maxWindow = MAX_PHRASE_WINDOW): PhraseMatch[] {
  if (/\r?\n/.test(input)) return [];
  const tokens = Array.from(input.matchAll(/[A-Za-z][A-Za-z0-9.-]*/g)).map((match) => ({
    text: match[0],
    normalized: normalizeCorrectionInput(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length
  }));
  const matches: PhraseMatch[] = [];
  let index = 0;

  while (index < tokens.length) {
    let accepted: PhraseMatch | undefined;
    const remaining = tokens.length - index;
    for (let size = Math.min(maxWindow, remaining); size >= 2; size -= 1) {
      const window = tokens.slice(index, index + size);
      const key = window.map((token) => token.normalized).join(" ");
      const phrase = PHRASES_BY_INPUT.get(key);
      if (!phrase) continue;
      accepted = {
        input: input.slice(window[0].start, window[window.length - 1].end),
        output: phrase.output,
        normalizedOutput: normalizeNepaliText(phrase.output),
        range: [window[0].start, window[window.length - 1].end],
        tokenRange: [index, index + size],
        score: phraseScore(phrase, size),
        domain: phrase.domain,
        frequency: phrase.frequency,
        source: phrase.source,
        reason: phrase.reason
      };
      break;
    }

    if (accepted) {
      matches.push(accepted);
      index = accepted.tokenRange[1];
    } else {
      index += 1;
    }
  }

  return matches;
}

function phraseScore(phrase: PhraseOverride, tokenLength: number): number {
  const lengthBoost = tokenLength * 80;
  const reviewStatusBoost = phrase.source.includes("manual") ? 180 : 40;
  const domainBoost = /government|legal|education|office|names|places/.test(phrase.domain) ? 80 : 30;
  const frequencyBoost = Math.floor(phrase.frequency / 10);
  return PHRASE_SCORE_BASE + lengthBoost + reviewStatusBoost + domainBoost + frequencyBoost;
}
