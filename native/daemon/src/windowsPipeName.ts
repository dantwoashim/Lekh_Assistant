import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const PIPE_PREFIX = "\\\\.\\pipe\\LekhKeyboard-";
const WINDOWS_SID_PATTERN = /^S-[1-9]\d*-(?:\d+-)*\d+$/u;
const MAXIMUM_SID_STRING_LENGTH = 184;
const WHOAMI_TIMEOUT_MS = 2_000;
const WHOAMI_MAX_BUFFER_BYTES = 16 * 1024;

export interface WindowsPipeNameOptions {
  platform?: NodeJS.Platform;
  resolveUserSid?: () => string | undefined;
}

export function defaultWindowsPipeName(options: WindowsPipeNameOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("The default Lekh named pipe can only be resolved on Windows.");
  }
  const sid = (options.resolveUserSid ?? currentUserSid)();
  if (!sid) {
    throw new Error("Lekh refused to start without a verified current-user Windows SID.");
  }
  return windowsPipeNameForSid(sid);
}

export function windowsPipeNameForSid(sid: string): string {
  if (!isWindowsSid(sid)) {
    throw new Error("Invalid current-user Windows SID for the Lekh named pipe.");
  }
  return `${PIPE_PREFIX}${sid}`;
}

export function parseWhoamiUserSid(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const fields = parseCsvLine(line);
    const sid = fields.find(isWindowsSid);
    if (sid) return sid;
  }
  return undefined;
}

function isWindowsSid(value: string): boolean {
  return value.length <= MAXIMUM_SID_STRING_LENGTH && WINDOWS_SID_PATTERN.test(value);
}

function currentUserSid(): string | undefined {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || systemRoot.includes("\0") || !win32.isAbsolute(systemRoot)) return undefined;
  const executable = win32.join(win32.normalize(systemRoot), "System32", "whoami.exe");
  const result = spawnSync(executable, ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    maxBuffer: WHOAMI_MAX_BUFFER_BYTES,
    shell: false,
    stdio: "pipe",
    timeout: WHOAMI_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.status !== 0) return undefined;
  return parseWhoamiUserSid(result.stdout);
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}
