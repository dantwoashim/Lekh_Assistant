import { nextWordCandidatesForCommittedText } from "./ngramLanguageModel";
import type { Candidate, KeyboardSession } from "./types";

export function nextWordCandidates(committedText: string, session: KeyboardSession): Candidate[] {
  return nextWordCandidatesForCommittedText(committedText, session, 4);
}
