import {
  IPC_PROTOCOL_LIMITS,
  createIpcErrorResponse
} from "../../shared/ipc/messages";
import { KeyboardDaemon } from "./keyboardDaemon";

export const MAX_IPC_LINE_BYTES = IPC_PROTOCOL_LIMITS.maximumFrameBytes;

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
      } catch {
        return JSON.stringify(
          createIpcErrorResponse({
            id: "parse_error",
            type: "health.check"
          }, {
            code: "IPC_JSON_PARSE_FAILED",
            message: "IPC input was not valid JSON.",
            recoverable: true
          })
        );
      }

      const response = await daemon.handle(parsed);
      return JSON.stringify(response);
    },
    async shutdown(): Promise<void> {
      await daemon.shutdown();
    }
  };
}
