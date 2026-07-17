import { describe, expect, it, vi } from "vitest";
import { createKeyboardEngine, defaultTypingContext } from "../../../src/engine/keyboard";
import { IPC_PROTOCOL_LIMITS, createIpcRequest } from "../../shared/ipc/messages";
import type { IpcMessageType, IpcPayloadByType, TypedIpcRequest } from "../../shared/ipc/messages";
import { KeyboardDaemon } from "./keyboardDaemon";

const NOW = 1_000;
const LIVE_DEADLINE = NOW + 50;

class ProtocolTestClient {
  private sequence = 0;

  constructor(readonly id: string) {}

  request<T extends IpcMessageType>(
    type: T,
    payload: IpcPayloadByType[T],
    requestId = `${this.id}_${type}_${this.sequence + 1}`,
    deadlineAt = LIVE_DEADLINE,
    sentAt = NOW
  ): TypedIpcRequest<T> {
    return createIpcRequest(type, payload, requestId, sentAt, {
      clientInstanceId: this.id,
      requestSequence: ++this.sequence,
      deadlineAt
    });
  }

  requestAtSequence<T extends IpcMessageType>(
    sequence: number,
    type: T,
    payload: IpcPayloadByType[T],
    requestId: string,
    deadlineAt = LIVE_DEADLINE
  ): TypedIpcRequest<T> {
    this.sequence = Math.max(this.sequence, sequence);
    return createIpcRequest(type, payload, requestId, NOW, {
      clientInstanceId: this.id,
      requestSequence: sequence,
      deadlineAt
    });
  }
}

async function negotiate(daemon: KeyboardDaemon, client: ProtocolTestClient, now = NOW) {
  return daemon.handle(client.request("protocol.negotiate", {
    client: "daemon-test",
    supportedVersions: [2]
  }, `${client.id}_negotiate`, now + IPC_PROTOCOL_LIMITS.controlDeadlineMs, now));
}

describe("IPC protocol v2 security state", () => {
  it("requires negotiation and returns canonical recovery guidance", async () => {
    const daemon = new KeyboardDaemon({ now: () => NOW, serverInstanceId: "server-a" });
    const client = new ProtocolTestClient("client-a");

    const response = await daemon.handle(client.request("health.check", { client: "daemon-test" }));

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      serverInstanceId: "server-a",
      error: {
        code: "IPC_NEGOTIATION_REQUIRED",
        message: expect.any(String),
        recoverable: true,
        action: "restartSession"
      }
    }));
  });

  it("negotiates once and replays an exact retry without duplicating state", async () => {
    const daemon = new KeyboardDaemon({ now: () => NOW, serverInstanceId: "server-a" });
    const client = new ProtocolTestClient("client-a");
    await expect(negotiate(daemon, client)).resolves.toEqual(expect.objectContaining({
      ok: true,
      payload: expect.objectContaining({
        selectedVersion: 2,
        serverInstanceId: "server-a",
        limits: expect.objectContaining({
          maximumClientInstances: IPC_PROTOCOL_LIMITS.maximumClientInstances,
          clientIdleTtlMs: IPC_PROTOCOL_LIMITS.clientIdleTtlMs
        })
      })
    }));

    const beginRequest = client.request("session.begin", { context: defaultTypingContext("romanized") }, "begin-once");
    const first = await daemon.handle(beginRequest);
    const retry = await daemon.handle(beginRequest);

    expect(retry).toEqual(first);
    expect(first.payload).toEqual(expect.objectContaining({ sessionId: expect.any(String), sessionEpoch: 1 }));
    expect(daemon.metrics().activeSessions).toBe(1);
  });

  it("rejects sequence and request-id replay while allowing an expired sequence to be retried", async () => {
    const daemon = new KeyboardDaemon({ now: () => NOW, serverInstanceId: "server-a" });
    const client = new ProtocolTestClient("client-a");
    await negotiate(daemon, client);

    const accepted = client.request("health.check", { client: "daemon-test" }, "health-once");
    await expect(daemon.handle(accepted)).resolves.toEqual(expect.objectContaining({ ok: true }));

    const reusedSequence = client.requestAtSequence(
      accepted.requestSequence,
      "health.check",
      { client: "daemon-test" },
      "health-different"
    );
    await expect(daemon.handle(reusedSequence)).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_REPLAY_DETECTED" })
    }));

    const expired = client.request("health.check", { client: "daemon-test" }, "expired", NOW - 1, NOW - 50);
    await expect(daemon.handle(expired)).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_DEADLINE_EXCEEDED", action: "passThrough" })
    }));
    const retriedDeadline = client.requestAtSequence(
      expired.requestSequence,
      "health.check",
      { client: "daemon-test" },
      "expired-retry"
    );
    await expect(daemon.handle(retriedDeadline)).resolves.toEqual(expect.objectContaining({ ok: true }));

    const reusedId = client.request("health.check", { client: "daemon-test" }, "health-once");
    await expect(daemon.handle(reusedId)).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_REPLAY_DETECTED" })
    }));
  });

  it("rejects stale and cross-client session epochs before engine mutation", async () => {
    const engine = createKeyboardEngine();
    const updateComposition = vi.spyOn(engine, "updateComposition");
    const daemon = new KeyboardDaemon({ engine, now: () => NOW, serverInstanceId: "server-a" });
    const owner = new ProtocolTestClient("owner");
    const stranger = new ProtocolTestClient("stranger");
    await negotiate(daemon, owner);
    await negotiate(daemon, stranger);

    const begin = await daemon.handle(owner.request("session.begin", {
      context: defaultTypingContext("romanized")
    }));
    const session = begin.payload as { sessionId: string; sessionEpoch: number };

    await expect(daemon.handle(owner.request("session.updateComposition", {
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch + 1,
      input: "ramro",
      cursor: 5
    }))).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SESSION_STALE" })
    }));
    expect(updateComposition).not.toHaveBeenCalled();

    await expect(daemon.handle(stranger.request("session.updateComposition", {
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      input: "ramro",
      cursor: 5
    }))).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SESSION_UNKNOWN" })
    }));
    expect(updateComposition).not.toHaveBeenCalled();
  });

  it("rejects a client that cannot negotiate the current protocol version", async () => {
    const daemon = new KeyboardDaemon({ now: () => NOW, serverInstanceId: "server-a" });
    const client = new ProtocolTestClient("legacy-client");
    const response = await daemon.handle(client.request("protocol.negotiate", {
      client: "daemon-test",
      supportedVersions: [1]
    }));

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_VERSION_UNSUPPORTED", action: "restartDaemon" })
    }));
  });

  it("expires idle client identities and retires every session they owned", async () => {
    let now = NOW;
    const engine = createKeyboardEngine();
    const endSession = vi.spyOn(engine, "endSession");
    const daemon = new KeyboardDaemon({ engine, now: () => now, serverInstanceId: "server-a" });
    const client = new ProtocolTestClient("idle-client");
    await negotiate(daemon, client, now);
    const begin = await daemon.handle(client.request(
      "session.begin",
      { context: defaultTypingContext("romanized") },
      "idle-session",
      now + 50,
      now
    ));
    const sessionId = (begin.payload as { sessionId: string }).sessionId;
    expect(daemon.metrics().activeSessions).toBe(1);

    now += IPC_PROTOCOL_LIMITS.clientIdleTtlMs;
    const expired = await daemon.handle(client.request(
      "health.check",
      { client: "daemon-test" },
      "after-idle-expiry",
      now + 50,
      now
    ));
    expect(expired).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_NEGOTIATION_REQUIRED" })
    }));
    expect(daemon.metrics().activeSessions).toBe(0);
    expect(endSession).toHaveBeenCalledWith(sessionId);
    await expect(negotiate(daemon, client, now)).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it("reclaims abandoned identities before admitting a new client at capacity", async () => {
    let now = NOW;
    const daemon = new KeyboardDaemon({ now: () => now, serverInstanceId: "server-a" });
    for (let index = 0; index < IPC_PROTOCOL_LIMITS.maximumClientInstances; index += 1) {
      await expect(negotiate(daemon, new ProtocolTestClient(`capacity-${index}`), now))
        .resolves.toEqual(expect.objectContaining({ ok: true }));
    }
    await expect(negotiate(daemon, new ProtocolTestClient("overflow"), now)).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_QUEUE_FULL" })
    }));

    now += IPC_PROTOCOL_LIMITS.clientIdleTtlMs;
    await expect(negotiate(daemon, new ProtocolTestClient("replacement"), now))
      .resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it("does not expose thrown engine details through IPC or diagnostics", async () => {
    const engine = createKeyboardEngine();
    vi.spyOn(engine, "getSuggestions").mockImplementation(() => {
      throw new Error("private typed fragment and local filesystem path");
    });
    const daemon = new KeyboardDaemon({ engine, now: () => NOW, serverInstanceId: "server-a" });
    const client = new ProtocolTestClient("failing-client");
    await negotiate(daemon, client);
    const response = await daemon.handle(client.request("suggestions.get", {
      context: defaultTypingContext("romanized")
    }));
    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "DAEMON_DISPATCH_FAILED",
        message: "The daemon request could not be completed."
      })
    }));
    expect(JSON.stringify(response)).not.toContain("private typed fragment");
    expect(daemon.metrics().lastError?.message).toBe("The daemon request could not be completed.");
  });
});
