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

export function processExecutablePath(pid) {
  if (!Number.isInteger(pid)) return "";
  const result = run("swift", ["-e", `
import Darwin
import Foundation
let pid = Int32(${pid})
var buffer = [CChar](repeating: 0, count: 4096)
let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
if length > 0 { print(String(cString: buffer)) } else { exit(2) }
`]);
  if (result.status !== 0) return "";
  const path = result.stdout.trim();
  if (!path || !existsSync(path)) return path;
  return realpathSync(path);
}

export function currentInputSource() {
  const result = run("swift", ["-e", `
import Carbon
import Foundation
let source = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
if let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) {
  print(Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String)
} else {
  exit(2)
}
`]);
  return {
    status: result.status,
    id: result.stdout.trim(),
    stderr: result.stderr
  };
}

export function currentConsoleSessionState() {
  const result = run("swift", ["-e", `
import ApplicationServices
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
  const activatedAt = Date.parse(record.controllerActivatedAt);
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
      const executablePath = processExecutablePath(pid);
      if (executablePath.endsWith("/TextEdit.app/Contents/MacOS/TextEdit")) {
        return {
          status: 0,
          pid,
          priorPids,
          observedNewPids: [...observedNewPids],
          launchedAtMs,
          executablePath,
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

export function terminateColdTextEdit(pid) {
  if (!Number.isInteger(pid)) return { status: 0, terminated: false, note: "No probe PID was launched." };
  const executablePath = processExecutablePath(pid);
  if (!executablePath.endsWith("/TextEdit.app/Contents/MacOS/TextEdit")) {
    return { status: 2, terminated: false, note: `PID ${pid} is not TextEdit.` };
  }
  const termination = run("/bin/kill", ["-TERM", String(pid)]);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && processPids("TextEdit").includes(pid)) wait(100);
  const stillRunning = processPids("TextEdit").includes(pid);
  return {
    status: termination.status === 0 && !stillRunning ? 0 : termination.status || 3,
    terminated: !stillRunning,
    note: stillRunning ? "The fresh probe TextEdit process did not terminate after SIGTERM." : "Only the fresh probe TextEdit PID was terminated."
  };
}

export function removeProbeFile(path) {
  rmSync(path, { force: true });
}
