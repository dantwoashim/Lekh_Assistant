import { spawnSync } from "node:child_process";

const FALLBACK_PIPE_NAME = "\\\\.\\pipe\\LekhKeyboard";
const PIPE_PREFIX = "\\\\.\\pipe\\LekhKeyboard-";

export function defaultWindowsPipeName(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LEKH_KEYBOARD_PIPE_NAME) return env.LEKH_KEYBOARD_PIPE_NAME;
  const sid = process.platform === "win32" ? currentUserSid() : undefined;
  return sid ? windowsPipeNameForSid(sid) : FALLBACK_PIPE_NAME;
}

export function windowsPipeNameForSid(sid: string): string {
  return `${PIPE_PREFIX}${sanitizePipeSegment(sid)}`;
}

export function parseWhoamiUserSid(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const fields = parseCsvLine(line);
    const sid = fields.find((field) => /^S-\d-\d+-(?:\d+-?)+$/.test(field));
    if (sid) return sid;
  }
  return undefined;
}

function currentUserSid(): string | undefined {
  const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return undefined;
  return parseWhoamiUserSid(result.stdout);
}

function sanitizePipeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9.-]/g, "_").slice(0, 180);
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
