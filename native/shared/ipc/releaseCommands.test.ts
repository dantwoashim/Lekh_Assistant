import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("native release protocol generation gates", () => {
  it.each([
    "package:windows",
    "package:windows:unsigned",
    "package:macos:imk:dev",
    "package:macos:imk:test-installer",
    "package:macos:appcast",
    "package:macos:release-manifest",
    "package:macos",
    "package:macos:unsigned",
    "package:macos:electron:unsigned"
  ])("checks generated IPC parity before %s", (scriptName) => {
    const command = packageJson.scripts?.[scriptName];
    expect(command).toBeTypeOf("string");
    expect(command).toContain("npm run check:experimental-passive-commit && npm run check:ipc-schema &&");
  });
});
