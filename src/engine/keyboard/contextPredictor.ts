import { canonicalRomanizedLabel } from "./helpers";
import type { Candidate, TypingContext } from "./types";

interface ContextPredictionRow {
  romanized: string;
  output: string;
  label?: string;
  confidence: number;
  domains: string[];
  contextHints: string[];
  reason: string;
  minPrefix?: number;
  allowWithoutContext?: boolean;
}

const CONTEXT_ROWS: ContextPredictionRow[] = [
  {
    romanized: "mero ke cha awastha",
    output: "मेरो के छ अवस्था",
    label: "mero ke cha awastha",
    confidence: 0.965,
    domains: ["casual", "general"],
    contextHints: ["sathi", "chat", "namaste", "k gardai", "kasto", "malai", "timi", "mero"],
    reason: "casual status completion",
    minPrefix: 5,
    allowWithoutContext: true
  },
  {
    romanized: "k gardai chau",
    output: "के गर्दै छौ",
    confidence: 0.955,
    domains: ["casual", "general"],
    contextHints: ["sathi", "chat", "timi", "aja", "bholi", "namaste"],
    reason: "casual activity question",
    minPrefix: 2,
    allowWithoutContext: true
  },
  {
    romanized: "malai thaha chaina",
    output: "मलाई थाहा छैन",
    confidence: 0.955,
    domains: ["casual", "general"],
    contextHints: ["sathi", "chat", "yo", "kasari", "kina"],
    reason: "casual uncertainty phrase",
    minPrefix: 5,
    allowWithoutContext: true
  },
  {
    romanized: "bholi bhetumla",
    output: "भोलि भेटौँला",
    confidence: 0.95,
    domains: ["casual", "general"],
    contextHints: ["aaja", "pachi", "meeting", "call", "sathi"],
    reason: "casual follow-up phrase",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "ramro lagyo",
    output: "राम्रो लाग्यो",
    confidence: 0.96,
    domains: ["casual", "general"],
    contextHints: ["photo", "video", "post", "yo", "dherai"],
    reason: "casual reaction phrase",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "dherai ramro",
    output: "धेरै राम्रो",
    label: "dherai ramro",
    confidence: 0.962,
    domains: ["casual", "general"],
    contextHints: ["ramro", "kasto", "post", "photo", "video", "yo", "sathi"],
    reason: "casual intensifier phrase",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "ma aaudai xu",
    output: "म आउँदै छु",
    label: "ma aaudai xu",
    confidence: 0.955,
    domains: ["casual", "general"],
    contextHints: ["ghar", "office", "meeting", "bato", "bholi", "aaja"],
    reason: "casual arrival phrase",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "jilla prashasan",
    output: "जिल्ला प्रशासन",
    confidence: 0.982,
    domains: ["government", "office", "admin"],
    contextHints: ["nid", "nagarikta", "form", "sifaris", "ward", "karyalaya", "darta", "praman", "citizenship"],
    reason: "government office context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "jilla prashasan karyalaya",
    output: "जिल्ला प्रशासन कार्यालय",
    confidence: 0.972,
    domains: ["government", "office", "admin"],
    contextHints: ["nid", "nagarikta", "form", "sifaris", "ward", "karyalaya", "darta", "praman", "citizenship"],
    reason: "government office phrase completion",
    minPrefix: 7,
    allowWithoutContext: true
  },
  {
    romanized: "nagarikta pramanpatra",
    output: "नागरिकता प्रमाणपत्र",
    label: "nagarikta pramanpatra",
    confidence: 0.982,
    domains: ["government", "office", "legal", "admin"],
    contextHints: ["nid", "citizenship", "ward", "jilla", "form", "sifaris", "prashasan"],
    reason: "citizenship document context",
    minPrefix: 5,
    allowWithoutContext: true
  },
  {
    romanized: "nagarikta praman patra",
    output: "नागरिकता प्रमाण पत्र",
    label: "nagarikta praman patra",
    confidence: 0.94,
    domains: ["government", "office", "legal", "admin"],
    contextHints: ["nid", "citizenship", "ward", "jilla", "form", "sifaris", "prashasan"],
    reason: "citizenship document spaced variant",
    minPrefix: 5,
    allowWithoutContext: true
  },
  {
    romanized: "janma darta",
    output: "जन्म दर्ता",
    confidence: 0.958,
    domains: ["government", "office", "legal", "admin"],
    contextHints: ["ward", "palika", "form", "record", "certificate", "sifaris"],
    reason: "civil registration context",
    minPrefix: 6,
    allowWithoutContext: true
  },
  {
    romanized: "mrityu darta",
    output: "मृत्यु दर्ता",
    confidence: 0.958,
    domains: ["government", "office", "legal", "admin"],
    contextHints: ["ward", "palika", "form", "record", "certificate", "sifaris"],
    reason: "civil registration context",
    minPrefix: 6,
    allowWithoutContext: true
  },
  {
    romanized: "sifaris patra",
    output: "सिफारिस पत्र",
    confidence: 0.955,
    domains: ["government", "office", "admin"],
    contextHints: ["ward", "palika", "form", "nagarikta", "jilla", "karyalaya"],
    reason: "recommendation-letter context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "rajaswa shakha",
    output: "राजस्व शाखा",
    confidence: 0.954,
    domains: ["government", "office", "admin"],
    contextHints: ["tax", "kar", "rasid", "ward", "palika", "payment"],
    reason: "revenue office context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "kar karyalaya",
    output: "कर कार्यालय",
    confidence: 0.954,
    domains: ["government", "office", "admin"],
    contextHints: ["tax", "vat", "pan", "rasid", "rajaswa", "payment"],
    reason: "tax office context",
    minPrefix: 3,
    allowWithoutContext: true
  },
  {
    romanized: "swasthya karyalaya",
    output: "स्वास्थ्य कार्यालय",
    confidence: 0.972,
    domains: ["health", "government", "office"],
    contextHints: ["doctor", "hospital", "janch", "report", "bima", "prescription", "xray"],
    reason: "health office context",
    minPrefix: 5,
    allowWithoutContext: true
  },
  {
    romanized: "swasthya bima",
    output: "स्वास्थ्य बीमा",
    confidence: 0.958,
    domains: ["health", "government"],
    contextHints: ["hospital", "doctor", "janch", "insurance", "report", "card"],
    reason: "health insurance context",
    minPrefix: 5,
    allowWithoutContext: true
  },
  {
    romanized: "doctor ko prescription",
    output: "doctor को prescription",
    label: "doctor ko prescription",
    confidence: 0.94,
    domains: ["health"],
    contextHints: ["hospital", "medicine", "report", "janch", "xray"],
    reason: "health mixed-language context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "xray report",
    output: "xray report",
    label: "xray report",
    confidence: 0.94,
    domains: ["health", "tech"],
    contextHints: ["doctor", "hospital", "janch", "prescription", "upload"],
    reason: "health protected report phrase",
    minPrefix: 2,
    allowWithoutContext: true
  },
  {
    romanized: "shiksha mantralaya",
    output: "शिक्षा मन्त्रालय",
    confidence: 0.968,
    domains: ["education", "government"],
    contextHints: ["school", "college", "exam", "result", "grade", "bidhyalaya", "admit"],
    reason: "education ministry context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "exam form",
    output: "exam form",
    label: "exam form",
    confidence: 0.93,
    domains: ["education"],
    contextHints: ["school", "college", "result", "admit", "grade", "bidhyalaya"],
    reason: "education mixed-language form phrase",
    minPrefix: 2,
    allowWithoutContext: true
  },
  {
    romanized: "result publish bhayo",
    output: "result publish भयो",
    label: "result publish bhayo",
    confidence: 0.94,
    domains: ["education"],
    contextHints: ["exam", "school", "college", "grade", "admit", "bidhyalaya"],
    reason: "education result context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "file upload bhayena",
    output: "file upload भएन",
    label: "file upload bhayena",
    confidence: 0.965,
    domains: ["tech", "office", "education", "government"],
    contextHints: ["pdf", "form", "submit", "website", "system", "online", "error", "nid"],
    reason: "digital workflow failure context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "form submit bhayena",
    output: "form submit भएन",
    label: "form submit bhayena",
    confidence: 0.965,
    domains: ["tech", "office", "education", "government"],
    contextHints: ["pdf", "file", "upload", "website", "system", "online", "error", "nid"],
    reason: "digital form failure context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "website khulena",
    output: "website खुलेन",
    label: "website khulena",
    confidence: 0.95,
    domains: ["tech"],
    contextHints: ["browser", "chrome", "link", "url", "system", "server", "login"],
    reason: "technical access problem context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "password birse",
    output: "password बिर्से",
    label: "password birse",
    confidence: 0.94,
    domains: ["tech"],
    contextHints: ["login", "account", "username", "email", "otp", "reset"],
    reason: "account/login context",
    minPrefix: 4,
    allowWithoutContext: true
  },
  {
    romanized: "email pathaideu",
    output: "email पठाइदेऊ",
    label: "email pathaideu",
    confidence: 0.94,
    domains: ["tech", "office", "education"],
    contextHints: ["file", "report", "pdf", "document", "office", "teacher"],
    reason: "digital communication context",
    minPrefix: 3,
    allowWithoutContext: true
  }
];

export function contextualPredictionCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  const active = normalizeRomanContext(input);
  if (!active || !/[a-z]/.test(active)) return [];

  const left = normalizeRomanContext(context?.leftTextWindow ?? "");
  const right = normalizeRomanContext(context?.rightTextWindow ?? "");
  const activeDomains = new Set((context?.activeDomains ?? []).map((domain) => domain.toLowerCase()));
  const contextWindow = `${left} ${right}`.trim();

  return CONTEXT_ROWS
    .map((row, index) => scoreContextRow(row, index, active, contextWindow, activeDomains, rangeEnd, context))
    .filter((candidate): candidate is Candidate => Boolean(candidate))
    .sort((a, b) => b.confidence - a.confidence || a.text.localeCompare(b.text, "ne"))
    .slice(0, 6);
}

function scoreContextRow(
  row: ContextPredictionRow,
  index: number,
  active: string,
  contextWindow: string,
  activeDomains: Set<string>,
  rangeEnd: number,
  context?: TypingContext
): Candidate | undefined {
  const prefixMinimum = row.minPrefix ?? 3;
  const exact = active === row.romanized;
  const prefixMatch = row.romanized.startsWith(active) && active.length >= prefixMinimum;
  const completedMatch = active.startsWith(row.romanized) && row.romanized.length >= prefixMinimum;
  if (!exact && !prefixMatch && !completedMatch) return undefined;

  const hintMatches = row.contextHints.filter((hint) => contextWindow.includes(hint));
  const domainMatches = row.domains.filter((domain) => activeDomains.has(domain));
  if (hintMatches.length === 0 && domainMatches.length === 0) return undefined;

  const coverage = Math.min(1, active.length / Math.max(row.romanized.length, 1));
  const contextBoost = Math.min(0.035, hintMatches.length * 0.012) + Math.min(0.025, domainMatches.length * 0.008);
  const exactBoost = exact ? 0.018 : 0;
  const shorterPhrasePenalty = completedMatch && !exact ? 0.045 : 0;
  const phraseBeforeBoundary = row.output.includes(" ") && prefixMatch && !active.includes(" ");
  const rawConfidence = Math.min(0.995, row.confidence + contextBoost + exactBoost + coverage * 0.015 - shorterPhrasePenalty);
  const confidence = phraseBeforeBoundary && hintMatches.length === 0 ? Math.min(0.78, rawConfidence) : rawConfidence;
  const label = context?.showRomanizedLabels ? row.label ?? canonicalRomanizedLabel(row.output, row.romanized) : undefined;
  const reasons = [
    `Context prediction: ${row.reason}`,
    hintMatches.length > 0 ? `Matched context: ${hintMatches.slice(0, 3).join(", ")}` : "",
    domainMatches.length > 0 ? `Matched domain: ${domainMatches.join(", ")}` : "",
    prefixMatch ? "Phrase completion from active prefix" : "",
    phraseBeforeBoundary && hintMatches.length === 0 ? "Held below exact word until context or phrase boundary is typed" : ""
  ].filter(Boolean);

  return {
    id: `context-${index}-${row.output}`,
    text: row.output,
    label,
    type: row.output.includes(" ") ? "phrase" : "completion",
    confidence,
    reason: reasons,
    replaceRange: [0, rangeEnd]
  };
}

function normalizeRomanContext(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9@._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
