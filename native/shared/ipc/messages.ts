import type {
  Candidate,
  CandidateUpdate,
  CommitResult,
  DictionaryResult,
  KeyboardKeyEvent,
  KeyboardMode,
  ProofHint,
  SessionId,
  TypingContext,
  WarmOptions,
  WarmResult
} from "../../../src/engine/keyboard/types";

export const IPC_SCHEMA_VERSION = 1 as const;

export const IPC_MESSAGE_TYPES = [
  "health.check",
  "engine.warm",
  "session.begin",
  "session.processKeyStroke",
  "session.updateComposition",
  "session.commitCandidate",
  "session.commitRaw",
  "session.cancel",
  "session.end",
  "session.setMode",
  "session.setLayout",
  "suggestions.get",
  "proofHints.get",
  "dictionary.lookup",
  "memory.learn",
  "diagnostics.getMetrics",
  "engine.shutdown"
] as const;

export type IpcMessageType =
  (typeof IPC_MESSAGE_TYPES)[number];

export interface IpcRequest<T = unknown> {
  id: string;
  type: IpcMessageType;
  version: typeof IPC_SCHEMA_VERSION;
  sentAt: number;
  payload: T;
}

export interface IpcResponse<T = unknown> {
  id: string;
  type: IpcMessageType;
  version: typeof IPC_SCHEMA_VERSION;
  ok: boolean;
  payload?: T;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  latencyMs?: number;
}

export interface HealthCheckPayload {
  client: "windows-tsf" | "macos-imk" | "companion" | "daemon-test";
}

export interface HealthCheckResult {
  status: "ok" | "degraded";
  daemonVersion?: string;
  engineReady: boolean;
  warnings: string[];
}

export interface BeginSessionPayload {
  context: TypingContext;
}

export interface BeginSessionResult {
  sessionId: SessionId;
}

export interface ProcessKeyStrokePayload {
  sessionId: SessionId;
  key: KeyboardKeyEvent;
}

export interface UpdateCompositionPayload {
  sessionId: SessionId;
  input: string;
  cursor: number;
}

export interface CommitCandidatePayload {
  sessionId: SessionId;
  candidateId: string;
}

export interface SessionPayload {
  sessionId: SessionId;
}

export interface SetModePayload {
  sessionId: SessionId;
  mode: KeyboardMode;
}

export interface SetLayoutPayload {
  sessionId: SessionId;
  layoutId: string;
}

export interface SuggestionsPayload {
  context: TypingContext;
}

export interface ProofHintsPayload {
  textWindow: string;
  context?: TypingContext;
}

export interface DictionaryLookupPayload {
  query: string;
  context?: TypingContext;
}

export interface MemoryLearnPayload {
  sessionId: SessionId;
  commitEpoch: number;
}

export interface DiagnosticsMetricsResult {
  uptimeMs: number;
  activeSessions: number;
  warmReady: boolean;
  lastError?: {
    code: string;
    message: string;
    at: number;
  };
  counters: {
    processedKeystrokes: number;
    ipcTimeouts: number;
    passThroughFallbacks: number;
    committedCandidates: number;
  };
}

export type IpcPayloadByType = {
  "health.check": HealthCheckPayload;
  "engine.warm": WarmOptions | null;
  "session.begin": BeginSessionPayload;
  "session.processKeyStroke": ProcessKeyStrokePayload;
  "session.updateComposition": UpdateCompositionPayload;
  "session.commitCandidate": CommitCandidatePayload;
  "session.commitRaw": SessionPayload;
  "session.cancel": SessionPayload;
  "session.end": SessionPayload;
  "session.setMode": SetModePayload;
  "session.setLayout": SetLayoutPayload;
  "suggestions.get": SuggestionsPayload;
  "proofHints.get": ProofHintsPayload;
  "dictionary.lookup": DictionaryLookupPayload;
  "memory.learn": MemoryLearnPayload;
  "diagnostics.getMetrics": null;
  "engine.shutdown": null;
};

export type IpcResultByType = {
  "health.check": HealthCheckResult;
  "engine.warm": WarmResult;
  "session.begin": BeginSessionResult;
  "session.processKeyStroke": CandidateUpdate;
  "session.updateComposition": CandidateUpdate;
  "session.commitCandidate": CommitResult;
  "session.commitRaw": CommitResult;
  "session.cancel": { cancelled: true };
  "session.end": { ended: true };
  "session.setMode": { mode: KeyboardMode };
  "session.setLayout": { layoutId: string };
  "suggestions.get": Candidate[];
  "proofHints.get": ProofHint[];
  "dictionary.lookup": DictionaryResult[];
  "memory.learn": { learned: boolean };
  "diagnostics.getMetrics": DiagnosticsMetricsResult;
  "engine.shutdown": { shutdown: true };
};

export type TypedIpcRequest<T extends IpcMessageType> = IpcRequest<IpcPayloadByType[T]> & {
  type: T;
};

export type AnyTypedIpcRequest = {
  [T in IpcMessageType]: TypedIpcRequest<T>;
}[IpcMessageType];

export type TypedIpcResponse<T extends IpcMessageType> = IpcResponse<IpcResultByType[T]> & {
  type: T;
};

export function createIpcRequest<T extends IpcMessageType>(
  type: T,
  payload: IpcPayloadByType[T],
  id = cryptoSafeId(),
  sentAt = Date.now()
): TypedIpcRequest<T> {
  return {
    id,
    type,
    version: IPC_SCHEMA_VERSION,
    sentAt,
    payload
  };
}

export function createIpcResponse<T extends IpcMessageType>(
  request: Pick<TypedIpcRequest<T>, "id" | "type" | "version">,
  payload: IpcResultByType[T],
  latencyMs?: number
): TypedIpcResponse<T> {
  return {
    id: request.id,
    type: request.type,
    version: IPC_SCHEMA_VERSION,
    ok: true,
    payload,
    ...(latencyMs === undefined ? {} : { latencyMs })
  };
}

export function createIpcErrorResponse(
  request: Pick<IpcRequest, "id" | "type">,
  error: IpcResponse["error"],
  latencyMs?: number
): IpcResponse {
  return {
    id: request.id,
    type: request.type,
    version: IPC_SCHEMA_VERSION,
    ok: false,
    error,
    ...(latencyMs === undefined ? {} : { latencyMs })
  };
}

export interface IpcValidationResult {
  ok: boolean;
  errors: string[];
}

export function isIpcMessageType(value: unknown): value is IpcMessageType {
  return typeof value === "string" && (IPC_MESSAGE_TYPES as readonly string[]).includes(value);
}

export function validateIpcEnvelope(value: unknown): IpcValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Envelope must be an object."] };
  }
  if (typeof value.id !== "string" || value.id.length === 0) errors.push("id must be a non-empty string.");
  if (!isIpcMessageType(value.type)) errors.push("type must be a known IPC message type.");
  if (value.version !== IPC_SCHEMA_VERSION) errors.push("version must be 1.");

  const hasSentAt = "sentAt" in value;
  const hasOk = "ok" in value;
  if (hasSentAt === hasOk) {
    errors.push("Envelope must be either a request with sentAt or a response with ok.");
  }

  if (hasSentAt) {
    if (typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)) errors.push("sentAt must be a finite number.");
    if (!("payload" in value)) errors.push("request payload must be present.");
  }

  if (hasOk) {
    if (typeof value.ok !== "boolean") errors.push("ok must be a boolean.");
    if (value.ok === false) {
      if (!isRecord(value.error)) {
        errors.push("error response must include an error object.");
      } else {
        if (typeof value.error.code !== "string" || !value.error.code) errors.push("error.code must be a non-empty string.");
        if (typeof value.error.message !== "string" || !value.error.message) errors.push("error.message must be a non-empty string.");
        if (typeof value.error.recoverable !== "boolean") errors.push("error.recoverable must be a boolean.");
      }
    }
    if ("latencyMs" in value && (typeof value.latencyMs !== "number" || value.latencyMs < 0)) {
      errors.push("latencyMs must be a non-negative number when present.");
    }
  }

  return { ok: errors.length === 0, errors };
}

function cryptoSafeId(): string {
  return `ipc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
