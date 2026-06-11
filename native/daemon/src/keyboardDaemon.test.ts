import { describe, expect, it } from "vitest";
import { createKeyboardEngine, defaultTypingContext } from "../../../src/engine/keyboard";
import { createIpcRequest } from "../../shared/ipc/messages";
import { KeyboardDaemon } from "./keyboardDaemon";

function key(value: string) {
  return {
    key: value,
    code: value === " " ? "Space" : `Key${value.toUpperCase()}`,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    timestamp: 1,
    platform: "test" as const
  };
}

describe("KeyboardDaemon IPC dispatcher", () => {
  it("warms the engine, begins a session, processes keys, and returns diagnostics", async () => {
    const daemon = new KeyboardDaemon({ now: () => 10 });
    const warm = await daemon.handle(createIpcRequest("engine.warm", { timeoutMs: 50 }, "warm_1", 1));
    expect(warm.ok).toBe(true);
    expect(warm.payload).toEqual(expect.objectContaining({ ready: true }));

    const begin = await daemon.handle(
      createIpcRequest("session.begin", { context: defaultTypingContext("romanized") }, "begin_1", 1)
    );
    expect(begin.ok).toBe(true);
    const sessionId = (begin.payload as { sessionId: string }).sessionId;

    for (const char of "swas") {
      const update = await daemon.handle(
        createIpcRequest("session.processKeyStroke", { sessionId, key: key(char) }, `key_${char}`, 1)
      );
      expect(update.ok).toBe(true);
    }

    const metrics = await daemon.handle(createIpcRequest("diagnostics.getMetrics", undefined, "metrics_1", 1));
    expect(metrics.ok).toBe(true);
    expect(metrics.payload).toEqual(
      expect.objectContaining({
        warmReady: true,
        activeSessions: 1,
        counters: expect.objectContaining({ processedKeystrokes: 4 })
      })
    );
  });

  it("dispatches dictionary, proofread, mode, layout, cancel, end, and shutdown messages", async () => {
    const daemon = new KeyboardDaemon();
    const begin = await daemon.handle(
      createIpcRequest("session.begin", { context: defaultTypingContext("romanized") }, "begin_2", 1)
    );
    const sessionId = (begin.payload as { sessionId: string }).sessionId;

    await expect(
      daemon.handle(createIpcRequest("session.setMode", { sessionId, mode: "traditional" }, "mode_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { mode: "traditional" } }));
    await expect(
      daemon.handle(createIpcRequest("session.setLayout", { sessionId, layoutId: "traditional-ltk-compatible.pending" }, "layout_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { layoutId: "traditional-ltk-compatible.pending" } }));
    await expect(
      daemon.handle(createIpcRequest("dictionary.lookup", { query: "swasthya" }, "dict_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      daemon.handle(createIpcRequest("proofHints.get", { textWindow: "सवस्थ्य" }, "proof_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      daemon.handle(createIpcRequest("session.cancel", { sessionId }, "cancel_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { cancelled: true } }));
    await expect(
      daemon.handle(createIpcRequest("session.end", { sessionId }, "end_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { ended: true } }));
    await expect(
      daemon.handle(createIpcRequest("engine.shutdown", undefined, "shutdown_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { shutdown: true } }));
  });

  it("returns recoverable errors for malformed envelopes and supports hot-path fallback", async () => {
    const daemon = new KeyboardDaemon();
    const malformed = await daemon.handle({ id: "", type: "session.fake", version: 1, sentAt: 1, payload: {} } as never);
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toEqual(expect.objectContaining({ code: "IPC_SCHEMA_INVALID", recoverable: true }));

    const fallback = await daemon.withHotPathTimeout(new Promise<string>((resolve) => setTimeout(() => resolve("late"), 20)), 1, "pass-through");
    expect(fallback).toEqual({ timedOut: true, value: "pass-through" });
    const metrics = daemon.metrics();
    expect(metrics.counters.ipcTimeouts).toBe(1);
    expect(metrics.counters.passThroughFallbacks).toBe(1);
  });

  it("wraps native hot-path keystrokes with pass-through timeout fallback", async () => {
    const engine = createKeyboardEngine();
    engine.processKeyStroke = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ action: "compose" }), 75);
      }) as never;
    const daemon = new KeyboardDaemon({ engine });
    const response = await daemon.handle(
      createIpcRequest("session.processKeyStroke", { sessionId: "slow-session", key: key("s") }, "slow_key_1", 1)
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual(
      expect.objectContaining({
        action: "passThrough",
        warnings: ["Native hot path exceeded 50ms; passing key through."]
      })
    );
    expect(daemon.metrics().counters).toEqual(expect.objectContaining({ ipcTimeouts: 1, passThroughFallbacks: 1 }));
  });
});
