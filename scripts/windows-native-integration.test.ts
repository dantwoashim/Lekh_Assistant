import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const windowsNative = require("../electron/windows-native.cjs") as {
  defaultWindowsPreferences(): LekhNativePreferences;
  inspectWindowsRegistration(
    expectedPath: string,
    options: { execFileAsync: ExecFile; compatibilityDllPath?: string }
  ): Promise<{
    registered: boolean;
    pathMatches: boolean;
    valid: boolean;
    compatibilityRegistered: boolean;
    compatibilityPathMatches: boolean;
    issues: string[];
  }>;
  parseRegistryBoolean(value: unknown, fallback: boolean): boolean;
  parseRegistryMultiString(value: unknown): string[];
  parseRegistryQueryOutput(value: unknown): string | null;
  probeWindowsBroker(options: {
    connect: (path: string) => unknown;
    sid: string;
    timeoutMs: number;
  }): Promise<{ healthy: boolean; reason: string | null }>;
  readWindowsPreferences(options: { execFileAsync: ExecFile }): Promise<LekhNativePreferences>;
  readWindowsStartupRegistration(path: string, options: { execFileAsync: ExecFile }): Promise<boolean>;
  registerWindowsTsfElevated(
    path: string,
    options: { execFileAsync: ExecFile; compatibilityDllPath?: string }
  ): Promise<{ ok: boolean }>;
  windowsApplicationIdentifier(path: string): string | null;
  writeWindowsStartupRegistration(
    enabled: boolean,
    path: string,
    options: { execFileAsync: ExecFile }
  ): Promise<{ ok: boolean; enabled: boolean }>;
  writeWindowsPreferencePatch(
    patch: Partial<LekhNativePreferences>,
    options: { execFileAsync: ExecFile }
  ): Promise<{ ok: boolean }>;
};

type ExecFile = (
  file: string,
  args: string[],
  options?: Record<string, unknown>
) => Promise<{ stdout: string; stderr?: string }>;

function registryOutput(name: string, type: string, value: string): string {
  return `HKEY_CURRENT_USER\\Software\\Lekh\\Keyboard\r\n    ${name}    ${type}    ${value}\r\n`;
}

describe("Windows native companion integration", () => {
  it("uses monotonic request sequences when startup health is polled repeatedly", async () => {
    const requests: Array<{ id: string; clientInstanceId: string; requestSequence: number }> = [];
    const connect = vi.fn(() => {
      class FakePipe extends EventEmitter {
        destroyed = false;
        setEncoding() { return this; }
        write(frame: string) {
          const request = JSON.parse(frame.trim());
          requests.push(request);
          queueMicrotask(() => this.emit("data", `${JSON.stringify({
            id: request.id,
            type: "protocol.negotiate",
            version: 2,
            ok: true,
            serverInstanceId: "server-test",
            requestSequence: request.requestSequence,
            payload: { selectedVersion: 2 }
          })}\n`));
          return true;
        }
        destroy() { this.destroyed = true; }
      }
      const pipe = new FakePipe();
      queueMicrotask(() => pipe.emit("connect"));
      return pipe;
    });

    await expect(windowsNative.probeWindowsBroker({ connect, sid: "S-1-5-21-test", timeoutMs: 1000 }))
      .resolves.toEqual(expect.objectContaining({ healthy: true }));
    await expect(windowsNative.probeWindowsBroker({ connect, sid: "S-1-5-21-test", timeoutMs: 1000 }))
      .resolves.toEqual(expect.objectContaining({ healthy: true }));
    expect(requests[1].clientInstanceId).toBe(requests[0].clientInstanceId);
    expect(requests[1].requestSequence).toBe(requests[0].requestSequence + 1);
  });

  it("reads bounded per-user preferences and preserves privacy-first defaults", async () => {
    const execFileAsync: ExecFile = vi.fn(async (_file, args) => {
      const name = args[3];
      if (name === "LekhNativeTypingMode") {
        return { stdout: registryOutput(name, "REG_SZ", "romanized-romanized") };
      }
      if (name === "LekhPersonalizationEnabled") {
        return { stdout: registryOutput(name, "REG_DWORD", "0x1") };
      }
      if (name === "LekhInlinePreviewEnabled") {
        return { stdout: registryOutput(name, "REG_DWORD", "0x0") };
      }
      if (name === "LekhExcludedApplicationBundleIdentifiers") {
        return {
          stdout: registryOutput(
            name,
            "REG_MULTI_SZ",
            "win32.exe:notepad.exe\\0com.example.Editor"
          )
        };
      }
      throw Object.assign(new Error("missing"), { code: 1 });
    });

    await expect(windowsNative.readWindowsPreferences({ execFileAsync })).resolves.toEqual({
      ...windowsNative.defaultWindowsPreferences(),
      nativeTypingMode: "romanized-romanized",
      inlinePreviewEnabled: false,
      personalizationEnabled: true,
      excludedApplicationBundleIdentifiers: [
        "win32.exe:notepad.exe",
        "com.example.Editor"
      ]
    });
  });

  it("writes only typed reg.exe arguments and rejects unverified Windows modes", async () => {
    const calls: string[][] = [];
    const execFileAsync: ExecFile = vi.fn(async (_file, args) => {
      calls.push(args);
      return { stdout: "" };
    });
    await windowsNative.writeWindowsPreferencePatch({
      inlinePreviewEnabled: false,
      nativeTypingMode: "romanized-romanized",
      excludedApplicationBundleIdentifiers: ["win32.exe:notepad.exe"]
    }, { execFileAsync });

    expect(calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(["/v", "LekhInlinePreviewEnabled", "/t", "REG_DWORD", "/d", "0"]),
      expect.arrayContaining(["/v", "LekhNativeTypingMode", "/t", "REG_SZ", "/d", "romanized-romanized"]),
      expect.arrayContaining(["/v", "LekhExcludedApplicationBundleIdentifiers", "/t", "REG_MULTI_SZ"])
    ]));
    await expect(windowsNative.writeWindowsPreferencePatch({
      nativeTypingMode: "traditional-traditional"
    }, { execFileAsync })).rejects.toThrow(/verified Romanized input modes/);
  });

  it("checks the real machine-wide COM path and TSF profile registration", async () => {
    const expected = "C:\\Program Files\\Lekh\\LekhTextService.dll";
    const compatibility = "C:\\Program Files\\Lekh\\x86\\LekhTextService.dll";
    const execFileAsync: ExecFile = vi.fn(async (_file, args) => {
      const key = args[1];
      if (key.includes("InprocServer32")) {
        const registeredPath = args.includes("/reg:32") ? compatibility : expected;
        return { stdout: `HKEY_LOCAL_MACHINE\\...\r\n    (Default)    REG_SZ    ${registeredPath}\r\n` };
      }
      if (key.includes("Microsoft\\CTF\\TIP")) return { stdout: "registered" };
      throw new Error("unexpected query");
    });

    await expect(windowsNative.inspectWindowsRegistration(expected, {
      execFileAsync,
      compatibilityDllPath: compatibility
    })).resolves.toEqual({
      registered: true,
      pathMatches: true,
      valid: true,
      compatibilityRegistered: true,
      compatibilityPathMatches: true,
      issues: []
    });
    expect(vi.mocked(execFileAsync).mock.calls.every(([, args]) => args[1].startsWith("HKLM\\")))
      .toBe(true);
    expect(vi.mocked(execFileAsync).mock.calls.some(([, args]) => args.includes("/reg:32"))).toBe(true);
  });

  it("creates privacy-safe executable identifiers without persisting full paths", () => {
    expect(windowsNative.windowsApplicationIdentifier("C:\\Program Files\\Windows NT\\notepad.exe"))
      .toBe("win32.exe:notepad.exe");
    expect(windowsNative.windowsApplicationIdentifier("C:\\लेख\\Lekh Helper.exe"))
      .toBe("win32.exe:lekh helper.exe");
    expect(windowsNative.windowsApplicationIdentifier("C:\\Temp\\notepad.exe.txt")).toBeNull();
    expect(windowsNative.parseRegistryMultiString("a\\0a\\0b")).toEqual(["a", "b"]);
    expect(windowsNative.parseRegistryBoolean("0x1", false)).toBe(true);
    expect(windowsNative.parseRegistryQueryOutput(
      "HKEY_CURRENT_USER\\X\r\n    LekhNativeTypingMode    REG_SZ    romanized-traditional\r\n"
    )).toBe("romanized-traditional");
  });

  it("uses an explicit elevated hidden regsvr32 repair flow", async () => {
    const primaryPath = "C:\\Program Files\\Lekh\\LekhTextService.dll";
    const compatibilityPath = "C:\\Program Files\\Lekh\\x86\\LekhTextService.dll";
    let elevatedScript = "";
    const execFileAsync: ExecFile = vi.fn(async (_file, arguments_) => {
      const outerScript = Buffer.from(
        arguments_[arguments_.indexOf("-EncodedCommand") + 1],
        "base64"
      ).toString("utf16le");
      const encodedPath = outerScript.match(/FromBase64String\('([^']+)'\)/)?.[1];
      if (encodedPath) {
        const repairScriptPath = Buffer.from(encodedPath, "base64").toString("utf16le");
        elevatedScript = readFileSync(repairScriptPath, "utf8");
      }
      return { stdout: "" };
    });
    await expect(windowsNative.registerWindowsTsfElevated(
      primaryPath,
      { execFileAsync, compatibilityDllPath: compatibilityPath }
    )).resolves.toEqual({ ok: true });
    expect(execFileAsync).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NonInteractive", "-EncodedCommand"]),
      expect.objectContaining({ windowsHide: true })
    );
    const [, arguments_] = vi.mocked(execFileAsync).mock.calls[0];
    const repairScript = Buffer.from(
      arguments_[arguments_.indexOf("-EncodedCommand") + 1],
      "base64"
    ).toString("utf16le");
    expect(repairScript.match(/-Verb RunAs/g)).toHaveLength(1);
    expect(arguments_).not.toContain(compatibilityPath);
    expect(elevatedScript).not.toContain(primaryPath);
    expect(elevatedScript).not.toContain(compatibilityPath);
    expect(elevatedScript).toContain(Buffer.from(primaryPath, "utf16le").toString("base64"));
    expect(elevatedScript).toContain(Buffer.from(compatibilityPath, "utf16le").toString("base64"));
    expect(elevatedScript).toContain("System32\\regsvr32.exe");
    expect(elevatedScript).toContain("SysWOW64\\regsvr32.exe");
    expect(elevatedScript).toContain("& $registrar /u /s $target");
  });

  it("owns the same run-at-sign-in registry value as the installer", async () => {
    const executable = "C:\\Program Files\\Lekh Keyboard\\Lekh Keyboard Companion.exe";
    const calls: string[][] = [];
    const execFileAsync: ExecFile = vi.fn(async (_file, args) => {
      calls.push(args);
      if (args[0] === "query") {
        return {
          stdout: `HKEY_CURRENT_USER\\...\r\n    LekhKeyboardCompanion    REG_SZ    "${executable}" --background\r\n`
        };
      }
      return { stdout: "" };
    });

    await expect(windowsNative.readWindowsStartupRegistration(executable, { execFileAsync }))
      .resolves.toBe(true);
    await expect(windowsNative.writeWindowsStartupRegistration(true, executable, { execFileAsync }))
      .resolves.toEqual({ ok: true, enabled: true });
    await expect(windowsNative.writeWindowsStartupRegistration(false, executable, { execFileAsync }))
      .resolves.toEqual({ ok: true, enabled: false });
    expect(calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "LekhKeyboardCompanion"]),
      expect.arrayContaining(["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "LekhKeyboardCompanion"])
    ]));
  });
});
