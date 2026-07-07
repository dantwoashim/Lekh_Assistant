#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const appBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
const reportPath = join(root, "reports", "macos-imk-host-textedit-smoke.json");
const tempTextEditFile = "/tmp/lekh-native-host-smoke.txt";
const expected = "स्वास्थ्य ";
const failures = [];

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function writeReport(status, details = {}) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run probe:macos-imk-host:textedit",
    suite: "macos-imk-host-textedit",
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
      "The dev input method bundle is installed and selectable, but scripted TextEdit keystrokes did not prove host-app delivery. macOS automation can bypass or race selected input methods, so this remains a manual host-app verification item rather than a release pass."
  });
  console.warn(JSON.stringify(report, null, 2));
  process.exit(2);
}

if (process.platform !== "darwin") {
  fail({ reason: "macOS IMK host-app smoke must run on macOS.", platform: process.platform });
}

if (!existsSync(appBundle)) failures.push("Installed Lekh Keyboard input method bundle is missing.");
if (!existsSync(registerScript)) failures.push("register-dev.swift is missing.");
if (!existsSync(restoreScript)) failures.push("restore-system-keyboard.sh is missing.");
if (failures.length > 0) fail();

run(restoreScript, []);

try {
  writeFileSync(tempTextEditFile, "");
  run("open", ["-gj", appBundle]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  run("open", ["-a", "TextEdit", tempTextEditFile]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);

  const prep = run("osascript", [
    "-e", 'tell application "TextEdit" to activate',
    "-e", 'tell application "System Events" to keystroke "a" using command down',
    "-e", 'tell application "System Events" to key code 51'
  ]);
  if (prep.status !== 0) fail({ step: "prepare-textedit", stdout: prep.stdout, stderr: prep.stderr });

  const select = run("swift", [registerScript, appBundle, "--select"]);
  if (select.status !== 0) fail({ step: "select-input-source", stdout: select.stdout, stderr: select.stderr });

  let read = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clear = run("osascript", [
      "-e", 'tell application "TextEdit" to activate',
      "-e", 'tell application "System Events" to keystroke "a" using command down',
      "-e", 'tell application "System Events" to key code 51'
    ]);
    if (clear.status !== 0) fail({ step: "clear-text", stdout: clear.stdout, stderr: clear.stderr });

    const type = run("osascript", [
      "-e", 'tell application "TextEdit" to activate',
      "-e", 'tell application "System Events" to keystroke "swasthya"',
      "-e", 'tell application "System Events" to key code 18',
      "-e", 'tell application "System Events" to key code 49'
    ]);
    if (type.status !== 0) fail({ step: "type-text", stdout: type.stdout, stderr: type.stderr, attempt });

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    read = run("osascript", ["-e", 'tell application "TextEdit" to get text of front document']);
    if (read.stdout.replace(/\r?\n$/, "") === expected) break;
  }

  if (read.status !== 0) fail({ step: "read-textedit", stdout: read.stdout, stderr: read.stderr });

  const actual = read.stdout.replace(/\r?\n$/, "");
  if (actual !== expected) {
    failures.push(`TextEdit content mismatch. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
    blockedAutomation({ step: "assert-text", actual });
  }

  const report = writeReport("passed", {
    actual,
    note: "Host-app smoke proves the dev IMK receives TextEdit key events, explicitly accepts candidate 1, and then inserts Space. It is not signed release or cross-app evidence."
  });
  console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-host-textedit-smoke.json", actual }, null, 2));
} finally {
  run(restoreScript, []);
}
