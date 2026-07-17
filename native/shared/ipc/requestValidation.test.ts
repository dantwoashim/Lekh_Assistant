import { describe, expect, it } from "vitest";
import { defaultTypingContext } from "../../../src/engine/keyboard";
import {
  IPC_MESSAGE_TYPES,
  IPC_SCHEMA_VERSION,
  createIpcRequest
} from "./messages";
import type { IpcMessageType, IpcPayloadByType } from "./messages";
import { validateIpcRequest } from "./requestValidation";

const context = defaultTypingContext("romanized");

const validPayloads: { [T in IpcMessageType]: IpcPayloadByType[T] } = {
  "protocol.negotiate": { client: "daemon-test", supportedVersions: [IPC_SCHEMA_VERSION] },
  "health.check": { client: "daemon-test" },
  "engine.warm": { timeoutMs: 50 },
  "session.begin": { context },
  "session.processKeyStroke": {
    sessionId: "session-1",
    sessionEpoch: 1,
    key: {
      key: "r",
      code: "KeyR",
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      timestamp: 1,
      platform: "test"
    }
  },
  "session.updateComposition": { sessionId: "session-1", sessionEpoch: 1, input: "ramro", cursor: 5 },
  "session.commitCandidate": { sessionId: "session-1", sessionEpoch: 1, candidateId: "candidate-1" },
  "session.commitRaw": { sessionId: "session-1", sessionEpoch: 1 },
  "session.cancel": { sessionId: "session-1", sessionEpoch: 1 },
  "session.end": { sessionId: "session-1", sessionEpoch: 1 },
  "session.setMode": { sessionId: "session-1", sessionEpoch: 1, mode: "traditional" },
  "session.setLayout": { sessionId: "session-1", sessionEpoch: 1, layoutId: "traditional-ltk-compatible.pending" },
  "suggestions.get": { context },
  "proofHints.get": { textWindow: "सवस्थ्य", context },
  "dictionary.lookup": { query: "swasthya", context },
  "memory.learn": { sessionId: "session-1", sessionEpoch: 1, commitEpoch: 1 },
  "diagnostics.getMetrics": null,
  "engine.shutdown": null
};

describe("native IPC request validation", () => {
  it("validates the exact payload contract for every declared request type", () => {
    for (const type of IPC_MESSAGE_TYPES) {
      const envelope = createIpcRequest(type, validPayloads[type], `test_${type}`, 1);
      const validation = validateIpcRequest(envelope);
      expect(validation.ok, `${type}: ${validation.errors.join(" ")}`).toBe(true);
    }
  });

  it("rejects malformed, unexpected, and type-confused request payloads", () => {
    const invalidPayloads: Array<[IpcMessageType, unknown]> = [
      ["protocol.negotiate", { client: "daemon-test", supportedVersions: [] }],
      ["health.check", { client: "browser" }],
      ["engine.warm", { timeoutMs: "fast" }],
      ["session.begin", { context: { ...context, secureInput: "no" } }],
      ["session.processKeyStroke", { sessionId: "session-1", key: { key: "r", code: "KeyR", modifiers: {} } }],
      ["session.updateComposition", { sessionId: "session-1", input: "abc", cursor: 4 }],
      ["session.commitCandidate", { sessionId: "session-1", candidateId: "" }],
      ["session.cancel", { sessionId: "session-1", unexpected: true }],
      ["session.setMode", { sessionId: "session-1", mode: "invented" }],
      ["session.setMode", { sessionId: "session-1", mode: "toString" }],
      ["proofHints.get", { textWindow: "text", context: { ...context, enabledSurfaces: ["invented"] } }],
      ["proofHints.get", { textWindow: "text", context: { ...context, enabledSurfaces: ["constructor"] } }],
      ["dictionary.lookup", { query: "" }],
      ["memory.learn", { commitEpoch: 1 }],
      ["memory.learn", { sessionId: "session-1" }],
      ["memory.learn", { sessionId: "session-1", commitEpoch: 0 }],
      ["memory.learn", { sessionId: "session-1", commitEpoch: 1.5 }],
      ["memory.learn", { sessionId: "session-1", commitEpoch: 1, context: { leftWindow: "inject" } }],
      ["memory.learn", { sessionId: "session-1", commitEpoch: 1, entry: { chosenOutput: "poison" } }],
      ["diagnostics.getMetrics", {}],
      ["engine.shutdown", undefined]
    ];

    for (const [type, payload] of invalidPayloads) {
      const validation = validateIpcRequest({
        ...createIpcRequest(type, validPayloads[type], `invalid_${type}`, 1),
        payload
      });
      expect(validation.ok, `${type} unexpectedly accepted ${JSON.stringify(payload)}`).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    }
  });

  it("preserves explicit null payloads across the JSON wire", () => {
    const request = createIpcRequest("engine.shutdown", null, "shutdown-wire", 1);
    const roundTripped = JSON.parse(JSON.stringify(request));
    expect(roundTripped).toHaveProperty("payload", null);
    expect(validateIpcRequest(roundTripped)).toEqual(expect.objectContaining({ ok: true, errors: [] }));
  });
});
