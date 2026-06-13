const EQUIVALENCE_GROUPS = [
  ["aa", "a"],
  ["ee", "i"],
  ["ii", "i"],
  ["oo", "u"],
  ["uu", "u"],
  ["chh", "ch"],
  ["chh", "x"],
  ["ch", "x"],
  ["sh", "s"],
  ["ṣ", "s"],
  ["w", "v"],
  ["b", "v"],
  ["t", "ṭ"],
  ["d", "ḍ"]
] as const;

const DIRECT_TOKEN_CANONICAL: Record<string, string> = {
  gharmaa: "gharma",
  "ghar maa": "gharma",
  chha: "cha",
  xa: "cha",
  chhaina: "chaina",
  xaina: "chaina",
  chhan: "chan",
  xan: "chan",
  chhu: "chu",
  xu: "chu",
  chhau: "chau",
  xau: "chau",
  hunxa: "huncha",
  parxa: "parcha",
  garxa: "garcha",
  garxu: "garchu",
  vato: "bato",
  baato: "bato",
  bato: "bato"
};

export interface RomanizationToleranceMatch {
  distance: number;
  similarity: number;
  reason: string;
}

export function normalizeRomanizedLoose(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function romanizedCanonicalKey(value: string): string {
  const loose = normalizeRomanizedLoose(value);
  if (DIRECT_TOKEN_CANONICAL[loose]) return DIRECT_TOKEN_CANONICAL[loose];
  return loose
    .replace(/\s+(maa|ma)$/g, "ma")
    .replace(/aa/g, "a")
    .replace(/ee|ii/g, "i")
    .replace(/oo|uu/g, "u")
    .replace(/chh/g, "ch")
    .replace(/x/g, "ch")
    .replace(/sh/g, "s")
    .replace(/w/g, "v")
    .replace(/\s+/g, "");
}

export function romanizedToleranceKeys(value: string): string[] {
  const loose = normalizeRomanizedLoose(value);
  const canonical = romanizedCanonicalKey(value);
  const collapsed = loose.replace(/\s+/g, "");
  const keys = new Set([loose, collapsed, canonical]);
  for (const [left, right] of EQUIVALENCE_GROUPS) {
    if (canonical.includes(left)) keys.add(canonical.split(left).join(right));
    if (canonical.includes(right)) keys.add(canonical.split(right).join(left));
  }
  return [...keys].filter(Boolean);
}

export function romanizedToleranceMatch(input: string, candidate: string): RomanizationToleranceMatch | undefined {
  const inputCanonical = romanizedCanonicalKey(input);
  const candidateCanonical = romanizedCanonicalKey(candidate);
  if (!inputCanonical || !candidateCanonical) return undefined;
  if (candidateCanonical === inputCanonical || candidateCanonical.startsWith(inputCanonical)) {
    return { distance: 0, similarity: 1, reason: "romanization canonical prefix" };
  }
  const distance = weightedRomanizedDistance(inputCanonical, candidateCanonical);
  const maxLength = Math.max(inputCanonical.length, candidateCanonical.length, 1);
  const similarity = 1 - distance / maxLength;
  const threshold = inputCanonical.length <= 4 ? 0.84 : 0.78;
  return similarity >= threshold
    ? { distance, similarity, reason: "weighted romanization tolerance" }
    : undefined;
}

function weightedRomanizedDistance(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = dp[i - 1][j - 1] + substitutionCost(a[i - 1], b[j - 1]);
      const deletion = dp[i - 1][j] + deletionCost(a[i - 1]);
      const insertion = dp[i][j - 1] + deletionCost(b[j - 1]);
      dp[i][j] = Math.min(substitution, deletion, insertion);
    }
  }
  return dp[a.length][b.length];
}

function substitutionCost(left: string, right: string): number {
  if (left === right) return 0;
  const pair = new Set([left, right]);
  if (pair.has("b") && pair.has("v")) return 0.25;
  if (pair.has("w") && pair.has("v")) return 0.25;
  if (pair.has("s") && pair.has("h")) return 0.55;
  if (pair.has("t") && pair.has("d")) return 0.6;
  if (pair.has("a") && pair.has("e")) return 0.7;
  if (pair.has("i") && pair.has("e")) return 0.55;
  if (pair.has("u") && pair.has("o")) return 0.55;
  return 1;
}

function deletionCost(char: string): number {
  return "aeiou".includes(char) ? 0.45 : 1;
}
