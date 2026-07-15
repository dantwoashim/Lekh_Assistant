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

  var installed = false
  var enabled = false
  var selected = false
  var version: String?
  var sourceCount = 0
  var signature: Signature = .unavailable
  var deterministicEngineReady = false
  var engineContractVersion: Int?
  var dictionaryBytes: Int64 = 0
  var neuralRuntime: NeuralRuntime = .unavailable
  var neuralArtifact: String?
  var readiness: KeyboardReadiness = .missing
  var lastChecked = Date()
}

private struct InputSourceSnapshot: Sendable {
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

  @Published var selectedSection: CompanionSection {
    didSet { UserDefaults.standard.set(selectedSection.rawValue, forKey: "LekhCompanionSection") }
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
    selectedSection = UserDefaults.standard.string(forKey: "LekhCompanionSection")
      .flatMap(CompanionSection.init(rawValue:)) ?? .home
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
    guard let source = Self.inputSources().first else {
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
    return [
      "Lekh Keyboard Companion diagnostics",
      "Generated: \(ISO8601DateFormatter().string(from: Date()))",
      "Installed: \(status.installed)",
      "Enabled: \(status.enabled)",
      "Selected: \(status.selected)",
      "Readiness: \(Self.diagnosticReadinessLabel(status.readiness))",
      "Version: \(status.version ?? "unknown")",
      "Registered sources: \(status.sourceCount)",
      "Signature: \(signature)",
      "Deterministic engine ready: \(status.deterministicEngineReady)",
      "Engine contract: \(contractVersion)",
      "Dictionary bytes: \(status.dictionaryBytes)",
      "Neural fallback: \(Self.diagnosticNeuralLabel(status.neuralRuntime))",
      "Neural artifact: \(neuralArtifact)",
      "Mode: \(preferences.mode.rawValue)",
      "Personal entries: \(learnedEntryCount)",
      "Privacy: no typed text is included"
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

  nonisolated private static func readNativeStatus(
    inputSources: InputSourceSnapshot
  ) -> NativeKeyboardStatus {
    let bundleURL = installedBundleURL
    let installed = FileManager.default.fileExists(atPath: bundleURL.path)
    let bundle = installed ? Bundle(url: bundleURL) : nil
    let version = bundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    let bundleVersion = (bundle?.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
      ?? (bundle?.object(forInfoDictionaryKey: "CFBundleVersion") as? NSNumber)?.stringValue
    let resources = bundleURL.appendingPathComponent("Contents/Resources", isDirectory: true)
    let dictionaryURL = resources.appendingPathComponent("runtime-suggestions.lkb")
    let contractURL = resources.appendingPathComponent("lekh-engine-contract.v1.json")
    let tokenCandidatesURL = resources.appendingPathComponent("lekh-token-candidates.v1.json")
    let manifestURL = resources.appendingPathComponent("LekhNeuralTransliterator.manifest.json")
    let modelURL = resources.appendingPathComponent("LekhNeuralTransliterator.mlmodelc", isDirectory: true)
    let vocabURL = resources.appendingPathComponent("LekhNeuralTransliterator.vocab.json")
    let contract = readJSON(contractURL)
    let manifest = readJSON(manifestURL)
    let productionEligible = manifest?["productionEligible"] as? Bool == true
    let experimentalEnabled = bundle?.object(forInfoDictionaryKey: "LekhExperimentalNeuralTypingEnabled") as? Bool == true
    let neuralAssetsPresent = FileManager.default.fileExists(atPath: modelURL.path) &&
      FileManager.default.fileExists(atPath: vocabURL.path) && manifest != nil
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
    let readiness = readKeyboardReadiness(
      installed: installed,
      sourceCount: inputSources.sourceCount,
      enabled: inputSources.enabled,
      selected: inputSources.selected,
      installedBundleVersion: bundleVersion
    )
    return NativeKeyboardStatus(
      installed: installed,
      enabled: inputSources.enabled,
      selected: inputSources.selected,
      version: version,
      sourceCount: inputSources.sourceCount,
      signature: installed ? signatureStatus(bundleURL) : .unavailable,
      deterministicEngineReady: FileManager.default.fileExists(atPath: dictionaryURL.path) &&
        contract != nil && FileManager.default.fileExists(atPath: tokenCandidatesURL.path),
      engineContractVersion: contract?["schemaVersion"] as? Int,
      dictionaryBytes: fileBytes(dictionaryURL),
      neuralRuntime: neuralRuntime,
      neuralArtifact: manifest?["selectedArtifact"] as? String,
      readiness: readiness,
      lastChecked: Date()
    )
  }

  nonisolated private static func readKeyboardReadiness(
    installed: Bool,
    sourceCount: Int,
    enabled: Bool,
    selected: Bool,
    installedBundleVersion: String?
  ) -> KeyboardReadiness {
    guard installed else { return .missing }
    guard sourceCount > 0 else { return .installedUnregistered }
    guard enabled else { return .approvalRequired }
    guard selected else { return .enabledNotSelected }

    let healthURL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Lekh Keyboard/runtime-health.v1.json")
    guard FileManager.default.fileExists(atPath: healthURL.path) else {
      return .selectedUntested
    }
    guard let data = try? Data(contentsOf: healthURL) else {
      return .degraded(.unreadableHealth)
    }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let health = try? decoder.decode(RuntimeHealthRecord.self, from: data) else {
      return .degraded(.unreadableHealth)
    }
    guard health.schemaVersion == 1 else { return .degraded(.wrongSchema) }
    guard health.bundleIdentifier == inputMethodBundleIdentifier else { return .degraded(.wrongBundle) }
    guard health.bundleVersion == installedBundleVersion else { return .degraded(.wrongBuild) }
    guard health.connectionName == "com.lekh.inputmethod.LekhKeyboard_Connection",
          health.serverStartedAt != nil else { return .degraded(.wrongConnection) }
    guard let controllerInitializedAt = health.controllerInitializedAt,
          health.controllerActivatedAt != nil else { return .degraded(.controllerMissing) }
    guard kill(health.processIdentifier, 0) == 0 || errno == EPERM else {
      return .degraded(.processExited)
    }
    return .healthy(
      processIdentifier: health.processIdentifier,
      controllerInitializedAt: controllerInitializedAt
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

  private static func readInputSourceSnapshot() -> InputSourceSnapshot {
    let sources = inputSources()
    let enabled = sources.contains(where: { boolProperty($0, kTISPropertyInputSourceIsEnabled) })
    let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    let currentID = stringProperty(current, kTISPropertyInputSourceID)
    let selected = currentID == inputSourceIdentifier || currentID.hasPrefix("\(inputMethodBundleIdentifier).")
    let sourceCount = Set(sources.map { stringProperty($0, kTISPropertyInputSourceID) }).count
    return InputSourceSnapshot(enabled: enabled, selected: selected, sourceCount: sourceCount)
  }

  private static func inputSources() -> [TISInputSource] {
    guard let unmanaged = TISCreateInputSourceList(nil, false) else { return [] }
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
