import { describe, expect, it, vi } from "vitest";
import {
  MAXIMUM_ACTIVE_PIPE_CONNECTIONS,
  SOCKET_IDLE_TIMEOUT_MS,
  createNamedPipeFrameDecoder,
  createOrderedResponseQueue,
  listenNamedPipeServer,
  namedPipeErrorResponse
} from "./namedPipeServer";

describe("Windows named-pipe response ordering", () => {
  it("closes production storage when the named-pipe listener cannot bind", async () => {
    const listenFailure = new Error("pipe already exists");
    let errorListener: ((error: Error) => void) | undefined;
    const cleanup = vi.fn(async () => undefined);
    const server = {
      once: vi.fn((_event: "error", listener: (error: Error) => void) => {
        errorListener = listener;
      }),
      off: vi.fn(),
      listen: vi.fn(() => {
        queueMicrotask(() => errorListener?.(listenFailure));
      })
    };

    await expect(listenNamedPipeServer(server, "\\\\.\\pipe\\lekh-test", cleanup))
      .rejects.toBe(listenFailure);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps requests and responses in exact arrival order despite uneven work", async () => {
    const written: string[] = [];
    const delays = new Map([
      ["first", 20],
      ["second", 1],
      ["third", 0]
    ]);
    const queue = createOrderedResponseQueue(
      async (line) => {
        await new Promise((resolve) => setTimeout(resolve, delays.get(line) ?? 0));
        return `response:${line}`;
      },
      (response) => {
        written.push(response);
      },
      (error) => `error:${String(error)}`
    );

    expect(queue.enqueue("first")).toBe(true);
    expect(queue.enqueue("second")).toBe(true);
    expect(queue.enqueue("third")).toBe(true);
    await queue.drain();
    expect(written).toEqual(["response:first", "response:second", "response:third"]);
  });

  it("writes an ordered recoverable error and continues with the next request", async () => {
    const written: string[] = [];
    const queue = createOrderedResponseQueue(
      async (line) => {
        if (line === "bad") throw new Error("invalid frame");
        return `response:${line}`;
      },
      (response) => {
        written.push(response);
      },
      (error) => `error:${error instanceof Error ? error.message : String(error)}`
    );

    expect(queue.enqueue("bad")).toBe(true);
    expect(queue.enqueue("good")).toBe(true);
    await queue.drain();
    expect(written).toEqual(["error:invalid frame", "response:good"]);
  });

  it("does not disconnect a live keyboard client during an ordinary thinking pause", () => {
    expect(SOCKET_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it("rejects overflow without extending the ordered work chain", async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createOrderedResponseQueue(
      async (line) => {
        await blocker;
        return line;
      },
      () => undefined,
      () => "error",
      2
    );

    expect(queue.enqueue("first")).toBe(true);
    expect(queue.enqueue("second")).toBe(true);
    expect(queue.pending()).toBe(2);
    expect(queue.enqueue("overflow")).toBe(false);
    expect(queue.pending()).toBe(2);
    release?.();
    await queue.drain();
    expect(queue.pending()).toBe(0);
  });

  it("cancels queued state mutations when the connection disappears", async () => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const handled: string[] = [];
    const written: string[] = [];
    const queue = createOrderedResponseQueue(
      async (line) => {
        handled.push(line);
        markStarted?.();
        await blocker;
        return `response:${line}`;
      },
      (response) => { written.push(response); },
      () => "error"
    );

    expect(queue.enqueue("active")).toBe(true);
    expect(queue.enqueue("must-not-run")).toBe(true);
    await started;
    queue.cancel();
    release?.();
    await queue.drain();
    expect(handled).toEqual(["active"]);
    expect(written).toEqual([]);
  });

  it("drops queued work and writes one ordered terminal failure", async () => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const handled: string[] = [];
    const written: string[] = [];
    const queue = createOrderedResponseQueue(
      async (line) => {
        handled.push(line);
        markStarted?.();
        await blocker;
        return `response:${line}`;
      },
      (response) => { written.push(response); },
      () => "error"
    );

    expect(queue.enqueue("active")).toBe(true);
    expect(queue.enqueue("must-not-run")).toBe(true);
    await started;
    const terminated = queue.terminate("terminal");
    release?.();
    await terminated;
    expect(handled).toEqual(["active"]);
    expect(written).toEqual(["terminal"]);
  });

  it("frames fragmented UTF-8 strictly and includes the newline in the byte ceiling", () => {
    const decoder = createNamedPipeFrameDecoder(16);
    const encoded = Buffer.from("ने\r\nnext\n", "utf8");
    expect(decoder.push(encoded.subarray(0, 2))).toEqual({ lines: [] });
    expect(decoder.push(encoded.subarray(2))).toEqual({ lines: ["ने", "next"] });

    expect(createNamedPipeFrameDecoder(8).push(Buffer.from("1234567\n"))).toEqual({ lines: ["1234567"] });
    expect(createNamedPipeFrameDecoder(8).push(Buffer.from("12345678\n"))).toEqual({
      lines: [],
      failure: "payload-too-large"
    });
    expect(createNamedPipeFrameDecoder().push(Buffer.from([0xc3, 0x28, 0x0a]))).toEqual({
      lines: [],
      failure: "invalid-utf8"
    });
  });

  it("bounds active connections and never returns internal exception text", () => {
    expect(MAXIMUM_ACTIVE_PIPE_CONNECTIONS).toBe(16);
    const response = namedPipeErrorResponse();
    expect(response).not.toContain("sensitive-internal-detail");
    expect(JSON.parse(response).error).toEqual(expect.objectContaining({
      code: "NAMED_PIPE_REQUEST_FAILED",
      message: "The named-pipe request could not be completed."
    }));
  });
});
