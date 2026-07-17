import {
  IPC_COMMON_DEFINITIONS,
  IPC_RESPONSE_PAYLOAD_SCHEMAS
} from "./generatedResponseSchemas";
import {
  isIpcMessageType,
  validateIpcEnvelope
} from "./messages";
import type {
  IpcMessageType,
  IpcResponse
} from "./messages";

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
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], response: value as IpcResponse };
}

export function validateIpcResponsePayload(type: IpcMessageType, payload: unknown): string[] {
  const errors: string[] = [];
  const schemas = IPC_RESPONSE_PAYLOAD_SCHEMAS as unknown as Record<IpcMessageType, SchemaNode>;
  validateSchema(payload, schemas[type], "payload", errors, 0);
  return errors;
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
