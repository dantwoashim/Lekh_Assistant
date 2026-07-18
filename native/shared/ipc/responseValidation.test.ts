import { describe, expect, it } from "vitest";
import type {
  Candidate,
  CandidateUpdate,
  CommitResult,
  DictionaryResult,
  ProofHint
} from "../../../src/engine/keyboard";
import { createKeyboardEngine, defaultTypingContext } from "../../../src/engine/keyboard";
import { KeyboardDaemon } from "../../daemon/src/keyboardDaemon";
import {
  IPC_MESSAGE_TYPES,
  IPC_PROTOCOL_LIMITS,
  createIpcErrorResponse,
  createIpcRequest,
  createIpcResponse
} from "./messages";
import type { IpcMessageType, IpcResultByType } from "./messages";
import {
  validateIpcResponse,
  validateIpcResponseForRequest,
  validateIpcResponsePayload
} from "./responseValidation";

const candidate: Candidate = {
  id: "candidate-1",
  text: "स्वास्थ्य",
  type: "word",
  confidence: 0.9,
  reason: ["deterministic"]
};

const proofHint: ProofHint = {
  range: [0, 7],
  original: "सवस्थ्य",
  suggestion: "स्वास्थ्य",
  type: "spelling",
  confidence: 0.9,
  action: "hint-only",
  explanation: "Reviewed correction"
};

const dictionaryResult: DictionaryResult = {
  query: "swasthya",
  word: "स्वास्थ्य",
  romanized: ["swasthya"],
  confidence: 0.9
};

const candidateUpdate: CandidateUpdate = {
  sessionId: "session-1",
  mode: "romanized-traditional",
  surface: "romanized-to-unicode",
  action: "compose",
  compositionText: "swasthya",
  displayText: "स्वास्थ्य",
  caret: 8,
  candidates: [candidate],
  primary: candidate,
  proofHints: [],
  shouldShowCandidateUI: true,
  confidence: 0.9,
  warnings: [],
  latencyMs: 1,
  schemaVersion: 1
};

const terminalCommitUpdate: CandidateUpdate = {
  sessionId: "session-1",
  mode: "romanized-traditional",
  surface: "romanized-to-unicode",
  action: "commit",
  compositionText: "",
  displayText: "",
  caret: 0,
  candidates: [],
  proofHints: [],
  committedText: "स्वास्थ्य",
  consumedRange: [0, 8],
  shouldShowCandidateUI: false,
  confidence: 0.9,
  warnings: [],
  latencyMs: 1,
  schemaVersion: 1
};

const commitResult: CommitResult = {
  sessionId: "session-1",
  action: "commit",
  committedText: "स्वास्थ्य",
  commitEpoch: 1,
  memoryRecorded: false,
  schemaVersion: 1
};

function candidateUpdatePayload(
  overrides: Record<string, unknown> = {},
  omittedKeys: readonly string[] = []
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...candidateUpdate, ...overrides };
  for (const key of omittedKeys) delete payload[key];
  return payload;
}

const validPayloads: { [T in IpcMessageType]: IpcResultByType[T] } = {
  "protocol.negotiate": {
    selectedVersion: 2,
    serverInstanceId: "server-1",
    limits: {
      maximumFrameBytes: IPC_PROTOCOL_LIMITS.maximumFrameBytes,
      maximumCompositionLength: IPC_PROTOCOL_LIMITS.maximumCompositionLength,
      hotPathDeadlineMs: IPC_PROTOCOL_LIMITS.hotPathDeadlineMs,
      maximumPendingRequestsPerConnection: IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection,
      maximumClientInstances: IPC_PROTOCOL_LIMITS.maximumClientInstances,
      maximumActiveSessions: IPC_PROTOCOL_LIMITS.maximumActiveSessions,
      clientIdleTtlMs: IPC_PROTOCOL_LIMITS.clientIdleTtlMs
    }
  },
  "health.check": { status: "ok", daemonVersion: "0.1.0-dev", engineReady: true, warnings: [] },
  "engine.warm": {
    ready: true,
    partial: false,
    loadedModules: ["deterministic"],
    unavailableModules: [],
    warmTimeMs: 1,
    warnings: []
  },
  "session.begin": { sessionId: "session-1", sessionEpoch: 1 },
  "session.processKeyStroke": candidateUpdate,
  "session.updateComposition": candidateUpdate,
  "session.commitCandidate": commitResult,
  "session.commitRaw": commitResult,
  "session.cancel": { cancelled: true },
  "session.end": { ended: true },
  "session.setMode": { mode: "traditional" },
  "session.setLayout": { layoutId: "traditional-ltk-compatible.pending" },
  "suggestions.get": [candidate],
  "proofHints.get": [proofHint],
  "dictionary.lookup": [dictionaryResult],
  "memory.learn": { learned: false },
  "diagnostics.getMetrics": {
    uptimeMs: 1,
    activeSessions: 1,
    warmReady: true,
    counters: {
      processedKeystrokes: 1,
      ipcTimeouts: 0,
      passThroughFallbacks: 0,
      committedCandidates: 0
    }
  },
  "engine.shutdown": { shutdown: true }
};

describe("generated IPC response validation", () => {
  it("has a bounded exact response payload contract for every message type", () => {
    for (const type of IPC_MESSAGE_TYPES) {
      expect(
        validateIpcResponsePayload(type, validPayloads[type]),
        `${type} rejected its valid payload`
      ).toEqual([]);
    }
  });

  it("validates complete success and error envelopes", () => {
    const request = createIpcRequest("health.check", { client: "daemon-test" }, "health-response", 1);
    const success = createIpcResponse(request, validPayloads["health.check"], 1, {
      serverInstanceId: "server-1"
    });
    expect(validateIpcResponse(success)).toEqual(expect.objectContaining({ ok: true, errors: [] }));

    const failure = createIpcErrorResponse(request, {
      code: "IPC_TIMEOUT",
      message: "The request timed out."
    }, 1, { serverInstanceId: "server-1" });
    expect(validateIpcResponse(failure)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });

  it("binds the session.begin envelope epoch to the payload epoch", () => {
    const request = createIpcRequest("session.begin", {
      context: defaultTypingContext("romanized")
    }, "begin-response", 1);
    const response = createIpcResponse(request, validPayloads["session.begin"], 1, {
      serverInstanceId: "server-1"
    });
    expect(validateIpcResponse(response)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
    expect(validateIpcResponse({ ...response, sessionEpoch: 2 })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "session.begin response sessionEpoch must match payload.sessionEpoch."
      ])
    }));
  });

  it("requires the exact negotiated protocol limits", () => {
    expect(validateIpcResponsePayload("protocol.negotiate", {
      ...validPayloads["protocol.negotiate"],
      limits: {
        ...validPayloads["protocol.negotiate"].limits,
        hotPathDeadlineMs: IPC_PROTOCOL_LIMITS.hotPathDeadlineMs + 1
      }
    })).not.toEqual([]);
  });

  it("requires a coherent cleared terminal state whenever a candidate update commits or cancels", () => {
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      action: "commit"
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      action: "commit",
      committedText: ""
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", terminalCommitUpdate)).toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...terminalCommitUpdate,
      candidates: [candidate],
      shouldShowCandidateUI: true
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", candidateUpdatePayload({
      action: "cancel"
    }))).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", candidateUpdatePayload({
      action: "cancel",
      compositionText: "",
      displayText: "",
      caret: 0,
      candidates: [],
      proofHints: [],
      shouldShowCandidateUI: false
    }, ["primary"]))).toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      committedText: "unexpected commit"
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      committedText: ""
    })).toEqual(expect.arrayContaining([
      "payload.committedText must be absent unless action is commit."
    ]));
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      consumedRange: [0, candidateUpdate.compositionText.length]
    })).toEqual(expect.arrayContaining([
      "payload.consumedRange must be absent unless action is commit."
    ]));
    expect(validateIpcResponsePayload("session.processKeyStroke", candidateUpdatePayload(
      { ...terminalCommitUpdate },
      ["primary", "consumedRange"]
    ))).toEqual(expect.arrayContaining([
      "payload.consumedRange must be present when action is commit."
    ]));
  });

  it("accepts context-derived next-word previews in otherwise cleared terminal updates", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({
      ...defaultTypingContext("romanized"),
      leftTextWindow: "नेपाल ",
      enableNextWordPrediction: true
    });
    engine.updateComposition(sessionId, "ramro", 5);
    const committed = engine.processKeyStroke(sessionId, {
      key: "Enter",
      code: "Enter",
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      timestamp: 1,
      platform: "test"
    });
    expect(committed.action).toBe("commit");
    expect(committed.inlineCompletion?.source).toBe("ngram-lm");
    expect(validateIpcResponsePayload(
      "session.processKeyStroke",
      JSON.parse(JSON.stringify(committed)) as unknown
    )).toEqual([]);

    engine.updateComposition(sessionId, " फेरि", 5);
    const cancelled = engine.processKeyStroke(sessionId, {
      key: "Escape",
      code: "Escape",
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      timestamp: 2,
      platform: "test"
    });
    expect(cancelled.action).toBe("cancel");
    expect(cancelled.inlineCompletion?.source).toBe("ngram-lm");
    expect(validateIpcResponsePayload(
      "session.processKeyStroke",
      JSON.parse(JSON.stringify(cancelled)) as unknown
    )).toEqual([]);
  });

  it("accepts every response type emitted by the real daemon dispatcher", async () => {
    const daemon = new KeyboardDaemon();
    const seen = new Set<IpcMessageType>();
    const accept = (response: Awaited<ReturnType<KeyboardDaemon["handle"]>>) => {
      const wireResponse = JSON.parse(JSON.stringify(response)) as unknown;
      expect(validateIpcResponse(wireResponse), `${response.type} emitted an invalid response`).toEqual(
        expect.objectContaining({ ok: true, errors: [] })
      );
      seen.add(response.type);
      return response;
    };

    accept(await daemon.handle(createIpcRequest("protocol.negotiate", {
      client: "daemon-test",
      supportedVersions: [2]
    })));
    accept(await daemon.handle(createIpcRequest("health.check", { client: "daemon-test" })));
    accept(await daemon.handle(createIpcRequest("engine.warm", { timeoutMs: 50 })));

    const begin = accept(await daemon.handle(createIpcRequest("session.begin", {
      context: defaultTypingContext("romanized")
    })));
    const session = begin.payload as { sessionId: string; sessionEpoch: number };
    const reference = { sessionId: session.sessionId, sessionEpoch: session.sessionEpoch };
    accept(await daemon.handle(createIpcRequest("session.processKeyStroke", {
      ...reference,
      key: {
        key: "a",
        code: "KeyA",
        modifiers: { shift: false, ctrl: false, alt: false, meta: false },
        timestamp: 1,
        platform: "test"
      }
    })));
    const update = accept(await daemon.handle(createIpcRequest("session.updateComposition", {
      ...reference,
      input: "swasthya",
      cursor: 8
    })));
    const candidateId = (update.payload as CandidateUpdate).candidates[0]?.id;
    expect(candidateId).toEqual(expect.any(String));
    const commit = accept(await daemon.handle(createIpcRequest("session.commitCandidate", {
      ...reference,
      candidateId: candidateId!
    })));
    accept(await daemon.handle(createIpcRequest("memory.learn", {
      ...reference,
      commitEpoch: (commit.payload as CommitResult).commitEpoch
    })));
    accept(await daemon.handle(createIpcRequest("session.setMode", { ...reference, mode: "traditional" })));
    accept(await daemon.handle(createIpcRequest("session.setLayout", { ...reference, layoutId: "traditional-ltk-compatible.pending" })));
    accept(await daemon.handle(createIpcRequest("session.cancel", reference)));
    accept(await daemon.handle(createIpcRequest("session.end", reference)));

    const rawBegin = accept(await daemon.handle(createIpcRequest("session.begin", {
      context: defaultTypingContext("romanized")
    })));
    const rawSession = rawBegin.payload as { sessionId: string; sessionEpoch: number };
    const rawReference = { sessionId: rawSession.sessionId, sessionEpoch: rawSession.sessionEpoch };
    accept(await daemon.handle(createIpcRequest("session.updateComposition", {
      ...rawReference,
      input: "ramro",
      cursor: 5
    })));
    accept(await daemon.handle(createIpcRequest("session.commitRaw", rawReference)));
    accept(await daemon.handle(createIpcRequest("session.end", rawReference)));

    const context = defaultTypingContext("romanized");
    accept(await daemon.handle(createIpcRequest("suggestions.get", { context })));
    accept(await daemon.handle(createIpcRequest("proofHints.get", { textWindow: "सवस्थ्य", context })));
    accept(await daemon.handle(createIpcRequest("dictionary.lookup", { query: "swasthya", context })));
    accept(await daemon.handle(createIpcRequest("diagnostics.getMetrics", null)));
    accept(await daemon.handle(createIpcRequest("engine.shutdown", null)));

    expect([...seen].sort()).toEqual([...IPC_MESSAGE_TYPES].sort());
  });

  it("rejects unknown nested fields, invalid tuples, unsafe numbers, and oversized result lists", () => {
    expect(validateIpcResponsePayload("suggestions.get", [{ ...candidate, injected: "typed text" }])).not.toEqual([]);
    expect(validateIpcResponsePayload("proofHints.get", [{ ...proofHint, range: [0, 1, 2] }])).not.toEqual([]);
    expect(validateIpcResponsePayload("proofHints.get", [{ ...proofHint, range: [7, 0] }])).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      confidence: Number.POSITIVE_INFINITY
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      caret: candidateUpdate.compositionText.length + 1
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      candidates: [{
        ...candidate,
        replaceRange: [0, candidateUpdate.compositionText.length + 1]
      }]
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      compositionText: "कि",
      caret: 2,
      candidates: [{ ...candidate, replaceRange: [1, 2] }]
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      compositionText: "कि",
      caret: 1,
      candidates: []
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("diagnostics.getMetrics", {
      ...validPayloads["diagnostics.getMetrics"],
      counters: {
        ...validPayloads["diagnostics.getMetrics"].counters,
        processedKeystrokes: 1.5
      }
    })).not.toEqual([]);
    expect(validateIpcResponsePayload(
      "dictionary.lookup",
      Array.from({ length: IPC_PROTOCOL_LIMITS.maximumDictionaryResults + 1 }, () => dictionaryResult)
    )).not.toEqual([]);
  });

  it("rejects malformed UTF-16 throughout generated response payloads", () => {
    expect(validateIpcResponsePayload("suggestions.get", [{
      ...candidate,
      text: "😀"
    }])).toEqual([]);
    expect(validateIpcResponsePayload("suggestions.get", [{
      ...candidate,
      text: "\ud800"
    }])).toEqual(expect.arrayContaining([
      "payload[0].text must contain well-formed UTF-16."
    ]));
    expect(validateIpcResponsePayload("suggestions.get", [{
      ...candidate,
      label: "\udc00"
    }])).not.toEqual([]);
    expect(validateIpcResponsePayload("health.check", {
      ...validPayloads["health.check"],
      warnings: ["\ud800"]
    })).not.toEqual([]);
  });

  it("binds candidates, primary selection, and proof hints to one composition coordinate space", () => {
    const duplicate = { ...candidate, text: "स्वस्थ" };
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload({
      candidates: [candidate, duplicate]
    }))).toEqual(expect.arrayContaining([
      "payload.candidates must not contain duplicate candidate identifiers."
    ]));
    expect(validateIpcResponsePayload("suggestions.get", [candidate, duplicate])).not.toEqual([]);
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload({
      primary: { ...candidate, text: "different" }
    }))).toEqual(expect.arrayContaining([
      "payload.primary must exactly match the first candidate."
    ]));
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload({}, ["primary"])))
      .not.toEqual([]);

    const graphemePayload = {
      compositionText: "कि",
      displayText: "कि",
      caret: 2,
      candidates: [],
      proofHints: [{
        ...proofHint,
        range: [0, 2],
        original: "कि"
      }]
    };
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload(
      graphemePayload,
      ["primary"]
    ))).toEqual([]);
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload({
      ...graphemePayload,
      proofHints: [{ ...proofHint, range: [1, 2], original: "ि" }]
    }, ["primary"]))).not.toEqual([]);
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload({
      ...graphemePayload,
      proofHints: [{ ...proofHint, range: [0, 2], original: "mismatch" }]
    }, ["primary"]))).toEqual(expect.arrayContaining([
      "payload.proofHints[0].original must equal the composition text selected by its range."
    ]));
    expect(validateIpcResponsePayload("session.updateComposition", candidateUpdatePayload({
      ...graphemePayload,
      primary: { ...candidate, replaceRange: [1, 2] },
      candidates: [{ ...candidate, replaceRange: [1, 2] }]
    }))).not.toEqual([]);
  });

  it("enforces commit action, epoch, memory, and follow-up invariants", () => {
    expect(validateIpcResponsePayload("session.commitCandidate", commitResult)).toEqual([]);
    expect(validateIpcResponsePayload("session.commitCandidate", {
      ...commitResult,
      commitEpoch: 0
    })).not.toEqual([]);
    expect(validateIpcResponsePayload("session.commitCandidate", {
      ...commitResult,
      action: "compose",
      committedText: "",
      commitEpoch: 0,
      memoryRecorded: false
    })).toEqual([]);
    expect(validateIpcResponsePayload("session.commitRaw", {
      ...commitResult,
      action: "compose",
      committedText: "",
      commitEpoch: 0,
      memoryRecorded: false
    })).not.toEqual([]);
    for (const invalid of [
      { action: "compose", committedText: "", commitEpoch: 1, memoryRecorded: false },
      { action: "passThrough", committedText: "", commitEpoch: 1, memoryRecorded: false },
      { action: "passThrough", committedText: "typed", commitEpoch: 0, memoryRecorded: false },
      { action: "passThrough", committedText: "", commitEpoch: 0, memoryRecorded: true },
      {
        action: "errorFallback",
        committedText: "",
        commitEpoch: 0,
        memoryRecorded: false,
        followupCandidates: [candidate]
      },
      { action: "cancel", committedText: "", commitEpoch: 0, memoryRecorded: false }
    ]) {
      expect(validateIpcResponsePayload("session.commitCandidate", {
        ...commitResult,
        ...invalid
      })).not.toEqual([]);
    }
  });

  it("admits the epoch-zero fail-open commit result without weakening learning receipts", () => {
    expect(validateIpcResponsePayload("session.commitCandidate", {
      ...commitResult,
      action: "passThrough",
      committedText: "",
      commitEpoch: 0
    })).toEqual([]);
    expect(validateIpcResponsePayload("session.commitCandidate", {
      ...commitResult,
      action: "passThrough",
      committedText: "",
      commitEpoch: -1
    })).not.toEqual([]);
  });

  it("keeps non-commit responses canonical after an earlier commit in the same session", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const prior = engine.updateComposition(sessionId, "swasthya", 8);
    const committed = engine.commitCandidate(sessionId, prior.primary?.id ?? "");
    expect(committed.commitEpoch).toBe(1);

    const helperUpdate = engine.updateComposition(sessionId, "pra", 3);
    const helper = helperUpdate.candidates.find((item) =>
      item.type === "romanized-helper" && item.text === "prashasan"
    );
    expect(helper).toBeDefined();
    const refined = engine.commitCandidate(sessionId, helper!.id);
    expect(refined.commitEpoch).toBe(0);
    expect(validateIpcResponsePayload("session.commitCandidate", refined)).toEqual([]);

    engine.cancelComposition(sessionId);
    const emptyEnter = engine.processKeyStroke(sessionId, {
      key: "Enter",
      code: "Enter",
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      timestamp: 2,
      platform: "test"
    });
    expect(emptyEnter.action).toBe("passThrough");
    expect(emptyEnter).not.toHaveProperty("committedText");
    expect(validateIpcResponsePayload("session.processKeyStroke", emptyEnter)).toEqual([]);
  });

  it("keeps live proof-hint coordinates relative to the active composition", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession({
      ...defaultTypingContext("unicode-proofread"),
      leftTextWindow: "क ".repeat(8_192)
    });
    const update = engine.updateComposition(sessionId, "सवस्थ्य", 7);
    expect(validateIpcResponsePayload("session.updateComposition", update)).toEqual([]);
    expect(update.proofHints.length).toBeGreaterThan(0);
    for (const hint of update.proofHints) {
      expect(hint.range[1]).toBeLessThanOrEqual(update.compositionText.length);
      expect(update.compositionText.slice(...hint.range)).toBe(hint.original);
    }
  });

  it("binds response identity, session authority, and proof coordinates to the originating request", () => {
    const proofRequest = createIpcRequest("proofHints.get", {
      textWindow: proofHint.original,
      context: defaultTypingContext("unicode-proofread")
    }, "proof-correlated", 1, { requestSequence: 31 });
    const proofResponse = createIpcResponse(proofRequest, [proofHint], 1, {
      serverInstanceId: "server-correlated"
    });
    expect(validateIpcResponseForRequest(proofRequest, proofResponse, {
      serverInstanceId: "server-correlated"
    })).toEqual(expect.objectContaining({ ok: true, errors: [] }));
    expect(validateIpcResponseForRequest(proofRequest, {
      ...proofResponse,
      id: "different-request",
      serverInstanceId: "different-server",
      requestSequence: 32
    }, { serverInstanceId: "server-correlated" })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "response.id must match the originating request.",
        "response.requestSequence must match the originating request.",
        "response.serverInstanceId must match the negotiated server instance."
      ])
    }));

    const shiftedProofRequest = {
      ...proofRequest,
      payload: { ...proofRequest.payload, textWindow: "x".repeat(proofHint.original.length) }
    };
    expect(validateIpcResponseForRequest(shiftedProofRequest, proofResponse)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "payload[0].original must equal the originating request text selected by its range."
      ])
    }));

    const sessionRequest = createIpcRequest("session.updateComposition", {
      sessionId: "session-correlated",
      sessionEpoch: 7,
      input: "swasthya",
      cursor: 8
    }, "session-correlated", 1, { requestSequence: 41 });
    const wrongSessionResponse = createIpcResponse(sessionRequest, {
      ...candidateUpdate,
      sessionId: "another-session"
    }, 1, {
      serverInstanceId: "server-correlated",
      sessionEpoch: 7
    });
    expect(validateIpcResponseForRequest(sessionRequest, wrongSessionResponse)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "response payload sessionId must match the originating session."
      ])
    }));
    expect(validateIpcResponseForRequest(sessionRequest, {
      ...wrongSessionResponse,
      payload: { ...wrongSessionResponse.payload, sessionId: "session-correlated" },
      sessionEpoch: 8
    })).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "response.sessionEpoch must match the originating session epoch."
      ])
    }));
  });

  it("keeps a valid maximum composition bounded when the next key would overflow it", () => {
    const engine = createKeyboardEngine();
    const sessionId = engine.beginSession(defaultTypingContext("romanized"));
    const maximum = "a".repeat(IPC_PROTOCOL_LIMITS.maximumCompositionLength);
    const atLimit = engine.updateComposition(sessionId, maximum, maximum.length);
    expect(validateIpcResponsePayload("session.updateComposition", atLimit)).toEqual([]);

    const overflow = engine.processKeyStroke(sessionId, {
      key: "b",
      code: "KeyB",
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      timestamp: 1,
      platform: "test"
    });
    expect(overflow.action).toBe("passThrough");
    expect(validateIpcResponsePayload("session.processKeyStroke", overflow)).toEqual([]);
  });

  it("rejects a success envelope whose payload only looks superficially valid", () => {
    const request = createIpcRequest("health.check", { client: "daemon-test" }, "invalid-health-response", 1);
    const response = createIpcResponse(request, validPayloads["health.check"], 1, {
      serverInstanceId: "server-1"
    });
    expect(validateIpcResponse({
      ...response,
      payload: { ...response.payload, unexpected: "typed text" }
    })).toEqual(expect.objectContaining({ ok: false }));
  });
});
