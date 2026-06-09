import type { EngineDiagnostic } from "../types";
import { isKnownEnglishPreserveWord, isLikelyEnglishRun } from "./english";
import { parseEnglishNepaliSuffix } from "./englishSuffix";
import { mergeAdjacentCompatibleSpans } from "./merge";
import { classifyNumericLike } from "./numbers";
import { isHardBoundaryPunctuation, isPunctuationOnly, isWhitespace } from "./punctuation";
import { scorePreetiIsland } from "./preetiIsland";
import { findProtectedLikeSpans } from "./protectedLike";
import { classifyRomanizedRun } from "./romanizedIsland";
import { legalActionsForKind } from "./scoring";
import { traceSpan } from "./trace";
import { hasDevanagari, isDevanagari } from "./unicodeNepali";
import type { ProtectedLikeMatch, SegmentationResult, SegmenterOptions, SpanKind, TypedSpan } from "./types";

export function segmentDocument(input: string, options: SegmenterOptions = {}): SegmentationResult {
  const protectedMatches = findProtectedLikeSpans(input);
  const rawSpans: TypedSpan[] = [];
  const diagnostics: EngineDiagnostic[] = [];
  let cursor = 0;

  for (const match of protectedMatches) {
    if (cursor < match.range[0]) {
      rawSpans.push(...segmentGap(input.slice(cursor, match.range[0]), cursor, options));
    }
    rawSpans.push(spanFromProtectedMatch(match, rawSpans.length));
    cursor = match.range[1];
  }

  if (cursor < input.length) {
    rawSpans.push(...segmentGap(input.slice(cursor), cursor, options));
  }

  const spans = mergeAdjacentCompatibleSpans(rawSpans);
  const coverage = spans.map((span) => span.text).join("");
  if (coverage !== input) {
    diagnostics.push({
      code: "SEGMENTATION_COVERAGE_ERROR",
      message: "Universal span segmenter did not preserve byte-for-byte input coverage.",
      severity: "error",
      data: { inputLength: input.length, coverageLength: coverage.length }
    });
  }

  return {
    input,
    spans,
    diagnostics,
    trace: spans.map(traceSpan)
  };
}

function segmentGap(text: string, offset: number, options: SegmenterOptions): TypedSpan[] {
  const spans: TypedSpan[] = [];
  let index = 0;
  let previousWord: string | undefined;
  while (index < text.length) {
    const start = index;
    const char = text[index];
    if (/\s/.test(char)) {
      while (index < text.length && /\s/.test(text[index])) index += 1;
      spans.push(makeSpan("whitespace", text.slice(start, index), offset + start, 1, "Whitespace is preserved.", {}));
      continue;
    }
    if (isHardBoundaryPunctuation(char)) {
      index += 1;
      spans.push(makeSpan("punctuation", text.slice(start, index), offset + start, 1, "Boundary punctuation is preserved.", {}));
      continue;
    }
    while (index < text.length && !/\s/.test(text[index]) && !isHardBoundaryPunctuation(text[index])) {
      index += 1;
    }
    const token = text.slice(start, index);
    const tokenSpans = segmentToken(token, offset + start, previousWord, options);
    const wordMatches = token.match(/[A-Za-z]+/g);
    const wordLike = wordMatches ? wordMatches[wordMatches.length - 1] : undefined;
    if (wordLike) previousWord = wordLike;
    spans.push(...tokenSpans);
  }
  return spans;
}

function segmentToken(token: string, offset: number, previousWord: string | undefined, options: SegmenterOptions): TypedSpan[] {
  if (isWhitespace(token)) return [makeSpan("whitespace", token, offset, 1, "Whitespace is preserved.", {})];
  const numericKind = classifyNumericLike(token);
  if (numericKind) return [makeSpan(numericKind, token, offset, 0.9, "Numeric/structured token is preserved by default.", {})];
  if (isPunctuationOnly(token) && !hasPreetiSignalPunctuation(token)) {
    return [makeSpan("punctuation", token, offset, 0.98, "Punctuation is preserved.", {})];
  }
  if (hasDevanagari(token) && /[^\u0900-\u097F\s]/.test(token)) {
    return segmentMixedUnicodeToken(token, offset);
  }
  if (hasDevanagari(token)) {
    return [makeSpan("unicode-nepali", token, offset, 0.98, "Existing Unicode Nepali span passes through proofread only.", {})];
  }
  const suffix = parseEnglishNepaliSuffix(token, previousWord);
  if (suffix) {
    return [makeSpan("english-with-nepali-suffix", token, offset, suffix.confidence, suffix.reason, {
      stem: suffix.stem,
      suffixInput: suffix.suffixInput,
      suffixOutput: suffix.suffixOutput
    })];
  }
  const preetiScore = scorePreetiIsland(token, { surroundingNepali: options.surroundingMode === "mixed-office" || options.mode === "mixed-unicode-legacy-repair" });
  if (preetiScore.shouldConvert) {
    return [makeSpan("preeti-legacy", token, offset, preetiScore.confidence, preetiScore.reason, preetiScore.features)];
  }
  if (preetiScore.shouldWarn && !isKnownEnglishPreserveWord(token)) {
    return [makeSpan("unknown-risky", token, offset, preetiScore.confidence, preetiScore.reason, preetiScore.features, {
      code: "LOW_CONFIDENCE_PREETI_LIKE_SPAN",
      message: `Span "${token}" has Preeti-like signals but is not safe for silent conversion.`,
      severity: "warning"
    })];
  }
  const romanized = classifyRomanizedRun(token);
  return [makeSpan(romanized.kind, token, offset, romanized.confidence, romanized.reason, {})];
}

function segmentMixedUnicodeToken(token: string, offset: number): TypedSpan[] {
  const spans: TypedSpan[] = [];
  let index = 0;
  while (index < token.length) {
    const start = index;
    const devanagari = isDevanagari(token[index]);
    while (index < token.length && isDevanagari(token[index]) === devanagari) {
      index += 1;
    }
    const run = token.slice(start, index);
    if (devanagari) {
      spans.push(makeSpan("unicode-nepali", run, offset + start, 0.98, "Unicode Nepali run inside mixed token is preserved.", {}));
      continue;
    }
    const suffix = parseEnglishNepaliSuffix(run);
    if (suffix) {
      spans.push(makeSpan("english-with-nepali-suffix", run, offset + start, suffix.confidence, suffix.reason, {
        stem: suffix.stem,
        suffixInput: suffix.suffixInput,
        suffixOutput: suffix.suffixOutput
      }));
      continue;
    }
    const preetiScore = scorePreetiIsland(run, { surroundingNepali: true, mixedToken: true });
    if (preetiScore.shouldConvert || hasPreetiSignalPunctuation(run)) {
      spans.push(makeSpan("preeti-legacy", run, offset + start, Math.max(preetiScore.confidence, 0.68), preetiScore.reason, preetiScore.features));
      continue;
    }
    if (isLikelyEnglishRun(run)) {
      spans.push(makeSpan("english-preserve", run, offset + start, 0.88, "English run inside mixed token is preserved.", {}));
      continue;
    }
    spans.push(makeSpan("unknown-risky", run, offset + start, preetiScore.confidence, "Mixed token run is not safe for silent conversion.", preetiScore.features));
  }
  return spans;
}

function spanFromProtectedMatch(match: ProtectedLikeMatch, index: number): TypedSpan {
  return {
    id: `span-${index + 1}`,
    text: match.text,
    range: match.range,
    kind: match.kind,
    confidence: match.confidence,
    legalActions: ["preserve"],
    reason: match.reason,
    features: match.features ?? {},
    diagnostics: []
  };
}

function makeSpan(
  kind: SpanKind,
  text: string,
  start: number,
  confidence: number,
  reason: string,
  features: Record<string, number | string | boolean>,
  diagnostic?: EngineDiagnostic
): TypedSpan {
  return {
    id: "span-pending",
    text,
    range: [start, start + text.length],
    kind,
    confidence,
    legalActions: legalActionsForKind(kind, confidence),
    reason,
    features,
    diagnostics: diagnostic ? [diagnostic] : []
  };
}

function hasPreetiSignalPunctuation(text: string): boolean {
  return /['"{}\[\]|\\]/.test(text);
}
