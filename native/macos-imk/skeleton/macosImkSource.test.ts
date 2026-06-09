import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("macOS IMK proof target source", () => {
  it("contains a real IMKInputController subclass instead of the old placeholder source", () => {
    const controllerPath = join(root, "native/macos-imk/skeleton/LekhInputController.swift");
    expect(existsSync(controllerPath)).toBe(true);
    expect(existsSync(join(root, "native/macos-imk/skeleton/LekhInputController.placeholder.swift"))).toBe(false);

    const source = readFileSync(controllerPath, "utf8");
    expect(source).toContain("IMKInputController");
    expect(source).toContain("inputText");
    expect(source).toContain("setMarkedText");
    expect(source).toContain("insertText");
  });

  it("keeps XPC unavailable behavior pass-through by default", () => {
    const source = readFileSync(join(root, "native/macos-imk/skeleton/LekhXpcClient.swift"), "utf8");
    expect(source).toContain("LekhXpcEngineClient");
    expect(source).toContain("LekhInputDecision.passThrough");
  });
});
