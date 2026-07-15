#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

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
const installedEngineContract = join(installedBundle, "Contents", "Resources", "lekh-engine-contract.v1.json");
const installedTokenCandidateContract = join(installedBundle, "Contents", "Resources", "lekh-token-candidates.v1.json");
const runtimeHealthPath = join(homedir(), "Library", "Application Support", "Lekh Keyboard", "runtime-health.v1.json");
const registerScript = join(root, "native", "macos-imk", "skeleton", "register-dev.swift");
const restoreSourceScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.swift");
const restoreScript = join(root, "native", "macos-imk", "skeleton", "restore-system-keyboard.sh");
const reportPath = join(root, "reports", "macos-imk-dev-install-check.json");
const inputSourceId = "com.lekh.inputmethod.LekhKeyboard.Main";
const parentInputSourceId = "com.lekh.inputmethod.LekhKeyboard";
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const failures = [];
const expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection";
const expectedBundleIdentifier = "com.lekh.inputmethod.LekhKeyboard";
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

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function plistValue(key) {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plistPath],
    { encoding: "utf8" }
  );
  return result.status === 0 ? result.stdout.trim() : "";
}

function inputMethodPids() {
  const result = spawnSync("pgrep", ["-x", "LekhInputMethodApp"], { encoding: "utf8" });
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
}

function runtimeHealthRecord() {
  if (!existsSync(runtimeHealthPath)) return { record: null, readError: "missing" };
  try {
    return { record: JSON.parse(readFileSync(runtimeHealthPath, "utf8")), readError: null };
  } catch (error) {
    return { record: null, readError: error instanceof Error ? error.message : String(error) };
  }
}

function runtimeHealthIssues(record, installedBundleVersion, pidsBeforeActivation, activationStartedAtMs) {
  const issues = [];
  if (!record || typeof record !== "object") return ["runtime health record is missing or unreadable"];
  if (record.schemaVersion !== 1) issues.push(`schemaVersion=${JSON.stringify(record.schemaVersion)}`);
  if (record.bundleIdentifier !== expectedBundleIdentifier) {
    issues.push(`bundleIdentifier=${JSON.stringify(record.bundleIdentifier)}`);
  }
  if (record.bundleVersion !== installedBundleVersion) {
    issues.push(`bundleVersion=${JSON.stringify(record.bundleVersion)}`);
  }
  if (record.connectionName !== expectedConnectionName) {
    issues.push(`connectionName=${JSON.stringify(record.connectionName)}`);
  }
  if (!Number.isInteger(record.processIdentifier) || !inputMethodPids().includes(record.processIdentifier)) {
    issues.push(`processIdentifier=${JSON.stringify(record.processIdentifier)} is not a live LekhInputMethodApp`);
  }
  for (const field of ["executableStartedAt", "serverStartedAt", "controllerInitializedAt", "controllerActivatedAt"]) {
    if (typeof record[field] !== "string" || !Number.isFinite(Date.parse(record[field]))) {
      issues.push(`${field}=missing-or-invalid`);
    }
  }
  if (
    pidsBeforeActivation.length === 0 &&
    typeof record.serverStartedAt === "string" &&
    Number.isFinite(Date.parse(record.serverStartedAt)) &&
    Date.parse(record.serverStartedAt) < activationStartedAtMs - 2_000
  ) {
    issues.push("serverStartedAt predates this TIS activation attempt");
  }
  if (existsSync(runtimeHealthPath)) {
    const healthStat = statSync(runtimeHealthPath);
    if ((healthStat.mode & 0o777) !== 0o600) issues.push("runtime health permissions are not 0600");
    if (typeof process.getuid === "function" && healthStat.uid !== process.getuid()) {
      issues.push("runtime health file is not owned by the current user");
    }
  }
  return issues;
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
if (!existsSync(installedEngineContract)) failures.push("Installed input method engine contract is missing.");
if (!existsSync(installedTokenCandidateContract)) failures.push("Installed input method shared token-candidate contract is missing.");
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
    "NSApplication",
    "tsInputMethodIconFileKey",
    "tsInputMethodCharacterRepertoireKey",
    "ComponentInputModeDict",
    "tsInputModeListKey",
    "com.lekh.inputmethod.LekhKeyboard.Main",
    "tsVisibleInputModeOrderedArrayKey",
    "Latn",
    "Deva"
  ]) {
    if (!plist.includes(marker)) failures.push(`Installed Info.plist missing ${marker}.`);
  }
  const connectionName = spawnSync(
    "/usr/bin/plutil",
    ["-extract", "InputMethodConnectionName", "raw", "-o", "-", plistPath],
    { encoding: "utf8" }
  );
  if (connectionName.status !== 0 || connectionName.stdout.trim() !== expectedConnectionName) {
    failures.push(`Installed InputMethodConnectionName must equal ${expectedConnectionName} exactly.`);
  }
}

if (failures.length > 0) fail();

function runRegistryCheck() {
  return spawnSync(
    "swift",
    [
      "-e",
      `
import Carbon
import Foundation

func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
  TISGetInputSourceProperty(source, key)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}

func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
  guard let pointer = TISGetInputSourceProperty(source, key) else { return false }
  return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(pointer).takeUnretainedValue())
}

func summarize(_ inputSourceID: String, prefix: String) {
  let query = [kTISPropertyInputSourceID as String: inputSourceID] as CFDictionary
  var discoverable = 0
  var enabled = 0
  var selectable = 0
  var types: [String] = []
  if let unmanagedList = TISCreateInputSourceList(query, true) {
    let list = unmanagedList.takeRetainedValue() as NSArray
    for item in list {
      let source = item as! TISInputSource
      guard stringProperty(source, kTISPropertyInputSourceID) == inputSourceID else { continue }
      discoverable += 1
      if boolProperty(source, kTISPropertyInputSourceIsEnabled) { enabled += 1 }
      if boolProperty(source, kTISPropertyInputSourceIsSelectCapable) { selectable += 1 }
      types.append(stringProperty(source, kTISPropertyInputSourceType))
    }
  }
  print("\\(prefix)Discoverable=\\(discoverable)")
  print("\\(prefix)Enabled=\\(enabled)")
  print("\\(prefix)Selectable=\\(selectable)")
  print("\\(prefix)Types=\\(types.sorted().joined(separator: ","))")
}

summarize("${inputSourceId}", prefix: "child")
summarize("${parentInputSourceId}", prefix: "parent")
let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
print("current=\\(stringProperty(current, kTISPropertyInputSourceID))")
`
    ],
    { encoding: "utf8", env: toolchainEnv }
  );
}

function registryValue(stdout, key) {
  return stdout.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

function registryIsExact(stdout) {
  return registryValue(stdout, "childDiscoverable") === "1" &&
    registryValue(stdout, "childEnabled") === "1" &&
    registryValue(stdout, "childSelectable") === "1" &&
    registryValue(stdout, "childTypes") === "TISTypeKeyboardInputMode" &&
    registryValue(stdout, "parentDiscoverable") === "1" &&
    registryValue(stdout, "parentEnabled") === "1" &&
    registryValue(stdout, "parentSelectable") === "0" &&
    registryValue(stdout, "parentTypes") === "TISTypeKeyboardInputMethodModeEnabled";
}

let registryCheck = runRegistryCheck();

for (
  let attempt = 0;
  attempt < 20 &&
  registryCheck.status === 0 &&
  !registryIsExact(registryCheck.stdout);
  attempt += 1
) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  registryCheck = runRegistryCheck();
}

if (registryCheck.status !== 0) {
  fail({ step: "registry", reason: "Swift Text Input Source registry check failed.", stdout: registryCheck.stdout, stderr: registryCheck.stderr });
}

if (registryValue(registryCheck.stdout, "childDiscoverable") !== "1") {
  failures.push("TIS must expose exactly one .Main transport source; stale or missing registrations are not acceptable.");
}
if (registryValue(registryCheck.stdout, "childEnabled") !== "1") {
  failures.push("Exactly one .Main transport source must be enabled in TIS.");
}
if (registryValue(registryCheck.stdout, "childSelectable") !== "1") {
  failures.push("Exactly one .Main transport source must be select-capable in TIS.");
}
if (registryValue(registryCheck.stdout, "childTypes") !== "TISTypeKeyboardInputMode") {
  failures.push("The .Main TIS source must have type TISTypeKeyboardInputMode.");
}
if (registryValue(registryCheck.stdout, "parentDiscoverable") !== "1") {
  failures.push("TIS must expose exactly one mode-enabled Lekh parent source.");
}
if (registryValue(registryCheck.stdout, "parentEnabled") !== "1") {
  failures.push("The one mode-enabled Lekh parent source must be enabled.");
}
if (registryValue(registryCheck.stdout, "parentSelectable") !== "0") {
  failures.push("The mode-enabled Lekh parent must not be directly select-capable.");
}
if (registryValue(registryCheck.stdout, "parentTypes") !== "TISTypeKeyboardInputMethodModeEnabled") {
  failures.push("The Lekh parent TIS source must have type TISTypeKeyboardInputMethodModeEnabled.");
}

if ([inputSourceId, parentInputSourceId].includes(registryValue(registryCheck.stdout, "current"))) {
  failures.push("Dev installer left Lekh selected as the current input source; this is unsafe until host-app typing is proven.");
}

const launchServices = spawnSync(lsregister, ["-dump"], {
  encoding: "utf8",
  maxBuffer: 80 * 1024 * 1024
});
const staleRegisteredPaths = new Set(
  launchServices.status === 0
    ? [...launchServices.stdout.matchAll(/^path:\s+(.+)$/gm)].map((match) => match[1].trim())
    : []
);
const staleBackupRegisteredPaths = [...staleRegisteredPaths].filter((path) =>
  path.includes("/Library/Application Support/Lekh Keyboard/InstallBackups/Lekh Keyboard.app.backup.")
);
if (
  staleRegisteredPaths.has(stagedPackageArtifact) ||
  staleRegisteredPaths.has(packageArtifact) ||
  staleRegisteredPaths.has(oldPackageArtifact) ||
  staleRegisteredPaths.has(legacyPackageArtifact)
) {
  failures.push("LaunchServices still has a packaged IMK artifact registered. Re-run npm run package:macos:imk:dev && native/macos-imk/skeleton/install-dev.sh so only ~/Library/Input Methods is authoritative.");
}
if (staleBackupRegisteredPaths.length > 0) {
  failures.push(`LaunchServices still has rollback backup IMK bundles registered, which can make macOS launch stale Lekh builds: ${staleBackupRegisteredPaths.join(", ")}`);
}

if (failures.length > 0) fail({ registryStdout: registryCheck.stdout, registryStderr: registryCheck.stderr });

const installedBundleVersion = plistValue("CFBundleVersion");
if (!installedBundleVersion) failures.push("Installed bundle has no CFBundleVersion for runtime-health matching.");

const originalInputSourceId = registryValue(registryCheck.stdout, "current");
const pidsBeforeActivation = inputMethodPids();
const activationStartedAtMs = Date.now();
const logStart = spawnSync("/bin/date", ["+%Y-%m-%d %H:%M:%S"], { encoding: "utf8" }).stdout.trim();
let selectProbe = null;
let restoreProbe = null;
let restoredRegistry = null;
let health = null;
let healthReadError = null;
let healthIssues = ["runtime health was not evaluated"];
let endpointLog = { status: null, stderr: "", rejectionLines: [] };

const snapshot = spawnSync("swift", [restoreSourceScript, "--snapshot"], {
  encoding: "utf8",
  env: toolchainEnv
});
if (snapshot.status !== 0) {
  failures.push("Could not snapshot the current input source before the controlled TIS health probe.");
} else {
  selectProbe = spawnSync("swift", [registerScript, installedBundle, "--select-only"], {
    encoding: "utf8",
    env: toolchainEnv
  });
  if (selectProbe.status !== 0) {
    failures.push("TIS could not select the installed .Main source without re-registering or re-enabling it.");
  } else {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const read = runtimeHealthRecord();
      health = read.record;
      healthReadError = read.readError;
      healthIssues = runtimeHealthIssues(
        health,
        installedBundleVersion,
        pidsBeforeActivation,
        activationStartedAtMs
      );
      if (healthIssues.length === 0) break;
      wait(125);
    }
    if (healthIssues.length > 0) {
      failures.push(
        "The TIS-launched installed build did not publish matching server/controller runtime health; focus a normal editable field and retry."
      );
    }
  }
}

if (logStart) {
  const logProbe = spawnSync(
    "/usr/bin/log",
    [
      "show",
      "--start",
      logStart,
      "--style",
      "compact",
      "--predicate",
      'process == "imklaunchagent" AND subsystem == "com.apple.inputmethodkit" AND category == "Server"'
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const rejectionLines = logProbe.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("Refusing connection name") || line.includes("unrecognized 'InputMethodConnectionName'"));
  endpointLog = { status: logProbe.status, stderr: logProbe.stderr, rejectionLines };
  if (rejectionLines.length > 0) {
    failures.push("imklaunchagent rejected InputMethodConnectionName during the controlled TIS activation.");
  }
}

restoreProbe = spawnSync(restoreScript, [], { encoding: "utf8", env: toolchainEnv });
if (restoreProbe.status !== 0) {
  failures.push("Could not restore the input source that was active before the controlled health probe.");
} else {
  restoredRegistry = runRegistryCheck();
  for (
    let attempt = 0;
    attempt < 20 &&
    restoredRegistry.status === 0 &&
    registryValue(restoredRegistry.stdout, "current") !== originalInputSourceId;
    attempt += 1
  ) {
    wait(150);
    restoredRegistry = runRegistryCheck();
  }
  if (restoredRegistry.status !== 0 || registryValue(restoredRegistry.stdout, "current") !== originalInputSourceId) {
    failures.push("The controlled health probe did not restore the user's exact previous input source.");
  }
  if (restoredRegistry.status === 0 && !registryIsExact(restoredRegistry.stdout)) {
    failures.push("TIS source cardinality or types changed during the controlled activation/restore cycle.");
  }
}

const runtimeHealthEvidence = health && typeof health === "object"
  ? {
      schemaVersion: health.schemaVersion,
      bundleIdentifier: health.bundleIdentifier,
      bundleVersion: health.bundleVersion,
      connectionName: health.connectionName,
      processIdentifier: health.processIdentifier,
      executableStartedAt: health.executableStartedAt,
      serverStartedAt: health.serverStartedAt,
      controllerInitializedAt: health.controllerInitializedAt,
      controllerActivatedAt: health.controllerActivatedAt
    }
  : null;

if (failures.length > 0) {
  fail({
    step: "tis-runtime-health",
    registryStdout: registryCheck.stdout,
    selectStatus: selectProbe?.status ?? null,
    selectStdout: selectProbe?.stdout ?? "",
    selectStderr: selectProbe?.stderr ?? "",
    healthReadError,
    healthIssues,
    runtimeHealth: runtimeHealthEvidence,
    endpointLog,
    restoreStatus: restoreProbe?.status ?? null,
    restoreStdout: restoreProbe?.stdout ?? "",
    restoreStderr: restoreProbe?.stderr ?? "",
    restoredRegistryStdout: restoredRegistry?.stdout ?? ""
  });
}

writeReport("passed", {
  registryStdout: registryCheck.stdout,
  restoredRegistryStdout: restoredRegistry?.stdout ?? "",
  runtimeWasAlreadyRunning: pidsBeforeActivation.length > 0,
  runtimeHealth: runtimeHealthEvidence,
  endpointLog,
  note: "The exact installed TIS sources were selected through TIS, published content-free server/controller health for this build, and restored the user's previous input source without terminating the IMK process."
});
console.log(JSON.stringify({ status: "passed", report: "reports/macos-imk-dev-install-check.json", installedBundle }, null, 2));
