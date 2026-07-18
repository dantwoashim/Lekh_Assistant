import { execFile } from "node:child_process";
import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryKeyboardCorrectionMemoryStore,
  InMemoryKeyboardSettingsStore,
  InMemoryPersonalDictionaryStore,
  createKeyboardEngine,
  defaultTypingContext
} from "../../../src/engine/keyboard";
import { IPC_PROTOCOL_LIMITS, createIpcRequest } from "../../shared/ipc/messages";
import type {
  IpcMessageType,
  IpcPayloadByType,
  TypedIpcRequest
} from "../../shared/ipc/messages";
import { SQLiteKeyboardStorage } from "../../shared/storage/sqliteStores";
import { developmentJsonStorageArgument } from "./daemonCli";
import { KeyboardDaemon } from "./keyboardDaemon";
import {
  createProductionKeyboardDaemon,
  createStorageBackedKeyboardDaemon,
  defaultProductionSQLitePath
} from "./productionDaemon";
import {
  CRASH_FIXTURE_PRIVATE_LEFT,
  CRASH_FIXTURE_PRIVATE_RIGHT
} from "./productionDaemonCrashFixture";

const execFileAsync = promisify(execFile);

class DaemonClient {
  private sequence = 0;

  constructor(readonly id: string, private readonly now: () => number = Date.now) {}

  request<T extends IpcMessageType>(
    type: T,
    payload: IpcPayloadByType[T],
    requestId = `${this.id}-${type}-${this.sequence + 1}`
  ): TypedIpcRequest<T> {
    const now = this.now();
    return createIpcRequest(type, payload, requestId, now, {
      clientInstanceId: this.id,
      requestSequence: ++this.sequence
    });
  }
}

describe("production daemon persistence", () => {
  it("survives a process crash, preloads learned memory, and never stores surrounding windows", async () => {
    const databasePath = await tempDatabasePath();
    await execFileAsync(process.execPath, [
      join(process.cwd(), "node_modules/vite-node/vite-node.mjs"),
      "native/daemon/src/productionDaemonCrashFixture.ts",
      databasePath
    ], {
      cwd: process.cwd(),
      env: { ...process.env, LEKH_DAEMON_CRASH_FIXTURE: "1", NODE_NO_WARNINGS: "1" },
      timeout: 30_000
    });

    const reopenedEngine = createKeyboardEngine();
    const reopened = await createProductionKeyboardDaemon({
      databasePath,
      engine: reopenedEngine,
      expirySweepIntervalMs: 600_000
    });
    const client = new DaemonClient("crash-reopen");
    await negotiate(reopened, client);
    const session = await begin(reopened, client, defaultTypingContext("romanized"));
    const update = reopenedEngine.updateComposition(session.sessionId, "prabin", 6);
    expect(update.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "personal" })])
    );
    await reopened.shutdown();

    const storageFiles = (await readdir(dirname(databasePath)))
      .filter((name) => name.startsWith("lekh-keyboard.sqlite3"));
    for (const fileName of storageFiles) {
      const bytes = await readFile(join(dirname(databasePath), fileName));
      expect(bytes.includes(Buffer.from(CRASH_FIXTURE_PRIVATE_LEFT, "utf8")), fileName).toBe(false);
      expect(bytes.includes(Buffer.from(CRASH_FIXTURE_PRIVATE_RIGHT, "utf8")), fileName).toBe(false);
    }
  }, 30_000);

  it("retries the same prepared learning snapshot after a failed durable write", async () => {
    const engine = createKeyboardEngine();
    const memory = new InMemoryKeyboardCorrectionMemoryStore();
    const record = vi.spyOn(memory, "record").mockRejectedValueOnce(new Error("simulated disk failure"));
    const close = vi.fn();
    const daemon = await createStorageBackedKeyboardDaemon({
      settings: () => new InMemoryKeyboardSettingsStore(),
      correctionMemory: () => memory,
      personalDictionary: () => new InMemoryPersonalDictionaryStore(),
      close
    }, { engine, expirySweepIntervalMs: 600_000 });
    const client = new DaemonClient("retry-client");
    await negotiate(daemon, client);
    const session = await begin(daemon, client, defaultTypingContext("romanized"));
    const committed = commitAlternate(engine, session.sessionId, "prabin");

    const first = await daemon.handle(client.request("memory.learn", {
      ...session,
      commitEpoch: committed.commitEpoch
    }, "learn-failed"));
    expect(first).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "DAEMON_DISPATCH_FAILED" })
    }));

    const probeBefore = await begin(daemon, client, defaultTypingContext("romanized"));
    const before = engine.updateComposition(probeBefore.sessionId, "prabin", 6);
    expect(before.candidates.some((row) => row.type === "personal"))
      .toBe(false);

    const second = await daemon.handle(client.request("memory.learn", {
      ...session,
      commitEpoch: committed.commitEpoch
    }, "learn-retry"));
    expect(second).toEqual(expect.objectContaining({ ok: true, payload: { learned: true } }));
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![0]).toEqual(record.mock.calls[0]![0]);
    expect((await memory.loadRecent(500))).toHaveLength(1);

    const probeAfter = await begin(daemon, client, defaultTypingContext("romanized"));
    const after = engine.updateComposition(probeAfter.sessionId, "prabin", 6);
    expect(after.candidates.some((row) => row.type === "personal"))
      .toBe(true);
    await daemon.shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("publishes and replays a durable learning success that crosses its deadline", async () => {
    let now = 10_000;
    const engine = createKeyboardEngine();
    const memory = new InMemoryKeyboardCorrectionMemoryStore();
    const originalRecord = memory.record.bind(memory);
    let learnDeadline = Number.MAX_SAFE_INTEGER;
    vi.spyOn(memory, "record").mockImplementation(async (entry) => {
      await originalRecord(entry);
      now = learnDeadline + 1;
    });
    const daemon = new KeyboardDaemon({
      engine,
      now: () => now,
      expirySweepIntervalMs: false,
      persistence: {
        memoryEnabled: true,
        correctionMemory: memory,
        personalDictionary: new InMemoryPersonalDictionaryStore(),
        close: () => undefined
      }
    });
    const client = new DaemonClient("late-durable-learning", () => now);
    await negotiate(daemon, client);
    const session = await begin(daemon, client, defaultTypingContext("romanized"));
    const committed = commitAlternate(engine, session.sessionId, "prabin");
    const request = client.request("memory.learn", {
      ...session,
      commitEpoch: committed.commitEpoch
    }, "late-durable-learning-request");
    learnDeadline = request.deadlineAt;

    const response = await daemon.handle(request);
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      payload: { learned: true },
      latencyMs: expect.any(Number)
    }));
    expect(response.latencyMs).toBeGreaterThan(IPC_PROTOCOL_LIMITS.controlDeadlineMs);
    await expect(daemon.handle(request)).resolves.toEqual(response);
    expect(await memory.loadRecent(500)).toHaveLength(1);
    await daemon.shutdown();
  });

  it("honors disabled memory and secure contexts without creating durable records", async () => {
    const databasePath = await tempDatabasePath();
    const seed = new SQLiteKeyboardStorage(databasePath);
    await seed.settings().updateSettings({ memoryEnabled: false });
    seed.close();

    const engine = createKeyboardEngine();
    const daemon = await createProductionKeyboardDaemon({
      databasePath,
      engine,
      expirySweepIntervalMs: 600_000
    });
    const client = new DaemonClient("disabled-memory");
    await negotiate(daemon, client);
    const normal = await begin(daemon, client, defaultTypingContext("romanized"));
    const committed = commitAlternate(engine, normal.sessionId, "prabin", "disabled");
    await expect(daemon.handle(client.request("memory.learn", {
      ...normal,
      commitEpoch: committed.commitEpoch
    }))).resolves.toEqual(expect.objectContaining({ ok: true, payload: { learned: false } }));

    const secure = await begin(daemon, client, {
      ...defaultTypingContext("romanized"),
      fieldType: "password",
      secureInput: true,
      leftTextWindow: "must-not-survive"
    });
    const secureUpdate = await daemon.handle(client.request("session.updateComposition", {
      ...secure,
      input: "secret-composition",
      cursor: 18
    }));
    expect(secureUpdate.payload).toEqual(expect.objectContaining({
      action: "passThrough",
      compositionText: "",
      candidates: []
    }));
    await daemon.shutdown();

    const reopened = new SQLiteKeyboardStorage(databasePath);
    expect(await reopened.correctionMemory().loadRecent(500)).toEqual([]);
    reopened.close();
  });

  it("merges personal SQLite dictionary rows deterministically and suppresses secure lookups", async () => {
    const databasePath = await tempDatabasePath();
    const seed = new SQLiteKeyboardStorage(databasePath);
    await seed.personalDictionary().addWord({
      id: "personal-health",
      word: "स्वास्थ्य",
      romanized: ["swasthya"],
      domains: ["personal"],
      source: "user",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      schemaVersion: 1
    });
    await seed.personalDictionary().addWord({
      id: "personal-health-formal",
      word: "स्वास्थ्यम्",
      romanized: ["swasthya"],
      domains: ["personal"],
      source: "user",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
      schemaVersion: 1
    });
    seed.close();

    const daemon = await createProductionKeyboardDaemon({ databasePath, expirySweepIntervalMs: 600_000 });
    const client = new DaemonClient("dictionary-client");
    await negotiate(daemon, client);
    const first = await daemon.handle(client.request("dictionary.lookup", { query: "swasthya" }, "dict-first"));
    const second = await daemon.handle(client.request("dictionary.lookup", { query: "swasthya" }, "dict-second"));
    expect(second.payload).toEqual(first.payload);
    const rows = first.payload as Array<{ word: string; source?: string }>;
    expect(rows.filter((row) => row.word === "स्वास्थ्य")).toEqual([
      expect.objectContaining({ source: "personal:user" })
    ]);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ word: "स्वास्थ्यम्" })]));
    expect(rows.length).toBeLessThanOrEqual(IPC_PROTOCOL_LIMITS.maximumDictionaryResults);

    const secure = await daemon.handle(client.request("dictionary.lookup", {
      query: "swasthya",
      context: { ...defaultTypingContext("dictionary-lookup"), fieldType: "password", secureInput: true }
    }, "dict-secure"));
    expect(secure).toEqual(expect.objectContaining({ ok: true, payload: [] }));
    await daemon.shutdown();
  });

  it("expires abandoned sessions from an unrefed timer and closes resources once on shutdown", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const engine = createKeyboardEngine();
      const endSession = vi.spyOn(engine, "endSession");
      const close = vi.fn();
      const daemon = new KeyboardDaemon({
        engine,
        now: () => now,
        expirySweepIntervalMs: 10,
        persistence: {
          memoryEnabled: true,
          correctionMemory: new InMemoryKeyboardCorrectionMemoryStore(),
          personalDictionary: new InMemoryPersonalDictionaryStore(),
          close
        }
      });
      const client = new DaemonClient("timer-client", () => now);
      await negotiate(daemon, client);
      const session = await begin(daemon, client, {
        ...defaultTypingContext("romanized"),
        leftTextWindow: "abandoned private window"
      });
      const abandonedInput = "abandoned-raw-composition";
      await daemon.handle(client.request("session.updateComposition", {
        ...session,
        input: abandonedInput,
        cursor: abandonedInput.length
      }));
      expect(daemon.metrics().activeSessions).toBe(1);

      now += IPC_PROTOCOL_LIMITS.clientIdleTtlMs;
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(daemon.metrics().activeSessions).toBe(0);
      expect(endSession).toHaveBeenCalledWith(session.sessionId);

      await Promise.all([daemon.shutdown(), daemon.shutdown()]);
      expect(close).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes an accepted engine-shutdown request a terminal queue barrier and finalizes once", async () => {
    const engine = createKeyboardEngine();
    const shutdownEngine = vi.spyOn(engine, "shutdown");
    const close = vi.fn();
    const daemon = new KeyboardDaemon({
      engine,
      expirySweepIntervalMs: false,
      persistence: {
        memoryEnabled: true,
        correctionMemory: new InMemoryKeyboardCorrectionMemoryStore(),
        personalDictionary: new InMemoryPersonalDictionaryStore(),
        close
      }
    });
    const client = new DaemonClient("terminal-shutdown");
    await negotiate(daemon, client);

    const terminal = daemon.handle(client.request("engine.shutdown", null, "terminal-shutdown-request"));
    const queuedAfter = daemon.handle(client.request(
      "health.check",
      { client: "daemon-test" },
      "must-not-touch-finalized-state"
    ));

    await expect(terminal).resolves.toEqual(expect.objectContaining({
      ok: true,
      payload: { shutdown: true }
    }));
    await expect(queuedAfter).resolves.toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "DAEMON_STOPPING", action: "restartDaemon" })
    }));
    await expect(daemon.shutdown()).resolves.toBeUndefined();
    expect(shutdownEngine).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("publishes completed shutdown when irreversible finalization crosses its deadline", async () => {
    let now = 20_000;
    let shutdownDeadline = Number.MAX_SAFE_INTEGER;
    const daemon = new KeyboardDaemon({
      now: () => now,
      expirySweepIntervalMs: false,
      persistence: {
        memoryEnabled: true,
        correctionMemory: new InMemoryKeyboardCorrectionMemoryStore(),
        personalDictionary: new InMemoryPersonalDictionaryStore(),
        close: () => {
          now = shutdownDeadline + 1;
        }
      }
    });
    const client = new DaemonClient("late-terminal-shutdown", () => now);
    await negotiate(daemon, client);
    const request = client.request("engine.shutdown", null, "late-terminal-shutdown-request");
    shutdownDeadline = request.deadlineAt;

    const response = await daemon.handle(request);
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      payload: { shutdown: true },
      latencyMs: expect.any(Number)
    }));
    expect(response.latencyMs).toBeGreaterThan(IPC_PROTOCOL_LIMITS.controlDeadlineMs);
  });

  it("closes persistent storage once even when engine shutdown fails", async () => {
    const engine = createKeyboardEngine();
    const failure = new Error("simulated engine shutdown failure");
    const shutdownEngine = vi.spyOn(engine, "shutdown").mockRejectedValue(failure);
    const close = vi.fn();
    const daemon = new KeyboardDaemon({
      engine,
      expirySweepIntervalMs: false,
      persistence: {
        memoryEnabled: true,
        correctionMemory: new InMemoryKeyboardCorrectionMemoryStore(),
        personalDictionary: new InMemoryPersonalDictionaryStore(),
        close
      }
    });

    const first = daemon.shutdown();
    const second = daemon.shutdown();
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(shutdownEngine).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("releases the engine and storage when startup cannot hand off a daemon", async () => {
    const engine = createKeyboardEngine();
    const shutdownEngine = vi.spyOn(engine, "shutdown");
    const close = vi.fn();
    await expect(createStorageBackedKeyboardDaemon({
      settings: () => new InMemoryKeyboardSettingsStore(),
      correctionMemory: () => new InMemoryKeyboardCorrectionMemoryStore(),
      personalDictionary: () => new InMemoryPersonalDictionaryStore(),
      close
    }, {
      engine,
      expirySweepIntervalMs: 0
    })).rejects.toThrow(/positive safe integer/);
    expect(shutdownEngine).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("resolves per-user production paths without touching disk and keeps JSON opt-in explicit", () => {
    expect(defaultProductionSQLitePath({
      platform: "win32",
      environment: { APPDATA: "C:\\Users\\Niraj\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\Niraj"
    })).toBe("C:\\Users\\Niraj\\AppData\\Roaming\\Lekh Keyboard\\lekh-keyboard.sqlite3");
    expect(defaultProductionSQLitePath({
      platform: "win32",
      environment: {},
      homeDirectory: "C:\\Users\\Niraj"
    })).toBe("C:\\Users\\Niraj\\AppData\\Roaming\\Lekh Keyboard\\lekh-keyboard.sqlite3");
    expect(defaultProductionSQLitePath({
      platform: "win32",
      environment: { APPDATA: "relative\\roaming" },
      homeDirectory: "C:\\Users\\Niraj"
    })).toBe("C:\\Users\\Niraj\\AppData\\Roaming\\Lekh Keyboard\\lekh-keyboard.sqlite3");
    expect(defaultProductionSQLitePath({
      platform: "darwin",
      environment: {},
      homeDirectory: "/Users/niraj"
    })).toBe("/Users/niraj/Library/Application Support/Lekh Keyboard/lekh-keyboard.sqlite3");
    expect(developmentJsonStorageArgument([
      `--development-json-storage=${join(tmpdir(), "lekh-development.json")}`
    ])).toBe(join(tmpdir(), "lekh-development.json"));
    expect(() => developmentJsonStorageArgument(["--development-json-storage=relative.json"]))
      .toThrow(/absolute .json path/);
    expect(() => developmentJsonStorageArgument([
      `--development-json-storage=${join(tmpdir(), "wrong-extension.sqlite3")}`
    ])).toThrow(/absolute .json path/);
    expect(() => developmentJsonStorageArgument([
      `--development-json-storage=${join(tmpdir(), "nul\0path.json")}`
    ])).toThrow(/absolute .json path/);
    expect(() => developmentJsonStorageArgument([
      `--development-json-storage=${join(tmpdir(), "first.json")}`,
      `--development-json-storage=${join(tmpdir(), "second.json")}`
    ])).toThrow(/only once/);
  });

  it("rejects unsafe production database paths before opening storage", async () => {
    await expect(createProductionKeyboardDaemon({ databasePath: "relative.sqlite3" }))
      .rejects.toThrow(/absolute .sqlite3 path/);
    await expect(createProductionKeyboardDaemon({ databasePath: join(tmpdir(), "wrong-extension.db") }))
      .rejects.toThrow(/absolute .sqlite3 path/);
    await expect(createProductionKeyboardDaemon({ databasePath: join(tmpdir(), "nul\0path.sqlite3") }))
      .rejects.toThrow(/absolute .sqlite3 path/);
  });

  it("binds both executable transports to production storage while unit handlers stay injectable", async () => {
    const [cli, namedPipe, lineProtocol] = await Promise.all([
      readFile(join(process.cwd(), "native/daemon/src/daemonCli.ts"), "utf8"),
      readFile(join(process.cwd(), "native/daemon/src/namedPipeServer.ts"), "utf8"),
      readFile(join(process.cwd(), "native/daemon/src/lineProtocol.ts"), "utf8")
    ]);
    expect(cli).toContain(": await createProductionDaemonLineHandler()");
    expect(namedPipe).toContain("const handler = await createProductionDaemonLineHandler()");
    expect(lineProtocol).toContain("createDaemonLineHandler(daemon = new KeyboardDaemon())");
    expect(namedPipe).not.toContain("const handler = createDaemonLineHandler()");
  });
});

async function negotiate(daemon: KeyboardDaemon, client: DaemonClient): Promise<void> {
  const response = await daemon.handle(client.request("protocol.negotiate", {
    client: "daemon-test",
    supportedVersions: [2]
  }));
  expect(response).toEqual(expect.objectContaining({ ok: true }));
  const warm = await daemon.handle(client.request("engine.warm", { timeoutMs: 250 }));
  expect(warm).toEqual(expect.objectContaining({ ok: true }));
}

async function begin(
  daemon: KeyboardDaemon,
  client: DaemonClient,
  context: ReturnType<typeof defaultTypingContext>
): Promise<{ sessionId: string; sessionEpoch: number }> {
  const response = await daemon.handle(client.request("session.begin", { context }));
  expect(response).toEqual(expect.objectContaining({ ok: true }));
  return response.payload as { sessionId: string; sessionEpoch: number };
}

function commitAlternate(
  engine: ReturnType<typeof createKeyboardEngine>,
  sessionId: string,
  input: string,
  learning: "deferred" | "disabled" = "deferred"
): { commitEpoch: number; selectedText: string } {
  const payload = engine.updateComposition(sessionId, input, input.length);
  const alternate = payload.candidates.find((candidate) => candidate.text !== payload.primary?.text);
  expect(alternate).toBeTruthy();
  const commit = engine.commitCandidate(sessionId, alternate!.id, { learning });
  expect(commit).toEqual(expect.objectContaining({ action: "commit", commitEpoch: expect.any(Number) }));
  return {
    commitEpoch: commit.commitEpoch,
    selectedText: alternate!.text
  };
}

async function tempDatabasePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "lekh-daemon-persistence-")), "lekh-keyboard.sqlite3");
}
