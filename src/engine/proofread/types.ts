import type { EngineWarning, ProtectedSpan } from "../types";

export type ProofreadHintKind =
  | "spelling"
  | "postposition"
  | "normalization"
  | "punctuation"
  | "halant"
  | "matra"
  | "style"
  | "agreement"
  | "honorific";

export interface ProofreadHint {
  id: string;
  range: [number, number];
  input: string;
  suggestion: string;
  ruleId: string;
  kind: ProofreadHintKind;
  confidence: number;
  action: "auto-fix" | "hint-only";
  explanation: string;
}

export interface ProofreadOptions {
  autoFix?: boolean;
  normalizePluralHaru?: boolean;
  normalizePostpositions?: boolean;
  normalizeDanda?: boolean;
  protectedSpans?: ProtectedSpan[];
}

export interface ProofreadResult {
  input: string;
  output: string;
  applied: ProofreadHint[];
  hints: ProofreadHint[];
  warnings: EngineWarning[];
}

export interface ProofreadRule {
  id: string;
  kind: ProofreadHintKind;
  confidence: number;
  action: "auto-fix" | "hint-only";
  explanation: string;
  apply(input: string, offset: number): ProofreadHint[];
}
