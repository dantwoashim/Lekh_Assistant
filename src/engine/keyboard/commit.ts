import { isLearningAllowedContext } from "./modes";
import type { Candidate, CommitResult, KeyboardSession, SessionId } from "./types";

export function commitCandidateResult(
  session: KeyboardSession,
  candidate: Candidate,
  memoryRecorded = isLearningAllowedContext(session.context)
): CommitResult {
  return {
    sessionId: session.sessionId,
    action: "commit",
    committedText: candidate.text,
    commitEpoch: session.commitEpoch + 1,
    consumedRange: candidate.replaceRange ?? [0, session.compositionText.length],
    followupCandidates: [],
    memoryRecorded,
    schemaVersion: 1
  };
}

export function commitRawResult(session: KeyboardSession): CommitResult {
  return {
    sessionId: session.sessionId,
    action: "commit",
    committedText: session.compositionText,
    commitEpoch: session.compositionText ? session.commitEpoch + 1 : session.commitEpoch,
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
    commitEpoch: 0,
    consumedRange: [0, 0],
    followupCandidates: [],
    memoryRecorded: false,
    schemaVersion: 1
  };
}
