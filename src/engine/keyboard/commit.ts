import type { Candidate, CommitResult, KeyboardSession, SessionId } from "./types";

export function commitCandidateResult(session: KeyboardSession, candidate: Candidate): CommitResult {
  return {
    sessionId: session.sessionId,
    action: "commit",
    committedText: candidate.text,
    consumedRange: candidate.replaceRange ?? [0, session.compositionText.length],
    followupCandidates: [],
    memoryRecorded: !session.context.secureInput && session.context.fieldType !== "password" && session.context.fieldType !== "code",
    schemaVersion: 1
  };
}

export function commitRawResult(session: KeyboardSession): CommitResult {
  return {
    sessionId: session.sessionId,
    action: "commit",
    committedText: session.compositionText,
    consumedRange: [0, session.compositionText.length],
    followupCandidates: [],
    memoryRecorded: false,
    schemaVersion: 1
  };
}

export function emptyCommitResult(sessionId: SessionId): CommitResult {
  return {
    sessionId,
    action: "errorFallback",
    committedText: "",
    consumedRange: [0, 0],
    followupCandidates: [],
    memoryRecorded: false,
    schemaVersion: 1
  };
}
