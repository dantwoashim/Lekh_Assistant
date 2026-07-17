import { createKeyboardEngine } from "../../../src/engine/keyboard";
import type { CandidateUpdate, CommitResult, KeyboardEngine } from "../../../src/engine/keyboard";
import {
  createIpcErrorResponse,
  createIpcResponse,
  isIpcMessageType
} from "../../shared/ipc/messages";
import { validateIpcRequest } from "../../shared/ipc/requestValidation";
import type {
  AnyTypedIpcRequest,
  BeginSessionResult,
  DiagnosticsMetricsResult,
  HealthCheckResult,
  IpcResponse
} from "../../shared/ipc/messages";

const DAEMON_VERSION = "0.1.0-dev";
const HOT_PATH_TIMEOUT_MS = 50;

export interface KeyboardDaemonOptions {
  engine?: KeyboardEngine;
  now?: () => number;
}

export interface HotPathFallback<T> {
  timedOut: boolean;
  value: T;
}

export class KeyboardDaemon {
  private readonly engine: KeyboardEngine;
  private readonly startedAt: number;
  private readonly now: () => number;
  private warmReady = false;
  private activeSessions = 0;
  private lastError: DiagnosticsMetricsResult["lastError"];
  private readonly counters = {
    processedKeystrokes: 0,
    ipcTimeouts: 0,
    passThroughFallbacks: 0,
    committedCandidates: 0
  };

  constructor(options: KeyboardDaemonOptions = {}) {
    this.engine = options.engine ?? createKeyboardEngine();
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  async handle(value: unknown): Promise<IpcResponse> {
    const startedAt = this.now();
    const validation = validateIpcRequest(value);
    if (!validation.ok) {
      const identity = requestIdentity(value);
      return createIpcErrorResponse(
        identity,
        {
          code: "IPC_SCHEMA_INVALID",
          message: validation.errors.join(" "),
          recoverable: true
        },
        this.now() - startedAt
      );
    }

    const request = validation.request;
    try {
      const response = await this.dispatch(request);
      response.latencyMs = this.now() - startedAt;
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = {
        code: "DAEMON_DISPATCH_FAILED",
        message,
        at: this.now()
      };
      return createIpcErrorResponse(
        request,
        {
          code: "DAEMON_DISPATCH_FAILED",
          message,
          recoverable: true
        },
        this.now() - startedAt
      );
    }
  }

  async withHotPathTimeout<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<HotPathFallback<T>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<HotPathFallback<T>>((resolve) => {
      timeout = setTimeout(() => {
        this.counters.ipcTimeouts += 1;
        this.counters.passThroughFallbacks += 1;
        resolve({ timedOut: true, value: fallback });
      }, timeoutMs);
    });
    const workPromise = work.then((value) => ({ timedOut: false, value }));
    const result = await Promise.race([workPromise, timeoutPromise]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  metrics(): DiagnosticsMetricsResult {
    return {
      uptimeMs: Math.max(0, this.now() - this.startedAt),
      activeSessions: this.activeSessions,
      warmReady: this.warmReady,
      lastError: this.lastError,
      counters: { ...this.counters }
    };
  }

  private async dispatch(request: AnyTypedIpcRequest): Promise<IpcResponse> {
    switch (request.type) {
      case "health.check": {
        const payload: HealthCheckResult = {
          status: this.lastError ? "degraded" : "ok",
          daemonVersion: DAEMON_VERSION,
          engineReady: this.warmReady,
          warnings: []
        };
        return createIpcResponse(request, payload);
      }
      case "engine.warm": {
        const result = await this.engine.warm(request.payload ?? undefined);
        this.warmReady = result.ready;
        return createIpcResponse(request, result);
      }
      case "session.begin": {
        const { context } = request.payload;
        const payload: BeginSessionResult = {
          sessionId: this.engine.beginSession(context)
        };
        this.activeSessions += 1;
        return createIpcResponse(request, payload);
      }
      case "session.processKeyStroke": {
        const { sessionId, key } = request.payload;
        this.counters.processedKeystrokes += 1;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.processKeyStroke(sessionId, key)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCandidateFallback(sessionId, "Native hot path exceeded 50ms; passing key through.")
        );
        return createIpcResponse(request, result.value);
      }
      case "session.updateComposition": {
        const { sessionId, input, cursor } = request.payload;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.updateComposition(sessionId, input, cursor)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCandidateFallback(sessionId, "Native composition update exceeded 50ms; preserving host input.", input, cursor)
        );
        return createIpcResponse(request, result.value);
      }
      case "session.commitCandidate": {
        const { sessionId, candidateId } = request.payload;
        const { value: result } = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitCandidate(sessionId, candidateId)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCommitFallback(sessionId, "Candidate commit exceeded 50ms; native host should pass through.")
        );
        if (result.committedText) this.counters.committedCandidates += 1;
        return createIpcResponse(request, result);
      }
      case "session.commitRaw": {
        const { sessionId } = request.payload;
        const { value: result } = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitRaw(sessionId)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCommitFallback(sessionId, "Raw commit exceeded 50ms; native host should pass through.")
        );
        if (result.committedText) this.counters.committedCandidates += 1;
        return createIpcResponse(request, result);
      }
      case "session.cancel": {
        const { sessionId } = request.payload;
        this.engine.cancelComposition(sessionId);
        return createIpcResponse(request, { cancelled: true });
      }
      case "session.end": {
        const { sessionId } = request.payload;
        this.engine.endSession(sessionId);
        this.activeSessions = Math.max(0, this.activeSessions - 1);
        return createIpcResponse(request, { ended: true });
      }
      case "session.setMode": {
        const { sessionId, mode } = request.payload;
        this.engine.setMode(sessionId, mode);
        return createIpcResponse(request, { mode });
      }
      case "session.setLayout": {
        const { sessionId, layoutId } = request.payload;
        this.engine.setLayout(sessionId, layoutId);
        return createIpcResponse(request, { layoutId });
      }
      case "suggestions.get": {
        const { context } = request.payload;
        return createIpcResponse(request, this.engine.getSuggestions(context));
      }
      case "proofHints.get": {
        const { textWindow, context } = request.payload;
        return createIpcResponse(request, this.engine.getProofHints(textWindow, context));
      }
      case "dictionary.lookup": {
        const { query, context } = request.payload;
        return createIpcResponse(request, this.engine.lookupDictionary(query, context));
      }
      case "memory.learn": {
        const learned = this.engine.learnCommittedCorrection(
          request.payload.sessionId,
          request.payload.commitEpoch
        );
        return createIpcResponse(request, { learned });
      }
      case "diagnostics.getMetrics": {
        return createIpcResponse(request, this.metrics());
      }
      case "engine.shutdown": {
        await this.engine.shutdown();
        this.warmReady = false;
        this.activeSessions = 0;
        return createIpcResponse(request, { shutdown: true });
      }
    }
  }
}

function hotPathCandidateFallback(sessionId: string, warning: string, input = "", cursor = 0): CandidateUpdate {
  return {
    sessionId,
    mode: "diagnostic",
    surface: "romanized-to-unicode",
    action: "passThrough",
    compositionText: input,
    displayText: input,
    caret: Math.max(0, Math.min(input.length, Math.trunc(cursor))),
    candidates: [],
    proofHints: [],
    shouldShowCandidateUI: false,
    confidence: 0,
    warnings: [warning],
    latencyMs: HOT_PATH_TIMEOUT_MS,
    schemaVersion: 1
  };
}

function hotPathCommitFallback(sessionId: string, warning: string): CommitResult {
  return {
    sessionId,
    action: "passThrough",
    committedText: "",
    commitEpoch: 0,
    followupCandidates: [],
    memoryRecorded: false,
    schemaVersion: 1
  };
}

function requestIdentity(value: unknown): { id: string; type: AnyTypedIpcRequest["type"] } {
  if (!isRecord(value)) {
    return { id: "invalid", type: "health.check" };
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : "invalid",
    type: isIpcMessageType(value.type) ? value.type : "health.check"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
