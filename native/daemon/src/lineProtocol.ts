import {
  IPC_SCHEMA_VERSION,
  createIpcErrorResponse,
  validateIpcEnvelope
} from "../../shared/ipc/messages";
import type { IpcRequest } from "../../shared/ipc/messages";
import { KeyboardDaemon } from "./keyboardDaemon";

export const MAX_IPC_LINE_BYTES = 64 * 1024;

export interface DaemonLineHandler {
  handleLine(line: string): Promise<string>;
  shutdown(): Promise<void>;
}

export function createDaemonLineHandler(daemon = new KeyboardDaemon()): DaemonLineHandler {
  return {
    async handleLine(line: string): Promise<string> {
      if (Buffer.byteLength(line, "utf8") > MAX_IPC_LINE_BYTES) {
        return JSON.stringify(
          createIpcErrorResponse({
            id: "payload_too_large",
            type: "health.check"
          }, {
            code: "IPC_PAYLOAD_TOO_LARGE",
            message: `IPC input line exceeded ${MAX_IPC_LINE_BYTES} bytes.`,
            recoverable: true
          })
        );
      }

      const trimmed = line.trim();
      if (!trimmed) {
        return JSON.stringify(
          createIpcErrorResponse({
            id: "empty",
            type: "health.check"
          }, {
            code: "IPC_EMPTY_LINE",
            message: "IPC input line was empty.",
            recoverable: true
          })
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        return JSON.stringify(
          createIpcErrorResponse({
            id: "parse_error",
            type: "health.check"
          }, {
            code: "IPC_JSON_PARSE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            recoverable: true
          })
        );
      }

      const validation = validateIpcEnvelope(parsed);
      if (!validation.ok) {
        const partial = parsed as Partial<IpcRequest>;
        const response = createIpcErrorResponse({
          id: typeof partial.id === "string" && partial.id ? partial.id : "invalid",
          type: "health.check"
        }, {
          code: "IPC_SCHEMA_INVALID",
          message: validation.errors.join(" "),
          recoverable: true
        });
        return JSON.stringify(response);
      }

      const response = await daemon.handle(parsed as IpcRequest);
      return JSON.stringify(response);
    },
    async shutdown(): Promise<void> {
      const shutdownRequest: IpcRequest = {
        id: "daemon_cli_shutdown",
        type: "engine.shutdown",
        version: IPC_SCHEMA_VERSION,
        sentAt: Date.now(),
        payload: undefined
      };
      await daemon.handle(shutdownRequest);
    }
  };
}
