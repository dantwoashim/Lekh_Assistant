import { deleteAfterCaret, deleteBeforeCaret, insertAtCaret } from "./ranges";
import type { KeyboardKeyEvent } from "./types";

export interface CompositionMutation {
  text: string;
  caret: number;
  command?: "commit-primary" | "commit-raw" | "cancel" | "expand-candidates" | "pass-through";
  warning?: string;
}

export function applyKeyToComposition(input: string, caret: number, key: KeyboardKeyEvent): CompositionMutation {
  const safeKey = typeof key?.key === "string" ? key.key : "";
  const modifiers = {
    shift: Boolean(key?.modifiers?.shift),
    ctrl: Boolean(key?.modifiers?.ctrl),
    alt: Boolean(key?.modifiers?.alt),
    meta: Boolean(key?.modifiers?.meta)
  };

  if (!safeKey) {
    return {
      text: input,
      caret,
      command: "pass-through",
      warning: "Malformed key event passed through to host application."
    };
  }

  if (modifiers.meta || modifiers.ctrl || (modifiers.alt && safeKey.length !== 1)) {
    return {
      text: input,
      caret,
      command: "pass-through",
      warning: "Modifier shortcut passed through to host application."
    };
  }

  if (safeKey === "Backspace") {
    if (input.length === 0) {
      return {
        text: input,
        caret,
        command: "pass-through",
        warning: "Backspace passed through because there is no active composition."
      };
    }
    return deleteBeforeCaret(input, caret);
  }

  if (safeKey === "Delete") {
    if (input.length === 0) {
      return {
        text: input,
        caret,
        command: "pass-through",
        warning: "Delete passed through because there is no active composition."
      };
    }
    return deleteAfterCaret(input, caret);
  }

  if (safeKey === "Escape") {
    return { text: "", caret: 0, command: "cancel" };
  }

  if (safeKey === "Enter") {
    return { text: input, caret, command: "commit-raw" };
  }

  if (safeKey === "Tab") {
    return { text: input, caret, command: "expand-candidates" };
  }

  if (safeKey === " ") {
    if (input.length === 0) {
      return {
        text: input,
        caret,
        command: "pass-through",
        warning: "Space passed through because there is no active composition."
      };
    }
    return { text: input, caret, command: "commit-raw" };
  }

  if (safeKey.length === 1) {
    return insertAtCaret(input, caret, safeKey);
  }

  return {
    text: input,
    caret,
    command: "pass-through",
    warning: `Unhandled key ${safeKey} passed through.`
  };
}
