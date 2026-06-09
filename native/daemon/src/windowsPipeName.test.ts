import { describe, expect, it } from "vitest";
import { defaultWindowsPipeName, parseWhoamiUserSid, windowsPipeNameForSid } from "./windowsPipeName";

describe("Windows named-pipe identity", () => {
  it("builds a per-user pipe name from a Windows SID", () => {
    expect(windowsPipeNameForSid("S-1-5-21-100-200-300-1001")).toBe("\\\\.\\pipe\\LekhKeyboard-S-1-5-21-100-200-300-1001");
  });

  it("parses whoami CSV output", () => {
    expect(parseWhoamiUserSid('"desktop\\\\rohan","S-1-5-21-100-200-300-1001"\r\n')).toBe("S-1-5-21-100-200-300-1001");
  });

  it("allows an explicit pipe override for controlled native tests", () => {
    expect(defaultWindowsPipeName({ LEKH_KEYBOARD_PIPE_NAME: "\\\\.\\pipe\\LekhKeyboard-Test" })).toBe(
      "\\\\.\\pipe\\LekhKeyboard-Test"
    );
  });
});
