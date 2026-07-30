import AppKit
import Carbon
import Combine
import Darwin
import Foundation
import Security
import SQLite3
import UniformTypeIdentifiers

enum CompanionSection: String, CaseIterable, Identifiable {
  case home
  case typing
  case privacy
  case diagnostics

  var id: String { rawValue }
  var symbol: String {
    switch self {
    case .home: return "house"
    case .typing: return "keyboard"
    case .privacy: return "hand.raised"
    case .diagnostics: return "checkmark.shield"
    }
  }
}

enum CompanionLocale: String, CaseIterable, Identifiable {
  case english = "en"
  case nepali = "ne"

  var id: String { rawValue }
  var label: String { self == .english ? "English" : "नेपाली" }
}

enum NativeTypingMode: String, CaseIterable, Identifiable {
  case romanizedNepali = "romanized-traditional"
  case romanizedRomanized = "romanized-romanized"
  case traditionalNepali = "traditional-traditional"
  case traditionalRomanized = "traditional-romanized"

  var id: String { rawValue }
}

struct CompanionPreferences: Equatable {
  var mode: NativeTypingMode = .romanizedNepali
  var inlinePreviewEnabled = true
  var customCandidatePanelEnabled = true
  var proofreadAsYouTypeEnabled = true
  var smartPunctuationEnabled = true
  var personalizationEnabled = true
  var nextWordPredictionEnabled = true
}

struct ExcludedApplication: Identifiable, Equatable {
  let bundleIdentifier: String
  let displayName: String
  var id: String { bundleIdentifier }
}

enum KeyboardFailure: String, Equatable {
  case unreadableHealth = "runtime-health-unreadable"
  case wrongSchema = "runtime-health-schema"
  case wrongBundle = "runtime-health-bundle"
  case wrongBuild = "runtime-health-build"
  case wrongConnection = "runtime-health-connection"
  case processExited = "runtime-process-exited"
  case controllerMissing = "runtime-controller-missing"
}

enum KeyboardReadiness: Equatable {
  case missing
  case installedUnregistered
  case approvalRequired
  case enabledNotSelected
  case selectedUntested
  case healthy(processIdentifier: Int32, controllerInitializedAt: Date)
  case degraded(KeyboardFailure)
}

enum KeyboardBuildVerification: Equatable {
  case notChecked
  case matched
  case mismatched
}

enum KeyboardPrimaryAction: Equatable {
  case showInstallLocation
  case register
  case enable
  case select
  case verify
  case write
  case reconnect
  case replaceBuild
}

enum KeyboardRecoveryPlan: Equatable {
  case install
  case register
  case enable
  case select
  case verify
  case ready
  case reconnect
  case replaceBuild
}

extension KeyboardReadiness {
  var installed: Bool {
    if case .missing = self { return false }
    return true
  }

  var registered: Bool {
    switch self {
    case .missing, .installedUnregistered: return false
    default: return true
    }
  }

  var enabled: Bool {
    switch self {
    case .missing, .installedUnregistered, .approvalRequired: return false
    default: return true
    }
  }

  var selected: Bool {
    switch self {
    case .selectedUntested, .healthy, .degraded: return true
    default: return false
    }
  }

  var running: Bool {
    if case .healthy = self { return true }
    return false
  }

  var buildVerification: KeyboardBuildVerification {
    switch self {
    case .healthy: return .matched
    case .degraded(.wrongBuild): return .mismatched
    default: return .notChecked
    }
  }

  var primaryAction: KeyboardPrimaryAction {
    switch self {
    case .missing: return .showInstallLocation
    case .installedUnregistered: return .register
    case .approvalRequired: return .enable
    case .enabledNotSelected: return .select
    case .selectedUntested: return .verify
    case .healthy: return .write
    case .degraded(let failure):
      switch failure {
      case .wrongSchema, .wrongBundle, .wrongBuild: return .replaceBuild
      case .unreadableHealth, .wrongConnection, .processExited, .controllerMissing: return .reconnect
      }
    }
  }

  var recoveryPlan: KeyboardRecoveryPlan {
    switch self {
    case .missing: return .install
    case .installedUnregistered: return .register
    case .approvalRequired: return .enable
    case .enabledNotSelected: return .select
    case .selectedUntested: return .verify
    case .healthy: return .ready
    case .degraded(let failure):
      switch failure {
      case .wrongSchema, .wrongBundle, .wrongBuild: return .replaceBuild
      case .unreadableHealth, .wrongConnection, .processExited, .controllerMissing: return .reconnect
      }
    }
  }
}

struct CompanionNotice: Identifiable, Equatable {
  enum Severity: Equatable {
    case success
    case information
    case warning
    case error
  }

  let id: UUID
  let severity: Severity
  let message: String

  init(_ message: String, severity: Severity) {
    id = UUID()
    self.severity = severity
    self.message = message
  }
}

private struct RuntimeHealthRecord: Decodable {
  let schemaVersion: Int
  let bundleIdentifier: String
  let bundleVersion: String
  let connectionName: String
  let processIdentifier: Int32
  let executableStartedAt: Date
  let serverStartedAt: Date?
  let controllerInitializedAt: Date?
  let controllerActivatedAt: Date?
  let controllerInstanceIdentifier: String?
  let activationIdentifier: String?
  let controllerIsActive: Bool?
  let controllerDeactivatedAt: Date?
  let lastGhostOfferedAt: Date?
  let lastGhostAcceptedAt: Date?
  let ghostSuppressionCounts: [String: Int]?
}

enum GhostSuppressionReason: String, CaseIterable, Equatable {
  case preferenceDisabled = "preference-disabled"
  case noEligibleCompletion = "no-eligible-completion"
  case compositionChanged = "composition-changed"
  case compositionOwnerChanged = "composition-owner-changed"
  case hostGeometryUnavailable = "host-geometry-unavailable"
  case presentationUnavailable = "presentation-unavailable"
  case candidateListRequested = "candidate-list-requested"
}

struct GhostRuntimeEvidence: Equatable {
  static let maximumCountPerReason = 10_000
  static let none = GhostRuntimeEvidence()

  let lastOfferedAt: Date?
  let lastAcceptedAt: Date?
  let controllerIsActive: Bool
  let suppressionCounts: [GhostSuppressionReason: Int]

  init(
    lastOfferedAt: Date? = nil,
    lastAcceptedAt: Date? = nil,
    controllerIsActive: Bool = false,
    rawSuppressionCounts: [String: Int] = [:]
  ) {
    self.lastOfferedAt = lastOfferedAt
    self.lastAcceptedAt = lastOfferedAt == nil ? nil : lastAcceptedAt
    self.controllerIsActive = controllerIsActive
    var sanitized: [GhostSuppressionReason: Int] = [:]
    for reason in GhostSuppressionReason.allCases {
      guard let value = rawSuppressionCounts[reason.rawValue] else { continue }
      sanitized[reason] = min(max(value, 0), Self.maximumCountPerReason)
    }
    suppressionCounts = sanitized
  }

  var suppressionTotal: Int {
    suppressionCounts.values.reduce(0, +)
  }
}

private struct KeyboardRuntimeSnapshot {
  let readiness: KeyboardReadiness
  let ghostEvidence: GhostRuntimeEvidence
}

private struct ValidatedKeyboardBundle {
  let bundle: Bundle
  let executableURL: URL
  let shortVersion: String?
  let buildVersion: String
  let codeDirectoryHash: Data
}

struct NativeKeyboardStatus: Equatable {
  enum Signature: Equatable {
    case developerID(String)
    case adHoc
    case unsigned
    case unavailable
  }

  enum NeuralRuntime: Equatable {
    case claimedProduction
    case experimental
    case gated
    case unavailable
  }

  var version: String?
  var sourceCount = 0
  var signature: Signature = .unavailable
  var deterministicEngineReady = false
  var engineContractVersion: Int?
  var dictionaryBytes: Int64 = 0
  var neuralRuntime: NeuralRuntime = .unavailable
  var neuralArtifact: String?
  var ghostEvidence = GhostRuntimeEvidence.none
  var readiness: KeyboardReadiness = .missing
  var lastChecked = Date()

  // `readiness` is the single lifecycle authority. These facts must never be
  // stored independently, because a bundle on disk is not proof that macOS has
  // registered, enabled, selected or connected the input method.
  var installed: Bool { readiness.installed }
  var registered: Bool { readiness.registered }
  var enabled: Bool { readiness.enabled }
  var selected: Bool { readiness.selected }
  var running: Bool { readiness.running }
  var buildVerification: KeyboardBuildVerification { readiness.buildVerification }
  var primaryAction: KeyboardPrimaryAction { readiness.primaryAction }
  var recoveryPlan: KeyboardRecoveryPlan { readiness.recoveryPlan }
}

private struct InputSourceSnapshot: Sendable {
  let registered: Bool
  let enabled: Bool
  let selected: Bool
  let sourceCount: Int
}

@MainActor
final class LekhCompanionModel: ObservableObject {
  nonisolated static let inputMethodBundleIdentifier = "com.lekh.inputmethod.LekhKeyboard"
  nonisolated static let inputSourceIdentifier = "com.lekh.inputmethod.LekhKeyboard.Main"
  nonisolated static let preferenceChangedNotification = "com.lekh.inputmethod.preferences.changed"
  nonisolated static let personalizationResetEpochKey = "LekhPersonalizationResetEpoch"

  enum PreferenceKey {
    static let mode = "LekhNativeTypingMode"
    static let modeChosen = "LekhNativeTypingModeChosen.v2"
    static let inlinePreview = "LekhInlinePreviewEnabled"
    static let candidatePanel = "LekhCustomCandidatePanelEnabled"
    static let proofread = "LekhProofreadAsYouTypeEnabled"
    static let punctuation = "LekhSmartPunctuationEnabled"
    static let personalization = "LekhPersonalizationEnabled"
    static let nextWord = "LekhNextWordPredictionEnabled"
    static let excludedApplications = "LekhExcludedApplicationBundleIdentifiers"
  }

  @Published var locale: CompanionLocale
  @Published private(set) var status = NativeKeyboardStatus()
  @Published private(set) var preferences = CompanionPreferences()
  @Published private(set) var isRefreshing = false
  @Published private(set) var learnedEntryCount = 0
  @Published private(set) var isClearingLearning = false
  @Published private(set) var excludedApplications: [ExcludedApplication] = []
  @Published var notice: CompanionNotice?

  private let preferenceDefaults: UserDefaults
  private var refreshTask: Task<Void, Never>?
  private var noticeDismissTask: Task<Void, Never>?
  private var workspaceObservers: [NSObjectProtocol] = []

  init() {
    preferenceDefaults = UserDefaults(suiteName: Self.inputMethodBundleIdentifier) ?? .standard
    let savedLocale = UserDefaults.standard.string(forKey: "LekhCompanionLocale")
    if let savedLocale, let parsed = CompanionLocale(rawValue: savedLocale) {
      locale = parsed
    } else {
      locale = Locale.current.language.languageCode?.identifier == "ne" ? .nepali : .english
    }
    loadPreferences()
    observeWorkspace()
    refresh()
  }

  deinit {
    for observer in workspaceObservers {
      NSWorkspace.shared.notificationCenter.removeObserver(observer)
    }
    refreshTask?.cancel()
    noticeDismissTask?.cancel()
  }

  func setLocale(_ locale: CompanionLocale) {
    self.locale = locale
    UserDefaults.standard.set(locale.rawValue, forKey: "LekhCompanionLocale")
  }

  func refresh() {
    refreshTask?.cancel()
    isRefreshing = true
    refreshTask = Task { [weak self] in
      guard let self else { return }
      guard !Task.isCancelled else { return }
      // HIToolbox requires every TIS/TSM call in a UI process to run on the main
      // thread. Capture this small snapshot here, then keep file, signature and
      // SQLite work off the main actor.
      let inputSourceSnapshot = Self.readInputSourceSnapshot()
      guard !Task.isCancelled else { return }
      let snapshot = await Task.detached(priority: .userInitiated) {
        (
          status: Self.readNativeStatus(inputSources: inputSourceSnapshot),
          learnedEntryCount: Self.readLearnedEntryCount()
        )
      }.value
      guard !Task.isCancelled else { return }
      self.status = snapshot.status
      self.loadPreferences()
      self.learnedEntryCount = snapshot.learnedEntryCount
      self.isRefreshing = false
    }
  }

  func refreshIfStale() {
    guard Date().timeIntervalSince(status.lastChecked) > 1.0, !isRefreshing else { return }
    refresh()
  }

  func setMode(_ mode: NativeTypingMode) {
    preferences.mode = mode
    preferenceDefaults.set(mode.rawValue, forKey: PreferenceKey.mode)
    preferenceDefaults.set(true, forKey: PreferenceKey.modeChosen)
    persistPreferenceChange()
    showNotice(copy.saved, severity: .success)
  }

  func setInlinePreview(_ value: Bool) {
    preferences.inlinePreviewEnabled = value
    write(value, key: PreferenceKey.inlinePreview)
  }

  func setCandidatePanel(_ value: Bool) {
    preferences.customCandidatePanelEnabled = value
    write(value, key: PreferenceKey.candidatePanel)
  }

  func setProofread(_ value: Bool) {
    preferences.proofreadAsYouTypeEnabled = value
    write(value, key: PreferenceKey.proofread)
  }

  func setPunctuation(_ value: Bool) {
    preferences.smartPunctuationEnabled = value
    write(value, key: PreferenceKey.punctuation)
  }

  func setPersonalization(_ value: Bool) {
    preferences.personalizationEnabled = value
    write(value, key: PreferenceKey.personalization)
  }

  func setNextWord(_ value: Bool) {
    preferences.nextWordPredictionEnabled = value
    write(value, key: PreferenceKey.nextWord)
  }

  func openKeyboardSettings(preserveNotice: Bool = false) {
    guard let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") else { return }
    NSWorkspace.shared.open(url)
    if !preserveNotice {
      showNotice(copy.returnToRefresh, severity: .information)
    }
  }

  func activateKeyboard() {
    guard let source = Self.inputSources(includeAllInstalled: true).first else {
      openKeyboardSettings()
      return
    }
    let enableStatus = TISEnableInputSource(source)
    let selectStatus = enableStatus == noErr ? TISSelectInputSource(source) : enableStatus
    if selectStatus == noErr {
      showNotice(copy.keyboardActivated, severity: .success)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.refresh() }
    } else {
      showNotice(copy.activationFailed, severity: .error)
      openKeyboardSettings(preserveNotice: true)
    }
  }

  func performPrimaryAction() {
    switch status.primaryAction {
    case .showInstallLocation, .replaceBuild:
      revealInputMethod()
    case .register:
      registerKeyboard()
    case .enable, .select:
      activateKeyboard()
    case .verify, .write, .reconnect:
      openPracticeApp()
    }
  }

  func registerKeyboard() {
    guard Self.validatedInstalledBundle() != nil else {
      showNotice(copy.registrationBundleInvalid, severity: .error)
      revealInputMethod()
      return
    }
    let registrationStatus = TISRegisterInputSource(Self.installedBundleURL as CFURL)
    guard registrationStatus == noErr else {
      showNotice(copy.registrationFailed, severity: .error)
      openKeyboardSettings(preserveNotice: true)
      return
    }
    showNotice(copy.registrationSucceeded, severity: .success)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      self?.refresh()
    }
  }

  func openPracticeApp() {
    let candidates = [
      URL(fileURLWithPath: "/System/Applications/TextEdit.app"),
      URL(fileURLWithPath: "/Applications/TextEdit.app")
    ]
    guard let appURL = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else { return }
    NSWorkspace.shared.openApplication(at: appURL, configuration: .init()) { _, _ in }
  }

  func revealInputMethod() {
    let url = Self.installedBundleURL
    if FileManager.default.fileExists(atPath: url.path) {
      NSWorkspace.shared.activateFileViewerSelecting([url])
    } else {
      NSWorkspace.shared.open(url.deletingLastPathComponent())
    }
  }

  func copyDiagnostics() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(diagnosticsText, forType: .string)
    showNotice(copy.diagnosticsCopied, severity: .success)
  }

  func clearPersonalization() {
    guard !isClearingLearning else { return }
    isClearingLearning = true
    Task { [weak self] in
      let cleared = await Task.detached(priority: .userInitiated) {
        Self.clearPersonalizationDatabase()
      }.value
      guard let self else { return }
      if cleared {
        self.preferenceDefaults.set(Date().timeIntervalSince1970, forKey: Self.personalizationResetEpochKey)
        self.persistPreferenceChange()
        self.learnedEntryCount = 0
        self.showNotice(self.copy.learningCleared, severity: .success)
      } else {
        self.showNotice(self.copy.learningClearFailed, severity: .error)
      }
      self.isClearingLearning = false
    }
  }

  func chooseExcludedApplications() {
    let panel = NSOpenPanel()
    panel.title = copy.chooseExcludedApplications
    panel.prompt = copy.addApplications
    panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
    panel.allowedContentTypes = [.applicationBundle]
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.treatsFilePackagesAsDirectories = false
    panel.begin { [weak self] response in
      guard response == .OK else { return }
      Task { @MainActor in
        guard let self else { return }
        var identifiers = Set(self.excludedApplications.map(\.bundleIdentifier))
        for url in panel.urls.prefix(25) {
          if let identifier = Bundle(url: url)?.bundleIdentifier, Self.isValidBundleIdentifier(identifier) {
            identifiers.insert(identifier)
          }
        }
        self.persistExcludedApplications(Array(identifiers).sorted())
      }
    }
  }

  func removeExcludedApplication(_ application: ExcludedApplication) {
    persistExcludedApplications(
      excludedApplications.map(\.bundleIdentifier).filter { $0 != application.bundleIdentifier }
    )
  }

  var copy: CompanionCopy { CompanionCopy(locale: locale) }

  var diagnosticsText: String {
    let signature: String
    switch status.signature {
    case .developerID(let authority): signature = "Developer ID: \(authority)"
    case .adHoc: signature = "Ad-hoc development signature"
    case .unsigned: signature = "Unsigned"
    case .unavailable: signature = "Unavailable"
    }
    let contractVersion = status.engineContractVersion.map(String.init) ?? "unknown"
    let neuralArtifact = status.neuralArtifact ?? "not packaged"
    let ghostOffered = status.ghostEvidence.lastOfferedAt == nil ? "no" : "yes"
    let ghostAcceptanceHandled = status.ghostEvidence.lastAcceptedAt == nil ? "no" : "yes"
    let ghostSuppressions = GhostSuppressionReason.allCases.compactMap { reason -> String? in
      guard let count = status.ghostEvidence.suppressionCounts[reason], count > 0 else { return nil }
      return "\(reason.rawValue)=\(count)"
    }.joined(separator: ",")
    return [
      "Lekh Keyboard Companion diagnostics",
      "Generated: \(ISO8601DateFormatter().string(from: Date()))",
      "Installed: \(status.installed)",
      "Registered: \(status.registered)",
      "Enabled: \(status.enabled)",
      "Selected: \(status.selected)",
      "Engine running: \(status.running)",
      "Runtime build: \(Self.diagnosticBuildLabel(status.buildVerification))",
      "Readiness: \(Self.diagnosticReadinessLabel(status.readiness))",
      "Version: \(status.version ?? "unknown")",
      "Registered sources: \(status.sourceCount)",
      "Signature: \(signature)",
      "Deterministic engine ready: \(status.deterministicEngineReady)",
      "Engine contract: \(contractVersion)",
      "Dictionary bytes: \(status.dictionaryBytes)",
      "Neural fallback: \(Self.diagnosticNeuralLabel(status.neuralRuntime))",
      "Neural artifact: \(neuralArtifact)",
      "Controller currently active: \(status.ghostEvidence.controllerIsActive ? "yes" : "no")",
      "Ghost offered in most recent verified activation: \(ghostOffered)",
      "Ghost explicit acceptance handled in most recent verified activation: \(ghostAcceptanceHandled)",
      "Most recent activation suppression counters: \(ghostSuppressions.isEmpty ? "none" : ghostSuppressions)",
      "Mode: \(preferences.mode.rawValue)",
      "Personal entries: \(learnedEntryCount)",
      "Privacy: this diagnostic evidence contains no typed or candidate text"
    ].joined(separator: "\n")
  }

  private func write(_ value: Bool, key: String) {
    preferenceDefaults.set(value, forKey: key)
    persistPreferenceChange()
    showNotice(copy.saved, severity: .success)
  }

  private func showNotice(_ message: String, severity: CompanionNotice.Severity) {
    noticeDismissTask?.cancel()
    let next = CompanionNotice(message, severity: severity)
    notice = next
    guard severity == .success else { return }
    noticeDismissTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      guard !Task.isCancelled, self?.notice?.id == next.id else { return }
      self?.notice = nil
    }
  }

  private func persistPreferenceChange() {
    preferenceDefaults.synchronize()
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(Self.preferenceChangedNotification as CFString),
      nil,
      nil,
      true
    )
  }

  private func loadPreferences() {
    let mode = preferenceDefaults.string(forKey: PreferenceKey.mode)
      .flatMap(NativeTypingMode.init(rawValue:)) ?? .romanizedNepali
    preferences = CompanionPreferences(
      mode: mode,
      inlinePreviewEnabled: boolPreference(PreferenceKey.inlinePreview, fallback: true),
      customCandidatePanelEnabled: boolPreference(PreferenceKey.candidatePanel, fallback: true),
      proofreadAsYouTypeEnabled: boolPreference(PreferenceKey.proofread, fallback: true),
      smartPunctuationEnabled: boolPreference(PreferenceKey.punctuation, fallback: true),
      personalizationEnabled: boolPreference(PreferenceKey.personalization, fallback: true),
      nextWordPredictionEnabled: boolPreference(PreferenceKey.nextWord, fallback: true)
    )
    let identifiers = preferenceDefaults.stringArray(forKey: PreferenceKey.excludedApplications) ?? []
    excludedApplications = identifiers
      .filter(Self.isValidBundleIdentifier)
      .map(Self.resolveApplication)
      .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
  }

  private func persistExcludedApplications(_ identifiers: [String]) {
    let safe = Array(Set(identifiers.filter(Self.isValidBundleIdentifier))).sorted().prefix(100)
    preferenceDefaults.set(Array(safe), forKey: PreferenceKey.excludedApplications)
    persistPreferenceChange()
    loadPreferences()
    showNotice(copy.exclusionsSaved, severity: .success)
  }

  private func boolPreference(_ key: String, fallback: Bool) -> Bool {
    preferenceDefaults.object(forKey: key) == nil ? fallback : preferenceDefaults.bool(forKey: key)
  }

  private func observeWorkspace() {
    let center = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didWakeNotification] {
      workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in self?.refreshIfStale() }
      })
    }
  }

  nonisolated private static var installedBundleURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Input Methods/Lekh Keyboard.app", isDirectory: true)
  }

  nonisolated private static func validatedInstalledBundle() -> ValidatedKeyboardBundle? {
    let url = installedBundleURL
    guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
          values.isDirectory == true,
          values.isSymbolicLink != true,
          let bundle = Bundle(url: url),
          bundle.bundleIdentifier == inputMethodBundleIdentifier,
          bundle.object(forInfoDictionaryKey: "InputMethodConnectionName") as? String ==
            "com.lekh.inputmethod.LekhKeyboard_Connection",
          let modes = bundle.object(forInfoDictionaryKey: "ComponentInputModeDict") as? [String: Any],
          let modeList = modes["tsInputModeListKey"] as? [String: Any],
          modeList[inputSourceIdentifier] != nil,
          let executableURL = bundle.executableURL,
          let executableValues = try? executableURL.resourceValues(forKeys: [.isRegularFileKey]),
          executableValues.isRegularFile == true,
          let buildVersion = (bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
            ?? (bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? NSNumber)?.stringValue,
          !buildVersion.isEmpty,
          let codeDirectoryHash = staticCodeDirectoryHash(url) else {
      return nil
    }
    let shortVersion = (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
      ?? (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? NSNumber)?.stringValue
    return ValidatedKeyboardBundle(
      bundle: bundle,
      executableURL: executableURL,
      shortVersion: shortVersion,
      buildVersion: buildVersion,
      codeDirectoryHash: codeDirectoryHash
    )
  }

  nonisolated private static func staticCodeDirectoryHash(_ url: URL) -> Data? {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
          let staticCode,
          SecStaticCodeCheckValidity(staticCode, [], nil) == errSecSuccess else { return nil }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(
      staticCode,
      SecCSFlags(rawValue: kSecCSSigningInformation),
      &information
    ) == errSecSuccess,
      let dictionary = information as? [String: Any] else { return nil }
    return dictionary[kSecCodeInfoUnique as String] as? Data
  }

  nonisolated private static func processCodeDirectoryHash(_ processIdentifier: Int32) -> Data? {
    guard processIdentifier > 0 else { return nil }
    let attributes = [
      kSecGuestAttributePid as String: NSNumber(value: processIdentifier)
    ] as CFDictionary
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
          let code,
          SecCodeCheckValidity(code, [], nil) == errSecSuccess else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
          let staticCode else { return nil }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(
      staticCode,
      SecCSFlags(rawValue: kSecCSSigningInformation),
      &information
    ) == errSecSuccess,
      let dictionary = information as? [String: Any] else { return nil }
    return dictionary[kSecCodeInfoUnique as String] as? Data
  }

  nonisolated private static func processExecutablePath(_ processIdentifier: Int32) -> String? {
    guard processIdentifier > 0 else { return nil }
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let length = buffer.withUnsafeMutableBufferPointer { pointer in
      proc_pidpath(processIdentifier, pointer.baseAddress, UInt32(pointer.count))
    }
    guard length > 0 else { return nil }
    return String(cString: buffer)
  }

  nonisolated private static func processStartDate(_ processIdentifier: Int32) -> Date? {
    guard processIdentifier > 0 else { return nil }
    var info = proc_bsdinfo()
    let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    let actualSize = withUnsafeMutablePointer(to: &info) { pointer in
      proc_pidinfo(
        processIdentifier,
        PROC_PIDTBSDINFO,
        0,
        UnsafeMutableRawPointer(pointer),
        expectedSize
      )
    }
    guard actualSize == expectedSize, info.pbi_start_tvsec > 0 else { return nil }
    return Date(
      timeIntervalSince1970: TimeInterval(info.pbi_start_tvsec) +
        TimeInterval(info.pbi_start_tvusec) / 1_000_000
    )
  }

  nonisolated private static func canonicalPath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
  }

  nonisolated private static func readNativeStatus(
    inputSources: InputSourceSnapshot
  ) -> NativeKeyboardStatus {
    let bundleURL = installedBundleURL
    let validatedBundle = validatedInstalledBundle()
    let installed = validatedBundle != nil
    let bundle = validatedBundle?.bundle
    let version = validatedBundle?.shortVersion
    let bundleVersion = validatedBundle?.buildVersion
    let resources = bundleURL.appendingPathComponent("Contents/Resources", isDirectory: true)
    let dictionaryURL = resources.appendingPathComponent("runtime-suggestions.lkb")
    let contractURL = resources.appendingPathComponent("lekh-engine-contract.v1.json")
    let tokenCandidatesURL = resources.appendingPathComponent("lekh-token-candidates.v1.json")
    let manifestURL = resources.appendingPathComponent("LekhNeuralTransliterator.manifest.json")
    let vocabURL = resources.appendingPathComponent("LekhNeuralTransliterator.vocab.json")
    let contract = readJSON(contractURL)
    let manifest = readJSON(manifestURL)
    let productionEligible = manifest?["productionEligible"] as? Bool == true
    let experimentalEnabled = bundle?.object(forInfoDictionaryKey: "LekhExperimentalNeuralTypingEnabled") as? Bool == true
    let neuralAssetsPresent = neuralRuntimeAssetsPresent(
      manifest: manifest,
      resources: resources,
      vocabulary: vocabURL
    )
    let neuralRuntime: NativeKeyboardStatus.NeuralRuntime
    if neuralAssetsPresent && productionEligible {
      neuralRuntime = .claimedProduction
    } else if neuralAssetsPresent && experimentalEnabled {
      neuralRuntime = .experimental
    } else if neuralAssetsPresent {
      neuralRuntime = .gated
    } else {
      neuralRuntime = .unavailable
    }
    let runtime = readKeyboardRuntimeSnapshot(
      installed: installed,
      sourceCount: inputSources.sourceCount,
      registered: inputSources.registered,
      enabled: inputSources.enabled,
      selected: inputSources.selected,
      installedBundleVersion: bundleVersion,
      expectedExecutableURL: validatedBundle?.executableURL,
      installedCodeDirectoryHash: validatedBundle?.codeDirectoryHash
    )
    return NativeKeyboardStatus(
      version: version,
      sourceCount: inputSources.sourceCount,
      signature: installed ? signatureStatus(bundleURL) : .unavailable,
      deterministicEngineReady: FileManager.default.fileExists(atPath: dictionaryURL.path) &&
        contract != nil && FileManager.default.fileExists(atPath: tokenCandidatesURL.path),
      engineContractVersion: contract?["schemaVersion"] as? Int,
      dictionaryBytes: fileBytes(dictionaryURL),
      neuralRuntime: neuralRuntime,
      neuralArtifact: manifest?["selectedArtifact"] as? String,
      ghostEvidence: runtime.ghostEvidence,
      readiness: runtime.readiness,
      lastChecked: Date()
    )
  }

  nonisolated static func neuralRuntimeAssetsPresent(
    manifest: [String: Any]?,
    resources: URL,
    vocabulary: URL
  ) -> Bool {
    guard let manifest,
          FileManager.default.fileExists(atPath: vocabulary.path),
          let selectedArtifact = manifest["selectedArtifact"] as? String else {
      return false
    }
    if selectedArtifact == "lekh-open-vocab-seq2seq-v1" {
      guard manifest["runtimeModelContract"] == nil else { return false }
      return FileManager.default.fileExists(
        atPath: resources
          .appendingPathComponent(
            "LekhNeuralTransliterator.mlmodelc",
            isDirectory: true
          )
          .path
      )
    }
    if selectedArtifact == "lekh-open-vocab-ctc-transformer-v2" {
      guard manifest["runtimeModelContract"] as? String ==
              "single-transformer-ctc-v1",
            manifest["compiledModels"] == nil else {
        return false
      }
      return FileManager.default.fileExists(
        atPath: resources
          .appendingPathComponent(
            "LekhNeuralTransliterator.mlmodelc",
            isDirectory: true
          )
          .path
      )
    }
    guard selectedArtifact == "lekh-open-vocab-bigru-attention-v1",
          manifest["runtimeModelContract"] as? String ==
            "split-attention-incremental-v1",
          let compiledModels = manifest["compiledModels"] as? [String: Any],
          Set(compiledModels.keys) == Set(["encoder", "decoderStep"]) else {
      return false
    }
    let expectedNames = [
      "encoder": "LekhNeuralTransliteratorEncoder.mlmodelc",
      "decoderStep": "LekhNeuralTransliteratorDecoderStep.mlmodelc"
    ]
    return expectedNames.allSatisfy { role, expectedName in
      guard let artifact = compiledModels[role] as? [String: Any],
            let recordedPath = artifact["compiledModel"] as? String,
            URL(fileURLWithPath: recordedPath).lastPathComponent == expectedName else {
        return false
      }
      return FileManager.default.fileExists(
        atPath: resources
          .appendingPathComponent(expectedName, isDirectory: true)
          .path
      )
    }
  }

  nonisolated private static func readKeyboardRuntimeSnapshot(
    installed: Bool,
    sourceCount: Int,
    registered: Bool,
    enabled: Bool,
    selected: Bool,
    installedBundleVersion: String?,
    expectedExecutableURL: URL?,
    installedCodeDirectoryHash: Data?
  ) -> KeyboardRuntimeSnapshot {
    guard installed else {
      return KeyboardRuntimeSnapshot(readiness: .missing, ghostEvidence: .none)
    }
    guard registered, sourceCount > 0 else {
      return KeyboardRuntimeSnapshot(readiness: .installedUnregistered, ghostEvidence: .none)
    }
    guard enabled else {
      return KeyboardRuntimeSnapshot(readiness: .approvalRequired, ghostEvidence: .none)
    }
    guard selected else {
      return KeyboardRuntimeSnapshot(readiness: .enabledNotSelected, ghostEvidence: .none)
    }

    let healthURL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Lekh Keyboard/runtime-health.v1.json")
    guard FileManager.default.fileExists(atPath: healthURL.path) else {
      return KeyboardRuntimeSnapshot(readiness: .selectedUntested, ghostEvidence: .none)
    }
    guard let data = try? Data(contentsOf: healthURL) else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.unreadableHealth), ghostEvidence: .none)
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let health = try? decoder.decode(RuntimeHealthRecord.self, from: data) else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.unreadableHealth), ghostEvidence: .none)
    }
    guard health.schemaVersion == 1 else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.wrongSchema), ghostEvidence: .none)
    }
    guard health.bundleIdentifier == inputMethodBundleIdentifier else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.wrongBundle), ghostEvidence: .none)
    }
    guard health.bundleVersion == installedBundleVersion else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.wrongBuild), ghostEvidence: .none)
    }
    guard health.connectionName == "com.lekh.inputmethod.LekhKeyboard_Connection",
          health.serverStartedAt != nil else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.wrongConnection), ghostEvidence: .none)
    }
    guard let controllerInitializedAt = health.controllerInitializedAt,
          let controllerActivatedAt = health.controllerActivatedAt,
          let controllerInstanceIdentifier = health.controllerInstanceIdentifier,
          UUID(uuidString: controllerInstanceIdentifier) != nil,
          let activationIdentifier = health.activationIdentifier,
          UUID(uuidString: activationIdentifier) != nil,
          let controllerIsActive = health.controllerIsActive,
          let serverStartedAt = health.serverStartedAt,
          serverStartedAt >= health.executableStartedAt,
          controllerInitializedAt >= health.executableStartedAt,
          controllerActivatedAt >= controllerInitializedAt,
          controllerActivatedAt <= Date().addingTimeInterval(300) else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.controllerMissing), ghostEvidence: .none)
    }
    guard health.processIdentifier > 0,
          kill(health.processIdentifier, 0) == 0 || errno == EPERM else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.processExited), ghostEvidence: .none)
    }
    guard let expectedExecutableURL,
          let installedCodeDirectoryHash,
          let liveExecutablePath = processExecutablePath(health.processIdentifier),
          let liveProcessStartedAt = processStartDate(health.processIdentifier),
          health.executableStartedAt >= liveProcessStartedAt.addingTimeInterval(-1),
          health.executableStartedAt <= liveProcessStartedAt.addingTimeInterval(10),
          canonicalPath(liveExecutablePath) == canonicalPath(expectedExecutableURL.path),
          processCodeDirectoryHash(health.processIdentifier) == installedCodeDirectoryHash else {
      return KeyboardRuntimeSnapshot(readiness: .degraded(.wrongBuild), ghostEvidence: .none)
    }
    let maximumEvidenceDate = Date().addingTimeInterval(300)
    let evidenceUpperBound: Date
    if controllerIsActive {
      guard health.controllerDeactivatedAt == nil else {
        return KeyboardRuntimeSnapshot(readiness: .degraded(.controllerMissing), ghostEvidence: .none)
      }
      evidenceUpperBound = maximumEvidenceDate
    } else {
      guard let controllerDeactivatedAt = health.controllerDeactivatedAt,
            controllerDeactivatedAt >= controllerActivatedAt,
            controllerDeactivatedAt <= maximumEvidenceDate else {
        return KeyboardRuntimeSnapshot(readiness: .degraded(.controllerMissing), ghostEvidence: .none)
      }
      evidenceUpperBound = controllerDeactivatedAt
    }
    let lastGhostOfferedAt = health.lastGhostOfferedAt.flatMap { date in
      date >= controllerActivatedAt && date <= evidenceUpperBound ? date : nil
    }
    let lastGhostAcceptedAt: Date? = health.lastGhostAcceptedAt.flatMap { date -> Date? in
      guard lastGhostOfferedAt != nil,
            date >= controllerActivatedAt,
            date <= evidenceUpperBound else { return nil }
      return date
    }
    return KeyboardRuntimeSnapshot(
      readiness: .healthy(
        processIdentifier: health.processIdentifier,
        controllerInitializedAt: controllerInitializedAt
      ),
      ghostEvidence: GhostRuntimeEvidence(
        lastOfferedAt: lastGhostOfferedAt,
        lastAcceptedAt: lastGhostAcceptedAt,
        controllerIsActive: controllerIsActive,
        rawSuppressionCounts: health.ghostSuppressionCounts ?? [:]
      )
    )
  }

  nonisolated private static func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data),
          let dictionary = object as? [String: Any] else { return nil }
    return dictionary
  }

  nonisolated private static func fileBytes(_ url: URL) -> Int64 {
    let values = try? url.resourceValues(forKeys: [.fileSizeKey])
    return Int64(values?.fileSize ?? 0)
  }

  nonisolated private static func diagnosticNeuralLabel(_ runtime: NativeKeyboardStatus.NeuralRuntime) -> String {
    switch runtime {
    case .claimedProduction: return "manifest-claims-production-unverified"
    case .experimental: return "experimental"
    case .gated: return "gated"
    case .unavailable: return "unavailable"
    }
  }

  nonisolated private static func diagnosticReadinessLabel(_ readiness: KeyboardReadiness) -> String {
    switch readiness {
    case .missing: return "missing"
    case .installedUnregistered: return "installed-unregistered"
    case .approvalRequired: return "approval-required"
    case .enabledNotSelected: return "enabled-not-selected"
    case .selectedUntested: return "selected-unverified"
    case .healthy(let processIdentifier, _): return "healthy-pid-\(processIdentifier)"
    case .degraded(let failure): return "degraded-\(failure.rawValue)"
    }
  }

  nonisolated private static func diagnosticBuildLabel(
    _ verification: KeyboardBuildVerification
  ) -> String {
    switch verification {
    case .notChecked: return "not-verified"
    case .matched: return "matches-installed-build"
    case .mismatched: return "mismatch"
    }
  }

  private static func readInputSourceSnapshot() -> InputSourceSnapshot {
    let registeredSources = inputSources(includeAllInstalled: true)
    let enabledSources = inputSources(includeAllInstalled: false)
    let registered = !registeredSources.isEmpty
    let enabled = enabledSources.contains(where: { boolProperty($0, kTISPropertyInputSourceIsEnabled) })
    let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    let currentID = stringProperty(current, kTISPropertyInputSourceID)
    let selected = currentID == inputSourceIdentifier || currentID.hasPrefix("\(inputMethodBundleIdentifier).")
    // Preserve duplicate registrations in diagnostics instead of collapsing
    // identical IDs; duplicate bundles are precisely the stale-install state
    // users need the companion to expose.
    let sourceCount = registeredSources.count
    return InputSourceSnapshot(
      registered: registered,
      enabled: enabled,
      selected: selected,
      sourceCount: sourceCount
    )
  }

  private static func inputSources(includeAllInstalled: Bool) -> [TISInputSource] {
    guard let unmanaged = TISCreateInputSourceList(nil, includeAllInstalled) else { return [] }
    let all = unmanaged.takeRetainedValue() as NSArray
    return (all as! [TISInputSource]).filter {
      let identifier = stringProperty($0, kTISPropertyInputSourceID)
      return identifier == inputSourceIdentifier
    }
  }

  private static func stringProperty(_ source: TISInputSource, _ key: CFString) -> String {
    guard let pointer = TISGetInputSourceProperty(source, key) else { return "" }
    return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
  }

  private static func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
    guard let pointer = TISGetInputSourceProperty(source, key) else { return false }
    return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(pointer).takeUnretainedValue())
  }

  nonisolated private static func signatureStatus(_ url: URL) -> NativeKeyboardStatus.Signature {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
          let staticCode else { return .unsigned }
    var information: CFDictionary?
    guard SecStaticCodeCheckValidity(staticCode, [], nil) == errSecSuccess else { return .unsigned }
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let dictionary = information as? [String: Any] else { return .unsigned }
    if let certificates = dictionary[kSecCodeInfoCertificates as String] as? [SecCertificate],
       let leaf = certificates.first,
       let summary = SecCertificateCopySubjectSummary(leaf) as String?,
       summary.hasPrefix("Developer ID Application:") {
      return .developerID(summary)
    }
    return certificatesAreAbsent(dictionary) ? .adHoc : .unsigned
  }

  nonisolated private static func isValidBundleIdentifier(_ identifier: String) -> Bool {
    identifier.range(
      of: #"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"#,
      options: .regularExpression
    ) != nil
  }

  nonisolated private static func resolveApplication(_ identifier: String) -> ExcludedApplication {
    let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier)
    let bundle = url.flatMap(Bundle.init(url:))
    let name = bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
      ?? url?.deletingPathExtension().lastPathComponent
      ?? identifier
    return ExcludedApplication(bundleIdentifier: identifier, displayName: name)
  }

  nonisolated private static func certificatesAreAbsent(_ dictionary: [String: Any]) -> Bool {
    (dictionary[kSecCodeInfoCertificates as String] as? [SecCertificate])?.isEmpty != false
  }

  nonisolated private static var databaseURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Lekh Keyboard/lekh-keyboard.sqlite3")
  }

  nonisolated private static func readLearnedEntryCount() -> Int {
    var database: OpaquePointer?
    guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
          let database else {
      sqlite3_close(database)
      return 0
    }
    defer { sqlite3_close(database) }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, "SELECT COUNT(*) FROM user_lexicon WHERE blocked = 0", -1, &statement, nil) == SQLITE_OK else {
      sqlite3_finalize(statement)
      return 0
    }
    defer { sqlite3_finalize(statement) }
    return sqlite3_step(statement) == SQLITE_ROW ? Int(sqlite3_column_int(statement, 0)) : 0
  }

  nonisolated private static func clearPersonalizationDatabase() -> Bool {
    var database: OpaquePointer?
    guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
          let database else {
      sqlite3_close(database)
      return false
    }
    defer { sqlite3_close(database) }
    sqlite3_busy_timeout(database, 1_500)
    guard sqlite3_exec(database, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { return false }
    guard sqlite3_exec(database, "DELETE FROM user_lexicon", nil, nil, nil) == SQLITE_OK,
          sqlite3_exec(database, "DELETE FROM user_bigrams", nil, nil, nil) == SQLITE_OK,
          sqlite3_exec(database, "COMMIT", nil, nil, nil) == SQLITE_OK else {
      sqlite3_exec(database, "ROLLBACK", nil, nil, nil)
      return false
    }
    // A live IMK process may temporarily hold a reader while this transaction
    // commits. The reset epoch posted immediately afterward clears its in-memory
    // state and orders a second truncate checkpoint on the IMK writer queue.
    _ = sqlite3_wal_checkpoint_v2(database, nil, SQLITE_CHECKPOINT_TRUNCATE, nil, nil)
    return true
  }
}
