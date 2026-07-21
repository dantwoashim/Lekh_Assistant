import { createKeyboardEngine } from "../../../src/engine/keyboard";
import { isSecureContext } from "../../../src/engine/keyboard";
import type {
  CandidateUpdate,
  CommitResult,
  DictionaryResult,
  KeyboardCorrectionMemoryStore,
  KeyboardEngine,
  PersonalDictionaryStore
} from "../../../src/engine/keyboard";
import {
  IPC_MESSAGE_DESCRIPTORS,
  IPC_PROTOCOL_LIMITS,
  IPC_SCHEMA_VERSION,
  createIpcErrorResponse,
  createIpcResponse,
  isIpcMessageType
} from "../../shared/ipc/messages";
import { validateIpcRequest } from "../../shared/ipc/requestValidation";
import { isWellFormedUtf16 } from "../../shared/ipc/utf16";
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

const DAEMON_VERSION = "1.0.0";
const HOT_PATH_TIMEOUT_MS = 50;

export interface KeyboardDaemonPersistence {
  memoryEnabled: boolean;
  correctionMemory: KeyboardCorrectionMemoryStore;
  personalDictionary: PersonalDictionaryStore;
  close(): void | Promise<void>;
}

export interface KeyboardDaemonOptions {
  engine?: KeyboardEngine;
  now?: () => number;
  serverInstanceId?: string;
  persistence?: KeyboardDaemonPersistence;
  expirySweepIntervalMs?: number | false;
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
  private readonly persistence?: KeyboardDaemonPersistence;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private expirySweepQueued = false;
  private acceptingRequests = true;
  private stopping = false;
  private nextRequestTicket = 0;
  private terminalRequestTicket?: number;
  private warmReady = false;
  private pendingRequests = 0;
  private dispatchTail: Promise<void> = Promise.resolve();
  private shutdownPromise?: Promise<void>;
  private finalizationPromise?: Promise<void>;
  private lastError: DiagnosticsMetricsResult["lastError"];
  private readonly counters = {
    processedKeystrokes: 0,
    ipcTimeouts: 0,
    passThroughFallbacks: 0,
    committedCandidates: 0
  };

  constructor(options: KeyboardDaemonOptions = {}) {
    this.engine = options.engine ?? createKeyboardEngine();
    this.persistence = options.persistence;
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
    if (options.expirySweepIntervalMs !== undefined && options.expirySweepIntervalMs !== false) {
      if (!Number.isSafeInteger(options.expirySweepIntervalMs) || options.expirySweepIntervalMs < 1) {
        throw new Error("Daemon expiry sweep interval must be a positive safe integer.");
      }
      this.expiryTimer = setInterval(() => this.scheduleExpirySweep(), options.expirySweepIntervalMs);
      this.expiryTimer.unref?.();
    }
  }

  handle(value: unknown): Promise<IpcResponse> {
    if (!this.acceptingRequests) return Promise.resolve(this.stoppingResponse(value));
    if (this.pendingRequests >= IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection) {
      return Promise.resolve(createIpcErrorResponse(
        requestIdentity(value),
        { code: "IPC_QUEUE_FULL", message: "The daemon request queue is full." },
        0,
        { serverInstanceId: this.protocol.serverInstanceId }
      ));
    }

    const ticket = ++this.nextRequestTicket;
    this.pendingRequests += 1;
    const response = this.dispatchTail.then(() => this.handleSerial(value, ticket));
    this.dispatchTail = response.then(() => undefined, () => undefined);
    return response.finally(() => {
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    });
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.acceptingRequests = false;
      this.stopExpiryTimer();
      const scheduled = this.dispatchTail.then(() => this.shutdownSerial());
      this.shutdownPromise = scheduled;
      this.dispatchTail = this.shutdownPromise.then(() => undefined, () => undefined);
    }
    return this.shutdownPromise;
  }

  private async handleSerial(value: unknown, ticket: number): Promise<IpcResponse> {
    const startedAt = this.now();
    if (this.terminalRequestTicket !== undefined && ticket > this.terminalRequestTicket) {
      return this.stoppingResponse(value, this.now() - startedAt);
    }
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
    if (request.type === "engine.shutdown") {
      this.acceptingRequests = false;
      this.terminalRequestTicket = ticket;
    }

    try {
      const response = await this.dispatch(request);
      response.latencyMs = this.now() - startedAt;
      if (!this.stopping) this.protocol.remember(request, response);
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
      if (!this.stopping) this.protocol.remember(request, response);
      return response;
    }
  }

  async withHotPathTimeout<T>(
    work: Promise<T>,
    timeoutMs: number,
    fallback: T,
    onTimeout?: () => void,
    deadlineAt = this.now() + timeoutMs
  ): Promise<HotPathFallback<T>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutHandled = false;
    const timeoutFallback = (): HotPathFallback<T> => {
      if (!timeoutHandled) {
        timeoutHandled = true;
        this.counters.ipcTimeouts += 1;
        this.counters.passThroughFallbacks += 1;
        onTimeout?.();
      }
      return { timedOut: true, value: fallback };
    };
    const timeoutPromise = new Promise<HotPathFallback<T>>((resolve) => {
      timeout = setTimeout(() => {
        resolve(timeoutFallback());
      }, timeoutMs);
    });
    const workPromise = work.then((value): HotPathFallback<T> => {
      return this.now() > deadlineAt
        ? timeoutFallback()
        : { timedOut: false, value };
    });
    try {
      return await Promise.race([workPromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
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
            maximumCompositionLength: IPC_PROTOCOL_LIMITS.maximumCompositionLength,
            hotPathDeadlineMs: IPC_PROTOCOL_LIMITS.hotPathDeadlineMs,
            maximumPendingRequestsPerConnection: IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection,
            maximumClientInstances: IPC_PROTOCOL_LIMITS.maximumClientInstances,
            maximumActiveSessions: IPC_PROTOCOL_LIMITS.maximumActiveSessions,
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
        if (!this.protocol.hasSessionCapacity) {
          return createIpcErrorResponse(
            request,
            { code: "IPC_QUEUE_FULL", message: "The daemon active-session limit has been reached." },
            undefined,
            { serverInstanceId: this.protocol.serverInstanceId }
          );
        }
        const { context } = request.payload;
        const sessionId = this.engine.beginSession(context);
        let sessionEpoch: number;
        try {
          sessionEpoch = this.protocol.openSession(request.clientInstanceId, sessionId);
        } catch (error) {
          try {
            this.engine.endSession(sessionId);
          } catch {
            // The protocol session was never admitted; cleanup remains best effort.
          }
          throw error;
        }
        const payload: BeginSessionResult = { sessionId, sessionEpoch };
        return this.success(request, payload);
      }
      case "session.processKeyStroke": {
        const { sessionId, key } = request.payload;
        this.counters.processedKeystrokes += 1;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.processKeyStroke(sessionId, key)),
          this.hotPathTimeout(request),
          hotPathCandidateFallback(sessionId, "Native hot path exceeded its deadline; passing key through."),
          () => this.retireSession(sessionId),
          request.deadlineAt
        );
        return this.success(request, result.value, result.timedOut);
      }
      case "session.updateComposition": {
        const { sessionId, input, cursor } = request.payload;
        const result = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.updateComposition(sessionId, input, cursor)),
          this.hotPathTimeout(request),
          hotPathCandidateFallback(sessionId, "Native composition update exceeded its deadline; preserving host input."),
          () => this.retireSession(sessionId),
          request.deadlineAt
        );
        return this.success(request, result.value, result.timedOut);
      }
      case "session.commitCandidate": {
        const { sessionId, candidateId } = request.payload;
        const timedResult = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitCandidate(
            sessionId,
            candidateId,
            { learning: this.persistence?.memoryEnabled === false ? "disabled" : "deferred" }
          )),
          this.hotPathTimeout(request),
          hotPathCommitFallback(sessionId, "Candidate commit exceeded its deadline; native host should pass through."),
          () => this.retireSession(sessionId),
          request.deadlineAt
        );
        const result = timedResult.value;
        if (result.committedText) this.counters.committedCandidates += 1;
        return this.success(request, result, timedResult.timedOut);
      }
      case "session.commitRaw": {
        const { sessionId } = request.payload;
        const timedResult = await this.withHotPathTimeout(
          Promise.resolve().then(() => this.engine.commitRaw(sessionId)),
          this.hotPathTimeout(request),
          hotPathCommitFallback(sessionId, "Raw commit exceeded its deadline; native host should pass through."),
          () => this.retireSession(sessionId),
          request.deadlineAt
        );
        const result = timedResult.value;
        if (result.committedText) this.counters.committedCandidates += 1;
        return this.success(request, result, timedResult.timedOut);
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
        if (context && isSecureContext(context)) return this.success(request, []);
        const builtIn = this.engine.lookupDictionary(query, context);
        const personal = this.persistence
          ? await this.persistence.personalDictionary.lookup(query)
          : [];
        return this.success(request, mergeDictionaryResults(personal, builtIn));
      }
      case "memory.learn": {
        const { sessionId, commitEpoch } = request.payload;
        if (!this.persistence) {
          const learned = this.engine.learnCommittedCorrection(sessionId, commitEpoch);
          return this.success(request, { learned }, learned);
        }
        if (!this.persistence.memoryEnabled) return this.success(request, { learned: false });
        const prepared = this.engine.prepareCommittedCorrectionLearning(sessionId, commitEpoch);
        if (!prepared) return this.success(request, { learned: false });
        await this.persistence.correctionMemory.record(prepared.entry);
        const learned = this.engine.commitPreparedCorrectionLearning(prepared);
        if (!learned) throw new Error("Durable correction learning could not be installed in the live engine.");
        // Once the durable transaction has committed, publish and replay its
        // exact result even if synchronous FULL-durability work crossed the
        // request deadline. Returning a deadline error here would make a
        // successful irreversible write indistinguishable from no write.
        return this.success(request, { learned }, true);
      }
      case "diagnostics.getMetrics": {
        return this.success(request, this.metrics());
      }
      case "engine.shutdown": {
        await this.shutdownSerial();
        // Finalization is irreversible and exactly-once. Once it completes,
        // report the completed terminal state even if storage close crossed
        // the request deadline; a fresh deadline failure would be false.
        const response = this.success(request, { shutdown: true }, true);
        return response;
      }
    }
  }

  private success<T extends IpcMessageType>(
    request: TypedIpcRequest<T>,
    payload: IpcResultByType[T],
    allowPublicationAfterDeadline = false
  ): IpcResponse {
    if (!allowPublicationAfterDeadline && this.now() > request.deadlineAt) {
      this.counters.ipcTimeouts += 1;
      if (IPC_MESSAGE_DESCRIPTORS[request.type].deadlineClass === "hotPath") {
        this.counters.passThroughFallbacks += 1;
      }
      const sessionId = responseSessionId(request, payload);
      if (sessionId) this.retireSession(sessionId);
      return createIpcErrorResponse(
        request,
        { code: "IPC_DEADLINE_EXCEEDED", message: "The request deadline elapsed before its result was safe to publish." },
        undefined,
        { serverInstanceId: this.protocol.serverInstanceId }
      );
    }
    return createIpcResponse<T>(request, payload, undefined, {
      serverInstanceId: this.protocol.serverInstanceId
    }) as unknown as IpcResponse;
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

  private shutdownSerial(): Promise<void> {
    if (!this.finalizationPromise) {
      this.acceptingRequests = false;
      this.stopping = true;
      this.stopExpiryTimer();
      this.finalizationPromise = (async () => {
        try {
          await this.engine.shutdown();
        } finally {
          try {
            await this.persistence?.close();
          } finally {
            this.warmReady = false;
            this.protocol.reset();
          }
        }
      })();
    }
    return this.finalizationPromise;
  }

  private scheduleExpirySweep(): void {
    if (this.stopping || this.expirySweepQueued) return;
    this.expirySweepQueued = true;
    const sweep = this.dispatchTail.then(() => {
      if (!this.stopping) this.protocol.expireIdle();
    }).finally(() => {
      this.expirySweepQueued = false;
    });
    this.dispatchTail = sweep.then(() => undefined, () => undefined);
  }

  private stopExpiryTimer(): void {
    if (!this.expiryTimer) return;
    clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private stoppingResponse(value: unknown, latencyMs = 0): IpcResponse {
    return createIpcErrorResponse(
      requestIdentity(value),
      { code: "DAEMON_STOPPING", message: "The daemon is shutting down." },
      latencyMs,
      { serverInstanceId: this.protocol.serverInstanceId }
    );
  }
}

export function mergeDictionaryResults(
  personal: readonly DictionaryResult[],
  builtIn: readonly DictionaryResult[]
): DictionaryResult[] {
  const ordered = [
    ...personal.map((result) => ({ result, personal: true })),
    ...builtIn.map((result) => ({ result, personal: false }))
  ].sort((left, right) => (
    Number(right.personal) - Number(left.personal) ||
    right.result.confidence - left.result.confidence ||
    compareCodeUnits(left.result.word.normalize("NFC"), right.result.word.normalize("NFC")) ||
    compareCodeUnits(left.result.source ?? "", right.result.source ?? "")
  ));
  const seen = new Set<string>();
  const merged: DictionaryResult[] = [];
  for (const { result } of ordered) {
    const key = result.word.normalize("NFC");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...result,
      romanized: result.romanized?.slice(),
      variants: result.variants?.slice(),
      domains: result.domains?.slice()
    });
    if (merged.length === IPC_PROTOCOL_LIMITS.maximumDictionaryResults) break;
  }
  return merged;
}

function hotPathCandidateFallback(sessionId: string, warning: string): CandidateUpdate {
  return {
    sessionId,
    mode: "diagnostic",
    surface: "romanized-to-unicode",
    action: "passThrough",
    compositionText: "",
    displayText: "",
    caret: 0,
    candidates: [],
    proofHints: [],
    shouldShowCandidateUI: false,
    confidence: 0,
    warnings: [warning],
    latencyMs: HOT_PATH_TIMEOUT_MS,
    schemaVersion: 1
  };
}

function responseSessionId<T extends IpcMessageType>(
  request: TypedIpcRequest<T>,
  payload: IpcResultByType[T]
): string | undefined {
  const payloadValue: unknown = payload;
  if (request.type === "session.begin" && isRecord(payloadValue) && typeof payloadValue.sessionId === "string") {
    return payloadValue.sessionId;
  }
  if (IPC_MESSAGE_DESCRIPTORS[request.type].sessionBound && isRecord(request.payload) &&
      typeof request.payload.sessionId === "string") {
    return request.payload.sessionId;
  }
  return undefined;
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
    id: typeof value.id === "string" && value.id && isWellFormedUtf16(value.id) &&
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
