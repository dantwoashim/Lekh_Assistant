import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createIpcErrorResponse } from "../../shared/ipc/messages";
import type { IpcResponse } from "../../shared/ipc/messages";
import { createDaemonLineHandler } from "./lineProtocol";
import { startWindowsNamedPipeDaemon } from "./namedPipeServer";
import {
  createDevelopmentJsonKeyboardDaemon,
  createProductionDaemonLineHandler,
  isDevelopmentJsonPath
} from "./productionDaemon";

async function runDaemonCli(): Promise<void> {
  if (process.argv.includes("--named-pipe")) {
    const daemon = await startWindowsNamedPipeDaemon();
    process.stderr.write(`Lekh Keyboard daemon listening on ${daemon.pipeName}\n`);
    const shutdownPipe = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdownPipe);
    process.once("SIGTERM", shutdownPipe);
    return;
  }

  const developmentJsonPath = developmentJsonStorageArgument(process.argv.slice(2));
  const handler = developmentJsonPath
    ? createDaemonLineHandler(await createDevelopmentJsonKeyboardDaemon(developmentJsonPath))
    : await createProductionDaemonLineHandler();
  const io = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await handler.shutdown();
    io.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  for await (const line of io) {
    try {
      process.stdout.write(`${await handler.handleLine(line)}\n`);
    } catch {
      const response: IpcResponse = createIpcErrorResponse({
        id: "daemon_cli_failed",
        type: "health.check"
      }, {
        code: "DAEMON_CLI_FAILED",
        message: "The daemon line could not be processed.",
        recoverable: true
      });
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }

  await handler.shutdown();
}

export function developmentJsonStorageArgument(args: readonly string[]): string | undefined {
  const prefix = "--development-json-storage=";
  const values = args.filter((argument) => argument.startsWith(prefix));
  if (values.length === 0) return undefined;
  if (values.length !== 1) throw new Error("Development JSON storage may be specified only once.");
  const value = values[0]!.slice(prefix.length);
  if (!isDevelopmentJsonPath(value)) {
    throw new Error("Development JSON storage requires an explicit absolute .json path.");
  }
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDaemonCli().catch(() => {
    process.stderr.write("Lekh daemon failed during startup or shutdown.\n");
    process.exit(1);
  });
}
