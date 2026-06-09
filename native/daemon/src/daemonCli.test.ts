import { describe, expect, it } from "vitest";
import { defaultTypingContext } from "../../../src/engine/keyboard";
import { createIpcRequest } from "../../shared/ipc/messages";
import { createDaemonLineHandler } from "./lineProtocol";

describe("daemon CLI line protocol", () => {
  it("handles JSONL IPC requests and returns JSON responses", async () => {
    const handler = createDaemonLineHandler();
    const health = JSON.parse(
      await handler.handleLine(JSON.stringify(createIpcRequest("health.check", { client: "daemon-test" }, "health_1", 1)))
    );
    expect(health).toEqual(expect.objectContaining({ id: "health_1", ok: true, type: "health.check" }));

    const begin = JSON.parse(
      await handler.handleLine(
        JSON.stringify(createIpcRequest("session.begin", { context: defaultTypingContext("romanized") }, "begin_cli_1", 1))
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

    await handler.shutdown();
  });
});
