import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("portable SHA-256", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"],
    ["स्वास्थ्य", "a1605a2da146ff4925fd5e865f17ec2f906b4602a923cf6c7da79d7c030d5aab"],
    ["🙂".repeat(100), "5da50ebba74058ac2912f38f18a43353259be36c54d8a96a2cd54357b0660500"]
  ])("matches the published SHA-256 vector for %j", (value, expected) => {
    expect(sha256Hex(value)).toBe(expected);
  });
});
