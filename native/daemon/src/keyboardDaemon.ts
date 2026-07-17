import { createKeyboardEngine } from "../../../src/engine/keyboard";
import type { CandidateUpdate, CommitResult, KeyboardEngine } from "../../../src/engine/keyboard";
import {
  IPC_PROTOCOL_LIMITS,
  IPC_SCHEMA_VERSION,
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
  IpcMessageType,
  IpcPayloadByType,
  IpcResponse,
  IpcResultByType,
  TypedIpcRequest,
  TypedIpcResponse
} from "../../shared/ipc/messages";
import { IpcProtocolState } from "./protocolState";

const DAEMON_VERSION = "0.1.0-dev";
const HOT_PATH_TIMEOUT_MS = 50;

export interface KeyboardDaemonOptions {
  engine?: KeyboardEngine;
  now?: () => number;
  serverInstanceId?: string;
}

export interface HotPathFallback<T> {
  timedOut: boolean;
  value: T;
}

export class KeyboardDaemon {
  private readonly engine: KeyboardEngine;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly protocol: IpcProtocolState;
  private warmReady = false;
  private pendingRequests = 0;
  private dispatchTail: Promise<void> = Promise.resolve();
  private shutdownPromise?: Promise<void>;
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
    this.protocol = new IpcProtocolState({
      now: this.now,
      serverInstanceId: options.serverInstanceId,
      onSessionExpired: (sessionId) => {
        try {
          this.engine.endSession(sessionId);
        } catch {
          // The protocol identity is already retired; engine cleanup is best effort.
        }
      }
    });
  }

  handle(value: unknown): Promise<IpcResponse> {
    if (this.pendingRequests >= IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection) {
      return Promise.resolve(createIpcErrorResponse(
        requestIdentity(value),
        { code: "IPC_QUEUE_FULL", message: "The daemon request queue is full." },
        0,
        { serverInstanceId: this.protocol.serverInstanceId }
      ));
    }

    this.pendingRequests += 1;
    const response = this.dispatchTail.then(() => this.handleSerial(value));
    this.dispatchTail = response.then(() => undefined, () => undefined);
    return response.finally(() => {
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    });
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      const scheduled = this.dispatchTail.then(() => this.shutdownSerial());
      this.shutdownPromise = scheduled.catch((error) => {
        this.shutdownPromise = undefined;
        throw error;
      });
      this.dispatchTail = this.shutdownPromise.then(() => undefined, () => undefined);
    }
    return this.shutdownPromise;
  }

  private async handleSerial(value: unknown): Promise<IpcResponse> {
    const startedAt = this.now();
    const validation = validateIpcRequest(value);
    if (!validation.ok) {
      const identity = requestIdentity(value);
      return createIpcErrorResponse(
        identity,
        {
          code: "IPC_SCHEMA_INVALID",
          message: "The IPC request did not match the required schema."
        },
        this.now() - startedAt,
        { serverInstanceId: this.protocol.serverInstanceId }
      );
    }

    const request = validation.request;
    const preflight = this.protocol.preflight(request);
    if (!preflight.proceed) return preflight.response;

    try {
      const response = await this.dispatch(request);
      response.latencyMs = this.now() - startedAt;
      this.protocol.remember(request, response);
      return response;
    } catch {
      const message = "The daemon request could not be completed.";
      this.lastError = {
        code: "DAEMON_DISPATCH_FAILED",
        message,
        at: this.now()
      };
      const response = createIpcErrorResponse(
        request,
        {
          code: "DAEMON_DISPATCH_FAILED",
          message
        },
        this.now() - startedAt,
        { serverInstanceId: this.protocol.serverInstanceId }
      );
      this.protocol.remember(request, response);
      return response;
    }
  }

  async withHotPathTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    fallback: T,
    onTimeout?: () => void
  ): Promise<HotPathFallback<T>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<HotPathFallback<T>>((resolve) => {
      timeout = setTimeout(() => {
        this.counters.ipcTimeouts += 1;
        this.counters.passThroughFallbacks += 1;
        onTimeout?.();
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
      activeSessions: this.protocol.activeSessionCount,
      warmReady: this.warmReady,
      lastError: this.lastError,
      counters: { ...this.counters }
    };
  }

  private async dispatch(request: AnyTypedIpcRequest): Promise<IpcResponse> {
    switch (request.type) {
      case "protocol.negotiate": {
        return this.success(request, {
          selectedVersion: IPC_SCHEMA_VERSION,
          serverInstanceId: this.protocol.serverInstanceId,
          limits: {
            maximumFrameBytes: IPC_PROTOCOL_LIMITS.maximumFrameBytes,
            hotPathDeadlineMs: IPC_PROTOCOL_LIMITS.hotPathDeadlineMs,
            maximumPendingRequestsPerConnection: IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection,
            maximumClientInstances: IPC_PROTOCOL_LIMITS.maximumClientInstances,
            clientIdleTtlMs: IPC_PROTOCOL_LIMITS.clientIdleTtlMs
          }
        });
      }
      case "health.check": {
        const payload: HealthCheckResult = {
          status: this.lastError ? "degraded" : "ok",
          daemonVersion: DAEMON_VERSION,
          engineReady: this.warmReady,
          warnings: []
        };
        return this.success(request, payload);
      }
      case "engine.warm": {
        const result = await this.engine.warm(request.payload ?? undefined);
        this.warmReady = result.ready;
        return this.success(request, result);
      }
      case "session.begin": {
        const { context } = request.payload;
        const sessionId = this.engine.beginSession(context);
        const payload: BeginSessionResult = {
          sessionId,
          sessionEpoch: this.protocol.openSession(request.clientInstanceId, sessionId)
        };
        return this.success(request, payload);
      }
      case "session.processKeyStroke": {
        const { sessionId, key } = request.payload;
        this.counters.processedKeystrokes += 1;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.processKeyStroke(sessionId, key)),
          this.hotPathTimeout(request),
          hotPathCandidateFallback(sessionId, "Native hot path exceeded its deadline; passing key through."),
          () => this.retireSession(sessionId)
        );
        return this.success(request, result.value);
      }
      case "session.updateComposition": {
        const { sessionId, input, cursor } = request.payload;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.updateComposition(sessionId, input, cursor)),
          this.hotPathTimeout(request),
          hotPathCandidateFallback(sessionId, "Native composition update exceeded its deadline; preserving host input.", input, cursor),
          () => this.retireSession(sessionId)
        );
        return this.success(request, result.value);
      }
      case "session.commitCandidate": {
        const { sessionId, candidateId } = request.payload;
        const { value: result } = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitCandidate(sessionId, candidateId)),
          this.hotPathTimeout(request),
          hotPathCommitFallback(sessionId, "Candidate commit exceeded its deadline; native host should pass through."),
          () => this.retireSession(sessionId)
        );
        if (result.committedText) this.counters.committedCandidates += 1;
        return this.success(request, result);
      }
      case "session.commitRaw": {
        const { sessionId } = request.payload;
        const { value: result } = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitRaw(sessionId)),
          this.hotPathTimeout(request),
          hotPathCommitFallback(sessionId, "Raw commit exceeded its deadline; native host should pass through."),
          () => this.retireSession(sessionId)
        );
        if (result.committedText) this.counters.committedCandidates += 1;
        return this.success(request, result);
      }
      case "session.cancel": {
        const { sessionId } = request.payload;
        this.engine.cancelComposition(sessionId);
        return this.success(request, { cancelled: true });
      }
      case "session.end": {
        const { sessionId } = request.payload;
        this.engine.endSession(sessionId);
        this.protocol.closeSession(sessionId);
        return this.success(request, { ended: true });
      }
      case "session.setMode": {
        const { sessionId, mode } = request.payload;
        this.engine.setMode(sessionId, mode);
        return this.success(request, { mode });
      }
      case "session.setLayout": {
        const { sessionId, layoutId } = request.payload;
        this.engine.setLayout(sessionId, layoutId);
        return this.success(request, { layoutId });
      }
      case "suggestions.get": {
        const { context } = request.payload;
        return this.success(request, this.engine.getSuggestions(context));
      }
      case "proofHints.get": {
        const { textWindow, context } = request.payload;
        return this.success(request, this.engine.getProofHints(textWindow, context));
      }
      case "dictionary.lookup": {
        const { query, context } = request.payload;
        return this.success(request, this.engine.lookupDictionary(query, context));
      }
      case "memory.learn": {
        const learned = this.engine.learnCommittedCorrection(
          request.payload.sessionId,
          request.payload.commitEpoch
        );
        return this.success(request, { learned });
      }
      case "diagnostics.getMetrics": {
        return this.success(request, this.metrics());
      }
      case "engine.shutdown": {
        await this.shutdownSerial();
        const response = this.success(request, { shutdown: true });
        return response;
      }
    }
  }

  private success<T extends IpcMessageType>(
    request: TypedIpcRequest<T>,
    payload: IpcResultByType[T]
  ): TypedIpcResponse<T> {
    return createIpcResponse<T>(request, payload, undefined, {
      serverInstanceId: this.protocol.serverInstanceId
    });
  }

  private hotPathTimeout(request: AnyTypedIpcRequest): number {
    return Math.max(1, Math.min(HOT_PATH_TIMEOUT_MS, Math.trunc(request.deadlineAt - this.now())));
  }

  private retireSession(sessionId: string): void {
    if (!this.protocol.closeSession(sessionId)) return;
    try {
      this.engine.endSession(sessionId);
    } catch {
      // The protocol epoch is already retired; engine cleanup is best effort.
    }
  }

  private async shutdownSerial(): Promise<void> {
    await this.engine.shutdown();
    this.warmReady = false;
    this.protocol.reset();
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

function requestIdentity(value: unknown): Pick<AnyTypedIpcRequest, "id" | "type"> &
  Partial<Pick<AnyTypedIpcRequest, "requestSequence" | "payload">> {
  if (!isRecord(value)) {
    return { id: "invalid", type: "health.check" };
  }
  return {
    id: typeof value.id === "string" && value.id &&
      value.id.length <= IPC_PROTOCOL_LIMITS.maximumIdentifierLength ? value.id : "invalid",
    type: isIpcMessageType(value.type) ? value.type : "health.check",
    ...(Number.isSafeInteger(value.requestSequence) && (value.requestSequence as number) >= 0
      ? { requestSequence: value.requestSequence as number }
      : {}),
    ...("payload" in value ? { payload: value.payload as IpcPayloadByType[IpcMessageType] } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
