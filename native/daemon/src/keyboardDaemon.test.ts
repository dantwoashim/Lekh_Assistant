import { describe, expect, it, vi } from "vitest";
import { createKeyboardEngine, defaultTypingContext } from "../../../src/engine/keyboard";
import { IPC_PROTOCOL_LIMITS, createIpcRequest } from "../../shared/ipc/messages";
import { validateIpcResponse } from "../../shared/ipc/responseValidation";
import { KeyboardDaemon } from "./keyboardDaemon";

const negotiatedDaemons = new WeakSet<KeyboardDaemon>();
const sessionEpochs = new Map<string, number>();

async function ensureNegotiated(daemon: KeyboardDaemon): Promise<void> {
  if (negotiatedDaemons.has(daemon)) return;
  const response = await daemon.handle(createIpcRequest("protocol.negotiate", {
    client: "daemon-test",
    supportedVersions: [2]
  }));
  expect(response).toEqual(expect.objectContaining({ ok: true }));
  negotiatedDaemons.add(daemon);
}

function trackSession(response: { payload?: unknown }): string {
  const payload = response.payload as { sessionId: string; sessionEpoch: number };
  sessionEpochs.set(payload.sessionId, payload.sessionEpoch);
  return payload.sessionId;
}

function sessionReference(sessionId: string): { sessionId: string; sessionEpoch: number } {
  const sessionEpoch = sessionEpochs.get(sessionId);
  if (!sessionEpoch) throw new Error(`Missing test session epoch for ${sessionId}`);
  return { sessionId, sessionEpoch };
}

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
  await ensureNegotiated(daemon);
  const warm = await daemon.handle(createIpcRequest("engine.warm", { timeoutMs: 50 }));
  expect(warm).toEqual(expect.objectContaining({ ok: true, payload: expect.objectContaining({ ready: true }) }));
  const response = await daemon.handle(createIpcRequest("session.begin", {
    context: {
      ...defaultTypingContext("romanized"),
      fieldType,
      leftTextWindow: "private surrounding context"
    }
  }, `begin-${fieldType}`));
  return trackSession(response);
}

async function commitCandidate(daemon: KeyboardDaemon, sessionId: string, input: string): Promise<number> {
  const update = await daemon.handle(createIpcRequest(
    "session.updateComposition",
    { ...sessionReference(sessionId), input, cursor: input.length },
    `update-${input}`
  ));
  const candidateId = (update.payload as { primary?: { id: string } }).primary?.id;
  expect(candidateId).toEqual(expect.any(String));
  const commit = await daemon.handle(createIpcRequest(
    "session.commitCandidate",
    { ...sessionReference(sessionId), candidateId: candidateId! },
    `commit-${input}`
  ));
  expect(commit).toEqual(expect.objectContaining({ ok: true }));
  return (commit.payload as { commitEpoch: number }).commitEpoch;
}

describe("KeyboardDaemon IPC dispatcher", () => {
  it("warms the engine, begins a session, processes keys, and returns diagnostics", async () => {
    const daemon = new KeyboardDaemon({ now: () => 10 });
    await ensureNegotiated(daemon);
    const warm = await daemon.handle(createIpcRequest("engine.warm", { timeoutMs: 50 }, "warm_1"));
    expect(warm.ok).toBe(true);
    expect(warm.payload).toEqual(expect.objectContaining({ ready: true }));

    const begin = await daemon.handle(
      createIpcRequest("session.begin", { context: defaultTypingContext("romanized") }, "begin_1")
    );
    expect(begin.ok).toBe(true);
    const sessionId = trackSession(begin);

    for (const [index, char] of [..."swas"].entries()) {
      const update = await daemon.handle(
        createIpcRequest("session.processKeyStroke", { ...sessionReference(sessionId), key: key(char) }, `key_${index}_${char}`)
      );
      expect(update.ok).toBe(true);
    }

    const metrics = await daemon.handle(createIpcRequest("diagnostics.getMetrics", null, "metrics_1"));
    expect(metrics.ok).toBe(true);
    expect(metrics.payload).toEqual(
      expect.objectContaining({
        warmReady: true,
        activeSessions: 1,
        counters: expect.objectContaining({ processedKeystrokes: 4 })
      })
    );
  });

  it("preserves the raw Windows Romanized Space contract across the daemon boundary", async () => {
    const daemon = new KeyboardDaemon({ now: () => 10, serverInstanceId: "windows-space-trace" });
    const handleValidated = async (request: unknown) => {
      const response = await daemon.handle(request);
      expect(validateIpcResponse(response)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
      return response;
    };

    await handleValidated(createIpcRequest("protocol.negotiate", {
      client: "windows-tsf",
      supportedVersions: [2]
    }, "windows-space-negotiate"));
    const warm = await handleValidated(createIpcRequest("engine.warm", { timeoutMs: 50 }, "windows-space-warm"));
    expect(warm).toEqual(expect.objectContaining({ ok: true, payload: expect.objectContaining({ ready: true }) }));

    const begin = await handleValidated(createIpcRequest("session.begin", {
      context: defaultTypingContext("romanized-traditional")
    }, "windows-space-begin"));
    const beginPayload = begin.payload as { sessionId: string; sessionEpoch: number };
    const liveSession = {
      sessionId: beginPayload.sessionId,
      sessionEpoch: beginPayload.sessionEpoch
    };

    const typeKey = async (value: string, trace: string) => handleValidated(createIpcRequest(
      "session.processKeyStroke",
      { ...liveSession, key: key(value) },
      `windows-space-${trace}`
    ));

    for (const [index, char] of [..."swasthya"].entries()) {
      const response = await typeKey(char, `authorized-${index}-${char}`);
      expect(response.sessionEpoch).toBe(liveSession.sessionEpoch);
    }
    const terminal = await typeKey(" ", "authorized-delimiter");

    expect(terminal.sessionEpoch).toBe(liveSession.sessionEpoch);
    expect(terminal.payload).toEqual(expect.objectContaining({
      action: "commit",
      committedText: "swasthya ",
      compositionText: "",
      displayText: "",
      caret: 0,
      candidates: [],
      proofHints: [],
      shouldShowCandidateUI: false
    }));
    expect(terminal.payload).not.toHaveProperty("primary");
    expect(terminal.payload).not.toHaveProperty("inlineCompletion");
    expect(terminal.payload).not.toHaveProperty("commitEpoch");
    expect(terminal.payload).not.toHaveProperty("memoryRecorded");

    const unauthorizedLearning = await handleValidated(createIpcRequest("memory.learn", {
      ...liveSession,
      commitEpoch: 1
    }, "windows-space-raw-learning"));
    expect(unauthorizedLearning).toEqual(expect.objectContaining({
      ok: true,
      sessionEpoch: liveSession.sessionEpoch,
      payload: { learned: false }
    }));

    for (const [index, char] of [..."swas"].entries()) {
      await typeKey(char, `unauthorized-${index}-${char}`);
    }
    const rawTerminal = await typeKey(" ", "unauthorized-delimiter");
    expect(rawTerminal.sessionEpoch).toBe(liveSession.sessionEpoch);
    expect(rawTerminal.payload).toEqual(expect.objectContaining({
      action: "commit",
      committedText: "swas ",
      compositionText: "",
      displayText: "",
      candidates: [],
      proofHints: [],
      shouldShowCandidateUI: false
    }));
  });

  it("dispatches dictionary, proofread, mode, layout, cancel, end, and shutdown messages", async () => {
    const daemon = new KeyboardDaemon();
    const sessionId = await beginSession(daemon);

    await expect(
      daemon.handle(createIpcRequest("session.setMode", { ...sessionReference(sessionId), mode: "traditional" }, "mode_1"))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { mode: "traditional" } }));
    await expect(
      daemon.handle(createIpcRequest("session.setLayout", { ...sessionReference(sessionId), layoutId: "traditional-ltk-compatible.pending" }, "layout_1"))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { layoutId: "traditional-ltk-compatible.pending" } }));
    await expect(
      daemon.handle(createIpcRequest("dictionary.lookup", { query: "swasthya" }, "dict_1"))
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      daemon.handle(createIpcRequest("proofHints.get", { textWindow: "सवस्थ्य" }, "proof_1"))
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      daemon.handle(createIpcRequest("session.cancel", sessionReference(sessionId), "cancel_1"))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { cancelled: true } }));
    await expect(
      daemon.handle(createIpcRequest("session.end", sessionReference(sessionId), "end_1"))
    ).resolves.toEqual(expect.objectContaining({ ok: true, payload: { ended: true } }));
    await expect(
      daemon.handle(createIpcRequest("engine.shutdown", null, "shutdown_1"))
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
    const sessionId = await beginSession(daemon);
    const response = await daemon.handle(
      createIpcRequest("session.processKeyStroke", { ...sessionReference(sessionId), key: key("s") }, "slow_key_1")
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual(
      expect.objectContaining({
        action: "passThrough",
        warnings: ["Native hot path exceeded its deadline; passing key through."]
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
      { ...sessionReference(sessionId), commitEpoch },
      "memory-valid"
    ));
    expect(accepted).toEqual(expect.objectContaining({ ok: true, payload: { learned: true } }));

    const replayed = await daemon.handle(createIpcRequest(
      "memory.learn",
      { ...sessionReference(sessionId), commitEpoch },
      "memory-replayed"
    ));
    expect(replayed).toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const injected = await daemon.handle({
      ...createIpcRequest("memory.learn", { ...sessionReference(sessionId), commitEpoch }, "memory-injected-context"),
      payload: {
        ...sessionReference(sessionId),
        commitEpoch,
        context: { leftWindow: "attacker supplied", rightWindow: "attacker supplied" }
      }
    });
    expect(injected).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SCHEMA_INVALID", recoverable: true })
    }));
  });

  it("purges deferred memory when candidate publication times out", async () => {
    const engine = createKeyboardEngine();
    const originalCommit = engine.commitCandidate.bind(engine);
    let actualCommitEpoch = 0;
    let selectedText = "";
    engine.commitCandidate = ((...args: Parameters<typeof originalCommit>) => {
      const committed = originalCommit(...args);
      actualCommitEpoch = committed.commitEpoch;
      selectedText = committed.committedText;
      return new Promise((resolve) => setTimeout(() => resolve(committed), 75));
    }) as never;
    const daemon = new KeyboardDaemon({ engine });
    const sessionId = await beginSession(daemon);
    const update = await daemon.handle(createIpcRequest(
      "session.updateComposition",
      { ...sessionReference(sessionId), input: "prabin", cursor: 6 },
      "timeout-learning-update"
    ));
    const candidates = (update.payload as { candidates: Array<{ id: string; text: string }> }).candidates;
    const primaryText = (update.payload as { primary?: { text: string } }).primary?.text;
    const alternate = candidates.find((candidate) => candidate.text !== primaryText);
    expect(alternate).toBeTruthy();

    const response = await daemon.handle(createIpcRequest(
      "session.commitCandidate",
      { ...sessionReference(sessionId), candidateId: alternate!.id },
      "timeout-learning-commit"
    ));
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      payload: expect.objectContaining({ action: "passThrough", memoryRecorded: false })
    }));
    expect(actualCommitEpoch).toBeGreaterThan(0);
    expect(engine.learnCommittedCorrection(sessionId, actualCommitEpoch)).toBe(false);

    const fresh = engine.beginSession({ ...defaultTypingContext("romanized"), fieldType: "normal" });
    expect(engine.updateComposition(fresh, "prabin", 6).candidates.some((candidate) => (
      candidate.type === "personal" && candidate.text === selectedText
    ))).toBe(false);
  });

  it("never echoes composition text in a timed-out fail-open response", async () => {
    const engine = createKeyboardEngine();
    const originalUpdate = engine.updateComposition.bind(engine);
    engine.updateComposition = ((...args: Parameters<typeof originalUpdate>) => (
      new Promise((resolve) => setTimeout(() => resolve(originalUpdate(...args)), 75))
    )) as never;
    const daemon = new KeyboardDaemon({ engine });
    const sessionId = await beginSession(daemon);
    const privateInput = "do-not-reflect-this-private-input";

    const response = await daemon.handle(createIpcRequest(
      "session.updateComposition",
      { ...sessionReference(sessionId), input: privateInput, cursor: privateInput.length },
      "private-timeout-update"
    ));
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      payload: expect.objectContaining({
        action: "passThrough",
        compositionText: "",
        displayText: "",
        caret: 0
      })
    }));
    expect(JSON.stringify(response)).not.toContain(privateInput);
  });

  it("rejects stale, missing, ended, and unknown memory-learning sessions", async () => {
    const daemon = new KeyboardDaemon();
    const sessionId = await beginSession(daemon);
    const staleEpoch = await commitCandidate(daemon, sessionId, "ramro");
    const currentEpoch = await commitCandidate(daemon, sessionId, "swasthya");

    await expect(daemon.handle(createIpcRequest(
      "memory.learn",
      { ...sessionReference(sessionId), commitEpoch: staleEpoch },
      "memory-stale"
    ))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    await expect(daemon.handle(createIpcRequest(
      "memory.learn",
      { sessionId: "missing-session", sessionEpoch: 1, commitEpoch: 1 },
      "memory-unknown"
    ))).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SESSION_UNKNOWN", action: "restartSession" })
    }));

    const malformed = await daemon.handle({
      ...createIpcRequest("memory.learn", { ...sessionReference(sessionId), commitEpoch: currentEpoch }, "memory-missing-session-id"),
      payload: { commitEpoch: currentEpoch }
    });
    expect(malformed).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SCHEMA_INVALID" })
    }));

    await daemon.handle(createIpcRequest("session.end", sessionReference(sessionId), "end-memory-session"));
    await expect(daemon.handle(createIpcRequest(
      "memory.learn",
      { ...sessionReference(sessionId), commitEpoch: currentEpoch },
      "memory-ended"
    ))).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "IPC_SESSION_UNKNOWN", action: "restartSession" })
    }));
  });

  it("rejects memory learning for secure, unknown, and unclassified fields", async () => {
    for (const fieldType of ["password", "code", "unknown"] as const) {
      const daemon = new KeyboardDaemon();
      const sessionId = await beginSession(daemon, fieldType);
      const response = await daemon.handle(createIpcRequest(
        "memory.learn",
        { ...sessionReference(sessionId), commitEpoch: 1 },
        `memory-${fieldType}`
      ));
      expect(response, fieldType).toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));
    }

    const secureInputDaemon = new KeyboardDaemon();
    await ensureNegotiated(secureInputDaemon);
    const secureInputBegin = await secureInputDaemon.handle(createIpcRequest("session.begin", {
      context: { ...defaultTypingContext("romanized"), fieldType: "normal", secureInput: true }
    }, "begin-secure-input"));
    const secureInputSessionId = trackSession(secureInputBegin);
    await expect(secureInputDaemon.handle(createIpcRequest(
      "memory.learn",
      { ...sessionReference(secureInputSessionId), commitEpoch: 1 },
      "memory-secure-input"
    ))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const daemon = new KeyboardDaemon();
    await ensureNegotiated(daemon);
    const unclassifiedContext = { ...defaultTypingContext("romanized") };
    delete unclassifiedContext.fieldType;
    const begin = await daemon.handle(createIpcRequest("session.begin", {
      context: unclassifiedContext
    }, "begin-unclassified"));
    const sessionId = trackSession(begin);
    const response = await daemon.handle(createIpcRequest(
      "memory.learn",
      { ...sessionReference(sessionId), commitEpoch: 1 },
      "memory-unclassified"
    ));
    expect(response).toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const retry = await daemon.handle(createIpcRequest(
      "session.updateComposition",
      { ...sessionReference(sessionId), input: "ramro", cursor: 5 },
      "retry-unclassified"
    ));
    expect(retry.payload).toEqual(expect.objectContaining({
      action: "passThrough",
      compositionText: "",
      candidates: []
    }));
  });

  it("returns a grapheme-boundary caret through session.updateComposition IPC", async () => {
    const daemon = new KeyboardDaemon();
    await ensureNegotiated(daemon);
    const begin = await daemon.handle(createIpcRequest("session.begin", {
      context: { ...defaultTypingContext("traditional"), fieldType: "normal" }
    }, "begin-grapheme"));
    const sessionId = trackSession(begin);

    const response = await daemon.handle(createIpcRequest(
      "session.updateComposition",
      { ...sessionReference(sessionId), input: "कि", cursor: 2 },
      "update-grapheme"
    ));

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      payload: expect.objectContaining({ compositionText: "कि", caret: 2 })
    }));
  });

  it("rejects malformed hot-path payloads before engine calls or diagnostics mutation", async () => {
    const engine = createKeyboardEngine();
    const processKeyStroke = vi.spyOn(engine, "processKeyStroke");
    const daemon = new KeyboardDaemon({ engine });
    await ensureNegotiated(daemon);

    const response = await daemon.handle({
      ...createIpcRequest("session.processKeyStroke", {
        sessionId: "session-1",
        sessionEpoch: 1,
        key: key("r")
      }, "malformed-key"),
      payload: {
        sessionId: "session-1",
        sessionEpoch: 1,
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

  it("does not reflect hostile schema content or amplify an invalid request", async () => {
    const engine = createKeyboardEngine();
    const processKeyStroke = vi.spyOn(engine, "processKeyStroke");
    const daemon = new KeyboardDaemon({ engine });
    const secret = "private-typed-fragment";
    const request = {
      ...createIpcRequest("session.processKeyStroke", {
        sessionId: "missing",
        sessionEpoch: 1,
        key: key("r")
      }, secret.repeat(1_000)),
      payload: {
        sessionId: "missing",
        sessionEpoch: 1,
        key: key("r"),
        [secret]: secret
      }
    };

    const response = await daemon.handle(request);
    const wire = JSON.stringify(response);
    expect(response).toEqual(expect.objectContaining({
      id: "invalid",
      ok: false,
      error: expect.objectContaining({
        code: "IPC_SCHEMA_INVALID",
        message: "The IPC request did not match the required schema."
      })
    }));
    expect(wire).not.toContain(secret);
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThan(IPC_PROTOCOL_LIMITS.maximumFrameBytes);
    expect(processKeyStroke).not.toHaveBeenCalled();
    expect(daemon.metrics().counters.processedKeystrokes).toBe(0);
  });

  it("does not reflect malformed UTF-16 identities into an invalid error response", async () => {
    const daemon = new KeyboardDaemon();
    const response = await daemon.handle({
      ...createIpcRequest("health.check", { client: "daemon-test" }, "well-formed"),
      id: "request-\ud800"
    });

    expect(response).toEqual(expect.objectContaining({ id: "invalid", ok: false }));
    expect(validateIpcResponse(response)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });
});
