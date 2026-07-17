import { describe, expect, it, vi } from "vitest";
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

async function beginSession(daemon: KeyboardDaemon, fieldType: "normal" | "password" | "code" | "unknown" = "normal"): Promise<string> {
  const response = await daemon.handle(createIpcRequest("session.begin", {
    context: {
      ...defaultTypingContext("romanized"),
      fieldType,
      leftTextWindow: "private surrounding context"
    }
  }, `begin-${fieldType}`, 1));
  return (response.payload as { sessionId: string }).sessionId;
}

async function commitCandidate(daemon: KeyboardDaemon, sessionId: string, input: string): Promise<number> {
  const update = await daemon.handle(createIpcRequest(
    "session.updateComposition",
    { sessionId, input, cursor: input.length },
    `update-${input}`,
    1
  ));
  const candidateId = (update.payload as { primary?: { id: string } }).primary?.id;
  expect(candidateId).toEqual(expect.any(String));
  const commit = await daemon.handle(createIpcRequest(
    "session.commitCandidate",
    { sessionId, candidateId: candidateId! },
    `commit-${input}`,
    1
  ));
  expect(commit).toEqual(expect.objectContaining({ ok: true }));
  return (commit.payload as { commitEpoch: number }).commitEpoch;
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

    const metrics = await daemon.handle(createIpcRequest("diagnostics.getMetrics", null, "metrics_1", 1));
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
      daemon.handle(createIpcRequest("engine.shutdown", null, "shutdown_1", 1))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { shutdown: true } }));
  });

  it("returns recoverable errors for malformed envelopes and supports hot-path fallback", async () => {
    const daemon = new KeyboardDaemon();
    const malformed = await daemon.handle({ id: "", type: "session.fake", version: 1, sentAt: 1, payload: {} });
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

  it("authorizes memory receipts once for a live non-secure commit and rejects injected context", async () => {
    const daemon = new KeyboardDaemon();
    const sessionId = await beginSession(daemon);
    const commitEpoch = await commitCandidate(daemon, sessionId, "ramro");

    const accepted = await daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId, commitEpoch },
      "memory-valid",
      1
    ));
    expect(accepted).toEqual(expect.objectContaining({ ok: true, payload: { learned: true } }));

    const replayed = await daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId, commitEpoch },
      "memory-replayed",
      1
    ));
    expect(replayed).toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const injected = await daemon.handle({
      id: "memory-injected-context",
      type: "memory.learn",
      version: 1,
      sentAt: 1,
      payload: {
        sessionId,
        commitEpoch,
        context: { leftWindow: "attacker supplied", rightWindow: "attacker supplied" }
      }
    });
    expect(injected).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SCHEMA_INVALID", recoverable: true })
    }));
  });

  it("rejects stale, missing, ended, and unknown memory-learning sessions", async () => {
    const daemon = new KeyboardDaemon();
    const sessionId = await beginSession(daemon);
    const staleEpoch = await commitCandidate(daemon, sessionId, "ramro");
    const currentEpoch = await commitCandidate(daemon, sessionId, "swasthya");

    await expect(daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId, commitEpoch: staleEpoch },
      "memory-stale",
      1
    ))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    await expect(daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId: "missing-session", commitEpoch: 1 },
      "memory-unknown",
      1
    ))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const malformed = await daemon.handle({
      id: "memory-missing-session-id",
      type: "memory.learn",
      version: 1,
      sentAt: 1,
      payload: { commitEpoch: currentEpoch }
    });
    expect(malformed).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SCHEMA_INVALID" })
    }));

    await daemon.handle(createIpcRequest("session.end", { sessionId }, "end-memory-session", 1));
    await expect(daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId, commitEpoch: currentEpoch },
      "memory-ended",
      1
    ))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));
  });

  it("rejects memory learning for secure, unknown, and unclassified fields", async () => {
    for (const fieldType of ["password", "code", "unknown"] as const) {
      const daemon = new KeyboardDaemon();
      const sessionId = await beginSession(daemon, fieldType);
      const response = await daemon.handle(createIpcRequest(
        "memory.learn",
        { sessionId, commitEpoch: 1 },
        `memory-${fieldType}`,
        1
      ));
      expect(response, fieldType).toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));
    }

    const secureInputDaemon = new KeyboardDaemon();
    const secureInputBegin = await secureInputDaemon.handle(createIpcRequest("session.begin", {
      context: { ...defaultTypingContext("romanized"), fieldType: "normal", secureInput: true }
    }, "begin-secure-input", 1));
    const secureInputSessionId = (secureInputBegin.payload as { sessionId: string }).sessionId;
    await expect(secureInputDaemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId: secureInputSessionId, commitEpoch: 1 },
      "memory-secure-input",
      1
    ))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const daemon = new KeyboardDaemon();
    const begin = await daemon.handle(createIpcRequest("session.begin", {
      context: defaultTypingContext("romanized")
    }, "begin-unclassified", 1));
    const sessionId = (begin.payload as { sessionId: string }).sessionId;
    const commitEpoch = await commitCandidate(daemon, sessionId, "ramro");
    const response = await daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId, commitEpoch },
      "memory-unclassified",
      1
    ));
    expect(response).toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const retry = await daemon.handle(createIpcRequest(
      "session.updateComposition",
      { sessionId, input: "ramro", cursor: 5 },
      "retry-unclassified",
      1
    ));
    expect((retry.payload as { candidates: Array<{ type: string }> }).candidates)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "personal" })]));
  });

  it("returns a grapheme-boundary caret through session.updateComposition IPC", async () => {
    const daemon = new KeyboardDaemon();
    const begin = await daemon.handle(createIpcRequest("session.begin", {
      context: { ...defaultTypingContext("traditional"), fieldType: "normal" }
    }, "begin-grapheme", 1));
    const sessionId = (begin.payload as { sessionId: string }).sessionId;

    const response = await daemon.handle(createIpcRequest(
      "session.updateComposition",
      { sessionId, input: "कि", cursor: 1 },
      "update-grapheme",
      1
    ));

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      payload: expect.objectContaining({ compositionText: "कि", caret: 0 })
    }));
  });

  it("rejects malformed hot-path payloads before engine calls or diagnostics mutation", async () => {
    const engine = createKeyboardEngine();
    const processKeyStroke = vi.spyOn(engine, "processKeyStroke");
    const daemon = new KeyboardDaemon({ engine });

    const response = await daemon.handle({
      id: "malformed-key",
      type: "session.processKeyStroke",
      version: 1,
      sentAt: 1,
      payload: {
        sessionId: "session-1",
        key: { key: "r", code: "KeyR", modifiers: { shift: false }, timestamp: 1 }
      }
    });

    expect(response).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SCHEMA_INVALID", recoverable: true })
    }));
    expect(processKeyStroke).not.toHaveBeenCalled();
    expect(daemon.metrics().counters.processedKeystrokes).toBe(0);
  });
});
