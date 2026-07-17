import { readFileSync } from "node:fs";
import { createKeyboardEngine, defaultTypingContext } from "../../src/engine/keyboard/index";
import { applyKeyToComposition } from "../../src/engine/keyboard/composition";
import {
  clampCaret,
  deleteAfterCaret,
  deleteBeforeCaret,
  insertAtCaret
} from "../../src/engine/keyboard/ranges";
import { isSecureContext } from "../../src/engine/keyboard/modes";
import { KeyboardSessionManager } from "../../src/engine/keyboard/session";
import type {
  Candidate,
  KeyboardKeyEvent,
  KeyboardMode,
  ProofHint,
  TypingContext
} from "../../src/engine/keyboard/types";
import { extractProtectedSpans } from "../../src/engine/protected/index";
import type { EngineMode } from "../../src/engine/types";

export const BEHAVIOR_CONTRACT_VERSION = "1.0.0";
export const BEHAVIOR_SCHEMA_VERSION = 1;

const CASE_KINDS = new Set([
  "edit",
  "key",
  "candidate",
  "protected-span",
  "context-transition",
  "mode-transition",
  "commit",
  "cancel",
  "failure"
]);

const NATIVE_MODES = new Set<KeyboardMode>([
  "romanized-traditional",
  "romanized-romanized",
  "traditional-traditional",
  "traditional-romanized"
]);

export interface BehaviorCase {
  schemaVersion: 1;
  contractVersion: string;
  id: string;
  kind: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

export interface BehaviorEvidence {
  caseId: string;
  contractVersion: string;
  observed: Record<string, unknown>;
  status: "passed";
}

export function loadBehaviorCorpus(path: string): BehaviorCase[] {
  const source = readFileSync(path, "utf8");
  const lines = source.split(/\r?\n/);
  const cases: BehaviorCase[] = [];
  const ids = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      if (index !== lines.length - 1) {
        throw new Error(`Behavior corpus line ${index + 1} is blank; blank records are forbidden.`);
      }
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Behavior corpus line ${index + 1} is not valid JSON: ${errorMessage(error)}`);
    }
    const row = requireObject(value, `line ${index + 1}`);
    assertExactKeys(row, ["schemaVersion", "contractVersion", "id", "kind", "input", "expected"], `line ${index + 1}`);
    if (row.schemaVersion !== BEHAVIOR_SCHEMA_VERSION) {
      throw new Error(`Behavior corpus line ${index + 1} has unsupported schemaVersion ${String(row.schemaVersion)}.`);
    }
    if (row.contractVersion !== BEHAVIOR_CONTRACT_VERSION) {
      throw new Error(`Behavior corpus line ${index + 1} has unsupported contractVersion ${String(row.contractVersion)}.`);
    }
    const id = requireString(row, "id", `line ${index + 1}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 96) {
      throw new Error(`Behavior corpus line ${index + 1} has invalid id ${JSON.stringify(id)}.`);
    }
    if (ids.has(id)) throw new Error(`Behavior corpus contains duplicate id ${id}.`);
    ids.add(id);
    const kind = requireString(row, "kind", id);
    if (!CASE_KINDS.has(kind)) throw new Error(`${id}: unsupported case kind ${kind}.`);

    const behaviorCase: BehaviorCase = {
      schemaVersion: 1,
      contractVersion: BEHAVIOR_CONTRACT_VERSION,
      id,
      kind,
      input: requireObject(row.input, `${id}.input`),
      expected: requireObject(row.expected, `${id}.expected`)
    };
    validateCaseShape(behaviorCase);
    cases.push(behaviorCase);
  }

  if (cases.length === 0) throw new Error("Behavior corpus contains no cases.");
  return cases;
}

export function runBehaviorContract(cases: BehaviorCase[]): BehaviorEvidence[] {
  return cases.map((behaviorCase) => {
    const observed = runCase(behaviorCase);
    assertSameValue(observed, behaviorCase.expected, behaviorCase.id);
    return {
      caseId: behaviorCase.id,
      contractVersion: behaviorCase.contractVersion,
      observed,
      status: "passed"
    };
  });
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function runCase(behaviorCase: BehaviorCase): Record<string, unknown> {
  switch (behaviorCase.kind) {
    case "edit": return runEditCase(behaviorCase);
    case "key": return runKeyCase(behaviorCase);
    case "candidate": return runCandidateCase(behaviorCase);
    case "protected-span": return runProtectedSpanCase(behaviorCase);
    case "context-transition": return runContextTransitionCase(behaviorCase);
    case "mode-transition": return runModeTransitionCase(behaviorCase);
    case "commit": return runCommitCase(behaviorCase);
    case "cancel": return runCancelCase(behaviorCase);
    case "failure": return runFailureCase(behaviorCase);
    default: throw new Error(`${behaviorCase.id}: unhandled kind ${behaviorCase.kind}.`);
  }
}

function runEditCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const operation = requireString(input, "operation", id);
  const text = requireString(input, "text", id);
  const caret = requireInteger(input, "caret", id);
  let result: { text: string; caret: number };
  if (operation === "backspace") result = deleteBeforeCaret(text, caret);
  else if (operation === "delete") result = deleteAfterCaret(text, caret);
  else if (operation === "insert") result = insertAtCaret(text, caret, requireString(input, "value", id));
  else if (operation === "clamp-caret") result = { text, caret: clampCaret(text, caret) };
  else throw new Error(`${id}: unsupported edit operation ${operation}.`);
  return result;
}

function runKeyCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const mode = requireNativeMode(input, "mode", id);
  const composition = requireString(input, "composition", id);
  const caret = requireInteger(input, "caret", id);
  const keyName = requireString(input, "key", id);
  const engine = createKeyboardEngine();
  const sessionId = engine.beginSession(defaultTypingContext(mode));
  engine.updateComposition(sessionId, composition, caret);
  const update = engine.processKeyStroke(sessionId, keyEvent(keyName));
  engine.endSession(sessionId);
  return {
    action: update.action,
    composition: update.compositionText,
    caret: update.caret
  };
}

function runCandidateCase({ id, input, expected }: BehaviorCase): Record<string, unknown> {
  const mode = requireNativeMode(input, "mode", id);
  const composition = requireString(input, "composition", id);
  const engine = createKeyboardEngine();
  const sessionId = engine.beginSession(defaultTypingContext(mode));
  const update = engine.updateComposition(sessionId, composition, composition.length);
  engine.endSession(sessionId);
  const texts = update.candidates.map((candidate) => candidate.text);

  if (typeof expected.candidateContains === "string") {
    if (!texts.includes(expected.candidateContains)) {
      throw new Error(`${id}: expected candidate ${JSON.stringify(expected.candidateContains)}; received ${stableJson(texts)}.`);
    }
    return {
      action: update.action,
      composition: update.compositionText,
      candidateContains: expected.candidateContains
    };
  }

  if (expected.candidateExtendsComposition === true) {
    if (!texts.some((candidate) => candidate.startsWith(composition) && candidate.length > composition.length)) {
      throw new Error(`${id}: expected a candidate extending ${JSON.stringify(composition)}; received ${stableJson(texts)}.`);
    }
    return {
      action: update.action,
      composition: update.compositionText,
      candidateExtendsComposition: true
    };
  }

  const alternatives = requireStringArray(expected, "candidateContainsAny", id);
  if (!alternatives.some((candidate) => texts.includes(candidate))) {
    throw new Error(`${id}: expected one of ${stableJson(alternatives)}; received ${stableJson(texts)}.`);
  }
  return {
    action: update.action,
    composition: update.compositionText,
    candidateContainsAny: alternatives
  };
}

function runProtectedSpanCase({ id, input, expected }: BehaviorCase): Record<string, unknown> {
  const mode = requireString(input, "mode", id) as EngineMode;
  const text = requireString(input, "text", id);
  const preservedText = requireString(expected, "preservedText", id);
  const expectedRange = requireIntegerPair(expected, "range", id);
  const result = extractProtectedSpans(text, mode);
  const span = result.spans.find((candidate) =>
    candidate.original === preservedText &&
    candidate.range[0] === expectedRange[0] &&
    candidate.range[1] === expectedRange[1]
  );
  if (!span) throw new Error(`${id}: protected span was not detected byte-exactly.`);

  const engine = createKeyboardEngine();
  const sessionId = engine.beginSession(defaultTypingContext("romanized-traditional"));
  const update = engine.updateComposition(sessionId, text, text.length);
  engine.endSession(sessionId);
  if (!update.candidates.some((candidate) => candidate.type === "protected" && candidate.text === preservedText)) {
    throw new Error(`${id}: keyboard candidate path did not preserve the protected span.`);
  }
  return { preservedText: span.original, range: span.range };
}

function runContextTransitionCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const mode = requireNativeMode(input, "mode", id);
  const initialFieldType = requireFieldType(input, "initialFieldType", id);
  const targetFieldType = requireFieldType(input, "targetFieldType", id);
  const initialComposition = requireString(input, "initialComposition", id);
  const leftTextWindow = requireString(input, "leftTextWindow", id);
  const rightTextWindow = requireString(input, "rightTextWindow", id);
  const targetSecureInput = requireBoolean(input, "targetSecureInput", id);
  const manager = new KeyboardSessionManager();
  const context: TypingContext = {
    ...defaultTypingContext(mode),
    fieldType: initialFieldType,
    leftTextWindow,
    rightTextWindow
  };
  const sessionId = manager.beginSession(context);

  if (!isSecureContext(context)) {
    manager.updateComposition(sessionId, "earlier", "earlier".length);
    manager.recordCommit(sessionId, "earlier");
    manager.updateComposition(sessionId, initialComposition, initialComposition.length);
    manager.updateCandidates(sessionId, [fixtureCandidate(initialComposition)]);
    manager.updateProofHints(sessionId, [fixtureProofHint(initialComposition)]);
  } else {
    manager.updateComposition(sessionId, initialComposition, initialComposition.length);
  }

  manager.updateContext(sessionId, {
    fieldType: targetFieldType,
    secureInput: targetSecureInput,
    leftTextWindow,
    rightTextWindow
  });
  const session = manager.get(sessionId);
  const secure = isSecureContext(session.context);
  const observed = {
    action: secure ? "passThrough" : "compose",
    composition: session.compositionText,
    caret: session.caret,
    candidateCount: session.candidates.length,
    proofHintCount: session.proofHints.length,
    committedHistoryCount: session.committedHistory.length,
    lastCommittedText: session.lastCommittedText,
    leftTextWindow: session.context.leftTextWindow,
    rightTextWindow: session.context.rightTextWindow ?? ""
  };
  manager.shutdown();
  return observed;
}

function runModeTransitionCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const fromMode = requireNativeMode(input, "fromMode", id);
  const toMode = requireNativeMode(input, "toMode", id);
  const composition = requireString(input, "composition", id);
  const manager = new KeyboardSessionManager();
  const sessionId = manager.beginSession(defaultTypingContext(fromMode));
  manager.updateComposition(sessionId, composition, composition.length);
  manager.updateCandidates(sessionId, [fixtureCandidate(composition)]);
  manager.setMode(sessionId, toMode);
  const session = manager.get(sessionId);
  const observed = {
    composition: session.compositionText,
    caret: session.caret,
    candidateCount: session.candidates.length
  };
  manager.shutdown();
  return observed;
}

function runCommitCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const mode = requireNativeMode(input, "mode", id);
  const composition = requireString(input, "composition", id);
  const strategy = requireString(input, "strategy", id);
  const engine = createKeyboardEngine();
  const sessionId = engine.beginSession({ ...defaultTypingContext(mode), fieldType: "normal" });
  const update = engine.updateComposition(sessionId, composition, composition.length);
  let action: string;
  let committedText: string;

  if (strategy === "candidate") {
    const candidateText = requireString(input, "candidate", id);
    const candidate = update.candidates.find((item) => item.text === candidateText);
    if (!candidate) throw new Error(`${id}: candidate ${JSON.stringify(candidateText)} is unavailable.`);
    const result = engine.commitCandidate(sessionId, candidate.id);
    action = result.action;
    committedText = result.committedText;
  } else if (strategy === "raw") {
    const delimiter = requireString(input, "delimiter", id);
    const delimiterKey = delimiter === " " ? " " : delimiter === "\n" ? "Enter" : delimiter;
    const result = engine.processKeyStroke(sessionId, keyEvent(delimiterKey));
    action = result.action;
    committedText = result.committedText ?? "";
  } else {
    throw new Error(`${id}: unsupported commit strategy ${strategy}.`);
  }

  const after = engine.updateComposition(sessionId, "", 0);
  engine.endSession(sessionId);
  return { action, committedText, composition: after.compositionText };
}

function runCancelCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const mode = requireNativeMode(input, "mode", id);
  const composition = requireString(input, "composition", id);
  const keyName = requireString(input, "key", id);
  const engine = createKeyboardEngine();
  const sessionId = engine.beginSession(defaultTypingContext(mode));
  engine.updateComposition(sessionId, composition, composition.length);
  const update = engine.processKeyStroke(sessionId, keyEvent(keyName));
  engine.endSession(sessionId);
  return { action: update.action, composition: update.compositionText, caret: update.caret };
}

function runFailureCase({ id, input }: BehaviorCase): Record<string, unknown> {
  const failure = requireString(input, "failure", id);
  const mode = requireNativeMode(input, "mode", id);
  const composition = requireString(input, "composition", id);
  const caret = requireInteger(input, "caret", id);
  const engine = createKeyboardEngine();

  if (failure === "unknown-session") {
    const update = engine.updateComposition("contract-missing-session", composition, caret);
    return { action: update.action, composition: update.compositionText, caret: update.caret };
  }

  const sessionId = engine.beginSession(defaultTypingContext(mode));
  engine.updateComposition(sessionId, composition, caret);
  if (failure === "malformed-key") {
    const malformed = { ...keyEvent("x"), key: undefined as unknown as string };
    const update = engine.processKeyStroke(sessionId, malformed);
    engine.endSession(sessionId);
    return { action: update.action, composition: update.compositionText, caret: update.caret };
  }
  if (failure === "unknown-candidate") {
    const result = engine.commitCandidate(sessionId, "contract-missing-candidate");
    const after = engine.updateComposition(sessionId, composition, caret);
    engine.endSession(sessionId);
    return { action: result.action, composition: after.compositionText, caret: after.caret };
  }
  if (failure === "backend-timeout") {
    // The adapter owns the timeout boundary. It must return the host-owned text
    // unchanged without calling a late or unavailable engine response.
    engine.endSession(sessionId);
    return { action: "errorFallback", composition, caret };
  }
  throw new Error(`${id}: unsupported failure ${failure}.`);
}

function validateCaseShape(behaviorCase: BehaviorCase): void {
  const { id, kind, input, expected } = behaviorCase;
  const shapes: Record<string, { input: string[]; optionalInput?: string[]; expected: string[] }> = {
    edit: { input: ["operation", "text", "caret"], optionalInput: ["value"], expected: ["text", "caret"] },
    key: { input: ["mode", "composition", "caret", "key"], expected: ["action", "composition", "caret"] },
    candidate: { input: ["mode", "composition"], expected: ["action", "composition"], optionalInput: [] },
    "protected-span": { input: ["mode", "text"], expected: ["preservedText", "range"] },
    "context-transition": {
      input: ["mode", "initialFieldType", "initialComposition", "leftTextWindow", "rightTextWindow", "targetFieldType", "targetSecureInput"],
      expected: ["action", "composition", "caret", "candidateCount", "proofHintCount", "committedHistoryCount", "lastCommittedText", "leftTextWindow", "rightTextWindow"]
    },
    "mode-transition": { input: ["fromMode", "toMode", "composition"], expected: ["composition", "caret", "candidateCount"] },
    commit: { input: ["mode", "composition", "strategy"], optionalInput: ["candidate", "delimiter"], expected: ["action", "committedText", "composition"] },
    cancel: { input: ["mode", "composition", "key"], expected: ["action", "composition", "caret"] },
    failure: { input: ["failure", "mode", "composition", "caret"], expected: ["action", "composition", "caret"] }
  };
  const shape = shapes[kind];
  if (!shape) throw new Error(`${id}: no shape validator for ${kind}.`);
  assertExactKeys(input, [...shape.input, ...(shape.optionalInput ?? [])], `${id}.input`, shape.input);
  const expectedAllowed = kind === "candidate"
    ? [...shape.expected, "candidateContains", "candidateContainsAny", "candidateExtendsComposition"]
    : shape.expected;
  const expectedRequired = kind === "candidate" ? shape.expected : shape.expected;
  assertExactKeys(expected, expectedAllowed, `${id}.expected`, expectedRequired);
  if (kind === "candidate") {
    const hasExact = typeof expected.candidateContains === "string";
    const hasAny = Array.isArray(expected.candidateContainsAny);
    const hasExtension = expected.candidateExtendsComposition === true;
    if ([hasExact, hasAny, hasExtension].filter(Boolean).length !== 1) {
      throw new Error(`${id}: candidate case requires exactly one candidate expectation.`);
    }
  }
}

function fixtureCandidate(text: string): Candidate {
  return {
    id: "contract-fixture-candidate",
    text: text || "fixture",
    type: "word",
    confidence: 1,
    reason: ["behavior contract fixture"]
  };
}

function fixtureProofHint(text: string): ProofHint {
  return {
    range: [0, text.length],
    original: text,
    suggestion: text,
    type: "normalization",
    confidence: 1,
    action: "hint-only",
    explanation: "behavior contract fixture"
  };
}

function keyEvent(key: string): KeyboardKeyEvent {
  return {
    key,
    code: key === " " ? "Space" : key.length === 1 ? `Key${key.toUpperCase()}` : key,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    timestamp: 1,
    platform: "test"
  };
}

function requireNativeMode(object: Record<string, unknown>, key: string, context: string): KeyboardMode {
  const mode = requireString(object, key, context) as KeyboardMode;
  if (!NATIVE_MODES.has(mode)) throw new Error(`${context}.${key}: unsupported native mode ${mode}.`);
  return mode;
}

function requireFieldType(object: Record<string, unknown>, key: string, context: string): NonNullable<TypingContext["fieldType"]> {
  const fieldType = requireString(object, key, context);
  if (!["normal", "password", "search", "code", "unknown"].includes(fieldType)) {
    throw new Error(`${context}.${key}: unsupported field type ${fieldType}.`);
  }
  return fieldType as NonNullable<TypingContext["fieldType"]>;
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(object: Record<string, unknown>, key: string, context: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string.`);
  return value;
}

function requireBoolean(object: Record<string, unknown>, key: string, context: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error(`${context}.${key} must be a boolean.`);
  return value;
}

function requireInteger(object: Record<string, unknown>, key: string, context: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value)) throw new Error(`${context}.${key} must be a safe integer.`);
  return value as number;
}

function requireStringArray(object: Record<string, unknown>, key: string, context: string): string[] {
  const value = object[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    throw new Error(`${context}.${key} must be a non-empty string array.`);
  }
  return value;
}

function requireIntegerPair(object: Record<string, unknown>, key: string, context: string): [number, number] {
  const value = object[key];
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isSafeInteger)) {
    throw new Error(`${context}.${key} must be a pair of safe integers.`);
  }
  return [value[0] as number, value[1] as number];
}

function assertExactKeys(
  object: Record<string, unknown>,
  allowed: string[],
  context: string,
  required: string[] = allowed
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${context} contains unknown fields: ${unknown.sort().join(", ")}.`);
  const missing = required.filter((key) => !Object.hasOwn(object, key));
  if (missing.length > 0) throw new Error(`${context} is missing fields: ${missing.join(", ")}.`);
}

function assertSameValue(actual: unknown, expected: unknown, id: string): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`${id}: expected ${stableJson(expected)}, observed ${stableJson(actual)}.`);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Kept reachable for mutation tests: this verifies that the normalized key
// primitive and the engine runner use the same grapheme-aware edit semantics.
export function runKeyPrimitive(text: string, caret: number, key: KeyboardKeyEvent) {
  return applyKeyToComposition(text, caret, key);
}
