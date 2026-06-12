import Foundation

#if canImport(MetricKit)
import MetricKit
#endif

public enum LekhMetricReporterBootstrap {
  public static func startIfOptedIn() {
    guard UserDefaults.standard.bool(forKey: "LekhMetricKitOptIn") else { return }
    #if canImport(MetricKit)
    if #available(macOS 12.0, *) {
      LekhMetricReporter.shared.start()
    }
    #endif
  }
}

#if canImport(MetricKit)
@available(macOS 12.0, *)
private final class LekhMetricReporter: NSObject, MXMetricManagerSubscriber {
  static let shared = LekhMetricReporter()
  private let lock = NSLock()
  private var started = false

  func start() {
    lock.lock()
    defer { lock.unlock() }
    guard !started else { return }
    MXMetricManager.shared.add(self)
    started = true
  }

  func didReceive(_ payloads: [MXMetricPayload]) {
    writePayloads(payloads.map { $0.jsonRepresentation() }, kind: "metric")
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    writePayloads(payloads.map { $0.jsonRepresentation() }, kind: "diagnostic")
  }

  private func writePayloads(_ payloads: [Data], kind: String) {
    guard !payloads.isEmpty else { return }
    let fileManager = FileManager.default
    let logDirectory = fileManager.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Logs", isDirectory: true)
      .appendingPathComponent("LekhKeyboard", isDirectory: true)
    try? fileManager.createDirectory(at: logDirectory, withIntermediateDirectories: true)
    let logURL = logDirectory.appendingPathComponent("metrics.jsonl")
    let handle: FileHandle?
    do {
      handle = try FileHandle(forWritingTo: logURL)
    } catch {
      handle = createLogFile(logURL)
    }
    guard let handle else { return }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    for payload in payloads {
      let line = makeLine(payload: payload, kind: kind)
      if let data = "\(line)\n".data(using: .utf8) {
        try? handle.write(contentsOf: data)
      }
    }
  }

  private func createLogFile(_ url: URL) -> FileHandle? {
    FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [
      .posixPermissions: 0o600
    ])
    return try? FileHandle(forWritingTo: url)
  }

  private func makeLine(payload: Data, kind: String) -> String {
    let base64 = payload.base64EncodedString()
    let timestamp = ISO8601DateFormatter().string(from: Date())
    return #"{"generatedAt":"\#(timestamp)","kind":"\#(kind)","source":"MetricKit","payloadBase64":"\#(base64)"}"#
  }
}
#endif
