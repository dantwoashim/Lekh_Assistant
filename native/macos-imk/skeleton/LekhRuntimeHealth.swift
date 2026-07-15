import Foundation

/// Content-free, process-bound readiness evidence shared with the companion.
/// It is written only at lifecycle boundaries, never from the keystroke path.
public enum LekhRuntimeHealth {
  public static let schemaVersion = 1
  /// Current macOS derives the accepted third-party IMK connection identity
  /// from the bundle identifier. An arbitrary legacy name is refused by
  /// imklaunchagent before the application can publish an endpoint.
  public static let expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection"

  private struct Record: Codable {
    var schemaVersion: Int
    var bundleIdentifier: String
    var bundleVersion: String
    var connectionName: String
    var processIdentifier: Int32
    var executableStartedAt: Date
    var serverStartedAt: Date?
    var controllerInitializedAt: Date?
    var controllerActivatedAt: Date?
  }

  private static let queue = DispatchQueue(
    label: "com.lekh.inputmethod.runtime-health",
    qos: .utility
  )

  public static func markServerStarted(connectionName: String) {
    update { record, now in
      record.connectionName = connectionName
      record.serverStartedAt = now
    }
  }

  public static func markControllerInitialized() {
    update { record, now in
      record.controllerInitializedAt = now
    }
  }

  public static func markControllerActivated() {
    update { record, now in
      record.controllerActivatedAt = now
    }
  }

  private static func update(_ mutation: @escaping (inout Record, Date) -> Void) {
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? ""
    let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    let pid = ProcessInfo.processInfo.processIdentifier
    guard bundleIdentifier == "com.lekh.inputmethod.LekhKeyboard",
          !bundleVersion.isEmpty else { return }

    queue.async {
      let now = Date()
      let url = healthURL
      let existing = (try? Data(contentsOf: url))
        .flatMap { try? JSONDecoder.lekhHealth.decode(Record.self, from: $0) }
      var record: Record
      if let existing,
         existing.schemaVersion == schemaVersion,
         existing.bundleIdentifier == bundleIdentifier,
         existing.bundleVersion == bundleVersion,
         existing.processIdentifier == pid {
        record = existing
      } else {
        record = Record(
          schemaVersion: schemaVersion,
          bundleIdentifier: bundleIdentifier,
          bundleVersion: bundleVersion,
          connectionName: expectedConnectionName,
          processIdentifier: pid,
          executableStartedAt: now,
          serverStartedAt: nil,
          controllerInitializedAt: nil,
          controllerActivatedAt: nil
        )
      }
      mutation(&record, now)
      guard let data = try? JSONEncoder.lekhHealth.encode(record) else { return }
      do {
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(),
          withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes(
          [.posixPermissions: 0o700],
          ofItemAtPath: url.deletingLastPathComponent().path
        )
        try data.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      } catch {
        // Health evidence is optional and must never affect typing startup.
      }
    }
  }

  private static var healthURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Lekh Keyboard", isDirectory: true)
      .appendingPathComponent("runtime-health.v1.json")
  }
}

private extension JSONEncoder {
  static var lekhHealth: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

private extension JSONDecoder {
  static var lekhHealth: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}
