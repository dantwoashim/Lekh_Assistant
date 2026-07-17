import type { KeyboardMode, SuggestionSurface } from "../../../src/engine/keyboard/types";
import {
  isIpcMessageType,
  validateIpcEnvelope
} from "./messages";
import type {
  AnyTypedIpcRequest,
  IpcMessageType
} from "./messages";

export type IpcRequestValidationResult =
  | { ok: true; errors: []; request: AnyTypedIpcRequest }
  | { ok: false; errors: string[] };

export function validateIpcRequest(value: unknown): IpcRequestValidationResult {
  const envelope = validateIpcEnvelope(value);
  const errors = [...envelope.errors];
  if (!isRecord(value)) return { ok: false, errors };

  if (!("sentAt" in value) || "ok" in value) {
    errors.push("Envelope must be an IPC request.");
  }
  rejectUnexpectedKeys(
    value,
    ["id", "type", "version", "sentAt", "deadlineAt", "clientInstanceId", "requestSequence", "payload"],
    "request",
    errors
  );

  if (isIpcMessageType(value.type) && "payload" in value) {
    errors.push(...validateIpcPayload(value.type, value.payload));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], request: value as unknown as AnyTypedIpcRequest };
}

export function validateIpcPayload(type: IpcMessageType, payload: unknown): string[] {
  switch (type) {
    case "protocol.negotiate":
      return validateProtocolNegotiatePayload(payload);
    case "health.check":
      return validateHealthCheckPayload(payload);
    case "engine.warm":
      return validateWarmPayload(payload);
    case "session.begin":
    case "suggestions.get":
      return validateContextPayload(payload);
    case "session.processKeyStroke":
      return validateProcessKeyStrokePayload(payload);
    case "session.updateComposition":
      return validateUpdateCompositionPayload(payload);
    case "session.commitCandidate":
      return validateCommitCandidatePayload(payload);
    case "session.commitRaw":
    case "session.cancel":
    case "session.end":
      return validateSessionPayload(payload);
    case "session.setMode":
      return validateSetModePayload(payload);
    case "session.setLayout":
      return validateSetLayoutPayload(payload);
    case "proofHints.get":
      return validateProofHintsPayload(payload);
    case "dictionary.lookup":
      return validateDictionaryLookupPayload(payload);
    case "memory.learn":
      return validateMemoryLearnPayload(payload);
    case "diagnostics.getMetrics":
    case "engine.shutdown":
      return payload === null ? [] : [`payload for ${type} must be null.`];
  }
}

const KEYBOARD_MODES: Readonly<Record<KeyboardMode, true>> = {
  romanized: true,
  traditional: true,
  "romanized-romanized": true,
  "romanized-traditional": true,
  "traditional-traditional": true,
  "traditional-romanized": true,
  "unicode-proofread": true,
  "dictionary-lookup": true,
  diagnostic: true
};

const SUGGESTION_SURFACES: Readonly<Record<SuggestionSurface, true>> = {
  "romanized-to-unicode": true,
  "romanized-to-romanized": true,
  "romanized-to-unicode-with-labels": true,
  "traditional-to-unicode": true,
  "traditional-to-romanized-helper": true,
  "traditional-to-traditional-proofread": true
};

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_QUERY_LENGTH = 1_024;
const MAX_CONTEXT_DOMAINS = 32;

function validateProtocolNegotiatePayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["client", "supportedVersions"], "payload", errors);
  if (!isOneOf(record.client, ["windows-tsf", "macos-imk", "companion", "daemon-test"])) {
    errors.push("payload.client must be a known IPC client.");
  }
  if (!Array.isArray(record.supportedVersions) || record.supportedVersions.length < 1 ||
      record.supportedVersions.length > 8 || new Set(record.supportedVersions).size !== record.supportedVersions.length ||
      record.supportedVersions.some((version) => !Number.isSafeInteger(version) || version < 1)) {
    errors.push("payload.supportedVersions must contain 1 through 8 unique positive safe integers.");
  }
  return errors;
}

function validateHealthCheckPayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["client"], "payload", errors);
  if (!isOneOf(record.client, ["windows-tsf", "macos-imk", "companion", "daemon-test"])) {
    errors.push("payload.client must be a known IPC client.");
  }
  return errors;
}

function validateWarmPayload(value: unknown): string[] {
  if (value === null) return [];
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["timeoutMs"], "payload", errors);
  if ("timeoutMs" in record && !isFiniteNumberInRange(record.timeoutMs, 0, 60_000)) {
    errors.push("payload.timeoutMs must be a finite number from 0 through 60000.");
  }
  return errors;
}

function validateContextPayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["context"], "payload", errors);
  validateTypingContext(record.context, "payload.context", errors);
  return errors;
}

function validateProcessKeyStrokePayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["sessionId", "sessionEpoch", "key"], "payload", errors);
  validateSessionReference(record, errors);
  validateKeyboardKeyEvent(record.key, "payload.key", errors);
  return errors;
}

function validateUpdateCompositionPayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["sessionId", "sessionEpoch", "input", "cursor"], "payload", errors);
  validateSessionReference(record, errors);
  requireString(record.input, "payload.input", MAX_TEXT_LENGTH, errors);
  if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0 ||
      (typeof record.input === "string" && (record.cursor as number) > record.input.length)) {
    errors.push("payload.cursor must be a safe integer within the UTF-16 input range.");
  }
  return errors;
}

function validateCommitCandidatePayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["sessionId", "sessionEpoch", "candidateId"], "payload", errors);
  validateSessionReference(record, errors);
  requireNonEmptyString(record.candidateId, "payload.candidateId", MAX_IDENTIFIER_LENGTH, errors);
  return errors;
}

function validateSessionPayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["sessionId", "sessionEpoch"], "payload", errors);
  validateSessionReference(record, errors);
  return errors;
}

function validateSetModePayload(value: unknown): string[] {
  const errors = validateSessionFields(value, ["sessionId", "sessionEpoch", "mode"]);
  if (!isRecord(value)) return errors;
  if (typeof value.mode !== "string" || !Object.hasOwn(KEYBOARD_MODES, value.mode)) {
    errors.push("payload.mode must be a known keyboard mode.");
  }
  return errors;
}

function validateSetLayoutPayload(value: unknown): string[] {
  const errors = validateSessionFields(value, ["sessionId", "sessionEpoch", "layoutId"]);
  if (!isRecord(value)) return errors;
  requireNonEmptyString(value.layoutId, "payload.layoutId", MAX_IDENTIFIER_LENGTH, errors);
  return errors;
}

function validateSessionFields(value: unknown, allowedKeys: readonly string[]): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, allowedKeys, "payload", errors);
  validateSessionReference(record, errors);
  return errors;
}

function validateProofHintsPayload(value: unknown): string[] {
  return validateTextAndOptionalContextPayload(value, "textWindow", true);
}

function validateDictionaryLookupPayload(value: unknown): string[] {
  return validateTextAndOptionalContextPayload(value, "query", false);
}

function validateTextAndOptionalContextPayload(value: unknown, key: "textWindow" | "query", allowEmpty: boolean): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, [key, "context"], "payload", errors);
  if (allowEmpty) {
    requireString(record[key], `payload.${key}`, MAX_TEXT_LENGTH, errors);
  } else {
    requireNonEmptyString(record[key], `payload.${key}`, MAX_QUERY_LENGTH, errors);
  }
  if ("context" in record) validateTypingContext(record.context, "payload.context", errors);
  return errors;
}

function validateMemoryLearnPayload(value: unknown): string[] {
  const errors: string[] = [];
  const record = requireRecord(value, "payload", errors);
  if (!record) return errors;
  rejectUnexpectedKeys(record, ["sessionId", "sessionEpoch", "commitEpoch"], "payload", errors);
  validateSessionReference(record, errors);
  if (!Number.isSafeInteger(record.commitEpoch) || (record.commitEpoch as number) < 1) {
    errors.push("payload.commitEpoch must be a positive safe integer.");
  }
  return errors;
}

function validateSessionReference(record: Record<string, unknown>, errors: string[]): void {
  requireNonEmptyString(record.sessionId, "payload.sessionId", MAX_IDENTIFIER_LENGTH, errors);
  if (!Number.isSafeInteger(record.sessionEpoch) || (record.sessionEpoch as number) < 1) {
    errors.push("payload.sessionEpoch must be a positive safe integer.");
  }
}

function validateTypingContext(value: unknown, path: string, errors: string[]): void {
  const record = requireRecord(value, path, errors);
  if (!record) return;
  rejectUnexpectedKeys(record, [
    "appId", "appName", "fieldType", "leftTextWindow", "rightTextWindow", "locale", "activeDomains",
    "preserveEnglish", "secureInput", "mode", "layoutId", "enabledSurfaces", "showRomanizedLabels",
    "enableNextWordPrediction"
  ], path, errors);

  for (const key of ["appId", "appName", "rightTextWindow", "locale", "layoutId"] as const) {
    if (key in record) requireString(record[key], `${path}.${key}`, MAX_TEXT_LENGTH, errors);
  }
  if ("fieldType" in record && !isOneOf(record.fieldType, ["normal", "password", "search", "code", "unknown"])) {
    errors.push(`${path}.fieldType must be a known field type.`);
  }
  requireString(record.leftTextWindow, `${path}.leftTextWindow`, MAX_TEXT_LENGTH, errors);
  validateStringArray(record.activeDomains, `${path}.activeDomains`, MAX_CONTEXT_DOMAINS, MAX_IDENTIFIER_LENGTH, errors);
  requireBoolean(record.preserveEnglish, `${path}.preserveEnglish`, errors);
  requireBoolean(record.secureInput, `${path}.secureInput`, errors);
  if (typeof record.mode !== "string" || !Object.hasOwn(KEYBOARD_MODES, record.mode)) {
    errors.push(`${path}.mode must be a known keyboard mode.`);
  }
  if (!Array.isArray(record.enabledSurfaces) || record.enabledSurfaces.length > Object.keys(SUGGESTION_SURFACES).length ||
      record.enabledSurfaces.some((surface) => typeof surface !== "string" || !Object.hasOwn(SUGGESTION_SURFACES, surface))) {
    errors.push(`${path}.enabledSurfaces must contain only known suggestion surfaces.`);
  }
  for (const key of ["showRomanizedLabels", "enableNextWordPrediction"] as const) {
    if (key in record) requireBoolean(record[key], `${path}.${key}`, errors);
  }
}

function validateKeyboardKeyEvent(value: unknown, path: string, errors: string[]): void {
  const record = requireRecord(value, path, errors);
  if (!record) return;
  rejectUnexpectedKeys(record, ["key", "code", "modifiers", "isRepeat", "timestamp", "platform", "nativeCode"], path, errors);
  requireNonEmptyString(record.key, `${path}.key`, MAX_IDENTIFIER_LENGTH, errors);
  requireNonEmptyString(record.code, `${path}.code`, MAX_IDENTIFIER_LENGTH, errors);

  const modifiers = requireRecord(record.modifiers, `${path}.modifiers`, errors);
  if (modifiers) {
    rejectUnexpectedKeys(modifiers, ["shift", "ctrl", "alt", "meta"], `${path}.modifiers`, errors);
    for (const key of ["shift", "ctrl", "alt", "meta"] as const) {
      requireBoolean(modifiers[key], `${path}.modifiers.${key}`, errors);
    }
  }
  if ("isRepeat" in record) requireBoolean(record.isRepeat, `${path}.isRepeat`, errors);
  if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) {
    errors.push(`${path}.timestamp must be a finite number.`);
  }
  if ("platform" in record && !isOneOf(record.platform, ["web", "windows-tsf", "macos-imk", "test"])) {
    errors.push(`${path}.platform must be a known keyboard platform.`);
  }
  if ("nativeCode" in record && !(
    (typeof record.nativeCode === "number" && Number.isFinite(record.nativeCode)) ||
    (typeof record.nativeCode === "string" && record.nativeCode.length <= MAX_IDENTIFIER_LENGTH)
  )) {
    errors.push(`${path}.nativeCode must be a finite number or bounded string.`);
  }
}


function requireRecord(value: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  return value;
}

function rejectUnexpectedKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) errors.push(`${path}.${key} is not allowed.`);
  }
}

function requireString(value: unknown, path: string, maxLength: number, errors: string[]): void {
  if (typeof value !== "string" || value.length > maxLength) {
    errors.push(`${path} must be a string no longer than ${maxLength} UTF-16 code units.`);
  }
}

function requireNonEmptyString(value: unknown, path: string, maxLength: number, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    errors.push(`${path} must be a non-empty string no longer than ${maxLength} UTF-16 code units.`);
  }
}

function requireBoolean(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "boolean") errors.push(`${path} must be a boolean.`);
}

function validateStringArray(value: unknown, path: string, maxItems: number, maxStringLength: number, errors: string[]): void {
  if (!Array.isArray(value) || value.length > maxItems ||
      value.some((item) => typeof item !== "string" || item.length > maxStringLength)) {
    errors.push(`${path} must contain at most ${maxItems} bounded strings.`);
  }
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isOneOf<const T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
