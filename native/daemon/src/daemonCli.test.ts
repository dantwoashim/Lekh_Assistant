import { describe, expect, it, vi } from "vitest";
import { createKeyboardEngine, defaultTypingContext } from "../../../src/engine/keyboard";
import { IPC_PROTOCOL_LIMITS, createIpcRequest } from "../../shared/ipc/messages";
import { MAX_IPC_LINE_BYTES, createDaemonLineHandler } from "./lineProtocol";
import { KeyboardDaemon } from "./keyboardDaemon";

describe("daemon CLI line protocol", () => {
  it("handles JSONL IPC requests and returns JSON responses", async () => {
    const fixedNow = Date.now();
    const handler = createDaemonLineHandler(new KeyboardDaemon({ now: () => fixedNow }));
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
    expect(parseError.error.message).toBe("IPC input was not valid JSON.");
    expect(JSON.stringify(parseError)).not.toContain("bad json");

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

  it("shuts the engine down directly and idempotently even when the client table is full", async () => {
    const now = 1_000;
    const engine = createKeyboardEngine();
    const shutdown = vi.spyOn(engine, "shutdown");
    const daemon = new KeyboardDaemon({ engine, now: () => now, serverInstanceId: "shutdown-test" });
    const handler = createDaemonLineHandler(daemon);
    for (let index = 0; index < IPC_PROTOCOL_LIMITS.maximumClientInstances; index += 1) {
      const response = await daemon.handle(createIpcRequest("protocol.negotiate", {
        client: "daemon-test",
        supportedVersions: [2]
      }, `fill-${index}`, now, {
        clientInstanceId: `shutdown-client-${index}`,
        requestSequence: 1,
        deadlineAt: now + IPC_PROTOCOL_LIMITS.controlDeadlineMs
      }));
      expect(response.ok).toBe(true);
    }

    await Promise.all([handler.shutdown(), handler.shutdown()]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
