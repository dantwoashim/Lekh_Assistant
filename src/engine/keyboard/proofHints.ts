import { applyProofread } from "../proofread";
import type { ProofreadHint as EngineProofreadHint } from "../proofread";
import type { ProofHint, TypingContext } from "./types";

export function getKeyboardProofHints(textWindow: string, context?: TypingContext): ProofHint[] {
  if (!textWindow.trim() || context?.secureInput || context?.fieldType === "password" || context?.fieldType === "code") return [];
  const result = applyProofread(textWindow, { autoFix: false });
  const activePrefix = activeDevanagariPrefixRange(textWindow);
  return result.hints
    .filter((hint) => !isUnsafeActivePrefixHint(hint, activePrefix))
    .slice(0, 8)
    .map(mapProofreadHint);
}

function activeDevanagariPrefixRange(input: string): [number, number] | undefined {
  if (/[\s।,;:!?]$/.test(input)) return undefined;
  const match = input.match(/[\u0900-\u097F]+$/);
  if (!match || match.index == null) return undefined;
  return [match.index, match.index + match[0].length];
}

function isUnsafeActivePrefixHint(hint: EngineProofreadHint, activeRange: [number, number] | undefined): boolean {
  if (!activeRange) return false;
  const overlapsActivePrefix = hint.range[0] < activeRange[1] && activeRange[0] < hint.range[1];
  if (!overlapsActivePrefix) return false;
  return hint.confidence < 0.9;
}

function mapProofreadHint(hint: EngineProofreadHint): ProofHint {
  return {
    range: hint.range,
    original: hint.input,
    suggestion: hint.suggestion,
    type: mapHintType(hint.kind),
    confidence: hint.confidence,
    action: hint.action === "auto-fix" ? "auto-suggest" : hint.confidence >= 0.85 ? "ask" : "hint-only",
    explanation: hint.explanation
  };
}

function mapHintType(kind: EngineProofreadHint["kind"]): ProofHint["type"] {
  if (kind === "normalization") return "normalization";
  if (kind === "postposition") return "postposition";
  if (kind === "halant") return "halanta";
  if (kind === "matra") return "matra";
  if (kind === "style") return "name-variant";
  return "spelling";
}
