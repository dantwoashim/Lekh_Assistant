import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import { transliterateRomanized } from "../../core/transliteration/transliterateRomanized";
import type { Candidate as CoreCandidate } from "../../core/types";
import { classifyDocument } from "../classify";
import { correctionMemoryCandidates } from "../memory";
import { extractProtectedSpans, restoreProtectedSpans } from "../protected";
import { attachProofread } from "../proofread";
import type { Candidate, ConversionResult, ConvertOptions, ConvertedToken, EngineDiagnostic, EngineMode, EngineWarning, ProtectedNode } from "../types";
import { nowMs } from "../util/time";
import { assessRomanizedConfidence } from "./confidence";
import { capCandidates } from "./candidates";
import { loanwordCandidates } from "./loanwords";
import { phoneticCandidatesForToken } from "./phonetic";
import { buildCandidateScore } from "./rank";
import { tokenizeRomanized } from "./tokenizer";

const CONVERSION_CACHE_MAX = 128;
const conversionCache = new Map<string, ConversionResult>();

export function convertRomanized(input: string, options: ConvertOptions = {}): ConversionResult {
  const start = nowMs();
  const requestedMode = options.mode ?? "romanized-mixed";
  const mode = normalizeRomanizedMode(requestedMode);
  const cacheKey = romanizedConversionCacheKey(input, options, mode);
  if (cacheKey) {
    const cached = conversionCache.get(cacheKey);
    if (cached) {
      const result = cloneConversionResult(cached);
      if (options.benchmark || options.development) result.timingMs = nowMs() - start;
      return result;
    }
  }
  const classified = classifyDocument(input, { ...options, mode });
  const protectedResult = mode === "romanized-strict" ? undefined : extractProtectedSpans(input, mode);
  const protectedConversion = protectedResult
    ? convertProtectedNodes(protectedResult.nodes, options, mode)
    : convertText(input, 0, options, mode);
  const phraseFirstConversion = protectedResult ? convertText(input, 0, options, mode) : undefined;
  const phraseFirstOutput = phraseFirstConversion ? normalizeNepaliText(phraseFirstConversion.outputBeforeRestore) : undefined;
  const usePhraseFirst =
    phraseFirstConversion &&
    phraseFirstOutput &&
    shouldPreferPhraseFirstConversion(phraseFirstConversion, phraseFirstOutput, protectedResult?.spans ?? []);
  const conversion = usePhraseFirst ? phraseFirstConversion : protectedConversion;
  const output = protectedResult && !usePhraseFirst
    ? restoreProtectedSpans(conversion.outputBeforeRestore, protectedResult.spans)
    : conversion.outputBeforeRestore;
  const normalizedOutput = normalizeNepaliText(output);
  const alternatives = ensureSelectedOutputCandidate(normalizedOutput, conversion.alternatives);
  const confidence = assessRomanizedConfidence({
    sourceInput: input,
    output: normalizedOutput,
    mode,
    alternatives,
    protectedSpans: protectedResult?.spans ?? []
  });
  const warnings: EngineWarning[] = [
    ...classified.warnings,
    ...conversion.warnings,
    ...confidence.warnings,
    ...(protectedResult?.spans.map((span): EngineWarning => ({
      code: "PROTECTED_SPAN_PRESERVED",
      message: `Preserved ${span.kind} span "${span.original}".`,
      severity: "info",
      range: span.range
    })) ?? [])
  ];

  const result = attachProofread({
    input,
    output: normalizedOutput,
    normalizedOutput,
    mode,
    documentConfidence: Math.min(classified.documentConfidence, confidence.confidence),
    tokens: conversion.tokens,
    alternatives,
    protectedSpans: protectedResult?.spans ?? [],
    warnings,
    diagnostics: [
      ...classified.diagnostics,
      ...(protectedResult
        ? [{
          code: "PROTECTED_SPANS_APPLIED",
          message: `Protected ${protectedResult.spans.length} spans before Romanized conversion.`,
          severity: "info" as const,
          data: { count: protectedResult.spans.length }
        }]
        : []),
      ...conversion.diagnostics,
      {
        code: "ROMANIZED_CONFIDENCE_GATE",
        message: `Romanized confidence status: ${confidence.status}.`,
        severity: confidence.status === "unsafe" ? "error" as const : confidence.status === "ambiguous" ? "warning" as const : "info" as const,
        data: { confidence: confidence.confidence, reasons: confidence.reasons }
      }
    ],
    trace: {
      steps: [
        { name: "classify", message: `Recommended ${classified.modeRecommendation}.` },
        { name: "protect", message: `Protected ${protectedResult?.spans.length ?? 0} spans.` },
        ...(usePhraseFirst ? [{ name: "phrase-first", message: "Selected full-text phrase conversion because protected originals survived byte-exactly." }] : []),
        { name: "convert", message: "Wrapped existing Romanized converter with candidate confidence gate." }
      ]
    },
    timingMs: options.benchmark || options.development ? nowMs() - start : undefined,
    schemaVersion: 1
  }, options);
  if (cacheKey) cacheConversionResult(cacheKey, result);
  return result;
}

function romanizedConversionCacheKey(input: string, options: ConvertOptions, mode: EngineMode): string | undefined {
  if ((options.localCorrections?.length ?? 0) > 0) return undefined;
  if ((options.correctionMemoryEntries?.length ?? 0) > 0) return undefined;
  return JSON.stringify({
    input,
    mode,
    digitPolicy: options.digitPolicy ?? null,
    proofread: options.proofread ?? null
  });
}

function cacheConversionResult(key: string, result: ConversionResult): void {
  if (conversionCache.has(key)) conversionCache.delete(key);
  conversionCache.set(key, cloneConversionResult(result));
  if (conversionCache.size > CONVERSION_CACHE_MAX) {
    const oldest = conversionCache.keys().next().value;
    if (oldest) conversionCache.delete(oldest);
  }
}

function cloneConversionResult(result: ConversionResult): ConversionResult {
  return JSON.parse(JSON.stringify(result)) as ConversionResult;
}

function convertProtectedNodes(nodes: ProtectedNode[], options: ConvertOptions, mode: EngineMode) {
  let outputBeforeRestore = "";
  const tokens: ConvertedToken[] = [];
  const alternatives: Candidate[] = [];
  const warnings: EngineWarning[] = [];
  const diagnostics: EngineDiagnostic[] = [];

  for (const node of nodes) {
    if (node.kind === "protected") {
      outputBeforeRestore += node.span.placeholder;
      tokens.push({
        input: node.span.original,
        output: node.span.original,
        range: node.span.range,
        confidence: node.span.confidence,
        alternatives: [],
        protected: true
      });
      continue;
    }

    const converted = convertText(node.text, node.range[0], options, mode);
    outputBeforeRestore += converted.outputBeforeRestore;
    tokens.push(...converted.tokens);
    alternatives.push(...converted.alternatives);
    warnings.push(...converted.warnings);
    diagnostics.push(...converted.diagnostics);
  }

  return { outputBeforeRestore, tokens, alternatives: capCandidates(alternatives, 12), warnings, diagnostics };
}

function convertText(text: string, offset = 0, options: ConvertOptions = {}, mode: EngineMode = "romanized-mixed") {
  const result = transliterateRomanized(text, "common-nepali", {
    localCorrections: options.localCorrections,
    digitPolicy: options.digitPolicy ?? digitPolicyForMode(mode)
  });
  const coreAlternatives = result.candidates.map(coreCandidateToEngineCandidate);
  const memoryAlternatives = correctionMemoryCandidates(options.correctionMemoryEntries ?? [], {
    input: text,
    domain: domainForMode(mode),
    protectedOriginals: []
  });
  const supplementalAlternatives = supplementalCandidatesForText(text, mode);
  const alternatives = capCandidates([...memoryAlternatives, ...coreAlternatives, ...supplementalAlternatives], 12);
  const normalized = alternatives[0]?.source === "memory" && alternatives[0].score.total > (coreAlternatives[0]?.score.total ?? 0) + 100
    ? alternatives[0].normalizedText
    : result.normalizedOutput;
  const token: ConvertedToken = {
    input: text,
    output: normalized,
    range: [offset, offset + text.length],
    confidence: alternatives[0]?.confidence ?? 0.72,
    chosen: alternatives[0],
    alternatives
  };
  return {
    outputBeforeRestore: normalized,
    tokens: text ? [token] : [],
    alternatives,
    warnings: [] as EngineWarning[],
    diagnostics: [] as EngineDiagnostic[]
  };
}

function digitPolicyForMode(mode: EngineMode): "preserve-ascii" | "convert-devanagari" | "context-dependent" {
  if (mode === "romanized-government" || mode === "romanized-legal" || mode === "romanized-education") {
    return "convert-devanagari";
  }
  return "preserve-ascii";
}

function coreCandidateToEngineCandidate(candidate: CoreCandidate): Candidate {
  const source = mapCoreCandidateSource(candidate);
  return {
    text: candidate.text,
    normalizedText: candidate.normalizedText,
    source,
    confidence: Math.max(0.2, Math.min(0.98, candidate.score / 2000)),
    score: buildCandidateScore({
      source,
      rawScore: candidate.score,
      domainMatched: /domain|government|legal|education|office/.test(candidate.reason),
      namePlaceMatched: /name|surname|place/i.test(candidate.reason)
    }),
    evidence: [{ source: candidate.source, detail: candidate.reason, weight: candidate.score }],
    warnings: []
  };
}

function supplementalCandidatesForText(text: string, mode: EngineMode): Candidate[] {
  const tokens = tokenizeRomanized(text).filter((token) => token.kind === "word");
  if (tokens.length !== 1) return [];
  const [token] = tokens;
  return capCandidates([
    ...loanwordCandidates(token.text, mode),
    ...phoneticCandidatesForToken(token.text)
  ], 8);
}

function ensureSelectedOutputCandidate(output: string, candidates: Candidate[]): Candidate[] {
  if (candidates.some((candidate) => candidate.normalizedText === output)) return capCandidates(candidates, 12);
  const topTotal = candidates[0]?.score.total ?? 1_000;
  const selected: Candidate = {
    text: output,
    normalizedText: output,
    source: "rule",
    confidence: candidates[0]?.confidence ?? 0.72,
    score: buildCandidateScore({ source: "rule", rawScore: Math.max(1_000, topTotal + 1) }),
    evidence: [{ source: "engine-facade", detail: "Selected full output after protected-span restoration", weight: topTotal + 1 }],
    warnings: []
  };
  return capCandidates([selected, ...candidates], 12);
}

function shouldPreferPhraseFirstConversion(conversion: ReturnType<typeof convertText>, output: string, spans: Array<{ original: string }>): boolean {
  if (!spans.every((span) => output.includes(span.original))) return false;
  return conversion.alternatives.some((candidate) =>
    candidate.source === "phrase" ||
    candidate.evidence.some((evidence) => /phrase/i.test(evidence.detail))
  );
}

function domainForMode(mode: EngineMode): string | undefined {
  if (mode === "romanized-government") return "admin";
  if (mode === "romanized-legal") return "legal";
  if (mode === "romanized-education") return "education";
  if (mode === "romanized-health") return "health";
  return undefined;
}

function mapCoreCandidateSource(candidate: CoreCandidate): Candidate["source"] {
  const reason = candidate.reason.toLowerCase();
  if (reason.includes("phrase")) return "phrase";
  if (candidate.source === "variant") return "alias";
  if (candidate.source === "user-feedback") return "memory";
  if (candidate.source === "dictionary") return "dictionary";
  return "rule";
}

function normalizeRomanizedMode(mode: EngineMode): EngineMode {
  return mode.startsWith("romanized-") ? mode : "romanized-mixed";
}
