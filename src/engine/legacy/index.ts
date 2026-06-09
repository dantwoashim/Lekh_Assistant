import { normalizeNepaliText } from "../../core/normalize/normalizeNepaliText";
import { convertPreetiToUnicode } from "../../core/preeti/convertPreetiToUnicode";
import { classifyDocument } from "../classify";
import { extractProtectedSpans, restoreProtectedSpans } from "../protected";
import { attachProofread } from "../proofread";
import type { ConversionResult, ConvertOptions, ConvertedToken, EngineMode, EngineWarning, ProtectedNode } from "../types";
import { nowMs } from "../util/time";
import { decodeLegacyWithAtoms } from "./decoder";
export { diagnoseLegacyInput } from "./diagnostics";
export { decodeLegacyWithAtoms } from "./decoder";
export { parseLegacyGlyphs } from "./parseGlyphs";
export { getLegacyProfile, getSemanticLegacyProfile, listLegacyProfiles } from "./profile";
export { tokenizeLegacy } from "./tokenizer";
export { assembleLegacyUnicode } from "./assembleUnicode";
export { verifyLegacyOutput } from "./verifier";
export type { LegacyAtom } from "./atoms";
export type { LegacyFontProfile, LegacyProfileId } from "./profile";
export type * from "./types";

export function convertPreeti(input: string, options: ConvertOptions = {}): ConversionResult {
  const start = nowMs();
  const requestedMode = options.mode ?? "preeti-mixed";
  const mode = normalizePreetiMode(requestedMode);
  const classified = classifyDocument(input, { ...options, mode });

  if (mode === "preeti-strict") {
    const result = convertPreetiToUnicode(input);
    const atomResult = decodeLegacyWithAtoms(input);
    const selected = selectLegacyOutput(result.normalizedOutput, atomResult.output, atomResult.verification.status, options.legacyDecoder);
    const protectedLike = extractProtectedSpans(input, "preeti-mixed").spans;
    const warnings: EngineWarning[] = [
      ...classified.warnings,
      ...result.warnings.map((warning): EngineWarning => ({
        code: warning.code,
        message: warning.message,
        severity: warning.severity,
        range: warning.position === undefined ? undefined : [warning.position, warning.position + (warning.sourceChar?.length ?? 1)]
      })),
      ...(protectedLike.length > 0
        ? [{
            code: "STRICT_PREETI_MIXED_CONTENT_WARNING",
            message: "Strict Preeti mode saw English/digital-like spans; use preeti-mixed for mixed documents.",
            severity: "warning" as const
          }]
        : [])
    ];
    return attachProofread({
      input,
      output: selected.output,
      normalizedOutput: selected.output,
      mode,
      documentConfidence: classified.documentConfidence,
      tokens: [{
        input,
        output: selected.output,
        range: [0, input.length],
        confidence: classified.documentConfidence,
        alternatives: []
      }],
      alternatives: [],
      protectedSpans: [],
      warnings,
      diagnostics: [
        ...classified.diagnostics,
        ...atomResult.diagnostics,
        {
          code: "STRICT_PREETI_PATH",
          message: "Strict Preeti conversion keeps the baseline path available and runs the atom decoder in parallel.",
          severity: "info" as const
        },
        {
          code: "LEGACY_DECODER_SELECTION",
          message: selected.reason,
          severity: selected.usedAtom ? "info" as const : "warning" as const,
          data: {
            legacyDecoder: options.legacyDecoder ?? "compare",
            atomVerifierStatus: atomResult.verification.status,
            baselineOutput: result.normalizedOutput,
            atomOutput: atomResult.output
          }
        }
      ],
      trace: {
        steps: [
          { name: "classify", message: `Recommended ${classified.modeRecommendation}.` },
          { name: "convert", message: "Wrapped existing strict Preeti converter and compared atom decoder." },
          ...atomResult.trace
        ]
      },
      timingMs: options.benchmark || options.development ? nowMs() - start : undefined,
      schemaVersion: 1
    }, options);
  }

  const protectedResult = extractProtectedSpans(input, mode);
  const converted = convertProtectedNodes(protectedResult.nodes, options);
  const output = restoreProtectedSpans(converted.outputBeforeRestore, protectedResult.spans);
  const normalizedOutput = normalizeNepaliText(output);
  const warnings: EngineWarning[] = [
    ...classified.warnings,
    ...converted.warnings,
    ...protectedResult.spans.map((span): EngineWarning => ({
      code: "PROTECTED_SPAN_PRESERVED",
      message: `Preserved ${span.kind} span "${span.original}".`,
      severity: "info",
      range: span.range
    }))
  ];

  return attachProofread({
    input,
    output: normalizedOutput,
    normalizedOutput,
    mode,
    documentConfidence: classified.documentConfidence,
    tokens: converted.tokens,
    alternatives: [],
    protectedSpans: protectedResult.spans,
    warnings,
    diagnostics: [
      ...classified.diagnostics,
      {
        code: "PROTECTED_SPANS_APPLIED",
        message: `Protected ${protectedResult.spans.length} spans before legacy-font conversion.`,
        severity: "info" as const,
        data: { count: protectedResult.spans.length }
      },
      ...converted.diagnostics
    ],
    trace: {
      steps: [
        { name: "classify", message: `Recommended ${classified.modeRecommendation}.` },
        { name: "protect", message: `Protected ${protectedResult.spans.length} spans.` },
        { name: "convert", message: "Wrapped existing Preeti converter over text nodes and compared atom decoder where requested." },
        ...converted.trace
      ]
    },
    timingMs: options.benchmark || options.development ? nowMs() - start : undefined,
    schemaVersion: 1
  }, options);
}

function convertProtectedNodes(nodes: ProtectedNode[], options: ConvertOptions) {
  let outputBeforeRestore = "";
  const tokens: ConvertedToken[] = [];
  const warnings: EngineWarning[] = [];
  const diagnostics: ConversionResult["diagnostics"] = [];
  const trace: NonNullable<ConversionResult["trace"]>["steps"] = [];

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

    const result = convertPreetiToUnicode(node.text);
    const atomResult = shouldRunAtomDecoder(options) ? decodeLegacyWithAtoms(node.text) : undefined;
    const selected = atomResult
      ? selectLegacyOutput(result.normalizedOutput, atomResult.output, atomResult.verification.status, options.legacyDecoder)
      : {
          output: result.normalizedOutput,
          usedAtom: false,
          reason: "Baseline decoder selected; atom compare skipped for the production mixed-mode hot path."
        };
    outputBeforeRestore += selected.output;
    tokens.push({
      input: node.text,
      output: selected.output,
      range: node.range,
      confidence: selected.usedAtom ? 0.82 : 0.75,
      alternatives: []
    });
    warnings.push(...result.warnings.map((warning): EngineWarning => ({
      code: warning.code,
      message: warning.message,
      severity: warning.severity,
      range: warning.position === undefined ? undefined : [node.range[0] + warning.position, node.range[0] + warning.position + (warning.sourceChar?.length ?? 1)]
    })));
    if (atomResult) diagnostics.push(...atomResult.diagnostics);
    diagnostics.push({
      code: "LEGACY_DECODER_SELECTION",
      message: selected.reason,
      severity: selected.usedAtom ? "info" : "warning",
      data: {
        legacyDecoder: options.legacyDecoder ?? "baseline",
        atomVerifierStatus: atomResult?.verification.status ?? "not-run",
        baselineOutput: result.normalizedOutput,
        atomOutput: atomResult?.output
      }
    });
    if (atomResult) trace.push(...atomResult.trace);
  }

  return { outputBeforeRestore, tokens, warnings, diagnostics, trace };
}

function shouldRunAtomDecoder(options: ConvertOptions): boolean {
  if (options.development) return true;
  return options.legacyDecoder === "atom" || options.legacyDecoder === "auto" || options.legacyDecoder === "compare";
}

function selectLegacyOutput(
  baselineOutput: string,
  atomOutput: string,
  atomStatus: "clean" | "warning" | "unsafe",
  decoder: ConvertOptions["legacyDecoder"] = "compare"
) {
  if (decoder === "atom" && atomStatus !== "unsafe") {
    return { output: atomOutput, usedAtom: true, reason: "legacyDecoder=atom selected verifier-accepted atom output." };
  }
  if (decoder === "auto" && atomStatus === "clean") {
    return { output: atomOutput, usedAtom: true, reason: "legacyDecoder=auto selected clean atom output." };
  }
  if (decoder === "baseline") {
    return { output: baselineOutput, usedAtom: false, reason: "legacyDecoder=baseline selected the existing converter." };
  }
  return {
    output: baselineOutput,
    usedAtom: false,
    reason: atomStatus === "unsafe"
      ? "Atom decoder ran in parallel but verifier marked it unsafe; baseline output selected."
      : "Atom decoder ran in compare mode; baseline output selected until cutover is explicitly proven."
  };
}

function normalizePreetiMode(mode: EngineMode): EngineMode {
  return mode === "preeti-strict" ? "preeti-strict" : "preeti-mixed";
}
