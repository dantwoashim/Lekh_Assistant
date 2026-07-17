import type { KeyboardMode, SuggestionSurface, TypingContext } from "./types";
import engineContract from "../../../data/engine/lekh-engine-contract.v1.json";

export const CANONICAL_KEYBOARD_MODES = engineContract.modes as KeyboardMode[];

export const DEFAULT_ROMANIZED_SURFACES: SuggestionSurface[] = [
  "romanized-to-unicode",
  "romanized-to-unicode-with-labels",
  "romanized-to-romanized"
];

export const DEFAULT_TRADITIONAL_SURFACES: SuggestionSurface[] = [
  "traditional-to-unicode",
  "traditional-to-traditional-proofread",
  "traditional-to-romanized-helper"
];

export function defaultTypingContext(mode: KeyboardMode = "romanized"): TypingContext {
  const traditionalInput =
    mode === "traditional" ||
    mode === "traditional-traditional" ||
    mode === "traditional-romanized";
  const enabledSurfaces: SuggestionSurface[] =
    mode === "romanized-romanized"
      ? ["romanized-to-romanized"]
      : mode === "romanized-traditional"
        ? ["romanized-to-unicode"]
        : mode === "traditional-romanized"
          ? ["traditional-to-romanized-helper"]
          : mode === "traditional-traditional"
            ? ["traditional-to-unicode", "traditional-to-traditional-proofread"]
            : traditionalInput
              ? DEFAULT_TRADITIONAL_SURFACES
              : DEFAULT_ROMANIZED_SURFACES;
  return {
    fieldType: "normal",
    leftTextWindow: "",
    activeDomains: [],
    preserveEnglish: true,
    secureInput: false,
    mode,
    enabledSurfaces,
    showRomanizedLabels: false,
    enableNextWordPrediction: true
  };
}

export function surfaceForMode(mode: KeyboardMode): SuggestionSurface {
  if (mode === "romanized-romanized") return "romanized-to-romanized";
  if (mode === "romanized-traditional") return "romanized-to-unicode";
  if (mode === "traditional-romanized") return "traditional-to-romanized-helper";
  if (mode === "traditional" || mode === "traditional-traditional") return "traditional-to-unicode";
  if (mode === "unicode-proofread") return "traditional-to-traditional-proofread";
  if (mode === "dictionary-lookup") return "romanized-to-unicode-with-labels";
  if (mode === "diagnostic") return "romanized-to-unicode-with-labels";
  return "romanized-to-unicode";
}

export function isSecureContext(context: TypingContext): boolean {
  return context.secureInput ||
    (context.fieldType !== "normal" && context.fieldType !== "search");
}

export function isLearningAllowedContext(context: TypingContext): boolean {
  return !isSecureContext(context) &&
    (context.fieldType === "normal" || context.fieldType === "search");
}
