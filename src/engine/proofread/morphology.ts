import type { ProofreadHint } from "./types";

const WORD_WITH_HARU = /([\u0900-\u097F]+)हरु(मा|ले|लाई|बाट|सँग|को|का|की)?/g;
const SPACED_WORD_WITH_HARU = /([\u0900-\u097F]+)\s+हरु\s*(मा|ले|लाई|बाट|सँग|को|का|की)?/g;

export function pluralHaruHints(input: string, offset = 0): ProofreadHint[] {
  const standalone = Array.from(input.matchAll(/(^|(?<=\s))हरु(?=\s|$)/g)).map((match, index): ProofreadHint => {
    const start = offset + (match.index ?? 0);
    return {
      id: `plural-haru-standalone-${offset}-${index}`,
      range: [start, start + "हरु".length],
      input: "हरु",
      suggestion: "हरू",
      ruleId: "plural-haru-normalization",
      kind: "normalization",
      confidence: 0.98,
      action: "auto-fix",
      explanation: "Normalize plural हरु to the standard हरू form."
    };
  });

  const spaced = Array.from(input.matchAll(SPACED_WORD_WITH_HARU)).map((match, index): ProofreadHint => {
    const original = match[0];
    const suffix = match[2] ?? "";
    const suggestion = `${match[1]}हरू${suffix}`;
    const start = offset + (match.index ?? 0);
    return {
      id: `plural-haru-${offset}-${index}`,
      range: [start, start + original.length],
      input: original,
      suggestion,
      ruleId: "plural-haru-normalization",
      kind: "normalization",
      confidence: 0.98,
      action: "auto-fix",
      explanation: "Normalize plural हरु to the standard हरू form."
    };
  });

  const compact = Array.from(input.matchAll(WORD_WITH_HARU)).map((match, index): ProofreadHint => {
    const original = match[0];
    const suffix = match[2] ?? "";
    const suggestion = `${match[1]}हरू${suffix}`;
    const start = offset + (match.index ?? 0);
    return {
      id: `plural-haru-compact-${offset}-${index}`,
      range: [start, start + original.length],
      input: original,
      suggestion,
      ruleId: "plural-haru-normalization",
      kind: "normalization",
      confidence: 0.98,
      action: "auto-fix",
      explanation: "Normalize plural हरु to the standard हरू form."
    };
  });

  return [...standalone, ...spaced, ...compact];
}
