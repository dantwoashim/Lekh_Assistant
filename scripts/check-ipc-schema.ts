import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  IPC_MESSAGE_TYPES,
  IPC_SCHEMA_VERSION,
  createIpcRequest,
  createIpcResponse,
  validateIpcEnvelope
} from "../native/shared/ipc/messages";
import { validateIpcRequest } from "../native/shared/ipc/requestValidation";
import { validateIpcResponse } from "../native/shared/ipc/responseValidation";
import { isWellFormedUtf16 } from "../native/shared/ipc/utf16";

interface JsonSchema {
  $defs?: {
    MessageType?: {
      enum?: unknown[];
    };
    IpcRequest?: {
      properties?: {
        version?: {
          const?: unknown;
        };
      };
    };
  };
}

const schemaPath = resolve("native/shared/ipc/lekh-keyboard-ipc.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchema;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addKeyword({
  keyword: "x-maxUtf16CodeUnits",
  schemaType: "number",
  type: "string",
  validate: (maximum: number, value: string) => value.length <= maximum,
  errors: false
});
ajv.addKeyword({
  keyword: "x-wellFormedUtf16",
  schemaType: "boolean",
  type: "string",
  validate: (required: boolean, value: string) => !required || isWellFormedUtf16(value),
  errors: false
});
const validateGeneratedSchema = ajv.compile(schema);

const schemaMessageTypes = schema.$defs?.MessageType?.enum ?? [];
const missingFromSchema = IPC_MESSAGE_TYPES.filter((type) => !schemaMessageTypes.includes(type));
const extraInSchema = schemaMessageTypes.filter((type) => !IPC_MESSAGE_TYPES.includes(type as (typeof IPC_MESSAGE_TYPES)[number]));
const schemaVersion = schema.$defs?.IpcRequest?.properties?.version?.const;

const sample = createIpcRequest("health.check", { client: "daemon-test" }, "ipc_schema_smoke", 1);
const validation = validateIpcEnvelope(sample);
const sampleResponse = createIpcResponse(sample, {
  status: "ok",
  engineReady: true,
  warnings: []
}, 0, { serverInstanceId: "ipc-schema-server" });

const astralInput = "😀".repeat(128);
const astralOverflow = createIpcRequest("session.updateComposition", {
  sessionId: "session-astral-overflow",
  sessionEpoch: 1,
  input: astralInput,
  cursor: 0
}, "ipc_schema_astral", 1);
const malformedUtf16 = {
  ...astralOverflow,
  id: "ipc_schema_malformed",
  payload: { ...astralOverflow.payload, input: "\ud800", cursor: 0 }
};
const invalidSuccessEnvelope = {
  ...sampleResponse,
  requestSequence: 0,
  sessionEpoch: 9
};

const parityCases = [
  {
    name: "valid request",
    schemaValid: validateGeneratedSchema(sample),
    runtimeValid: validateIpcRequest(sample).ok,
    expected: true
  },
  {
    name: "valid response",
    schemaValid: validateGeneratedSchema(sampleResponse),
    runtimeValid: validateIpcResponse(sampleResponse).ok,
    expected: true
  },
  {
    name: "UTF-16 astral composition overflow",
    schemaValid: validateGeneratedSchema(astralOverflow),
    runtimeValid: validateIpcRequest(astralOverflow).ok,
    expected: false
  },
  {
    name: "malformed UTF-16 request",
    schemaValid: validateGeneratedSchema(malformedUtf16),
    runtimeValid: validateIpcRequest(malformedUtf16).ok,
    expected: false
  },
  {
    name: "non-session success with zero sequence and epoch",
    schemaValid: validateGeneratedSchema(invalidSuccessEnvelope),
    runtimeValid: validateIpcResponse(invalidSuccessEnvelope).ok,
    expected: false
  }
];

const failures = [
  ...missingFromSchema.map((type) => `Missing IPC message type in schema: ${type}`),
  ...extraInSchema.map((type) => `Unexpected IPC message type in schema: ${String(type)}`),
  schemaVersion === IPC_SCHEMA_VERSION ? "" : `Schema request version ${String(schemaVersion)} does not match ${IPC_SCHEMA_VERSION}.`,
  validation.ok ? "" : `Runtime IPC validator rejected sample envelope: ${validation.errors.join("; ")}`,
  ...parityCases.flatMap((testCase) => [
    testCase.schemaValid === testCase.expected
      ? ""
      : `Generated JSON Schema parity failed for ${testCase.name}: expected ${testCase.expected}, received ${testCase.schemaValid}.`,
    testCase.runtimeValid === testCase.expected
      ? ""
      : `Runtime validator parity failed for ${testCase.name}: expected ${testCase.expected}, received ${testCase.runtimeValid}.`,
    testCase.schemaValid === testCase.runtimeValid
      ? ""
      : `Generated schema and runtime validator disagree for ${testCase.name}.`
  ])
].filter(Boolean);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      schema: schemaPath,
      version: IPC_SCHEMA_VERSION,
      messageTypes: IPC_MESSAGE_TYPES.length,
      checkedAt: new Date().toISOString()
    },
    null,
    2
  )
);
