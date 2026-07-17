import { describe, expect, it } from "vitest";
import type {
  Candidate,
  CandidateUpdate,
  CommitResult,
  DictionaryResult,
  ProofHint
} from "../../../src/engine/keyboard";
import { defaultTypingContext } from "../../../src/engine/keyboard";
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

const commitResult: CommitResult = {
  sessionId: "session-1",
  action: "commit",
  committedText: "स्वास्थ्य",
  commitEpoch: 1,
  memoryRecorded: false,
  schemaVersion: 1
};

const validPayloads: { [T in IpcMessageType]: IpcResultByType[T] } = {
  "protocol.negotiate": {
    selectedVersion: 2,
    serverInstanceId: "server-1",
    limits: {
      maximumFrameBytes: IPC_PROTOCOL_LIMITS.maximumFrameBytes,
      hotPathDeadlineMs: IPC_PROTOCOL_LIMITS.hotPathDeadlineMs,
      maximumPendingRequestsPerConnection: IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection,
      maximumClientInstances: IPC_PROTOCOL_LIMITS.maximumClientInstances,
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
    expect(validateIpcResponsePayload("session.processKeyStroke", {
      ...candidateUpdate,
      confidence: Number.POSITIVE_INFINITY
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
