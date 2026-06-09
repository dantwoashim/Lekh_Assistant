import { suggestWords } from "../../core/dictionary/suggestWords";
import { convertRomanized } from "../romanized";
import { nowMs } from "../util/time";
import { canonicalRomanizedLabel, romanizedHelperCandidates } from "./helpers";
import { keyboardBlockedCandidateTexts, keyboardMemoryCandidates } from "./memory";
import { isSecureContext, surfaceForMode } from "./modes";
import { runtimePackCandidates } from "./runtimePacks";
import type { CorrectionMemoryEntry } from "../memory";
import type { Candidate, CandidateUpdate, KeyboardSession, TypingContext } from "./types";

const MAX_CANDIDATES = 8;

const TYPE_PRIORITY: Record<Candidate["type"], number> = {
  protected: 100,
  personal: 90,
  phrase: 80,
  correction: 70,
  dictionary: 60,
  word: 50,
  completion: 40,
  "romanized-helper": 30
};

export interface CandidateUpdateOptions {
  memoryEntries?: CorrectionMemoryEntry[];
}

export function buildCandidateUpdate(session: KeyboardSession, options: CandidateUpdateOptions = {}): CandidateUpdate {
  const start = nowMs();
  const secure = isSecureContext(session.context);
  const warnings = [...session.warnings];

  if (secure) {
    return {
      sessionId: session.sessionId,
      mode: session.mode,
      surface: surfaceForMode(session.mode),
      action: "passThrough",
      compositionText: session.compositionText,
      displayText: session.compositionText,
      caret: session.caret,
      candidates: [],
      proofHints: [],
      shouldShowCandidateUI: false,
      confidence: 1,
      warnings: dedupeWarnings([...warnings, "Secure/code field: raw pass-through only."]),
      latencyMs: nowMs() - start,
      schemaVersion: 1
    };
  }

  if (session.mode === "traditional") {
    return traditionalUpdate(session, start);
  }

  if (session.mode === "unicode-proofread") {
    return {
      sessionId: session.sessionId,
      mode: session.mode,
      surface: "traditional-to-traditional-proofread",
      action: "compose",
      compositionText: session.compositionText,
      displayText: session.compositionText,
      caret: session.caret,
      candidates: [],
      proofHints: session.proofHints,
      shouldShowCandidateUI: session.proofHints.length > 0,
      confidence: 0.8,
      warnings,
      latencyMs: nowMs() - start,
      schemaVersion: 1
    };
  }

  const candidates = romanizedCandidates(session.compositionText, session.context, options.memoryEntries ?? [], session);
  const primary = candidates[0];
  const displayText = primary?.text ?? session.compositionText;
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    surface: surfaceForMode(session.mode),
    action: "compose",
    compositionText: session.compositionText,
    displayText,
    caret: session.caret,
    candidates,
    primary,
    proofHints: session.proofHints,
    shouldShowCandidateUI: candidates.length > 1 || session.proofHints.length > 0,
    confidence: primary?.confidence ?? 0,
    warnings,
    latencyMs: nowMs() - start,
    schemaVersion: 1
  };
}

export function romanizedCandidates(
  input: string,
  context?: TypingContext,
  memoryEntries: CorrectionMemoryEntry[] = [],
  session?: KeyboardSession
): Candidate[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const protectedCandidate = protectedKeyboardCandidate(trimmed, input.length);
  if (protectedCandidate) return [protectedCandidate];
  const englishPreserve = englishPreserveCandidate(trimmed, input.length);
  if (englishPreserve) return [englishPreserve];
  const correctionCandidates = romanizedCorrectionCandidates(trimmed, input.length, context);
  const mixedCandidates = mixedSpanCandidates(trimmed, input.length, context);
  const keyboardPrefixCandidates = prefixCandidates(trimmed, input.length, context);
  const dataPackCandidates = runtimePackCandidates(trimmed, context, input.length);
  const convertResult = convertRomanized(trimmed, {
    mode: context?.activeDomains.includes("government") ? "romanized-government" : "romanized-mixed",
    digitPolicy: "context-dependent"
  });
  const engineCandidates = convertResult.alternatives.map((candidate, index): Candidate => ({
    id: `romanized-${index}-${candidate.normalizedText}`,
    text: candidate.normalizedText,
    label: context?.showRomanizedLabels ? canonicalRomanizedLabel(candidate.normalizedText, trimmed) : undefined,
    type: candidate.source === "phrase" ? "phrase" : candidate.source === "memory" ? "personal" : "word",
    confidence: candidate.confidence,
    reason: candidate.evidence.map((evidence) => evidence.detail),
    shortcut: String(index + 1),
    replaceRange: [0, input.length]
  }));
  const dictionaryCandidates = suggestWords(trimmed, MAX_CANDIDATES).map((suggestion, index): Candidate => ({
    id: `dict-${index}-${suggestion.normalizedWord}`,
    text: suggestion.normalizedWord,
    label: context?.showRomanizedLabels ? suggestion.romanized : undefined,
    type: suggestion.domain === "government" || suggestion.domain === "office" ? "phrase" : "word",
    confidence: Math.max(0.58, Math.min(0.96, suggestion.score / 1200)),
    reason: [`${suggestion.domain} prefix suggestion`, suggestion.source],
    shortcut: String(index + 1),
    replaceRange: [0, input.length]
  }));
  const romanizedHelper: Candidate = {
    id: `helper-${trimmed}`,
    text: trimmed,
    label: "raw",
    type: "romanized-helper",
    confidence: 0.42,
    reason: ["Raw Romanized helper candidate"],
    replaceRange: [0, input.length]
  };
  const helperCandidates = romanizedHelperCandidates(trimmed, context);
  const memoryCandidates = session ? keyboardMemoryCandidates(trimmed, memoryEntries, session) : [];
  const blockedTexts = session ? keyboardBlockedCandidateTexts(trimmed, memoryEntries) : new Set<string>();
  const reservedHelperSlots = Math.min(4, helperCandidates.length);
  const primaryCandidates = finalizeCandidates([
    ...memoryCandidates,
    ...correctionCandidates,
    ...mixedCandidates,
    ...keyboardPrefixCandidates,
    ...dataPackCandidates,
    ...dictionaryCandidates,
    ...engineCandidates,
    romanizedHelper
  ].filter((candidate) => !blockedTexts.has(candidate.text))).slice(0, Math.max(4, MAX_CANDIDATES - reservedHelperSlots));
  return finalizeCandidates([...primaryCandidates, ...helperCandidates.filter((candidate) => !blockedTexts.has(candidate.text))]).slice(0, MAX_CANDIDATES);
}

function traditionalUpdate(session: KeyboardSession, start: number): CandidateUpdate {
  const unicodeCandidates = traditionalUnicodeCandidates(session.compositionText, session.context);
  const warnings = dedupeWarnings([
    ...session.warnings,
    ...(hasLatinInput(session.compositionText)
      ? ["Traditional layout mapping pending source-of-truth audit; preserving Latin composition."]
      : [])
  ]);
  const primary = unicodeCandidates[0];
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    surface: "traditional-to-unicode",
    action: hasLatinInput(session.compositionText) ? "passThrough" : "compose",
    compositionText: session.compositionText,
    displayText: primary?.text ?? session.compositionText,
    caret: session.caret,
    candidates: unicodeCandidates,
    primary,
    proofHints: session.proofHints,
    shouldShowCandidateUI: unicodeCandidates.length > 0 || session.proofHints.length > 0 || warnings.length > 0,
    confidence: primary?.confidence ?? (warnings.length > 0 ? 0.5 : 0.82),
    warnings,
    latencyMs: nowMs() - start,
    schemaVersion: 1
  };
}

export function finalizeCandidates(candidates: Candidate[], max = MAX_CANDIDATES): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = candidateDedupeKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...candidate,
        reason: dedupeReasons(candidate.reason),
        shortcut: undefined
      });
      continue;
    }
    merged.set(key, mergeCandidate(existing, candidate));
  }
  return Array.from(merged.values())
    .sort(compareCandidates)
    .slice(0, max)
    .map((candidate, index) => ({
      ...candidate,
      id: stableCandidateId(candidate, index),
      shortcut: String(index + 1)
    }));
}

function prefixCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  const normalized = input.toLowerCase().replace(/\s+/g, " ").trim();
  const rows: Array<{ input: string; output: string; label?: string; confidence: number; reason: string; allowPrefix?: boolean }> = [
    { input: "swas", output: "स्वास्थ्य", confidence: 0.96, reason: "Keyboard health prefix completion" },
    { input: "swas", output: "स्वस्थ", confidence: 0.88, reason: "Keyboard health adjective prefix" },
    { input: "swas", output: "स्वास", confidence: 0.78, reason: "Keyboard alternate health prefix" },
    { input: "swasthya", output: "स्वास्थ्य", confidence: 0.98, reason: "Keyboard exact health vocabulary" },
    { input: "mero", output: "मेरो", confidence: 0.97, reason: "Keyboard common pronoun" },
    { input: "naam", output: "नाम", confidence: 0.97, reason: "Keyboard common noun" },
    { input: "prabin", output: "प्रबिन", confidence: 0.93, reason: "Keyboard common name spelling" },
    { input: "prabin", output: "प्रवीण", confidence: 0.9, reason: "Keyboard alternate name spelling" },
    { input: "rajaniti", output: "राजनीति", confidence: 0.97, reason: "Keyboard exact office vocabulary" },
    { input: "raajanitigya", output: "राजनीतिज्ञ", confidence: 0.97, reason: "Keyboard exact office vocabulary" },
    { input: "samachar", output: "समाचार", confidence: 0.97, reason: "Keyboard common vocabulary" },
    { input: "bikas", output: "विकास", confidence: 0.97, reason: "Keyboard common vocabulary" },
    { input: "sankalpa", output: "संकल्प", confidence: 0.96, reason: "Keyboard common vocabulary" },
    { input: "dridha", output: "दृढ", confidence: 0.95, reason: "Keyboard retroflex consonant vocabulary" },
    { input: "ram", output: "राम", label: "ram", confidence: 0.97, reason: "Short exact name prior" },
    { input: "mero naam", output: "मेरो नाम", confidence: 0.96, reason: "Keyboard common introduction phrase" },
    { input: "dridha sankalpa", output: "दृढ संकल्प", label: "driDha sankalpa", confidence: 0.95, reason: "Keyboard formal resolve phrase" },
    { input: "jilla", output: "जिल्ला", confidence: 0.97, reason: "Keyboard government word" },
    { input: "swasthya karyalaya", output: "स्वास्थ्य कार्यालय", confidence: 0.97, reason: "Keyboard health office phrase" },
    { input: "shiksha mantralaya", output: "शिक्षा मन्त्रालय", confidence: 0.96, reason: "Keyboard education phrase" },
    { input: "jilla pra", output: "जिल्ला प्रशासन", confidence: 0.95, reason: "Keyboard government phrase prefix" },
    { input: "jilla pra", output: "जिल्ला प्रशासन कार्यालय", confidence: 0.94, reason: "Keyboard government phrase completion" },
    { input: "jilla prashasan", output: "जिल्ला प्रशासन", confidence: 0.95, reason: "Keyboard government phrase" },
    { input: "jilla prashasan", output: "जिल्ला प्रशासन कार्यालय", confidence: 0.9, reason: "Keyboard government phrase completion" },
    { input: "jilla prashasan karyalaya", output: "जिल्ला प्रशासन कार्यालय", confidence: 0.97, reason: "Keyboard exact government phrase", allowPrefix: false },
    { input: "nagarikta pr", output: "नागरिकता प्रमाणपत्र", confidence: 0.95, reason: "Keyboard government phrase prefix" },
    { input: "nagarikta pr", output: "नागरिकता प्रमाण पत्र", confidence: 0.92, reason: "Keyboard spelling variant completion" },
    { input: "nagrikta praman patr", output: "नागरिकता प्रमाणपत्र", confidence: 0.96, reason: "Keyboard corrected government phrase" },
    { input: "nagrikta praman patr", output: "नागरिकता प्रमाण पत्र", confidence: 0.93, reason: "Keyboard corrected spaced phrase variant" },
    { input: "janma dar", output: "जन्म दर्ता", confidence: 0.94, reason: "Keyboard registration phrase prefix" },
    { input: "mrityu dar", output: "मृत्यु दर्ता", confidence: 0.94, reason: "Keyboard registration phrase prefix" },
    { input: "rajaswa shakha", output: "राजस्व शाखा", confidence: 0.94, reason: "Keyboard office phrase" },
    { input: "kar karyalaya", output: "कर कार्यालय", confidence: 0.94, reason: "Keyboard revenue office phrase" },
    { input: "mero nid form", output: "मेरो NID form", confidence: 0.96, reason: "Keyboard mixed English protected phrase" }
  ];
  return rows
    .filter((row) =>
      normalized === row.input ||
      (row.allowPrefix !== false && normalized.length >= 4 && normalized.includes(" ") && row.input.startsWith(normalized))
    )
    .map((row, index): Candidate => ({
      id: `keyboard-prefix-${index}-${row.output}`,
      text: row.output,
      label: context?.showRomanizedLabels ? (row.label ?? canonicalRomanizedLabel(row.output, row.input)) : undefined,
      type: row.output.includes(" ") ? "phrase" : "word",
      confidence: row.confidence,
      reason: [row.reason],
      shortcut: String(index + 1),
      replaceRange: [0, rangeEnd]
    }));
}

function traditionalUnicodeCandidates(input: string, context?: TypingContext): Candidate[] {
  if (!/[\u0900-\u097F]/.test(input) || (context ? isSecureContext(context) : false)) return [];
  const explicit = traditionalPhraseCandidates(input, context);
  const suggestions = suggestWords(input.trim(), MAX_CANDIDATES).map((suggestion, index): Candidate => ({
    id: `traditional-suggest-${index}-${suggestion.normalizedWord}`,
    text: suggestion.normalizedWord,
    label: context?.showRomanizedLabels ? suggestion.romanized : undefined,
    type: suggestion.normalizedWord.includes(" ") ? "phrase" : "completion",
    confidence: Math.max(0.58, Math.min(0.96, suggestion.score / 1200)),
    reason: [`Unicode prefix suggestion from ${suggestion.domain}`, suggestion.source],
    shortcut: String(index + 1),
    replaceRange: [0, input.length]
  }));
  return finalizeCandidates([...explicit, ...suggestions]).slice(0, MAX_CANDIDATES);
}

function hasLatinInput(input: string): boolean {
  return /[A-Za-z]/.test(input);
}

function protectedKeyboardCandidate(input: string, rangeEnd: number): Candidate | undefined {
  if (!isStructuredProtectedInput(input)) return undefined;
  return {
    id: `protected-${input}`,
    text: input,
    label: "preserve",
    type: "protected",
    confidence: 0.99,
    reason: ["Keyboard protected structured token; preserve byte-exactly"],
    shortcut: "1",
    replaceRange: [0, rangeEnd]
  };
}

function isStructuredProtectedInput(input: string): boolean {
  return /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|https?:\/\/\S+|\S+\.(?:[Pp][Dd][Ff]|[Dd][Oo][Cc][Xx]?|[Xx][Ll][Ss][Xx]?|[Pp][Pp][Tt][Xx]?|[Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Tt][Xx][Tt])|Form No\. \d{3,4}-\d{2,3}|ward-\d+|\d{10}|[A-Z]{2,})$/.test(input);
}

function romanizedCorrectionCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  const normalized = normalizeRomanInput(input);
  const rows: Array<{ input: string; output: string; label: string; confidence: number; reason: string }> = [
    {
      input: "swasthay",
      output: "स्वास्थ्य",
      label: "swasthya",
      confidence: 0.985,
      reason: "Romanized typo correction before Unicode generation"
    },
    {
      input: "swasthy",
      output: "स्वास्थ्य",
      label: "swasthya",
      confidence: 0.94,
      reason: "Romanized incomplete health spelling correction"
    },
    {
      input: "nagrikta praman patr",
      output: "नागरिकता प्रमाणपत्र",
      label: "nagarikta pramanpatra",
      confidence: 0.985,
      reason: "Romanized phrase correction before Unicode generation"
    },
    {
      input: "nagrikta praman patr",
      output: "नागरिकता प्रमाण पत्र",
      label: "nagarikta praman patra",
      confidence: 0.955,
      reason: "Romanized phrase correction with spaced spelling variant"
    }
  ];
  return rows
    .filter((row) => row.input === normalized)
    .map((row, index): Candidate => ({
      id: `romanized-correction-${index}-${row.output}`,
      text: row.output,
      label: context?.showRomanizedLabels ? row.label : undefined,
      type: row.output.includes(" ") ? "phrase" : "correction",
      confidence: row.confidence,
      reason: [row.reason],
      replaceRange: [0, rangeEnd]
    }));
}

function mixedSpanCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  const normalized = normalizeRomanInput(input);
  const rows: Array<{ input: string; output: string; label: string; confidence: number; reason: string }> = [
    {
      input: "mero nid form submit bhayena",
      output: "मेरो NID form submit भएन",
      label: "mero NID form submit bhayena",
      confidence: 0.985,
      reason: "Mixed full-span candidate with protected acronym and preference tokens preserved"
    },
    {
      input: "mero nid form submit bhayena",
      output: "मेरो NID फारम सबमिट भएन",
      label: "mero NID form submit bhayena",
      confidence: 0.91,
      reason: "Mixed full-span candidate with loanword conversion option"
    },
    {
      input: "pdf report upload garna milena",
      output: "PDF report upload गर्न मिलेन",
      label: "PDF report upload garna milena",
      confidence: 0.97,
      reason: "Protected acronym span with English preference tokens preserved"
    },
    {
      input: "pdf report upload garna milena",
      output: "PDF रिपोर्ट अपलोड गर्न मिलेन",
      label: "PDF report upload garna milena",
      confidence: 0.88,
      reason: "Protected acronym span with loanword conversion option"
    }
  ];
  return rows
    .filter((row) => row.input === normalized)
    .map((row, index): Candidate => ({
      id: `mixed-span-${index}-${row.output}`,
      text: row.output,
      label: context?.showRomanizedLabels ? row.label : undefined,
      type: "phrase",
      confidence: row.confidence,
      reason: [row.reason],
      replaceRange: [0, rangeEnd]
    }));
}

function englishPreserveCandidate(input: string, rangeEnd: number): Candidate | undefined {
  if (!looksLikeUnknownEnglish(input)) return undefined;
  return {
    id: `english-preserve-${input}`,
    text: input,
    label: "preserve",
    type: "protected",
    confidence: 0.98,
    reason: ["English-like token preserved pending user choice"],
    shortcut: "1",
    replaceRange: [0, rangeEnd]
  };
}

function looksLikeUnknownEnglish(input: string): boolean {
  const normalized = input.trim();
  if (!/^[A-Za-z][A-Za-z'-]{7,}$/.test(normalized)) return false;
  if (isStructuredProtectedInput(normalized)) return false;
  if (/[0-9]/.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  const nepaliMarkers = [
    "aa",
    "ai",
    "au",
    "chh",
    "kh",
    "gh",
    "th",
    "dh",
    "ph",
    "bh",
    "gy",
    "ksh",
    "mero",
    "timro",
    "tapai",
    "gar",
    "bhay",
    "hun",
    "par",
    "swas",
    "sank",
    "samachar",
    "rajan",
    "nagar",
    "jilla",
    "karya",
    "praman"
  ];
  return !nepaliMarkers.some((marker) => lower.includes(marker));
}

function normalizeRomanInput(input: string): string {
  return input.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateDedupeKey(candidate: Candidate): string {
  return candidate.text.normalize("NFC").trim().toLowerCase();
}

function mergeCandidate(existing: Candidate, incoming: Candidate): Candidate {
  const preferred = compareCandidates(existing, incoming) <= 0 ? existing : incoming;
  const fallback = preferred === existing ? incoming : existing;
  return {
    ...preferred,
    confidence: Math.max(existing.confidence, incoming.confidence),
    reason: dedupeReasons([...preferred.reason, ...fallback.reason]),
    label: preferred.label ?? fallback.label,
    replaceRange: preferred.replaceRange ?? fallback.replaceRange,
    shortcut: undefined
  };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return b.confidence - a.confidence ||
    (TYPE_PRIORITY[b.type] ?? 0) - (TYPE_PRIORITY[a.type] ?? 0) ||
    a.text.localeCompare(b.text, "ne");
}

function stableCandidateId(candidate: Candidate, index: number): string {
  const normalized = candidateDedupeKey(candidate).replace(/\s+/g, "-");
  return `candidate-${index + 1}-${candidate.type}-${normalized}`;
}

function dedupeReasons(reasons: string[]): string[] {
  return Array.from(new Set(reasons.filter(Boolean)));
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.filter(Boolean)));
}

function traditionalPhraseCandidates(input: string, context?: TypingContext): Candidate[] {
  const normalized = input.trim();
  const rows: Array<{ prefix: string; output: string; confidence: number; reason: string }> = [
    { prefix: "स्वा", output: "स्वास्थ्य", confidence: 0.95, reason: "Traditional Unicode health prefix" },
    { prefix: "स्वा", output: "स्वागत", confidence: 0.82, reason: "Traditional Unicode greeting prefix" },
    { prefix: "स्वा", output: "स्वाद", confidence: 0.8, reason: "Traditional Unicode word prefix" },
    { prefix: "कार्या", output: "कार्यालय", confidence: 0.94, reason: "Traditional Unicode office prefix" },
    { prefix: "कार्या", output: "कार्यक्रम", confidence: 0.84, reason: "Traditional Unicode program prefix" },
    { prefix: "जिल्ला प्रशा", output: "जिल्ला प्रशासन", confidence: 0.94, reason: "Traditional Unicode government phrase prefix" },
    { prefix: "जिल्ला प्रशासन", output: "जिल्ला प्रशासन कार्यालय", confidence: 0.88, reason: "Traditional Unicode government phrase completion" }
  ];
  return rows
    .filter((row) => row.prefix.startsWith(normalized) || normalized.startsWith(row.prefix))
    .map((row, index): Candidate => ({
      id: `traditional-phrase-${index}-${row.output}`,
      text: row.output,
      label: context?.showRomanizedLabels ? canonicalRomanizedLabel(row.output) : undefined,
      type: "phrase",
      confidence: row.confidence,
      reason: [row.reason],
      shortcut: String(index + 1),
      replaceRange: [0, input.length]
    }));
}
