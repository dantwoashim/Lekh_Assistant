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

    await Promise.all([queue.enqueue("first"), queue.enqueue("second"), queue.enqueue("third")]);
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

    await Promise.all([queue.enqueue("bad"), queue.enqueue("good")]);
    expect(written).toEqual(["error:invalid frame", "response:good"]);
  });

  it("does not disconnect a live keyboard client during an ordinary thinking pause", () => {
    expect(SOCKET_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });
});
