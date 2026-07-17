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
import {
  IPC_COMPATIBLE_SCHEMA_VERSIONS,
  IPC_ERROR_DEFINITIONS,
  IPC_MESSAGE_DESCRIPTORS,
  IPC_MESSAGE_TYPES,
  IPC_PROTOCOL_LIMITS,
  IPC_SCHEMA_VERSION
} from "./generatedProtocol";
import type {
  GeneratedIpcMessageType,
  IpcErrorCode,
  IpcRecoveryAction
} from "./generatedProtocol";

export {
  IPC_COMPATIBLE_SCHEMA_VERSIONS,
  IPC_ERROR_DEFINITIONS,
  IPC_MESSAGE_DESCRIPTORS,
  IPC_MESSAGE_TYPES,
  IPC_PROTOCOL_LIMITS,
  IPC_SCHEMA_VERSION
};
export type { IpcErrorCode, IpcRecoveryAction };

export type IpcMessageType = GeneratedIpcMessageType;

export interface IpcRequest<T = unknown> {
  id: string;
  type: IpcMessageType;
  version: typeof IPC_SCHEMA_VERSION;
  sentAt: number;
  deadlineAt: number;
  clientInstanceId: string;
  requestSequence: number;
  payload: T;
}

export interface IpcResponse<T = unknown> {
  id: string;
  type: IpcMessageType;
  version: typeof IPC_SCHEMA_VERSION;
  ok: boolean;
  serverInstanceId: string;
  requestSequence: number;
  sessionEpoch?: number;
  payload?: T;
  error?: {
    code: IpcErrorCode;
    message: string;
    recoverable: boolean;
    action?: IpcRecoveryAction;
  };
  latencyMs?: number;
}

export interface ProtocolNegotiatePayload {
  client: "windows-tsf" | "macos-imk" | "companion" | "daemon-test";
  supportedVersions: number[];
}

export interface ProtocolNegotiateResult {
  selectedVersion: typeof IPC_SCHEMA_VERSION;
  serverInstanceId: string;
  limits: {
    maximumFrameBytes: number;
    hotPathDeadlineMs: number;
    maximumPendingRequestsPerConnection: number;
  };
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
  sessionEpoch: number;
}

export interface SessionReference {
  sessionId: SessionId;
  sessionEpoch: number;
}

export interface ProcessKeyStrokePayload extends SessionReference {
  key: KeyboardKeyEvent;
}

export interface UpdateCompositionPayload extends SessionReference {
  input: string;
  cursor: number;
}

export interface CommitCandidatePayload extends SessionReference {
  candidateId: string;
}

export type SessionPayload = SessionReference;

export interface SetModePayload extends SessionReference {
  mode: KeyboardMode;
}

export interface SetLayoutPayload extends SessionReference {
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

export interface MemoryLearnPayload extends SessionReference {
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
  "protocol.negotiate": ProtocolNegotiatePayload;
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
  "protocol.negotiate": ProtocolNegotiateResult;
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

export interface IpcRequestMetadata {
  clientInstanceId?: string;
  requestSequence?: number;
  deadlineAt?: number;
}

export interface IpcResponseMetadata {
  serverInstanceId: string;
  sessionEpoch?: number;
}

const DEFAULT_CLIENT_INSTANCE_ID = `client_${cryptoSafeId()}`;
let nextRequestSequence = 0;

export function createIpcRequest<T extends IpcMessageType>(
  type: T,
  payload: IpcPayloadByType[T],
  id = cryptoSafeId(),
  sentAt = Date.now(),
  metadata: IpcRequestMetadata = {}
): TypedIpcRequest<T> {
  const deadlineBudget = IPC_MESSAGE_DESCRIPTORS[type].deadlineClass === "hotPath"
    ? IPC_PROTOCOL_LIMITS.hotPathDeadlineMs
    : IPC_PROTOCOL_LIMITS.controlDeadlineMs;
  return {
    id,
    type,
    version: IPC_SCHEMA_VERSION,
    sentAt,
    deadlineAt: metadata.deadlineAt ?? sentAt + deadlineBudget,
    clientInstanceId: metadata.clientInstanceId ?? DEFAULT_CLIENT_INSTANCE_ID,
    requestSequence: metadata.requestSequence ?? ++nextRequestSequence,
    payload
  };
}

export function createIpcResponse<T extends IpcMessageType>(
  request: Pick<TypedIpcRequest<T>, "id" | "type" | "version">,
  payload: IpcResultByType[T],
  latencyMs?: number,
  metadata: IpcResponseMetadata = { serverInstanceId: "unbound_server" }
): TypedIpcResponse<T> {
  const requestWithMetadata = request as Partial<Pick<IpcRequest, "requestSequence" | "payload">>;
  const sessionEpoch = metadata.sessionEpoch ?? sessionEpochFrom(requestWithMetadata.payload) ?? sessionEpochFrom(payload);
  return {
    id: request.id,
    type: request.type,
    version: IPC_SCHEMA_VERSION,
    ok: true,
    serverInstanceId: metadata.serverInstanceId,
    requestSequence: requestWithMetadata.requestSequence ?? 0,
    ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
    payload,
    ...(latencyMs === undefined ? {} : { latencyMs })
  };
}

export function createIpcErrorResponse(
  request: Pick<IpcRequest, "id" | "type"> & Partial<Pick<IpcRequest, "requestSequence" | "payload">>,
  error: Pick<NonNullable<IpcResponse["error"]>, "code" | "message"> &
    Partial<Pick<NonNullable<IpcResponse["error"]>, "recoverable" | "action">>,
  latencyMs?: number,
  metadata: IpcResponseMetadata = { serverInstanceId: "transport_error" }
): IpcResponse {
  const definition = IPC_ERROR_DEFINITIONS[error.code];
  const sessionEpoch = metadata.sessionEpoch ?? sessionEpochFrom(request.payload);
  return {
    id: request.id,
    type: request.type,
    version: IPC_SCHEMA_VERSION,
    ok: false,
    serverInstanceId: metadata.serverInstanceId,
    requestSequence: request.requestSequence ?? 0,
    ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
    error: {
      code: error.code,
      message: error.message,
      recoverable: definition.recoverable,
      action: definition.action
    },
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
  if (value.version !== IPC_SCHEMA_VERSION) errors.push(`version must be ${IPC_SCHEMA_VERSION}.`);

  const hasSentAt = "sentAt" in value;
  const hasOk = "ok" in value;
  if (hasSentAt === hasOk) {
    errors.push("Envelope must be either a request with sentAt or a response with ok.");
  }

  if (hasSentAt) {
    if (typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)) errors.push("sentAt must be a finite number.");
    if (typeof value.deadlineAt !== "number" || !Number.isFinite(value.deadlineAt)) {
      errors.push("deadlineAt must be a finite number.");
    }
    if (typeof value.sentAt === "number" && Number.isFinite(value.sentAt) &&
        typeof value.deadlineAt === "number" && Number.isFinite(value.deadlineAt) && isIpcMessageType(value.type)) {
      const maximumBudget = IPC_MESSAGE_DESCRIPTORS[value.type].deadlineClass === "hotPath"
        ? IPC_PROTOCOL_LIMITS.hotPathDeadlineMs
        : IPC_PROTOCOL_LIMITS.controlDeadlineMs;
      if (value.deadlineAt < value.sentAt || value.deadlineAt - value.sentAt > maximumBudget) {
        errors.push(`deadlineAt must be within the ${maximumBudget}ms ${IPC_MESSAGE_DESCRIPTORS[value.type].deadlineClass} budget.`);
      }
    }
    if (typeof value.clientInstanceId !== "string" || value.clientInstanceId.length === 0 ||
        value.clientInstanceId.length > IPC_PROTOCOL_LIMITS.maximumIdentifierLength) {
      errors.push("clientInstanceId must be a bounded non-empty string.");
    }
    if (!Number.isSafeInteger(value.requestSequence) || (value.requestSequence as number) < 1) {
      errors.push("requestSequence must be a positive safe integer.");
    }
    if (!("payload" in value)) errors.push("request payload must be present.");
  }

  if (hasOk) {
    const allowedResponseKeys = new Set([
      "id", "type", "version", "ok", "serverInstanceId", "requestSequence", "sessionEpoch", "payload", "error", "latencyMs"
    ]);
    for (const key of Object.keys(value)) {
      if (!allowedResponseKeys.has(key)) errors.push(`response.${key} is not allowed.`);
    }
    if (typeof value.ok !== "boolean") errors.push("ok must be a boolean.");
    if (typeof value.serverInstanceId !== "string" || value.serverInstanceId.length === 0 ||
        value.serverInstanceId.length > IPC_PROTOCOL_LIMITS.maximumIdentifierLength) {
      errors.push("serverInstanceId must be a bounded non-empty string.");
    }
    if (!Number.isSafeInteger(value.requestSequence) || (value.requestSequence as number) < 0) {
      errors.push("requestSequence must be a non-negative safe integer.");
    }
    if ("sessionEpoch" in value && (!Number.isSafeInteger(value.sessionEpoch) || (value.sessionEpoch as number) < 1)) {
      errors.push("sessionEpoch must be a positive safe integer when present.");
    }
    if (value.ok === false) {
      if ("payload" in value) errors.push("error response must not include payload.");
      if (!isRecord(value.error)) {
        errors.push("error response must include an error object.");
      } else {
        if (!isIpcErrorCode(value.error.code)) {
          errors.push("error.code must be a known IPC error code.");
        } else {
          const definition = IPC_ERROR_DEFINITIONS[value.error.code];
          if (value.error.recoverable !== definition.recoverable) errors.push("error.recoverable must match the protocol definition.");
          if (value.error.action !== definition.action) errors.push("error.action must match the protocol definition.");
        }
        if (typeof value.error.message !== "string" || !value.error.message) errors.push("error.message must be a non-empty string.");
      }
    } else {
      if (!("payload" in value)) errors.push("success response must include payload.");
      if ("error" in value) errors.push("success response must not include error.");
      if (isIpcMessageType(value.type) && IPC_MESSAGE_DESCRIPTORS[value.type].sessionBound &&
          (!Number.isSafeInteger(value.sessionEpoch) || (value.sessionEpoch as number) < 1)) {
        errors.push("session-bound success response must include a positive sessionEpoch.");
      }
      if (value.type === "protocol.negotiate") {
        if (!isRecord(value.payload) || value.payload.selectedVersion !== IPC_SCHEMA_VERSION ||
            value.payload.serverInstanceId !== value.serverInstanceId) {
          errors.push("protocol negotiation payload must bind the selected version and server instance.");
        }
      }
    }
    if ("latencyMs" in value && (typeof value.latencyMs !== "number" || value.latencyMs < 0)) {
      errors.push("latencyMs must be a non-negative number when present.");
    }
  }

  return { ok: errors.length === 0, errors };
}

function cryptoSafeId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") return `ipc_${randomUUID.call(globalThis.crypto)}`;
  return `ipc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isIpcErrorCode(value: unknown): value is IpcErrorCode {
  return typeof value === "string" && Object.hasOwn(IPC_ERROR_DEFINITIONS, value);
}

function sessionEpochFrom(value: unknown): number | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.sessionEpoch) || (value.sessionEpoch as number) < 1) return undefined;
  return value.sessionEpoch as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
