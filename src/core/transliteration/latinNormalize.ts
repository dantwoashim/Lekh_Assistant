const TECHNICAL_ENGLISH = new Set([
  "nid",
  "pdf",
  "excel",
  "word",
  "form",
  "field",
  "desk",
  "result",
  "mismatch",
  "old",
  "online",
  "payment",
  "budget",
  "screenshot",
  "clear",
  "browser",
  "cache",
  "school",
  "parent",
  "match",
  "ward",
  "library",
  "barcode",
  "class",
  "group",
  "case",
  "entry",
  "urgent",
  "submit",
  "verify",
  "name",
  "sms",
  "file",
  "folder",
  "copy",
  "link",
  "upload",
  "row",
  "draft",
  "final",
  "slow",
  "branch",
  "campus",
  "card",
  "meeting",
  "update",
  "check",
  "table",
  "voucher",
  "bank",
  "address",
  "biometrics",
  "status",
  "user",
  "candidate",
  "phrase",
  "detect",
  "wrong",
  "correct",
  "output",
  "minutes",
  "code",
  "scan",
  "report",
  "photo",
  "publish",
  "office",
  "system",
  "record",
  "data",
  "print",
  "save",
  "format",
  "sheet",
  "document",
  "doc",
  "docx",
  "id",
  "no",
  "number",
  "phone",
  "mobile",
  "passport",
  "ray",
  "xray",
  "date",
  "email",
  "url",
  "http",
  "https"
]);

const CANONICAL_ENGLISH = new Map([
  ["kc", "KC"],
  ["nid", "NID"],
  ["pdf", "PDF"],
  ["url", "URL"],
  ["id", "ID"]
]);

export function normalizeLatinInput(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeRomanizedToken(token: string): string {
  return token.normalize("NFKC").toLowerCase();
}

export function normalizeRomanizedTokenForParsing(token: string): string {
  const normalized = token.normalize("NFKC");
  return isPresentationTitleCase(normalized) ? normalized.toLowerCase() : normalized;
}

export function isLikelyEnglishToken(token: string): boolean {
  if (token === "x" || token === "X") return true;
  if (/^https?:\/\//i.test(token)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)) return true;
  if (/^[A-Z0-9]{2,}$/.test(token)) return true;
  return TECHNICAL_ENGLISH.has(token.toLowerCase());
}

export function canonicalEnglishToken(token: string): string {
  return CANONICAL_ENGLISH.get(token.toLowerCase()) ?? token;
}

export function hasIntentionalCapitalPhoneme(token: string): boolean {
  const normalized = token.normalize("NFKC");
  if (isPresentationTitleCase(normalized)) return false;
  return /Sh|Th|Dh|[TDNSL]/.test(normalized);
}

function isPresentationTitleCase(token: string): boolean {
  return /^[A-Z][a-z]+$/.test(token);
}
