import { createKeyboardEngine, defaultTypingContext } from "../../../src/engine/keyboard";
import { createIpcRequest } from "../../shared/ipc/messages";
import type { IpcMessageType, IpcPayloadByType } from "../../shared/ipc/messages";
import { createProductionKeyboardDaemon } from "./productionDaemon";

export const CRASH_FIXTURE_PRIVATE_LEFT = "CRASH_PRIVATE_LEFT_WINDOW_DO_NOT_PERSIST";
export const CRASH_FIXTURE_PRIVATE_RIGHT = "CRASH_PRIVATE_RIGHT_WINDOW_DO_NOT_PERSIST";

async function run(databasePath: string): Promise<never> {
  const engine = createKeyboardEngine();
  const daemon = await createProductionKeyboardDaemon({
    databasePath,
    engine,
    expirySweepIntervalMs: 600_000
  });
  let sequence = 0;
  const request = <T extends IpcMessageType>(type: T, payload: IpcPayloadByType[T], id: string) => {
    const now = Date.now();
    return createIpcRequest(type, payload, id, now, {
      clientInstanceId: "crash-child",
      requestSequence: ++sequence
    });
  };
  await daemon.handle(request("protocol.negotiate", {
    client: "daemon-test",
    supportedVersions: [2]
  }, "negotiate"));
  await daemon.handle(request("engine.warm", { timeoutMs: 250 }, "warm"));
  const begin = await daemon.handle(request("session.begin", { context: {
    ...defaultTypingContext("romanized"),
    leftTextWindow: CRASH_FIXTURE_PRIVATE_LEFT,
    rightTextWindow: CRASH_FIXTURE_PRIVATE_RIGHT
  } }, "begin"));
  const session = begin.payload as { sessionId: string; sessionEpoch: number };
  // Persistence crash recovery is independent of the separate 50 ms IPC
  // composition budget. Prepare the candidate state directly so loaded CI
  // scheduling cannot turn this durability fixture into a hot-path benchmark.
  const payload = engine.updateComposition(session.sessionId, "prabin", 6);
  const alternate = payload.candidates.find((candidate) => candidate.text !== payload.primary?.text);
  if (!alternate) throw new Error("No alternate candidate was available for crash persistence test.");
  const commit = engine.commitCandidate(session.sessionId, alternate.id, { learning: "deferred" });
  const learned = await daemon.handle(request("memory.learn", {
    ...session,
    commitEpoch: commit.commitEpoch
  }, "learn"));
  if (!learned.ok || !(learned.payload as { learned: boolean }).learned) {
    throw new Error("Durable learning was not acknowledged.");
  }

  // Deliberately bypass daemon shutdown to prove that the preceding SQLite
  // acknowledgement is sufficient for recovery by a new process.
  process.exit(0);
}

if (process.env.LEKH_DAEMON_CRASH_FIXTURE === "1") {
  const databasePath = process.argv.at(-1);
  if (!databasePath) throw new Error("Crash fixture requires an explicit SQLite path.");
  void run(databasePath);
}
