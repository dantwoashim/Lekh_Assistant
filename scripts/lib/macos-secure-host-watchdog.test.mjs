import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentInputSource,
  focusAccessibilityElement,
  processExecutablePath,
  restoreExactInputSource,
  secureEventInputState
} from "./macos-imk-host-harness.mjs";

const liveGUIEnabled = process.env.LEKH_RUN_LIVE_GUI_QA === "1";

function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const value = predicate();
      if (value || Date.now() >= deadline) {
        clearInterval(timer);
        resolve(value || null);
      }
    }, 75);
  });
}

describe.skipIf(process.platform !== "darwin")("secure host watchdog", () => {
  it.runIf(liveGUIEnabled)("terminates on parent-pipe EOF and releases Secure Event Input", async () => {
    const root = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), "lekh-secure-watchdog-"));
    const executable = join(directory, "LekhSecureFieldHost");
    const statusPath = join(directory, "host-status.v1.json");
    const priorSource = currentInputSource();
    let child = null;
    try {
      expect(priorSource.status).toBe(0);
      execFileSync("/usr/bin/xcrun", [
        "swiftc",
        join(root, "native", "macos-imk", "qa-hosts", "LekhSecureFieldHost", "main.swift"),
        "-O", "-framework", "AppKit", "-framework", "Carbon", "-o", executable
      ]);
      chmodSync(executable, 0o755);
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", executable]);
      child = spawn(executable, [], {
        env: { ...process.env, LEKH_SECURE_HOST_STATUS_PATH: statusPath },
        stdio: ["pipe", "ignore", "ignore"]
      });
      expect(Number.isInteger(child.pid)).toBe(true);
      child.stdin.write(`${Buffer.from("watchdog fixture ", "utf8").toString("base64")}\n`);
      expect(await waitFor(() => existsSync(statusPath))).toBe(true);
      const focused = focusAccessibilityElement(child.pid, "lekh.secureHost.field", "AXSecureTextField");
      expect(focused.status).toBe(0);
      expect(await waitFor(() => secureEventInputState().enabled === true)).toBe(true);

      child.stdin.end();
      const exit = await Promise.race([
        new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
        new Promise((resolve) => setTimeout(() => resolve(null), 5_000))
      ]);
      expect(exit).not.toBeNull();
      expect(await waitFor(() => secureEventInputState().enabled === false, 5_000)).toBe(true);
      expect(processExecutablePath(child.pid)).toBe("");
      const restored = restoreExactInputSource(priorSource.id);
      expect(restored.status).toBe(0);
      expect(currentInputSource().id).toBe(priorSource.id);
    } finally {
      if (child && processExecutablePath(child.pid) === executable) child.kill("SIGKILL");
      if (priorSource.id) restoreExactInputSource(priorSource.id);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
