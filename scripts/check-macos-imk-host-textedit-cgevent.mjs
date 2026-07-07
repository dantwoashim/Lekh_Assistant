#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
const reportPath = join(root, "reports", "macos-imk-host-textedit-cgevent-smoke.json");
const tempTextEditFile = "/tmp/lekh-native-host-cgevent-smoke.txt";
const expected = "स्वास्थ्य ";
const failures = [];

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function writeReport(status, details = {}) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:textedit:cgevent",
    suite: "macos-imk-host-textedit-cgevent",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    appBundle,
    expected,
    failures,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function fail(details = {}) {
  run(restoreScript, []);
  const report = writeReport("failed", details);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

function blockedAutomation(details = {}) {
  run(restoreScript, []);
  const report = writeReport("blocked-automation", {
    ...details,
    note:
      "CGEvent key-code injection did not prove host-app delivery. This can still be blocked by Accessibility/Input Monitoring, app focus, TIS selection race, or an IMK bug. Manual hardware typing remains the release gate."
  });
  console.warn(JSON.stringify(report, null, 2));
  process.exit(2);
}

if (process.platform !== "darwin") {
  fail({ reason: "macOS IMK CGEvent host-app smoke must run on macOS.", platform: process.platform });
}

if (!existsSync(appBundle)) failures.push("Installed Lekh Keyboard input method bundle is missing.");
if (!existsSync(registerScript)) failures.push("register-dev.swift is missing.");
if (!existsSync(restoreScript)) failures.push("restore-system-keyboard.sh is missing.");
if (failures.length > 0) fail();

run(restoreScript, []);

try {
  writeFileSync(tempTextEditFile, "");
  const realTempTextEditFile = realpathSync(tempTextEditFile);
  run("open", ["-a", "TextEdit", tempTextEditFile]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);

  const prep = run("osascript", [
    "-e", 'tell application "TextEdit" to activate',
    "-e", `tell application "TextEdit" to if (path of front document) is not "${realTempTextEditFile}" then error "Front TextEdit document is not the Lekh probe file."`,
    "-e", 'tell application "TextEdit" to set text of front document to ""'
  ]);
  if (prep.status !== 0) blockedAutomation({ step: "prepare-textedit", stdout: prep.stdout, stderr: prep.stderr });

  run("open", ["-gj", appBundle]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);

  const select = run("swift", [registerScript, appBundle, "--select"]);
  if (select.status !== 0) fail({ step: "select-input-source", stdout: select.stdout, stderr: select.stderr });

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  const focus = run("osascript", [
    "-e", 'tell application "TextEdit" to activate',
    "-e", `tell application "TextEdit" to if (path of front document) is not "${realTempTextEditFile}" then error "Front TextEdit document changed before CGEvent posting."`
  ]);
  if (focus.status !== 0) blockedAutomation({ step: "focus-textedit", stdout: focus.stdout, stderr: focus.stderr });

  const postKeys = run("swift", [
    "-e",
    `
import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
let keyCodes: [CGKeyCode] = [1, 13, 0, 1, 17, 4, 16, 0, 18, 49]
for code in keyCodes {
  let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  down?.post(tap: .cghidEventTap)
  usleep(30_000)
  up?.post(tap: .cghidEventTap)
  usleep(45_000)
}
`
  ]);
  if (postKeys.status !== 0) blockedAutomation({ step: "post-cgevents", stdout: postKeys.stdout, stderr: postKeys.stderr });

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  const read = run("osascript", [
    "-e", `tell application "TextEdit" to if (path of front document) is not "${realTempTextEditFile}" then error "Front TextEdit document changed before read."`,
    "-e", 'tell application "TextEdit" to get text of front document'
  ]);
  if (read.status !== 0) blockedAutomation({ step: "read-textedit", stdout: read.stdout, stderr: read.stderr });

  const actual = read.stdout.replace(/\r?\n$/, "");
  if (actual !== expected) {
    failures.push(`TextEdit content mismatch. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
    blockedAutomation({ step: "assert-text", actual, selectStdout: select.stdout });
  }

  const report = writeReport("passed", {
    actual,
    note: "CGEvent key-code host smoke passed for TextEdit. This is useful automation evidence, not a replacement for the manual host-app matrix."
  });
  console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-host-textedit-cgevent-smoke.json", actual }, null, 2));
} finally {
  run(restoreScript, []);
}
