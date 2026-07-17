import { nowMs } from "../util/time";
import { unknownSessionError } from "./errors";
import { isLearningAllowedContext, isSecureContext } from "./modes";
import { clampCaret } from "./ranges";
import type { Candidate, KeyboardMode, KeyboardSession, SessionId, TypingContext } from "./types";

let nextSessionCounter = 0;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;

export interface CorrectionLearningGrant {
  commitEpoch: number;
}

export class KeyboardSessionManager {
  private readonly sessions = new Map<SessionId, KeyboardSession>();
  private readonly correctionLearningGrants = new Map<SessionId, CorrectionLearningGrant>();

  constructor(
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS
  ) {}

  beginSession(context: TypingContext): SessionId {
    this.cleanupExpired();
    this.evictLeastRecentlyUsedIfNeeded();
    const sessionId = `kbd-${Date.now().toString(36)}-${(nextSessionCounter += 1).toString(36)}`;
    const secure = isSecureContext(context);
    this.sessions.set(sessionId, {
      sessionId,
      context: {
        ...context,
        secureInput: secure,
        leftTextWindow: secure ? "" : context.leftTextWindow,
        rightTextWindow: secure ? "" : context.rightTextWindow,
        preserveEnglish: context.preserveEnglish ?? true,
        activeDomains: context.activeDomains ?? [],
        enabledSurfaces: context.enabledSurfaces ?? []
      },
      mode: context.mode,
      layoutId: context.layoutId,
      compositionText: "",
      caret: 0,
      candidates: [],
      proofHints: [],
      lastUpdateTime: nowMs(),
      lastCommittedText: "",
      commitEpoch: 0,
      warnings: secure ? ["Secure/uncertain field: suggestions and memory are disabled."] : [],
      committedHistory: []
    });
    return sessionId;
  }

  get(sessionId: SessionId): KeyboardSession {
    this.cleanupExpired();
    const session = this.sessions.get(sessionId);
    if (!session) throw unknownSessionError(sessionId);
    return session;
  }

  has(sessionId: SessionId): boolean {
    this.cleanupExpired();
    return this.sessions.has(sessionId);
  }

  updateComposition(sessionId: SessionId, compositionText: string, caret: number): KeyboardSession {
    const session = this.get(sessionId);
    this.correctionLearningGrants.delete(sessionId);
    if (isSecureContext(session.context)) {
      purgeSensitiveSessionState(session);
      session.lastUpdateTime = nowMs();
      return session;
    }
    session.compositionText = compositionText;
    session.caret = clampCaret(compositionText, caret);
    session.lastUpdateTime = nowMs();
    return session;
  }

  updateContext(sessionId: SessionId, patch: Partial<TypingContext>): KeyboardSession {
    const session = this.get(sessionId);
    this.correctionLearningGrants.delete(sessionId);
    const mergedContext: TypingContext = {
      ...session.context,
      ...patch,
      activeDomains: patch.activeDomains ?? session.context.activeDomains ?? [],
      enabledSurfaces: patch.enabledSurfaces ?? session.context.enabledSurfaces ?? [],
      preserveEnglish: patch.preserveEnglish ?? session.context.preserveEnglish ?? true
    };
    const secure = isSecureContext(mergedContext);
    session.context = {
      ...mergedContext,
      secureInput: secure,
      // Never retain surrounding text supplied by a host after the field is
      // classified as secure or uncertain. The adapter may have learned the
      // classification in the same callback that carried these windows.
      leftTextWindow: secure ? "" : mergedContext.leftTextWindow,
      rightTextWindow: secure ? "" : mergedContext.rightTextWindow
    };
    session.mode = session.context.mode;
    session.layoutId = session.context.layoutId;
    if (secure) {
      purgeSensitiveSessionState(session);
    }
    session.warnings = secure ? ["Secure/uncertain field: suggestions and memory are disabled."] : [];
    session.lastUpdateTime = nowMs();
    return session;
  }

  updateCandidates(sessionId: SessionId, candidates: Candidate[], warnings: string[] = []): KeyboardSession {
    const session = this.get(sessionId);
    if (isSecureContext(session.context)) {
      purgeSensitiveSessionState(session);
      session.lastUpdateTime = nowMs();
      return session;
    }
    session.candidates = candidates.slice(0, 12);
    session.warnings = warnings;
    session.lastUpdateTime = nowMs();
    return session;
  }

  updateProofHints(sessionId: SessionId, proofHints: KeyboardSession["proofHints"]): KeyboardSession {
    const session = this.get(sessionId);
    if (isSecureContext(session.context)) {
      purgeSensitiveSessionState(session);
      session.lastUpdateTime = nowMs();
      return session;
    }
    session.proofHints = proofHints.slice(0, 8);
    session.lastUpdateTime = nowMs();
    return session;
  }

  setMode(sessionId: SessionId, mode: KeyboardMode): void {
    const session = this.get(sessionId);
    this.correctionLearningGrants.delete(sessionId);
    session.mode = mode;
    session.context.mode = mode;
    session.compositionText = "";
    session.caret = 0;
    session.candidates = [];
    session.proofHints = [];
    if (isSecureContext(session.context)) purgeSensitiveSessionState(session);
    session.warnings = isSecureContext(session.context) ? ["Secure/uncertain field: suggestions and memory are disabled."] : [];
    session.lastUpdateTime = nowMs();
  }

  setLayout(sessionId: SessionId, layoutId: string): void {
    const session = this.get(sessionId);
    this.correctionLearningGrants.delete(sessionId);
    session.layoutId = layoutId;
    session.context.layoutId = layoutId;
    session.lastUpdateTime = nowMs();
  }

  recordCommit(sessionId: SessionId, committedText: string, learnable = false): number {
    const session = this.get(sessionId);
    const hadComposition = session.compositionText.length > 0;
    this.correctionLearningGrants.delete(sessionId);
    if (isSecureContext(session.context)) {
      purgeSensitiveSessionState(session);
      session.lastUpdateTime = nowMs();
      return session.commitEpoch;
    }
    session.lastCommittedText = committedText;
    if (committedText) {
      session.commitEpoch += 1;
      session.committedHistory = [...session.committedHistory, committedText].slice(-24);
      if (learnable && isLearningAllowedContext(session.context) && hadComposition) {
        this.correctionLearningGrants.set(sessionId, {
          commitEpoch: session.commitEpoch
        });
      }
    }
    session.compositionText = "";
    session.caret = 0;
    session.candidates = [];
    session.proofHints = [];
    session.lastUpdateTime = nowMs();
    return session.commitEpoch;
  }

  consumeCorrectionLearningGrant(sessionId: SessionId, commitEpoch: number): CorrectionLearningGrant | undefined {
    if (!this.has(sessionId)) return undefined;
    const session = this.get(sessionId);
    if (!isLearningAllowedContext(session.context)) {
      this.correctionLearningGrants.delete(sessionId);
      return undefined;
    }
    const grant = this.correctionLearningGrants.get(sessionId);
    if (!grant || grant.commitEpoch !== commitEpoch || session.commitEpoch !== commitEpoch) return undefined;
    this.correctionLearningGrants.delete(sessionId);
    return { ...grant };
  }

  cancelComposition(sessionId: SessionId): void {
    const session = this.get(sessionId);
    this.correctionLearningGrants.delete(sessionId);
    session.compositionText = "";
    session.caret = 0;
    session.candidates = [];
    session.proofHints = [];
    session.lastUpdateTime = nowMs();
  }

  endSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
    this.correctionLearningGrants.delete(sessionId);
  }

  shutdown(): void {
    this.sessions.clear();
    this.correctionLearningGrants.clear();
  }

  cleanupExpired(now = nowMs()): number {
    let removed = 0;
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastUpdateTime > this.sessionTtlMs) {
        this.sessions.delete(sessionId);
        this.correctionLearningGrants.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  snapshot(): KeyboardSession[] {
    this.cleanupExpired();
    return Array.from(this.sessions.values()).map((session) => ({
      ...session,
      context: { ...session.context },
      candidates: session.candidates.slice(),
      proofHints: session.proofHints.slice(),
      warnings: session.warnings.slice(),
      committedHistory: session.committedHistory.slice()
    }));
  }

  private evictLeastRecentlyUsedIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;
    const [oldestSessionId] = Array.from(this.sessions.entries()).sort(
      ([, a], [, b]) => a.lastUpdateTime - b.lastUpdateTime
    )[0] ?? [];
    if (oldestSessionId) this.sessions.delete(oldestSessionId);
    if (oldestSessionId) this.correctionLearningGrants.delete(oldestSessionId);
  }
}

function purgeSensitiveSessionState(session: KeyboardSession): void {
  session.context.leftTextWindow = "";
  session.context.rightTextWindow = "";
  session.compositionText = "";
  session.caret = 0;
  session.candidates = [];
  session.proofHints = [];
  session.lastCommittedText = "";
  session.committedHistory = [];
  session.warnings = ["Secure/uncertain field: suggestions and memory are disabled."];
}
