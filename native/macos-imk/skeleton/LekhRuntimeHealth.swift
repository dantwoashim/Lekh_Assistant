import Foundation

/// Content-free generation gate used to prevent delayed callbacks from one IMK
/// controller activation from publishing evidence for another activation.
public struct LekhRuntimeActivationGate: Sendable {
  private var liveActivationIdentifier: String?

  public init() {}

  @discardableResult
  public mutating func activate(_ activationIdentifier: String) -> Bool {
    guard UUID(uuidString: activationIdentifier) != nil else { return false }
    liveActivationIdentifier = activationIdentifier
    return true
  }

  public mutating func deactivate(_ activationIdentifier: String) {
    guard liveActivationIdentifier == activationIdentifier else { return }
    liveActivationIdentifier = nil
  }

  public func accepts(
    _ activationIdentifier: String,
    recordActivationIdentifier: String?
  ) -> Bool {
    UUID(uuidString: activationIdentifier) != nil &&
      liveActivationIdentifier == activationIdentifier &&
      recordActivationIdentifier == activationIdentifier
  }
}

/// Content-free, process-bound readiness and surface evidence shared with the
/// companion. Calls from typing remain nonblocking and coalesce disk writes.
public enum LekhRuntimeHealth {
  public static let schemaVersion = 1
  public static let maximumGhostSuppressionCount = 10_000
  /// Current macOS derives the accepted third-party IMK connection identity
  /// from the bundle identifier. An arbitrary legacy name is refused by
  /// imklaunchagent before the application can publish an endpoint.
  public static let expectedConnectionName = "com.lekh.inputmethod.LekhKeyboard_Connection"

  /// A deliberately closed, content-free reason vocabulary. Callers cannot add
  /// raw keys, tokens, candidates, application text or host identifiers to the
  /// runtime-health record.
  public enum GhostSuppressionReason: String, CaseIterable, Sendable {
    case preferenceDisabled = "preference-disabled"
    case noEligibleCompletion = "no-eligible-completion"
    case compositionChanged = "composition-changed"
    case compositionOwnerChanged = "composition-owner-changed"
    case hostGeometryUnavailable = "host-geometry-unavailable"
    case presentationUnavailable = "presentation-unavailable"
    case candidateListRequested = "candidate-list-requested"
  }

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
    var controllerInstanceIdentifier: String?
    var activationIdentifier: String?
    var controllerIsActive: Bool?
    var controllerDeactivatedAt: Date?
    var lastGhostOfferedAt: Date?
    var lastGhostAcceptedAt: Date?
    var ghostSuppressionCounts: [String: Int]?
  }

  private static let queue = DispatchQueue(
    label: "com.lekh.inputmethod.runtime-health",
    qos: .utility
  )
  private static var cachedRecord: Record?
  private static var pendingGhostWrite: DispatchWorkItem?
  private static var activationGate = LekhRuntimeActivationGate()
  private static let ghostWriteDelay: TimeInterval = 0.25

  public static func markServerStarted(connectionName: String) {
    update(forceNewRecord: true) { record, now in
      activationGate = LekhRuntimeActivationGate()
      record.connectionName = connectionName
      record.serverStartedAt = now
      return true
    }
  }

  public static func markControllerInitialized(
    controllerIdentifier: String,
    initializedAt: Date
  ) {
    guard UUID(uuidString: controllerIdentifier) != nil else { return }
    update { record, now in
      // IMK may construct another controller while a different controller is
      // still active. Never let an inactive instance overwrite the lifecycle
      // or surface evidence of the active one.
      guard record.activationIdentifier == nil else { return false }
      record.controllerInstanceIdentifier = controllerIdentifier
      record.controllerInitializedAt = max(record.executableStartedAt, min(initializedAt, now))
      return true
    }
  }

  public static func markControllerActivated(
    controllerIdentifier: String,
    initializedAt: Date,
    activationIdentifier: String
  ) {
    guard UUID(uuidString: controllerIdentifier) != nil,
          UUID(uuidString: activationIdentifier) != nil else { return }
    update { record, now in
      guard activationGate.activate(activationIdentifier) else { return false }
      record.controllerInstanceIdentifier = controllerIdentifier
      record.activationIdentifier = activationIdentifier
      record.controllerInitializedAt = max(record.executableStartedAt, min(initializedAt, now))
      record.controllerActivatedAt = now
      record.controllerIsActive = true
      record.controllerDeactivatedAt = nil
      // Evidence is scoped to one explicit controller activation. This keeps
      // interleaved WebKit/Electron controllers and old host sessions from
      // being presented as proof for the current text client.
      record.lastGhostOfferedAt = nil
      record.lastGhostAcceptedAt = nil
      record.ghostSuppressionCounts = [:]
      return true
    }
  }

  public static func markControllerDeactivated(activationIdentifier: String) {
    guard UUID(uuidString: activationIdentifier) != nil else { return }
    update { record, now in
      activationGate.deactivate(activationIdentifier)
      guard record.activationIdentifier == activationIdentifier else { return false }
      record.controllerIsActive = false
      record.controllerDeactivatedAt = now
      return true
    }
  }

  /// Records only proof that the nonactivating completion panel successfully
  /// became visible. No suggestion text or host data crosses this boundary.
  public static func markGhostOffered(activationIdentifier: String) {
    update(coalesce: true) { record, now in
      guard acceptsSurfaceEvidence(record, activationIdentifier: activationIdentifier) else { return false }
      record.lastGhostOfferedAt = now
      return true
    }
  }

  /// Records that IMK handled an explicit acceptance command and dispatched
  /// the insertion request. Host probes separately verify resulting document
  /// text because IMKTextInput.insertText has no success return value.
  public static func markGhostAccepted(activationIdentifier: String) {
    update { record, now in
      guard acceptsSurfaceEvidence(record, activationIdentifier: activationIdentifier),
            record.lastGhostOfferedAt != nil else { return false }
      record.lastGhostAcceptedAt = now
      return true
    }
  }

  /// Adds one to a fixed reason bucket and saturates it at a small bound. This
  /// intentionally measures aggregate behavior without retaining typed content,
  /// token length, key identity, candidate identity or application identity.
  public static func markGhostSuppressed(
    _ reason: GhostSuppressionReason,
    activationIdentifier: String
  ) {
    update(coalesce: true) { record, _ in
      guard acceptsSurfaceEvidence(record, activationIdentifier: activationIdentifier) else { return false }
      var counts = boundedSuppressionCounts(record.ghostSuppressionCounts ?? [:])
      let current = counts[reason.rawValue] ?? 0
      counts[reason.rawValue] = min(current + 1, maximumGhostSuppressionCount)
      record.ghostSuppressionCounts = counts
      return true
    }
  }

  private static func update(
    forceNewRecord: Bool = false,
    coalesce: Bool = false,
    _ mutation: @escaping (inout Record, Date) -> Bool
  ) {
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? ""
    let bundleVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    let pid = ProcessInfo.processInfo.processIdentifier
    guard bundleIdentifier == "com.lekh.inputmethod.LekhKeyboard",
          !bundleVersion.isEmpty else { return }

    queue.async {
      let now = Date()
      let url = healthURL
      let existing = cachedRecord ?? (try? Data(contentsOf: url))
        .flatMap { try? JSONDecoder.lekhHealth.decode(Record.self, from: $0) }
      var record: Record
      if !forceNewRecord,
         let existing,
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
          controllerActivatedAt: nil,
          controllerInstanceIdentifier: nil,
          activationIdentifier: nil,
          controllerIsActive: false,
          controllerDeactivatedAt: nil,
          lastGhostOfferedAt: nil,
          lastGhostAcceptedAt: nil,
          ghostSuppressionCounts: [:]
        )
      }
      record.ghostSuppressionCounts = boundedSuppressionCounts(record.ghostSuppressionCounts ?? [:])
      guard mutation(&record, now) else { return }
      cachedRecord = record
      if coalesce {
        scheduleGhostWrite()
      } else {
        pendingGhostWrite?.cancel()
        pendingGhostWrite = nil
        persistCachedRecord()
      }
    }
  }

  private static func scheduleGhostWrite() {
    pendingGhostWrite?.cancel()
    let work = DispatchWorkItem {
      pendingGhostWrite = nil
      persistCachedRecord()
    }
    pendingGhostWrite = work
    queue.asyncAfter(deadline: .now() + ghostWriteDelay, execute: work)
  }

  private static func persistCachedRecord() {
    guard let record = cachedRecord,
          let data = try? JSONEncoder.lekhHealth.encode(record) else { return }
    let url = healthURL
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

  private static func boundedSuppressionCounts(_ input: [String: Int]) -> [String: Int] {
    var output: [String: Int] = [:]
    for reason in GhostSuppressionReason.allCases {
      guard let value = input[reason.rawValue] else { continue }
      output[reason.rawValue] = min(max(value, 0), maximumGhostSuppressionCount)
    }
    return output
  }

  private static func acceptsSurfaceEvidence(
    _ record: Record,
    activationIdentifier: String
  ) -> Bool {
    activationGate.accepts(
      activationIdentifier,
      recordActivationIdentifier: record.activationIdentifier
    )
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
