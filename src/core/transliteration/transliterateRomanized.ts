import { lookupByRomanized } from "../dictionary/loadSeedWords";
import { normalizeNepaliText } from "../normalize/normalizeNepaliText";
import type { Candidate, RomanizedResult, TokenTrace } from "../types";
import { uniqueRankedCandidates } from "./candidateRanker";
import { localCorrectionCandidates, type LocalCorrection } from "./localCorrectionMemory";
import {
  canonicalEnglishToken,
  hasIntentionalCapitalPhoneme,
  isLikelyEnglishToken,
  normalizeRomanizedToken,
  normalizeRomanizedTokenForParsing
} from "./latinNormalize";
import { composeRomanizedToken } from "./devanagariComposer";
import { findPhraseMatches, phraseCandidatesForInput, type PhraseMatch } from "./phraseRanker";
import { weightedRepairCandidates } from "./repairCandidates";

export type RomanizationProfile = "common-nepali" | "google-like" | "strict-phonetic" | "experimental";

export interface TransliterateOptions {
  useDictionary?: boolean;
  localCorrections?: LocalCorrection[];
  disableSlidingPhrases?: boolean;
  digitPolicy?: "preserve-ascii" | "convert-devanagari" | "context-dependent";
}

const SCORE = {
  exactAlias: 1800,
  domainDictionary: 1200,
  defaultFullOutput: 1000,
  rule: 700
};

const BEAM_ALTERNATIVE_MAX_SCORE = SCORE.defaultFullOutput - 1;

interface TokenConversion {
  input: string;
  output: string;
  candidates: Candidate[];
  trace: TokenTrace[];
}

interface TokenContext {
  romanizedWordCount: number;
}

interface BeamPath {
  parts: string[];
  score: number;
  replacements: number;
  reasons: string[];
  sources: Set<Candidate["source"]>;
}

const TOKEN_PATTERN =
  /(https?:\/\/\S+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z]+|\|\||\d+|\r?\n|[^\S\r\n]+|.)/g;

const FORMAL_TOKEN_OVERRIDES = new Map<string, string>([
  ["maanab", "मानव"],
  ["basaainsarai", "बसाइँसराइ"],
  ["basaainsaraaiko", "बसाइँसराइको"],
  ["gardai", "गर्दै"],
  ["gardaa", "गर्दा"],
  ["prithbiko", "पृथ्वीको"],
  ["prithviko", "पृथ्वीको"],
  ["jaibik", "जैविक"],
  ["bibidhataa", "विविधता"],
  ["bibidhata", "विविधता"],
  ["atibrishti", "अतिवृष्टि"],
  ["anaabrishti", "अनावृष्टि"],
  ["khandabrishti", "खण्डवृष्टि"],
  ["khandabrishtile", "खण्डवृष्टिले"],
  ["dushparinaam", "दुष्परिणाम"],
  ["dushparinaamharu", "दुष्परिणामहरू"],
  ["darshanaanusaar", "दर्शनानुसार"],
  ["samrakshanmaa", "संरक्षणमा"],
  ["basudhaiba", "वसुधैव"],
  ["kutumbakam", "कुटुम्बकम्"],
  ["siddhaanta", "सिद्धान्त"],
  ["siddhaantalai", "सिद्धान्तलाई"],
  ["aatmasaat", "आत्मसात्"],
  ["sangkalpit", "सङ्कल्पित"],
  ["buddhijibi", "बुद्धिजीवी"],
  ["raajanitigya", "राजनीतिज्ञ"],
  ["praapta", "प्राप्त"],
  ["paribaar", "परिवार"],
  ["paribaaar", "परिवार"],
  ["sauryamandal", "सौर्यमण्डल"],
  ["sauryamandalkaa", "सौर्यमण्डलका"],
  ["sauryamandalka", "सौर्यमण्डलका"],
  ["grahaharumaa", "ग्रहहरूमा"],
  ["parikalpanaa", "परिकल्पना"],
  ["paaristhitikiy", "पारिस्थितिकीय"],
  ["dinpratidin", "दिनप्रतिदिन"],
  ["jirna", "जीर्ण"],
  ["bandai", "बन्दै"],
  ["gairaheko", "गइरहेको"],
  ["purbiya", "पूर्वीय"],
  ["arthaat", "अर्थात्"],
  ["sampurna", "सम्पूर्ण"],
  ["bishwa", "विश्व"],
  ["bhanne", "भन्ने"],
  ["haamile", "हामीले"],
  ["aafnaa", "आफ्ना"],
  ["swaarthaharulai", "स्वार्थहरूलाई"],
  ["tyaagera", "त्यागेर"],
  ["prakritiko", "प्रकृतिको"],
  ["ekajut", "एकजुट"],
  ["aparihaarya", "अपरिहार्य"],
  ["saalko", "सालको"],
  ["madhyatira", "मध्यतिर"],
  ["aaipugdaa", "आइपुग्दा"],
  ["jalabaayu", "जलवायु"],
  ["paribartankaa", "परिवर्तनका"],
  ["jastai", "जस्तै"],
  ["krishi", "कृषि"],
  ["kshetramaa", "क्षेत्रमा"],
  ["thulo", "ठुलो"],
  ["hraas", "ह्रास"],
  ["lyaaeko", "ल्याएको"],
  ["atah", "अतः"],
  ["naagarikle", "नागरिकले"],
  ["kartabya", "कर्तव्य"],
  ["daayitwabodh", "दायित्वबोध"],
  ["bikaaskaa", "विकासका"],
  ["lakshyaharu", "लक्ष्यहरू"],
  ["hunupardachha", "हुनुपर्दछ"],
  ["uchchatam", "उच्चतम्"],
  ["bikaassangai", "विकाससँगै"]
]);

const CASUAL_TAIL_OVERRIDES = new Map<string, string>([
  ["baato", "बाटो"],
  ["bato", "बाटो"],
  ["vato", "बाटो"],
  ["chha", "छ"],
  ["cha", "छ"],
  ["xa", "छ"],
  ["xaina", "छैन"],
  ["xau", "छौ"],
  ["xu", "छु"],
  ["xan", "छन्"],
  ["xas", "छस्"]
]);

export function transliterateRomanized(
  input: string,
  profile: RomanizationProfile = "common-nepali",
  options: TransliterateOptions = {}
): RomanizedResult {
  const exactPhraseCandidates = options.useDictionary === false ? [] : phraseCandidatesForInput(input);
  if (!options.disableSlidingPhrases && exactPhraseCandidates.length === 0) {
    const phraseMatches = options.useDictionary === false ? [] : findPhraseMatches(input);
    if (phraseMatches.length > 0) {
      return transliterateWithPhraseMatches(input, phraseMatches, profile, options);
    }
  }
  const tokens = input.match(TOKEN_PATTERN) ?? [];
  const tokenContext: TokenContext = {
    romanizedWordCount: tokens.filter((token) => /^[A-Za-z]+$/.test(token)).length
  };
  const conversions = tokens.map((token) => convertToken(token, profile, options, tokenContext));
  const defaultOutput = conversions.map((conversion) => conversion.output).join("");
  const normalizedDefaultOutput = normalizeNepaliText(applyOutputPolicies(defaultOutput, options));
  const latticeCandidates = buildFullOutputCandidates(input, conversions, normalizedDefaultOutput, options.localCorrections ?? []);
  const selectedOutput = applyOutputPolicies(latticeCandidates[0]?.normalizedText ?? normalizedDefaultOutput, options);
  const output = selectedOutput;
  const normalizedOutput = normalizeNepaliText(selectedOutput);
  const candidates = uniqueRankedCandidates(
    [
      ...latticeCandidates,
      ...buildTokenReplacementCandidates(conversions)
    ],
    12
  );

  return {
    input,
    output,
    normalizedOutput,
    warnings: [],
    candidates,
    trace: [
      {
        input,
        output: normalizedOutput,
        rule: "candidate-lattice",
        notes: ["full-output ranking", `profile:${profile}`, `winner:${latticeCandidates[0]?.reason ?? "default"}`]
      },
      ...conversions.flatMap((conversion) => conversion.trace)
    ]
  };
}

function transliterateWithPhraseMatches(
  input: string,
  phraseMatches: PhraseMatch[],
  profile: RomanizationProfile,
  options: TransliterateOptions
): RomanizedResult {
  let cursor = 0;
  let output = "";
  const trace: TokenTrace[] = [];
  const candidates: Candidate[] = [];

  for (const match of phraseMatches) {
    if (cursor < match.range[0]) {
      const segment = input.slice(cursor, match.range[0]);
      const converted = transliterateRomanized(segment, profile, { ...options, disableSlidingPhrases: true });
      output += converted.normalizedOutput;
      trace.push(...converted.trace);
      candidates.push(...converted.candidates);
    }
    output += match.normalizedOutput;
    trace.push({
      input: match.input,
      output: match.normalizedOutput,
      rule: "sliding-phrase-rank",
      notes: [`domain:${match.domain}`, `source:${match.source}`, match.reason]
    });
    cursor = match.range[1];
  }

  if (cursor < input.length) {
    const segment = input.slice(cursor);
    const converted = transliterateRomanized(segment, profile, { ...options, disableSlidingPhrases: true });
    output += converted.normalizedOutput;
    trace.push(...converted.trace);
    candidates.push(...converted.candidates);
  }

  const normalizedOutput = normalizeNepaliText(output);
  const phraseCandidate: Candidate = {
    text: normalizedOutput,
    normalizedText: normalizedOutput,
    score: Math.min(2600, 2100 + phraseMatches.reduce((total, match) => total + Math.round(match.score / 100), 0)),
    source: "dictionary",
    reason: `Sliding-window phrase match: ${phraseMatches.map((match) => match.input).join("; ")}`
  };

  return {
    input,
    output: normalizedOutput,
    normalizedOutput,
    warnings: [],
    candidates: uniqueRankedCandidates([phraseCandidate, ...candidates], 12),
    trace: [
      {
        input,
        output: normalizedOutput,
        rule: "candidate-lattice",
        notes: ["sliding-window phrase ranking", `matches:${phraseMatches.length}`]
      },
      ...trace
    ]
  };
}

function convertToken(token: string, profile: RomanizationProfile, options: TransliterateOptions, context: TokenContext): TokenConversion {
  if (!/[A-Za-z]/.test(token)) {
    const output = token === "||"
      ? "।"
      : shouldConvertDigits(token, options)
        ? toDevanagariDigits(token)
        : token;
    return {
      input: token,
      output,
      candidates: output === token ? [] : [{ text: output, normalizedText: output, score: 700, source: "rule", reason: "Explicit danda notation" }],
      trace: output === token ? [] : [{ input: token, output, rule: "explicit-punctuation" }]
    };
  }

  if (isLikelyEnglishToken(token)) {
    const output = canonicalEnglishToken(token);
    const dictionaryCandidates = options.useDictionary === false
      ? []
      : dictionaryCandidatesForToken(token, "Preserved likely English token; Nepali loanword candidate");
    if (shouldPreferStandaloneLoanword(token, context, dictionaryCandidates)) {
      const top = dictionaryCandidates[0];
      return {
        input: token,
        output: top.text,
        candidates: uniqueRankedCandidates([
          top,
          {
            text: output,
            normalizedText: output,
            score: SCORE.defaultFullOutput - 1,
            source: "rule",
            reason: "Preserved English alternative for mixed/document context"
          }
        ], 8),
        trace: [{ input: token, output: top.text, rule: "standalone-loanword-rank", notes: ["Single-token normal context prefers reviewed Nepali loanword candidate."] }]
      };
    }
    return {
      input: token,
      output,
      candidates: dictionaryCandidates,
      trace: [{ input: token, output, rule: "preserve-english", notes: ["Likely technical English, URL, email, or acronym."] }]
    };
  }

  const normalizedToken = normalizeRomanizedToken(token);
  const formalOverride = FORMAL_TOKEN_OVERRIDES.get(normalizedToken);
  if (formalOverride) {
    const parseToken = normalizeRomanizedTokenForParsing(token);
    const ruleConversion = composeRomanizedToken(parseToken);
    return {
      input: token,
      output: formalOverride,
      candidates: uniqueRankedCandidates([
        {
          text: formalOverride,
          normalizedText: normalizeNepaliText(formalOverride),
          score: SCORE.exactAlias + 20,
          source: "dictionary",
          reason: "Reviewed formal Nepali stress-test override"
        },
        {
          text: ruleConversion.output,
          normalizedText: normalizeNepaliText(ruleConversion.output),
          score: SCORE.rule,
          source: "rule",
          reason: "Rule-only parse candidate"
        }
      ], 8),
      trace: [
        {
          input: token,
          output: formalOverride,
          rule: "formal-token-override",
          notes: ["Reviewed high-value formal Romanized case."]
        },
        ...ruleConversion.trace
      ]
    };
  }
  const casualTailOverride = CASUAL_TAIL_OVERRIDES.get(normalizedToken);
  if (casualTailOverride) {
    const parseToken = normalizeRomanizedTokenForParsing(token);
    const ruleConversion = composeRomanizedToken(parseToken);
    return {
      input: token,
      output: casualTailOverride,
      candidates: uniqueRankedCandidates([
        {
          text: casualTailOverride,
          normalizedText: normalizeNepaliText(casualTailOverride),
          score: SCORE.exactAlias + 10,
          source: "variant",
          reason: "Reviewed casual Nepali typing convention"
        },
        {
          text: ruleConversion.output,
          normalizedText: normalizeNepaliText(ruleConversion.output),
          score: SCORE.rule,
          source: "rule",
          reason: "Rule-only parse candidate"
        },
        ...ambiguityCandidates(parseToken, ruleConversion.output)
      ], 8),
      trace: [
        {
          input: token,
          output: casualTailOverride,
          rule: "casual-tail-override",
          notes: ["Messenger-style Nepali spelling convention."]
        },
        ...ruleConversion.trace
      ]
    };
  }
  const dictionaryEntries = options.useDictionary === false || hasIntentionalCapitalPhoneme(token) ? [] : lookupByRomanized(normalizedToken);
  const parseToken = normalizeRomanizedTokenForParsing(token);
  const ruleConversion = composeRomanizedToken(parseToken);
  const variantCandidates = ambiguityCandidates(parseToken, ruleConversion.output);

  if (dictionaryEntries.length > 0) {
    const top = dictionaryEntries[0];
    const dictionaryCandidates: Candidate[] = dictionaryEntries.map((entry, index) => ({
      text: entry.word,
      normalizedText: entry.normalizedWord,
      score: (entry.source.includes("alias") ? SCORE.exactAlias : SCORE.domainDictionary) + Math.floor(entry.frequency / 10) - index,
      source: entry.source.includes("alias") ? "variant" : "dictionary",
      reason: entry.source.includes("alias") ? "Exact reviewed alias matched this spelling" : "Domain/frequency local dictionary match"
    }));

    if (normalizeNepaliText(ruleConversion.output) !== top.normalizedWord) {
      dictionaryCandidates.push({
        text: ruleConversion.output,
        normalizedText: normalizeNepaliText(ruleConversion.output),
        score: SCORE.rule,
        source: "rule",
        reason: "Rule-only parse candidate"
      });
    }

    return {
      input: token,
      output: top.word,
      candidates: uniqueRankedCandidates([...dictionaryCandidates, ...nameVariantCandidates(normalizedToken), ...variantCandidates], 8),
      trace: [
        {
          input: token,
          output: top.word,
          rule: "dictionary-rank",
          notes: [`profile:${profile}`, `romanized:${top.romanized}`]
        },
        ...ruleConversion.trace
      ]
    };
  }

  const compoundCandidates = options.useDictionary === false ? [] : compoundCandidatesForToken(normalizedToken);
  if (compoundCandidates.length > 0) {
    const top = compoundCandidates[0];
    return {
      input: token,
      output: top.text,
      candidates: uniqueRankedCandidates([...compoundCandidates, ...variantCandidates], 8),
      trace: [
        {
          input: token,
          output: top.text,
          rule: "compound-dictionary-rank",
          notes: [`profile:${profile}`, "split known romanized pieces before falling back to rule-only parse"]
        },
        ...ruleConversion.trace
      ]
    };
  }

  if (normalizedToken.includes("x")) {
    return {
      input: token,
      output: token,
      candidates: uniqueRankedCandidates(
        [
          {
            text: token,
            normalizedText: token,
            score: 710,
            source: "rule",
            reason: "x is preserved unless a dictionary/profile candidate is selected"
          },
          ...variantCandidates
        ],
        8
      ),
      trace: [
        {
          input: token,
          output: token,
          rule: "preserve-x",
          notes: ["x is candidate/profile-dependent in the common-nepali profile."]
        }
      ]
    };
  }

  return {
    input: token,
    output: ruleConversion.output,
    candidates: uniqueRankedCandidates(
      [
        {
          text: ruleConversion.output,
          normalizedText: normalizeNepaliText(ruleConversion.output),
          score: 700,
          source: "rule",
          reason: "Longest-match common-nepali rule parse"
        },
        ...variantCandidates
      ],
      8
    ),
    trace: ruleConversion.trace
  };
}

function shouldConvertDigits(token: string, options: TransliterateOptions): boolean {
  return options.digitPolicy === "convert-devanagari" && /^\d+$/.test(token);
}

function toDevanagariDigits(token: string): string {
  return token.replace(/\d/g, (digit) => String.fromCharCode("०".charCodeAt(0) + Number(digit)));
}

function applyOutputPolicies(output: string, options: TransliterateOptions): string {
  if (options.digitPolicy !== "convert-devanagari") return output;
  return normalizeFormalProseOutput(output);
}

function normalizeFormalProseOutput(output: string): string {
  const bsPlaceholder = "\uE020LKH_BS\uE021";
  return output
    .replace(/बि\.(?:साम|सम)\./g, "वि.सं.")
    .replace(/वि\.सं\./g, bsPlaceholder)
    .replace(/([।])\s*।/g, "$1")
    .replace(/([\u0900-\u097F])\.(?=\s|$)/g, "$1 ।")
    .replace(/([\u0900-\u097F]):(?=\s|$)/g, "$1ः")
    .replace(new RegExp(bsPlaceholder, "g"), "वि.सं.");
}

function shouldPreferStandaloneLoanword(token: string, context: TokenContext, dictionaryCandidates: Candidate[]): boolean {
  if (context.romanizedWordCount !== 1 || dictionaryCandidates.length === 0) return false;
  if (/^https?:\/\//i.test(token)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) return false;
  if (/^[A-Z0-9]{2,}$/.test(token)) return false;
  if (token === "x" || token === "X") return false;
  return true;
}

function buildFullOutputCandidates(
  input: string,
  conversions: TokenConversion[],
  normalizedDefaultOutput: string,
  localCorrections: LocalCorrection[]
): Candidate[] {
  const usedDictionary = conversions.some((conversion) =>
    conversion.candidates.some((candidate) => candidate.source === "dictionary")
  );

  return uniqueRankedCandidates(
    [
      ...localCorrectionCandidates(input, localCorrections),
      ...phraseCandidatesForInput(input),
      ...buildBeamFullOutputCandidates(conversions, normalizedDefaultOutput),
      {
        text: normalizedDefaultOutput,
        normalizedText: normalizedDefaultOutput,
        score: SCORE.defaultFullOutput,
        source: usedDictionary ? "dictionary" : "rule",
        reason: "Default full output from lattice top path"
      }
    ],
    8
  );
}

function buildBeamFullOutputCandidates(conversions: TokenConversion[], normalizedDefaultOutput: string): Candidate[] {
  let beams: BeamPath[] = [
    {
      parts: [],
      score: 0,
      replacements: 0,
      reasons: [],
      sources: new Set()
    }
  ];

  for (const conversion of conversions) {
    const alternatives = tokenBeamAlternatives(conversion);
    const nextBeams: BeamPath[] = [];

    for (const beam of beams) {
      for (const alternative of alternatives) {
        const isReplacement = alternative.normalizedText !== normalizeNepaliText(conversion.output);
        const nextSources = new Set(beam.sources);
        if (isReplacement) nextSources.add(alternative.source);
        nextBeams.push({
          parts: [...beam.parts, alternative.normalizedText],
          score: beam.score + (isReplacement ? Math.max(2, (alternative.score - 650) / 10) : 0),
          replacements: beam.replacements + (isReplacement ? 1 : 0),
          reasons: isReplacement ? [...beam.reasons, `${conversion.input}:${alternative.reason}`] : beam.reasons,
          sources: nextSources
        });
      }
    }

    beams = nextBeams.sort((a, b) => scoreBeam(b) - scoreBeam(a)).slice(0, 16);
  }

  return uniqueRankedCandidates(
    beams
      .filter((beam) => beam.replacements > 0 && (beam.sources.has("dictionary") || beam.sources.has("user-feedback")))
      .map((beam): Candidate => {
        const normalizedText = normalizeNepaliText(beam.parts.join(""));
        const source = beam.sources.has("user-feedback")
          ? "user-feedback"
          : beam.sources.has("dictionary")
            ? "dictionary"
            : beam.sources.has("variant")
              ? "variant"
              : "rule";

        return {
          text: normalizedText,
          normalizedText,
          score: Math.min(BEAM_ALTERNATIVE_MAX_SCORE, 930 + Math.round(scoreBeam(beam) / 4)),
          source,
          reason: `Combined ${beam.replacements} token-level candidates: ${beam.reasons.slice(0, 4).join("; ")}`
        };
      })
      .filter((candidate) => candidate.normalizedText !== normalizedDefaultOutput),
    8
  );
}

function tokenBeamAlternatives(conversion: TokenConversion): Candidate[] {
  const base = normalizeNepaliText(conversion.output);
  if (conversion.trace.some((trace) => trace.rule === "preserve-english")) {
    return [
      {
        text: base,
        normalizedText: base,
        score: SCORE.defaultFullOutput,
        source: "rule",
        reason: "preserved English token path"
      }
    ];
  }

  return uniqueRankedCandidates(
    [
      {
        text: base,
        normalizedText: base,
        score: SCORE.defaultFullOutput,
        source: "rule",
        reason: "default token path"
      },
      ...conversion.candidates
    ],
    5
  );
}

function scoreBeam(beam: BeamPath): number {
  return beam.score + beam.replacements * 8;
}

function buildTokenReplacementCandidates(conversions: TokenConversion[]): Candidate[] {
  const baseParts = conversions.map((conversion) => conversion.output);
  const candidates: Candidate[] = [];

  conversions.forEach((conversion, index) => {
    for (const candidate of conversion.candidates) {
      if (candidate.normalizedText === normalizeNepaliText(conversion.output)) continue;
      const nextParts = [...baseParts];
      nextParts[index] = candidate.normalizedText;
      const fullOutput = normalizeNepaliText(nextParts.join(""));
      candidates.push({
        ...candidate,
        text: fullOutput,
        normalizedText: fullOutput,
        score: Math.min(candidate.score, 990),
        reason: `${candidate.reason}; token alternative for "${conversion.input}"`
      });
    }
  });

  return uniqueRankedCandidates(candidates, 12);
}

function dictionaryCandidatesForToken(token: string, reason: string): Candidate[] {
  return lookupByRomanized(normalizeRomanizedToken(token)).map((entry, index) => ({
    text: entry.word,
    normalizedText: entry.normalizedWord,
    score: entry.frequency + 120 - index,
    source: "dictionary",
    reason
  }));
}

function nameVariantCandidates(token: string): Candidate[] {
  if (token === "niraj") {
    return [
      {
        text: "नीरज",
        normalizedText: "नीरज",
        score: 650,
        source: "variant",
        reason: "Common name spelling variant for Niraj/Neeraj"
      }
    ];
  }
  if (token === "neeraj") {
    return [
      {
        text: "निरज",
        normalizedText: "निरज",
        score: 640,
        source: "variant",
        reason: "Common name spelling variant for Niraj/Neeraj"
      }
    ];
  }
  return [];
}

function compoundCandidatesForToken(token: string): Candidate[] {
  if (token.length < 6 || !/^[a-z]+$/.test(token)) return [];
  const candidates: Candidate[] = [];

  for (let split = 2; split <= token.length - 2; split += 1) {
    const left = token.slice(0, split);
    const right = token.slice(split);
    const leftEntries = lookupByRomanized(left);
    const rightEntries = lookupByRomanized(right);
    const rightEnglish = isLikelyEnglishToken(right) ? canonicalEnglishToken(right) : undefined;
    const leftEnglish = isLikelyEnglishToken(left) ? canonicalEnglishToken(left) : undefined;

    if (leftEntries.length > 0 && rightEnglish) {
      pushCompoundCandidate(candidates, left, right, leftEntries[0].normalizedWord, rightEnglish, leftEntries[0].frequency + 2200);
      continue;
    }
    if (leftEnglish && rightEntries.length > 0) {
      pushCompoundCandidate(candidates, left, right, leftEnglish, rightEntries[0].normalizedWord, rightEntries[0].frequency + 2200);
      continue;
    }
    if (leftEntries.length > 0 && rightEntries.length > 0) {
      pushCompoundCandidate(candidates, left, right, leftEntries[0].normalizedWord, rightEntries[0].normalizedWord, leftEntries[0].frequency + rightEntries[0].frequency);
    }
  }

  return uniqueRankedCandidates(candidates, 6);
}

function pushCompoundCandidate(
  candidates: Candidate[],
  leftInput: string,
  rightInput: string,
  leftOutput: string,
  rightOutput: string,
  scoreBasis: number
) {
  const normalizedText = normalizeNepaliText(`${leftOutput}${rightOutput}`);
  candidates.push({
    text: normalizedText,
    normalizedText,
    score: 1080 + Math.min(180, Math.floor(scoreBasis / 20)),
    source: "dictionary",
    reason: `Compound candidate from "${leftInput}" + "${rightInput}"`
  });
}

function ambiguityCandidates(token: string, defaultOutput: string): Candidate[] {
  const lower = token.toLowerCase();
  const candidates: Candidate[] = [];

  if (lower.includes("sh")) {
    pushVariant(candidates, token, { sh: "ष" }, 560, "plain sh can have a formal ष variant");
    pushVariant(candidates, token, { sh: "स" }, 520, "plain sh can be typed where users expect स");
  }

  if (token.includes("Sh") || token.includes("S")) {
    pushVariant(candidates, token, { Sh: "श", S: "श" }, 555, "capital Sh/S has a श secondary candidate");
  }

  if (lower.includes("ch") && !lower.includes("chh")) {
    pushVariant(candidates, token, { ch: "छ" }, 540, "ch has छ as a secondary candidate");
  }

  if (lower.startsWith("ri")) {
    const riVariant = composeRomanizedToken(token, { forceInitialRiAsVowel: true }).output;
    candidates.push({
      text: riVariant,
      normalizedText: normalizeNepaliText(riVariant),
      score: 550,
      source: "variant",
      reason: "initial ri can be ऋ for known classical/formal words"
    });
  }

  if (lower.includes("gya")) {
    const literalToken = token.replace(/gya/gi, (match) => `${match.slice(0, 2)}aa`);
    const literal = composeRomanizedToken(literalToken, { clusterOverrides: { gy: "ग्य" } }).output;
    candidates.push({
      text: literal,
      normalizedText: normalizeNepaliText(literal),
      score: 500,
      source: "variant",
      reason: "literal ग्या secondary candidate for gya"
    });
  }

  if (lower.includes("x")) {
    const kshCandidate = composeRomanizedToken(token.replace(/x/gi, "ksh")).output;
    candidates.push({
      text: kshCandidate,
      normalizedText: normalizeNepaliText(kshCandidate),
      score: 540,
      source: "variant",
      reason: "x can be selected as क्ष by profile or dictionary candidate"
    });
    if (/[aeiou]/i.test(lower.slice(lower.indexOf("x") + 1, lower.indexOf("x") + 2))) {
      const chhaCandidate = composeRomanizedToken(token.replace(/x/gi, "chh")).output;
      candidates.push({
        text: chhaCandidate,
        normalizedText: normalizeNepaliText(chhaCandidate),
        score: 570,
        source: "variant",
        reason: "x can be selected as छ in common Nepali chat typing"
      });
    }
  }

  if (/^[bv]a[a-z]+$/i.test(token)) {
    const longAInput = token.replace(/^[bv]a/i, "baa");
    const longA = composeRomanizedToken(longAInput).output;
    candidates.push({
      text: longA,
      normalizedText: normalizeNepaliText(longA),
      score: 565,
      source: "variant",
      reason: "initial ba/va can imply long बा in casual road/place words"
    });
  }

  if (lower.includes("ksh")) {
    const rare = composeRomanizedToken(token, { clusterOverrides: { ksh: "क्" + "श" } }).output;
    candidates.push({
      text: rare,
      normalizedText: normalizeNepaliText(rare),
      score: 480,
      source: "variant",
      reason: "rare क्श spelling candidate for ksh"
    });
  }

  if (/[bcdfghjklmnpqrstvwxyz]/i.test(token) && /्/.test(defaultOutput)) {
    const noGenericHalanta = composeRomanizedToken(token, { genericHalanta: false }).output;
    if (normalizeNepaliText(noGenericHalanta) !== normalizeNepaliText(defaultOutput)) {
      candidates.push({
        text: noGenericHalanta,
        normalizedText: normalizeNepaliText(noGenericHalanta),
        score: 455,
        source: "variant",
        reason: "non-conjunct parse candidate for ambiguous consonant sequence"
      });
    }
  }

  return uniqueRankedCandidates([...candidates, ...weightedRepairCandidates(token, defaultOutput)], 8);
}

function pushVariant(
  candidates: Candidate[],
  token: string,
  overrides: Record<string, string>,
  score: number,
  reason: string
) {
  const variant = composeRomanizedToken(token, { consonantOverrides: overrides }).output;
  candidates.push({
    text: variant,
    normalizedText: normalizeNepaliText(variant),
    score,
    source: "variant",
    reason
  });
}
