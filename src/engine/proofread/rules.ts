import type { ProofreadHint } from "./types";
import { pluralHaruHints } from "./morphology";
import { postpositionHints } from "./postpositions";

const SPELLING_CORRECTIONS: Array<[string, string, string]> = [
  ["सवस्थ्य", "स्वास्थ्य", "common-spelling-swasthya"],
  ["प्रनलि", "प्रणाली", "common-spelling-pranali"],
  ["राजनितिज्ञ", "राजनीतिज्ञ", "common-spelling-rajanitigya"],
  ["मरित्यु", "मृत्यु", "common-spelling-mrityu"],
  ["अन्तररस्त्रिय", "अन्तर्राष्ट्रिय", "common-spelling-antarrastriya"],
  ["अन्तरराष्ट्रिय", "अन्तर्राष्ट्रिय", "common-spelling-antarrastriya"],
  ["सनसद", "संसद", "common-spelling-sansad"],
  ["स्थनिय", "स्थानीय", "common-spelling-sthaniya"],
  ["गल्त", "गलत", "common-spelling-galat"],
  ["प्रमनपत्र", "प्रमाणपत्र", "common-spelling-pramanpatra"],
  ["प्रमनपुरज", "प्रमाणपुर्जा", "common-spelling-pramanpurja"],
  ["जगग", "जग्गा", "common-spelling-jagga"]
];

const HALANT_CORRECTIONS: Array<[string, string, string]> = [
  ["मन्त्रिपरिषद", "मन्त्रिपरिषद्", "terminal-halant-mantriparishad"]
];

export interface RuleOptions {
  normalizePluralHaru: boolean;
  normalizePostpositions: boolean;
  normalizeDanda: boolean;
}

export function collectProofreadHints(input: string, offset: number, options: RuleOptions): ProofreadHint[] {
  return [
    ...spellingHints(input, offset),
    ...grammarAwareHints(input, offset),
    ...halantHints(input, offset),
    ...(options.normalizePluralHaru ? pluralHaruHints(input, offset) : []),
    ...(options.normalizePostpositions ? postpositionHints(input, offset) : []),
    ...(options.normalizeDanda ? dandaHints(input, offset) : [])
  ].sort((a, b) => a.range[0] - b.range[0] || b.confidence - a.confidence);
}

function grammarAwareHints(input: string, offset: number): ProofreadHint[] {
  return [
    ...subjectAgreementHints(input, offset),
    ...honorificHints(input, offset),
    ...anusvaraRuleHints(input, offset),
    ...matraContextHints(input, offset)
  ];
}

function subjectAgreementHints(input: string, offset: number): ProofreadHint[] {
  const rules: Array<{
    pattern: RegExp;
    suggestion(subject: string): string;
    ruleId: string;
    explanation: string;
  }> = [
    {
      pattern: /(म)\s+आयौ/g,
      suggestion: (subject) => `${subject} आएँ`,
      ruleId: "agreement-ma-aaye",
      explanation: "First-person singular subject normally takes आएँ, not आयौ."
    },
    {
      pattern: /(हामी)\s+आयौ/g,
      suggestion: (subject) => `${subject} आयौं`,
      ruleId: "agreement-hami-aayaun",
      explanation: "First-person plural subject normally takes आयौं/आयौँ; suggest the common आयौं form."
    },
    {
      pattern: /(तिमी)\s+आयौं/g,
      suggestion: (subject) => `${subject} आयौ`,
      ruleId: "agreement-timi-aayau",
      explanation: "Second-person familiar subject तिमी normally takes आयौ, not आयौं."
    }
  ];
  return rules.flatMap((rule) =>
    Array.from(input.matchAll(rule.pattern)).map((match): ProofreadHint => {
      const start = offset + (match.index ?? 0);
      const original = match[0];
      return {
        id: `${rule.ruleId}-${start}`,
        range: [start, start + original.length],
        input: original,
        suggestion: rule.suggestion(match[1]),
        ruleId: rule.ruleId,
        kind: "agreement",
        confidence: 0.9,
        action: "hint-only",
        explanation: rule.explanation
      };
    })
  );
}

function honorificHints(input: string, offset: number): ProofreadHint[] {
  const rules: Array<{
    pattern: RegExp;
    suggestion(subject: string): string;
    ruleId: string;
    explanation: string;
  }> = [
    {
      pattern: /(तपाईं|तपाईँ|हजुर|उहाँ)\s+आयो/g,
      suggestion: (subject) => `${subject} आउनुभयो`,
      ruleId: "honorific-aayo-aaunubhayo",
      explanation: "Honorific subjects should be reviewed; suggest आउनुभयो instead of आयो."
    },
    {
      pattern: /(तपाईं|तपाईँ|हजुर|उहाँ)\s+गयो/g,
      suggestion: (subject) => `${subject} जानुभयो`,
      ruleId: "honorific-gayo-janubhayo",
      explanation: "Honorific subjects should be reviewed; suggest जानुभयो instead of गयो."
    },
    {
      pattern: /(तपाईं|तपाईँ|हजुर|उहाँ)\s+छ/g,
      suggestion: (subject) => `${subject} हुनुहुन्छ`,
      ruleId: "honorific-cha-hunuhuncha",
      explanation: "Honorific subjects usually take हुनुहुन्छ instead of छ."
    }
  ];
  return rules.flatMap((rule) =>
    Array.from(input.matchAll(rule.pattern)).map((match): ProofreadHint => {
      const start = offset + (match.index ?? 0);
      const original = match[0];
      return {
        id: `${rule.ruleId}-${start}`,
        range: [start, start + original.length],
        input: original,
        suggestion: rule.suggestion(match[1]),
        ruleId: rule.ruleId,
        kind: "honorific",
        confidence: 0.9,
        action: "hint-only",
        explanation: rule.explanation
      };
    })
  );
}

function anusvaraRuleHints(input: string, offset: number): ProofreadHint[] {
  return replacementHints(
    input,
    offset,
    [
      ["सस्कृति", "संस्कृति", "anusvara-drop-sanskriti"],
      ["सचार", "सञ्चार", "anusvara-drop-sanchar"],
      ["सघीय", "संघीय", "anusvara-drop-sanghiya"],
      ["संबिधान", "संविधान", "anusvara-context-sambidhan"]
    ],
    "spelling",
    0.91,
    "Rule-generated anusvara/nasalization correction, rescored conservatively by lexical context."
  ).map((hint) => ({ ...hint, action: "hint-only" as const }));
}

function matraContextHints(input: string, offset: number): ProofreadHint[] {
  return replacementHints(
    input,
    offset,
    [
      ["राम्रो लग्यो", "राम्रो लाग्यो", "matra-context-ramro-lagyo"],
      ["मन पर्यो", "मन पर्‍यो", "matra-context-man-paryo"],
      ["गरि सके", "गरी सके", "matra-context-gari-sake"]
    ],
    "matra",
    0.88,
    "Contextual matra/verb-form suggestion; review before accepting."
  ).map((hint) => ({ ...hint, action: "hint-only" as const }));
}

function spellingHints(input: string, offset: number): ProofreadHint[] {
  return replacementHints(input, offset, SPELLING_CORRECTIONS, "spelling", 0.98, "Curated common spelling correction.");
}

function halantHints(input: string, offset: number): ProofreadHint[] {
  return replacementHints(input, offset, HALANT_CORRECTIONS, "halant", 0.96, "Curated terminal halant correction for a fixed lexical form.");
}

function replacementHints(
  input: string,
  offset: number,
  corrections: Array<[string, string, string]>,
  kind: ProofreadHint["kind"],
  confidence: number,
  explanation: string
): ProofreadHint[] {
  const hints: ProofreadHint[] = [];
  for (const [source, target, ruleId] of corrections) {
    let startAt = 0;
    while (startAt < input.length) {
      const index = input.indexOf(source, startAt);
      if (index === -1) break;
      hints.push({
        id: `${ruleId}-${offset + index}`,
        range: [offset + index, offset + index + source.length],
        input: source,
        suggestion: target,
        ruleId,
        kind,
        confidence,
        action: "auto-fix",
        explanation
      });
      startAt = index + source.length;
    }
  }
  return hints;
}

function dandaHints(input: string, offset: number): ProofreadHint[] {
  const hints: ProofreadHint[] = [];
  for (const match of input.matchAll(/([\u0900-\u097F])\.(?=\s|$)/g)) {
    const start = offset + (match.index ?? 0) + match[1].length;
    hints.push({
      id: `danda-normalization-${start}`,
      range: [start, start + 1],
      input: ".",
      suggestion: "।",
      ruleId: "danda-normalization",
      kind: "punctuation",
      confidence: 0.96,
      action: "auto-fix",
      explanation: "Normalize a Nepali sentence-ending period to danda outside protected English spans."
    });
  }
  for (const match of input.matchAll(/।{2,}/g)) {
    const start = offset + (match.index ?? 0);
    hints.push({
      id: `duplicate-danda-${start}`,
      range: [start, start + match[0].length],
      input: match[0],
      suggestion: "।",
      ruleId: "duplicate-danda",
      kind: "punctuation",
      confidence: 0.99,
      action: "auto-fix",
      explanation: "Collapse duplicated danda punctuation."
    });
  }
  return hints;
}
