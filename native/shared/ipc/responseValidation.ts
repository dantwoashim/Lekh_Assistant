import {
  IPC_COMMON_DEFINITIONS,
  IPC_RESPONSE_PAYLOAD_SCHEMAS
} from "./generatedResponseSchemas";
import {
  IPC_MESSAGE_DESCRIPTORS,
  isIpcMessageType,
  validateIpcEnvelope
} from "./messages";
import type {
  AnyTypedIpcRequest,
  IpcMessageType,
  IpcResponse
} from "./messages";
import { isWellFormedUtf16 } from "./utf16";
import { graphemeBoundaries } from "../../../src/engine/keyboard/ranges";

const MAXIMUM_VALIDATION_ERRORS = 32;
const MAXIMUM_SCHEMA_DEPTH = 32;

type SchemaNode = boolean | {
  $ref?: string;
  type?: "null" | "object" | "array" | "string" | "number" | "integer" | "boolean";
  const?: unknown;
  enum?: readonly unknown[];
  oneOf?: readonly SchemaNode[];
  required?: readonly string[];
  properties?: Readonly<Record<string, SchemaNode>>;
  additionalProperties?: boolean;
  items?: SchemaNode;
  prefixItems?: readonly SchemaNode[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

export type IpcResponseValidationResult =
  | { ok: true; errors: []; response: IpcResponse }
  | { ok: false; errors: string[] };

export function validateIpcResponse(value: unknown): IpcResponseValidationResult {
  const envelope = validateIpcEnvelope(value);
  const errors = [...envelope.errors];
  if (!isRecord(value) || !("ok" in value) || "sentAt" in value) {
    pushError(errors, "Envelope must be an IPC response.");
  }
  if (isRecord(value) && value.ok === true && isIpcMessageType(value.type) && "payload" in value) {
    for (const error of validateIpcResponsePayload(value.type, value.payload)) pushError(errors, error);
    if (value.type === "session.begin" && isRecord(value.payload) &&
        value.sessionEpoch !== value.payload.sessionEpoch) {
      pushError(errors, "session.begin response sessionEpoch must match payload.sessionEpoch.");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], response: value as unknown as IpcResponse };
}

export interface IpcResponseExpectation {
  serverInstanceId?: string;
}

export function validateIpcResponseForRequest(
  request: Pick<AnyTypedIpcRequest, "id" | "type" | "requestSequence" | "payload">,
  value: unknown,
  expectation: IpcResponseExpectation = {}
): IpcResponseValidationResult {
  const validation = validateIpcResponse(value);
  const errors = [...validation.errors];
  if (!isRecord(value)) return { ok: false, errors };

  if (value.id !== request.id) pushError(errors, "response.id must match the originating request.");
  if (value.type !== request.type) pushError(errors, "response.type must match the originating request.");
  if (value.requestSequence !== request.requestSequence) {
    pushError(errors, "response.requestSequence must match the originating request.");
  }
  if (expectation.serverInstanceId !== undefined && value.serverInstanceId !== expectation.serverInstanceId) {
    pushError(errors, "response.serverInstanceId must match the negotiated server instance.");
  }

  const descriptor = IPC_MESSAGE_DESCRIPTORS[request.type];
  if (descriptor.sessionBound && isRecord(request.payload) &&
      value.sessionEpoch !== request.payload.sessionEpoch) {
    pushError(errors, "response.sessionEpoch must match the originating session epoch.");
  }

  if (value.ok === true && isRecord(value.payload)) {
    if ((request.type === "session.processKeyStroke" || request.type === "session.updateComposition" ||
         request.type === "session.commitCandidate" || request.type === "session.commitRaw") &&
        isRecord(request.payload) && value.payload.sessionId !== request.payload.sessionId) {
      pushError(errors, "response payload sessionId must match the originating session.");
    }
  }
  if (value.ok === true && request.type === "proofHints.get" &&
      isRecord(request.payload) && typeof request.payload.textWindow === "string") {
    validateProofHintCoordinatesForText(
      value.payload,
      request.payload.textWindow,
      "payload",
      errors
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], response: value as unknown as IpcResponse };
}

export function validateIpcResponsePayload(type: IpcMessageType, payload: unknown): string[] {
  const errors: string[] = [];
  const schemas = IPC_RESPONSE_PAYLOAD_SCHEMAS as unknown as Record<IpcMessageType, SchemaNode>;
  validateSchema(payload, schemas[type], "payload", errors, 0);
  if (errors.length === 0) validateResponseSemantics(type, payload, errors);
  return errors;
}

function validateResponseSemantics(type: IpcMessageType, payload: unknown, errors: string[]): void {
  if (type === "session.processKeyStroke" || type === "session.updateComposition") {
    validateCandidateUpdateSemantics(payload, errors);
    return;
  }
  if (type === "session.commitCandidate" || type === "session.commitRaw") {
    validateCommitResultSemantics(type, payload, errors);
    return;
  }
  if (type === "suggestions.get") {
    validateCandidateList(payload, "payload", errors);
    return;
  }
  if (type === "proofHints.get" && Array.isArray(payload)) {
    payload.forEach((hint, index) => {
      if (isRecord(hint)) validateOptionalRange(hint.range, `payload[${index}].range`, errors, { required: true });
    });
  }
}

function validateProofHintCoordinatesForText(
  value: unknown,
  text: string,
  path: string,
  errors: string[]
): void {
  if (!Array.isArray(value)) return;
  const coordinates: TextCoordinates = {
    text,
    boundaries: new Set(graphemeBoundaries(text))
  };
  value.forEach((hint, index) => {
    if (!isRecord(hint)) return;
    const hintPath = `${path}[${index}]`;
    const validRange = validateOptionalRange(hint.range, `${hintPath}.range`, errors, {
      coordinates,
      required: true
    });
    if (validRange && Array.isArray(hint.range) && typeof hint.original === "string" &&
        text.slice(hint.range[0] as number, hint.range[1] as number) !== hint.original) {
      pushError(errors, `${hintPath}.original must equal the originating request text selected by its range.`);
    }
  });
}

function validateCandidateUpdateSemantics(payload: unknown, errors: string[]): void {
  if (!isRecord(payload) || typeof payload.compositionText !== "string") return;
  const coordinates: TextCoordinates = {
    text: payload.compositionText,
    boundaries: new Set(graphemeBoundaries(payload.compositionText))
  };

  if (typeof payload.caret === "number") {
    if (payload.caret > coordinates.text.length) {
      pushError(errors, "payload.caret must be within the UTF-16 composition range.");
    } else if (!coordinates.boundaries.has(payload.caret)) {
      pushError(errors, "payload.caret must align with a UTF-16 grapheme boundary.");
    }
  }

  validateOptionalRange(payload.consumedRange, "payload.consumedRange", errors);
  validateCandidateList(payload.candidates, "payload.candidates", errors, coordinates);
  validatePrimaryCandidate(payload, errors, coordinates);
  if (isRecord(payload.inlineCompletion) && isRecord(payload.inlineCompletion.candidate)) {
    validateCandidateSemantics(
      payload.inlineCompletion.candidate,
      "payload.inlineCompletion.candidate",
      errors,
      coordinates
    );
  }
  if (Array.isArray(payload.proofHints)) {
    payload.proofHints.forEach((hint, index) => {
      if (!isRecord(hint)) return;
      const path = `payload.proofHints[${index}]`;
      const rangeIsValid = validateOptionalRange(hint.range, `${path}.range`, errors, {
        coordinates,
        required: true
      });
      if (rangeIsValid && Array.isArray(hint.range) && typeof hint.original === "string" &&
          coordinates.text.slice(hint.range[0] as number, hint.range[1] as number) !== hint.original) {
        pushError(errors, `${path}.original must equal the composition text selected by its range.`);
      }
    });
  }

  validateCandidateUpdateAction(payload, errors);
}

function validateCandidateUpdateAction(payload: Record<string, unknown>, errors: string[]): void {
  const committedText = typeof payload.committedText === "string" ? payload.committedText : undefined;
  if (payload.action === "commit") {
    if (!committedText) {
      pushError(errors, "payload.committedText must be non-empty when action is commit.");
    }
    if (payload.compositionText !== "" || payload.displayText !== "" || payload.caret !== 0 ||
        !Array.isArray(payload.candidates) || payload.candidates.length !== 0 ||
        payload.primary !== undefined || !validTerminalInlineCompletion(payload.inlineCompletion) ||
        !Array.isArray(payload.proofHints) || payload.proofHints.length !== 0 ||
        payload.shouldShowCandidateUI !== false) {
      pushError(errors, "payload commit action must carry a cleared terminal composition state.");
    }
    if (payload.consumedRange === undefined) {
      pushError(errors, "payload.consumedRange must be present when action is commit.");
    }
    return;
  }

  if ("committedText" in payload) {
    pushError(errors, "payload.committedText must be absent unless action is commit.");
  }
  if ("consumedRange" in payload) {
    pushError(errors, "payload.consumedRange must be absent unless action is commit.");
  }
  if (payload.action === "cancel" &&
      (payload.compositionText !== "" || payload.displayText !== "" || payload.caret !== 0 ||
       !Array.isArray(payload.candidates) || payload.candidates.length !== 0 ||
       payload.primary !== undefined || !validTerminalInlineCompletion(payload.inlineCompletion) ||
       !Array.isArray(payload.proofHints) || payload.proofHints.length !== 0 ||
       payload.shouldShowCandidateUI !== false || payload.consumedRange !== undefined)) {
    pushError(errors, "payload cancel action must carry a cleared terminal composition state.");
  }
}

function validTerminalInlineCompletion(value: unknown): boolean {
  return value === undefined || (isRecord(value) && value.source === "ngram-lm");
}

function validateCommitResultSemantics(
  type: "session.commitCandidate" | "session.commitRaw",
  payload: unknown,
  errors: string[]
): void {
  if (!isRecord(payload)) return;
  validateOptionalRange(payload.consumedRange, "payload.consumedRange", errors);
  validateOptionalRange(payload.replacementRange, "payload.replacementRange", errors);
  validateCandidateList(payload.followupCandidates, "payload.followupCandidates", errors);

  const isCommit = payload.action === "commit";
  const committedText = typeof payload.committedText === "string" ? payload.committedText : "";
  const commitEpoch = typeof payload.commitEpoch === "number" ? payload.commitEpoch : -1;
  if (payload.action === "cancel" || (type === "session.commitRaw" && payload.action === "compose")) {
    pushError(errors, `payload.action is not a valid ${type} result action.`);
  }
  if (isCommit) {
    if (!committedText) pushError(errors, "payload.committedText must be non-empty when action is commit.");
    if (commitEpoch < 1) pushError(errors, "payload.commitEpoch must be positive when action is commit.");
  } else {
    if (committedText) pushError(errors, "payload.committedText must be empty unless action is commit.");
    if (payload.memoryRecorded !== false) {
      pushError(errors, "payload.memoryRecorded must be false unless action is commit.");
    }
    if (Array.isArray(payload.followupCandidates) && payload.followupCandidates.length > 0) {
      pushError(errors, "payload.followupCandidates must be empty unless action is commit.");
    }
    if (payload.replacementRange !== undefined) {
      pushError(errors, "payload.replacementRange is only valid when action is commit.");
    }
  }
  if (!isCommit && commitEpoch !== 0) {
    pushError(errors, "payload.commitEpoch must be zero unless action is commit.");
  }
}

function validatePrimaryCandidate(
  payload: Record<string, unknown>,
  errors: string[],
  coordinates: TextCoordinates
): void {
  if (!Array.isArray(payload.candidates)) return;
  if (payload.candidates.length === 0) {
    if (payload.primary !== undefined) {
      pushError(errors, "payload.primary must be absent when payload.candidates is empty.");
    }
    return;
  }
  if (!isRecord(payload.primary)) {
    pushError(errors, "payload.primary must identify the first candidate when candidates are present.");
    return;
  }
  validateCandidateSemantics(payload.primary, "payload.primary", errors, coordinates);
  if (!isRecord(payload.candidates[0]) || stableFingerprint(payload.primary) !== stableFingerprint(payload.candidates[0])) {
    pushError(errors, "payload.primary must exactly match the first candidate.");
  }
}

function validateCandidateList(
  value: unknown,
  path: string,
  errors: string[],
  coordinates?: TextCoordinates
): void {
  if (!Array.isArray(value)) return;
  const ids = new Set<string>();
  value.forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    validateCandidateSemantics(candidate, `${path}[${index}]`, errors, coordinates);
    if (typeof candidate.id !== "string") return;
    if (ids.has(candidate.id)) pushError(errors, `${path} must not contain duplicate candidate identifiers.`);
    ids.add(candidate.id);
  });
}

function validateCandidateSemantics(
  candidate: Record<string, unknown>,
  path: string,
  errors: string[],
  coordinates?: TextCoordinates
): void {
  validateOptionalRange(candidate.replaceRange, `${path}.replaceRange`, errors, {
    coordinates
  });
}

interface TextCoordinates {
  text: string;
  boundaries: ReadonlySet<number>;
}

interface RangeSemantics {
  coordinates?: TextCoordinates;
  required?: boolean;
}

function validateOptionalRange(
  value: unknown,
  path: string,
  errors: string[],
  semantics: RangeSemantics = {}
): boolean {
  if (value === undefined) return !semantics.required;
  if (!Array.isArray(value) || value.length !== 2 ||
      !Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1])) {
    return false;
  }
  const start = value[0] as number;
  const end = value[1] as number;
  let valid = true;
  if (start > end) {
    pushError(errors, `${path} must be ordered start-to-end.`);
    valid = false;
  }
  if (semantics.coordinates && end > semantics.coordinates.text.length) {
    pushError(errors, `${path} must stay within the UTF-16 composition range.`);
    valid = false;
  }
  if (semantics.coordinates &&
      (!semantics.coordinates.boundaries.has(start) || !semantics.coordinates.boundaries.has(end))) {
    pushError(errors, `${path} must align with UTF-16 grapheme boundaries.`);
    valid = false;
  }
  return valid;
}

function validateSchema(
  value: unknown,
  schema: SchemaNode | undefined,
  path: string,
  errors: string[],
  depth: number
): void {
  if (errors.length >= MAXIMUM_VALIDATION_ERRORS) return;
  if (schema === undefined || schema === false) {
    pushError(errors, `${path} is not allowed by the generated response schema.`);
    return;
  }
  if (schema === true) return;
  if (depth > MAXIMUM_SCHEMA_DEPTH) {
    pushError(errors, `${path} exceeded the generated schema depth.`);
    return;
  }
  if (schema.$ref) {
    const name = schema.$ref.startsWith("#/$defs/") ? schema.$ref.slice("#/$defs/".length) : "";
    const definitions = IPC_COMMON_DEFINITIONS as unknown as Record<string, SchemaNode>;
    if (!name || !Object.hasOwn(definitions, name)) {
      pushError(errors, `${path} referenced an unknown generated schema definition.`);
      return;
    }
    validateSchema(value, definitions[name], path, errors, depth + 1);
    return;
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors: string[] = [];
      validateSchema(value, candidate, path, candidateErrors, depth + 1);
      return candidateErrors.length === 0;
    }).length;
    if (matches !== 1) pushError(errors, `${path} must match exactly one generated schema alternative.`);
    return;
  }
  if ("const" in schema && !Object.is(value, schema.const)) {
    pushError(errors, `${path} must equal the generated constant.`);
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    pushError(errors, `${path} must be a generated enum value.`);
    return;
  }

  switch (schema.type) {
    case "null":
      if (value !== null) pushError(errors, `${path} must be null.`);
      return;
    case "boolean":
      if (typeof value !== "boolean") pushError(errors, `${path} must be a boolean.`);
      return;
    case "string":
      validateString(value, schema, path, errors);
      return;
    case "number":
      validateNumber(value, schema, path, errors, false);
      return;
    case "integer":
      validateNumber(value, schema, path, errors, true);
      return;
    case "array":
      validateArray(value, schema, path, errors, depth);
      return;
    case "object":
      validateObject(value, schema, path, errors, depth);
      return;
    case undefined:
      return;
  }
}

function validateString(value: unknown, schema: Exclude<SchemaNode, boolean>, path: string, errors: string[]): void {
  if (typeof value !== "string") {
    pushError(errors, `${path} must be a string.`);
    return;
  }
  if (!isWellFormedUtf16(value)) {
    pushError(errors, `${path} must contain well-formed UTF-16.`);
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    pushError(errors, `${path} is shorter than the generated minimum.`);
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    pushError(errors, `${path} exceeds the generated string bound.`);
  }
}

function validateNumber(
  value: unknown,
  schema: Exclude<SchemaNode, boolean>,
  path: string,
  errors: string[],
  integer: boolean
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    pushError(errors, `${path} must be a finite${integer ? " safe integer" : " number"}.`);
    return;
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    pushError(errors, `${path} is below the generated minimum.`);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    pushError(errors, `${path} exceeds the generated maximum.`);
  }
}

function validateArray(
  value: unknown,
  schema: Exclude<SchemaNode, boolean>,
  path: string,
  errors: string[],
  depth: number
): void {
  if (!Array.isArray(value)) {
    pushError(errors, `${path} must be an array.`);
    return;
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    pushError(errors, `${path} has fewer entries than the generated minimum.`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    pushError(errors, `${path} exceeds the generated array bound.`);
  }
  if (schema.uniqueItems) {
    const fingerprints = value.map(stableFingerprint);
    if (new Set(fingerprints).size !== fingerprints.length) pushError(errors, `${path} must contain unique entries.`);
  }
  const prefixLength = schema.prefixItems?.length ?? 0;
  schema.prefixItems?.forEach((itemSchema, index) => {
    if (index < value.length) validateSchema(value[index], itemSchema, `${path}[${index}]`, errors, depth + 1);
  });
  if (schema.items === false && value.length > prefixLength) {
    pushError(errors, `${path} contains entries beyond the generated tuple length.`);
  } else if (schema.items && schema.items !== true) {
    for (let index = prefixLength; index < value.length; index += 1) {
      validateSchema(value[index], schema.items, `${path}[${index}]`, errors, depth + 1);
    }
  }
}

function validateObject(
  value: unknown,
  schema: Exclude<SchemaNode, boolean>,
  path: string,
  errors: string[],
  depth: number
): void {
  if (!isRecord(value)) {
    pushError(errors, `${path} must be an object.`);
    return;
  }
  const properties = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) pushError(errors, `${path}.${key} is required.`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) pushError(errors, `${path}.${key} is not allowed.`);
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) validateSchema(value[key], childSchema, `${path}.${key}`, errors, depth + 1);
  }
}

function stableFingerprint(value: unknown): string {
  if (value === null || typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableFingerprint).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableFingerprint(record[key])}`).join(",")}}`;
}

function pushError(errors: string[], message: string): void {
  if (errors.length < MAXIMUM_VALIDATION_ERRORS) errors.push(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
