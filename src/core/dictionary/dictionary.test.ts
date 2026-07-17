import hunspellFixtures from "../../data/fixtures/hunspell-fixtures.json";
import suggestionFixtures from "../../data/fixtures/suggestion-fixtures.json";
import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import { getSpellHints, getSpellHintsWithHunspell, levenshtein } from "./spellHints";
import { parseRomanizedAliases, parseSeedWords, validateWordlist, wordEntries } from "./loadSeedWords";
import { isKnownNepaliHunspellWord, suggestNepaliHunspellWords } from "./nepaliHunspell";
import { replaceCurrentRomanizedToken, suggestWords } from "./suggestWords";

describe("seed dictionary", () => {
  it("validates the bundled wordlist", () => {
    expect(validateWordlist()).toEqual([]);
  });

  it("normalizes every seed word", () => {
    for (const entry of parseSeedWords()) {
      expect(entry.normalizedWord).toBe(normalizeNepaliText(entry.word));
    }
  });

  it("parses BOM-prefixed CRLF wordlist and alias input", () => {
    expect(parseSeedWords(
      "\uFEFFword\tromanized\tfrequency\tdomain\tsource\r\nनेपाल\tnepal\t10\tcommon\ttest\r\n"
    )).toEqual([
      expect.objectContaining({ word: "नेपाल", romanized: "nepal", frequency: 10, source: "test" })
    ]);
    expect(parseRomanizedAliases(
      "\uFEFFword\tromanized\tfrequencyBoost\tdomain\tsource\r\nनेपाल\tnepaal\t2\tcommon\ttest\r\n"
    )).toEqual([
      expect.objectContaining({ word: "नेपाल", romanized: "nepaal", frequencyBoost: 2, source: "test" })
    ]);
  });

  it("contains practical seed coverage", () => {
    expect(wordEntries.length).toBeGreaterThan(2000);
    expect(wordEntries.some((entry) => entry.domain === "names")).toBe(true);
    expect(wordEntries.some((entry) => entry.domain === "places")).toBe(true);
  });
});

describe("suggestWords", () => {
  it("returns prefix fixtures", () => {
    expect(suggestionFixtures).toHaveLength(50);
    expect(new Set(suggestionFixtures.map((fixture) => fixture.expectedDomain))).toEqual(
      new Set(["common", "government", "education", "legal", "office", "names", "places"])
    );
    for (const fixture of suggestionFixtures) {
      const first = suggestWords(fixture.prefix)[0];
      expect(first?.word).toBe(fixture.expectedFirst);
      expect(first?.domain).toBe(fixture.expectedDomain);
    }
  });

  it("feels populated across government, school, legal, office, names, and places", () => {
    expect(suggestWords("nagarik").length).toBeGreaterThan(2);
    expect(suggestWords("vidya").length).toBeGreaterThan(2);
    expect(suggestWords("kanun").length).toBeGreaterThan(2);
    expect(suggestWords("file").length).toBeGreaterThan(0);
    expect(suggestWords("shrestha").length).toBeGreaterThan(0);
    expect(suggestWords("kathmandu").length).toBeGreaterThan(0);
  });

  it("supports devanagari prefix lookup", () => {
    expect(suggestWords("विद्या").some((suggestion) => suggestion.word === "विद्यार्थी")).toBe(true);
  });

  it("replaces only the trailing romanized token when applying a suggestion", () => {
    expect(replaceCurrentRomanizedToken("mero pra", "prashasan")).toBe("mero prashasan");
    expect(replaceCurrentRomanizedToken("janma miti ", "pramanpatra")).toBe("janma miti pramanpatra");
  });
});

describe("spell hints", () => {
  it("flags unknown words gently", () => {
    const hints = getSpellHints("नेपाल सरकार झझझझ");
    expect(hints.some((hint) => hint.label === "Possible typo")).toBe(true);
  });

  it("does not flag known seed words", () => {
    expect(getSpellHints("नेपाल सरकार सेवा")).toEqual([]);
  });

  it("calculates edit distance", () => {
    expect(levenshtein("सरकर", "सरकार")).toBe(1);
  });

  it("uses dictionary-ne through nspell for local validation", () => {
    for (const fixture of hunspellFixtures) {
      expect(isKnownNepaliHunspellWord(fixture.word)).toBe(fixture.known);
      if ("expectedSuggestion" in fixture) {
        expect(suggestNepaliHunspellWords(fixture.word, 8).some((suggestion) => suggestion.word === fixture.expectedSuggestion)).toBe(true);
      }
    }
  }, 15_000);

  it("lazy-loads Hunspell for enhanced spell hints", async () => {
    expect(getSpellHints("नेपाल सरकार")).toEqual([]);
    await expect(getSpellHintsWithHunspell("नेपाल सरकार")).resolves.toEqual([]);
  });
});
