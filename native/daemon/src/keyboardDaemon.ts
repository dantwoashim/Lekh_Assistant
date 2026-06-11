import { createKeyboardEngine } from "../../../src/engine/keyboard";
import type { CandidateUpdate, CommitResult, KeyboardEngine } from "../../../src/engine/keyboard";
import {
  IPC_SCHEMA_VERSION,
  createIpcErrorResponse,
  createIpcResponse,
  validateIpcEnvelope
} from "../../shared/ipc/messages";
import type {
  BeginSessionPayload,
  BeginSessionResult,
  DiagnosticsMetricsResult,
  DictionaryLookupPayload,
  HealthCheckResult,
  IpcRequest,
  IpcResponse,
  ProcessKeyStrokePayload,
  ProofHintsPayload,
  SessionPayload,
  SetLayoutPayload,
  SetModePayload,
  SuggestionsPayload,
  UpdateCompositionPayload
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

  async handle(request: IpcRequest): Promise<IpcResponse> {
    const startedAt = this.now();
    const envelope = validateIpcEnvelope(request);
    if (!envelope.ok) {
      return createIpcErrorResponse(
        {
          id: typeof request?.id === "string" && request.id ? request.id : "invalid",
          type: isKnownType(request?.type) ? request.type : "health.check"
        },
        {
          code: "IPC_SCHEMA_INVALID",
          message: envelope.errors.join(" "),
          recoverable: true
        },
        this.now() - startedAt
      );
    }

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

  private async dispatch(request: IpcRequest): Promise<IpcResponse> {
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
        const result = await this.engine.warm(request.payload as never);
        this.warmReady = result.ready;
        return createIpcResponse(request, result);
      }
      case "session.begin": {
        const { context } = request.payload as BeginSessionPayload;
        const payload: BeginSessionResult = {
          sessionId: this.engine.beginSession(context)
        };
        this.activeSessions += 1;
        return createIpcResponse(request, payload);
      }
      case "session.processKeyStroke": {
        const { sessionId, key } = request.payload as ProcessKeyStrokePayload;
        this.counters.processedKeystrokes += 1;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.processKeyStroke(sessionId, key)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCandidateFallback(sessionId, "Native hot path exceeded 50ms; passing key through.")
        );
        return createIpcResponse(request, result.value);
      }
      case "session.updateComposition": {
        const { sessionId, input, cursor } = request.payload as UpdateCompositionPayload;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.updateComposition(sessionId, input, cursor)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCandidateFallback(sessionId, "Native composition update exceeded 50ms; preserving host input.", input, cursor)
        );
        return createIpcResponse(request, result.value);
      }
      case "session.commitCandidate": {
        const { sessionId, candidateId } = request.payload as { sessionId: string; candidateId: string };
        const { value: result } = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitCandidate(sessionId, candidateId)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCommitFallback(sessionId, "Candidate commit exceeded 50ms; native host should pass through.")
        );
        if (result.committedText) this.counters.committedCandidates += 1;
        return createIpcResponse(request, result);
      }
      case "session.commitRaw": {
        const { sessionId } = request.payload as SessionPayload;
        const { value: result } = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitRaw(sessionId)),
          HOT_PATH_TIMEOUT_MS,
          hotPathCommitFallback(sessionId, "Raw commit exceeded 50ms; native host should pass through.")
        );
        if (result.committedText) this.counters.committedCandidates += 1;
        return createIpcResponse(request, result);
      }
      case "session.cancel": {
        const { sessionId } = request.payload as SessionPayload;
        this.engine.cancelComposition(sessionId);
        return createIpcResponse(request, { cancelled: true });
      }
      case "session.end": {
        const { sessionId } = request.payload as SessionPayload;
        this.engine.endSession(sessionId);
        this.activeSessions = Math.max(0, this.activeSessions - 1);
        return createIpcResponse(request, { ended: true });
      }
      case "session.setMode": {
        const { sessionId, mode } = request.payload as SetModePayload;
        this.engine.setMode(sessionId, mode);
        return createIpcResponse(request, { mode });
      }
      case "session.setLayout": {
        const { sessionId, layoutId } = request.payload as SetLayoutPayload;
        this.engine.setLayout(sessionId, layoutId);
        return createIpcResponse(request, { layoutId });
      }
      case "suggestions.get": {
        const { context } = request.payload as SuggestionsPayload;
        return createIpcResponse(request, this.engine.getSuggestions(context));
      }
      case "proofHints.get": {
        const { textWindow, context } = request.payload as ProofHintsPayload;
        return createIpcResponse(request, this.engine.getProofHints(textWindow, context));
      }
      case "dictionary.lookup": {
        const { query, context } = request.payload as DictionaryLookupPayload;
        return createIpcResponse(request, this.engine.lookupDictionary(query, context));
      }
      case "memory.learn": {
        this.engine.learnCorrection(request.payload);
        return createIpcResponse(request, { learned: true });
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
      default:
        return createIpcErrorResponse(
          request,
          {
            code: "IPC_MESSAGE_UNSUPPORTED",
            message: `Unsupported IPC message: ${request.type}`,
            recoverable: true
          }
        );
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
    followupCandidates: [],
    memoryRecorded: false,
    schemaVersion: 1
  };
}

function isKnownType(value: unknown): value is IpcRequest["type"] {
  return typeof value === "string" && validateIpcEnvelope({ id: "probe", type: value, version: IPC_SCHEMA_VERSION, sentAt: 1, payload: null }).ok;
}
