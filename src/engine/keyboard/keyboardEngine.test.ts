import { describe, expect, it } from "vitest";
import engineContract from "../../../data/engine/lekh-engine-contract.v1.json";
import ngramModel from "../../data/keyboard-packs/v0.1/ngram-lm.json";
import predictionModel from "../../data/keyboard-packs/v0.1/prediction-model.json";
import { createKeyboardEngine, defaultTypingContext } from "./index";
import type { KeyboardKeyEvent } from "./types";
import { finalizeCandidates } from "./candidates";
import { buildKeyboardMemorySelection, importKeyboardMemoryEntry } from "./memory";
import { KeyboardSessionManager } from "./session";

const MAXIMUM_COMPOSITION_UTF16 = engineContract.hotPathPolicy.maximumCompositionUtf16CodeUnits;

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
  it("keeps all four product modes distinct at the engine boundary", () => {
    const engine = createKeyboardEngine();
    const cases = [
      ["romanized-romanized", "swas", "romanized-to-romanized"],
      ["romanized-traditional", "swas", "romanized-to-unicode"],
      ["traditional-traditional", "स्वा", "traditional-to-unicode"],
      ["traditional-romanized", "स्वा", "traditional-to-romanized-helper"]
    ] as const;

    for (const [mode, input, surface] of cases) {
      const sessionId = engine.beginSession(defaultTypingContext(mode));
      const update = engine.updateComposition(sessionId, input, input.length);
      expect(update.mode).toBe(mode);
      expect(update.surface).toBe(surface);
      engine.endSession(sessionId);
    }
  });

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

  it("uses romanization tolerance for common Nepali typing variants", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "thaperaa", 8);
    const candidate = update.candidates.find((item) => item.text === "थपेर");

    expect(candidate).toBeDefined();
    expect(candidate?.reason.join(" ")).toMatch(/romanization/);
    expect(update.candidates.some((item) => item.text === "थापेर")).toBe(true);
  });

  it("uses the trained aggregate prediction model for contextual Romanized suggestions", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "ramro x", 7);
    const trainedCandidate = update.candidates.find((candidate) =>
      candidate.label === "ramro xa" && candidate.reason.join(" ").includes("trained prediction model")
    );

    expect(trainedCandidate?.text).toBe("राम्रो छ");
    expect(trainedCandidate?.confidence).toBeGreaterThan(0.7);
  });

  it("uses the quantized local n-gram model for inline next-word completion", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({
      ...defaultTypingContext("romanized"),
      leftTextWindow: "मेरो ",
      showRomanizedLabels: true
    });
    const update = engine.updateComposition(sessionId, "", 0);

    expect(update.inlineCompletion?.source).toBe("ngram-lm");
    expect(update.inlineCompletion?.text).toBe("नाम");
    expect(update.inlineCompletion?.displayText).toBe("नाम");
    expect(update.inlineCompletion?.candidate.label).toBe("naam");
  });

  it("returns n-gram follow-up candidates after a committed word", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "swasthya", 8);
    const result = engine.commitCandidate(sessionId, update.primary?.id ?? "");

    expect(result.followupCandidates?.[0]?.text).toBe("कार्यालय");
    expect(result.followupCandidates?.[0]?.label).toBe("karyalaya");
    expect(result.followupCandidates?.[0]?.reason.join(" ")).toMatch(/local n-gram/);
  });

  it("suppresses n-gram inline completions in secure fields", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({
      ...defaultTypingContext("romanized"),
      leftTextWindow: "मेरो ",
      secureInput: true,
      fieldType: "password"
    });
    const update = engine.updateComposition(sessionId, "", 0);

    expect(update.action).toBe("passThrough");
    expect(update.inlineCompletion).toBeUndefined();
    expect(update.candidates).toHaveLength(0);
  });

  it("keeps curated inline n-gram spellings natural", () => {
    const model = ngramModel as { rows: Array<{ c: string; n: string; r?: string }> };
    const swasthya = model.rows.find((row) => row.c === "स्वास्थ्य" && row.r === "bima");
    const ramro = model.rows.find((row) => row.c === "राम्रो" && row.r === "lagyo");

    expect(swasthya?.n).toBe("बीमा");
    expect(ramro?.n).toBe("लाग्यो");
    expect(model.rows.some((row) => row.n === "लज्ञो" || row.n === "वीमा")).toBe(false);
  });

  it("keeps unsafe public-comment tokens out of the default trained runtime model", () => {
    const unsafeExact = new Set(["lado", "muji", "mugi", "randi", "radi", "chikne", "chikni", "machikne", "machikney", "khate", "khatey", "gandu", "boka"]);
    const unsafePrefixes = ["lado", "muji", "mugi", "randi", "radi", "chikne", "machikne", "khate", "khatey", "gandu"];
    const unsafe = (token: string) =>
      unsafeExact.has(token) || unsafePrefixes.some((prefix) => token.startsWith(prefix) && token.length <= prefix.length + 5);
    const model = predictionModel as {
      contextPredictions: Array<{ c: string; n: string }>;
      prefixPredictions: Array<{ p: string; m: string }>;
    };

    const contextHit = model.contextPredictions.find((row) => unsafe(row.n) || row.c.split(" ").some(unsafe));
    const prefixHit = model.prefixPredictions.find((row) => row.p.split(" ").some(unsafe) || row.m.split(" ").some(unsafe));

    expect(contextHit).toBeUndefined();
    expect(prefixHit).toBeUndefined();
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

  it("keeps candidate selection identifiers bounded for long admissible compositions", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const input = "a".repeat(MAXIMUM_COMPOSITION_UTF16);
    const update = engine.updateComposition(sessionId, input, input.length);
    expect(update.candidates.length).toBeGreaterThan(0);
    expect(update.candidates.every((candidate) => candidate.id.length <= 256)).toBe(true);
    expect(new Set(update.candidates.map((candidate) => candidate.id)).size).toBe(update.candidates.length);
  });

  it("accepts the exact composition bound and rejects +1 without mutating cached state", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const maximum = "a".repeat(MAXIMUM_COMPOSITION_UTF16);
    const atLimit = engine.updateComposition(sessionId, maximum, maximum.length);
    expect(atLimit.compositionText).toBe(maximum);
    const candidateIds = atLimit.candidates.map((candidate) => candidate.id);

    const overflow = engine.processKeyStroke(sessionId, key("b"));
    expect(overflow.action).toBe("passThrough");
    expect(overflow.compositionText).toBe(maximum);
    expect(overflow.caret).toBe(maximum.length);
    expect(overflow.candidates).toEqual([]);
    expect(overflow.proofHints).toEqual([]);

    const overflowWire = JSON.parse(JSON.stringify(overflow)) as Record<string, unknown>;
    for (const optionalKey of ["primary", "inlineCompletion", "committedText", "consumedRange"]) {
      expect(overflowWire).not.toHaveProperty(optionalKey);
    }

    const rejectedBulkUpdate = engine.updateComposition(sessionId, `${maximum}c`, maximum.length + 1);
    expect(rejectedBulkUpdate.action).toBe("errorFallback");
    expect(rejectedBulkUpdate.compositionText).toBe(maximum);
    expect(rejectedBulkUpdate.candidates).toEqual([]);

    const unchanged = engine.updateComposition(sessionId, maximum, maximum.length);
    expect(unchanged.candidates.map((candidate) => candidate.id)).toEqual(candidateIds);

    const committed = engine.processKeyStroke(sessionId, key("Enter"));
    expect(committed.action).toBe("commit");
    expect(committed.committedText).toBe(`${maximum}\n`);
    expect(committed.committedText?.length).toBe(MAXIMUM_COMPOSITION_UTF16 + 1);
    expect(committed.compositionText).toBe("");
  });

  it("keeps exact-bound edits on extended grapheme boundaries", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const prefix = "a".repeat(MAXIMUM_COMPOSITION_UTF16 - 2);
    const maximum = `${prefix}😀`;
    expect(maximum.length).toBe(MAXIMUM_COMPOSITION_UTF16);

    const atLimit = engine.updateComposition(sessionId, maximum, maximum.length);
    expect(atLimit.compositionText).toBe(maximum);
    expect(atLimit.caret).toBe(maximum.length);

    const overflow = engine.processKeyStroke(sessionId, key("b"));
    expect(overflow.action).toBe("passThrough");
    expect(overflow.compositionText).toBe(maximum);

    const deleted = engine.processKeyStroke(sessionId, key("Backspace"));
    expect(deleted.compositionText).toBe(prefix);
    expect(deleted.caret).toBe(prefix.length);
  });

  it("never reuses a candidate selection identifier across colliding legacy hash inputs", () => {
    const costarring = {
      id: "first",
      text: "costarring",
      type: "word" as const,
      confidence: 1,
      reason: []
    };
    const liquid = {
      id: "second",
      text: "liquid",
      type: "word" as const,
      confidence: 1,
      reason: []
    };
    const first = finalizeCandidates([costarring]);
    const second = finalizeCandidates([liquid]);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect(finalizeCandidates([costarring])[0]?.id).toBe(first[0]?.id);
    expect(first[0]?.id).toMatch(/^candidate-[a-f0-9]{32}$/u);
  });

  it("keeps candidate identifiers stable across input order, rank changes, and engine instances", () => {
    const health = {
      id: "health-source",
      text: "स्वास्थ्य",
      type: "word" as const,
      confidence: 0.9,
      reason: ["health"]
    };
    const welcome = {
      id: "welcome-source",
      text: "स्वागत",
      type: "word" as const,
      confidence: 0.8,
      reason: ["welcome"]
    };
    const first = finalizeCandidates([health, welcome]);
    const reordered = finalizeCandidates([
      { ...welcome, confidence: 0.99 },
      { ...health, confidence: 0.1 }
    ]);
    const firstIds = new Map(first.map((candidate) => [candidate.text, candidate.id]));
    const reorderedIds = new Map(reordered.map((candidate) => [candidate.text, candidate.id]));
    expect(reorderedIds).toEqual(firstIds);

    const firstEngine = createKeyboardEngine();
    const secondEngine = createKeyboardEngine();
    const firstSession = firstEngine.beginSession(defaultTypingContext("romanized"));
    const secondSession = secondEngine.beginSession(defaultTypingContext("romanized"));
    const firstUpdate = firstEngine.updateComposition(firstSession, "swas", 4);
    const secondUpdate = secondEngine.updateComposition(secondSession, "swas", 4);
    expect(secondUpdate.candidates.map(({ id }) => id)).toEqual(firstUpdate.candidates.map(({ id }) => id));
  });

  it("rejects a semantic candidate ID after it leaves the current composition generation", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const first = engine.updateComposition(sessionId, "swas", 4);
    const staleCandidate = first.candidates.find((candidate) => candidate.text === "स्वास्थ्य");
    expect(staleCandidate).toBeDefined();

    const current = engine.updateComposition(sessionId, "ramro", 5);
    expect(current.candidates.some((candidate) => candidate.id === staleCandidate!.id)).toBe(false);
    const rejected = engine.commitCandidate(sessionId, staleCandidate!.id);

    expect(rejected.action).toBe("errorFallback");
    expect(rejected.committedText).toBe("");
    expect(rejected.commitEpoch).toBe(0);
    expect(engine.updateComposition(sessionId, "ramro", 5).compositionText).toBe("ramro");
  });

  it("passes through malformed native key events without corrupting composition", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    engine.updateComposition(sessionId, "swas", 4);
    const update = engine.processKeyStroke(sessionId, { ...key("x"), key: undefined as unknown as string });
    expect(update.action).toBe("passThrough");
    expect(update.compositionText).toBe("swas");
    expect(update.warnings.join(" ")).toMatch(/Malformed key event/);
    const malformedUtf16 = engine.processKeyStroke(sessionId, { ...key("x"), key: "\ud800" });
    expect(malformedUtf16.action).toBe("passThrough");
    expect(malformedUtf16.compositionText).toBe("swas");

    const rejectedBulkUpdate = engine.updateComposition(sessionId, "broken-\udc00", 8);
    expect(rejectedBulkUpdate.action).toBe("errorFallback");
    expect(rejectedBulkUpdate.compositionText).toBe("swas");
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
    const acceptedGhost = engine.processKeyStroke(sessionId, key("Tab"));
    expect(acceptedGhost.action).toBe("commit");
    expect(acceptedGhost.committedText).toBe("स्वास्थ्य");
    engine.updateComposition(sessionId, "swasthy", 7);
    const spaceCommit = engine.processKeyStroke(sessionId, key(" "));
    expect(spaceCommit.action).toBe("commit");
    expect(spaceCommit.committedText).toBe("swasthy ");
    expect(spaceCommit.compositionText).toBe("");
    const emptyBackspace = engine.processKeyStroke(sessionId, key("Backspace"));
    expect(emptyBackspace.action).toBe("passThrough");
    const emptyEnter = engine.processKeyStroke(sessionId, key("Enter"));
    expect(emptyEnter.action).toBe("passThrough");
    expect(emptyEnter.committedText).toBeUndefined();
    expect(emptyEnter.compositionText).toBe("");
    expect(engine.processKeyStroke(sessionId, key("Escape")).action).toBe("cancel");

    engine.updateComposition(sessionId, "swas", 4);
    const rightAcceptedGhost = engine.processKeyStroke(sessionId, key("ArrowRight"));
    expect(rightAcceptedGhost.action).toBe("commit");
    expect(rightAcceptedGhost.committedText).toBe("स्वास्थ्य");

    engine.updateComposition(sessionId, "swasthya", 8);
    const committed = engine.processKeyStroke(sessionId, key("Enter"));
    expect(committed.action).toBe("commit");
    expect(committed.committedText).toBe("swasthya\n");
    expect(committed.compositionText).toBe("");
  });

  it("commits native candidate shortcuts 1-9 without inserting the digit", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    engine.updateComposition(sessionId, "swas", 4);

    const committed = engine.processKeyStroke(sessionId, key("2"));
    expect(committed.action).toBe("commit");
    expect(committed.committedText).toBe("स्वस्थ");
    expect(committed.compositionText).toBe("");
    expect(committed).not.toHaveProperty("commitEpoch");
    expect(committed).not.toHaveProperty("memoryRecorded");

    const afterUnacknowledgedCommit = engine.updateComposition(sessionId, "swas", 4);
    expect(afterUnacknowledgedCommit.candidates.some((candidate) => (
      candidate.type === "personal" && candidate.text === "स्वस्थ"
    ))).toBe(false);
  });

  it("commits selected candidate and clears composition", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), fieldType: "normal" });
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
    const prior = engine.updateComposition(sessionId, "swasthya", 8);
    const priorCommit = engine.commitCandidate(sessionId, prior.primary?.id ?? "");
    expect(priorCommit.action).toBe("commit");
    expect(priorCommit.commitEpoch).toBe(1);

    const update = engine.updateComposition(sessionId, "pra", 3);
    const helper = update.candidates.find((candidate) => candidate.type === "romanized-helper" && candidate.text === "prashasan");
    expect(helper).toBeTruthy();
    const result = engine.commitCandidate(sessionId, helper!.id);
    expect(result.action).toBe("compose");
    expect(result.committedText).toBe("");
    expect(result.commitEpoch).toBe(0);
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

  it("keeps live suggestions populated for active Romanized prefixes inside sentences", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const cases = [
      ["k", "के", "k"],
      ["jilla p", "जिल्ला प्रशासन", "jilla prashasan"],
      ["nagarikta p", "नागरिकता प्रमाणपत्र", "nagarikta pramanpatra"],
      ["swasthya k", "स्वास्थ्य कार्यालय", "swasthya karyalaya"]
    ] as const;

    for (const [input, unicodeCandidate, romanizedCandidate] of cases) {
      const update = engine.updateComposition(sessionId, input, input.length);
      expect(update.shouldShowCandidateUI).toBe(true);
      expect(update.candidates.length).toBeGreaterThan(0);
      expect(update.candidates.map((candidate) => candidate.text)).toContain(unicodeCandidate);
      expect(update.candidates.map((candidate) => candidate.label)).toContain(romanizedCandidate);
    }
    const singleToken = engine.updateComposition(sessionId, "mero", 4);
    expect(singleToken.candidates.every((candidate) => !candidate.text.trim().includes(" "))).toBe(true);
  });

  it("covers casual Romanized Nepali words, slang spellings, and social phrases", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const cases = [
      ["kasto", "कस्तो", "kasto"],
      ["kasto cha", "कस्तो छ", "kasto cha"],
      ["k gardai chau", "के गर्दै छौ", "k gardai chau"],
      ["hunxa", "हुन्छ", "hunxa"],
      ["garna", "गर्न", "garna"],
      ["parxa", "पर्छ", "parxa"],
      ["aaja", "आज", "aaja"],
      ["bholi", "भोलि", "bholi"],
      ["malai", "मलाई", "malai"],
      ["timro", "तिम्रो", "timro"],
      ["ramro", "राम्रो", "ramro"],
      ["ramro lagyo", "राम्रो लाग्यो", "ramro lagyo"],
      ["sanchai", "सञ्चै", "sanchai"],
      ["ma aaudai xu", "म आउँदै छु", "ma aaudai xu"],
      ["timi kaha chau", "तिमी कहाँ छौ", "timi kaha chau"],
      ["ghar jane", "घर जाने", "ghar jane"],
      ["dherai dhanyabad", "धेरै धन्यवाद", "dherai dhanyabad"]
    ] as const;

    for (const [input, expected, label] of cases) {
      const update = engine.updateComposition(sessionId, input, input.length);
      expect(update.shouldShowCandidateUI, input).toBe(true);
      expect(update.candidates.map((candidate) => candidate.text), input).toContain(expected);
      expect(update.candidates.map((candidate) => candidate.label), input).toContain(label);
    }
  });

  it("normalizes casual Romanized shorthand instead of echoing raw text", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "mero k xa awastha", 17);

    expect(update.candidates.map((candidate) => candidate.text)).toContain("मेरो के छ अवस्था");
    expect(update.candidates.some((candidate) => candidate.type === "romanized-helper" && candidate.text === "mero ke cha awastha")).toBe(true);
    expect(update.candidates.find((candidate) => candidate.text === "मेरो के छ अवस्था")?.label).toBe("mero k xa awastha");
  });

  it("offers status phrase completions without relying on raw Romanized echoes", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "mero ke cha", 11);

    expect(update.candidates.map((candidate) => candidate.text)).toContain("मेरो के छ अवस्था");
    expect(update.candidates.map((candidate) => candidate.label)).toContain("mero ke cha awastha");
  });

  it("progressively completes casual Romanized prefixes instead of waiting for exact words", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const cases = [
      ["kas", "कस्तो", "kasto"],
      ["kasto c", "कस्तो छ", "kasto cha"],
      ["k gard", "के गर्दै छौ", "k gardai chau"],
      ["ma aa", "म आउँदै छु", "ma aaudai xu"],
      ["ramro l", "राम्रो लाग्यो", "ramro lagyo"],
      ["dherai d", "धेरै धन्यवाद", "dherai dhanyabad"]
    ] as const;

    for (const [input, expected, label] of cases) {
      const update = engine.updateComposition(sessionId, input, input.length);
      expect(update.candidates.map((candidate) => candidate.text), input).toContain(expected);
      expect(update.candidates.map((candidate) => candidate.label), input).toContain(label);
    }
  });

  it("never returns an empty live suggestion list for alphabetic Romanized starts", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const starts = "abcdefghijklmnopqrstuvwxyz".split("");

    for (const start of starts) {
      const single = engine.updateComposition(sessionId, start, start.length);
      expect(single.candidates.length, `single prefix ${start}`).toBeGreaterThan(0);
      expect(single.shouldShowCandidateUI, `single prefix ${start}`).toBe(true);

      const sentence = `mero ${start}`;
      const sentenceUpdate = engine.updateComposition(sessionId, sentence, sentence.length);
      expect(sentenceUpdate.candidates.length, `sentence prefix ${sentence}`).toBeGreaterThan(0);
      expect(sentenceUpdate.shouldShowCandidateUI, `sentence prefix ${sentence}`).toBe(true);
    }
  });

  it("ranks full mixed Nepali-English spans instead of fragmenting the sentence", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });
    const update = engine.updateComposition(sessionId, "mero NID form submit bhayena", 28);
    expect(update.primary?.text).toBe("मेरो NID form submit भएन");
    expect(update.candidates.map((candidate) => candidate.text)).toContain("मेरो NID फारम सबमिट भएन");
  });

  it("applies mixed token policy beyond exact fixture rows", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });

    const pan = engine.updateComposition(sessionId, "mero PAN file upload bhayena", 28);
    expect(pan.candidates.map((candidate) => candidate.text)).toContain("मेरो PAN file upload भएन");
    expect(pan.candidates.map((candidate) => candidate.text)).toContain("मेरो PAN फाइल अपलोड भएन");

    const email = engine.updateComposition(sessionId, "email@test.com pathaunu", 22);
    expect(email.primary?.text).toContain("email@test.com");
    expect(email.candidates.map((candidate) => candidate.text)).toContain("email@test.com पठाउनु");
  });

  it("uses context-aware code switching instead of a static preserve list", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });

    const email = engine.updateComposition(sessionId, "mero email gmail pathaunu", 26);
    expect(email.candidates.map((candidate) => candidate.text)).toContain("मेरो email gmail पठाउनु");
    expect(email.primary?.text).toBe("मेरो email gmail पठाउनु");

    const hospital = engine.updateComposition(sessionId, "ma hospital gaye", 16);
    const texts = hospital.candidates.map((candidate) => candidate.text);
    expect(texts).toContain("म hospital गये");
    expect(texts).toContain("म अस्पताल गये");
    expect(texts.indexOf("म hospital गये")).toBeLessThan(texts.indexOf("म अस्पताल गये"));
  });

  it("preserves Nepal-specific wallet, telco, and messaging brands", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });

    const cases = [
      ["eSewa pathaunu", "eSewa पठाउनु"],
      ["Khalti login garna", "Khalti login गर्न"],
      ["Ncell recharge garnu", "Ncell recharge गर्नु"],
      ["WhatsApp ma pathaunu", "WhatsApp म पठाउनु"],
      ["IME Pay pathaunu", "IME Pay पठाउनु"],
      ["Wi-Fi password pathaunu", "Wi-Fi password पठाउनु"],
      ["Viber ma message pathaunu", "Viber म message पठाउनु"]
    ] as const;

    for (const [input, expected] of cases) {
      const update = engine.updateComposition(sessionId, input, input.length);
      expect(update.candidates.map((candidate) => candidate.text), input).toContain(expected);
    }
  });

  it("honors explicit keep-English gestures", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));

    const equals = engine.updateComposition(sessionId, "hospital=", 9);
    expect(equals.primary?.text).toBe("hospital");
    expect(equals.primary?.type).toBe("protected");

    const doubleSpace = engine.updateComposition(sessionId, "hello  world", 12);
    expect(doubleSpace.primary?.text).toBe("hello world");
    expect(doubleSpace.primary?.reason.join(" ")).toMatch(/keep-English/);
  });

  it("adds smart dates, numbers, emoji shortcuts, and text-expansion candidates", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });

    expect(engine.updateComposition(sessionId, "2081 saal", 9).primary?.text).toBe("२०८१ साल");
    expect(engine.updateComposition(sessionId, "ru 1200", 7).primary?.text).toBe("रु १,२००");
    expect(engine.updateComposition(sessionId, ":namaste:", 9).primary?.text).toBe("🙏");
    expect(engine.updateComposition(sessionId, "@@addr", 6).primary?.text).toBe("काठमाडौं, नेपाल");
    expect(engine.updateComposition(sessionId, "aja", 3).candidates.every((candidate) => !candidate.text.includes(" "))).toBe(true);
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

  it("keeps exact words above phrase completions until the phrase boundary is typed", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), showRomanizedLabels: true });

    expect(engine.updateComposition(sessionId, "dridha", 6).primary?.text).toBe("दृढ");
    expect(engine.updateComposition(sessionId, "janma", 5).primary?.text).toBe("जन्म");
    expect(engine.updateComposition(sessionId, "mrityu", 6).primary?.text).toBe("मृत्यु");
    expect(engine.updateComposition(sessionId, "janma d", 7).primary?.text).toBe("जन्म दर्ता");
  });

  it("uses left-context signals for official, health, education, tech, and casual predictions", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({
      ...defaultTypingContext("romanized"),
      showRomanizedLabels: true,
      activeDomains: ["general", "government", "office", "education", "health", "tech", "admin"]
    });

    const cases = [
      {
        leftTextWindow: "mero NID form submit bhayena. ward ko sifaris ko lagi ",
        input: "jilla p",
        expected: "जिल्ला प्रशासन",
        label: "jilla prashasan"
      },
      {
        leftTextWindow: "hospital ko report cha doctor le bima ko lagi ",
        input: "swasthya b",
        expected: "स्वास्थ्य बीमा",
        label: "swasthya bima"
      },
      {
        leftTextWindow: "school exam result ko notice aayo. ",
        input: "shiksha m",
        expected: "शिक्षा मन्त्रालय",
        label: "shiksha mantralaya"
      },
      {
        leftTextWindow: "website ma PDF form submit garna khojda ",
        input: "file upload b",
        expected: "file upload भएन",
        label: "file upload bhayena"
      },
      {
        leftTextWindow: "namaste sathi, k gardai chau? ",
        input: "mero ke",
        expected: "मेरो के छ अवस्था",
        label: "mero ke cha awastha"
      }
    ] as const;

    for (const item of cases) {
      engine.setContext(sessionId, { leftTextWindow: item.leftTextWindow });
      const update = engine.updateComposition(sessionId, item.input, item.input.length);
      expect(update.candidates.map((candidate) => candidate.text), item.input).toContain(item.expected);
      expect(update.candidates.map((candidate) => candidate.label), item.input).toContain(item.label);
      expect(update.candidates.find((candidate) => candidate.text === item.expected)?.reason.join(" "), item.input).toMatch(/Context prediction/);
    }
  });

  it("uses compiled next-context corpus rows for broad casual continuation", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({
      ...defaultTypingContext("romanized"),
      showRomanizedLabels: true
    });

    engine.setContext(sessionId, { leftTextWindow: "khusi " });
    const update = engine.updateComposition(sessionId, "chh", 3);

    expect(update.candidates.map((candidate) => candidate.label)).toContain("chhu");
    expect(update.candidates.find((candidate) => candidate.label === "chhu")?.reason.join(" ")).toMatch(/trained prediction model|next-context pack/);
  });

  it("suppresses low-confidence proofread hints on active prefixes", () => {
    const engine = createKeyboardEngine();
    const activePrefix = engine.getProofHints("से");
    expect(activePrefix).toHaveLength(0);

    const fullTypo = engine.getProofHints("सवस्थ्य");
    expect(fullTypo.some((hint) => hint.suggestion === "स्वास्थ्य")).toBe(true);
  });

  it("surfaces grammar-aware proof hints as underline-style suggestions", () => {
    const engine = createKeyboardEngine();
    const hints = engine.getProofHints("हामी आयौ। उहाँ आयो।");

    expect(hints.find((hint) => hint.suggestion === "हामी आयौं")?.type).toBe("agreement");
    expect(hints.find((hint) => hint.suggestion === "उहाँ आउनुभयो")?.type).toBe("honorific");
    expect(hints.every((hint) => hint.action !== "auto-suggest")).toBe(true);
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
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), fieldType: "normal" });
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

  it("defers native selection learning until one exact host confirmation", () => {
    const engine = createKeyboardEngine();
    const committingSession = engine.beginSession({
      ...defaultTypingContext("romanized"),
      fieldType: "normal"
    });
    const beforeCommit = engine.updateComposition(committingSession, "prabin", 6);
    const alternate = beforeCommit.candidates.find((candidate) => candidate.text !== beforeCommit.primary?.text);
    expect(alternate).toBeTruthy();

    const commit = engine.commitCandidate(
      committingSession,
      alternate!.id,
      { learning: "deferred" }
    );
    expect(commit.memoryRecorded).toBe(false);

    const observingSession = engine.beginSession({
      ...defaultTypingContext("romanized"),
      fieldType: "normal"
    });
    const beforeConfirmation = engine.updateComposition(observingSession, "prabin", 6);
    expect(beforeConfirmation.candidates.some((candidate) => (
      candidate.type === "personal" && candidate.text === alternate!.text
    ))).toBe(false);

    expect(engine.learnCommittedCorrection(committingSession, commit.commitEpoch)).toBe(true);
    expect(engine.learnCommittedCorrection(committingSession, commit.commitEpoch)).toBe(false);
    const afterConfirmation = engine.updateComposition(observingSession, "prabin", 6);
    expect(afterConfirmation.candidates[0]).toEqual(expect.objectContaining({
      text: alternate!.text,
      type: "personal"
    }));
  });

  it("purges deferred learning on secure and stale session transitions", () => {
    const assertTransitionRejectsLearning = (
      transition: (engine: ReturnType<typeof createKeyboardEngine>, sessionId: string) => void
    ) => {
      const engine = createKeyboardEngine();
      const sessionId = engine.beginSession({
        ...defaultTypingContext("romanized"),
        fieldType: "normal"
      });
      const update = engine.updateComposition(sessionId, "prabin", 6);
      const alternate = update.candidates.find((candidate) => candidate.text !== update.primary?.text);
      expect(alternate).toBeTruthy();
      const commit = engine.commitCandidate(sessionId, alternate!.id, { learning: "deferred" });

      transition(engine, sessionId);
      expect(engine.learnCommittedCorrection(sessionId, commit.commitEpoch)).toBe(false);
      const fresh = engine.beginSession({ ...defaultTypingContext("romanized"), fieldType: "normal" });
      expect(engine.updateComposition(fresh, "prabin", 6).candidates.some((candidate) => (
        candidate.type === "personal" && candidate.text === alternate!.text
      ))).toBe(false);
    };

    assertTransitionRejectsLearning((engine, sessionId) => {
      engine.setContext(sessionId, { fieldType: "password", secureInput: true });
    });
    assertTransitionRejectsLearning((engine, sessionId) => {
      engine.updateComposition(sessionId, "next", 4);
    });
  });

  it("privacy-projects pending and imported memory before retention", () => {
    const manager = new KeyboardSessionManager();
    const sessionId = manager.beginSession({
      ...defaultTypingContext("romanized"),
      fieldType: "normal",
      leftTextWindow: "private sentence before",
      rightTextWindow: "private sentence after",
      activeDomains: ["health", "ignored"]
    });
    manager.updateComposition(sessionId, "prabin", 6);
    const candidate = {
      id: "candidate",
      text: "प्रवीण",
      type: "word" as const,
      confidence: 0.9,
      reason: ["test"]
    };
    manager.updateCandidates(sessionId, [candidate]);

    expect(buildKeyboardMemorySelection(manager.get(sessionId), candidate)?.context).toEqual({
      leftWindow: "",
      rightWindow: "",
      domain: "health"
    });
    const firstId = buildKeyboardMemorySelection(manager.get(sessionId), candidate)?.id;
    const concurrentSessionId = manager.beginSession({
      ...defaultTypingContext("romanized"),
      fieldType: "normal",
      activeDomains: ["health"]
    });
    manager.updateComposition(concurrentSessionId, "prabin", 6);
    const differentOutputId = buildKeyboardMemorySelection(manager.get(concurrentSessionId), {
      ...candidate,
      id: "different-candidate",
      text: "प्रबिन"
    })?.id;
    expect(firstId).toMatch(/^kbd-memory-[a-f0-9]{40}$/);
    expect(differentOutputId).not.toBe(firstId);
    const imported = importKeyboardMemoryEntry([], {
      id: "imported",
      inputRomanized: "prabin",
      chosenOutput: "प्रवीण",
      context: {
        leftWindow: "private imported left",
        rightWindow: "private imported right",
        domain: "health"
      },
      timestamps: {
        firstSeen: "2026-07-18T00:00:00.000Z",
        lastUsed: "2026-07-18T00:00:00.000Z"
      }
    });
    expect(imported[0]?.context).toEqual({ leftWindow: "", rightWindow: "", domain: "health" });
    expect(imported[0]?.id).toBe(firstId);

    const duplicate = importKeyboardMemoryEntry(imported, {
      id: "same-supplied-id-for-unrelated-data",
      inputRomanized: "ＰＲＡＢＩＮ",
      normalizedInput: "forged",
      chosenOutput: "प्रवीण",
      context: { domain: "HEALTH" },
      frequency: 7,
      timestamps: {
        firstSeen: "2026-07-18T05:45:00+05:45",
        lastUsed: "2026-07-18T06:45:00+05:45"
      }
    });
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toEqual(expect.objectContaining({
      id: firstId,
      frequency: 7,
      timestamps: {
        firstSeen: expect.any(String),
        lastUsed: "2026-07-18T01:00:00.000Z"
      }
    }));

    const malformed = importKeyboardMemoryEntry(duplicate, {
      inputRomanized: "prabin",
      chosenOutput: "broken-\ud800"
    });
    expect(malformed).toBe(duplicate);

    const collidingExisting = [{
      ...duplicate[0]!,
      normalizedInput: "unrelated",
      normalizedOutput: "असम्बन्धित",
      chosenOutput: "असम्बन्धित"
    }];
    expect(importKeyboardMemoryEntry(collidingExisting, {
      inputRomanized: "prabin",
      chosenOutput: "प्रवीण",
      context: { domain: "health" }
    })).toBe(collidingExisting);
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

  it("keeps deferred learning unchanged until an opaque prepared transaction is committed", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "prabin", 6);
    const alternate = update.candidates.find((candidate) => candidate.text !== update.primary?.text);
    expect(alternate).toBeTruthy();
    const committed = engine.commitCandidate(sessionId, alternate!.id, { learning: "deferred" });

    const beforeConfirmation = engine.updateComposition(
      engine.beginSession(defaultTypingContext("romanized")),
      "prabin",
      6
    );
    expect(beforeConfirmation.candidates.some((candidate) => (
      candidate.type === "personal" && candidate.text === alternate!.text
    ))).toBe(false);

    const prepared = engine.prepareCommittedCorrectionLearning(sessionId, committed.commitEpoch);
    expect(prepared).toBeTruthy();
    expect(engine.prepareCommittedCorrectionLearning(sessionId, committed.commitEpoch)).toBe(prepared);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared!.entry)).toBe(true);
    expect(engine.commitPreparedCorrectionLearning({ ...prepared! })).toBe(false);
    expect(engine.commitPreparedCorrectionLearning(prepared!)).toBe(true);
    expect(engine.commitPreparedCorrectionLearning(prepared!)).toBe(false);

    const afterConfirmation = engine.updateComposition(
      engine.beginSession(defaultTypingContext("romanized")),
      "prabin",
      6
    );
    expect(afterConfirmation.candidates.some((candidate) => (
      candidate.type === "personal" && candidate.text === alternate!.text
    ))).toBe(true);
  });

  it("preloads bounded privacy-projected correction memory only before sessions begin", () => {
    const oversized = createKeyboardEngine();
    expect(() => oversized.preloadCorrectionMemory(Array.from({ length: 501 }, () => null)))
      .toThrow(/cannot exceed 500 entries/);

    const engine = createKeyboardEngine();
    expect(engine.preloadCorrectionMemory([{
      id: "caller-id-is-not-trusted",
      inputRomanized: "prabin",
      chosenOutput: "प्रवीण",
      normalizedInput: "prabin",
      normalizedOutput: "प्रवीण",
      rejectedAlternatives: [],
      context: { leftWindow: "private before", rightWindow: "private after", domain: "HEALTH" },
      source: "user-accept",
      frequency: 2,
      confidenceAtSelection: 0.9,
      timestamps: {
        firstSeen: "2026-07-18T00:00:00.000Z",
        lastUsed: "2026-07-18T00:00:00.000Z"
      }
    }])).toBe(1);
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    expect(engine.updateComposition(sessionId, "prabin", 6).candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "personal", text: "प्रवीण" })])
    );
    expect(() => engine.preloadCorrectionMemory([])).toThrow(/before keyboard sessions begin/);
  });

  it("does not prepare an undurable correction when all 500 retained rows are pinned", () => {
    const engine = createKeyboardEngine();
    expect(engine.preloadCorrectionMemory(Array.from({ length: 500 }, (_, index) => ({
      id: `caller-id-${index}`,
      inputRomanized: `retained${index}`,
      chosenOutput: `स्थिर${index}`,
      normalizedInput: `retained${index}`,
      normalizedOutput: `स्थिर${index}`,
      rejectedAlternatives: [],
      context: { leftWindow: "", rightWindow: "" },
      source: "import",
      frequency: 1,
      confidenceAtSelection: 0.9,
      timestamps: {
        firstSeen: "2026-07-18T00:00:00.000Z",
        lastUsed: "2026-07-18T00:00:00.000Z"
      },
      pinned: true
    })))).toBe(500);

    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const update = engine.updateComposition(sessionId, "prabin", 6);
    const alternate = update.candidates.find((candidate) => candidate.text !== update.primary?.text);
    expect(alternate).toBeTruthy();
    const committed = engine.commitCandidate(sessionId, alternate!.id, { learning: "deferred" });
    expect(engine.prepareCommittedCorrectionLearning(sessionId, committed.commitEpoch)).toBeUndefined();
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

  it("passes secure input through without retaining or echoing it", () => {
    const engine = createKeyboardEngine();
    const context = {
      ...defaultTypingContext("romanized"),
      secureInput: true,
      fieldType: "password" as const
    };
    const sessionId = engine.beginSession(context);
    const update = engine.updateComposition(sessionId, "swasthya", 8);
    expect(update.action).toBe("passThrough");
    expect(update.compositionText).toBe("");
    expect(update.displayText).toBe("");
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
    const sessionId = engine.beginSession({ ...defaultTypingContext("romanized"), fieldType: "normal" });
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
    const sentence = engine.updateComposition(sessionId, "मेरो स्वा", 8);
    expect(sentence.candidates.some((candidate) => candidate.text === "मेरो स्वास्थ्य")).toBe(true);
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
    expect(warm.ready).toBe(true);
    expect(warm.loadedModules).toEqual(expect.arrayContaining([
      "candidate-pipeline",
      "proofread-index",
      "dictionary-index"
    ]));
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

  it("never stores a composition caret inside an extended grapheme", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("traditional"));

    const update = engine.updateComposition(sessionId, "कि", 1);

    expect(update.compositionText).toBe("कि");
    expect(update.caret).toBe(0);
  });

  it("evicts idle sessions with TTL cleanup for daemon lifecycle safety", () => {
    const removed: string[] = [];
    const manager = new KeyboardSessionManager(1, 2, (sessionIds) => removed.push(...sessionIds));
    const first = manager.beginSession(defaultTypingContext("romanized"));
    const second = manager.beginSession(defaultTypingContext("romanized"));
    manager.updateComposition(second, "swas", 4);
    expect(manager.has(first)).toBe(true);
    expect(manager.cleanupExpired(Date.now() + 10)).toBeGreaterThan(0);
    expect(manager.has(first)).toBe(false);
    expect(manager.has(second)).toBe(false);
    expect(new Set(removed)).toEqual(new Set([first, second]));
  });

  it("rejects session overflow instead of silently evicting live state", () => {
    const removed: string[] = [];
    const manager = new KeyboardSessionManager(60_000, 2, (sessionIds) => removed.push(...sessionIds));
    const first = manager.beginSession(defaultTypingContext("romanized"));
    const second = manager.beginSession(defaultTypingContext("romanized"));

    expect(() => manager.beginSession(defaultTypingContext("romanized"))).toThrow(/capacity/);
    expect(manager.has(first)).toBe(true);
    expect(manager.has(second)).toBe(true);
    expect(removed).toEqual([]);
  });

  it("rejects invalid custom session TTL and capacity limits", () => {
    const invalidLimits = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const invalid of invalidLimits) {
      expect(() => new KeyboardSessionManager(invalid, 1)).toThrow(/TTL.*positive safe integer/);
      expect(() => new KeyboardSessionManager(1, invalid)).toThrow(/capacity.*positive safe integer/);
    }
    expect(() => new KeyboardSessionManager(1, 1)).not.toThrow();
    expect(() => new KeyboardSessionManager(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it("atomically purges retained text and assistance when a session becomes secure", () => {
    const manager = new KeyboardSessionManager();
    const sessionId = manager.beginSession({
      ...defaultTypingContext("romanized"),
      leftTextWindow: "prior context ",
      rightTextWindow: "after"
    });
    manager.recordCommit(sessionId, "निजी");
    manager.updateComposition(sessionId, "secret", 6);
    manager.updateCandidates(sessionId, [{
      id: "private-candidate",
      text: "गोप्य",
      type: "word",
      confidence: 0.9,
      reason: ["test"]
    }]);
    manager.updateProofHints(sessionId, [{
      range: [0, 6],
      original: "secret",
      suggestion: "गोप्य",
      type: "spelling",
      confidence: 0.9,
      action: "hint-only",
      explanation: "test"
    }]);

    const secured = manager.updateContext(sessionId, {
      fieldType: "password",
      secureInput: true,
      leftTextWindow: "new password",
      rightTextWindow: "sensitive suffix"
    });

    expect(secured.context.leftTextWindow).toBe("");
    expect(secured.context.rightTextWindow).toBe("");
    expect(secured.compositionText).toBe("");
    expect(secured.caret).toBe(0);
    expect(secured.candidates).toEqual([]);
    expect(secured.proofHints).toEqual([]);
    expect(secured.lastCommittedText).toBe("");
    expect(secured.committedHistory).toEqual([]);
  });

  it("never retains host text when a session starts secure or uncertain", () => {
    for (const fieldType of ["password", "code", "unknown"] as const) {
      const manager = new KeyboardSessionManager();
      const sessionId = manager.beginSession({
        ...defaultTypingContext("romanized"),
        fieldType,
        leftTextWindow: "sensitive left context",
        rightTextWindow: "sensitive right context"
      });
      const session = manager.get(sessionId);
      expect(session.context.secureInput, fieldType).toBe(true);
      expect(session.context.leftTextWindow, fieldType).toBe("");
      expect(session.context.rightTextWindow, fieldType).toBe("");
      expect(session.warnings.join(" "), fieldType).toMatch(/Secure\/uncertain/);
    }
  });

  it("rejects every later text-bearing mutation while a session remains secure", () => {
    const manager = new KeyboardSessionManager();
    const sessionId = manager.beginSession({
      ...defaultTypingContext("romanized"),
      fieldType: "unknown"
    });

    manager.updateComposition(sessionId, "secret composition", 6);
    manager.updateCandidates(sessionId, [{
      id: "secret-candidate",
      text: "secret candidate",
      type: "word",
      confidence: 0.9,
      reason: ["secret reason"]
    }], ["secret warning"]);
    manager.updateProofHints(sessionId, [{
      range: [0, 6],
      original: "secret",
      suggestion: "private",
      type: "spelling",
      confidence: 0.9,
      action: "hint-only",
      explanation: "secret explanation"
    }]);
    manager.recordCommit(sessionId, "secret commit");

    const session = manager.get(sessionId);
    expect(session.compositionText).toBe("");
    expect(session.candidates).toEqual([]);
    expect(session.proofHints).toEqual([]);
    expect(session.lastCommittedText).toBe("");
    expect(session.committedHistory).toEqual([]);
    expect(JSON.stringify(session)).not.toContain("secret");
  });
});
