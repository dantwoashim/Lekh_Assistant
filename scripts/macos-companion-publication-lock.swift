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

guard
  CommandLine.arguments.count == 3,
  CommandLine.arguments[1] == "--lock-fd",
  let descriptor = Int32(CommandLine.arguments[2]),
  descriptor >= 3
else {
  FileHandle.standardError.write(Data("usage: macos-companion-publication-lock --lock-fd <inherited-fd>\n".utf8))
  exit(EX_USAGE)
}

// The Node parent opened this descriptor and passed the same open file
// description as fd 3. BSD flock attaches to that open file description, so
// the lock remains held by the parent's descriptor after this helper exits.
// Never call LOCK_UN here: doing so would unlock the shared description.
guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
  let code = errno
  emit(LockEvidence(
    status: code == EWOULDBLOCK ? "busy" : "failed",
    errorNumber: code,
    reason: String(cString: strerror(code))
  ))
  exit(code == EWOULDBLOCK ? EX_TEMPFAIL : EX_OSERR)
}

emit(LockEvidence(status: "acquired", errorNumber: nil, reason: nil))
exit(EX_OK)
