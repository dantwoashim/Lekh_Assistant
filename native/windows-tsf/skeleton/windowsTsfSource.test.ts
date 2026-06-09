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
});
