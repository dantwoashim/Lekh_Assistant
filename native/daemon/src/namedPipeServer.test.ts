import { describe, expect, it } from "vitest";
import { SOCKET_IDLE_TIMEOUT_MS, createOrderedResponseQueue } from "./namedPipeServer";

describe("Windows named-pipe response ordering", () => {
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
});
