"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { createConnection } = require("node:net");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { promisify } = require("node:util");

const execFileAsyncDefault = promisify(execFile);

const WINDOWS_TSF_CLSID = "{3F04E1EA-7D90-47E1-865B-11D6F13D0301}";
const WINDOWS_TSF_PROFILE_GUID = "{8076E28F-3B91-430B-9834-D85F08FE9A6D}";
const WINDOWS_PREFERENCE_KEY = "HKCU\\Software\\Lekh\\Keyboard";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "LekhKeyboardCompanion";
const WINDOWS_COM_KEY = `HKLM\\Software\\Classes\\CLSID\\${WINDOWS_TSF_CLSID}\\InprocServer32`;
const WINDOWS_TIP_KEY = `HKLM\\Software\\Microsoft\\CTF\\TIP\\${WINDOWS_TSF_CLSID}`;
const WINDOWS_PIPE_PREFIX = "LekhKeyboard-";
const WINDOWS_IPC_VERSION = 2;
const MAXIMUM_PIPE_FRAME_BYTES = 64 * 1024;

const WINDOWS_PREFERENCE_DEFINITIONS = new Map([
  ["inlinePreviewEnabled", ["LekhInlinePreviewEnabled", true]],
  ["customCandidatePanelEnabled", ["LekhCustomCandidatePanelEnabled", false]],
  ["proofreadAsYouTypeEnabled", ["LekhProofreadAsYouTypeEnabled", true]],
  ["smartPunctuationEnabled", ["LekhSmartPunctuationEnabled", true]],
  ["personalizationEnabled", ["LekhPersonalizationEnabled", false]],
  ["nextWordPredictionEnabled", ["LekhNextWordPredictionEnabled", true]]
]);
const WINDOWS_MODE_VALUE = "LekhNativeTypingMode";
const WINDOWS_EXCLUDED_APPLICATIONS_VALUE = "LekhExcludedApplicationBundleIdentifiers";
const WINDOWS_NATIVE_MODES = new Set([
  "romanized-romanized",
  "romanized-traditional"
]);

let cachedWindowsSid = null;
const windowsBrokerProbeClientInstanceId = `companion-${process.pid}-${randomUUID()}`;
let windowsBrokerProbeRequestSequence = 0;

function defaultWindowsPreferences() {
  return {
    nativeTypingMode: "romanized-traditional",
    inlinePreviewEnabled: true,
    customCandidatePanelEnabled: false,
    proofreadAsYouTypeEnabled: true,
    smartPunctuationEnabled: true,
    personalizationEnabled: false,
    nextWordPredictionEnabled: true,
    excludedApplicationBundleIdentifiers: []
  };
}

async function readWindowsPreferences({ execFileAsync = execFileAsyncDefault } = {}) {
  const defaults = defaultWindowsPreferences();
  const preferences = { ...defaults };
  const booleanEntries = await Promise.all(
    Array.from(WINDOWS_PREFERENCE_DEFINITIONS.entries()).map(async ([publicKey, [registryName, fallback]]) => {
      const value = await queryRegistryValue(WINDOWS_PREFERENCE_KEY, registryName, { execFileAsync });
      return [publicKey, parseRegistryBoolean(value, fallback)];
    })
  );
  for (const [key, value] of booleanEntries) preferences[key] = value;

  const mode = await queryRegistryValue(WINDOWS_PREFERENCE_KEY, WINDOWS_MODE_VALUE, { execFileAsync });
  preferences.nativeTypingMode = WINDOWS_NATIVE_MODES.has(mode)
    ? mode
    : defaults.nativeTypingMode;

  const excluded = await queryRegistryValue(
    WINDOWS_PREFERENCE_KEY,
    WINDOWS_EXCLUDED_APPLICATIONS_VALUE,
    { execFileAsync }
  );
  preferences.excludedApplicationBundleIdentifiers = parseRegistryMultiString(excluded)
    .filter(isSupportedApplicationIdentifier)
    .slice(0, 100);
  return preferences;
}

async function writeWindowsPreferencePatch(patch, { execFileAsync = execFileAsyncDefault } = {}) {
  for (const [publicKey, value] of Object.entries(patch)) {
    if (publicKey === "nativeTypingMode") {
      if (!WINDOWS_NATIVE_MODES.has(value)) {
        throw new TypeError("This Windows build supports only verified Romanized input modes.");
      }
      await addRegistryValue(WINDOWS_MODE_VALUE, "REG_SZ", value, { execFileAsync });
      continue;
    }
    if (publicKey === "excludedApplicationBundleIdentifiers") {
      if (value.length === 0) {
        await deleteRegistryValue(WINDOWS_EXCLUDED_APPLICATIONS_VALUE, { execFileAsync });
      } else {
        await addRegistryValue(
          WINDOWS_EXCLUDED_APPLICATIONS_VALUE,
          "REG_MULTI_SZ",
          value.join("\\0"),
          { execFileAsync }
        );
      }
      continue;
    }
    const definition = WINDOWS_PREFERENCE_DEFINITIONS.get(publicKey);
    if (!definition) throw new TypeError(`Unsupported Windows preference: ${publicKey}`);
    await addRegistryValue(definition[0], "REG_DWORD", value ? "1" : "0", { execFileAsync });
  }
  return { ok: true };
}

async function inspectWindowsRegistration(expectedDllPath, {
  execFileAsync = execFileAsyncDefault,
  compatibilityDllPath = null
} = {}) {
  const [registeredDllPath, compatibilityRegisteredDllPath, tipRegistered] = await Promise.all([
    queryRegistryValue(WINDOWS_COM_KEY, null, { execFileAsync, registryView: 64 }),
    compatibilityDllPath
      ? queryRegistryValue(WINDOWS_COM_KEY, null, { execFileAsync, registryView: 32 })
      : Promise.resolve(null),
    registryKeyExists(WINDOWS_TIP_KEY, { execFileAsync })
  ]);
  const comRegistered = Boolean(registeredDllPath);
  const primaryPathMatches = Boolean(
    expectedDllPath
    && registeredDllPath
    && equivalentWindowsPaths(expectedDllPath, registeredDllPath)
  );
  const compatibilityRegistered = !compatibilityDllPath || Boolean(compatibilityRegisteredDllPath);
  const compatibilityPathMatches = !compatibilityDllPath || Boolean(
    compatibilityRegisteredDllPath
    && equivalentWindowsPaths(compatibilityDllPath, compatibilityRegisteredDllPath)
  );
  const pathMatches = primaryPathMatches && compatibilityPathMatches;
  const issues = [];
  if (!comRegistered) issues.push("missing-com-registration");
  if (compatibilityDllPath && !compatibilityRegistered) issues.push("missing-x86-com-registration");
  if (!tipRegistered) issues.push("missing-language-profile");
  if (comRegistered && expectedDllPath && !primaryPathMatches) issues.push("registration-path-mismatch");
  if (compatibilityDllPath && compatibilityRegistered && !compatibilityPathMatches) {
    issues.push("x86-registration-path-mismatch");
  }
  return {
    registered: comRegistered && compatibilityRegistered && tipRegistered,
    pathMatches,
    valid: comRegistered && compatibilityRegistered && tipRegistered && pathMatches,
    compatibilityRegistered,
    compatibilityPathMatches,
    issues
  };
}

async function probeWindowsBroker({
  execFileAsync = execFileAsyncDefault,
  connect = createConnection,
  sid,
  timeoutMs = 1200
} = {}) {
  const startedAt = performance.now();
  const currentSid = sid ?? await currentWindowsSid({ execFileAsync });
  if (!currentSid) {
    return { healthy: false, latencyMs: elapsed(startedAt), reason: "sid-unavailable" };
  }
  const pipePath = `\\\\.\\pipe\\${WINDOWS_PIPE_PREFIX}${currentSid}`;
  const now = Date.now();
  const requestSequence = ++windowsBrokerProbeRequestSequence;
  const requestId = `companion-health-${process.pid}-${requestSequence}-${now}`;
  const request = JSON.stringify({
    id: requestId,
    type: "protocol.negotiate",
    version: WINDOWS_IPC_VERSION,
    sentAt: now,
    deadlineAt: now + 5000,
    clientInstanceId: windowsBrokerProbeClientInstanceId,
    requestSequence,
    payload: {
      client: "companion",
      supportedVersions: [WINDOWS_IPC_VERSION]
    }
  });

  return new Promise((resolve) => {
    let socket;
    let buffer = "";
    let settled = false;
    const finish = (healthy, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      resolve({ healthy, latencyMs: elapsed(startedAt), reason: healthy ? null : reason });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    timer.unref?.();
    try {
      socket = connect(pipePath);
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(`${request}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_PIPE_FRAME_BYTES) {
          finish(false, "oversized-response");
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline).replace(/\r$/, ""));
          const healthy = response?.id === requestId
            && response?.type === "protocol.negotiate"
            && response?.version === WINDOWS_IPC_VERSION
            && response?.ok === true
            && response?.payload?.selectedVersion === WINDOWS_IPC_VERSION
            && typeof response?.serverInstanceId === "string"
            && response.serverInstanceId.length > 0;
          finish(healthy, healthy ? null : "invalid-response");
        } catch {
          finish(false, "invalid-json");
        }
      });
      socket.once("error", () => finish(false, "connection-failed"));
      socket.once("end", () => finish(false, "connection-closed"));
    } catch {
      finish(false, "connection-failed");
    }
  });
}

async function registerWindowsTsfElevated(dllPath, {
  execFileAsync = execFileAsyncDefault,
  compatibilityDllPath = null
} = {}) {
  if (!isSafeAbsoluteWindowsDllPath(dllPath)) {
    throw new TypeError("Windows TSF repair requires an absolute DLL path.");
  }
  if (compatibilityDllPath && !isSafeAbsoluteWindowsDllPath(compatibilityDllPath)) {
    throw new TypeError("Windows TSF repair requires an absolute compatibility DLL path.");
  }
  const primaryPathBase64 = Buffer.from(dllPath, "utf16le").toString("base64");
  const compatibilityPathBase64 = Buffer.from(compatibilityDllPath ?? "", "utf16le").toString("base64");
  const elevatedScript = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${primaryPathBase64}'))`,
    `$compatibilityTarget = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${compatibilityPathBase64}'))`,
    "$registrar = Join-Path $env:WINDIR 'System32\\regsvr32.exe'",
    "& $registrar /s $target",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "if ($compatibilityTarget) { $compatibilityRegistrar = Join-Path $env:WINDIR 'SysWOW64\\regsvr32.exe'; & $compatibilityRegistrar /s $compatibilityTarget; $compatibilityExitCode = $LASTEXITCODE; if ($compatibilityExitCode -ne 0) { & $registrar /u /s $target | Out-Null; exit $compatibilityExitCode } }",
    "exit 0"
  ].join("; ");
  const repairDirectory = await mkdtemp(path.join(tmpdir(), "lekh-tsf-repair-"));
  const repairScriptPath = path.join(repairDirectory, "repair.ps1");
  try {
    await writeFile(repairScriptPath, elevatedScript, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const repairScriptPathBase64 = Buffer.from(repairScriptPath, "utf16le").toString("base64");
    const outerScript = [
      "$ErrorActionPreference = 'Stop'",
      `$repairScript = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${repairScriptPathBase64}'))`,
      "$quotedRepairScript = [char]34 + $repairScript + [char]34",
      "$powershell = Join-Path $PSHOME 'powershell.exe'",
      "$process = Start-Process -FilePath $powershell -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $quotedRepairScript) -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
      "exit $process.ExitCode"
    ].join("; ");
    const encodedOuterScript = Buffer.from(outerScript, "utf16le").toString("base64");
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedOuterScript
    ], { timeout: 120_000, windowsHide: true });
  } finally {
    await rm(repairDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  return { ok: true };
}

async function readWindowsStartupRegistration(executablePath, { execFileAsync = execFileAsyncDefault } = {}) {
  if (!isSafeAbsoluteWindowsExecutablePath(executablePath)) return false;
  const registeredCommand = await queryRegistryValue(WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, { execFileAsync });
  return typeof registeredCommand === "string"
    && registeredCommand.trim().toLowerCase() === windowsStartupCommand(executablePath).toLowerCase();
}

async function writeWindowsStartupRegistration(enabled, executablePath, { execFileAsync = execFileAsyncDefault } = {}) {
  if (typeof enabled !== "boolean" || !isSafeAbsoluteWindowsExecutablePath(executablePath)) {
    throw new TypeError("Windows run-at-sign-in requires a boolean and an absolute executable path.");
  }
  if (!enabled) {
    await deleteRegistryValueFromKey(WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, { execFileAsync });
    return { ok: true, enabled: false };
  }
  await execFileAsync("reg.exe", [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    WINDOWS_RUN_VALUE,
    "/t",
    "REG_SZ",
    "/d",
    windowsStartupCommand(executablePath),
    "/f",
    "/reg:64"
  ], { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 });
  return { ok: true, enabled: true };
}

async function currentWindowsSid({ execFileAsync = execFileAsyncDefault } = {}) {
  if (cachedWindowsSid) return cachedWindowsSid;
  try {
    const { stdout } = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      timeout: 3000,
      windowsHide: true
    });
    const sid = stdout.match(/S-\d-(?:\d+-)+\d+/i)?.[0];
    if (!sid || sid.length > 184) return null;
    cachedWindowsSid = sid;
    return sid;
  } catch {
    return null;
  }
}

function windowsApplicationIdentifier(filePath) {
  if (typeof filePath !== "string" || filePath.includes("\0") || path.extname(filePath).toLowerCase() !== ".exe") {
    return null;
  }
  const executableName = path.win32.basename(filePath).toLowerCase();
  if (!/^[^<>:"/\\|?*\u0000-\u001F]{1,180}\.exe$/iu.test(executableName)) return null;
  return `win32.exe:${executableName}`;
}

function isSupportedApplicationIdentifier(value) {
  return typeof value === "string" && (
    /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)
    || /^win32\.exe:[^<>:"/\\|?*\u0000-\u001F]{1,180}\.exe$/iu.test(value)
  );
}

async function queryRegistryValue(key, valueName, {
  execFileAsync = execFileAsyncDefault,
  registryView = 64
} = {}) {
  const args = ["query", key, valueName === null ? "/ve" : "/v", ...(valueName === null ? [] : [valueName]), `/reg:${registryView}`];
  try {
    const { stdout } = await execFileAsync("reg.exe", args, {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    return parseRegistryQueryOutput(stdout);
  } catch {
    return null;
  }
}

async function registryKeyExists(key, { execFileAsync = execFileAsyncDefault } = {}) {
  try {
    await execFileAsync("reg.exe", ["query", key, "/reg:64"], {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 256 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

async function addRegistryValue(name, type, data, { execFileAsync = execFileAsyncDefault } = {}) {
  await execFileAsync("reg.exe", [
    "add",
    WINDOWS_PREFERENCE_KEY,
    "/v",
    name,
    "/t",
    type,
    "/d",
    String(data),
    "/f",
    "/reg:64"
  ], { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 });
}

async function deleteRegistryValue(name, { execFileAsync = execFileAsyncDefault } = {}) {
  return deleteRegistryValueFromKey(WINDOWS_PREFERENCE_KEY, name, { execFileAsync });
}

async function deleteRegistryValueFromKey(key, name, { execFileAsync = execFileAsyncDefault } = {}) {
  try {
    await execFileAsync("reg.exe", [
      "delete",
      key,
      "/v",
      name,
      "/f",
      "/reg:64"
    ], { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 });
  } catch (error) {
    if (!isMissingRegistryValueError(error)) throw error;
  }
}

function windowsStartupCommand(executablePath) {
  return `"${executablePath}" --background`;
}

function parseRegistryQueryOutput(stdout) {
  if (typeof stdout !== "string") return null;
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:\(Default\)|[^\s]+)\s+REG_(?:SZ|EXPAND_SZ|DWORD|QWORD|MULTI_SZ)\s+(.*)$/i);
    if (match) return match[1].trim();
  }
  return null;
}

function parseRegistryBoolean(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0x1" || normalized === "1" || normalized === "true") return true;
  if (normalized === "0x0" || normalized === "0" || normalized === "false") return false;
  return fallback;
}

function parseRegistryMultiString(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  return Array.from(new Set(value.split(/\\0/).map((item) => item.trim()).filter(Boolean)));
}

function equivalentWindowsPaths(left, right) {
  try {
    return path.win32.normalize(left.replace(/^"|"$/g, "")).toLowerCase()
      === path.win32.normalize(right.replace(/^"|"$/g, "")).toLowerCase();
  } catch {
    return false;
  }
}

function isSafeAbsoluteWindowsDllPath(value) {
  return typeof value === "string"
    && value.length > 4
    && value.length <= 32_768
    && !value.includes("\0")
    && !value.includes('"')
    && path.win32.isAbsolute(value)
    && path.win32.extname(value).toLowerCase() === ".dll";
}

function isSafeAbsoluteWindowsExecutablePath(value) {
  return typeof value === "string"
    && value.length > 4
    && value.length <= 32_768
    && !value.includes("\0")
    && !value.includes('"')
    && path.win32.isAbsolute(value)
    && path.win32.extname(value).toLowerCase() === ".exe";
}

function isMissingRegistryValueError(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return code === 1 || code === "1";
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

module.exports = {
  WINDOWS_EXCLUDED_APPLICATIONS_VALUE,
  WINDOWS_MODE_VALUE,
  WINDOWS_NATIVE_MODES,
  WINDOWS_PREFERENCE_DEFINITIONS,
  WINDOWS_PREFERENCE_KEY,
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE,
  WINDOWS_TSF_CLSID,
  WINDOWS_TSF_PROFILE_GUID,
  currentWindowsSid,
  defaultWindowsPreferences,
  inspectWindowsRegistration,
  isSupportedApplicationIdentifier,
  parseRegistryBoolean,
  parseRegistryMultiString,
  parseRegistryQueryOutput,
  probeWindowsBroker,
  readWindowsPreferences,
  readWindowsStartupRegistration,
  registerWindowsTsfElevated,
  windowsApplicationIdentifier,
  writeWindowsStartupRegistration,
  writeWindowsPreferencePatch
};
