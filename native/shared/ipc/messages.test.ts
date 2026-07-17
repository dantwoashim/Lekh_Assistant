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
      version: 2,
      ok: false,
      error: { code: "", message: "", recoverable: "yes" }
    };
    const result = validateIpcEnvelope(malformed);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "id must be a non-empty string.",
        "type must be a known IPC message type.",
        "version must be 1."
      ])
    );
  });
});
