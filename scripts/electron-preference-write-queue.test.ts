import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  BoundedSerialTaskQueue,
  validatePreferencePatch
} = require("../electron/preference-write-queue.cjs") as {
  BoundedSerialTaskQueue: new (options?: { maximumPending?: number }) => {
    accepting: boolean;
    pendingCount: number;
    enqueue<T>(task: () => Promise<T> | T): Promise<T>;
    close(): void;
    drain(timeoutMs: number): Promise<{ drained: boolean; pending: number }>;
  };
  validatePreferencePatch(
    patch: unknown,
    options: {
      booleanKeys: Set<string>;
      nativeModes: Set<string>;
      maximumExcludedApplications?: number;
    }
  ): Record<string, unknown>;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("bounded main-process preference write queue", () => {
  afterEach(() => vi.useRealTimers());

  it("executes accepted writes strictly in arrival order", async () => {
    const queue = new BoundedSerialTaskQueue();
    const firstGate = deferred<void>();
    const events: string[] = [];
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const second = queue.enqueue(() => {
      events.push("second");
    });

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("isolates a failed write and continues with the next accepted write", async () => {
    const queue = new BoundedSerialTaskQueue();
    const events: string[] = [];
    const failed = queue.enqueue(() => {
      events.push("failed");
      throw new Error("native write failed");
    });
    const recovered = queue.enqueue(() => {
      events.push("recovered");
      return "saved";
    });

    await expect(failed).rejects.toThrow("native write failed");
    await expect(recovered).resolves.toBe("saved");
    expect(events).toEqual(["failed", "recovered"]);
  });

  it("rejects excess work before accepting more than the configured bound", async () => {
    const queue = new BoundedSerialTaskQueue({ maximumPending: 2 });
    const gate = deferred<void>();
    const first = queue.enqueue(() => gate.promise);
    const second = queue.enqueue(() => undefined);

    expect(queue.pendingCount).toBe(2);
    expect(() => queue.enqueue(() => undefined)).toThrowError(
      expect.objectContaining({ code: "ERR_LEKH_PREFERENCE_QUEUE_FULL" })
    );
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("closes admission and drains all already accepted writes", async () => {
    const queue = new BoundedSerialTaskQueue();
    const gate = deferred<void>();
    const accepted = queue.enqueue(() => gate.promise);
    queue.close();

    expect(queue.accepting).toBe(false);
    expect(() => queue.enqueue(() => undefined)).toThrowError(
      expect.objectContaining({ code: "ERR_LEKH_PREFERENCE_QUEUE_CLOSED" })
    );
    const draining = queue.drain(1_000);
    gate.resolve();
    await accepted;
    await expect(draining).resolves.toEqual({ drained: true, pending: 0 });
  });

  it("uses a finite drain timeout without cancelling accepted work", async () => {
    vi.useFakeTimers();
    const queue = new BoundedSerialTaskQueue();
    const gate = deferred<void>();
    const accepted = queue.enqueue(() => gate.promise);
    await vi.advanceTimersByTimeAsync(0);

    const draining = queue.drain(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(draining).resolves.toEqual({ drained: false, pending: 1 });

    gate.resolve();
    await accepted;
    await expect(queue.drain(25)).resolves.toEqual({ drained: true, pending: 0 });
  });
});

describe("main-process preference validation", () => {
  const options = {
    booleanKeys: new Set(["inlinePreviewEnabled", "personalizationEnabled"]),
    nativeModes: new Set(["romanized-traditional", "traditional-traditional"]),
    maximumExcludedApplications: 2
  };

  it("validates and clones a complete patch before it enters the queue", () => {
    const identifiers = ["com.example.Editor"];
    const validated = validatePreferencePatch({
      inlinePreviewEnabled: false,
      nativeTypingMode: "traditional-traditional",
      excludedApplicationBundleIdentifiers: identifiers
    }, options);
    identifiers.push("org.example.Writer");

    expect(validated).toEqual({
      inlinePreviewEnabled: false,
      nativeTypingMode: "traditional-traditional",
      excludedApplicationBundleIdentifiers: ["com.example.Editor"]
    });
  });

  it("rejects unknown, malformed, duplicate, and oversized values atomically", () => {
    expect(() => validatePreferencePatch({ unknown: true }, options)).toThrow();
    expect(() => validatePreferencePatch({ inlinePreviewEnabled: "yes" }, options)).toThrow();
    expect(() => validatePreferencePatch({ nativeTypingMode: "unknown" }, options)).toThrow();
    expect(() => validatePreferencePatch({
      excludedApplicationBundleIdentifiers: ["com.example.Editor", "com.example.Editor"]
    }, options)).toThrow();
    expect(() => validatePreferencePatch({
      excludedApplicationBundleIdentifiers: [
        "com.example.One",
        "com.example.Two",
        "com.example.Three"
      ]
    }, options)).toThrow();
    expect(() => validatePreferencePatch({
      inlinePreviewEnabled: false,
      unknown: true
    }, options)).toThrow();
  });
});
