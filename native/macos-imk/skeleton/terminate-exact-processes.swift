#!/usr/bin/env swift
import Darwin
import Foundation

struct ProcessIdentity: Hashable {
  let processIdentifier: pid_t
  let executablePath: String
  let startSeconds: UInt64
  let startMicroseconds: UInt64

  var startToken: String { "\(startSeconds):\(startMicroseconds)" }
}

func emit(status: String, path: String, termSignals: Int, killSignals: Int, remaining: [ProcessIdentity]) -> Never {
  let output: [String: Any] = [
    "status": status,
    "executablePath": path,
    "termSignals": termSignals,
    "killSignals": killSignals,
    "remaining": remaining.map {
      [
        "processIdentifier": $0.processIdentifier,
        "processStartToken": $0.startToken
      ]
    }
  ]
  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
  let stream = status == "passed" ? FileHandle.standardOutput : FileHandle.standardError
  stream.write(data)
  stream.write(Data([0x0a]))
  exit(status == "passed" ? 0 : 1)
}

func identity(_ processIdentifier: pid_t) -> ProcessIdentity? {
  guard processIdentifier > 1 else { return nil }
  // Swift does not import PROC_PIDPATHINFO_MAXSIZE because the SDK macro is
  // expressed in terms of an unsupported C structure. Four MAXPATHLEN pages
  // is the Darwin contract value and leaves room for long translated paths.
  var pathBuffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  let pathLength = proc_pidpath(
    processIdentifier,
    &pathBuffer,
    UInt32(pathBuffer.count)
  )
  var info = proc_bsdinfo()
  let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
  let infoSize = proc_pidinfo(
    processIdentifier,
    PROC_PIDTBSDINFO,
    0,
    &info,
    expectedSize
  )
  guard pathLength > 0,
        infoSize == expectedSize,
        info.pbi_status != UInt32(SZOMB) else { return nil }
  return ProcessIdentity(
    processIdentifier: processIdentifier,
    executablePath: String(cString: pathBuffer),
    startSeconds: info.pbi_start_tvsec,
    startMicroseconds: info.pbi_start_tvusec
  )
}

func allProcessIdentifiers() -> [pid_t] {
  let estimatedCount = max(Int(proc_listallpids(nil, 0)), 4_096)
  var processIdentifiers = [pid_t](repeating: 0, count: estimatedCount + 256)
  let count = processIdentifiers.withUnsafeMutableBytes { buffer in
    proc_listallpids(buffer.baseAddress, Int32(buffer.count))
  }
  guard count > 0 else { return [] }
  return Array(processIdentifiers.prefix(Int(count))).filter { $0 > 1 }
}

func identities(exactExecutablePath: String) -> [ProcessIdentity] {
  allProcessIdentifiers()
    .compactMap(identity)
    .filter { $0.executablePath == exactExecutablePath }
    .sorted { left, right in
      if left.processIdentifier != right.processIdentifier {
        return left.processIdentifier < right.processIdentifier
      }
      return left.startToken < right.startToken
    }
}

@discardableResult
func signalExactIdentity(_ expected: ProcessIdentity, signal: Int32) -> Bool {
  guard let observed = identity(expected.processIdentifier), observed == expected else {
    return false
  }
  return kill(expected.processIdentifier, signal) == 0
}

guard CommandLine.arguments.count == 3,
      CommandLine.arguments[1] == "--terminate-all-exact-path" else {
  fputs("Usage: terminate-exact-processes.swift --terminate-all-exact-path /absolute/executable\n", stderr)
  exit(2)
}

let requestedPath = CommandLine.arguments[2]
guard requestedPath.hasPrefix("/") else {
  fputs("Exact executable path must be absolute.\n", stderr)
  exit(2)
}
let exactExecutablePath = URL(fileURLWithPath: requestedPath).resolvingSymlinksInPath().path
var termSignals = 0
var killSignals = 0
var termSignaled = Set<ProcessIdentity>()
let termDeadline = Date().addingTimeInterval(3.0)

while Date() < termDeadline {
  let running = identities(exactExecutablePath: exactExecutablePath)
  if running.isEmpty {
    emit(
      status: "passed",
      path: exactExecutablePath,
      termSignals: termSignals,
      killSignals: killSignals,
      remaining: []
    )
  }
  for process in running where !termSignaled.contains(process) {
    if signalExactIdentity(process, signal: SIGTERM) {
      termSignals += 1
      termSignaled.insert(process)
    }
  }
  usleep(100_000)
}

let killDeadline = Date().addingTimeInterval(2.0)
var killSignaled = Set<ProcessIdentity>()
while Date() < killDeadline {
  let running = identities(exactExecutablePath: exactExecutablePath)
  if running.isEmpty {
    emit(
      status: "passed",
      path: exactExecutablePath,
      termSignals: termSignals,
      killSignals: killSignals,
      remaining: []
    )
  }
  for process in running where !killSignaled.contains(process) {
    if signalExactIdentity(process, signal: SIGKILL) {
      killSignals += 1
      killSignaled.insert(process)
    }
  }
  usleep(100_000)
}

emit(
  status: "failed",
  path: exactExecutablePath,
  termSignals: termSignals,
  killSignals: killSignals,
  remaining: identities(exactExecutablePath: exactExecutablePath)
)
