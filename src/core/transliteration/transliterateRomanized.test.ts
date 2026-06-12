import adminLegalFixtures from "../../data/fixtures/romanized-admin-legal-fixtures.json";
import fixtures from "../../data/fixtures/romanized-fixtures.json";
import generatedPhraseFixtures from "../../data/fixtures/romanized-generated-phrase-fixtures.json";
import lexicalFixtures from "../../data/fixtures/romanized-lexical-fixtures.json";
import malformedSpacingFixtures from "../../data/fixtures/romanized-malformed-spacing-fixtures.json";
import mixedEnglishFixtures from "../../data/fixtures/romanized-mixed-english-fixtures.json";
import namesPlacesFixtures from "../../data/fixtures/romanized-names-places-fixtures.json";
import regressionFixtures from "../../data/fixtures/romanized-regression-fixtures.json";
import ruleOnlyFixtures from "../../data/fixtures/romanized-rule-fixtures.json";
import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import { transliterateRomanized } from "./transliterateRomanized";

interface RomanizedFixture {
  category: string;
  input: string;
  expected: string;
}

describe("transliterateRomanized", () => {
  it("ships with at least 5,000 romanized gold fixtures split by category", () => {
    expect((fixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(5000);
    expect((lexicalFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(300);
    expect((generatedPhraseFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(1000);
    expect((namesPlacesFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(800);
    expect((adminLegalFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(800);
    expect((mixedEnglishFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(700);
    expect((malformedSpacingFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(600);
    expect((regressionFixtures as RomanizedFixture[]).length).toBeGreaterThanOrEqual(150);
  });

  it("matches the romanized fixture suite", () => {
    for (const fixture of fixtures as RomanizedFixture[]) {
      const result = transliterateRomanized(fixture.input);
      expect(result.normalizedOutput, fixture.input).toBe(fixture.expected);
      expect(result.normalizedOutput).toBe(normalizeNepaliText(result.output));
    }
  }, 15_000);

  it("keeps rule-only parser fixtures separate from dictionary rescue", () => {
    for (const fixture of ruleOnlyFixtures as RomanizedFixture[]) {
      const result = transliterateRomanized(fixture.input, "common-nepali", { useDictionary: false });
      expect(result.normalizedOutput, fixture.input).toBe(fixture.expected);
    }
  });

  it("exposes ambiguity candidates for sh/s/Sh, ch/chh/c, x/ksh, ri, gya, tra, and shra", () => {
    const sh = transliterateRomanized("shakti");
    expect(sh.normalizedOutput).toBe("शक्ति");
    expect(sh.candidates.some((candidate) => candidate.normalizedText.includes("ष"))).toBe(true);

    const ch = transliterateRomanized("chala");
    expect(ch.candidates.some((candidate) => candidate.normalizedText.includes("छ"))).toBe(true);

    const x = transliterateRomanized("xetra");
    expect(x.normalizedOutput).toBe("क्षेत्र");
    expect(transliterateRomanized("x").normalizedOutput).toBe("x");
    expect(transliterateRomanized("xalo").candidates.some((candidate) => candidate.normalizedText.includes("क्ष"))).toBe(true);

    const ri = transliterateRomanized("rishi");
    expect(ri.normalizedOutput).toBe("ऋषि");
    expect(ri.trace.some((trace) => trace.rule === "dictionary-rank")).toBe(true);

    expect(transliterateRomanized("gyan").normalizedOutput).toBe("ज्ञान");
    expect(transliterateRomanized("patra").normalizedOutput).toBe("पत्र");
    expect(transliterateRomanized("shram").normalizedOutput).toBe("श्रम");
  });

  it("handles common chat-style tail spellings without requiring a server model", () => {
    expect(transliterateRomanized("vato").normalizedOutput).toBe("बाटो");
    expect(transliterateRomanized("bato").normalizedOutput).toBe("बाटो");
    expect(transliterateRomanized("baato").normalizedOutput).toBe("बाटो");
    expect(transliterateRomanized("chha").normalizedOutput).toBe("छ");
    expect(transliterateRomanized("cha").normalizedOutput).toBe("छ");
    expect(transliterateRomanized("xa").normalizedOutput).toBe("छ");
    expect(transliterateRomanized("xaina").normalizedOutput).toBe("छैन");
    expect(transliterateRomanized("x").normalizedOutput).toBe("x");
    expect(transliterateRomanized("xetra").candidates.some((candidate) => candidate.normalizedText === "क्षेत्र")).toBe(true);
  });

  it("preserves mixed English/Nepali desktop text", () => {
    expect(transliterateRomanized("NID form ko naam field").normalizedOutput).toBe("NID form को नाम field");
    expect(transliterateRomanized("PDF ma naam").normalizedOutput).toBe("PDF मा नाम");
  });

  it("preserves Arabic numerals by default", () => {
    expect(transliterateRomanized("nagarikta 123").normalizedOutput).toBe("नागरिकता 123");
  });

  it("ranks phrase-level lattice overrides above token-only paths", () => {
    for (const [input, expected] of [
      ["janma miti", "जन्म मिति"],
      ["nagarikta pramanpatra", "नागरिकता प्रमाणपत्र"],
      ["jilla prashasan karyalaya", "जिल्ला प्रशासन कार्यालय"],
      ["rastriya parichayapatra", "राष्ट्रिय परिचयपत्र"],
      ["rastriya parichaypatra", "राष्ट्रिय परिचयपत्र"],
      ["shiksha mantralaya", "शिक्षा मन्त्रालय"]
    ] as const) {
      const result = transliterateRomanized(input);
      expect(result.normalizedOutput, input).toBe(expected);
      expect(result.trace[0].rule).toBe("candidate-lattice");
    }
  });

  it("matches reviewed phrases in the middle of long mixed sentences", () => {
    const cases = [
      ["mero form ma jilla prashasan karyalaya ko naam wrong cha", "मेरो form मा जिल्ला प्रशासन कार्यालय को नाम wrong छ"],
      ["PDF ma rastriya parichaya patra ko date milena", "PDF मा राष्ट्रिय परिचय पत्र को date मिलेन"],
      ["ward-05 ko online form ma janma darta ra mrityu darta milena", "ward-05 को online form मा जन्म दर्ता र मृत्यु दर्ता मिलेन"],
      ["yo kagaj jagga dhani pramanpurja ko lagi ho", "यो कागज जग्गा धनी प्रमाणपुर्जा को लागि हो"]
    ] as const;

    for (const [input, expected] of cases) {
      const result = transliterateRomanized(input);
      expect(result.normalizedOutput, input).toBe(expected);
      expect(result.trace.some((trace) => trace.rule === "sliding-phrase-rank")).toBe(true);
    }
  });

  it("handles common name variants as reviewed candidates", () => {
    expect(transliterateRomanized("laxmi").normalizedOutput).toBe("लक्ष्मी");
    expect(transliterateRomanized("laxmee").normalizedOutput).toBe("लक्ष्मी");
    expect(transliterateRomanized("shreshtha").normalizedOutput).toBe("श्रेष्ठ");
    expect(transliterateRomanized("bhattary").candidates.some((candidate) => candidate.normalizedText === "भट्टराई")).toBe(true);
    expect(transliterateRomanized("chaudhry").normalizedOutput).toBe("चौधरी");
    expect(transliterateRomanized("pokhrel").normalizedOutput).toBe("पोखरेल");
    expect(transliterateRomanized("neeraj bhushal").normalizedOutput).toBe("नीरज भुसाल");
    expect(transliterateRomanized("ashim shrestha").normalizedOutput).toBe("आशिम श्रेष्ठ");
  });

  it("keeps loanwords as candidates without corrupting protected English defaults", () => {
    expect(transliterateRomanized("digital").normalizedOutput).toBe("डिजिटल");
    expect(transliterateRomanized("unicode").normalizedOutput).toBe("युनिकोड");
    expect(transliterateRomanized("convert").normalizedOutput).toBe("कन्भर्ट");
    expect(transliterateRomanized("PDF").normalizedOutput).toBe("PDF");
    expect(transliterateRomanized("form").normalizedOutput).toBe("फारम");
    expect(transliterateRomanized("NID form").normalizedOutput).toBe("NID form");
  });

  it("returns full-output alternatives instead of replacing the sentence with one word", () => {
    const result = transliterateRomanized("niraj bhusal");
    expect(result.normalizedOutput).toBe("निरज भुसाल");
    expect(result.candidates.some((candidate) => candidate.normalizedText === "नीरज भुसाल")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.normalizedText !== "नीरज")).toBe(true);
  });

  it("can rank explicit local correction memory above the default candidate", () => {
    const result = transliterateRomanized("niraj bhusal", "common-nepali", {
      localCorrections: [
        {
          input: "niraj bhusal",
          normalizedInput: "niraj bhusal",
          output: "नीरज भुसाल",
          normalizedOutput: "नीरज भुसाल",
          count: 3,
          updatedAt: "2026-05-25T00:00:00.000Z"
        }
      ]
    });

    expect(result.normalizedOutput).toBe("नीरज भुसाल");
    expect(result.candidates[0].source).toBe("user-feedback");
  });

  it("keeps weighted repair candidates visible without hiding dictionary-vs-rule behavior", () => {
    const result = transliterateRomanized("karmachari", "common-nepali", { useDictionary: false });
    expect(result.normalizedOutput).toBe("कर्मचरि");
    expect(result.candidates.some((candidate) => candidate.normalizedText === "कर्मचारी")).toBe(true);

    const prashasan = transliterateRomanized("prashasan", "common-nepali", { useDictionary: false });
    expect(prashasan.normalizedOutput).toBe("प्रशसन");
    expect(prashasan.candidates.some((candidate) => candidate.normalizedText === "प्रशासन")).toBe(true);
  });
});
