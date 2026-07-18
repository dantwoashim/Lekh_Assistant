import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { TextDecoder } from "node:util";
import {
  IPC_PROTOCOL_LIMITS,
  createIpcErrorResponse
} from "../../shared/ipc/messages";
import { MAX_IPC_LINE_BYTES, createDaemonLineHandler } from "./lineProtocol";
import { createProductionDaemonLineHandler } from "./productionDaemon";
import { defaultWindowsPipeName } from "./windowsPipeName";

export const SOCKET_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const MAXIMUM_ACTIVE_PIPE_CONNECTIONS = IPC_PROTOCOL_LIMITS.maximumActiveConnections;

export interface NamedPipeDaemon {
  pipeName: string;
  close(): Promise<void>;
}

export async function startWindowsNamedPipeDaemon(pipeName?: string): Promise<NamedPipeDaemon> {
  if (process.platform !== "win32") {
    throw new Error("Windows named-pipe daemon mode requires process.platform === 'win32'.");
  }
  const resolvedPipeName = pipeName ?? defaultWindowsPipeName();

  const handler = await createProductionDaemonLineHandler();
  const connections = new Map<Socket, OrderedResponseQueue>();
  let shuttingDown = false;
  const server = createServer((socket) => {
    if (shuttingDown || connections.size >= MAXIMUM_ACTIVE_PIPE_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const responses = wireSocket(socket, handler);
    connections.set(socket, responses);
    socket.once("close", () => {
      responses.cancel();
      connections.delete(socket);
    });
  });

  await listenNamedPipeServer(server, resolvedPipeName, () => handler.shutdown());

  let closePromise: Promise<void> | undefined;
  return {
    pipeName: resolvedPipeName,
    close() {
      if (!closePromise) {
        closePromise = (async () => {
          shuttingDown = true;
          const serverClosed = closeServer(server);
          const responseQueues = [...connections.values()];
          for (const [socket, responses] of connections) {
            responses.cancel();
            socket.destroy();
          }
          await serverClosed;
          await Promise.all(responseQueues.map((responses) => responses.drain()));
          await handler.shutdown();
        })();
      }
      return closePromise;
    }
  };
}

interface NamedPipeListenServer {
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  listen(pipeName: string, listener: () => void): unknown;
}

/**
 * Opens the public diagnostic listener without leaking the already-opened
 * production database if binding fails (for example, when the pipe is busy).
 */
export async function listenNamedPipeServer(
  server: NamedPipeListenServer,
  pipeName: string,
  cleanup: () => Promise<void>
): Promise<void> {
  let onError: ((error: Error) => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const listener = (error: Error) => reject(error);
      onError = listener;
      server.once("error", listener);
      server.listen(pipeName, () => {
        server.off("error", listener);
        onError = undefined;
        resolve();
      });
    });
  } catch (listenError) {
    if (onError) server.off("error", onError);
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [listenError, cleanupError],
        "Named-pipe startup and daemon-storage cleanup both failed."
      );
    }
    throw listenError;
  }
}

function wireSocket(socket: Socket, handler: ReturnType<typeof createDaemonLineHandler>): OrderedResponseQueue {
  socket.on("error", () => undefined);
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
    socket.destroy(new Error("Named pipe client timed out."));
  });
  let terminating = false;
  const frames = createNamedPipeFrameDecoder();
  const responses = createOrderedResponseQueue(
    (line) => handler.handleLine(line),
    (response) => writeSocketFrame(socket, response),
    () => namedPipeErrorResponse()
  );

  socket.on("data", (chunk) => {
    if (terminating) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const batch = frames.push(bytes);
    if (batch.failure === "payload-too-large") {
      terminate(namedPipePayloadTooLargeResponse());
      return;
    }
    if (batch.failure === "invalid-utf8") {
      terminate(namedPipeInvalidUtf8Response());
      return;
    }
    for (const line of batch.lines) {
      if (!responses.enqueue(line)) {
        terminate(namedPipeQueueFullResponse());
        break;
      }
    }
  });

  return responses;

  function terminate(response: string): void {
    if (terminating) return;
    terminating = true;
    socket.pause();
    void responses.terminate(response).finally(() => socket.destroy());
  }
}

export type NamedPipeFrameFailure = "invalid-utf8" | "payload-too-large";

export interface NamedPipeFrameBatch {
  lines: string[];
  failure?: NamedPipeFrameFailure;
}

export interface NamedPipeFrameDecoder {
  push(chunk: Uint8Array): NamedPipeFrameBatch;
}

export function createNamedPipeFrameDecoder(
  maximumFrameBytes: number = MAX_IPC_LINE_BYTES
): NamedPipeFrameDecoder {
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 2) {
    throw new Error("Named-pipe frame limit must be an integer of at least two bytes.");
  }
  let buffer = Buffer.alloc(0);
  let failed = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return {
    push(chunk) {
      if (failed) return { lines: [] };
      const bytes = Buffer.from(chunk);
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes], buffer.length + bytes.length);
      const lines: string[] = [];

      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        if (newline + 1 > maximumFrameBytes) return failure("payload-too-large");
        let frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
        try {
          lines.push(decoder.decode(frame));
        } catch {
          return failure("invalid-utf8");
        }
      }
      if (buffer.length >= maximumFrameBytes) return failure("payload-too-large");
      return { lines };
    }
  };

  function failure(code: NamedPipeFrameFailure): NamedPipeFrameBatch {
    failed = true;
    buffer = Buffer.alloc(0);
    return { lines: [], failure: code };
  }
}

export interface OrderedResponseQueue {
  enqueue(line: string): boolean;
  terminate(response: string): Promise<void>;
  cancel(): void;
  drain(): Promise<void>;
  pending(): number;
}

export function createOrderedResponseQueue(
  handleLine: (line: string) => Promise<string>,
  writeLine: (response: string) => void | Promise<void>,
  errorResponse: (error: unknown) => string,
  maximumPending: number = IPC_PROTOCOL_LIMITS.maximumPendingRequestsPerConnection
): OrderedResponseQueue {
  let tail = Promise.resolve();
  let pending = 0;
  let accepting = true;
  let cancelPending = false;
  let terminal: Promise<void> | undefined;
  return {
    enqueue(line) {
      if (!accepting || pending >= maximumPending) return false;
      pending += 1;
      const current = tail.then(async () => {
        if (cancelPending) return;
        try {
          const response = await handleLine(line);
          if (!cancelPending) await writeLine(response);
        } catch (error) {
          if (!cancelPending) await writeLine(errorResponse(error));
        }
      }).finally(() => {
        pending = Math.max(0, pending - 1);
      });
      // A failed transport write must not allow a later request to overtake it
      // or permanently poison the queue. Socket errors are handled separately.
      tail = current.catch(() => undefined);
      return true;
    },
    terminate(response) {
      if (terminal) return terminal;
      accepting = false;
      cancelPending = true;
      terminal = tail.then(() => writeLine(response)).catch(() => undefined);
      tail = terminal;
      return terminal;
    },
    cancel() {
      accepting = false;
      cancelPending = true;
    },
    drain() {
      return tail;
    },
    pending() {
      return pending;
    }
  };
}

export function namedPipeErrorResponse(): string {
  return JSON.stringify(createIpcErrorResponse(
    { id: "named_pipe_failed", type: "health.check" },
    {
      code: "NAMED_PIPE_REQUEST_FAILED",
      message: "The named-pipe request could not be completed."
    }
  ));
}

function namedPipeInvalidUtf8Response(): string {
  return JSON.stringify(createIpcErrorResponse(
    { id: "invalid_utf8", type: "health.check" },
    { code: "IPC_JSON_PARSE_FAILED", message: "IPC input was not valid UTF-8." }
  ));
}

function namedPipeQueueFullResponse(): string {
  return JSON.stringify(createIpcErrorResponse(
    { id: "named_pipe_queue_full", type: "health.check" },
    { code: "IPC_QUEUE_FULL", message: "The named-pipe request queue is full." }
  ));
}

function namedPipePayloadTooLargeResponse(): string {
  return JSON.stringify(createIpcErrorResponse(
    { id: "payload_too_large", type: "health.check" },
    {
      code: "IPC_PAYLOAD_TOO_LARGE",
      message: `IPC input line exceeded ${MAX_IPC_LINE_BYTES} bytes.`
    }
  ));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeSocketFrame(socket: Socket, response: string): Promise<void> {
  const frame = Buffer.from(`${response}\n`, "utf8");
  if (frame.length > MAX_IPC_LINE_BYTES) {
    return Promise.reject(new Error("Named-pipe response exceeded the protocol frame limit."));
  }
  if (socket.destroyed || !socket.writable) {
    return Promise.reject(new Error("Named-pipe client is no longer writable."));
  }
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
