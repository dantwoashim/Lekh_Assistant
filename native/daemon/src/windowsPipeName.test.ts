import { describe, expect, it } from "vitest";
import { defaultWindowsPipeName, parseWhoamiUserSid, windowsPipeNameForSid } from "./windowsPipeName";

describe("Windows named-pipe identity", () => {
  it("builds a per-user pipe name from a Windows SID", () => {
    expect(windowsPipeNameForSid("S-1-5-21-100-200-300-1001")).toBe("\\\\.\\pipe\\LekhKeyboard-S-1-5-21-100-200-300-1001");
  });

  it("parses whoami CSV output", () => {
    expect(parseWhoamiUserSid('"desktop\\\\rohan","S-1-5-21-100-200-300-1001"\r\n')).toBe("S-1-5-21-100-200-300-1001");
    expect(parseWhoamiUserSid('"desktop\\\\rohan","S-0-5-21-100-200-300-1001"\r\n')).toBeUndefined();
    expect(parseWhoamiUserSid('"desktop\\\\rohan","S-1-5-21-100-200-300-1001\\evil"\r\n')).toBeUndefined();
  });

  it("resolves only a verified Windows user SID and has no shared fallback", () => {
    expect(defaultWindowsPipeName({
      platform: "win32",
      resolveUserSid: () => "S-1-5-21-100-200-300-1001"
    })).toBe("\\\\.\\pipe\\LekhKeyboard-S-1-5-21-100-200-300-1001");
    expect(() => defaultWindowsPipeName({ platform: "win32", resolveUserSid: () => undefined })).toThrow(
      "verified current-user Windows SID"
    );
    expect(() => defaultWindowsPipeName({ platform: "darwin" })).toThrow("only be resolved on Windows");
  });

  it("rejects malformed SID pipe segments instead of sanitizing them", () => {
    expect(() => windowsPipeNameForSid("S-1-5-21-100/other-user")).toThrow("Invalid current-user Windows SID");
    expect(() => windowsPipeNameForSid(`S-1-5-${"1".repeat(185)}`)).toThrow("Invalid current-user Windows SID");
    expect(() => windowsPipeNameForSid("")).toThrow("Invalid current-user Windows SID");
  });
});
