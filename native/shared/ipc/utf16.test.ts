import { describe, expect, it } from "vitest";
import { isWellFormedUtf16 } from "./utf16";

describe("IPC UTF-16 validation", () => {
  it("accepts BMP text and complete surrogate pairs", () => {
    expect(isWellFormedUtf16("नेपाली 😀 text")).toBe(true);
  });

  it("rejects every unpaired-surrogate position", () => {
    for (const value of ["\ud800", "\udc00", "a\ud800", "\ud800a", "a\udc00b", "\ud800\ud800"]) {
      expect(isWellFormedUtf16(value), JSON.stringify(value)).toBe(false);
    }
  });
});
