import Darwin
import Foundation

private struct LockEvidence: Codable {
  let status: String
  let errorNumber: Int32?
  let reason: String?
}

private func emit(_ evidence: LockEvidence) {
  guard let data = try? JSONEncoder().encode(evidence) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

let arguments = CommandLine.arguments
guard
  [3, 5].contains(arguments.count),
  arguments[1] == "--lock-fd",
  let descriptor = Int32(arguments[2]),
  descriptor >= 3,
  arguments.count == 3 || arguments[3] == "--wait-ms",
  arguments.count == 3 || Int(arguments[4]) != nil
else {
  FileHandle.standardError.write(Data("usage: macos-companion-publication-lock --lock-fd <inherited-fd> [--wait-ms <0...60000>]\n".utf8))
  exit(EX_USAGE)
}

let waitMilliseconds = arguments.count == 5 ? Int(arguments[4])! : 0
guard (0...60_000).contains(waitMilliseconds) else {
  FileHandle.standardError.write(Data("lock wait must be between 0 and 60000 milliseconds\n".utf8))
  exit(EX_USAGE)
}

// The Node parent opened this descriptor and passed the same open file
// description as fd 3. BSD flock attaches to that open file description, so
// the lock remains held by the parent's descriptor after this helper exits.
// Never call LOCK_UN here: doing so would unlock the shared description.
let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(waitMilliseconds) * 1_000_000
while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
  let code = errno
  guard code == EWOULDBLOCK, DispatchTime.now().uptimeNanoseconds < deadline else {
    emit(LockEvidence(
      status: code == EWOULDBLOCK ? "busy" : "failed",
      errorNumber: code,
      reason: String(cString: strerror(code))
    ))
    exit(code == EWOULDBLOCK ? EX_TEMPFAIL : EX_OSERR)
  }
  usleep(50_000)
}

emit(LockEvidence(status: "acquired", errorNumber: nil, reason: nil))
exit(EX_OK)
