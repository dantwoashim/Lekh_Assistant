#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const installedBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const plistPath = join(installedBundle, "Contents", "Info.plist");
const executablePath = join(installedBundle, "Contents", "MacOS", "LekhInputMethodApp");
const reportPath = join(root, "reports", "macos-imk-dev-install-check.json");
const inputSourceId = "com.lekh.inputmethod.keyboard";
const failures = [];

function writeReport(status, details = {}) {
  mkdirSync(join(root, "reports"), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    command: "npm run check:macos-imk-install",
    suite: "macos-imk-dev-install",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    installedBundle,
    failures,
    ...details
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function fail(details = {}) {
  const report = writeReport("failed", details);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail({ reason: "macOS IMK installed-bundle smoke must run on macOS.", platform: process.platform });
}

if (!existsSync(installedBundle)) failures.push("Installed input method bundle is missing.");
if (!existsSync(plistPath)) failures.push("Installed input method Info.plist is missing.");
if (!existsSync(executablePath)) failures.push("Installed input method executable is missing.");
if (existsSync(executablePath) && !(statSync(executablePath).mode & 0o111)) {
  failures.push("Installed input method executable is not executable.");
}

if (existsSync(plistPath)) {
  const plist = readFileSync(plistPath, "utf8");
  for (const marker of [
    "com.lekh.inputmethod.keyboard",
    "InputMethodConnectionName",
    "Lekh_Keyboard_Connection",
    "InputMethodServerControllerClass",
    "LekhInputController",
    "tsInputMethodCharacterRepertoireKey",
    "Latn",
    "Deva"
  ]) {
    if (!plist.includes(marker)) failures.push(`Installed Info.plist missing ${marker}.`);
  }
}

if (failures.length > 0) fail();

spawnSync("swift", [join(root, "native", "macos-imk", "skeleton", "register-dev.swift"), installedBundle], {
  encoding: "utf8"
});

function runRegistryCheck() {
  return spawnSync(
  "swift",
  [
    "-e",
    `
import Carbon
import Foundation
let query = [kTISPropertyInputSourceID as String: "${inputSourceId}"] as CFDictionary
var discoverableCount = 0
if let unmanagedList = TISCreateInputSourceList(query, false) {
  discoverableCount = (unmanagedList.takeRetainedValue() as NSArray).count
}
if discoverableCount == 0, let unmanagedAll = TISCreateInputSourceList(nil, true) {
  let allSources = unmanagedAll.takeRetainedValue() as NSArray
  for item in allSources {
    let source = item as! TISInputSource
    let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
      .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
    if id == "${inputSourceId}" {
      discoverableCount += 1
    }
  }
}
print("discoverable=\\(discoverableCount)")
let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
let currentId = TISGetInputSourceProperty(current, kTISPropertyInputSourceID).map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
print("current=\\(currentId)")
`
  ],
  { encoding: "utf8" }
);
}

let registryCheck = runRegistryCheck();

for (let attempt = 0; attempt < 20 && registryCheck.status === 0 && !registryCheck.stdout.includes("discoverable=1"); attempt += 1) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  registryCheck = runRegistryCheck();
}

if (registryCheck.status !== 0) {
  fail({ step: "registry", reason: "Swift Text Input Source registry check failed.", stdout: registryCheck.stdout, stderr: registryCheck.stderr });
}

if (!registryCheck.stdout.includes("discoverable=1")) {
  failures.push("Installed input method is not discoverable in the macOS Text Input Source registry.");
}

if (registryCheck.stdout.includes(`current=${inputSourceId}`)) {
  failures.push("Dev installer left Lekh selected as the current input source; this is unsafe until host-app typing is proven.");
}

if (failures.length > 0) fail({ registryStdout: registryCheck.stdout, registryStderr: registryCheck.stderr });

const child = spawn(executablePath, [], {
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

const launchTimer = setTimeout(() => {
  if (child.exitCode !== null || child.killed) {
    fail({ step: "launch", reason: "Input method executable exited during launch smoke.", stdout, stderr, exitCode: child.exitCode });
  }

  child.kill("SIGTERM");
  const report = writeReport("passed", {
    launchSmokeMs: Math.round(performance.now() - startedAt),
    registryStdout: registryCheck.stdout,
    note: "The installed IMK app bundle is discoverable and launches. It is intentionally not required to be selected as the current input source because the native host-app typing path is not release-safe yet."
  });
  console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-dev-install-check.json", installedBundle }, null, 2));
  process.exit(0);
}, 1500);

launchTimer.unref();

child.on("exit", (code, signal) => {
  clearTimeout(launchTimer);
  fail({ step: "launch", reason: "Input method executable exited before the launch smoke window.", stdout, stderr, code, signal });
});
