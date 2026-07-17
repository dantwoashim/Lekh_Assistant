import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

const protocolVersion = "lekh-candidate-textedit-custody-v1";
const framePrefixes = Object.freeze({
  ready: "LEKH_TEXTEDIT_CUSTODIAN_READY:",
  host: "LEKH_TEXTEDIT_CUSTODIAN_HOST:",
  released: "LEKH_TEXTEDIT_CUSTODIAN_RELEASED:"
});

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected field set.`);
  }
}

function boundedAppend(current, chunk, limit = 128 * 1024) {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") > limit) throw new Error("TextEdit custodian output exceeded its bound.");
  return next;
}

function validateParentIdentity(value) {
  const identity = {
    processIdentifier: value?.processIdentifier,
    executablePath: value?.executablePath,
    processStartToken: value?.processStartToken
  };
  if (
    !Number.isInteger(identity.processIdentifier) || identity.processIdentifier <= 1 ||
    !isAbsolute(identity.executablePath ?? "") ||
    !/^\d{1,20}:\d{1,6}$/u.test(identity.processStartToken ?? "")
  ) throw new Error("TextEdit custodian parent identity is incomplete.");
  return Object.freeze(identity);
}

function validatePrivateDocument(path) {
  const canonical = realpathSync(path);
  const metadata = lstatSync(canonical);
  if (
    canonical !== path || !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 ||
    !/\/Library\/Application Support\/Lekh Keyboard\/QA Recovery\/Candidate Mouse Probe\/\.candidate-document\.[a-f0-9]{32}\.txt$/u.test(canonical)
  ) throw new Error("TextEdit custodian document is outside the exact private recovery namespace.");
  return canonical;
}

function pathHash(path) {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function swiftString(value) {
  return JSON.stringify(value);
}

export function candidateTextEditCustodianSource({ documentPath, parentIdentity }) {
  const documentPathBase64 = Buffer.from(documentPath, "utf8").toString("base64");
  const parentPathBase64 = Buffer.from(parentIdentity.executablePath, "utf8").toString("base64");
  const documentPathSha256 = pathHash(documentPath);
  return `
import AppKit
import Darwin
import Foundation
import ObjectiveC.runtime

let protocolVersion = ${swiftString(protocolVersion)}
let documentPath = String(data: Data(base64Encoded: ${swiftString(documentPathBase64)})!, encoding: .utf8)!
let documentPathSha256 = ${swiftString(documentPathSha256)}
let parentPid = pid_t(${parentIdentity.processIdentifier})
let parentPath = String(data: Data(base64Encoded: ${swiftString(parentPathBase64)})!, encoding: .utf8)!
let parentStartToken = ${swiftString(parentIdentity.processStartToken)}

struct ProcessEpoch: Equatable {
  let pid: pid_t
  let path: String
  let startToken: String
}

func epoch(_ pid: pid_t) -> ProcessEpoch? {
  guard pid > 1, kill(pid, 0) == 0 else { return nil }
  var pathBuffer = [CChar](repeating: 0, count: 4096)
  let pathLength = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
  var info = proc_bsdinfo()
  let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let infoSize = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expectedSize)
  guard pathLength > 0, infoSize == expectedSize, info.pbi_status != UInt32(SZOMB) else { return nil }
  return ProcessEpoch(
    pid: pid,
    path: String(cString: pathBuffer),
    startToken: "\\(info.pbi_start_tvsec):\\(info.pbi_start_tvusec)"
  )
}

func parentIsExact() -> Bool {
  guard let observed = epoch(parentPid) else { return false }
  return observed.path == parentPath && observed.startToken == parentStartToken
}

func emit(_ prefix: String, _ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { exit(70) }
  let line = prefix + data.base64EncodedString() + "\\n"
  FileHandle.standardOutput.write(Data(line.utf8))
}

func canonicalTextEditExecutable() -> String? {
  for candidate in [
    "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
    "/Applications/TextEdit.app/Contents/MacOS/TextEdit"
  ] where FileManager.default.isExecutableFile(atPath: candidate) {
    let canonical = URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path
    let bundlePath = URL(fileURLWithPath: canonical).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
    if Bundle(path: bundlePath)?.bundleIdentifier == "com.apple.TextEdit" { return canonical }
  }
  return nil
}

func documentIsExact() -> Bool {
  var info = stat()
  guard lstat(documentPath, &info) == 0,
        (info.st_mode & S_IFMT) == S_IFREG,
        info.st_uid == getuid(),
        (info.st_mode & 0o777) == 0o600,
        info.st_nlink == 1 else { return false }
  return URL(fileURLWithPath: documentPath).resolvingSymlinksInPath().path == documentPath
}

var hostEpoch: ProcessEpoch?
var launchCount = 0
var released = false
var finishing = false
var inputBuffer = Data()

typealias OpenURLsFunction = @convention(c) (
  AnyObject,
  Selector,
  NSArray,
  NSURL,
  UInt,
  NSDictionary,
  UnsafeMutablePointer<NSError?>?
) -> Unmanaged<AnyObject>?

func terminateHostExactly() -> Bool {
  guard let expected = hostEpoch else { return true }
  guard let observed = epoch(expected.pid) else { return true }
  guard observed == expected else { return true }
  _ = kill(expected.pid, SIGTERM)
  let termDeadline = Date().addingTimeInterval(1.0)
  while Date() < termDeadline {
    guard let current = epoch(expected.pid) else { return true }
    if current != expected { return true }
    usleep(25_000)
  }
  guard epoch(expected.pid) == expected else { return true }
  _ = kill(expected.pid, SIGKILL)
  let killDeadline = Date().addingTimeInterval(0.75)
  while Date() < killDeadline {
    guard let current = epoch(expected.pid) else { return true }
    if current != expected { return true }
    usleep(25_000)
  }
  return epoch(expected.pid) != expected
}

func abortCustody(_ code: Int32) -> Never {
  if finishing { exit(code) }
  finishing = true
  FileHandle.standardInput.readabilityHandler = nil
  let safe = terminateHostExactly()
  exit(safe ? code : 74)
}

func requestAbort(_ code: Int32) {
  if finishing { return }
  FileHandle.standardInput.readabilityHandler = nil
  abortCustody(code)
}

// The modern NSWorkspace API is deliberately asynchronous and creates an
// interval in which a host may exist before its PID is available to recovery.
// Invoke the legacy synchronous Objective-C entry point dynamically so the
// compiler emits no deprecated-API warning and custody receives the exact
// NSRunningApplication in the same call that authorizes the launch.
func openTextEditSynchronously(applicationURL: URL) throws -> NSRunningApplication {
  let selector = NSSelectorFromString("openURLs:withApplicationAtURL:options:configuration:error:")
  guard NSWorkspace.shared.responds(to: selector),
        let method = class_getInstanceMethod(NSWorkspace.self, selector) else {
    throw NSError(domain: "com.lekh.qa.textedit-custodian", code: 1)
  }
  let invoke = unsafeBitCast(method_getImplementation(method), to: OpenURLsFunction.self)
  var launchError: NSError?
  // NSWorkspaceLaunchWithoutAddingToRecents | NSWorkspaceLaunchNewInstance.
  let options = UInt(0x00000100 | 0x00080000)
  let result = invoke(
    NSWorkspace.shared,
    selector,
    [URL(fileURLWithPath: documentPath)] as NSArray,
    applicationURL as NSURL,
    options,
    NSDictionary(),
    &launchError
  )?.takeUnretainedValue()
  if let application = result as? NSRunningApplication { return application }
  throw launchError ?? NSError(domain: "com.lekh.qa.textedit-custodian", code: 2)
}

func launchExactlyOnce() {
  guard !finishing, launchCount == 0, parentIsExact(), documentIsExact(),
        let executable = canonicalTextEditExecutable() else { abortCustody(78) }
  launchCount = 1
  let launchedAtUnixMs = Int64(Date().timeIntervalSince1970 * 1_000)
  let executableURL = URL(fileURLWithPath: executable)
  let applicationURL = executableURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let application: NSRunningApplication
  do {
    application = try openTextEditSynchronously(applicationURL: applicationURL)
  } catch {
    abortCustody(71)
  }
  let pid = application.processIdentifier
  guard application.bundleIdentifier == "com.apple.TextEdit",
        let exact = epoch(pid),
        exact.path == executable,
        exact.path.hasSuffix("/TextEdit.app/Contents/MacOS/TextEdit") else {
    if let fallback = epoch(pid) { hostEpoch = fallback }
    abortCustody(73)
  }
  // Bind the host before checking the parent again. If the parent died inside
  // the synchronous call, abortCustody can now terminate exactly this epoch.
  hostEpoch = exact
  guard parentIsExact() else { abortCustody(77) }
  _ = application.activate(options: [.activateAllWindows])
  emit("LEKH_TEXTEDIT_CUSTODIAN_HOST:", [
    "schemaVersion": 1,
    "protocolVersion": protocolVersion,
    "processIdentifier": Int(exact.pid),
    "executablePath": exact.path,
    "processStartToken": exact.startToken,
    "launchedAtUnixMs": launchedAtUnixMs,
    "documentPathSha256": documentPathSha256,
    "launchCount": launchCount
  ])
}

func releaseHost(_ encoded: String) {
  guard !finishing, launchCount == 1, let expected = hostEpoch, parentIsExact(),
        let data = Data(base64Encoded: encoded),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        object.count == 3,
        object["processIdentifier"] as? Int == Int(expected.pid),
        object["executablePath"] as? String == expected.path,
        object["processStartToken"] as? String == expected.startToken,
        epoch(expected.pid) == expected else { abortCustody(76) }
  released = true
  finishing = true
  FileHandle.standardInput.readabilityHandler = nil
  emit("LEKH_TEXTEDIT_CUSTODIAN_RELEASED:", [
    "schemaVersion": 1,
    "protocolVersion": protocolVersion,
    "processIdentifier": Int(expected.pid),
    "documentPathSha256": documentPathSha256,
    "launchCount": launchCount,
    "released": true
  ])
  exit(0)
}

func consumeInput(_ data: Data) {
  guard !finishing else { return }
  if data.isEmpty { requestAbort(77); return }
  inputBuffer.append(data)
  guard inputBuffer.count <= 8_192 else { abortCustody(78) }
  while let newline = inputBuffer.firstIndex(of: 10) {
    let lineData = inputBuffer.prefix(upTo: newline)
    inputBuffer.removeSubrange(...newline)
    guard let line = String(data: lineData, encoding: .utf8) else { abortCustody(78) }
    if launchCount == 0, line == "GO" { launchExactlyOnce(); continue }
    if launchCount == 1, line.hasPrefix("RELEASE:") {
      releaseHost(String(line.dropFirst("RELEASE:".count)))
    }
    abortCustody(78)
  }
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGHUP, SIG_IGN)
let signalQueue = DispatchQueue(label: "com.lekh.qa.candidate-textedit-custodian.signals")
let signalSources = [SIGINT, SIGTERM, SIGHUP].map { number -> DispatchSourceSignal in
  let source = DispatchSource.makeSignalSource(signal: number, queue: signalQueue)
  source.setEventHandler { DispatchQueue.main.async { requestAbort(77) } }
  source.resume()
  return source
}
let parentTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
parentTimer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
parentTimer.setEventHandler {
  if !parentIsExact() { requestAbort(77); return }
  if !released, let expected = hostEpoch, epoch(expected.pid) != expected { requestAbort(75) }
}
parentTimer.resume()

guard parentIsExact(), documentIsExact(), canonicalTextEditExecutable() != nil else { exit(78) }
FileHandle.standardInput.readabilityHandler = { handle in
  let data = handle.availableData
  DispatchQueue.main.async { consumeInput(data) }
}
emit("LEKH_TEXTEDIT_CUSTODIAN_READY:", [
  "schemaVersion": 1,
  "protocolVersion": protocolVersion,
  "processIdentifier": Int(getpid()),
  "documentPathSha256": documentPathSha256,
  "launchCount": launchCount,
  "sideEffectsAuthorized": false
])
RunLoop.main.run()
`;
}

function decodeFrame(line, prefix) {
  const encoded = line.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("TextEdit custodian emitted malformed base64.");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function validateReady(value, childPid, expectedHash) {
  exactKeys(value, [
    "schemaVersion", "protocolVersion", "processIdentifier", "documentPathSha256",
    "launchCount", "sideEffectsAuthorized"
  ], "TextEdit custodian READY");
  if (
    value.schemaVersion !== 1 || value.protocolVersion !== protocolVersion ||
    value.processIdentifier !== childPid || value.documentPathSha256 !== expectedHash ||
    value.launchCount !== 0 || value.sideEffectsAuthorized !== false
  ) throw new Error("TextEdit custodian READY evidence is invalid.");
  return Object.freeze({ ...value });
}

function validateHost(value, expectedHash) {
  exactKeys(value, [
    "schemaVersion", "protocolVersion", "processIdentifier", "executablePath",
    "processStartToken", "launchedAtUnixMs", "documentPathSha256", "launchCount"
  ], "TextEdit custodian HOST");
  if (
    value.schemaVersion !== 1 || value.protocolVersion !== protocolVersion ||
    !Number.isInteger(value.processIdentifier) || value.processIdentifier <= 1 ||
    !isAbsolute(value.executablePath ?? "") || !value.executablePath.endsWith("/TextEdit.app/Contents/MacOS/TextEdit") ||
    !/^\d{1,20}:\d{1,6}$/u.test(value.processStartToken ?? "") ||
    !Number.isInteger(value.launchedAtUnixMs) || value.launchedAtUnixMs <= 0 ||
    value.documentPathSha256 !== expectedHash || value.launchCount !== 1
  ) throw new Error("TextEdit custodian HOST evidence is invalid.");
  return Object.freeze({ ...value });
}

function validateReleased(value, host, expectedHash) {
  exactKeys(value, [
    "schemaVersion", "protocolVersion", "processIdentifier", "documentPathSha256",
    "launchCount", "released"
  ], "TextEdit custodian RELEASED");
  if (
    value.schemaVersion !== 1 || value.protocolVersion !== protocolVersion ||
    value.processIdentifier !== host.processIdentifier || value.documentPathSha256 !== expectedHash ||
    value.launchCount !== 1 || value.released !== true
  ) throw new Error("TextEdit custodian RELEASED evidence is invalid.");
  return Object.freeze({ ...value });
}

export function startCandidateTextEditCustodian({ documentPath, parentIdentity }) {
  const canonicalDocumentPath = validatePrivateDocument(documentPath);
  const exactParent = validateParentIdentity(parentIdentity);
  const expectedHash = pathHash(canonicalDocumentPath);
  const source = candidateTextEditCustodianSource({
    documentPath: canonicalDocumentPath,
    parentIdentity: exactParent
  });
  const child = spawn("/usr/bin/swift", ["-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let protocolError = null;
  let readyFrame = null;
  let hostFrame = null;
  let releasedFrame = null;
  const waiters = new Map();

  function publish(kind, value) {
    if (kind === "ready") readyFrame = validateReady(value, child.pid, expectedHash);
    if (kind === "host") hostFrame = validateHost(value, expectedHash);
    if (kind === "released") releasedFrame = validateReleased(value, hostFrame, expectedHash);
    const waiter = waiters.get(kind);
    if (waiter) {
      waiters.delete(kind);
      waiter.resolve(kind === "ready" ? readyFrame : kind === "host" ? hostFrame : releasedFrame);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    try {
      stdout = boundedAppend(stdout, chunk);
      lineBuffer += chunk;
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        const match = Object.entries(framePrefixes).find(([, prefix]) => line.startsWith(prefix));
        if (!match) continue;
        const [kind, prefix] = match;
        if ((kind === "ready" && readyFrame) || (kind === "host" && hostFrame) || (kind === "released" && releasedFrame)) {
          throw new Error(`TextEdit custodian emitted duplicate ${kind} evidence.`);
        }
        publish(kind, decodeFrame(line, prefix));
      }
    } catch (error) {
      protocolError = error;
      child.stdin.end();
    }
  });
  child.stderr.on("data", (chunk) => {
    try { stderr = boundedAppend(stderr, chunk); } catch (error) { protocolError = error; child.stdin.end(); }
  });
  const closed = new Promise((resolve) => {
    child.once("error", (error) => resolve({ status: 3, signal: null, error }));
    child.once("close", (status, signal) => resolve({ status: status ?? 3, signal, error: null }));
  }).then((completion) => {
    for (const waiter of waiters.values()) waiter.reject(protocolError ?? new Error("TextEdit custodian closed before its expected frame."));
    waiters.clear();
    return completion;
  });

  function frame(kind, timeoutMs) {
    const existing = kind === "ready" ? readyFrame : kind === "host" ? hostFrame : releasedFrame;
    if (existing) return Promise.resolve(existing);
    if (waiters.has(kind)) throw new Error(`TextEdit custodian ${kind} already has a waiter.`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(kind);
        reject(new Error(`Timed out waiting for TextEdit custodian ${kind}.`));
      }, timeoutMs);
      waiters.set(kind, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); }
      });
    });
  }

  return Object.freeze({
    child,
    closed,
    get pid() { return child.pid; },
    waitForReady: (timeoutMs = 8_000) => frame("ready", timeoutMs),
    waitForHost: (timeoutMs = 8_000) => frame("host", timeoutMs),
    waitForReleased: (timeoutMs = 3_000) => frame("released", timeoutMs),
    authorizeLaunch(durableHelperIdentity) {
      if (!readyFrame || hostFrame || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("TextEdit custodian is not at its READY authorization boundary.");
      }
      if (
        durableHelperIdentity?.processIdentifier !== child.pid ||
        !isAbsolute(durableHelperIdentity?.executablePath ?? "") ||
        !/^\d{1,20}:\d{1,6}$/u.test(durableHelperIdentity?.processStartToken ?? "")
      ) throw new Error("Durable TextEdit-custodian identity is invalid.");
      child.stdin.write("GO\n");
    },
    releaseToRecovery(durableHostIdentity) {
      if (!hostFrame || releasedFrame || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("TextEdit custodian is not awaiting durable host publication.");
      }
      const exact = {
        processIdentifier: durableHostIdentity?.processIdentifier,
        executablePath: durableHostIdentity?.executablePath,
        processStartToken: durableHostIdentity?.processStartToken
      };
      if (
        exact.processIdentifier !== hostFrame.processIdentifier ||
        exact.executablePath !== hostFrame.executablePath ||
        exact.processStartToken !== hostFrame.processStartToken
      ) throw new Error("Durable TextEdit identity does not match the custodian's live host epoch.");
      child.stdin.end(`RELEASE:${Buffer.from(JSON.stringify(exact), "utf8").toString("base64")}\n`);
    },
    abort() { child.stdin.end(); },
    output() { return { stdout, stderr, protocolError: protocolError?.message ?? null }; }
  });
}

export const CANDIDATE_TEXTEDIT_CUSTODY_PROTOCOL = protocolVersion;
