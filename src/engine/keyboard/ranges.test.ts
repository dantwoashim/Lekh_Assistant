import { describe, expect, it } from "vitest";
import {
  clampCaret,
  clampRange,
  deleteAfterCaret,
  deleteBeforeCaret,
  insertAtCaret,
  replaceByUtf16Range,
  sliceByUtf16Range,
  validateRange
} from "./ranges";

describe("keyboard UTF-16 range helpers", () => {
  it("validates and clamps ASCII ranges", () => {
    expect(validateRange("abc", [0, 2])).toBe(true);
    expect(validateRange("abc", [-1, 2])).toBe(false);
    expect(clampRange("abc", [-5, 99])).toEqual([0, 3]);
    expect(sliceByUtf16Range("abc", [1, 3])).toBe("bc");
  });

  it("replaces mixed Latin and Devanagari text by native UTF-16 offsets", () => {
    const input = "formमा";
    expect(replaceByUtf16Range(input, [4, 6], "लाई")).toBe("formलाई");
  });

  it("replaces Devanagari proofread spans using UTF-16 native offsets", () => {
    const input = "विद्यालय को";
    expect(sliceByUtf16Range(input, [0, 8])).toBe("विद्यालय");
    expect(replaceByUtf16Range(input, [0, input.length], "विद्यालयको")).toBe("विद्यालयको");
  });

  it("inserts at a clamped caret", () => {
    expect(insertAtCaret("स्व", 99, "ा")).toEqual({ text: "स्वा", caret: 4 });
  });

  it("deletes without splitting surrogate pairs", () => {
    expect(deleteBeforeCaret("a🙂b", 3)).toEqual({ text: "ab", caret: 1 });
    expect(deleteAfterCaret("a🙂b", 1)).toEqual({ text: "ab", caret: 1 });
  });

  it("treats Devanagari conjuncts and combining marks as indivisible graphemes", () => {
    expect(deleteBeforeCaret("कि", 2)).toEqual({ text: "", caret: 0 });
    expect(deleteBeforeCaret("क्ष", 3)).toEqual({ text: "", caret: 0 });
    expect(deleteAfterCaret("क्षत्र", 0)).toEqual({ text: "त्र", caret: 0 });
    expect(validateRange("कि", [1, 2])).toBe(false);
    expect(clampRange("कि", [1, 2])).toEqual([0, 2]);
  });

  it("keeps emoji ZWJ sequences intact and normalizes hostile numeric offsets", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(deleteBeforeCaret(`${family}क`, family.length)).toEqual({ text: "क", caret: 0 });
    expect(deleteAfterCaret(`${family}क`, 0)).toEqual({ text: "क", caret: 0 });
    expect(clampCaret("abc", Number.NaN)).toBe(0);
    expect(clampCaret("abc", Number.POSITIVE_INFINITY)).toBe(3);
  });
});
