#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const startedAt = performance.now();
const installedBundle = join(homedir(), "Library", "Input Methods", "Lekh Keyboard.app");
const stagedPackageArtifact = process.env.LEKH_MACOS_IMK_BUILD_DIR
  ? join(process.env.LEKH_MACOS_IMK_BUILD_DIR, "Lekh Keyboard.imkdevbundle")
  : join(homedir(), "Library", "Caches", "LekhKeyboardBuild", "native", "macos", "Lekh Keyboard.imkdevbundle");
const packageArtifact = join(root, "release", "native", "macos", "Lekh Keyboard.imkdevbundle");
const oldPackageArtifact = join(root, "release", "native", "macos", "Lekh Keyboard Dev.imkdevbundle");
const legacyPackageArtifact = join(root, "release", "native", "macos", "Lekh Keyboard.app");
const plistPath = join(installedBundle, "Contents", "Info.plist");
const executablePath = join(installedBundle, "Contents", "MacOS", "LekhInputMethodApp");
const reportPath = join(root, "reports", "macos-imk-dev-install-check.json");
const inputSourceId = "com.lekh.inputmethod.LekhKeyboard.Romanized";
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const failures = [];
const toolchainCacheDir = join(root, ".build-cache", "macos-toolchain");
const toolchainEnv = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: join(toolchainCacheDir, "clang-module-cache"),
  SWIFT_MODULE_CACHE_PATH: join(toolchainCacheDir, "swift-module-cache")
};

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

mkdirSync(toolchainEnv.CLANG_MODULE_CACHE_PATH, { recursive: true });
mkdirSync(toolchainEnv.SWIFT_MODULE_CACHE_PATH, { recursive: true });

for (const artifact of [stagedPackageArtifact, packageArtifact, oldPackageArtifact, legacyPackageArtifact]) {
  spawnSync(lsregister, ["-u", "-v", artifact], { encoding: "utf8", stdio: "ignore" });
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
    "com.lekh.inputmethod.LekhKeyboard",
    "InputMethodConnectionName",
    "com.lekh.inputmethod.LekhKeyboard_Connection",
    "InputMethodServerControllerClass",
    "LekhInputController",
    "NSPrincipalClass",
    "LekhInputMethodApplication",
    "tsInputMethodIconFileKey",
    "tsInputMethodCharacterRepertoireKey",
    "ComponentInputModeDict",
    "tsInputModeListKey",
    "com.lekh.inputmethod.LekhKeyboard.Romanized",
    "tsVisibleInputModeOrderedArrayKey",
    "Latn",
    "Deva"
  ]) {
    if (!plist.includes(marker)) failures.push(`Installed Info.plist missing ${marker}.`);
  }
}

if (failures.length > 0) fail();

spawnSync("swift", [join(root, "native", "macos-imk", "skeleton", "register-dev.swift"), installedBundle], {
  encoding: "utf8",
  env: toolchainEnv
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
var enabledCount = 0
var selectableCount = 0
if let unmanagedList = TISCreateInputSourceList(query, false) {
  let list = unmanagedList.takeRetainedValue() as NSArray
  discoverableCount = list.count
  for item in list {
    let source = item as! TISInputSource
    if let enabledPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsEnabled),
       CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(enabledPtr).takeUnretainedValue()) {
      enabledCount += 1
    }
    if let selectablePtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsSelectCapable),
       CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(selectablePtr).takeUnretainedValue()) {
      selectableCount += 1
    }
  }
}
if discoverableCount == 0, let unmanagedAll = TISCreateInputSourceList(nil, true) {
  let allSources = unmanagedAll.takeRetainedValue() as NSArray
  for item in allSources {
    let source = item as! TISInputSource
    let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
      .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
    if id == "${inputSourceId}" {
      discoverableCount += 1
      if let enabledPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsEnabled),
         CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(enabledPtr).takeUnretainedValue()) {
        enabledCount += 1
      }
      if let selectablePtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsSelectCapable),
         CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(selectablePtr).takeUnretainedValue()) {
        selectableCount += 1
      }
    }
  }
}
print("discoverable=\\(discoverableCount)")
print("enabled=\\(enabledCount)")
print("selectable=\\(selectableCount)")
let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
let currentId = TISGetInputSourceProperty(current, kTISPropertyInputSourceID).map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
print("current=\\(currentId)")
`
  ],
  { encoding: "utf8", env: toolchainEnv }
);
}

let registryCheck = runRegistryCheck();

for (
  let attempt = 0;
  attempt < 20 &&
  registryCheck.status === 0 &&
  (!registryCheck.stdout.includes("discoverable=1") || !registryCheck.stdout.includes("enabled=1"));
  attempt += 1
) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  registryCheck = runRegistryCheck();
}

if (registryCheck.status !== 0) {
  fail({ step: "registry", reason: "Swift Text Input Source registry check failed.", stdout: registryCheck.stdout, stderr: registryCheck.stderr });
}

if (!/^discoverable=[1-9][0-9]*$/m.test(registryCheck.stdout)) {
  failures.push("Installed input method is not discoverable in the macOS Text Input Source registry.");
}
if (!/^enabled=[1-9][0-9]*$/m.test(registryCheck.stdout)) {
  failures.push("Installed input method is discoverable but not enabled in the macOS Text Input Source registry; menu-bar selection will not be reliable.");
}
if (!/^selectable=[1-9][0-9]*$/m.test(registryCheck.stdout)) {
  failures.push("Installed input method is not select-capable in the macOS Text Input Source registry.");
}

if (registryCheck.stdout.includes(`current=${inputSourceId}`)) {
  failures.push("Dev installer left Lekh selected as the current input source; this is unsafe until host-app typing is proven.");
}

const launchServices = spawnSync(lsregister, ["-dump"], {
  encoding: "utf8",
  maxBuffer: 80 * 1024 * 1024
});
if (launchServices.status === 0 && (
  launchServices.stdout.includes(`path:                       ${stagedPackageArtifact}`) ||
  launchServices.stdout.includes(`path:                       ${packageArtifact}`) ||
  launchServices.stdout.includes(`path:                       ${oldPackageArtifact}`) ||
  launchServices.stdout.includes(`path:                       ${legacyPackageArtifact}`)
)) {
  failures.push("LaunchServices still has a packaged IMK artifact registered. Re-run npm run package:macos:imk:dev && native/macos-imk/skeleton/install-dev.sh so only ~/Library/Input Methods is authoritative.");
}

if (failures.length > 0) fail({ registryStdout: registryCheck.stdout, registryStderr: registryCheck.stderr });

spawnSync("pkill", ["-f", "Lekh Keyboard.app/Contents/MacOS/LekhInputMethodApp"], {
  encoding: "utf8"
});
spawnSync("pkill", ["-f", "Lekh Keyboard Dev.app/Contents/MacOS/LekhInputMethodApp"], {
  encoding: "utf8"
});

const child = spawn(executablePath, [], {
  env: toolchainEnv,
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
