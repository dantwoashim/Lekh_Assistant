import type { Candidate, KeyboardSession } from "./types";

const FOLLOWUP_ROWS: Record<string, Array<{ text: string; confidence: number; reason: string }>> = {
  "जिल्ला": [
    { text: "प्रशासन", confidence: 0.86, reason: "common government phrase continuation" },
    { text: "कार्यालय", confidence: 0.76, reason: "office continuation" }
  ],
  "स्वास्थ्य": [
    { text: "कार्यालय", confidence: 0.86, reason: "common service phrase continuation" },
    { text: "सेवा", confidence: 0.78, reason: "common health phrase continuation" },
    { text: "मन्त्रालय", confidence: 0.74, reason: "government domain continuation" }
  ],
  "नेपाल": [
    { text: "सरकार", confidence: 0.84, reason: "common official phrase continuation" }
  ],
  "नागरिकता": [
    { text: "प्रमाणपत्र", confidence: 0.86, reason: "common document phrase continuation" },
    { text: "प्रमाण पत्र", confidence: 0.8, reason: "spaced spelling variant" }
  ],
  "शिक्षा": [
    { text: "मन्त्रालय", confidence: 0.84, reason: "education government phrase continuation" },
    { text: "कार्यालय", confidence: 0.72, reason: "office phrase continuation" }
  ],
  "जन्म": [
    { text: "दर्ता", confidence: 0.84, reason: "common civil-registration phrase continuation" }
  ],
  "मृत्यु": [
    { text: "दर्ता", confidence: 0.84, reason: "common civil-registration phrase continuation" }
  ]
};

export function nextWordCandidates(committedText: string, session: KeyboardSession): Candidate[] {
  if (!session.context.enableNextWordPrediction || session.context.secureInput) return [];
  const words = committedText.trim().split(/\s+/);
  const lastWord = words[words.length - 1] ?? "";
  const rows = FOLLOWUP_ROWS[lastWord] ?? [];
  return rows.slice(0, 4).map((row, index): Candidate => ({
    id: `followup-${index}-${lastWord}-${row.text}`,
    text: row.text,
    type: row.text.includes(" ") ? "phrase" : "completion",
    confidence: row.confidence,
    reason: [`Next-word baseline: ${row.reason}`],
    shortcut: String(index + 1),
    replaceRange: [0, 0]
  }));
}
