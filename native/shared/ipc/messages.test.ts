import { describe, expect, it } from "vitest";
import {
  IPC_MESSAGE_DESCRIPTORS,
  IPC_PROTOCOL_LIMITS,
  createIpcErrorResponse,
  createIpcRequest,
  createIpcResponse,
  validateIpcEnvelope
} from "./messages";

describe("native IPC message contract", () => {
  it("classifies terminal session retirement as off-hot-path control work", () => {
    for (const type of ["session.cancel", "session.end"] as const) {
      expect(IPC_MESSAGE_DESCRIPTORS[type].deadlineClass).toBe("control");
      const request = createIpcRequest(type, { sessionId: "retire-1", sessionEpoch: 1 }, `${type}-control`, 100);
      expect(request.deadlineAt - request.sentAt).toBe(IPC_PROTOCOL_LIMITS.controlDeadlineMs);
      expect(validateIpcEnvelope(request)).toEqual({ ok: true, errors: [] });
    }
  });

  it("creates valid success and recoverable error responses", () => {
    const request = createIpcRequest("health.check", { client: "daemon-test" }, "health_1", 1);
    const success = createIpcResponse(request, {
      status: "ok",
      engineReady: true,
      warnings: []
    }, undefined, { serverInstanceId: "server-1" });
    expect(validateIpcEnvelope(success)).toEqual({ ok: true, errors: [] });

    const failure = createIpcErrorResponse(request, {
      code: "IPC_TIMEOUT",
      message: "Hot path request exceeded 50ms and must pass through.",
      recoverable: true
    });
    expect(validateIpcEnvelope(failure)).toEqual({ ok: true, errors: [] });
  });

  it("rejects malformed envelopes before native shells trust them", () => {
    const malformed = {
      id: "",
      type: "session.fake",
      version: 1,
      ok: false,
      error: { code: "", message: "", recoverable: "yes" }
    };
    const result = validateIpcEnvelope(malformed);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "id must be a bounded non-empty string.",
        "type must be a known IPC message type.",
        "version must be 2."
      ])
    );
  });

  it("rejects oversized identities and ambiguous error metadata", () => {
    const request = createIpcRequest("health.check", { client: "daemon-test" }, "bounded-response", 1);
    const response = createIpcErrorResponse(request, {
      code: "IPC_SCHEMA_INVALID",
      message: "invalid"
    });
    expect(validateIpcEnvelope({
      ...response,
      id: "x".repeat(IPC_PROTOCOL_LIMITS.maximumIdentifierLength + 1)
    }).ok).toBe(false);
    expect(validateIpcEnvelope({
      ...response,
      error: { ...response.error, typedFragment: "must-not-be-accepted" }
    }).ok).toBe(false);
    expect(validateIpcEnvelope({ ...response, latencyMs: Number.POSITIVE_INFINITY }).ok).toBe(false);
  });

  it("rejects malformed UTF-16 in request and response envelope strings", () => {
    const request = createIpcRequest("health.check", { client: "daemon-test" }, "well-formed", 1);
    const failure = createIpcErrorResponse(request, {
      code: "IPC_SCHEMA_INVALID",
      message: "invalid"
    }, undefined, { serverInstanceId: "server-1" });

    for (const malformed of [
      { ...request, id: "\ud800" },
      { ...request, clientInstanceId: "\udc00" },
      { ...failure, id: "response-\ud800" },
      { ...failure, serverInstanceId: "server-\udc00" },
      { ...failure, error: { ...failure.error, message: "broken-\ud800" } }
    ]) {
      expect(validateIpcEnvelope(malformed).ok).toBe(false);
    }
  });

  it("binds negotiated server identity and session epochs without response ambiguity", () => {
    const negotiation = createIpcRequest("protocol.negotiate", {
      client: "daemon-test",
      supportedVersions: [2]
    });
    const splitIdentity = createIpcResponse(negotiation, {
      selectedVersion: 2,
      serverInstanceId: "payload-server",
      limits: {
        maximumFrameBytes: 65536,
        maximumCompositionLength: IPC_PROTOCOL_LIMITS.maximumCompositionLength,
        hotPathDeadlineMs: 50,
        maximumPendingRequestsPerConnection: 32,
        maximumClientInstances: 64,
        maximumActiveSessions: 64,
        clientIdleTtlMs: 1_800_000
      }
    }, undefined, { serverInstanceId: "envelope-server" });
    expect(validateIpcEnvelope(splitIdentity)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "protocol negotiation payload must bind the selected version and server instance."
      ])
    }));

    const sessionSuccessWithoutEpoch = {
      id: "key-1",
      type: "session.processKeyStroke",
      version: 2,
      ok: true,
      serverInstanceId: "server-1",
      requestSequence: 1,
      payload: {}
    };
    expect(validateIpcEnvelope(sessionSuccessWithoutEpoch)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "session-bearing success response must include a positive sessionEpoch."
      ])
    }));

    expect(validateIpcEnvelope({
      ...successEnvelopeFixture("health.check"),
      sessionEpoch: 1,
      payload: { status: "ok", engineReady: true, warnings: [] }
    })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "non-session success response must not include sessionEpoch."
      ])
    }));

    expect(validateIpcEnvelope({
      ...successEnvelopeFixture("health.check"),
      requestSequence: 0,
      payload: { status: "ok", engineReady: true, warnings: [] }
    })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "success response requestSequence must be a positive safe integer."
      ])
    }));

    const beginSuccessWithoutEpoch = {
      id: "begin-1",
      type: "session.begin",
      version: 2,
      ok: true,
      serverInstanceId: "server-1",
      requestSequence: 2,
      payload: { sessionId: "session-1", sessionEpoch: 1 }
    };
    expect(validateIpcEnvelope(beginSuccessWithoutEpoch)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "session-bearing success response must include a positive sessionEpoch."
      ])
    }));

    const ambiguousError = {
      ...createIpcErrorResponse(negotiation, {
        code: "IPC_TIMEOUT",
        message: "deadline"
      }),
      payload: {}
    };
    expect(validateIpcEnvelope(ambiguousError)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining(["error response must not include payload."])
    }));
  });
});

function successEnvelopeFixture(type: "health.check") {
  return {
    id: "success-fixture",
    type,
    version: 2,
    ok: true,
    serverInstanceId: "server-1",
    requestSequence: 1
  } as const;
}
