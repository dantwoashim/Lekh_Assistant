import { suggestWords } from "../../core/dictionary/suggestWords";
import { finalizeCandidates } from "./candidates";
import { runtimePackSuggestions } from "./runtimePacks";
import type { Candidate, TypingContext } from "./types";

export function getKeyboardSuggestions(context: TypingContext): Candidate[] {
  if (context.secureInput || context.fieldType === "password" || context.fieldType === "code") return [];
  const lastToken = currentToken(context.leftTextWindow);
  if (!lastToken) return [];
  const dictionaryCandidates = suggestWords(lastToken, 8).map((suggestion, index): Candidate => ({
    id: `suggest-${index}-${suggestion.normalizedWord}`,
    text: suggestion.normalizedWord,
    label: suggestion.romanized,
    type: suggestion.domain === "government" || suggestion.domain === "office" ? "phrase" : "word",
    confidence: Math.max(0.55, Math.min(0.96, suggestion.score / 1200)),
    reason: [`${suggestion.domain} dictionary prefix`, suggestion.source],
    shortcut: String(index + 1)
  }));
  return finalizeCandidates([...runtimePackSuggestions(context), ...dictionaryCandidates], 8);
}

function currentToken(input: string): string {
  const tokens = input.trim().split(/\s+/);
  return tokens[tokens.length - 1] ?? "";
}
