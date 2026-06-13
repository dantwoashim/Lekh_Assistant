import ngramModel from "../../data/keyboard-packs/v0.1/ngram-lm.json";
import { isSecureContext } from "./modes";
import { romanizedCanonicalKey } from "./romanizationTolerance";
import type { Candidate, InlineCompletion, KeyboardSession, TypingContext } from "./types";

type ScriptKind = "devanagari" | "romanized";

interface NgramRow {
  k: ScriptKind;
  c: string;
  n: string;
  r?: string;
  q: number;
  f: number;
  s: string;
}

interface NgramModel {
  version: string;
  rows: NgramRow[];
}

interface CompletionMatch {
  row: NgramRow;
  contextLength: number;
}

const model = ngramModel as NgramModel;
const MAX_NEXT_WORDS = 4;
const CURATED_NEXT_WORDS: Array<{
  kind: ScriptKind;
  context: string;
  next: string;
  romanized?: string;
  confidence: number;
}> = [
  { kind: "devanagari", context: "नेपाल", next: "सरकार", romanized: "sarkar", confidence: 0.97 },
  { kind: "romanized", context: "nepal", next: "सरकार", romanized: "sarkar", confidence: 0.97 },
  { kind: "devanagari", context: "जिल्ला", next: "प्रशासन", romanized: "prashasan", confidence: 0.97 },
  { kind: "romanized", context: "jilla", next: "प्रशासन", romanized: "prashasan", confidence: 0.97 },
  { kind: "devanagari", context: "स्वास्थ्य", next: "कार्यालय", romanized: "karyalaya", confidence: 0.96 },
  { kind: "romanized", context: "swasthya", next: "कार्यालय", romanized: "karyalaya", confidence: 0.96 },
  { kind: "devanagari", context: "जन्म", next: "दर्ता", romanized: "darta", confidence: 0.96 },
  { kind: "romanized", context: "janma", next: "दर्ता", romanized: "darta", confidence: 0.96 },
  { kind: "devanagari", context: "मृत्यु", next: "दर्ता", romanized: "darta", confidence: 0.96 },
  { kind: "romanized", context: "mrityu", next: "दर्ता", romanized: "darta", confidence: 0.96 }
];

let index: Map<string, NgramRow[]> | undefined;

export function inlineCompletionForSession(session: KeyboardSession, primary?: Candidate): InlineCompletion | undefined {
  if (!session.context.enableNextWordPrediction || isSecureContext(session.context)) return undefined;

  const activeCompletion = activeCandidateInlineCompletion(session, primary);
  if (activeCompletion) return activeCompletion;

  const nextWord = nextWordCandidatesFromContext(session.context, 1)[0];
  if (!nextWord) return undefined;
  return {
    text: nextWord.text,
    displayText: nextWord.text,
    contextText: nextWord.reason.find((reason) => reason.startsWith("context:"))?.slice("context:".length) ?? "",
    candidate: nextWord,
    confidence: nextWord.confidence,
    source: "ngram-lm",
    acceptKeys: ["Tab", "Enter"]
  };
}

export function nextWordCandidatesFromContext(context: TypingContext, limit = MAX_NEXT_WORDS): Candidate[] {
  if (!context.enableNextWordPrediction || isSecureContext(context)) return [];
  const leftWindow = context.leftTextWindow ?? "";
  if (!leftWindow || !/\s$/.test(leftWindow)) return [];
  return ngramCandidatesForText(leftWindow, context, limit);
}

export function nextWordCandidatesForCommittedText(committedText: string, session: KeyboardSession, limit = MAX_NEXT_WORDS): Candidate[] {
  if (!session.context.enableNextWordPrediction || isSecureContext(session.context)) return [];
  const history = [...session.committedHistory, committedText]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const textWindow = history ? `${history} ` : committedText;
  return ngramCandidatesForText(textWindow, session.context, limit);
}

export function ngramModelVersion(): string {
  return model.version;
}

function activeCandidateInlineCompletion(session: KeyboardSession, primary?: Candidate): InlineCompletion | undefined {
  const activeText = session.compositionText;
  const trimmed = activeText.trimEnd();
  if (!trimmed || !primary || primary.type === "protected" || primary.text.trim() === trimmed.trim()) return undefined;
  const displayText = inlineDisplayText(trimmed, activeText.slice(trimmed.length), primary.text);
  if (!displayText) return undefined;
  return {
    text: primary.text,
    displayText,
    contextText: session.context.leftTextWindow ?? "",
    candidate: {
      ...primary,
      id: `${primary.id}-inline`,
      type: primary.type === "romanized-helper" ? "completion" : primary.type,
      reason: [...primary.reason, "Inline active composition preview"]
    },
    confidence: primary.confidence,
    source: "active-candidate",
    acceptKeys: ["Tab", "Enter"]
  };
}

function inlineDisplayText(activeText: string, trailingWhitespace: string, suggestion: string): string {
  if (!suggestion || suggestion.trim() === activeText.trim()) return "";
  if (suggestion.startsWith(activeText)) return `${trailingWhitespace}${suggestion.slice(activeText.length)}`;
  return `  ${suggestion}`;
}

function ngramCandidatesForText(textWindow: string, context: TypingContext, limit: number): Candidate[] {
  const suffix = contextSuffix(textWindow);
  if (!suffix) return [];
  const curated = curatedCandidatesForSuffix(suffix, context);
  const matches: CompletionMatch[] = [];
  for (const candidateContext of suffixes(suffix.text, suffix.kind)) {
    const bucket = modelIndex().get(indexKey(suffix.kind, candidateContext)) ?? [];
    for (const row of bucket) {
      matches.push({ row, contextLength: candidateContext.split(" ").length });
      if (matches.length >= limit * 4) break;
    }
    if (matches.length >= limit * 4) break;
  }
  const modelCandidates = matches
    .sort((left, right) =>
      right.contextLength - left.contextLength ||
      rowConfidence(right.row) - rowConfidence(left.row) ||
      Math.log1p(right.row.f) - Math.log1p(left.row.f) ||
      left.row.n.localeCompare(right.row.n, "ne")
    )
    .slice(0, limit)
    .map(({ row, contextLength }, index): Candidate => ({
      id: `ngram-next-${index}-${row.k}-${row.c}-${row.n}`,
      text: row.n,
      label: context.showRomanizedLabels ? row.r : undefined,
      type: row.n.includes(" ") ? "phrase" : "completion",
      confidence: Math.min(0.96, rowConfidence(row) + contextLength * 0.012),
      reason: [`local n-gram ${model.version}`, `source:${row.s}`, `context:${row.c}`],
      shortcut: String(index + 1),
      replaceRange: [0, 0]
    }));
  return dedupeNextWordCandidates([...curated, ...modelCandidates], limit);
}

function curatedCandidatesForSuffix(suffix: { kind: ScriptKind; text: string }, context: TypingContext): Candidate[] {
  const suffixValues = suffixes(suffix.text, suffix.kind);
  return CURATED_NEXT_WORDS
    .filter((row) => row.kind === suffix.kind && suffixValues.includes(row.context))
    .map((row, index): Candidate => ({
      id: `ngram-curated-${index}-${row.kind}-${row.context}-${row.next}`,
      text: row.next,
      label: context.showRomanizedLabels ? row.romanized : undefined,
      type: "completion",
      confidence: row.confidence,
      reason: [`local n-gram curated Nepali next-word seed`, `context:${row.context}`],
      shortcut: String(index + 1),
      replaceRange: [0, 0]
    }));
}

function dedupeNextWordCandidates(candidates: Candidate[], limit: number): Candidate[] {
  const output: Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.text.normalize("NFC");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...candidate,
      shortcut: String(output.length + 1)
    });
    if (output.length >= limit) break;
  }
  return output;
}

function contextSuffix(textWindow: string): { kind: ScriptKind; text: string } | undefined {
  const trimmed = textWindow.normalize("NFC").trim();
  if (!trimmed) return undefined;
  const tokens = trimmed.match(/[\u0900-\u097F]+|[A-Za-z0-9]+/g) ?? [];
  if (tokens.length === 0) return undefined;
  const devanagariCount = tokens.filter((token) => /[\u0900-\u097F]/.test(token)).length;
  const kind: ScriptKind = devanagariCount >= Math.max(1, tokens.length - devanagariCount) ? "devanagari" : "romanized";
  const normalizedTokens = tokens
    .filter((token) => kind === "devanagari" ? /[\u0900-\u097F]/.test(token) : /^[A-Za-z0-9]+$/.test(token))
    .map((token) => kind === "devanagari" ? normalizeDevanagariToken(token) : normalizeRomanizedToken(token))
    .filter(Boolean)
    .slice(-4);
  if (normalizedTokens.length === 0) return undefined;
  return { kind, text: normalizedTokens.join(" ") };
}

function suffixes(value: string, kind: ScriptKind): string[] {
  const tokens = value.split(" ").filter(Boolean);
  const output: string[] = [];
  for (let length = Math.min(4, tokens.length); length >= 1; length -= 1) {
    output.push(tokens.slice(-length).join(" "));
  }
  if (kind === "romanized") {
    return output.map((item) => normalizeRomanizedPhrase(item));
  }
  return output;
}

function modelIndex(): Map<string, NgramRow[]> {
  if (index) return index;
  index = new Map<string, NgramRow[]>();
  for (const row of model.rows) {
    const key = indexKey(row.k, row.c);
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  for (const [key, rows] of index.entries()) {
    index.set(
      key,
      rows.sort((left, right) =>
        rowConfidence(right) - rowConfidence(left) ||
        Math.log1p(right.f) - Math.log1p(left.f) ||
        left.n.localeCompare(right.n, "ne")
      ).slice(0, MAX_NEXT_WORDS * 2)
    );
  }
  return index;
}

function indexKey(kind: ScriptKind, context: string): string {
  return `${kind}:${context}`;
}

function rowConfidence(row: NgramRow): number {
  return Math.max(0.3, Math.min(0.98, row.q / 255));
}

function normalizeRomanizedPhrase(value: string): string {
  return value.split(" ").map(normalizeRomanizedToken).filter(Boolean).join(" ");
}

function normalizeRomanizedToken(value: string): string {
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
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return romanizedCanonicalKey(tokenMap[normalized] ?? normalized);
}

function normalizeDevanagariToken(value: string): string {
  return value.normalize("NFC").replace(/[^\u0900-\u097F]+/g, "");
}
