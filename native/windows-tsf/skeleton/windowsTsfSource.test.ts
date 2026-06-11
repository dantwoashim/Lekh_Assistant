import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Windows TSF source safety contract", () => {
  it("keeps host-app keys pass-through unless experimental key eating is enabled", () => {
    const source = readFileSync(join(root, "native/windows-tsf/skeleton/LekhTextService.cpp"), "utf8");
    expect(source).toContain("LEKH_TSF_ENABLE_EXPERIMENTAL_KEY_EATING");
    expect(source).toContain("!experimentalKeyEatingEnabled()");
    expect(source).toContain("*eaten = FALSE");
  });

  it("uses a per-user pipe name when the Windows SID is available", () => {
    const ipc = readFileSync(join(root, "native/windows-tsf/skeleton/IpcClient.cpp"), "utf8");
    const guids = readFileSync(join(root, "native/windows-tsf/skeleton/Guids.h"), "utf8");
    expect(ipc).toContain("ConvertSidToStringSidW");
    expect(ipc).toContain("LEKH_KEYBOARD_PIPE_NAME");
    expect(guids).toContain("kLekhPipeNamePrefix");
  });

  it("uses per-focus TSF session ids instead of a constant dev session", () => {
    const header = readFileSync(join(root, "native/windows-tsf/skeleton/LekhTextService.h"), "utf8");
    const source = readFileSync(join(root, "native/windows-tsf/skeleton/LekhTextService.cpp"), "utf8");
    expect(header).toContain("std::wstring sessionId_");
    expect(source).toContain("makeSessionId()");
    expect(source).toContain("resetSessionId()");
    expect(source).toContain("OnSetFocus(BOOL foreground)");
    expect(source).not.toContain("windows-tsf-dev");
  });

  it("uses overlapped named-pipe IO with bounded hot-path timeout", () => {
    const ipc = readFileSync(join(root, "native/windows-tsf/skeleton/IpcClient.cpp"), "utf8");
    expect(ipc).toContain("FILE_FLAG_OVERLAPPED");
    expect(ipc).toContain("WaitForSingleObject");
    expect(ipc).toContain("CancelIo");
    expect(ipc).toContain("writeFileWithTimeout");
    expect(ipc).toContain("readFileWithTimeout");
  });
});
