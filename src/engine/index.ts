import { normalizeNepaliText } from "../core/normalize/normalizeNepaliText";
import { classifyDocument } from "./classify";
import { convertPreeti } from "./legacy";
import { attachProofread } from "./proofread";
import { extractProtectedSpans, restoreProtectedSpans } from "./protected";
import { convertRomanized } from "./romanized";
import { routeDocument } from "./router";
import type { ConversionResult, ConvertOptions, EngineMode } from "./types";
import { nowMs } from "./util/time";

export function convert(input: string, options: ConvertOptions = {}): ConversionResult {
  const start = nowMs();
  const classified = classifyDocument(input, options);
  const mode = resolveMode(options.mode, classified.modeRecommendation);

  if (mode === "mixed-unicode-legacy-repair" || mode === "romanized-mixed-office" || mode === "preeti-mixed-document" || mode === "diagnostic") {
    const routed = routeDocument(input, { ...options, mode });
    return attachProofread({
      input,
      output: routed.output,
      normalizedOutput: routed.normalizedOutput,
      mode,
      documentConfidence: routed.confidence,
      action: routed.action,
      typedSpans: routed.segmentation.spans,
      spanCandidates: routed.spanCandidates,
      tokens: routed.spanCandidates.map((candidate) => ({
        input: candidate.input,
        output: candidate.output,
        range: routed.segmentation.spans.find((span) => span.id === candidate.spanId)?.range ?? [0, candidate.input.length],
        confidence: candidate.confidence,
        alternatives: [],
        protected: candidate.action === "preserve"
      })),
      alternatives: [],
      protectedSpans: [],
      warnings: routed.warnings,
      diagnostics: [
        ...classified.diagnostics,
        ...routed.diagnostics,
        {
          code: "SPAN_ROUTED_CONVERSION",
          message: `Universal span router selected document action: ${routed.action}.`,
          severity: routed.action === "refuse" ? "error" : routed.action === "warn" ? "warning" : "info",
          data: { spanCount: routed.segmentation.spans.length }
        }
      ],
      trace: {
        steps: [
          { name: "classify", message: `Recommended ${classified.modeRecommendation}.` },
          { name: "segment", message: `Typed ${routed.segmentation.spans.length} spans.` },
          { name: "route", message: `Document action ${routed.action}.`, data: { trace: routed.trace.slice(0, 20) } }
        ]
      },
      timingMs: options.benchmark || options.development ? nowMs() - start : undefined,
      schemaVersion: 1
    }, options);
  }

  if (mode.startsWith("romanized-")) {
    return convertRomanized(input, { ...options, mode });
  }

  if (mode === "preeti-strict" || mode === "preeti-mixed" || mode === "legacy-profile") {
    return convertPreeti(input, { ...options, mode: mode === "legacy-profile" ? "preeti-mixed" : mode });
  }

  if (mode === "unicode-passthrough" || mode === "proofread-only") {
    const output = normalizeNepaliText(input);
    return attachProofread({
      input,
      output,
      normalizedOutput: output,
      mode,
      documentConfidence: classified.documentConfidence,
      tokens: [{
        input,
        output,
        range: [0, input.length],
        confidence: classified.documentConfidence,
        alternatives: []
      }],
      alternatives: [],
      protectedSpans: [],
      warnings: classified.warnings,
      diagnostics: classified.diagnostics,
      trace: { steps: [{ name: "passthrough", message: "Normalized Unicode text without conversion." }] },
      timingMs: options.benchmark || options.development ? nowMs() - start : undefined,
      schemaVersion: 1
    }, options);
  }

  return {
    input,
    output: input,
    normalizedOutput: normalizeNepaliText(input),
    mode: "unknown-diagnostic",
    documentConfidence: classified.documentConfidence,
    tokens: [],
    alternatives: [],
    protectedSpans: [],
    warnings: [
      ...classified.warnings,
      {
        code: "UNKNOWN_DIAGNOSTIC_MODE",
        message: "Input was not converted because classification confidence is low.",
        severity: "warning"
      }
    ],
    diagnostics: classified.diagnostics,
    trace: { steps: [{ name: "diagnostic", message: "No converter selected for ambiguous input." }] },
    timingMs: options.benchmark || options.development ? nowMs() - start : undefined,
    schemaVersion: 1
  };
}

function resolveMode(requested: EngineMode | undefined, recommended: EngineMode): EngineMode {
  if (requested && requested !== "auto") return requested === "romanized-health" ? "romanized-mixed" : requested;
  return recommended;
}

export { classifyDocument } from "./classify";
export { extractProtectedSpans, restoreProtectedSpans } from "./protected";
export { convertPreeti } from "./legacy";
export { convertRomanized } from "./romanized";
export * from "./lexicon";
export * from "./memory";
export * from "./proofread";
export * from "./romanized/candidates";
export * from "./romanized/context";
export * from "./romanized/confidence";
export * from "./romanized/maxMatch";
export * from "./romanized/numbers";
export * from "./romanized/phraseMatch";
export * from "./romanized/tokenizer";
export * from "./romanized/rank";
export * from "./segmentation";
export * from "./router";
export * from "./lattice";
export * from "./verify";
export * from "./traditional";
export { createKeyboardEngine, defaultTypingContext, surfaceForMode, isSecureContext, warmKeyboard } from "./keyboard";
export {
  validateRange,
  clampRange,
  sliceByUtf16Range,
  replaceByUtf16Range,
  clampCaret,
  deleteBeforeCaret,
  deleteAfterCaret,
  insertAtCaret
} from "./keyboard";
export {
  defaultKeyboardSettings,
  InMemoryKeyboardSettingsStore,
  InMemoryPersonalDictionaryStore,
  InMemoryKeyboardCorrectionMemoryStore
} from "./keyboard";
export type {
  SessionId,
  KeyboardMode,
  SuggestionSurface,
  KeyboardKeyEvent,
  TypingContext,
  Candidate as KeyboardCandidate,
  ProofHint as KeyboardProofHint,
  DictionaryResult as KeyboardDictionaryResult,
  CandidateUpdate as KeyboardCandidateUpdate,
  CommitResult as KeyboardCommitResult,
  WarmResult,
  WarmOptions,
  KeyboardEngine,
  KeyboardSession,
  KeyboardSettings,
  KeyboardSettingsStore,
  PersonalDictionaryEntry,
  PersonalDictionaryStore,
  KeyboardCorrectionMemoryStore
} from "./keyboard";
export type * from "./types";
