import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID,
  analyzeDevanagariOutputSequence,
  isValidDevanagariWordSequence,
  partitionDevanagariWordTargets,
  validateDevanagariWordSequence
} from "./devanagari-word-sequence.mjs";

const sharedDecoderContract = JSON.parse(readFileSync(
  new URL("../../contracts/neural-decoder/v2/lekh-neural-decoder.v2.json", import.meta.url),
  "utf8"
));
const ctcAlignmentAudit = JSON.parse(readFileSync(
  new URL("../../data/neural/audits/ctc-transformer-v2-alignment-v1.json", import.meta.url),
  "utf8"
));

describe("Devanagari scalar word-sequence validator", () => {
  it("matches every shared Python/Swift sequence-contract case exactly", () => {
    expect(sharedDecoderContract.outputSequenceValidation)
      .toBe(DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID);
    for (const item of sharedDecoderContract.sequenceCases) {
      expect(analyzeDevanagariOutputSequence(item.value), item.value).toEqual({
        validPrefix: item.validPrefix,
        terminable: item.terminable,
        issueCodes: item.issueCodes
      });
    }
  });

  it("matches the exhaustive production-vocabulary grammar oracle", () => {
    const oracle = sharedDecoderContract.productionGrammarOracle;
    const auditedTokens = ctcAlignmentAudit.trainingVocabulary.output.tokens
      .map(({ token }) => token)
      .sort((left, right) => left.codePointAt(0) - right.codePointAt(0));
    expect(oracle).toMatchObject({
      id: "ctc-output-vocabulary-cartesian-prefixes-v1",
      enumeration: "ordered-cartesian-product-depth-1-through-3",
      serialization: "utf8-value-tab-validPrefix-bit-tab-terminable-bit-tab-comma-joined-issueCodes-lf",
      maxDepth: 3
    });
    expect(oracle.tokens).toEqual(auditedTokens);

    const digest = createHash("sha256");
    let sequenceCount = 0;
    let validPrefixCount = 0;
    let terminableCount = 0;
    const visit = (prefix, depth) => {
      if (depth > 0) {
        const analysis = analyzeDevanagariOutputSequence(prefix);
        digest.update(
          `${prefix}\t${analysis.validPrefix ? 1 : 0}\t` +
          `${analysis.terminable ? 1 : 0}\t${analysis.issueCodes.join(",")}\n`
        );
        sequenceCount += 1;
        if (analysis.validPrefix) validPrefixCount += 1;
        if (analysis.terminable) terminableCount += 1;
      }
      if (depth === oracle.maxDepth) return;
      for (const token of oracle.tokens) visit(prefix + token, depth + 1);
    };
    visit("", 0);

    expect({
      sequenceCount,
      validPrefixCount,
      terminableCount,
      sha256: digest.digest("hex")
    }).toEqual({
      sequenceCount: oracle.sequenceCount,
      validPrefixCount: oracle.validPrefixCount,
      terminableCount: oracle.terminableCount,
      sha256: oracle.sha256
    });
  });

  it("accepts normal syllables, conjuncts, modifiers, nukta, and adjacent units", () => {
    expect(DEVANAGARI_WORD_SEQUENCE_VALIDATOR_ID).toBe("devanagari-word-sequence-v1");
    for (const value of [
      "नेपाल",
      "कका",
      "क्षेत्र",
      "क़लम",
      "किं",
      "गाउँ",
      "हाँस्यौं",
      "संघसंस्थाहरूद्वारा",
      "दुःख",
      "पुनर्अभिमुखीकरण"
    ]) {
      expect(validateDevanagariWordSequence(value), value).toEqual({
        valid: true,
        issueCodes: [],
        primaryIssueCode: null
      });
    }
  });

  it("accepts terminal virama and well-formed joiner conjuncts", () => {
    for (const value of ["पश्चात्", "छन्", "क्‍ष", "क्‌ष"]) {
      expect(isValidDevanagariWordSequence(value), value).toBe(true);
    }
  });

  it.each([
    ["ेनेपाल", "dependent-vowel-sign-without-consonant"],
    ["ंचुनाव", "mark-without-base"],
    ["अाफ्नै", "dependent-vowel-sign-without-consonant"],
    ["किी", "multiple-dependent-vowel-signs"],
    ["केै", "multiple-dependent-vowel-signs"],
    ["कुँँ", "duplicate-mark"],
    ["छन्ः", "mark-after-virama"],
    ["कि्", "virama-after-dependent-vowel-sign"],
    ["़कलम", "orphan-or-misordered-nukta"],
    ["का़", "orphan-or-misordered-nukta"],
    ["क़़", "duplicate-nukta"]
  ])("rejects malformed mark order in %s", (value, issueCode) => {
    const result = validateDevanagariWordSequence(value);
    expect(result.valid).toBe(false);
    expect(result.issueCodes).toContain(issueCode);
  });

  it.each([
    ["‍क", "joiner-not-after-virama"],
    ["क‍ष", "joiner-not-after-virama"],
    ["क्‍", "joiner-not-before-consonant"],
    ["क्‍ा", "joiner-not-before-consonant"],
    ["क‌ष", "joiner-not-after-virama"]
  ])("rejects malformed joiner order in %s", (value, issueCode) => {
    const result = validateDevanagariWordSequence(value);
    expect(result.valid).toBe(false);
    expect(result.issueCodes).toContain(issueCode);
  });

  it.each([
    ["दामल१", "digit"],
    ["सी॰", "punctuation"],
    ["राम।", "punctuation"],
    ["राम-नाम", "punctuation"],
    ["नेpal", "unsupported-scalar"],
    ["राम नाम", "whitespace"],
    ["", "empty"]
  ])("rejects non-word target %s", (value, issueCode) => {
    const result = validateDevanagariWordSequence(value);
    expect(result.valid).toBe(false);
    expect(result.issueCodes).toContain(issueCode);
  });

  it("reports deterministic unique reasons without throwing on hostile input", () => {
    const first = validateDevanagariWordSequence("१‍ेे");
    const second = validateDevanagariWordSequence("१‍ेे");
    expect(first).toEqual(second);
    expect(first.issueCodes).toEqual([
      "digit",
      "joiner-not-after-virama",
      "joiner-not-before-consonant",
      "dependent-vowel-sign-without-consonant",
      "multiple-dependent-vowel-signs"
    ]);
    expect(() => validateDevanagariWordSequence(null)).not.toThrow();
  });

  it("always retains a valid primary target when aliases omit it or are filtered", () => {
    expect(partitionDevanagariWordTargets("नेपाल", [])).toEqual({
      accepted: ["नेपाल"],
      rejected: []
    });
    expect(partitionDevanagariWordTargets("नेपाल", ["राम।", "नेपाल", "दामल१"])).toEqual({
      accepted: ["नेपाल"],
      rejected: [
        { value: "राम।", issueCodes: ["punctuation"], primaryIssueCode: "punctuation" },
        { value: "दामल१", issueCodes: ["digit"], primaryIssueCode: "digit" }
      ]
    });
  });
});
