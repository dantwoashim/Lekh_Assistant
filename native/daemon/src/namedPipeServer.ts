import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { MAX_IPC_LINE_BYTES, createDaemonLineHandler } from "./lineProtocol";
import { defaultWindowsPipeName } from "./windowsPipeName";

export const WINDOWS_PIPE_NAME = defaultWindowsPipeName();
export const SOCKET_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface NamedPipeDaemon {
  pipeName: string;
  close(): Promise<void>;
}

export async function startWindowsNamedPipeDaemon(pipeName = defaultWindowsPipeName()): Promise<NamedPipeDaemon> {
  if (process.platform !== "win32") {
    throw new Error("Windows named-pipe daemon mode requires process.platform === 'win32'.");
  }

  const handler = createDaemonLineHandler();
  const server = createServer((socket) => wireSocket(socket, handler));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    pipeName,
    async close() {
      await handler.shutdown();
      await closeServer(server);
    }
  };
}

function wireSocket(socket: Socket, handler: ReturnType<typeof createDaemonLineHandler>): void {
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
    socket.destroy(new Error("Named pipe client timed out."));
  });
  let buffer = "";
  const responses = createOrderedResponseQueue(
    (line) => handler.handleLine(line),
    (response) => {
      socket.write(`${response}\n`);
    },
    namedPipeErrorResponse
  );

  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_IPC_LINE_BYTES) {
      socket.write(
        `${JSON.stringify({
          id: "payload_too_large",
          type: "health.check",
          version: 1,
          ok: false,
          error: {
            code: "IPC_PAYLOAD_TOO_LARGE",
            message: `IPC input line exceeded ${MAX_IPC_LINE_BYTES} bytes.`,
            recoverable: true
          }
        })}\n`,
        () => socket.destroy()
      );
      return;
    }
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      void responses.enqueue(line);
    }
  });
}

export interface OrderedResponseQueue {
  enqueue(line: string): Promise<void>;
  drain(): Promise<void>;
}

export function createOrderedResponseQueue(
  handleLine: (line: string) => Promise<string>,
  writeLine: (response: string) => void | Promise<void>,
  errorResponse: (error: unknown) => string
): OrderedResponseQueue {
  let tail = Promise.resolve();
  return {
    enqueue(line) {
      const current = tail.then(async () => {
        try {
          await writeLine(await handleLine(line));
        } catch (error) {
          await writeLine(errorResponse(error));
        }
      });
      // A failed transport write must not allow a later request to overtake it
      // or permanently poison the queue. Socket errors are handled separately.
      tail = current.catch(() => undefined);
      return current;
    },
    drain() {
      return tail;
    }
  };
}

function namedPipeErrorResponse(error: unknown): string {
  return JSON.stringify({
    id: "named_pipe_failed",
    type: "health.check",
    version: 1,
    ok: false,
    error: {
      code: "NAMED_PIPE_REQUEST_FAILED",
      message: error instanceof Error ? error.message : String(error),
      recoverable: true
    }
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
