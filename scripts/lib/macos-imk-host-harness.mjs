import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const lekhInputSourceId = "com.lekh.inputmethod.LekhKeyboard.Main";
export const lekhBundleIdentifier = "com.lekh.inputmethod.LekhKeyboard";
export const lekhConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection";

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

export function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function processPids(name) {
  const result = run("pgrep", ["-x", name]);
  return result.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
}

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return {
      status: 2,
      state: "invalid",
      processIdentifier: pid,
      executablePath: "",
      processStartToken: "",
      stderr: "Invalid process identifier."
    };
  }
  const result = run("swift", ["-e", `
import Darwin
import Foundation
let pid = Int32(${pid})
func emit(_ state: String, _ path: String = "", _ startToken: String = "") -> Never {
  let output: [String: Any] = [
    "state": state,
    "processIdentifier": pid,
    "executablePath": path,
    "processStartToken": startToken
  ]
  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  exit(0)
}

if kill(pid, 0) != 0 {
  if errno == ESRCH { emit("absent") }
  emit("probe-failed")
}
var buffer = [CChar](repeating: 0, count: 4096)
let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
var info = proc_bsdinfo()
let expectedInfoSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
let infoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedInfoSize)
if infoSize == expectedInfoSize, info.pbi_status == UInt32(SZOMB) { emit("terminated") }
guard length > 0, infoSize == expectedInfoSize else { emit("probe-failed") }
emit(
  "running",
  String(cString: buffer),
  "\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)"
)
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "null");
  } catch {
    // A malformed probe result is an unknown state, never evidence of absence.
  }
  const validState = ["running", "absent", "terminated", "probe-failed"].includes(parsed?.state);
  const valid = result.status === 0 && validState && parsed?.processIdentifier === pid &&
    typeof parsed?.executablePath === "string" && typeof parsed?.processStartToken === "string";
  if (!valid) {
    return {
      status: result.status || 3,
      state: "probe-failed",
      processIdentifier: pid,
      executablePath: "",
      processStartToken: "",
      stderr: result.stderr || "Process identity probe returned malformed evidence."
    };
  }
  if (parsed.state !== "running") {
    return {
      status: ["absent", "terminated"].includes(parsed.state) ? 0 : 3,
      state: parsed.state,
      processIdentifier: pid,
      executablePath: "",
      processStartToken: "",
      stderr: result.stderr
    };
  }
  let executablePath = parsed.executablePath;
  try {
    if (executablePath && existsSync(executablePath)) executablePath = realpathSync(executablePath);
  } catch {
    return {
      status: 3,
      state: "probe-failed",
      processIdentifier: pid,
      executablePath: "",
      processStartToken: "",
      stderr: "The running process executable could not be canonicalized."
    };
  }
  if (!executablePath || !/^\d{1,20}:\d{1,6}$/u.test(parsed.processStartToken)) {
    return {
      status: 3,
      state: "probe-failed",
      processIdentifier: pid,
      executablePath: "",
      processStartToken: "",
      stderr: "The running process identity was incomplete."
    };
  }
  return {
    status: 0,
    state: "running",
    processIdentifier: pid,
    executablePath,
    processStartToken: parsed.processStartToken,
    stderr: result.stderr
  };
}

export function processExecutablePath(pid) {
  const identity = processIdentity(pid);
  return identity.state === "running" ? identity.executablePath : "";
}

export function exactProcessIdentity(expected) {
  if (!expected || !Number.isInteger(expected.processIdentifier)) {
    return { status: 2, state: "invalid", matches: false, observed: null };
  }
  const observed = processIdentity(expected.processIdentifier);
  return {
    status: observed.status,
    state: observed.state,
    matches: observed.state === "running" &&
      observed.executablePath === expected.executablePath &&
      observed.processStartToken === expected.processStartToken,
    observed
  };
}

export function signalExactProcess(expected, signal) {
  if (
    !expected ||
    !Number.isInteger(expected.processIdentifier) ||
    expected.processIdentifier <= 1 ||
    typeof expected.executablePath !== "string" ||
    !expected.executablePath ||
    !/^\d{1,20}:\d{1,6}$/u.test(expected.processStartToken ?? "") ||
    !["TERM", "KILL"].includes(signal)
  ) {
    return { status: 2, disposition: "invalid", signalSent: false };
  }
  const expectedPathBase64 = Buffer.from(expected.executablePath, "utf8").toString("base64");
  const expectedStartToken = expected.processStartToken;
  const signalNumber = signal === "TERM" ? 15 : 9;
  const result = run("swift", ["-e", `
import Darwin
import Foundation

let pid = Int32(${expected.processIdentifier})
let expectedPath = String(
  data: Data(base64Encoded: ${JSON.stringify(expectedPathBase64)})!,
  encoding: .utf8
)!
let expectedStartToken = ${JSON.stringify(expectedStartToken)}

func emit(_ disposition: String, _ signalSent: Bool) -> Never {
  let output: [String: Any] = [
    "disposition": disposition,
    "processIdentifier": pid,
    "signalSent": signalSent
  ]
  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
  exit(0)
}

if kill(pid, 0) != 0 {
  if errno == ESRCH { emit("absent", false) }
  emit("probe-failed", false)
}
var buffer = [CChar](repeating: 0, count: 4096)
let pathLength = proc_pidpath(pid, &buffer, UInt32(buffer.count))
var info = proc_bsdinfo()
let expectedInfoSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
let infoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedInfoSize)
if infoSize == expectedInfoSize, info.pbi_status == UInt32(SZOMB) { emit("absent", false) }
guard pathLength > 0, infoSize == expectedInfoSize else { emit("probe-failed", false) }
let observedPath = String(cString: buffer)
let observedStartToken = "\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)"
guard observedPath == expectedPath, observedStartToken == expectedStartToken else {
  emit("identity-mismatch", false)
}
if kill(pid, ${signalNumber}) == 0 { emit("signaled", true) }
if errno == ESRCH { emit("absent", false) }
emit("signal-failed", false)
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "null");
  } catch {
    // A malformed signal helper result is a failure, never permission to retry broadly.
  }
  const dispositions = new Set([
    "absent", "probe-failed", "identity-mismatch", "signaled", "signal-failed"
  ]);
  const valid = result.status === 0 &&
    dispositions.has(parsed?.disposition) &&
    parsed?.processIdentifier === expected.processIdentifier &&
    typeof parsed?.signalSent === "boolean";
  if (!valid) return { status: result.status || 3, disposition: "probe-failed", signalSent: false };
  const successful = parsed.disposition === "absent" ||
    parsed.disposition === "identity-mismatch" ||
    parsed.disposition === "signaled";
  return {
    status: successful ? 0 : 3,
    disposition: parsed.disposition,
    signalSent: parsed.signalSent
  };
}

export function terminateExactProcess(expected, {
  termTimeoutMs = 3_000,
  killTimeoutMs = 1_000,
  pollIntervalMs = 100
} = {}) {
  const initial = exactProcessIdentity(expected);
  if (["absent", "terminated"].includes(initial.state) || (initial.state === "running" && initial.matches === false)) {
    return {
      status: 0,
      terminated: true,
      disposition: ["absent", "terminated"].includes(initial.state)
        ? "already-absent"
        : "original-process-replaced"
    };
  }
  if (initial.status !== 0 || !initial.matches) {
    return { status: 3, terminated: false, disposition: "identity-probe-failed" };
  }
  const term = signalExactProcess(expected, "TERM");
  if (term.status !== 0) {
    return { status: 3, terminated: false, disposition: `term-${term.disposition}` };
  }
  if (term.disposition !== "signaled") {
    return { status: 0, terminated: true, disposition: term.disposition };
  }

  const observeUntil = (deadline) => {
    let lastProbeFailed = false;
    while (Date.now() < deadline) {
      const observed = exactProcessIdentity(expected);
      if (["absent", "terminated"].includes(observed.state) || (observed.state === "running" && observed.matches === false)) {
        return { complete: true, failed: false };
      }
      lastProbeFailed = observed.status !== 0 || !observed.matches;
      wait(pollIntervalMs);
    }
    return { complete: false, failed: lastProbeFailed };
  };

  const afterTerm = observeUntil(Date.now() + termTimeoutMs);
  if (afterTerm.complete) return { status: 0, terminated: true, disposition: "terminated-after-term" };
  if (afterTerm.failed) return { status: 3, terminated: false, disposition: "post-term-probe-failed" };

  const kill = signalExactProcess(expected, "KILL");
  if (kill.status !== 0) {
    return { status: 3, terminated: false, disposition: `kill-${kill.disposition}` };
  }
  if (kill.disposition !== "signaled") {
    return { status: 0, terminated: true, disposition: kill.disposition };
  }
  const afterKill = observeUntil(Date.now() + killTimeoutMs);
  if (afterKill.complete) return { status: 0, terminated: true, disposition: "terminated-after-kill" };
  return {
    status: 3,
    terminated: false,
    disposition: afterKill.failed ? "post-kill-probe-failed" : "still-running-after-kill"
  };
}

export function currentInputSource() {
  const result = run("swift", ["-e", `
import Carbon
import Foundation
let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
guard let identifierPointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { exit(2) }
let identifier = Unmanaged<CFString>.fromOpaque(identifierPointer).takeUnretainedValue() as String
func stringProperty(_ key: CFString) -> String? {
  guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
  return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}
func booleanProperty(_ key: CFString) -> Bool? {
  guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
  return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(pointer).takeUnretainedValue())
}
let category = stringProperty(kTISPropertyInputSourceCategory)
let sourceType = stringProperty(kTISPropertyInputSourceType)
let output: [String: Any] = [
  "id": identifier,
  "asciiCapable": booleanProperty(kTISPropertyInputSourceIsASCIICapable) as Any,
  "enabled": booleanProperty(kTISPropertyInputSourceIsEnabled) as Any,
  "category": category as Any,
  "sourceType": sourceType as Any,
  "categoryIsKeyboardInputSource": category == (kTISCategoryKeyboardInputSource as String),
  "typeIsKeyboardLayoutOrInputMode": sourceType == (kTISTypeKeyboardLayout as String) ||
    sourceType == (kTISTypeKeyboardInputMode as String)
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    // The structured failure below prevents callers from trusting partial TIS output.
  }
  return {
    status: result.status === 0 && typeof parsed?.id === "string" && parsed.id.length > 0
      ? 0
      : result.status || 3,
    id: typeof parsed?.id === "string" ? parsed.id : "",
    asciiCapable: typeof parsed?.asciiCapable === "boolean" ? parsed.asciiCapable : null,
    enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : null,
    category: typeof parsed?.category === "string" ? parsed.category : "",
    sourceType: typeof parsed?.sourceType === "string" ? parsed.sourceType : "",
    categoryIsKeyboardInputSource: parsed?.categoryIsKeyboardInputSource === true,
    typeIsKeyboardLayoutOrInputMode: parsed?.typeIsKeyboardLayoutOrInputMode === true,
    stderr: result.stderr
  };
}

export function currentConsoleSessionState() {
  const result = run("swift", ["-e", `
import ApplicationServices
import CoreGraphics
import Foundation

guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
  exit(2)
}
let output: [String: Any] = [
  "loginDone": session["kCGSessionLoginDoneKey"] as? Bool ?? false,
  "onConsole": session["kCGSSessionOnConsoleKey"] as? Bool ?? false,
  "screenLocked": session["CGSSessionScreenIsLocked"] as? Bool ?? false,
  "screenLockedAt": session["CGSSessionScreenLockedTime"] as? Double ?? 0
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  try {
    const state = JSON.parse(line);
    return {
      status: result.status,
      loginDone: state.loginDone === true,
      onConsole: state.onConsole === true,
      screenLocked: state.screenLocked === true,
      screenLockedAt: Number.isFinite(state.screenLockedAt) ? state.screenLockedAt : 0,
      stderr: result.stderr
    };
  } catch {
    return {
      status: result.status || 3,
      loginDone: false,
      onConsole: false,
      screenLocked: false,
      screenLockedAt: 0,
      stderr: result.stderr || "Could not decode the current console-session state.\n"
    };
  }
}

export function consoleSessionPrecondition() {
  const observed = currentConsoleSessionState();
  const code = observed.status !== 0
    ? "console-session-state-unavailable"
    : !observed.loginDone
      ? "console-login-incomplete"
      : !observed.onConsole
        ? "not-active-console-session"
        : observed.screenLocked
          ? "console-session-locked"
          : null;
  const message = code === "console-session-state-unavailable"
    ? "macOS console-session state could not be read."
    : code === "console-login-incomplete"
      ? "The macOS desktop login is not complete."
      : code === "not-active-console-session"
        ? "The invoking session is not the active macOS console session."
        : code === "console-session-locked"
          ? "The macOS console session is locked."
          : "The active macOS console session is ready.";
  return {
    eligible: code === null,
    code,
    message,
    required: { loginDone: true, onConsole: true, screenLocked: false },
    observed
  };
}

export function restoreExactInputSource(inputSourceId) {
  if (typeof inputSourceId !== "string" || inputSourceId.length === 0) {
    return { status: 2, stdout: "", stderr: "The prior input source id is empty.\n", restoredId: "" };
  }
  const sourceIdLiteral = JSON.stringify(inputSourceId);
  const result = run("swift", ["-e", `
import Carbon
import Foundation
let expected = ${sourceIdLiteral}
let query = [kTISPropertyInputSourceID as String: expected] as CFDictionary
func sourceID(_ source: TISInputSource) -> String {
  TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
    .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
}
guard let unmanaged = TISCreateInputSourceList(query, true) else { exit(2) }
let sources = unmanaged.takeRetainedValue() as NSArray
guard let source = sources.map({ $0 as! TISInputSource }).first(where: { sourceID($0) == expected }) else { exit(3) }
guard TISSelectInputSource(source) == noErr else { exit(4) }
for _ in 0..<30 {
  let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  if sourceID(current) == expected {
    print(expected)
    exit(0)
  }
  Thread.sleep(forTimeInterval: 0.1)
}
exit(5)
`]);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    restoredId: result.stdout.trim()
  };
}

export function installedBundleIdentity(appBundle) {
  const plist = join(appBundle, "Contents", "Info.plist");
  const executable = join(appBundle, "Contents", "MacOS", "LekhInputMethodApp");
  const plistValue = (key) => run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).stdout.trim();
  const executablePath = existsSync(executable) ? realpathSync(executable) : executable;
  const digest = run("/usr/bin/shasum", ["-a", "256", executablePath]).stdout.trim().split(/\s+/)[0] ?? "";
  const signature = run("/usr/bin/codesign", ["-dvvv", executablePath]);
  return {
    bundlePath: existsSync(appBundle) ? realpathSync(appBundle) : appBundle,
    executablePath,
    bundleIdentifier: plistValue("CFBundleIdentifier"),
    shortVersion: plistValue("CFBundleShortVersionString"),
    buildVersion: plistValue("CFBundleVersion"),
    connectionName: plistValue("InputMethodConnectionName"),
    executableSha256: digest,
    codeDirectoryHash: /CDHash=([^\s]+)/.exec(signature.stderr)?.[1] ?? "",
    architecture: run("/usr/bin/uname", ["-m"]).stdout.trim(),
    macOS: run("/usr/bin/sw_vers", ["-productVersion"]).stdout.trim()
  };
}

export function readRuntimeHealth(runtimeHealthPath) {
  if (!existsSync(runtimeHealthPath)) return { record: null, readError: "missing" };
  try {
    return {
      record: JSON.parse(readFileSync(runtimeHealthPath, "utf8")),
      readError: null,
      mtimeMs: statSync(runtimeHealthPath).mtimeMs
    };
  } catch (error) {
    return { record: null, readError: error instanceof Error ? error.message : String(error) };
  }
}

export function exactRuntimeHealthIssues({
  record,
  runtimeHealthPath,
  bundleIdentity,
  activatedAfterMs,
  previousActivation = null,
  previousActivationIdentifier = null,
  previousHealthMtimeMs = null,
  healthMtimeMs = null
}) {
  const issues = [];
  if (!record || typeof record !== "object") return ["runtime health record is missing or unreadable"];
  if (record.schemaVersion !== 1) issues.push(`schemaVersion=${JSON.stringify(record.schemaVersion)}`);
  if (record.bundleIdentifier !== bundleIdentity.bundleIdentifier || record.bundleIdentifier !== lekhBundleIdentifier) {
    issues.push(`bundleIdentifier=${JSON.stringify(record.bundleIdentifier)}`);
  }
  if (record.bundleVersion !== bundleIdentity.buildVersion) {
    issues.push(`bundleVersion=${JSON.stringify(record.bundleVersion)}`);
  }
  if (record.connectionName !== bundleIdentity.connectionName || record.connectionName !== lekhConnectionName) {
    issues.push(`connectionName=${JSON.stringify(record.connectionName)}`);
  }
  if (!Number.isInteger(record.processIdentifier) || !processPids("LekhInputMethodApp").includes(record.processIdentifier)) {
    issues.push(`processIdentifier=${JSON.stringify(record.processIdentifier)} is not a live LekhInputMethodApp`);
  }
  for (const field of ["executableStartedAt", "serverStartedAt", "controllerInitializedAt", "controllerActivatedAt"]) {
    if (typeof record[field] !== "string" || !Number.isFinite(Date.parse(record[field]))) {
      issues.push(`${field}=missing-or-invalid`);
    }
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const field of ["controllerInstanceIdentifier", "activationIdentifier"]) {
    if (typeof record[field] !== "string" || !uuidPattern.test(record[field])) {
      issues.push(`${field}=missing-or-invalid`);
    }
  }
  if (typeof record.controllerIsActive !== "boolean") {
    issues.push("controllerIsActive=missing-or-invalid");
  }
  const executableStartedAt = Date.parse(record.executableStartedAt);
  const serverStartedAt = Date.parse(record.serverStartedAt);
  const controllerInitializedAt = Date.parse(record.controllerInitializedAt);
  const activatedAt = Date.parse(record.controllerActivatedAt);
  const deactivatedAt = Date.parse(record.controllerDeactivatedAt);
  if (
    [executableStartedAt, serverStartedAt, controllerInitializedAt, activatedAt].every(Number.isFinite) &&
    !(
      executableStartedAt <= serverStartedAt &&
      executableStartedAt <= controllerInitializedAt &&
      controllerInitializedAt <= activatedAt
    )
  ) {
    issues.push("runtime lifecycle timestamps are not causally ordered");
  }
  if (record.controllerIsActive === true && record.controllerDeactivatedAt != null) {
    issues.push("active controller unexpectedly has controllerDeactivatedAt");
  }
  if (
    record.controllerIsActive === false &&
    (!Number.isFinite(deactivatedAt) || !Number.isFinite(activatedAt) || deactivatedAt < activatedAt)
  ) {
    issues.push("deactivated controller has no causally ordered controllerDeactivatedAt");
  }
  if (Number.isFinite(activatedAfterMs) && Number.isFinite(activatedAt) && activatedAt < activatedAfterMs - 2_000) {
    issues.push("controllerActivatedAt predates the fresh TextEdit input context");
  }
  if (Number.isFinite(previousHealthMtimeMs) && Number.isFinite(healthMtimeMs) && healthMtimeMs <= previousHealthMtimeMs) {
    issues.push("runtime health file was not rewritten for the fresh TextEdit input context");
  } else if (
    typeof previousActivation === "string" &&
    previousActivation.length > 0 &&
    record.controllerActivatedAt === previousActivation &&
    !Number.isFinite(healthMtimeMs)
  ) {
    issues.push("controllerActivatedAt did not change for the fresh TextEdit input context");
  }
  if (
    typeof previousActivationIdentifier === "string" &&
    previousActivationIdentifier.length > 0 &&
    record.activationIdentifier === previousActivationIdentifier
  ) {
    issues.push("activationIdentifier did not change for the fresh TextEdit input context");
  }
  if (existsSync(runtimeHealthPath)) {
    const healthStat = statSync(runtimeHealthPath);
    if ((healthStat.mode & 0o777) !== 0o600) issues.push("runtime health permissions are not 0600");
    if (typeof process.getuid === "function" && healthStat.uid !== process.getuid()) {
      issues.push("runtime health file is not owned by the current user");
    }
  }
  if (issues.length === 0) {
    const runningExecutable = processExecutablePath(record.processIdentifier);
    if (runningExecutable !== bundleIdentity.executablePath) {
      issues.push(`running executable is ${JSON.stringify(runningExecutable)}, not the installed bundle executable`);
    } else {
      const runningSha256 = run("/usr/bin/shasum", ["-a", "256", runningExecutable]).stdout.trim().split(/\s+/)[0] ?? "";
      if (!runningSha256 || runningSha256 !== bundleIdentity.executableSha256) {
        issues.push("running executable SHA-256 does not match the installed bundle");
      }
    }
  }
  return issues;
}

export function waitForExactRuntimeHealth({
  runtimeHealthPath,
  bundleIdentity,
  activatedAfterMs,
  previousActivation = null,
  previousActivationIdentifier = null,
  previousHealthMtimeMs = null,
  timeoutMs = 15_000
}) {
  const deadline = Date.now() + timeoutMs;
  let latest = { record: null, readError: "not-read", issues: ["runtime health was not evaluated"] };
  while (Date.now() < deadline) {
    const read = readRuntimeHealth(runtimeHealthPath);
    const issues = exactRuntimeHealthIssues({
      record: read.record,
      runtimeHealthPath,
      bundleIdentity,
      activatedAfterMs,
      previousActivation,
      previousActivationIdentifier,
      previousHealthMtimeMs,
      healthMtimeMs: read.mtimeMs
    });
    latest = { ...read, issues };
    if (issues.length === 0) return { ...latest, verified: true };
    wait(125);
  }
  return { ...latest, verified: false };
}

export function launchColdTextEdit(realDocumentPath, { timeoutMs = 8_000 } = {}) {
  const priorPids = processPids("TextEdit");
  const priorPidSet = new Set(priorPids);
  const launchedAtMs = Date.now();
  const launch = run("/usr/bin/open", ["-F", "-n", "-a", "TextEdit", realDocumentPath]);
  if (launch.status !== 0) {
    return { status: launch.status, pid: null, priorPids, launchedAtMs, stdout: launch.stdout, stderr: launch.stderr };
  }
  const deadline = Date.now() + timeoutMs;
  const observedNewPids = new Set();
  while (Date.now() < deadline) {
    for (const pid of processPids("TextEdit")) {
      if (priorPidSet.has(pid)) continue;
      observedNewPids.add(pid);
      const identity = processIdentity(pid);
      if (
        identity.status === 0 &&
        identity.state === "running" &&
        identity.executablePath.endsWith("/TextEdit.app/Contents/MacOS/TextEdit")
      ) {
        return {
          status: 0,
          pid,
          priorPids,
          observedNewPids: [...observedNewPids],
          launchedAtMs,
          executablePath: identity.executablePath,
          processStartToken: identity.processStartToken,
          stdout: launch.stdout,
          stderr: launch.stderr,
          launchArguments: ["-F", "-n", "-a", "TextEdit", realDocumentPath]
        };
      }
    }
    wait(100);
  }
  return {
    status: 3,
    pid: null,
    priorPids,
    observedNewPids: [...observedNewPids],
    launchedAtMs,
    stdout: launch.stdout,
    stderr: launch.stderr || "No fresh TextEdit PID appeared."
  };
}

export function prepareExactTextEdit(pid, realDocumentPath, text) {
  return textEditAccessibilityOperation(pid, realDocumentPath, text);
}

export function readExactTextEdit(pid, realDocumentPath) {
  return textEditAccessibilityOperation(pid, realDocumentPath, null);
}

function textEditAccessibilityOperation(pid, realDocumentPath, replacementText) {
  if (!Number.isInteger(pid)) return { status: 2, snapshot: null, stderr: "Missing TextEdit PID." };
  const expectedPathLiteral = JSON.stringify(realDocumentPath);
  const replacementBase64 = replacementText === null
    ? ""
    : Buffer.from(replacementText, "utf8").toString("base64");
  const replacementLiteral = JSON.stringify(replacementBase64);
  const shouldReplace = replacementText !== null ? "true" : "false";
  const result = run("swift", ["-e", `
import AppKit
import ApplicationServices
import Foundation

let targetPid = pid_t(${pid})
let expectedPath = ${expectedPathLiteral}
let shouldReplace = ${shouldReplace}
let replacementBase64 = ${replacementLiteral}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  attribute(element, name) as? String ?? ""
}

func canonicalDocumentPath(_ raw: String) -> String {
  let url: URL
  if raw.hasPrefix("file:"), let fileURL = URL(string: raw) {
    url = fileURL
  } else {
    url = URL(fileURLWithPath: raw)
  }
  return url.standardizedFileURL.resolvingSymlinksInPath().path
}

let canonicalExpectedPath = canonicalDocumentPath(expectedPath)

func textArea(in element: AXUIElement, depth: Int = 0) -> AXUIElement? {
  guard depth < 12 else { return nil }
  if stringAttribute(element, kAXRoleAttribute as CFString) == (kAXTextAreaRole as String) {
    return element
  }
  let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
  for child in children {
    if let match = textArea(in: child, depth: depth + 1) { return match }
  }
  return nil
}

let app = AXUIElementCreateApplication(targetPid)
if let running = NSRunningApplication(processIdentifier: targetPid) {
  _ = running.activate(options: [.activateAllWindows])
}
_ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
Thread.sleep(forTimeInterval: 0.15)

let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
var documents: [String] = []
var exactWindows: [AXUIElement] = []
for window in windows {
  let raw = stringAttribute(window, kAXDocumentAttribute as CFString)
  guard !raw.isEmpty else { continue }
  let path = canonicalDocumentPath(raw)
  documents.append(path)
  if path == canonicalExpectedPath { exactWindows.append(window) }
}

var textValue: String? = nil
var operationStatus = "document-not-found"
if exactWindows.count == 1, documents.count == 1, let window = exactWindows.first {
  _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  if let editor = textArea(in: window) {
    _ = AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if shouldReplace,
       let replacementData = Data(base64Encoded: replacementBase64),
       let replacement = String(data: replacementData, encoding: .utf8) {
      let setStatus = AXUIElementSetAttributeValue(editor, kAXValueAttribute as CFString, replacement as CFString)
      var selectedRange = CFRange(location: (replacement as NSString).length, length: 0)
      if let rangeValue = AXValueCreate(.cfRange, &selectedRange) {
        _ = AXUIElementSetAttributeValue(editor, kAXSelectedTextRangeAttribute as CFString, rangeValue)
      }
      operationStatus = setStatus == .success ? "prepared" : "set-value-failed-\(setStatus.rawValue)"
    } else {
      operationStatus = "read"
    }
    textValue = attribute(editor, kAXValueAttribute as CFString) as? String
  } else {
    operationStatus = "text-area-not-found"
  }
} else if exactWindows.count > 1 || documents.count > 1 {
  operationStatus = "unexpected-documents"
}

let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
let textBase64 = textValue?.data(using: .utf8)?.base64EncodedString() ?? ""
let output: [String: Any] = [
  "targetPid": targetPid,
  "frontmostPid": frontmostPid,
  "windowCount": windows.count,
  "documents": documents,
  "exactDocumentCount": exactWindows.count,
  "operationStatus": operationStatus,
  "textBase64": textBase64
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  let line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let snapshot = (() => {
    try {
      const parsed = JSON.parse(line);
      return {
        ...parsed,
        text: parsed.textBase64 ? Buffer.from(parsed.textBase64, "base64").toString("utf8") : ""
      };
    } catch {
      return null;
    }
  })();
  const expectedStatus = replacementText === null ? "read" : "prepared";
  const valid = result.status === 0 &&
    snapshot?.targetPid === pid &&
    snapshot?.frontmostPid === pid &&
    snapshot?.exactDocumentCount === 1 &&
    snapshot?.documents?.length === 1 &&
    snapshot?.operationStatus === expectedStatus;
  return {
    status: valid ? 0 : result.status || 3,
    snapshot,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export function terminateColdTextEdit(identity) {
  if (!identity) return { status: 0, terminated: false, note: "No probe process was launched." };
  if (
    !Number.isInteger(identity.pid) ||
    typeof identity.executablePath !== "string" ||
    !identity.executablePath.endsWith("/TextEdit.app/Contents/MacOS/TextEdit") ||
    !/^\d{1,20}:\d{1,6}$/u.test(identity.processStartToken ?? "")
  ) {
    return { status: 2, terminated: false, note: "The cold TextEdit process identity is incomplete." };
  }
  const termination = terminateExactProcess({
    processIdentifier: identity.pid,
    executablePath: identity.executablePath,
    processStartToken: identity.processStartToken
  });
  return {
    status: termination.status,
    terminated: termination.terminated,
    note: termination.terminated
      ? "Only the exact fresh TextEdit process instance was terminated."
      : `The exact fresh TextEdit process was retained: ${termination.disposition}.`
  };
}

export function removeProbeFile(path) {
  rmSync(path, { force: true });
}

/**
 * Returns the GUI-automation grants of the exact helper process used by the
 * host probes. Event-listening access is informational: secure-field probes
 * synthesize targeted events but deliberately never install an event tap.
 */
export function automationPermissionPrecondition() {
  const result = run("swift", ["-e", `
import ApplicationServices
import CoreGraphics
import Foundation

let output: [String: Any] = [
  "accessibilityTrusted": AXIsProcessTrusted(),
  "eventPostAccess": CGPreflightPostEventAccess(),
  "eventListenAccess": CGPreflightListenEventAccess()
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  try {
    const observed = JSON.parse(line);
    return {
      status: result.status,
      eligible: result.status === 0 &&
        observed.accessibilityTrusted === true &&
        observed.eventPostAccess === true,
      accessibilityTrusted: observed.accessibilityTrusted === true,
      eventPostAccess: observed.eventPostAccess === true,
      eventListenAccess: observed.eventListenAccess === true,
      eventListenAccessRequired: false,
      stderr: result.stderr
    };
  } catch {
    return {
      status: result.status || 3,
      eligible: false,
      accessibilityTrusted: false,
      eventPostAccess: false,
      eventListenAccess: false,
      eventListenAccessRequired: false,
      stderr: result.stderr || "Could not decode GUI-automation permission state.\n"
    };
  }
}

/**
 * Secure Event Input is global macOS state. Callers must prove a causal
 * false -> true -> false transition; this helper never enables or disables it.
 */
export function secureEventInputState() {
  const result = run("swift", ["-e", `
import Carbon
import Foundation
let output: [String: Any] = ["enabled": IsSecureEventInputEnabled()]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  try {
    const parsed = JSON.parse(line);
    return { status: result.status, enabled: parsed.enabled === true, stderr: result.stderr };
  } catch {
    return {
      status: result.status || 3,
      enabled: null,
      stderr: result.stderr || "Could not decode Secure Event Input state.\n"
    };
  }
}

const preferenceEvidenceSchema = "lekh.cfpreferences.current-user-any-host.v1";
const preferenceScope = "current-user-any-host";
const propertyListTypes = new Set(["array", "boolean", "data", "date", "dictionary", "number", "string"]);

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return isPlainRecord(value) &&
    Object.keys(value).sort().join("\0") === [...expectedKeys].sort().join("\0");
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function preferenceRequest(domain, key) {
  if (typeof domain !== "string" || domain.length === 0 || typeof key !== "string" || key.length === 0) return null;
  return {
    domainBase64: JSON.stringify(Buffer.from(domain, "utf8").toString("base64")),
    keyBase64: JSON.stringify(Buffer.from(key, "utf8").toString("base64"))
  };
}

function preferenceFailure(result, message, extra = {}) {
  return {
    status: Number.isInteger(result?.status) && result.status !== 0 ? result.status : 3,
    ...extra,
    stderr: typeof result?.stderr === "string" && result.stderr.length > 0 ? result.stderr : `${message}\n`
  };
}

const exactPropertyListEqualitySwift = `
func propertyListTypeName(_ value: Any) -> String {
  let type = CFGetTypeID(value as CFTypeRef)
  if type == CFArrayGetTypeID() { return "array" }
  if type == CFBooleanGetTypeID() { return "boolean" }
  if type == CFDataGetTypeID() { return "data" }
  if type == CFDateGetTypeID() { return "date" }
  if type == CFDictionaryGetTypeID() { return "dictionary" }
  if type == CFNumberGetTypeID() { return "number" }
  if type == CFStringGetTypeID() { return "string" }
  return "unsupported"
}

func exactPropertyListEqual(_ left: Any, _ right: Any) -> Bool {
  let leftType = CFGetTypeID(left as CFTypeRef)
  guard leftType == CFGetTypeID(right as CFTypeRef) else { return false }
  if leftType == CFArrayGetTypeID() {
    guard let leftArray = left as? [Any], let rightArray = right as? [Any],
          leftArray.count == rightArray.count else { return false }
    return zip(leftArray, rightArray).allSatisfy { exactPropertyListEqual($0, $1) }
  }
  if leftType == CFDictionaryGetTypeID() {
    guard let leftDictionary = left as? [String: Any], let rightDictionary = right as? [String: Any],
          Set(leftDictionary.keys) == Set(rightDictionary.keys) else { return false }
    return leftDictionary.allSatisfy { key, value in
      guard let other = rightDictionary[key] else { return false }
      return exactPropertyListEqual(value, other)
    }
  }
  return CFEqual(left as CFTypeRef, right as CFTypeRef)
}
`;

function validSnapshotSchema(snapshot, domain, key) {
  if (!hasExactKeys(snapshot, [
    "status", "schema", "scope", "domain", "key", "exists",
    "propertyListType", "propertyListBase64", "stderr"
  ])) return false;
  if (
    snapshot.status !== 0 ||
    snapshot.schema !== preferenceEvidenceSchema ||
    snapshot.scope !== preferenceScope ||
    snapshot.domain !== domain ||
    snapshot.key !== key ||
    typeof snapshot.exists !== "boolean" ||
    typeof snapshot.propertyListType !== "string" ||
    typeof snapshot.propertyListBase64 !== "string" ||
    typeof snapshot.stderr !== "string"
  ) return false;
  return snapshot.exists
    ? propertyListTypes.has(snapshot.propertyListType) && canonicalBase64(snapshot.propertyListBase64)
    : snapshot.propertyListType === "absent" && snapshot.propertyListBase64 === "";
}

/**
 * Snapshots exactly the current-user/any-host value as a binary property list.
 * This preserves both its property-list type and whether it was absent. Probe
 * reports must not serialize this opaque snapshot.
 */
export function snapshotPreference(domain, key) {
  const request = preferenceRequest(domain, key);
  if (!request) {
    return preferenceFailure(null, "Preference domain or key is invalid.", {
      schema: preferenceEvidenceSchema,
      scope: preferenceScope,
      domain: typeof domain === "string" ? domain : "",
      key: typeof key === "string" ? key : "",
      exists: false,
      propertyListType: "invalid",
      propertyListBase64: ""
    });
  }
  const result = run("swift", ["-e", `
import CoreFoundation
import Foundation
${exactPropertyListEqualitySwift}
guard let domainData = Data(base64Encoded: ${request.domainBase64}),
      let keyData = Data(base64Encoded: ${request.keyBase64}),
      let domainString = String(data: domainData, encoding: .utf8),
      let keyString = String(data: keyData, encoding: .utf8) else { exit(2) }
let domain = domainString as CFString
let key = keyString as CFString
guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { exit(3) }
var output: [String: Any] = [
  "schema": ${JSON.stringify(preferenceEvidenceSchema)},
  "scope": ${JSON.stringify(preferenceScope)},
  "domain": domainString,
  "key": keyString,
  "exists": false,
  "propertyListType": "absent",
  "propertyListBase64": ""
]
if let value = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) {
  let type = propertyListTypeName(value)
  guard type != "unsupported",
        PropertyListSerialization.propertyList(value, isValidFor: .binary) else { exit(4) }
  let data = try PropertyListSerialization.data(fromPropertyList: value, format: .binary, options: 0)
  output["exists"] = true
  output["propertyListType"] = type
  output["propertyListBase64"] = data.base64EncodedString()
}
let encoded = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: encoded, as: UTF8.self))
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    // Fail closed below on malformed helper output.
  }
  const valid = result.status === 0 && hasExactKeys(parsed, [
    "schema", "scope", "domain", "key", "exists", "propertyListType", "propertyListBase64"
  ]) &&
    parsed.schema === preferenceEvidenceSchema &&
    parsed.scope === preferenceScope &&
    parsed.domain === domain &&
    parsed.key === key &&
    typeof parsed.exists === "boolean" &&
    (parsed.exists
      ? propertyListTypes.has(parsed.propertyListType) && canonicalBase64(parsed.propertyListBase64)
      : parsed.propertyListType === "absent" && parsed.propertyListBase64 === "");
  if (!valid) {
    return preferenceFailure(result, "Could not snapshot the exact current-user/any-host preference.", {
      schema: preferenceEvidenceSchema,
      scope: preferenceScope,
      domain,
      key,
      exists: false,
      propertyListType: "invalid",
      propertyListBase64: ""
    });
  }
  return { status: 0, ...parsed, stderr: result.stderr };
}

/** Writes and verifies a JSON-compatible current-user/any-host property-list value. */
export function writePreference(domain, key, value) {
  const request = preferenceRequest(domain, key);
  let encodedValue = null;
  try {
    encodedValue = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  } catch {
    // The structured invalid-input result below is fail closed.
  }
  if (!request || !encodedValue) {
    return { status: 2, readBackEqual: false, stderr: "Preference request is not a JSON-compatible property list.\n" };
  }
  const result = run("swift", ["-e", `
import CoreFoundation
import Foundation
${exactPropertyListEqualitySwift}
guard let domainData = Data(base64Encoded: ${request.domainBase64}),
      let keyData = Data(base64Encoded: ${request.keyBase64}),
      let valueData = Data(base64Encoded: ${JSON.stringify(encodedValue)}),
      let domainString = String(data: domainData, encoding: .utf8),
      let keyString = String(data: keyData, encoding: .utf8),
      let requested = try? JSONSerialization.jsonObject(with: valueData, options: [.fragmentsAllowed]),
      PropertyListSerialization.propertyList(requested, isValidFor: .binary) else { exit(2) }
let domain = domainString as CFString
let key = keyString as CFString
let requestedType = propertyListTypeName(requested)
guard requestedType != "unsupported" else { exit(2) }
CFPreferencesSetValue(
  key,
  requested as CFPropertyList,
  domain,
  kCFPreferencesCurrentUser,
  kCFPreferencesAnyHost
)
guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { exit(3) }
guard let observed = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { exit(4) }
let readBackEqual = exactPropertyListEqual(requested, observed)
let output: [String: Any] = [
  "schema": ${JSON.stringify(preferenceEvidenceSchema)},
  "scope": ${JSON.stringify(preferenceScope)},
  "domain": domainString,
  "key": keyString,
  "exists": true,
  "propertyListType": propertyListTypeName(observed),
  "readBackEqual": readBackEqual
]
let encoded = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: encoded, as: UTF8.self))
guard readBackEqual else { exit(5) }
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    // Fail closed below on malformed helper output.
  }
  const valid = result.status === 0 && hasExactKeys(parsed, [
    "schema", "scope", "domain", "key", "exists", "propertyListType", "readBackEqual"
  ]) &&
    parsed.schema === preferenceEvidenceSchema &&
    parsed.scope === preferenceScope &&
    parsed.domain === domain &&
    parsed.key === key &&
    parsed.exists === true &&
    propertyListTypes.has(parsed.propertyListType) &&
    parsed.readBackEqual === true;
  if (!valid) return preferenceFailure(result, "Preference write could not be verified.", { readBackEqual: false });
  return { status: 0, ...parsed, stderr: result.stderr };
}

/** Reads an explicitly scoped string-array preference with a strict schema. */
export function readStringArrayPreference(domain, key) {
  const request = preferenceRequest(domain, key);
  if (!request) return { status: 2, exists: false, value: [], stderr: "Preference domain or key is invalid.\n" };
  const result = run("swift", ["-e", `
import CoreFoundation
import Foundation
guard let domainData = Data(base64Encoded: ${request.domainBase64}),
      let keyData = Data(base64Encoded: ${request.keyBase64}),
      let domainString = String(data: domainData, encoding: .utf8),
      let keyString = String(data: keyData, encoding: .utf8) else { exit(2) }
let domain = domainString as CFString
let key = keyString as CFString
guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { exit(3) }
var exists = false
var value: [String] = []
if let observed = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) {
  guard CFGetTypeID(observed) == CFArrayGetTypeID(),
        let items = observed as? [Any],
        items.allSatisfy({ CFGetTypeID($0 as CFTypeRef) == CFStringGetTypeID() }),
        let strings = items as? [String] else { exit(4) }
  exists = true
  value = strings
}
let output: [String: Any] = [
  "schema": ${JSON.stringify(preferenceEvidenceSchema)},
  "scope": ${JSON.stringify(preferenceScope)},
  "domain": domainString,
  "key": keyString,
  "exists": exists,
  "value": value
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    // Fail closed below on malformed helper output.
  }
  const valid = result.status === 0 && hasExactKeys(parsed, ["schema", "scope", "domain", "key", "exists", "value"]) &&
    parsed.schema === preferenceEvidenceSchema &&
    parsed.scope === preferenceScope &&
    parsed.domain === domain &&
    parsed.key === key &&
    typeof parsed.exists === "boolean" &&
    Array.isArray(parsed.value) &&
    parsed.value.every((item) => typeof item === "string") &&
    (parsed.exists || parsed.value.length === 0);
  if (!valid) return preferenceFailure(result, "Could not read the exact string-array preference.", { exists: false, value: [] });
  return { status: 0, ...parsed, stderr: result.stderr };
}

/** Restores and verifies the exact scoped value/type or absence from a snapshot. */
export function restorePreference(domain, key, snapshot) {
  if (!validSnapshotSchema(snapshot, domain, key)) {
    return { status: 2, readBackEqual: false, stderr: "Preference snapshot schema, scope, domain, or key is invalid.\n" };
  }
  const request = preferenceRequest(domain, key);
  const result = run("swift", ["-e", `
import CoreFoundation
import Foundation
${exactPropertyListEqualitySwift}
guard let domainData = Data(base64Encoded: ${request.domainBase64}),
      let keyData = Data(base64Encoded: ${request.keyBase64}),
      let domainString = String(data: domainData, encoding: .utf8),
      let keyString = String(data: keyData, encoding: .utf8) else { exit(2) }
let domain = domainString as CFString
let key = keyString as CFString
let existed = ${snapshot.exists ? "true" : "false"}
let expectedType = ${JSON.stringify(snapshot.propertyListType)}
var restoredValue: Any? = nil
if existed {
  guard let data = Data(base64Encoded: ${JSON.stringify(snapshot.propertyListBase64)}),
        let value = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
        PropertyListSerialization.propertyList(value, isValidFor: .binary),
        propertyListTypeName(value) == expectedType else { exit(2) }
  restoredValue = value
  CFPreferencesSetValue(key, value as CFPropertyList, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
} else {
  guard expectedType == "absent" else { exit(2) }
  CFPreferencesSetValue(key, nil, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
}
guard CFPreferencesSynchronize(domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost) else { exit(3) }
let observed = CFPreferencesCopyValue(key, domain, kCFPreferencesCurrentUser, kCFPreferencesAnyHost)
let readBackEqual: Bool
if let restoredValue {
  readBackEqual = observed.map { exactPropertyListEqual(restoredValue, $0) } ?? false
} else {
  readBackEqual = observed == nil
}
let output: [String: Any] = [
  "schema": ${JSON.stringify(preferenceEvidenceSchema)},
  "scope": ${JSON.stringify(preferenceScope)},
  "domain": domainString,
  "key": keyString,
  "exists": observed != nil,
  "propertyListType": observed.map(propertyListTypeName) ?? "absent",
  "readBackEqual": readBackEqual
]
let encoded = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: encoded, as: UTF8.self))
guard readBackEqual else { exit(5) }
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    // Fail closed below on malformed helper output.
  }
  const valid = result.status === 0 && hasExactKeys(parsed, [
    "schema", "scope", "domain", "key", "exists", "propertyListType", "readBackEqual"
  ]) &&
    parsed.schema === preferenceEvidenceSchema &&
    parsed.scope === preferenceScope &&
    parsed.domain === domain &&
    parsed.key === key &&
    parsed.exists === snapshot.exists &&
    parsed.propertyListType === snapshot.propertyListType &&
    parsed.readBackEqual === true;
  if (!valid) return preferenceFailure(result, "Preference restoration could not be verified.", { readBackEqual: false });
  return { status: 0, ...parsed, stderr: result.stderr };
}

/**
 * Focuses a named accessibility element without asking for AXValue. This is
 * safe for NSSecureTextField because only role/subrole/focus metadata leaves
 * the target process.
 */
export function focusAccessibilityElement(pid, identifier, expectedSubrole = "") {
  if (!Number.isInteger(pid)) return { status: 2, snapshot: null, stderr: "Missing target PID.\n" };
  const identifierLiteral = JSON.stringify(identifier);
  const subroleLiteral = JSON.stringify(expectedSubrole);
  const result = run("swift", ["-e", `
import AppKit
import ApplicationServices
import Foundation

let targetPid = pid_t(${pid})
let expectedIdentifier = ${identifierLiteral}
let expectedSubrole = ${subroleLiteral}

func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
  return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  attribute(element, name) as? String ?? ""
}

func find(_ element: AXUIElement, depth: Int = 0) -> [AXUIElement] {
  guard depth < 14 else { return [] }
  var matches: [AXUIElement] = []
  if stringAttribute(element, kAXIdentifierAttribute as CFString) == expectedIdentifier {
    matches.append(element)
  }
  let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
  for child in children { matches.append(contentsOf: find(child, depth: depth + 1)) }
  return matches
}

let app = AXUIElementCreateApplication(targetPid)
if let running = NSRunningApplication(processIdentifier: targetPid) {
  _ = running.activate(options: [.activateAllWindows])
}
_ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
Thread.sleep(forTimeInterval: 0.12)
let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
let matches = windows.flatMap { find($0) }
var setResult: AXError = .failure
if matches.count == 1, let match = matches.first {
  if let window = windows.first(where: { find($0).contains(where: { CFEqual($0, match) }) }) {
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  }
  setResult = AXUIElementSetAttributeValue(match, kAXFocusedAttribute as CFString, kCFBooleanTrue)
}
Thread.sleep(forTimeInterval: 0.12)
let match = matches.first
let role = match.map { stringAttribute($0, kAXRoleAttribute as CFString) } ?? ""
let subrole = match.map { stringAttribute($0, kAXSubroleAttribute as CFString) } ?? ""
let focused = match.flatMap { attribute($0, kAXFocusedAttribute as CFString) as? Bool } ?? false
let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
let output: [String: Any] = [
  "targetPid": targetPid,
  "frontmostPid": frontmostPid,
  "matchCount": matches.count,
  "role": role,
  "subrole": subrole,
  "focused": focused,
  "setResult": setResult.rawValue,
  "subroleMatches": expectedSubrole.isEmpty || subrole == expectedSubrole
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  let snapshot = null;
  try {
    snapshot = JSON.parse(line);
  } catch {
    // Decoding failure is reported below without exposing any target content.
  }
  const valid = result.status === 0 &&
    snapshot?.targetPid === pid &&
    snapshot?.frontmostPid === pid &&
    snapshot?.matchCount === 1 &&
    snapshot?.focused === true &&
    snapshot?.subroleMatches === true;
  return { status: valid ? 0 : result.status || 3, snapshot, stdout: result.stdout, stderr: result.stderr };
}

/** Returns only schema-validated visibility metadata for Lekh-owned surfaces. */
export function visibleLekhInputMethodSurfaces(pid) {
  const surfaceSchema = "lekh.imk-surface-visibility.v1";
  const forbiddenIdentifiers = new Set(["lekh.inlineCompletionPanel", "lekh.candidatePanel"]);
  const failedInspection = (status = 3) => ({
    status: Number.isInteger(status) && status !== 0 ? status : 3,
    schema: surfaceSchema,
    rows: [],
    ownerOnScreenWindowCount: null,
    forbiddenVisibleCount: null,
    stderr: "Surface visibility inspection failed closed without reading target content.\n"
  });
  if (!Number.isInteger(pid) || pid <= 0) return failedInspection(2);
  const result = run("swift", ["-e", `
import ApplicationServices
import CoreGraphics
import Foundation

let targetPid = pid_t(${pid})
let forbidden = Set(["lekh.inlineCompletionPanel", "lekh.candidatePanel"])

let app = AXUIElementCreateApplication(targetPid)
var windowsValue: CFTypeRef?
guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue) == .success,
      let windowsValue,
      CFGetTypeID(windowsValue) == CFArrayGetTypeID(),
      let windows = windowsValue as? [AXUIElement] else { exit(20) }
var rows: [[String: Any]] = []
for window in windows {
  var identifierValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window, kAXIdentifierAttribute as CFString, &identifierValue) == .success,
        let identifierValue,
        CFGetTypeID(identifierValue) == CFStringGetTypeID(),
        let identifier = identifierValue as? String else { exit(21) }
  if forbidden.contains(identifier) {
    var minimizedValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimizedValue) == .success,
          let minimizedValue,
          CFGetTypeID(minimizedValue) == CFBooleanGetTypeID(),
          let minimized = minimizedValue as? Bool else { exit(22) }
    // AXWindows contains the application's exposed windows. AppKit panels that
    // are ordered out disappear from this list; minimized windows remain and
    // are rejected separately below.
    rows.append(["identifier": identifier, "minimized": minimized])
  }
}
guard let windowRows = CGWindowListCopyWindowInfo(
  [.optionOnScreenOnly, .excludeDesktopElements],
  kCGNullWindowID
) as? [[String: Any]] else { exit(30) }
var ownerOnScreenWindowCount = 0
for row in windowRows {
  guard let owner = row[kCGWindowOwnerPID as String] as? NSNumber,
        CFGetTypeID(owner) == CFNumberGetTypeID() else { exit(31) }
  if owner.int32Value == targetPid { ownerOnScreenWindowCount += 1 }
}
rows.sort {
  ($0["identifier"] as? String ?? "") < ($1["identifier"] as? String ?? "")
}
let output: [String: Any] = [
  "schema": ${JSON.stringify("lekh.imk-surface-visibility.v1")},
  "targetPid": targetPid,
  "rows": rows,
  "ownerOnScreenWindowCount": ownerOnScreenWindowCount
]
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
`]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return failedInspection(result.status);
  }
  const validRows = Array.isArray(parsed?.rows) && parsed.rows.every((row) =>
    hasExactKeys(row, ["identifier", "minimized"]) &&
    forbiddenIdentifiers.has(row.identifier) &&
    typeof row.minimized === "boolean"
  );
  const valid = result.status === 0 &&
    hasExactKeys(parsed, ["schema", "targetPid", "rows", "ownerOnScreenWindowCount"]) &&
    parsed.schema === surfaceSchema &&
    parsed.targetPid === pid &&
    validRows &&
    Number.isInteger(parsed.ownerOnScreenWindowCount) &&
    parsed.ownerOnScreenWindowCount >= 0;
  if (!valid) return failedInspection(result.status);
  const identifiedVisibleCount = parsed.rows.filter((row) => row.minimized === false).length;
  return {
    status: 0,
    schema: surfaceSchema,
    rows: parsed.rows,
    ownerOnScreenWindowCount: parsed.ownerOnScreenWindowCount,
    forbiddenVisibleCount: Math.max(identifiedVisibleCount, parsed.ownerOnScreenWindowCount),
    stderr: ""
  };
}
