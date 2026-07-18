import { createHash, randomUUID } from "node:crypto";
import {
  IPC_MESSAGE_DESCRIPTORS,
  IPC_PROTOCOL_LIMITS,
  IPC_SCHEMA_VERSION,
  createIpcErrorResponse
} from "../../shared/ipc/messages";
import type {
  AnyTypedIpcRequest,
  IpcErrorCode,
  IpcResponse
} from "../../shared/ipc/messages";

interface ReplayEntry {
  id: string;
  type: AnyTypedIpcRequest["type"];
  fingerprint: string;
  response: IpcResponse;
}

interface ClientState {
  selectedVersion: typeof IPC_SCHEMA_VERSION;
  lastSequence: number;
  lastSeenAt: number;
  replayBySequence: Map<number, ReplayEntry>;
}

interface SessionState {
  clientInstanceId: string;
  epoch: number;
  lastSeenAt: number;
}

export type ProtocolPreflight =
  | { proceed: true }
  | { proceed: false; response: IpcResponse; replayed: boolean };

export interface IpcProtocolStateOptions {
  now?: () => number;
  serverInstanceId?: string;
  clientIdleTtlMs?: number;
  onSessionExpired?: (sessionId: string) => void;
}

export class IpcProtocolState {
  readonly serverInstanceId: string;
  private readonly now: () => number;
  private readonly clientIdleTtlMs: number;
  private readonly onSessionExpired?: (sessionId: string) => void;
  private readonly clients = new Map<string, ClientState>();
  private readonly sessions = new Map<string, SessionState>();
  private nextSessionEpoch = 1;

  constructor(options: IpcProtocolStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.clientIdleTtlMs = options.clientIdleTtlMs ?? IPC_PROTOCOL_LIMITS.clientIdleTtlMs;
    if (!Number.isSafeInteger(this.clientIdleTtlMs) || this.clientIdleTtlMs < 1) {
      throw new Error("IPC client idle TTL must be a positive safe integer.");
    }
    this.onSessionExpired = options.onSessionExpired;
    this.serverInstanceId = options.serverInstanceId ?? `daemon_${randomUUID()}`;
  }

  preflight(request: AnyTypedIpcRequest): ProtocolPreflight {
    this.cleanupExpiredClients();
    this.cleanupExpiredSessions();
    if (this.now() > request.deadlineAt) {
      return this.reject(request, "IPC_DEADLINE_EXCEEDED", "The request deadline elapsed before dispatch.");
    }

    const client = this.clients.get(request.clientInstanceId);
    if (client) {
      const replay = client.replayBySequence.get(request.requestSequence);
      if (replay) {
        if (replay.id === request.id && replay.type === request.type &&
            replay.fingerprint === requestFingerprint(request)) {
          return { proceed: false, response: replay.response, replayed: true };
        }
        return this.reject(request, "IPC_REPLAY_DETECTED", "A request sequence was reused with different content.");
      }
      if (request.requestSequence <= client.lastSequence || this.hasRequestId(client, request.id)) {
        return this.reject(request, "IPC_REPLAY_DETECTED", "A stale sequence or reused request identifier was rejected.");
      }
    }

    if (request.type === "protocol.negotiate") {
      if (!request.payload.supportedVersions.includes(IPC_SCHEMA_VERSION)) {
        return this.reject(request, "IPC_VERSION_UNSUPPORTED", `Protocol version ${IPC_SCHEMA_VERSION} is required.`);
      }
      if (!client && this.clients.size >= IPC_PROTOCOL_LIMITS.maximumClientInstances) {
        return this.reject(request, "IPC_QUEUE_FULL", "The daemon client-instance limit has been reached.");
      }
      return { proceed: true };
    }

    if (!client) {
      return this.reject(request, "IPC_NEGOTIATION_REQUIRED", "Negotiate this client instance before sending requests.");
    }
    if (client.selectedVersion !== request.version) {
      return this.reject(request, "IPC_VERSION_UNSUPPORTED", "The request version differs from the negotiated version.");
    }

    if (IPC_MESSAGE_DESCRIPTORS[request.type].sessionBound) {
      const payload = request.payload as { sessionId: string; sessionEpoch: number };
      const session = this.sessions.get(payload.sessionId);
      if (!session || session.clientInstanceId !== request.clientInstanceId) {
        return this.reject(request, "IPC_SESSION_UNKNOWN", "The session is not live for this client instance.");
      }
      if (session.epoch !== payload.sessionEpoch) {
        return this.reject(request, "IPC_SESSION_STALE", "The session epoch is stale.");
      }
      session.lastSeenAt = this.now();
    }

    return { proceed: true };
  }

  remember(request: AnyTypedIpcRequest, response: IpcResponse): void {
    let client = this.clients.get(request.clientInstanceId);
    if (!client && request.type === "protocol.negotiate" && response.ok) {
      client = {
        selectedVersion: IPC_SCHEMA_VERSION,
        lastSequence: 0,
        lastSeenAt: this.now(),
        replayBySequence: new Map()
      };
      this.clients.set(request.clientInstanceId, client);
    } else if (client && request.type === "protocol.negotiate" && response.ok) {
      this.retireClientSessions(request.clientInstanceId);
      client.replayBySequence.clear();
    }
    if (!client) return;

    client.lastSequence = Math.max(client.lastSequence, request.requestSequence);
    client.lastSeenAt = this.now();
    client.replayBySequence.set(request.requestSequence, {
      id: request.id,
      type: request.type,
      fingerprint: requestFingerprint(request),
      response
    });
    while (client.replayBySequence.size > IPC_PROTOCOL_LIMITS.maximumReplayEntriesPerClient) {
      const oldest = client.replayBySequence.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      client.replayBySequence.delete(oldest);
    }
  }

  openSession(clientInstanceId: string, sessionId: string): number {
    if (!this.clients.has(clientInstanceId)) throw new Error("Cannot open a session for an unnegotiated client.");
    if (this.sessions.size >= IPC_PROTOCOL_LIMITS.maximumActiveSessions) {
      throw new Error("IPC active-session capacity is exhausted.");
    }
    if (this.sessions.has(sessionId)) throw new Error("IPC engine returned a duplicate live session identifier.");
    if (this.nextSessionEpoch >= Number.MAX_SAFE_INTEGER) throw new Error("Session epoch space is exhausted.");
    const epoch = this.nextSessionEpoch++;
    this.sessions.set(sessionId, { clientInstanceId, epoch, lastSeenAt: this.now() });
    return epoch;
  }

  closeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  reset(): void {
    this.sessions.clear();
    this.clients.clear();
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get hasSessionCapacity(): boolean {
    return this.sessions.size < IPC_PROTOCOL_LIMITS.maximumActiveSessions;
  }

  private cleanupExpiredClients(): void {
    const now = this.now();
    const expiredClients = new Set<string>();
    for (const [clientInstanceId, client] of this.clients) {
      if (now - client.lastSeenAt >= this.clientIdleTtlMs) {
        this.clients.delete(clientInstanceId);
        expiredClients.add(clientInstanceId);
      }
    }
    if (expiredClients.size === 0) return;
    for (const clientInstanceId of expiredClients) {
      this.retireClientSessions(clientInstanceId);
    }
  }

  private cleanupExpiredSessions(): void {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastSeenAt < this.clientIdleTtlMs) continue;
      this.sessions.delete(sessionId);
      try {
        this.onSessionExpired?.(sessionId);
      } catch {
        // Protocol state is already retired; engine cleanup cannot restore it.
      }
    }
  }

  private retireClientSessions(clientInstanceId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.clientInstanceId !== clientInstanceId) continue;
      this.sessions.delete(sessionId);
      try {
        this.onSessionExpired?.(sessionId);
      } catch {
        // Protocol state is already retired; engine cleanup cannot restore it.
      }
    }
  }

  private hasRequestId(client: ClientState, requestId: string): boolean {
    for (const entry of client.replayBySequence.values()) {
      if (entry.id === requestId) return true;
    }
    return false;
  }

  private reject(request: AnyTypedIpcRequest, code: IpcErrorCode, message: string): ProtocolPreflight {
    return {
      proceed: false,
      replayed: false,
      response: createIpcErrorResponse(request, { code, message }, undefined, {
        serverInstanceId: this.serverInstanceId
      })
    };
  }
}

function requestFingerprint(request: AnyTypedIpcRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
