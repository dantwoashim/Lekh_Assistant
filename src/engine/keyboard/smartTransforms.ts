import { convertRomanized } from "../romanized";
import { isSecureContext } from "./modes";
import type { Candidate, TypingContext } from "./types";

type MixedPolicy =
  | { kind: "protected"; text?: string; reason: string }
  | { kind: "preference"; converted: string; reason: string }
  | { kind: "convert"; reason: string };

const DEVANAGARI_DIGITS = ["०", "१", "२", "३", "४", "५", "६", "७", "८", "९"];

const EMOJI_SHORTCUTS: Record<string, string> = {
  ":namaste:": "🙏",
  ":dhanyabad:": "🙏",
  ":smile:": "🙂",
  ":heart:": "❤️"
};

const TEXT_SNIPPETS: Record<string, string> = {
  "@@addr": "काठमाडौं, नेपाल",
  "@@namaste": "नमस्ते",
  "@@thanks": "धन्यवाद"
};

const CONTEXT_LATIN_CUES = new Set([
  "email",
  "mail",
  "url",
  "link",
  "website",
  "username",
  "password",
  "otp",
  "pin",
  "code",
  "account",
  "id"
]);

const LOANWORD_CONVERSIONS: Record<string, string> = {
  file: "फाइल",
  form: "फारम",
  report: "रिपोर्ट",
  submit: "सबमिट",
  upload: "अपलोड",
  download: "डाउनलोड",
  system: "सिस्टम",
  office: "अफिस",
  record: "रेकर्ड",
  hospital: "अस्पताल",
  school: "स्कुल",
  college: "कलेज",
  meeting: "मिटिङ"
};

const MIXED_ROMANIZED_OVERRIDES: Record<string, string> = {
  ma: "म",
  mero: "मेरो",
  hamro: "हाम्रो",
  timro: "तिम्रो",
  gaye: "गये",
  gayen: "गएँ",
  pathaunu: "पठाउनु"
};

export function smartTransformCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  if (context && isSecureContext(context)) return [];
  const normalized = input.trim();
  if (!normalized) return [];

  const explicit = explicitKeepEnglishCandidate(normalized, rangeEnd);
  if (explicit) return [explicit];

  const expansion = expansionCandidate(normalized, rangeEnd);
  const dateNumber = dateNumberCandidates(normalized, rangeEnd);
  return [...(expansion ? [expansion] : []), ...dateNumber];
}

export function classifyMixedLatinToken(token: string, leftTokens: string[]): MixedPolicy {
  const cleaned = cleanToken(token);
  const lower = cleaned.toLowerCase();
  if (!cleaned) return { kind: "convert", reason: "empty token after punctuation trim" };
  if (token.endsWith("=")) {
    return { kind: "protected", text: cleaned.replace(/=$/, ""), reason: "explicit keep-English gesture" };
  }
  if (
    isStructuredProtectedToken(cleaned) ||
    /^[A-Z]{2,}$/.test(cleaned) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ||
    /^https?:\/\//i.test(cleaned) ||
    /^\d{2,4}(?:[-/]\d{1,4})*$/.test(cleaned)
  ) {
    return { kind: "protected", reason: "structured protected Latin token" };
  }
  const previousToken = leftTokens[leftTokens.length - 1];
  if (CONTEXT_LATIN_CUES.has(lower) || (previousToken ? CONTEXT_LATIN_CUES.has(previousToken) : false)) {
    return { kind: "protected", reason: "Latin token preserved by local context classifier" };
  }
  const converted = LOANWORD_CONVERSIONS[lower];
  if (converted) return { kind: "preference", converted, reason: "contextual loanword conversion candidate" };
  return { kind: "convert", reason: "Romanized Nepali conversion candidate" };
}

export function convertSmartRomanizedToken(token: string, context?: TypingContext): string {
  const cleaned = token.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const override = MIXED_ROMANIZED_OVERRIDES[cleaned];
  if (override) return override;
  return convertRomanized(token, {
    mode: context?.activeDomains.includes("government") ? "romanized-government" : "romanized-mixed",
    digitPolicy: "context-dependent"
  }).normalizedOutput;
}

function explicitKeepEnglishCandidate(input: string, rangeEnd: number): Candidate | undefined {
  if (!input.endsWith("=") && !/\s{2,}/.test(input)) return undefined;
  const text = input.endsWith("=")
    ? input.slice(0, -1).trim()
    : input.replace(/\s{2,}/g, " ").trim();
  if (!text || !/[A-Za-z]/.test(text)) return undefined;
  return {
    id: `explicit-keep-english-${text}`,
    text,
    label: "keep English",
    type: "protected",
    confidence: 0.995,
    reason: ["Explicit keep-English gesture: trailing = or double-space"],
    replaceRange: [0, rangeEnd]
  };
}

function expansionCandidate(input: string, rangeEnd: number): Candidate | undefined {
  const lower = input.toLowerCase();
  const emoji = EMOJI_SHORTCUTS[lower];
  if (emoji) {
    return {
      id: `emoji-shortcut-${lower}`,
      text: emoji,
      label: lower,
      type: "completion",
      confidence: 0.99,
      reason: ["Local emoji shortcut expansion"],
      replaceRange: [0, rangeEnd]
    };
  }
  const snippet = TEXT_SNIPPETS[lower];
  if (snippet) {
    return {
      id: `snippet-${lower}`,
      text: snippet,
      label: lower,
      type: "completion",
      confidence: 0.98,
      reason: ["Local text-expansion snippet"],
      replaceRange: [0, rangeEnd]
    };
  }
  return undefined;
}

function dateNumberCandidates(input: string, rangeEnd: number): Candidate[] {
  const candidates: Candidate[] = [];
  const saal = input.match(/^([0-9०-९]{3,4})\s+(?:saal|sal|साल)$/i);
  if (saal) {
    const year = toNepaliDigits(toLatinDigits(saal[1]));
    candidates.push({
      id: `smart-year-${year}`,
      text: `${year} साल`,
      label: input,
      type: "completion",
      confidence: 0.98,
      reason: ["Smart Nepali year and numeral formatting"],
      replaceRange: [0, rangeEnd]
    });
  }

  const rupees = input.match(/^(?:rs|nrs|ru|रु)\.?\s*([0-9०-९,]+)$/i);
  if (rupees) {
    const amount = formatNepaliNumber(toLatinDigits(rupees[1]));
    candidates.push({
      id: `smart-rupees-${amount}`,
      text: `रु ${amount}`,
      label: input,
      type: "completion",
      confidence: 0.97,
      reason: ["Smart rupee amount formatting"],
      replaceRange: [0, rangeEnd]
    });
  }

  if (/^(?:aja|aaja|आज)$/i.test(input)) {
    const today = todayBsLabel();
    candidates.push({
      id: `smart-date-today-${today}`,
      text: `आज (${today})`,
      label: "aja",
      type: "completion",
      confidence: 0.9,
      reason: ["Today date expansion in local Nepali format"],
      replaceRange: [0, rangeEnd]
    });
  }

  return candidates;
}

function todayBsLabel(date = new Date()): string {
  const anchor = Date.UTC(2026, 3, 14);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  let days = Math.floor((current - anchor) / 86_400_000);
  let year = 2083;
  const monthNames = ["बैशाख", "जेठ", "असार", "साउन", "भदौ", "असोज", "कात्तिक", "मंसिर", "पुस", "माघ", "फागुन", "चैत"];
  const monthLengths = [31, 31, 32, 31, 31, 30, 30, 29, 30, 29, 30, 30];

  while (days < 0) {
    year -= 1;
    days += 365;
  }
  while (days >= 365) {
    year += 1;
    days -= 365;
  }

  let month = 0;
  while (month < monthLengths.length - 1 && days >= monthLengths[month]) {
    days -= monthLengths[month];
    month += 1;
  }
  return `${toNepaliDigits(String(year))} ${monthNames[month]} ${toNepaliDigits(String(days + 1))}`;
}

function formatNepaliNumber(value: string): string {
  const normalized = value.replace(/,/g, "");
  const formatted = Number(normalized).toLocaleString("en-IN");
  return toNepaliDigits(formatted);
}

function toNepaliDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => DEVANAGARI_DIGITS[Number(digit)]);
}

function toLatinDigits(value: string): string {
  return value.replace(/[०-९]/g, (digit) => String(DEVANAGARI_DIGITS.indexOf(digit)));
}

function cleanToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}@./:=_-]+|[^\p{L}\p{N}@./:=_-]+$/gu, "");
}

function isStructuredProtectedToken(input: string): boolean {
  return /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/\S+|\S+\.(?:[Pp][Dd][Ff]|[Dd][Oo][Cc][Xx]?|[Xx][Ll][Ss][Xx]?|[Pp][Pp][Tt][Xx]?|[Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Tt][Xx][Tt])|Form No\. \d{3,4}-\d{2,3}|ward-\d+|\d{10}|[A-Z]{2,})$/.test(input);
}
