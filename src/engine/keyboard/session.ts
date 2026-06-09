import { nowMs } from "../util/time";
import { unknownSessionError } from "./errors";
import { isSecureContext } from "./modes";
import type { Candidate, KeyboardMode, KeyboardSession, SessionId, TypingContext } from "./types";

let nextSessionCounter = 0;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;

export class KeyboardSessionManager {
  private readonly sessions = new Map<SessionId, KeyboardSession>();

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
      warnings: secure ? ["Secure/code field: suggestions and memory are disabled."] : [],
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
    session.compositionText = compositionText;
    session.caret = Math.max(0, Math.min(compositionText.length, Math.trunc(caret)));
    session.lastUpdateTime = nowMs();
    return session;
  }

  updateCandidates(sessionId: SessionId, candidates: Candidate[], warnings: string[] = []): KeyboardSession {
    const session = this.get(sessionId);
    session.candidates = candidates.slice(0, 12);
    session.warnings = warnings;
    session.lastUpdateTime = nowMs();
    return session;
  }

  updateProofHints(sessionId: SessionId, proofHints: KeyboardSession["proofHints"]): KeyboardSession {
    const session = this.get(sessionId);
    session.proofHints = proofHints.slice(0, 8);
    session.lastUpdateTime = nowMs();
    return session;
  }

  setMode(sessionId: SessionId, mode: KeyboardMode): void {
    const session = this.get(sessionId);
    session.mode = mode;
    session.context.mode = mode;
    session.compositionText = "";
    session.caret = 0;
    session.candidates = [];
    session.proofHints = [];
    session.warnings = isSecureContext(session.context) ? ["Secure/code field: suggestions and memory are disabled."] : [];
    session.lastUpdateTime = nowMs();
  }

  setLayout(sessionId: SessionId, layoutId: string): void {
    const session = this.get(sessionId);
    session.layoutId = layoutId;
    session.context.layoutId = layoutId;
    session.lastUpdateTime = nowMs();
  }

  recordCommit(sessionId: SessionId, committedText: string): void {
    const session = this.get(sessionId);
    session.lastCommittedText = committedText;
    if (committedText) {
      session.committedHistory = [...session.committedHistory, committedText].slice(-24);
    }
    session.compositionText = "";
    session.caret = 0;
    session.candidates = [];
    session.proofHints = [];
    session.lastUpdateTime = nowMs();
  }

  cancelComposition(sessionId: SessionId): void {
    const session = this.get(sessionId);
    session.compositionText = "";
    session.caret = 0;
    session.candidates = [];
    session.proofHints = [];
    session.lastUpdateTime = nowMs();
  }

  endSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
  }

  shutdown(): void {
    this.sessions.clear();
  }

  cleanupExpired(now = nowMs()): number {
    let removed = 0;
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastUpdateTime > this.sessionTtlMs) {
        this.sessions.delete(sessionId);
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
  }
}
