import { suggestWords } from "../../core/dictionary/suggestWords";
import engineContract from "../../../data/engine/lekh-engine-contract.v1.json";
import tokenCandidatePack from "../../../data/engine/lekh-token-candidates.v1.json";
import { convertRomanized } from "../romanized";
import { nowMs } from "../util/time";
import { sha256Hex } from "../util/sha256";
import { contextualPredictionCandidates } from "./contextPredictor";
import { canonicalRomanizedLabel, romanizedHelperCandidates } from "./helpers";
import { keyboardBlockedCandidateTexts, keyboardMemoryCandidates } from "./memory";
import { isSecureContext, surfaceForMode } from "./modes";
import { inlineCompletionForSession } from "./ngramLanguageModel";
import { runtimePackCandidates } from "./runtimePacks";
import { classifyMixedLatinToken, convertSmartRomanizedToken, smartTransformCandidates } from "./smartTransforms";
import type { CorrectionMemoryEntry } from "../memory";
import type { Candidate, CandidateUpdate, KeyboardSession, TypingContext } from "./types";

const MAX_CANDIDATES = engineContract.candidatePolicy.maximumVisible;

type PrefixCandidateRow = {
  input: string;
  output: string;
  label?: string;
  confidence: number;
  reason: string;
  allowPrefix?: boolean;
};

const SHARED_TOKEN_ROWS: PrefixCandidateRow[] = tokenCandidatePack.rows.flatMap((row) =>
  row.outputs.map((output) => ({
    input: row.input,
    output: output.text,
    confidence: output.confidence,
    reason: `Shared ${tokenCandidatePack.id} deterministic token candidate`,
    allowPrefix: true
  }))
);
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

const NEPAL_MIXED_BRANDS = new Set([
  "esewa",
  "khalti",
  "ime",
  "ntc",
  "ncell",
  "wi-fi",
  "wifi",
  "tiktok",
  "whatsapp",
  "viber"
]);

const NEPAL_MIXED_CONTEXT_TOKENS = new Set([
  "account",
  "email",
  "id",
  "login",
  "message",
  "password",
  "recharge",
  "username"
]);

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
      warnings: dedupeWarnings([...warnings, "Secure/uncertain field: raw pass-through only."]),
      latencyMs: nowMs() - start,
      schemaVersion: 1
    };
  }

  if (
    session.mode === "traditional" ||
    session.mode === "traditional-traditional" ||
    session.mode === "traditional-romanized"
  ) {
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

  const baseCandidates = romanizedCandidates(session.compositionText, session.context, options.memoryEntries ?? [], session);
  const candidates = session.mode === "romanized-romanized"
    ? romanizedTargetCandidates(baseCandidates, session.compositionText)
    : baseCandidates;
  const primary = candidates[0];
  const displayText = primary?.text ?? session.compositionText;
  const inlineCompletion = inlineCompletionForSession(session, primary);
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    surface: surfaceForMode(session.mode),
    action: "compose",
    compositionText: session.compositionText,
    displayText,
    caret: session.caret,
    candidates,
    ...(primary ? { primary } : {}),
    ...(inlineCompletion ? { inlineCompletion } : {}),
    proofHints: session.proofHints,
    shouldShowCandidateUI: candidates.length > 0 || session.proofHints.length > 0,
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
  const smartCandidates = smartTransformCandidates(input, input.length, context);
  const correctionCandidates = romanizedCorrectionCandidates(trimmed, input.length, context);
  const mixedCandidates = mixedSpanCandidates(trimmed, input.length, context);
  const contextCandidates = contextualPredictionCandidates(trimmed, input.length, context);
  const keyboardPrefixCandidates = prefixCandidates(trimmed, input.length, context);
  const activeWordCompletions = keyboardPrefixCandidates.length > 0
    ? []
    : activeRomanizedWordCompletionCandidates(trimmed, input.length, context);
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
  const fallbackCandidate = romanizedLiteralFallbackCandidate(trimmed, input.length, convertResult.normalizedOutput, context);
  const romanizedHelper: Candidate = {
    id: `helper-${trimmed}`,
    text: trimmed,
    label: "raw",
    type: "romanized-helper",
    confidence: 0.42,
    reason: ["Raw Romanized helper candidate"],
    replaceRange: [0, input.length]
  };
  const helperCandidates = [
    ...romanizedNormalizationHelperCandidates(trimmed, input.length, context),
    ...(keyboardPrefixCandidates.length > 0 ? [] : activeRomanizedHelperCompletionCandidates(trimmed, input.length, context)),
    ...romanizedHelperCandidates(trimmed, context)
  ];
  const personalizationEnabled = context?.enablePersonalization !== false;
  const memoryCandidates = session && personalizationEnabled
    ? keyboardMemoryCandidates(trimmed, memoryEntries, session)
    : [];
  const blockedTexts = session && personalizationEnabled
    ? keyboardBlockedCandidateTexts(trimmed, memoryEntries)
    : new Set<string>();
  const activeTokenSafe = (candidate: Candidate) =>
    trimmed.includes(" ") ||
    /^[@:]{2}/.test(trimmed) ||
    !candidate.text.trim().includes(" ");
  const reservedHelperSlots = Math.min(4, helperCandidates.length);
  const primaryCandidates = finalizeCandidates([
    ...memoryCandidates,
    ...smartCandidates,
    ...contextCandidates,
    ...correctionCandidates,
    ...mixedCandidates,
    ...keyboardPrefixCandidates,
    ...activeWordCompletions,
    ...dataPackCandidates,
    ...dictionaryCandidates,
    ...engineCandidates,
    ...(fallbackCandidate ? [fallbackCandidate] : []),
    romanizedHelper
  ].filter((candidate) => !blockedTexts.has(candidate.text) && activeTokenSafe(candidate))).slice(0, Math.max(4, MAX_CANDIDATES - reservedHelperSlots));
  return finalizeCandidates([
    ...primaryCandidates,
    ...helperCandidates.filter((candidate) => !blockedTexts.has(candidate.text) && activeTokenSafe(candidate))
  ]).slice(0, MAX_CANDIDATES);
}

function traditionalUpdate(session: KeyboardSession, start: number): CandidateUpdate {
  // Romanized helper output is carried through the internal candidate label.
  // It is semantic data in this mode, not an optional presentation preference.
  // Without this adapter-level override the default `showRomanizedLabels=false`
  // context produced an empty Traditional -> Romanized candidate list.
  const candidateContext = session.mode === "traditional-romanized"
    ? { ...session.context, showRomanizedLabels: true }
    : session.context;
  const baseCandidates = traditionalUnicodeCandidates(session.compositionText, candidateContext);
  const unicodeCandidates = session.mode === "traditional-romanized"
    ? traditionalRomanizedTargetCandidates(baseCandidates)
    : baseCandidates;
  const warnings = dedupeWarnings([
    ...session.warnings,
    ...(hasLatinInput(session.compositionText)
      ? ["Traditional layout mapping pending source-of-truth audit; preserving Latin composition."]
      : [])
  ]);
  const primary = unicodeCandidates[0];
  const displayText = primary?.text ?? session.compositionText;
  const inlineCompletion = inlineCompletionForSession(session, primary);
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    surface: surfaceForMode(session.mode),
    action: hasLatinInput(session.compositionText) ? "passThrough" : "compose",
    compositionText: session.compositionText,
    displayText,
    caret: session.caret,
    candidates: unicodeCandidates,
    ...(primary ? { primary } : {}),
    ...(inlineCompletion ? { inlineCompletion } : {}),
    proofHints: session.proofHints,
    shouldShowCandidateUI: unicodeCandidates.length > 0 || session.proofHints.length > 0 || warnings.length > 0,
    confidence: primary?.confidence ?? (warnings.length > 0 ? 0.5 : 0.82),
    warnings,
    latencyMs: nowMs() - start,
    schemaVersion: 1
  };
}

function romanizedTargetCandidates(candidates: Candidate[], raw: string): Candidate[] {
  return finalizeCandidates(candidates.flatMap((candidate): Candidate[] => {
    const text = candidate.type === "romanized-helper"
      ? candidate.text
      : candidate.label && /[a-z]/i.test(candidate.label)
        ? candidate.label
        : "";
    if (!text || text.trim() === raw.trim()) return [];
    return [{
      ...candidate,
      id: `romanized-target-${candidate.id}`,
      text,
      label: undefined,
      type: "romanized-helper"
    }];
  }));
}

function traditionalRomanizedTargetCandidates(candidates: Candidate[]): Candidate[] {
  return finalizeCandidates(candidates.flatMap((candidate): Candidate[] => {
    if (!candidate.label || !/[a-z]/i.test(candidate.label)) return [];
    return [{
      ...candidate,
      id: `traditional-romanized-target-${candidate.id}`,
      text: candidate.label,
      label: undefined,
      type: "romanized-helper"
    }];
  }));
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
    .map((candidate, index) => canonicalCandidate(candidate, index));
}

function canonicalCandidate(candidate: Candidate, index: number): Candidate {
  const canonical: Candidate = {
    ...candidate,
    id: candidateSelectionId(candidate),
    shortcut: String(index + 1)
  };
  if (canonical.label === undefined) delete canonical.label;
  if (canonical.replaceRange === undefined) delete canonical.replaceRange;
  return canonical;
}

function prefixCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  const normalized = input.toLowerCase().replace(/\s+/g, " ").trim();
  const legacyRows: PrefixCandidateRow[] = [
    { input: "swas", output: "स्वास्थ्य", confidence: 0.96, reason: "Keyboard health prefix completion" },
    { input: "swas", output: "स्वस्थ", confidence: 0.88, reason: "Keyboard health adjective prefix" },
    { input: "swas", output: "स्वास", confidence: 0.78, reason: "Keyboard alternate health prefix" },
    { input: "kasto cha", output: "कस्तो छ", confidence: 0.97, reason: "Casual greeting phrase" },
    { input: "k cha", output: "के छ", confidence: 0.96, reason: "Casual greeting phrase" },
    { input: "ke cha", output: "के छ", confidence: 0.96, reason: "Casual greeting phrase" },
    { input: "k xa", output: "के छ", confidence: 0.95, reason: "Casual x spelling greeting phrase", allowPrefix: false },
    { input: "k gardai chau", output: "के गर्दै छौ", confidence: 0.96, reason: "Casual activity question" },
    { input: "ke gardai chau", output: "के गर्दै छौ", confidence: 0.96, reason: "Casual activity question" },
    { input: "k gardai xau", output: "के गर्दै छौ", confidence: 0.95, reason: "Casual x spelling activity question" },
    { input: "tapai kahaa hunuhuncha", output: "तपाईं कहाँ हुनुहुन्छ", confidence: 0.95, reason: "Polite location phrase" },
    { input: "mero ke cha", output: "मेरो के छ अवस्था", label: "mero ke cha awastha", confidence: 0.93, reason: "Casual status sentence completion", allowPrefix: false },
    { input: "mero k cha", output: "मेरो के छ अवस्था", label: "mero ke cha awastha", confidence: 0.92, reason: "Casual shorthand status sentence completion", allowPrefix: false },
    { input: "mero k xa", output: "मेरो के छ अवस्था", label: "mero ke cha awastha", confidence: 0.92, reason: "Casual x spelling status sentence completion", allowPrefix: false },
    { input: "ke cha", output: "के छ अवस्था", label: "ke cha awastha", confidence: 0.91, reason: "Casual status phrase completion", allowPrefix: false },
    { input: "k cha", output: "के छ अवस्था", label: "ke cha awastha", confidence: 0.9, reason: "Casual shorthand status phrase completion", allowPrefix: false },
    { input: "k xa", output: "के छ अवस्था", label: "ke cha awastha", confidence: 0.9, reason: "Casual x spelling status phrase completion", allowPrefix: false },
    { input: "mero k xa awastha", output: "मेरो के छ अवस्था", confidence: 0.96, reason: "Casual mixed shorthand status phrase", allowPrefix: false },
    { input: "mero ke cha awastha", output: "मेरो के छ अवस्था", confidence: 0.96, reason: "Casual status phrase", allowPrefix: false },
    { input: "mero k cha awastha", output: "मेरो के छ अवस्था", confidence: 0.95, reason: "Casual shorthand status phrase", allowPrefix: false },
    { input: "k xa awastha", output: "के छ अवस्था", confidence: 0.95, reason: "Casual shorthand status phrase", allowPrefix: false },
    { input: "ke cha awastha", output: "के छ अवस्था", confidence: 0.95, reason: "Casual status phrase", allowPrefix: false },
    { input: "ghar jane", output: "घर जाने", confidence: 0.95, reason: "Casual movement phrase" },
    { input: "ma aaudai xu", output: "म आउँदै छु", confidence: 0.96, reason: "Casual arrival phrase" },
    { input: "ma audai xu", output: "म आउँदै छु", confidence: 0.95, reason: "Casual arrival phrase spelling" },
    { input: "timi kaha chau", output: "तिमी कहाँ छौ", confidence: 0.95, reason: "Casual location question phrase" },
    { input: "timi kahaa chau", output: "तिमी कहाँ छौ", confidence: 0.94, reason: "Casual location question long-vowel phrase" },
    { input: "ramro lagyo", output: "राम्रो लाग्यो", confidence: 0.97, reason: "Casual reaction phrase" },
    { input: "maya lagcha", output: "माया लाग्छ", confidence: 0.95, reason: "Casual feeling phrase" },
    { input: "bhok lagyo", output: "भोक लाग्यो", confidence: 0.95, reason: "Casual feeling phrase" },
    { input: "sanchai chau", output: "सञ्चै छौ", confidence: 0.94, reason: "Casual wellness phrase" },
    { input: "thik cha", output: "ठीक छ", confidence: 0.96, reason: "Casual acknowledgement phrase" },
    { input: "thikai cha", output: "ठीकै छ", confidence: 0.95, reason: "Casual acknowledgement phrase" },
    { input: "dherai dhanyabad", output: "धेरै धन्यवाद", confidence: 0.96, reason: "Casual gratitude phrase" },
    { input: "mero naam", output: "मेरो नाम", confidence: 0.96, reason: "Keyboard common introduction phrase" },
    { input: "dridha sankalpa", output: "दृढ संकल्प", label: "driDha sankalpa", confidence: 0.95, reason: "Keyboard formal resolve phrase" },
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
    { input: "janma", output: "जन्म", confidence: 0.96, reason: "Keyboard exact civil-registration word" },
    { input: "janma dar", output: "जन्म दर्ता", confidence: 0.94, reason: "Keyboard registration phrase prefix" },
    { input: "mrityu", output: "मृत्यु", confidence: 0.96, reason: "Keyboard exact civil-registration word" },
    { input: "mrityu dar", output: "मृत्यु दर्ता", confidence: 0.94, reason: "Keyboard registration phrase prefix" },
    { input: "rajaswa shakha", output: "राजस्व शाखा", confidence: 0.94, reason: "Keyboard office phrase" },
    { input: "kar karyalaya", output: "कर कार्यालय", confidence: 0.94, reason: "Keyboard revenue office phrase" },
    { input: "mero nid form", output: "मेरो NID form", confidence: 0.96, reason: "Keyboard mixed English protected phrase" }
  ];
  const rows = [
    ...SHARED_TOKEN_ROWS,
    ...legacyRows
  ];
  return rows
    .filter((row) =>
      normalized === row.input ||
      (row.allowPrefix !== false && normalized.length >= 1 && row.input.startsWith(normalized)) ||
      (row.allowPrefix !== false && normalized.length >= 4 && normalized.includes(" ") && row.input.startsWith(normalized))
    )
    .map((row, index): Candidate => {
      const exactMatch = normalized === row.input;
      const phraseBeforeBoundary = !exactMatch && row.input.includes(" ") && !normalized.includes(" ");
      return {
      id: `keyboard-prefix-${index}-${row.output}`,
      text: row.output,
      label: context?.showRomanizedLabels ? (row.label ?? canonicalRomanizedLabel(row.output, row.input)) : undefined,
      type: row.output.includes(" ") ? "phrase" : "word",
      confidence: phraseBeforeBoundary ? Math.min(row.confidence, 0.76) : row.confidence,
      reason: phraseBeforeBoundary ? [row.reason, "Phrase completion held below exact word until phrase boundary is typed"] : [row.reason],
      shortcut: String(index + 1),
      replaceRange: [0, rangeEnd]
    };
  });
}

function traditionalUnicodeCandidates(input: string, context?: TypingContext): Candidate[] {
  if (!/[\u0900-\u097F]/.test(input) || (context ? isSecureContext(context) : false)) return [];
  const explicit = traditionalPhraseCandidates(input, context);
  const activeWordCompletions = activeTraditionalWordCompletionCandidates(input, context);
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
  const activeTokenSafe = (candidate: Candidate) =>
    input.trim().includes(" ") || !candidate.text.trim().includes(" ");
  return finalizeCandidates(
    [...explicit, ...activeWordCompletions, ...suggestions].filter(activeTokenSafe)
  ).slice(0, MAX_CANDIDATES);
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
  const curated = rows
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
  const forcedBrandCandidate = forcedNepalBrandMixedCandidate(input, rangeEnd, context);
  return [...curated, ...(forcedBrandCandidate ? [forcedBrandCandidate] : []), ...genericMixedPolicyCandidates(input, rangeEnd, context)];
}

function forcedNepalBrandMixedCandidate(input: string, rangeEnd: number, context?: TypingContext): Candidate | undefined {
  if (!input.includes(" ")) return undefined;
  const parts = input.split(/(\s+)/);
  let previousToken = "";
  let hasBrandTrigger = false;
  const text = parts.map((part) => {
    if (/^\s+$/.test(part)) return part;
    const visible = cleanMixedToken(part);
    const lower = visible.toLowerCase();
    const preserve =
      NEPAL_MIXED_BRANDS.has(lower) ||
      NEPAL_MIXED_CONTEXT_TOKENS.has(lower) ||
      (lower === "pay" && previousToken === "ime") ||
      /^[A-Z]{2,}$/.test(visible);
    if (NEPAL_MIXED_BRANDS.has(lower) || (lower === "pay" && previousToken === "ime")) {
      hasBrandTrigger = true;
    }
    previousToken = lower;
    return preserve ? part : convertSmartRomanizedToken(part, context);
  }).join("").trim();

  if (!hasBrandTrigger || !text || text === input.trim()) return undefined;
  return {
    id: `mixed-nepal-brand-preserve-${text}`,
    text,
    label: context?.showRomanizedLabels ? input : undefined,
    type: "protected",
    confidence: 0.965,
    reason: ["Nepal wallet, telco, or messaging token preserved locally"],
    replaceRange: [0, rangeEnd]
  };
}

function genericMixedPolicyCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  if (!input.includes(" ")) return [];
  const parts = input.split(/(\s+)/);
  let hasPolicyToken = false;
  let convertiblePreferenceToken = false;
  const seenTokens: string[] = [];
  const policies = parts.map((part) => {
    if (/^\s+$/.test(part)) return undefined;
    const policy = mixedTokenPolicy(part, seenTokens);
    const cleaned = mixedPolicyVisibleText(part, policy);
    if (cleaned) seenTokens.push(cleaned.toLowerCase());
    return policy;
  });

  const preserved = parts.map((part, index) => {
    if (/^\s+$/.test(part)) return part;
    const policy = policies[index] ?? mixedTokenPolicy(part, []);
    if (policy.kind === "protected" || policy.kind === "preference") hasPolicyToken = true;
    if (policy.kind === "preference" && policy.converted) convertiblePreferenceToken = true;
    if (policy.kind === "protected") return policy.text ?? part;
    if (policy.kind === "preference") return part;
    return convertSmartRomanizedToken(part, context);
  }).join("").trim();

  if (!hasPolicyToken || !preserved || preserved === input.trim()) return [];

  const candidates: Candidate[] = [{
    id: `mixed-policy-preserve-${preserved}`,
    text: preserved,
    label: context?.showRomanizedLabels ? input : undefined,
    type: "protected",
    confidence: 0.94,
    reason: ["Mixed Nepali-English policy candidate with protected/preference tokens preserved"],
    replaceRange: [0, rangeEnd]
  }];

  if (convertiblePreferenceToken) {
    const converted = parts.map((part, index) => {
      if (/^\s+$/.test(part)) return part;
      const policy = policies[index] ?? mixedTokenPolicy(part, []);
      if (policy.kind === "protected") return policy.text ?? part;
      if (policy.kind === "preference" && policy.converted) return policy.converted;
      return convertSmartRomanizedToken(part, context);
    }).join("").trim();
    if (converted && converted !== preserved) {
      candidates.push({
        id: `mixed-policy-convert-${converted}`,
        text: converted,
        label: context?.showRomanizedLabels ? input : undefined,
        type: "phrase",
        confidence: 0.84,
        reason: ["Mixed Nepali-English policy candidate with preference loanwords converted"],
        replaceRange: [0, rangeEnd]
      });
    }
  }

  return candidates;
}

function mixedTokenPolicy(token: string, leftTokens: string[]): ReturnType<typeof classifyMixedLatinToken> {
  return classifyMixedLatinToken(token, leftTokens);
}

function mixedPolicyVisibleText(token: string, policy: ReturnType<typeof classifyMixedLatinToken>): string {
  if (policy.kind === "protected" && policy.text) return policy.text;
  return cleanMixedToken(token);
}

function cleanMixedToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}@./:=_-]+|[^\p{L}\p{N}@./:=_-]+$/gu, "");
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

function activeRomanizedWordCompletionCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  const active = trailingRomanizedToken(input);
  if (!active) return [];
  if (shouldDeferSingleLetterToContext(active.prefix, active.token)) return [];
  const suggestions = suggestWords(active.token, MAX_CANDIDATES);
  if (suggestions.length === 0) return [];
  const unicodePrefix = convertRomanizedPrefix(active.prefix, context);
  return suggestions.map((suggestion, index): Candidate => {
    const romanizedFullText = `${active.prefix}${suggestion.romanized ?? active.token}`.trim();
    const unicodeFullText = `${unicodePrefix}${suggestion.normalizedWord}`.trim();
    return {
      id: `active-romanized-${index}-${unicodeFullText}`,
      text: unicodeFullText,
      label: context?.showRomanizedLabels ? romanizedFullText : undefined,
      type: unicodeFullText.includes(" ") ? "phrase" : "completion",
      confidence: active.token.length === 1
        ? Math.max(0.74, Math.min(0.9, suggestion.score / 1200))
        : Math.max(0.82, Math.min(0.95, suggestion.score / 1200)),
      reason: [`Active Romanized token completion from ${suggestion.domain}`, suggestion.source],
      replaceRange: [0, rangeEnd]
    };
  });
}

function activeRomanizedHelperCompletionCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  if (!helpersEnabledForContext(context)) return [];
  const active = trailingRomanizedToken(input);
  if (!active) return [];
  if (shouldDeferSingleLetterToContext(active.prefix, active.token)) return [];
  return suggestWords(active.token, MAX_CANDIDATES)
    .filter((suggestion) => suggestion.romanized)
    .map((suggestion, index): Candidate => ({
      id: `active-romanized-helper-${index}-${active.prefix}${suggestion.romanized}`,
      text: `${active.prefix}${suggestion.romanized}`.trim(),
      label: suggestion.normalizedWord,
      type: "romanized-helper",
      confidence: active.token.length === 1 ? 0.62 : Math.max(0.68, Math.min(0.9, suggestion.score / 1400)),
      reason: [`Active Romanized helper completion from ${suggestion.domain}`, suggestion.source],
      replaceRange: [0, rangeEnd]
    }));
}

function shouldDeferSingleLetterToContext(prefix: string, token: string): boolean {
  return Boolean(prefix.trim()) && token.length === 1 && token.toLowerCase() === "x";
}

function romanizedNormalizationHelperCandidates(input: string, rangeEnd: number, context?: TypingContext): Candidate[] {
  if (!helpersEnabledForContext(context)) return [];
  const normalized = normalizeRomanInput(input);
  if (!normalized || !/[a-z]/.test(normalized)) return [];
  const tokenMap: Record<string, string> = {
    k: "ke",
    xa: "cha",
    xau: "chau",
    xu: "chu",
    xaina: "chaina",
    hunxa: "huncha",
    parxa: "parcha",
    garxu: "garchu",
    paxi: "pachi",
    voli: "bholi",
    vayo: "bhayo",
    vayena: "bhayena",
    malaai: "malai",
    kahaa: "kaha",
    audai: "aaudai",
    aja: "aaja",
    abastha: "awastha"
  };
  const helper = normalized.split(" ").map((token) => tokenMap[token] ?? token).join(" ");
  if (helper === normalized) return [];
  const unicode = convertRomanized(helper, {
    mode: context?.activeDomains.includes("government") ? "romanized-government" : "romanized-mixed",
    digitPolicy: "context-dependent"
  }).normalizedOutput;
  return [{
    id: `romanized-normalized-helper-${helper}`,
    text: helper,
    label: unicode,
    type: "romanized-helper",
    confidence: 0.82,
    reason: ["Casual Romanized spelling normalization helper"],
    replaceRange: [0, rangeEnd]
  }];
}

function romanizedLiteralFallbackCandidate(input: string, rangeEnd: number, output: string, context?: TypingContext): Candidate | undefined {
  const normalizedOutput = output.trim();
  if (!normalizedOutput) return undefined;
  if (normalizedOutput === input && !/[\u0900-\u097F]/.test(normalizedOutput)) return undefined;
  return {
    id: `romanized-fallback-${normalizedOutput}`,
    text: normalizedOutput,
    label: context?.showRomanizedLabels ? input : undefined,
    type: normalizedOutput.includes(" ") ? "phrase" : "word",
    confidence: 0.52,
    reason: ["Live Romanized transliteration fallback"],
    replaceRange: [0, rangeEnd]
  };
}

function activeTraditionalWordCompletionCandidates(input: string, context?: TypingContext): Candidate[] {
  const active = trailingDevanagariToken(input);
  if (!active) return [];
  return suggestWords(active.token, MAX_CANDIDATES).map((suggestion, index): Candidate => {
    const text = `${active.prefix}${suggestion.normalizedWord}`.trim();
    return {
      id: `active-traditional-${index}-${text}`,
      text,
      label: context?.showRomanizedLabels ? traditionalRomanizedLabel(active.prefix, suggestion.romanized) : undefined,
      type: text.includes(" ") ? "phrase" : "completion",
      confidence: active.token.length === 1 ? 0.78 : Math.max(0.82, Math.min(0.95, suggestion.score / 1200)),
      reason: [`Active Traditional token completion from ${suggestion.domain}`, suggestion.source],
      replaceRange: [0, input.length]
    };
  });
}

function trailingRomanizedToken(input: string): { prefix: string; token: string } | undefined {
  const match = input.match(/[A-Za-z]+$/);
  if (!match) return undefined;
  const token = match[0];
  return { prefix: input.slice(0, input.length - token.length), token };
}

function trailingDevanagariToken(input: string): { prefix: string; token: string } | undefined {
  const match = input.match(/[\u0900-\u097F]+$/);
  if (!match) return undefined;
  const token = match[0];
  return { prefix: input.slice(0, input.length - token.length), token };
}

function convertRomanizedPrefix(prefix: string, context?: TypingContext): string {
  if (!prefix) return "";
  const trailingWhitespace = prefix.match(/\s*$/)?.[0] ?? "";
  const core = prefix.slice(0, prefix.length - trailingWhitespace.length);
  if (!core) return trailingWhitespace;
  return `${convertRomanized(core, {
    mode: context?.activeDomains.includes("government") ? "romanized-government" : "romanized-mixed",
    digitPolicy: "context-dependent"
  }).normalizedOutput}${trailingWhitespace}`;
}

function traditionalRomanizedLabel(prefix: string, romanized?: string): string | undefined {
  if (!romanized) return undefined;
  const prefixLabel = prefix
    .split(/(\s+)/)
    .map((part) => {
      if (!/[\u0900-\u097F]/.test(part)) return part;
      return canonicalRomanizedLabel(part, part);
    })
    .join("");
  return `${prefixLabel}${romanized}`.trim();
}

function helpersEnabledForContext(context?: TypingContext): boolean {
  return Boolean(
    context?.mode === "diagnostic" ||
    context?.enabledSurfaces.includes("romanized-to-romanized") ||
    context?.enabledSurfaces.includes("romanized-to-unicode-with-labels")
  );
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

function candidateSelectionId(candidate: Candidate): string {
  const commitIdentity = JSON.stringify([
    "lekh-candidate-selection-v1",
    engineContract.schemaVersion,
    candidate.type,
    candidate.text.normalize("NFC"),
    candidate.replaceRange ?? null
  ]);
  return `candidate-${sha256Hex(commitIdentity).slice(0, 32)}`;
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
