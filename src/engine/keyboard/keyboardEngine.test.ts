import { describe, expect, it } from "vitest";
import { createKeyboardEngine, defaultTypingContext } from "./index";
import type { KeyboardKeyEvent } from "./types";
import { finalizeCandidates } from "./candidates";
import { KeyboardSessionManager } from "./session";

function key(value: string): KeyboardKeyEvent {
  return {
    key: value,
    code: value === " " ? "Space" : value.length === 1 ? `Key${value.toUpperCase()}` : value,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    timestamp: 1,
    platform: "test"
  };
}

describe("KeyboardEngine session API", () => {
  it("updates Romanized composition and returns candidates", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "swasthya", 8);
    expect(update.action).toBe("compose");
    expect(update.compositionText).toBe("swasthya");
    expect(update.displayText).toBe("स्वास्थ्य");
    expect(update.primary?.text).toBe("स्वास्थ्य");
    expect(update.primary?.label).toBe("swasthya");
    expect(update.candidates.length).toBeGreaterThan(0);
  });

  it("uses the compiled keyboard runtime pack for live candidates and direct suggestions", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "muskuraundai", 11);
    expect(update.candidates.some((candidate) => candidate.text === "मुस्कुराउँदै")).toBe(true);
    expect(update.candidates.find((candidate) => candidate.text === "मुस्कुराउँदै")?.reason.join(" ")).toMatch(/runtime pack/);

    const suggestions = engine.getSuggestions({
      ...defaultTypingContext("romanized"),
      leftTextWindow: "muskur",
      showRomanizedLabels: true
    });
    expect(suggestions.some((candidate) => candidate.text === "मुस्कुराउँदै")).toBe(true);
  });

  it("suppresses compiled runtime pack suggestions in secure fields", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), secureInput: true });
    const update = engine.updateComposition(sessionId, "muskuraundai", 11);
    expect(update.candidates).toHaveLength(0);
    expect(engine.getSuggestions({ ...defaultTypingContext("romanized"), leftTextWindow: "muskur", secureInput: true })).toHaveLength(0);
  });

  it("processes native-style key strokes", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    for (const char of "swas") {
      engine.processKeyStroke(sessionId, key(char));
    }
    const update = engine.processKeyStroke(sessionId, key("t"));
    expect(update.compositionText).toBe("swast");
    expect(update.candidates.some((candidate) => candidate.text.startsWith("स्व"))).toBe(true);
  });

  it("passes through malformed native key events without corrupting composition", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    engine.updateComposition(sessionId, "swas", 4);
    const update = engine.processKeyStroke(sessionId, { ...key("x"), key: undefined as unknown as string });
    expect(update.action).toBe("passThrough");
    expect(update.compositionText).toBe("swas");
    expect(update.warnings.join(" ")).toMatch(/Malformed key event/);
  });

  it("passes native secure-field keys through without mutating composition", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), secureInput: true, fieldType: "password" });
    const update = engine.processKeyStroke(sessionId, key("s"));
    expect(update.action).toBe("passThrough");
    expect(update.compositionText).toBe("");
    expect(update.candidates).toHaveLength(0);
    expect(update.warnings.join(" ")).toMatch(/Secure/);
  });

  it("handles Backspace, Delete, Tab, Escape, Space, and Enter in the native path", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    engine.updateComposition(sessionId, "swasthya", 8);
    expect(engine.processKeyStroke(sessionId, key("Backspace")).compositionText).toBe("swasthy");
    expect(engine.processKeyStroke(sessionId, key("Delete")).compositionText).toBe("swasthy");
    expect(engine.processKeyStroke(sessionId, key("Tab")).shouldShowCandidateUI).toBe(true);
    const spaceCommit = engine.processKeyStroke(sessionId, key(" "));
    expect(spaceCommit.action).toBe("commit");
    expect(spaceCommit.committedText).toMatch(/^स्वास्थ्य /);
    expect(spaceCommit.compositionText).toBe("");
    const emptyBackspace = engine.processKeyStroke(sessionId, key("Backspace"));
    expect(emptyBackspace.action).toBe("passThrough");
    expect(engine.processKeyStroke(sessionId, key("Escape")).action).toBe("cancel");

    engine.updateComposition(sessionId, "swasthya", 8);
    const committed = engine.processKeyStroke(sessionId, key("Enter"));
    expect(committed.action).toBe("commit");
    expect(committed.committedText).toBe("स्वास्थ्य");
    expect(committed.compositionText).toBe("");
  });

  it("commits selected candidate and clears composition", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "karyalaya", 9);
    const result = engine.commitCandidate(sessionId, update.primary?.id ?? "");
    expect(result.action).toBe("commit");
    expect(result.committedText).toBe("कार्यालय");
    expect(result.consumedRange).toEqual([0, 9]);
    expect(result.memoryRecorded).toBe(true);
    const after = engine.updateComposition(sessionId, "", 0);
    expect(after.compositionText).toBe("");
  });

  it("offers Romanized helper candidates without replacing the Unicode primary", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "swas", 4);
    expect(update.primary?.text).toBe("स्वास्थ्य");
    expect(update.candidates.map((candidate) => candidate.text)).toEqual(
      expect.arrayContaining(["स्वास्थ्य", "स्वस्थ", "स्वास"])
    );
    expect(update.candidates.some((candidate) => candidate.type === "romanized-helper" && candidate.text === "swasthya")).toBe(true);
  });

  it("refines composition when a Romanized helper is selected", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "pra", 3);
    const helper = update.candidates.find((candidate) => candidate.type === "romanized-helper" && candidate.text === "prashasan");
    expect(helper).toBeTruthy();
    const result = engine.commitCandidate(sessionId, helper!.id);
    expect(result.action).toBe("compose");
    expect(result.committedText).toBe("");
    expect(result.memoryRecorded).toBe(false);
    const refined = engine.updateComposition(sessionId, "prashasan", 9);
    expect(refined.compositionText).toBe("prashasan");
  });

  it("keeps Romanized labels optional and independent of dedupe", () => {
    const engine = createKeyboardEngine();
    const labelsOn = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const phrase = "jilla prashasan karyalaya";
    const withLabels = engine.updateComposition(labelsOn, phrase, phrase.length);
    expect(withLabels.primary?.text).toBe("जिल्ला प्रशासन कार्यालय");
    expect(withLabels.primary?.label).toBe("jilla prashasan karyalaya");

    const labelsOff = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: false });
    const withoutLabels = engine.updateComposition(labelsOff, phrase, phrase.length);
    expect(withoutLabels.primary?.text).toBe("जिल्ला प्रशासन कार्यालय");
    expect(withoutLabels.primary?.label).toBeUndefined();
    expect(new Set(withLabels.candidates.map((candidate) => candidate.text)).size).toBe(withLabels.candidates.length);
  });

  it("covers common Prompt 2 Romanized words and government phrases", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), activeDomains: ["government"] });
    const cases = [
      ["mero", "मेरो"],
      ["naam", "नाम"],
      ["prabin", "प्रबिन"],
      ["sankalpa", "संकल्प"],
      ["driDha", "दृढ"],
      ["mero naam", "मेरो नाम"],
      ["driDha sankalpa", "दृढ संकल्प"],
      ["janma dar", "जन्म दर्ता"],
      ["mrityu dar", "मृत्यु दर्ता"],
      ["rajaswa shakha", "राजस्व शाखा"],
      ["kar karyalaya", "कर कार्यालय"],
      ["shiksha mantralaya", "शिक्षा मन्त्रालय"]
    ] as const;

    for (const [input, expected] of cases) {
      const update = engine.updateComposition(sessionId, input, input.length);
      expect(update.candidates.map((candidate) => candidate.text)).toContain(expected);
    }
  });

  it("ranks full mixed Nepali-English spans instead of fragmenting the sentence", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "mero NID form submit bhayena", 28);
    expect(update.primary?.text).toBe("मेरो NID form submit भएन");
    expect(update.candidates.map((candidate) => candidate.text)).toContain("मेरो NID फारम सबमिट भएन");
  });

  it("corrects Romanized typo and phrase forms before Unicode generation", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const typo = engine.updateComposition(sessionId, "swasthay", 8);
    expect(typo.primary?.text).toBe("स्वास्थ्य");
    expect(typo.primary?.label).toBe("swasthya");

    const phrase = engine.updateComposition(sessionId, "nagrikta praman patr", 20);
    expect(phrase.primary?.text).toBe("नागरिकता प्रमाणपत्र");
    expect(phrase.candidates.map((candidate) => candidate.text)).toContain("नागरिकता प्रमाण पत्र");
  });

  it("protects only structured spans inside mixed sentences and preserves English-like unknown tokens", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const mixed = engine.updateComposition(sessionId, "PDF report upload garna milena", 30);
    expect(mixed.primary?.text).toBe("PDF report upload गर्न मिलेन");
    expect(mixed.primary?.text).not.toBe("PDF report upload garna milena");
    expect(mixed.candidates.map((candidate) => candidate.text)).toContain("PDF रिपोर्ट अपलोड गर्न मिलेन");

    const unknown = engine.updateComposition(sessionId, "unknownenglishlike", 18);
    expect(unknown.primary?.text).toBe("unknownenglishlike");
    expect(unknown.primary?.type).toBe("protected");
  });

  it("prefers exact short name candidates over longer prefix completions", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "ram", 3);
    expect(update.primary?.text).toBe("राम");
  });

  it("suppresses low-confidence proofread hints on active prefixes", () => {
    const engine = createKeyboardEngine();
    const activePrefix = engine.getProofHints("से");
    expect(activePrefix).toHaveLength(0);

    const fullTypo = engine.getProofHints("सवस्थ्य");
    expect(fullTypo.some((hint) => hint.suggestion === "स्वास्थ्य")).toBe(true);
  });

  it("dedupes candidate text, merges reasons, and assigns sequential shortcuts after sorting", () => {
    const candidates = finalizeCandidates([
      {
        id: "a",
        text: "प्रबिनको",
        type: "word",
        confidence: 0.7,
        reason: ["dictionary"],
        shortcut: "9"
      },
      {
        id: "b",
        text: "प्रबिनको",
        type: "personal",
        confidence: 0.92,
        reason: ["memory"],
        shortcut: "2"
      },
      {
        id: "c",
        text: "प्रवीण",
        type: "word",
        confidence: 0.85,
        reason: ["alias"]
      }
    ]);

    expect(candidates.map((candidate) => candidate.text)).toEqual(["प्रबिनको", "प्रवीण"]);
    expect(candidates[0].type).toBe("personal");
    expect(candidates[0].reason).toEqual(["memory", "dictionary"]);
    expect(candidates.map((candidate) => candidate.shortcut)).toEqual(["1", "2"]);
  });

  it("returns unique visible candidates with gapless shortcuts from live Romanized input", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "swas", 4);
    expect(new Set(update.candidates.map((candidate) => candidate.text)).size).toBe(update.candidates.length);
    expect(update.candidates.map((candidate) => candidate.shortcut)).toEqual(
      update.candidates.map((_, index) => String(index + 1))
    );
  });

  it("boosts repeated local memory selections without using secure fields", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    let update = engine.updateComposition(sessionId, "prabin", 6);
    const second = update.candidates.find((candidate) => candidate.text !== update.primary?.text);
    expect(second).toBeTruthy();
    engine.commitCandidate(sessionId, second!.id);

    update = engine.updateComposition(sessionId, "prabin", 6);
    expect(update.candidates[0].text).toBe(second!.text);
    expect(update.candidates[0].type).toBe("personal");

    const secureId = engine.beginSession({ ...defaultTypingContext("romanized"), secureInput: true });
    const secure = engine.updateComposition(secureId, "prabin", 6);
    expect(secure.candidates).toHaveLength(0);
  });

  it("honors pinned personal memory and never-suggest blocks safely", () => {
    const engine = createKeyboardEngine();
    engine.learnCorrection({
      inputRomanized: "prabin",
      chosenOutput: "प्रवीण",
      source: "user-add-dictionary",
      frequency: 3,
      pinned: true
    });
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const pinned = engine.updateComposition(sessionId, "prabin", 6);
    expect(pinned.primary?.text).toBe("प्रवीण");
    expect(pinned.primary?.type).toBe("personal");

    engine.learnCorrection({
      inputRomanized: "prabin",
      chosenOutput: "प्रवीण",
      source: "user-add-dictionary",
      blocked: true
    });
    const blocked = engine.updateComposition(sessionId, "prabin", 6);
    expect(blocked.candidates.some((candidate) => candidate.text === "प्रवीण")).toBe(false);
  });

  it("returns conservative next-word followups after candidate commit", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "jilla", 5);
    const candidate = update.candidates.find((item) => item.text === "जिल्ला");
    expect(candidate).toBeTruthy();
    const result = engine.commitCandidate(sessionId, candidate!.id);
    expect(result.committedText).toBe("जिल्ला");
    expect(result.followupCandidates?.some((candidate) => candidate.text === "प्रशासन")).toBe(true);
  });

  it("returns civil-registration next-word followups", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "janma", 5);
    const candidate = update.candidates.find((item) => item.text === "जन्म");
    expect(candidate).toBeTruthy();
    const result = engine.commitCandidate(sessionId, candidate!.id);
    expect(result.committedText).toBe("जन्म");
    expect(result.followupCandidates?.some((candidate) => candidate.text === "दर्ता")).toBe(true);
  });

  it("preserves raw input in secure contexts", () => {
    const engine = createKeyboardEngine();
    const context = {
      ...defaultTypingContext("romanized"),
      secureInput: true,
      fieldType: "password" as const
    };
    const sessionId = engine.beginSession(context);
    const update = engine.updateComposition(sessionId, "swasthya", 8);
    expect(update.displayText).toBe("swasthya");
    expect(update.candidates).toHaveLength(0);
    expect(update.proofHints).toHaveLength(0);
    expect(update.warnings.join(" ")).toMatch(/Secure/);
  });

  it("keeps multiple sessions isolated and makes stale events safe after endSession", () => {
    const engine = createKeyboardEngine();
    const first = engine.beginSession(defaultTypingContext("romanized"));
    const second = engine.beginSession(defaultTypingContext("romanized"));
    engine.updateComposition(first, "jilla", 5);
    engine.updateComposition(second, "swasthya", 8);

    expect(engine.updateComposition(first, "jilla", 5).primary?.text).toBe("जिल्ला");
    expect(engine.updateComposition(second, "swasthya", 8).primary?.text).toBe("स्वास्थ्य");

    engine.endSession(first);
    const stale = engine.processKeyStroke(first, key("a"));
    expect(stale.warnings.join(" ")).toMatch(/Unknown keyboard session/);
    expect(engine.updateComposition(second, "swasthya", 8).primary?.text).toBe("स्वास्थ्य");
  });

  it("flushes sessions and local memory on shutdown", async () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "prabin", 6);
    const alternate = update.candidates.find((candidate) => candidate.text !== update.primary?.text);
    expect(alternate).toBeTruthy();
    engine.commitCandidate(sessionId, alternate!.id);
    expect(engine.updateComposition(sessionId, "prabin", 6).primary?.text).toBe(alternate!.text);

    await engine.shutdown();
    const stale = engine.updateComposition(sessionId, "prabin", 6);
    expect(stale.warnings.join(" ")).toMatch(/Unknown keyboard session/);

    const fresh = engine.beginSession(defaultTypingContext("romanized"));
    expect(engine.updateComposition(fresh, "prabin", 6).primary?.type).not.toBe("personal");
  });

  it("keeps Traditional mode as an honest placeholder until audit completes", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("traditional"));
    const update = engine.updateComposition(sessionId, "abc", 3);
    expect(update.displayText).toBe("abc");
    expect(update.candidates).toHaveLength(0);
    expect(update.warnings.join(" ")).toMatch(/Traditional layout mapping pending/);
  });

  it("supports Traditional Unicode suggestions and proofread without a final keymap", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("traditional"));
    const update = engine.updateComposition(sessionId, "स्वा", 3);
    expect(update.candidates.some((candidate) => candidate.text === "स्वास्थ्य")).toBe(true);
    const typo = engine.updateComposition(sessionId, "सवस्थ्य", 7);
    expect(typo.proofHints.some((hint) => hint.suggestion === "स्वास्थ्य")).toBe(true);
  });

  it("supports proof hints, dictionary lookup, mode changes, and warm", async () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    expect(engine.getProofHints("सवस्थ्य")).toHaveLength(1);
    expect(engine.lookupDictionary("swasthya").some((row) => row.word === "स्वास्थ्य")).toBe(true);
    engine.setMode(sessionId, "traditional");
    expect(engine.updateComposition(sessionId, "x", 1).warnings.join(" ")).toMatch(/Traditional/);
    const warm = await engine.warm({ timeoutMs: 50 });
    expect(warm.loadedModules.length).toBeGreaterThan(0);
  });

  it("handles unknown sessions with safe results instead of crashing native callers", () => {
    const engine = createKeyboardEngine();
    const update = engine.updateComposition("missing-session", "swas", 4);
    expect(update.action).toBe("errorFallback");
    expect(update.displayText).toBe("swas");
    expect(update.warnings.join(" ")).toMatch(/Unknown keyboard session/);
    const commit = engine.commitRaw("missing-session");
    expect(commit.action).toBe("errorFallback");
    expect(commit.committedText).toBe("");
  });

  it("evicts idle sessions with TTL cleanup for daemon lifecycle safety", () => {
    const manager = new KeyboardSessionManager(1, 2);
    const first = manager.beginSession(defaultTypingContext("romanized"));
    const second = manager.beginSession(defaultTypingContext("romanized"));
    manager.updateComposition(second, "swas", 4);
    expect(manager.has(first)).toBe(true);
    expect(manager.cleanupExpired(Date.now() + 10)).toBeGreaterThan(0);
    expect(manager.has(first)).toBe(false);
    expect(manager.has(second)).toBe(false);
  });
});
