import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createKeyboardEngine,
  defaultTypingContext,
  type CandidateUpdate,
  type KeyboardMode,
  type SessionId
} from "../../engine/keyboard";

type TypingMode =
  | "romanized-romanized"
  | "romanized-traditional"
  | "traditional-traditional"
  | "traditional-romanized";

interface Suggestion {
  id: string;
  text: string;
}

type TextRange = [number, number];

const MODES: Array<{ id: TypingMode; label: string; engineMode: TypingMode; placeholder: string }> = [
  {
    id: "romanized-romanized",
    label: "Romanized-Romanized",
    engineMode: "romanized-romanized",
    placeholder: "swas"
  },
  {
    id: "romanized-traditional",
    label: "Romanized-Traditional",
    engineMode: "romanized-traditional",
    placeholder: "swasthya karyalaya"
  },
  {
    id: "traditional-traditional",
    label: "Traditional-Traditional (Beta)",
    engineMode: "traditional-traditional",
    placeholder: "स्वा"
  },
  {
    id: "traditional-romanized",
    label: "Traditional-Romanized (Beta)",
    engineMode: "traditional-romanized",
    placeholder: "स्वास्थ्य"
  }
];

const ACTIVE_DOMAINS = ["general", "government", "office", "education", "health", "tech", "legal", "admin"];
const ROMANIZED_SOFT_BOUNDARY_WORDS = new Set([
  "cha",
  "chha",
  "xa",
  "ho",
  "huncha",
  "hunxa",
  "bhayo",
  "vayo",
  "bhayena",
  "vayena",
  "chaina",
  "chhaina",
  "xaina",
  "parcha",
  "parxa",
  "milena",
  "sakina",
  "sakincha",
  "sakiyo",
  "lagyo"
]);

export function FocusedKeyboard() {
  const engine = useMemo(() => createKeyboardEngine(), []);
  const [mode, setMode] = useState<TypingMode>("romanized-traditional");
  const [sessionId, setSessionId] = useState<SessionId>(() => engine.beginSession(contextFor("romanized-traditional")));
  const [input, setInput] = useState("");
  const [update, setUpdate] = useState<CandidateUpdate>(() => engine.updateComposition(sessionId, "", 0));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void engine.warm({ timeoutMs: 50 });
    const shutdown = () => {
      void engine.shutdown();
    };
    window.addEventListener("beforeunload", shutdown);
    return () => {
      window.removeEventListener("beforeunload", shutdown);
      void engine.shutdown();
    };
  }, [engine]);

  const modeDefinition = MODES.find((item) => item.id === mode) ?? MODES[1];
  const suggestions = suggestionsForMode(update, mode);
  const activeSuggestion = suggestions[selectedIndex] ?? suggestions[0];
  const activeText = activeCompositionText(input);
  const inlineSuggestion = inlineSuggestionForUpdate(update, activeText, activeSuggestion?.text);
  const suggestionPreview = activeSuggestion ? previewSuggestion(activeText, activeSuggestion.text) : "";

  function changeMode(nextMode: TypingMode) {
    const nextDefinition = MODES.find((item) => item.id === nextMode) ?? MODES[1];
    engine.endSession(sessionId);
    const nextSessionId = engine.beginSession(contextFor(nextDefinition.engineMode));
    setMode(nextMode);
    setModeMenuOpen(false);
    setSessionId(nextSessionId);
    setInput("");
    setSelectedIndex(0);
    setUpdate(engine.updateComposition(nextSessionId, "", 0));
    inputRef.current?.focus();
  }

  const refresh = useCallback((nextInput: string, nextSessionId = sessionId) => {
    const [start, end] = activeCompositionRange(nextInput);
    const nextActiveText = nextInput.slice(start, end);
    engine.setContext(nextSessionId, {
      leftTextWindow: nextInput.slice(0, start),
      rightTextWindow: nextInput.slice(end)
    });
    setInput(nextInput);
    setSelectedIndex(0);
    setUpdate(engine.updateComposition(nextSessionId, nextActiveText, nextActiveText.length));
  }, [engine, sessionId]);

  function acceptSuggestion(suggestion = activeSuggestion, options: { addSpace?: boolean } = {}) {
    if (!suggestion) return;
    const nextInput = maybeAppendContinuationSpace(replaceActiveComposition(input, suggestion.text), options.addSpace ?? false);
    if (inputRef.current) inputRef.current.value = nextInput;
    refresh(nextInput);
    const length = nextInput.length;
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(length, length);
  }

  function syncGhostScroll() {
    if (!inputRef.current || !ghostRef.current) return;
    ghostRef.current.scrollTop = inputRef.current.scrollTop;
    ghostRef.current.scrollLeft = inputRef.current.scrollLeft;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const isModeShortcut =
      (event.ctrlKey && event.altKey && event.code === "Space") ||
      (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "m");

    if (isModeShortcut) {
      event.preventDefault();
      setModeMenuOpen((isOpen) => !isOpen);
      return;
    }

    if (modeMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setModeMenuOpen(false);
        return;
      }

      const selectedMode = MODES[Number(event.key) - 1];
      if (selectedMode) {
        event.preventDefault();
        changeMode(selectedMode.id);
        return;
      }
    }

    if (event.key === "Tab" && activeSuggestion) {
      event.preventDefault();
      acceptSuggestion(activeSuggestion, { addSpace: true });
      return;
    }

    if (event.key === "Enter" && activeSuggestion && !event.shiftKey) {
      event.preventDefault();
      acceptSuggestion(activeSuggestion, { addSpace: true });
      return;
    }

    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, suggestions.length - 1));
      return;
    }

    if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
      return;
    }

  }

  return (
    <main className="typing-shell">
      <section className="typing-surface" aria-label="Typing surface">
        <div className="typing-guide" aria-label="Quick typing guide">
          <span>Type naturally.</span>
          <span>Gray text is the suggestion.</span>
          <span>Press Tab/Enter or tap Accept.</span>
          <span>Ctrl+Alt+Space switches mode.</span>
        </div>

        <div className="typing-modes" aria-label="Typing mode options">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === mode ? "typing-mode typing-mode--active" : "typing-mode"}
              aria-pressed={item.id === mode}
              onClick={() => changeMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {modeMenuOpen ? (
          <div className="typing-mode-menu" role="menu" aria-label="Typing mode shortcut menu">
            {MODES.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.id === mode}
                className={item.id === mode ? "typing-mode-menu__item typing-mode-menu__item--active" : "typing-mode-menu__item"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => changeMode(item.id)}
              >
                <span>{index + 1}</span>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="typing-box-frame">
          <div ref={ghostRef} className="typing-ghost-layer" aria-hidden="true">
            <span className="typing-ghost-prefix">{input}</span>
            {inlineSuggestion ? <span className="typing-ghost-suggestion">{inlineSuggestion}</span> : null}
          </div>
          <textarea
            ref={inputRef}
            className="typing-box"
            aria-label={modeDefinition.label}
            value={input}
            onChange={(event) => refresh(event.target.value)}
            onKeyDown={handleKeyDown}
            onScroll={syncGhostScroll}
            placeholder={modeDefinition.placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            rows={8}
          />
          {activeSuggestion ? (
            <button
              type="button"
              className="typing-accept"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptSuggestion(activeSuggestion, { addSpace: true })}
              aria-label={`Accept suggestion ${activeSuggestion.text}`}
            >
              <span className="typing-accept__label">Accept</span>
              <span className="typing-accept__text">{suggestionPreview || activeSuggestion.text}</span>
            </button>
          ) : null}
          <div className="sr-only" aria-live="polite">
            {activeSuggestion ? `Suggestion: ${activeSuggestion.text}` : ""}
          </div>
        </div>
      </section>
    </main>
  );
}

function contextFor(mode: TypingMode) {
  return {
    ...defaultTypingContext(mode),
    activeDomains: ACTIVE_DOMAINS,
    preserveEnglish: true,
    secureInput: false,
    showRomanizedLabels: true,
    enableNextWordPrediction: true
  };
}

function suggestionsForMode(update: CandidateUpdate, mode: TypingMode): Suggestion[] {
  if (!update.compositionText.trim() && update.inlineCompletion) {
    const candidate = update.inlineCompletion.candidate;
    if (mode === "romanized-romanized" && candidate.label && /[a-z]/i.test(candidate.label)) {
      return [{ id: `${candidate.id}-label`, text: candidate.label }];
    }
    if (mode === "traditional-romanized" && candidate.label && /[a-z]/i.test(candidate.label)) {
      return [{ id: `${candidate.id}-label`, text: candidate.label }];
    }
    return [{ id: candidate.id, text: update.inlineCompletion.text }];
  }

  if (!update.compositionText.trim()) return [];

  if (mode === "romanized-romanized") {
    const rawComposition = update.compositionText.trim();
    const suggestions = dedupeSuggestions(
      update.candidates.flatMap((candidate) => {
        if (candidate.type === "romanized-helper" && candidate.label !== "raw" && candidate.text.trim() !== rawComposition) {
          return [{ id: candidate.id, text: candidate.text }];
        }
        if (
          candidate.type !== "romanized-helper" &&
          candidate.label &&
          /[a-z]/i.test(candidate.label) &&
          candidate.label.trim() !== rawComposition
        ) {
          return [{ id: `${candidate.id}-label`, text: candidate.label }];
        }
        return [];
      })
    );
    if (suggestions.length > 0) return suggestions;
    return dedupeSuggestions(
      update.candidates
        .filter((candidate) => candidate.type === "romanized-helper")
        .map((candidate) => ({ id: candidate.id, text: candidate.text }))
    );
  }

  if (mode === "traditional-romanized") {
    return dedupeSuggestions(
      update.candidates.flatMap((candidate, index) => {
        const text = candidate.type === "romanized-helper" ? candidate.text : candidate.label;
        return text && text !== "preserve" && /[a-z]/i.test(text)
          ? [{ id: `traditional-romanized-${index}-${text}`, text }]
          : [];
      })
    );
  }

  const unicodeSuggestions = dedupeSuggestions(
    visibleUnicodeCandidates(update).map((candidate) => ({ id: candidate.id, text: candidate.text }))
  );
  if (unicodeSuggestions.length > 0) return unicodeSuggestions;

  return dedupeSuggestions(
    update.candidates
      .filter((candidate) => candidate.type === "romanized-helper")
      .map((candidate) => ({ id: candidate.id, text: candidate.label && /[\u0900-\u097F]/.test(candidate.label) ? candidate.label : candidate.text }))
  );
}

function visibleUnicodeCandidates(update: CandidateUpdate): CandidateUpdate["candidates"] {
  const unicodeCandidates = update.candidates.filter((candidate) => candidate.type !== "romanized-helper");
  const hasStrongMultiWordPhrase =
    update.compositionText.trim().includes(" ") &&
    unicodeCandidates.some((candidate) => candidate.type === "phrase" && candidate.confidence >= 0.9);

  if (!hasStrongMultiWordPhrase) return unicodeCandidates;

  return unicodeCandidates.filter((candidate) =>
    candidate.text === update.primary?.text ||
    candidate.confidence >= 0.9 ||
    candidate.type === "protected" ||
    candidate.type === "personal" ||
    candidate.type === "correction"
  );
}

function activeCompositionText(input: string): string {
  const [start, end] = activeCompositionRange(input);
  return input.slice(start, end);
}

function replaceActiveComposition(input: string, replacement: string): string {
  const [start, end] = activeCompositionRange(input);
  return `${input.slice(0, start)}${replacement}${input.slice(end)}`;
}

function maybeAppendContinuationSpace(value: string, enabled: boolean): string {
  if (!enabled || !value || /\s$/.test(value) || /[।.!?]$/.test(value)) return value;
  return `${value} `;
}

function activeCompositionRange(input: string): TextRange {
  const end = input.length;
  if (end > 0 && /\s/.test(input[end - 1] ?? "")) return [end, end];

  const hardBoundary = Math.max(
    input.lastIndexOf("\n"),
    input.lastIndexOf("।"),
    input.lastIndexOf("."),
    input.lastIndexOf("?"),
    input.lastIndexOf("!")
  );
  let start = hardBoundary >= 0 ? hardBoundary + 1 : 0;
  while (start < end && /\s/.test(input[start])) start += 1;

  const segment = input.slice(start, end);
  const latinTail = segment.match(/[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)*$/);
  if (latinTail && typeof latinTail.index === "number" && latinTail.index > 0 && /[\u0900-\u097F]/.test(segment.slice(0, latinTail.index))) {
    start += latinTail.index;
  }

  let activeSegment = input.slice(start, end);
  const softBoundaryOffset = romanizedSoftBoundaryOffset(activeSegment);
  if (softBoundaryOffset > 0) {
    start += softBoundaryOffset;
    activeSegment = input.slice(start, end);
  }

  const maxWords = 9;
  const matches = Array.from(activeSegment.matchAll(/\S+/g));
  if (matches.length > maxWords) {
    const cutoff = matches[matches.length - maxWords]?.index;
    if (typeof cutoff === "number") start += cutoff;
  }

  return [start, end];
}

function romanizedSoftBoundaryOffset(segment: string): number {
  if (/[\u0900-\u097F]/.test(segment)) return 0;
  const tokens = Array.from(segment.matchAll(/[A-Za-z][A-Za-z'-]*/g));
  let offset = 0;

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    const word = token[0].toLowerCase();
    const wordsAfter = tokens.length - index - 1;
    if (wordsAfter < 2 || !ROMANIZED_SOFT_BOUNDARY_WORDS.has(word)) continue;

    const boundaryEnd = (token.index ?? 0) + token[0].length;
    offset = boundaryEnd;
    while (offset < segment.length && /\s/.test(segment[offset] ?? "")) offset += 1;
  }

  return offset;
}

function inlineSuggestionForUpdate(update: CandidateUpdate, activeText: string, suggestion?: string): string {
  if (!activeText.trim() && update.inlineCompletion) return update.inlineCompletion.displayText;
  return inlineSuggestionFor(activeText, suggestion);
}

function inlineSuggestionFor(activeText: string, suggestion?: string): string {
  if (!activeText.trim() || !suggestion) return "";
  const trimmedActive = activeText.trimEnd();
  const trailingWhitespace = activeText.slice(trimmedActive.length);
  if (!trimmedActive || suggestion.trim() === trimmedActive.trim()) return "";

  if (suggestion.startsWith(activeText)) return suggestion.slice(activeText.length);
  if (suggestion.startsWith(trimmedActive)) return `${trailingWhitespace}${suggestion.slice(trimmedActive.length)}`;
  return `  ${suggestion}`;
}

function previewSuggestion(activeText: string, suggestion: string): string {
  const active = activeText.trim();
  if (!active || suggestion.trim() === active) return suggestion;
  if (suggestion.startsWith(active)) return suggestion.slice(active.length).trimStart() || suggestion;
  return suggestion;
}

function dedupeSuggestions(suggestions: Suggestion[]) {
  const seen = new Set<string>();
  const deduped: Suggestion[] = [];
  for (const suggestion of suggestions) {
    const text = suggestion.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    deduped.push({ ...suggestion, text });
    if (deduped.length >= 6) break;
  }
  return deduped;
}
