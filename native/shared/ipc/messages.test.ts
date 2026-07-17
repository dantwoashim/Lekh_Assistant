import { describe, expect, it } from "vitest";
import {
  createIpcErrorResponse,
  createIpcRequest,
  createIpcResponse,
  validateIpcEnvelope
} from "./messages";

describe("native IPC message contract", () => {
  it("creates valid success and recoverable error responses", () => {
    const request = createIpcRequest("health.check", { client: "daemon-test" }, "health_1", 1);
    const success = createIpcResponse(request, {
      status: "ok",
      engineReady: true,
      warnings: []
    });
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
        "id must be a non-empty string.",
        "type must be a known IPC message type.",
        "version must be 2."
      ])
    );
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
        hotPathDeadlineMs: 50,
        maximumPendingRequestsPerConnection: 32
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
        "session-bound success response must include a positive sessionEpoch."
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
