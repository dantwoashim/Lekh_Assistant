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

const MODES: Array<{ id: TypingMode; label: string; engineMode: Extract<KeyboardMode, "romanized" | "traditional">; placeholder: string }> = [
  {
    id: "romanized-romanized",
    label: "Romanized-Romanized",
    engineMode: "romanized",
    placeholder: "swas"
  },
  {
    id: "romanized-traditional",
    label: "Romanized-Traditional",
    engineMode: "romanized",
    placeholder: "swasthya karyalaya"
  },
  {
    id: "traditional-traditional",
    label: "Traditional-Traditional",
    engineMode: "traditional",
    placeholder: "स्वा"
  },
  {
    id: "traditional-romanized",
    label: "Traditional-Romanized",
    engineMode: "traditional",
    placeholder: "स्वास्थ्य"
  }
];

const ACTIVE_DOMAINS = ["general", "government", "office", "education", "health", "tech", "legal", "admin"];

export function FocusedKeyboard() {
  const engine = useMemo(() => createKeyboardEngine(), []);
  const [mode, setMode] = useState<TypingMode>("romanized-traditional");
  const [sessionId, setSessionId] = useState<SessionId>(() => engine.beginSession(contextFor("romanized")));
  const [input, setInput] = useState("");
  const [update, setUpdate] = useState<CandidateUpdate>(() => engine.updateComposition(sessionId, "", 0));
  const [selectedIndex, setSelectedIndex] = useState(0);
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
    };
  }, [engine]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const liveValue = inputRef.current?.value;
      if (typeof liveValue !== "string") return;
      setInput((currentValue) => {
        if (liveValue === currentValue) return currentValue;
        setSelectedIndex(0);
        const [start, end] = activeCompositionRange(liveValue);
        const activeText = liveValue.slice(start, end);
        engine.setContext(sessionId, {
          leftTextWindow: liveValue.slice(0, start),
          rightTextWindow: liveValue.slice(end)
        });
        setUpdate(engine.updateComposition(sessionId, activeText, activeText.length));
        return liveValue;
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [engine, sessionId]);

  const modeDefinition = MODES.find((item) => item.id === mode) ?? MODES[1];
  const suggestions = suggestionsForMode(update, mode);
  const activeSuggestion = suggestions[selectedIndex] ?? suggestions[0];
  const activeText = activeCompositionText(input);
  const inlineSuggestion = inlineSuggestionFor(activeText, activeSuggestion?.text);

  function changeMode(nextMode: TypingMode) {
    const nextDefinition = MODES.find((item) => item.id === nextMode) ?? MODES[1];
    engine.endSession(sessionId);
    const nextSessionId = engine.beginSession(contextFor(nextDefinition.engineMode));
    setMode(nextMode);
    setSessionId(nextSessionId);
    setInput("");
    setSelectedIndex(0);
    setUpdate(engine.updateComposition(nextSessionId, "", 0));
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.focus();
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
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

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return undefined;
    const sync = () => refresh(node.value);
    node.addEventListener("input", sync);
    node.addEventListener("keyup", sync);
    node.addEventListener("compositionend", sync);
    return () => {
      node.removeEventListener("input", sync);
      node.removeEventListener("keyup", sync);
      node.removeEventListener("compositionend", sync);
    };
  }, [refresh]);

  function acceptSuggestion(suggestion = activeSuggestion) {
    if (!suggestion) return;
    const nextInput = replaceActiveComposition(input, suggestion.text);
    if (inputRef.current) inputRef.current.value = nextInput;
    refresh(nextInput);
    window.requestAnimationFrame(() => {
      const length = nextInput.length;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(length, length);
    });
  }

  function syncGhostScroll() {
    if (!inputRef.current || !ghostRef.current) return;
    ghostRef.current.scrollTop = inputRef.current.scrollTop;
    ghostRef.current.scrollLeft = inputRef.current.scrollLeft;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && activeSuggestion) {
      event.preventDefault();
      acceptSuggestion(activeSuggestion);
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

    window.requestAnimationFrame(() => {
      const liveValue = inputRef.current?.value;
      if (typeof liveValue === "string") refresh(liveValue);
    });
  }

  return (
    <main className="typing-shell">
      <section className="typing-surface" aria-label="Typing surface">
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
            onInput={(event) => refresh(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            onScroll={syncGhostScroll}
            placeholder={modeDefinition.placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            rows={8}
          />
          <div className="sr-only" aria-live="polite">
            {activeSuggestion ? `Suggestion: ${activeSuggestion.text}` : ""}
          </div>
        </div>
      </section>
    </main>
  );
}

function contextFor(mode: Extract<KeyboardMode, "romanized" | "traditional">) {
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
      update.candidates
        .map((candidate) => candidate.label)
        .filter((label): label is string => Boolean(label && label !== "preserve" && /[a-z]/i.test(label)))
        .map((label, index) => ({ id: `traditional-romanized-${index}-${label}`, text: label }))
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

function activeCompositionRange(input: string): TextRange {
  const end = input.length;
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
  const maxWords = 9;
  const matches = Array.from(segment.matchAll(/\S+/g));
  if (matches.length > maxWords) {
    const cutoff = matches[matches.length - maxWords]?.index;
    if (typeof cutoff === "number") start += cutoff;
  }

  return [start, end];
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
