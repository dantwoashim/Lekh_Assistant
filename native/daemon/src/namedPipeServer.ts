import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { createDaemonLineHandler } from "./lineProtocol";
import { defaultWindowsPipeName } from "./windowsPipeName";

export const WINDOWS_PIPE_NAME = defaultWindowsPipeName();

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
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      void handler.handleLine(line).then(
        (response) => socket.write(`${response}\n`),
        (error) =>
          socket.write(
            `${JSON.stringify({
              id: "named_pipe_failed",
              type: "health.check",
              version: 1,
              ok: false,
              error: {
                code: "NAMED_PIPE_REQUEST_FAILED",
                message: error instanceof Error ? error.message : String(error),
                recoverable: true
              }
            })}\n`
          )
      );
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
