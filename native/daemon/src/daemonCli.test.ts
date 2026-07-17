import { describe, expect, it } from "vitest";
import { defaultTypingContext } from "../../../src/engine/keyboard";
import { createIpcRequest } from "../../shared/ipc/messages";
import { MAX_IPC_LINE_BYTES, createDaemonLineHandler } from "./lineProtocol";

describe("daemon CLI line protocol", () => {
  it("handles JSONL IPC requests and returns JSON responses", async () => {
    const handler = createDaemonLineHandler();
    const negotiation = JSON.parse(
      await handler.handleLine(JSON.stringify(createIpcRequest("protocol.negotiate", {
        client: "daemon-test",
        supportedVersions: [2]
      }, "negotiate_1")))
    );
    expect(negotiation).toEqual(expect.objectContaining({ id: "negotiate_1", ok: true, type: "protocol.negotiate" }));

    const health = JSON.parse(
      await handler.handleLine(JSON.stringify(createIpcRequest("health.check", { client: "daemon-test" }, "health_1")))
    );
    expect(health).toEqual(expect.objectContaining({ id: "health_1", ok: true, type: "health.check" }));

    const begin = JSON.parse(
      await handler.handleLine(
        JSON.stringify(createIpcRequest("session.begin", { context: defaultTypingContext("romanized") }, "begin_cli_1"))
      )
    );
    expect(begin).toEqual(expect.objectContaining({ ok: true, type: "session.begin" }));
    expect(begin.payload.sessionId).toEqual(expect.any(String));

    await handler.shutdown();
  });

  it("returns recoverable JSON errors for malformed lines", async () => {
    const handler = createDaemonLineHandler();
    const parseError = JSON.parse(await handler.handleLine("{bad json"));
    expect(parseError).toEqual(expect.objectContaining({ ok: false, type: "health.check" }));
    expect(parseError.error).toEqual(expect.objectContaining({ code: "IPC_JSON_PARSE_FAILED", recoverable: true }));

    const empty = JSON.parse(await handler.handleLine(" "));
    expect(empty.error).toEqual(expect.objectContaining({ code: "IPC_EMPTY_LINE", recoverable: true }));

    const invalidPayload = JSON.parse(await handler.handleLine(JSON.stringify({
      id: "invalid_payload",
      type: "session.setMode",
      version: 1,
      sentAt: 1,
      payload: { sessionId: "session-1", mode: "invented" }
    })));
    expect(invalidPayload).toEqual(expect.objectContaining({ id: "invalid_payload", ok: false, type: "session.setMode" }));
    expect(invalidPayload.error).toEqual(expect.objectContaining({ code: "IPC_SCHEMA_INVALID", recoverable: true }));

    await handler.shutdown();
  });

  it("rejects oversized JSONL payloads before parsing", async () => {
    const handler = createDaemonLineHandler();
    const oversized = "x".repeat(MAX_IPC_LINE_BYTES + 1);
    const response = JSON.parse(await handler.handleLine(oversized));
    expect(response).toEqual(expect.objectContaining({ ok: false, type: "health.check" }));
    expect(response.error).toEqual(expect.objectContaining({ code: "IPC_PAYLOAD_TOO_LARGE", recoverable: true }));

    await handler.shutdown();
  });
});
