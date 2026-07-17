import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const specPath = resolve(root, "native/shared/ipc/lekh-keyboard-protocol.json");
const outputs = {
  schema: resolve(root, "native/shared/ipc/lekh-keyboard-ipc.schema.json"),
  typescript: resolve(root, "native/shared/ipc/generatedProtocol.ts"),
  swift: resolve(root, "native/macos-imk/skeleton/LekhIPCProtocol.generated.swift"),
  cpp: resolve(root, "native/shared/ipc/generated/LekhIPCProtocol.generated.h")
};

const checkOnly = process.argv.includes("--check");
const spec = JSON.parse(await readFile(specPath, "utf8"));
validateSpec(spec);

const generated = {
  schema: `${JSON.stringify(generateSchema(spec), null, 2)}\n`,
  typescript: generateTypeScript(spec),
  swift: generateSwift(spec),
  cpp: generateCpp(spec)
};

if (checkOnly) {
  const stale = [];
  for (const [kind, path] of Object.entries(outputs)) {
    let actual;
    try {
      actual = await readFile(path, "utf8");
    } catch {
      stale.push(`${kind}: missing ${path}`);
      continue;
    }
    if (actual !== generated[kind]) stale.push(`${kind}: regenerate ${path}`);
  }
  if (stale.length > 0) {
    console.error(stale.join("\n"));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "pass", version: spec.currentVersion, messageTypes: spec.messages.length }, null, 2));
} else {
  for (const [kind, path] of Object.entries(outputs)) await writeFile(path, generated[kind], "utf8");
  console.log(JSON.stringify({ status: "generated", version: spec.currentVersion, outputs }, null, 2));
}

function validateSpec(value) {
  const fail = (message) => { throw new Error(`Invalid IPC protocol specification: ${message}`); };
  if (!Number.isSafeInteger(value.currentVersion) || value.currentVersion < 1) fail("currentVersion must be positive");
  if (!Array.isArray(value.compatibleVersions) || !value.compatibleVersions.includes(value.currentVersion)) {
    fail("compatibleVersions must include currentVersion");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) fail("messages must be non-empty");
  const types = value.messages.map((message) => message.type);
  if (types.some((type) => typeof type !== "string" || !type)) fail("every message needs a type");
  if (new Set(types).size !== types.length) fail("message types must be unique");
  for (const message of value.messages) {
    if (typeof message.sessionBound !== "boolean") fail(`${message.type}.sessionBound must be boolean`);
    if (!message.requestPayload || typeof message.requestPayload !== "object") fail(`${message.type} needs requestPayload`);
  }
  const codes = value.errors.map((error) => error.code);
  if (new Set(codes).size !== codes.length) fail("error codes must be unique");
  for (const error of value.errors) {
    if (!value.recoveryActions.includes(error.action)) fail(`${error.code} has an unknown recovery action`);
  }
}

function generateSchema(value) {
  const messageTypes = value.messages.map((message) => message.type);
  const requestConditions = value.messages.map((message) => ({
    if: { properties: { type: { const: message.type } }, required: ["type"] },
    then: { properties: { payload: message.requestPayload } }
  }));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://lekh.local/schemas/lekh-keyboard-ipc.schema.json",
    title: value.protocolName,
    description: "Generated versioned local-only IPC contract for native keyboard shells, daemon, and companion.",
    oneOf: [{ $ref: "#/$defs/IpcRequest" }, { $ref: "#/$defs/IpcResponse" }],
    $defs: {
      ...value.commonDefinitions,
      SessionPayload: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: { sessionId: { $ref: "#/$defs/SessionId" } }
      },
      MessageType: { type: "string", enum: messageTypes },
      ErrorCode: { type: "string", enum: value.errors.map((error) => error.code) },
      RecoveryAction: { type: "string", enum: value.recoveryActions },
      IpcRequest: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "version", "sentAt", "payload"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: value.limits.maximumIdentifierLength },
          type: { $ref: "#/$defs/MessageType" },
          version: { const: value.currentVersion },
          sentAt: { type: "number" },
          payload: true
        },
        allOf: requestConditions
      },
      IpcResponse: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "version", "ok"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: value.limits.maximumIdentifierLength },
          type: { $ref: "#/$defs/MessageType" },
          version: { const: value.currentVersion },
          ok: { type: "boolean" },
          payload: true,
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "recoverable"],
            properties: {
              code: { $ref: "#/$defs/ErrorCode" },
              message: { type: "string", minLength: 1, maxLength: value.limits.maximumTextLength },
              recoverable: { type: "boolean" },
              action: { $ref: "#/$defs/RecoveryAction" }
            }
          },
          latencyMs: { type: "number", minimum: 0 }
        },
        allOf: [
          {
            if: { properties: { ok: { const: true } }, required: ["ok"] },
            then: { required: ["payload"], not: { required: ["error"] } },
            else: { required: ["error"], not: { required: ["payload"] } }
          }
        ]
      }
    }
  };
}

function generateTypeScript(value) {
  const descriptors = Object.fromEntries(value.messages.map((message) => [message.type, {
    sessionBound: message.sessionBound,
    deadlineClass: message.deadlineClass
  }]));
  return `// Generated from lekh-keyboard-protocol.json. Do not edit.\n` +
    `export const IPC_SCHEMA_VERSION = ${value.currentVersion} as const;\n` +
    `export const IPC_COMPATIBLE_SCHEMA_VERSIONS = ${JSON.stringify(value.compatibleVersions)} as const;\n` +
    `export const IPC_CLIENTS = ${JSON.stringify(value.clients)} as const;\n` +
    `export const IPC_PROTOCOL_LIMITS = ${JSON.stringify(value.limits, null, 2)} as const;\n` +
    `export const IPC_MESSAGE_DESCRIPTORS = ${JSON.stringify(descriptors, null, 2)} as const;\n` +
    `export const IPC_MESSAGE_TYPES = Object.freeze(Object.keys(IPC_MESSAGE_DESCRIPTORS)) as readonly (keyof typeof IPC_MESSAGE_DESCRIPTORS)[];\n` +
    `export type GeneratedIpcMessageType = keyof typeof IPC_MESSAGE_DESCRIPTORS;\n` +
    `export const IPC_ERROR_DEFINITIONS = ${JSON.stringify(Object.fromEntries(value.errors.map((error) => [error.code, {
      recoverable: error.recoverable,
      action: error.action
    }])), null, 2)} as const;\n` +
    `export type IpcErrorCode = keyof typeof IPC_ERROR_DEFINITIONS;\n` +
    `export type IpcRecoveryAction = (typeof IPC_ERROR_DEFINITIONS)[IpcErrorCode]["action"];\n`;
}

function generateSwift(value) {
  const cases = value.messages.map((message) => `  case ${swiftIdentifier(message.type)} = "${message.type}"`).join("\n");
  const errors = value.errors.map((error) => `  case ${swiftIdentifier(error.code.toLowerCase())} = "${error.code}"`).join("\n");
  return `// Generated from lekh-keyboard-protocol.json. Do not edit.\nimport Foundation\n\n` +
    `public enum LekhIPCProtocolContract {\n` +
    `  public static let schemaVersion = ${value.currentVersion}\n` +
    `  public static let compatibleVersions = ${JSON.stringify(value.compatibleVersions)}\n` +
    `  public static let maximumFrameBytes = ${value.limits.maximumFrameBytes}\n` +
    `  public static let hotPathDeadlineMilliseconds = ${value.limits.hotPathDeadlineMs}\n` +
    `  public static let maximumPendingRequestsPerConnection = ${value.limits.maximumPendingRequestsPerConnection}\n` +
    `}\n\npublic enum LekhIPCMessageType: String, CaseIterable, Sendable {\n${cases}\n}\n\n` +
    `public enum LekhIPCErrorCode: String, CaseIterable, Sendable {\n${errors}\n}\n`;
}

function generateCpp(value) {
  const messages = value.messages.map((message) => `  "${message.type}"`).join(",\n");
  const errors = value.errors.map((error) => `  "${error.code}"`).join(",\n");
  return `// Generated from lekh-keyboard-protocol.json. Do not edit.\n#pragma once\n\n#include <array>\n#include <cstddef>\n#include <cstdint>\n#include <string_view>\n\nnamespace lekh::ipc {\n` +
    `inline constexpr std::uint32_t kSchemaVersion = ${value.currentVersion};\n` +
    `inline constexpr std::size_t kMaximumFrameBytes = ${value.limits.maximumFrameBytes};\n` +
    `inline constexpr std::uint32_t kHotPathDeadlineMilliseconds = ${value.limits.hotPathDeadlineMs};\n` +
    `inline constexpr std::size_t kMaximumPendingRequestsPerConnection = ${value.limits.maximumPendingRequestsPerConnection};\n` +
    `inline constexpr std::array<std::string_view, ${value.messages.length}> kMessageTypes = {\n${messages}\n};\n` +
    `inline constexpr std::array<std::string_view, ${value.errors.length}> kErrorCodes = {\n${errors}\n};\n` +
    `} // namespace lekh::ipc\n`;
}

function swiftIdentifier(value) {
  const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const identifier = words.map((word, index) => index === 0 ? word : word[0].toUpperCase() + word.slice(1)).join("");
  return /^\d/.test(identifier) ? `value${identifier}` : identifier;
}
