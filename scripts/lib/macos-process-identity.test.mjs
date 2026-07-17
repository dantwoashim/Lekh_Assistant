import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  exactProcessIdentity,
  processIdentity,
  signalExactProcess
} from "./macos-imk-host-harness.mjs";

function closeOf(child) {
  return new Promise((resolve) => child.once("close", resolve));
}

describe.skipIf(process.platform !== "darwin")("macOS process-instance identity", () => {
  it("distinguishes sequential instances of the same executable", async () => {
    const first = spawn("/bin/sleep", ["30"]);
    const firstClosed = closeOf(first);
    const firstIdentity = processIdentity(first.pid);
    expect(firstIdentity).toMatchObject({ status: 0, state: "running", executablePath: "/bin/sleep" });
    expect(firstIdentity.processStartToken).toMatch(/^\d{1,20}:\d{1,6}$/u);
    first.kill("SIGTERM");
    await firstClosed;

    const second = spawn("/bin/sleep", ["30"]);
    const secondClosed = closeOf(second);
    try {
      const secondIdentity = processIdentity(second.pid);
      expect(secondIdentity).toMatchObject({ status: 0, state: "running", executablePath: "/bin/sleep" });
      expect(secondIdentity.processStartToken).not.toBe(firstIdentity.processStartToken);
    } finally {
      second.kill("SIGTERM");
      await secondClosed;
    }
  });

  it("never signals a live process when its start epoch does not match", async () => {
    const child = spawn("/bin/sleep", ["30"]);
    const closed = closeOf(child);
    try {
      const identity = processIdentity(child.pid);
      const mismatched = { ...identity, processStartToken: "1:1" };
      expect(exactProcessIdentity(mismatched)).toMatchObject({
        status: 0,
        state: "running",
        matches: false
      });
      expect(signalExactProcess(mismatched, "TERM")).toEqual({
        status: 0,
        disposition: "identity-mismatch",
        signalSent: false
      });
      expect(processIdentity(child.pid)).toMatchObject({ state: "running" });
    } finally {
      child.kill("SIGTERM");
      await closed;
    }
  });

  it("keeps invalid, absent, and probe-failed states distinct", () => {
    expect(processIdentity(1)).toMatchObject({ status: 2, state: "invalid" });
    expect(processIdentity(99_999_999)).toMatchObject({ status: 0, state: "absent" });
    expect(exactProcessIdentity({
      processIdentifier: 99_999_999,
      executablePath: "/bin/sleep",
      processStartToken: "1:1"
    })).toMatchObject({ status: 0, state: "absent", matches: false });
  });
});
