import AppKit
import Carbon
import Foundation
import InputMethodKit
import OSLog

private let lekhLogger = Logger(subsystem: "com.lekh.inputmethod.keyboard", category: "imk")
private let lekhNativeModeDefaultsKey = LekhNativePreferences.Keys.nativeTypingMode
private let lekhNativeModeChosenDefaultsKey = LekhNativePreferences.Keys.nativeTypingModeChosen
private let lekhNativeModeDidChangeNotification = LekhNativePreferences.modeDidChangeNotification
private let lekhArrowUpKey = "\u{F700}"
private let lekhArrowDownKey = "\u{F701}"

func lekhNativeLog(_ message: String) {
  guard LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: IsSecureEventInputEnabled()) else { return }
  lekhLogger.debug("\(message, privacy: .private)")
}

public struct LekhInputDecision: Equatable {
  public let handled: Bool
  public let markedText: String?
  public let committedText: String?
  public let candidates: [String]
  public let shouldCancel: Bool
  public let shouldPassThrough: Bool

  public static let passThrough = LekhInputDecision(
    handled: false,
    markedText: nil,
    committedText: nil,
    candidates: [],
    shouldCancel: false,
    shouldPassThrough: true
  )
}

private struct LekhMarkedCompositionDisplay {
  let text: NSAttributedString
  let cursorLocation: Int
}

@objc(LekhInputController)
open class LekhInputController: IMKInputController {
  private let engineClient: LekhEngineClient
  private let latencyTelemetry = LekhLatencyRingBuffer()
  private let candidateState = LekhCandidateController()
  private let neuralCandidateService = LekhNeuralCandidateService.shared
  private var candidateSelectionExplicit = false
  private var candidatePanel: IMKCandidates?
  private let customCandidatePanel = LekhCandidatePanel()
  private let inlinePreviewPanel = LekhInlinePreviewPanel()
  private let layoutTranslator = LekhKeyboardLayoutTranslator.shared
  private var sessionId = UUID().uuidString
  private var nativeMode = LekhNativeTypingMode.romanizedTraditional
  private var modeMenuOpen = false
  private var modePromptPending = false
  private var usesInlineComposition: Bool {
    let value = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]?.lowercased()
    if value == "0" || value == "false" || value == "no" {
      return false
    }
    return true
  }

  public init(engineClient: LekhEngineClient = LekhNativeEngineClient()) {
    LekhNativePreferences.registerDefaults()
    self.engineClient = engineClient
    super.init()
    configureModeFromDefaults()
    observeNativeModeChanges()
  }

  public required override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
    LekhNativePreferences.registerDefaults()
    self.engineClient = Self.defaultEngineClient()
    super.init(server: server, delegate: delegate, client: inputClient)
    self.candidatePanel = IMKCandidates(server: server, panelType: kIMKSingleRowSteppingCandidatePanel)
    self.candidatePanel?.setDismissesAutomatically(true)
    configureModeFromDefaults()
    observeNativeModeChanges()
    lekhNativeLog("controller.init")
    logSelectorAvailability()
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  private static func defaultEngineClient() -> LekhEngineClient {
    return LekhNativeEngineClient()
  }

  private func logSelectorAvailability() {
    let selectors: [(String, Selector)] = [
      ("handleEvent", #selector(handle(_:client:))),
      ("inputText", #selector(inputText(_:client:))),
      ("inputTextKey", #selector(inputText(_:key:modifiers:client:))),
      ("didCommand", #selector(didCommand(by:client:))),
      ("recognizedEvents", #selector(recognizedEvents(_:)))
    ]
    let availability = selectors
      .map { "\($0.0)=\(responds(to: $0.1) ? 1 : 0)" }
      .joined(separator: " ")
    lekhNativeLog("controller.selectors class=\(NSStringFromClass(type(of: self))) \(availability)")
  }

  open override func recognizedEvents(_ sender: Any!) -> Int {
    Int(NSEvent.EventTypeMask.keyDown.rawValue)
  }

  open override func activateServer(_ sender: Any!) {
    configureModeFromDefaults()
    setKeyboardLayoutOverride()
    lekhNativeLog("lifecycle.activate")
    modeMenuOpen = false
    if shouldShowFirstModePicker() {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        LekhModePickerWindowController.shared.show(current: self.nativeMode) { [weak self] mode in
          self?.selectNativeMode(mode)
        }
      }
    }
  }

  open override func deactivateServer(_ sender: Any!) {
    lekhNativeLog("lifecycle.deactivate")
    hideCandidates()
    defer { engineClient.endSession(sessionId) }
    if IsSecureEventInputEnabled() {
      cancelLocalComposition(client: sender as? IMKTextInput)
      return
    }
    if modeMenuOpen {
      modeMenuOpen = false
      cancelLocalComposition(client: sender as? IMKTextInput)
      return
    }
    guard usesInlineComposition else {
      engineClient.resetSession(sessionId)
      return
    }
    if engineClient.hasComposition(sessionId: sessionId), let client = sender as? IMKTextInput {
      _ = commitCurrentComposition(client: client, suffix: "")
    } else {
      engineClient.resetSession(sessionId)
    }
  }

  open override func inputControllerWillClose() {
    lekhNativeLog("lifecycle.close")
    hideCandidates()
    engineClient.endSession(sessionId)
  }

  open override func commitComposition(_ sender: Any!) {
    if IsSecureEventInputEnabled() {
      cancelLocalComposition(client: sender as? IMKTextInput)
      return
    }
    if modeMenuOpen {
      modeMenuOpen = false
      cancelLocalComposition(client: sender as? IMKTextInput)
      return
    }
    guard usesInlineComposition else {
      engineClient.resetSession(sessionId)
      return
    }
    guard engineClient.hasComposition(sessionId: sessionId), let client = sender as? IMKTextInput else {
      return
    }
    _ = commitCurrentComposition(client: client, suffix: "")
  }

  open override func composedString(_ sender: Any!) -> Any! {
    engineClient.rawBuffer(sessionId: sessionId)
  }

  open override func originalString(_ sender: Any!) -> NSAttributedString! {
    NSAttributedString(string: engineClient.rawBuffer(sessionId: sessionId))
  }

  open override func inputText(_ string: String!, client sender: Any!) -> Bool {
    guard let string, !string.isEmpty else { return false }
    lekhNativeLog("event.inputText units=\(string.count)")

    var handledAny = false
    for character in string {
      let handled = processKeyInput(
        String(character),
        keyCode: -1,
        modifiers: [],
        client: sender,
        route: "inputText"
      )
      handledAny = handledAny || handled
    }
    return handledAny
  }

  open override func inputText(_ string: String!, key keyCode: Int, modifiers flags: Int, client sender: Any!) -> Bool {
    let modifiers = NSEvent.ModifierFlags(rawValue: UInt(flags)).intersection(.deviceIndependentFlagsMask)
    let key = keyString(from: string, keyCode: keyCode, modifiers: modifiers)
    lekhNativeLog("event.inputTextKey flags=\(flags) units=\(string?.count ?? 0)")
    guard !key.isEmpty else { return false }
    return processKeyInput(key, keyCode: keyCode, modifiers: modifiers, client: sender, route: "inputTextKey")
  }

  open override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
    guard let event, event.type == .keyDown else { return false }

    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    let key = keyString(from: event)
    guard !key.isEmpty else { return false }
    lekhNativeLog("event.handle route=handle")
    return processKeyInput(key, keyCode: Int(event.keyCode), modifiers: modifiers, client: sender, route: "handle")
  }

  private func processKeyInput(
    _ key: String,
    keyCode: Int,
    modifiers: NSEvent.ModifierFlags,
    client sender: Any!,
    route: String
  ) -> Bool {
    if IsSecureEventInputEnabled() {
      cancelLocalComposition(client: sender as? IMKTextInput)
      lekhNativeLog("event.passThrough route=\(route) reason=secureInput")
      return false
    }

    // Control+Option+1..4 switches Lekh modes directly.
    if modifiers.contains(.control),
       modifiers.contains(.option),
       let selectedMode = modeFromMenuKey(key, keyCode: keyCode) {
      selectNativeMode(selectedMode)
      modeMenuOpen = false
      return apply(modeSelectedDecision(selectedMode), client: sender, route: "modeHotkey")
    }

    // Control+Option+Space or Control+Option+M opens the Lekh mode selector.
    if modifiers.contains(.control), modifiers.contains(.option), keyCode == 49 || keyCode == 46 {
      showModePicker()
      return true
    }

    if modeMenuOpen {
      if let selectedMode = modeFromMenuKey(key, keyCode: keyCode) {
        selectNativeMode(selectedMode)
        modeMenuOpen = false
        engineClient.resetSession(sessionId)
        return apply(modeSelectedDecision(selectedMode), client: sender, route: "modeSelect")
      }
      if key == "\u{1b}" {
        modeMenuOpen = false
        markModePromptConsumed()
        return apply(cancelDecision(), client: sender, route: "modeCancel")
      }
      modeMenuOpen = false
      markModePromptConsumed()
      cancelLocalComposition(client: sender as? IMKTextInput)
    }

    if handleCandidateCommand(key, keyCode: keyCode, modifiers: modifiers, client: sender, route: route) {
      return true
    }

    if shouldPassThrough(modifiers: modifiers) {
      lekhNativeLog("event.passThrough route=\(route) reason=modifier")
      return false
    }

    if let optionText = traditionalOptionText(key: key, keyCode: keyCode, modifiers: modifiers) {
      return processKey(optionText, client: sender, route: "traditional.optionLayer")
    }

    if shouldPassThroughWithoutComposition(key: key) {
      lekhNativeLog("event.passThrough route=\(route) reason=noComposition")
      return false
    }

    if shouldCommitBeforePassingThrough(key: key), let client = sender as? IMKTextInput {
      if usesInlineComposition {
        _ = commitCurrentComposition(client: client, suffix: "")
      } else {
        engineClient.resetSession(sessionId)
      }
      lekhNativeLog("event.passThrough route=\(route) reason=unsupportedAfterCommit")
      return false
    }

    guard usesInlineComposition else {
      return processFailOpenKey(key, keyCode: keyCode, client: sender, route: route)
    }

    return processKey(key, client: sender, route: route)
  }

  open override func didCommand(by selector: Selector!, client sender: Any!) -> Bool {
    guard let selector else { return false }
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\u{1b}", keyCode: 53, client: sender, route: "command.cancel")
      }
      guard let client = sender as? IMKTextInput else { return false }
      return commitRawComposition(client: client, suffix: "")
    }
    if selector == #selector(NSResponder.deleteBackward(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\u{7f}", keyCode: 51, client: sender, route: "command.backspace")
      }
      return processKey("\u{7f}", client: sender, route: "command.backspace")
    }
    if selector == #selector(NSResponder.insertNewline(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\n", keyCode: 36, client: sender, route: "command.enter")
      }
      guard let client = sender as? IMKTextInput else { return false }
      return commitCurrentComposition(client: client, suffix: "\n")
    }
    if selector == #selector(NSResponder.insertTab(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\t", keyCode: 48, client: sender, route: "command.tab")
      }
      guard let client = sender as? IMKTextInput else { return false }
      if candidateSelectionExplicit {
        return commitSelectedCandidate(client: client, suffix: "")
      }
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }
    return false
  }

  open override func candidates(_ sender: Any!) -> [Any]! {
    guard !IsSecureEventInputEnabled() else { return [] }
    return candidateState.currentState().candidates
  }

  open override func candidateSelected(_ candidateString: NSAttributedString!) {
    guard let text = candidateString?.string, !text.isEmpty, let client = self.client() else {
      return
    }
    guard !IsSecureEventInputEnabled() else {
      cancelLocalComposition(client: client)
      return
    }
    if modeMenuOpen, let mode = modeFromMenuLabel(text) {
      selectNativeMode(mode)
      modeMenuOpen = false
      cancelLocalComposition(client: client)
      return
    }
    candidateSelectionExplicit = true
    commitCandidateText(text, client: client, suffix: "")
  }

  open override func candidateSelectionChanged(_ candidateString: NSAttributedString!) {
    guard !IsSecureEventInputEnabled() else {
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      hideCandidates()
      return
    }
    guard let text = candidateString?.string, !text.isEmpty else {
      return
    }
    if let index = candidateState.currentState().candidates.firstIndex(of: text) {
      candidateState.select(index: index)
      // IMK may emit this callback while updating/showing its panel. Only a
      // physical Arrow key or an explicit click/selection may authorize commit.
      refreshCandidatePanel()
    }
  }

  open override func menu() -> NSMenu! {
    let menu = NSMenu(title: LekhL10n.text("app.name"))
    if let warning = engineClient.securityWarning() {
      let warningItem = NSMenuItem(title: LekhL10n.text("menu.dictionaryWarning"), action: #selector(showDictionaryWarningFromInputMenu(_:)), keyEquivalent: "")
      warningItem.target = self
      warningItem.representedObject = warning
      menu.addItem(warningItem)
      menu.addItem(.separator())
    }
    for mode in LekhNativeTypingMode.visibleModes {
      let item = NSMenuItem(title: mode.menuLabel, action: #selector(selectModeFromInputMenu(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = mode.rawValue
      item.state = mode == nativeMode ? .on : .off
      menu.addItem(item)
    }
    if !IsSecureEventInputEnabled(), let currentCandidate = candidateState.selectedCandidate() {
      menu.addItem(.separator())
      let forget = NSMenuItem(title: LekhL10n.text("menu.forgetCandidate"), action: #selector(forgetCurrentCandidateFromInputMenu(_:)), keyEquivalent: "")
      forget.target = self
      forget.representedObject = currentCandidate
      menu.addItem(forget)
    }
    menu.addItem(.separator())
    let preferences = NSMenuItem(title: LekhL10n.text("menu.preferences"), action: #selector(showPreferencesFromInputMenu(_:)), keyEquivalent: "")
    preferences.target = self
    menu.addItem(preferences)

    let tutorial = NSMenuItem(title: LekhL10n.text("menu.tutorial"), action: #selector(showTutorialFromInputMenu(_:)), keyEquivalent: "")
    tutorial.target = self
    menu.addItem(tutorial)

    if LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: IsSecureEventInputEnabled()) {
      menu.addItem(.separator())
      let diagnostics = NSMenuItem(title: LekhL10n.text("menu.diagnostics"), action: #selector(showDiagnosticsFromInputMenu(_:)), keyEquivalent: "")
      diagnostics.target = self
      menu.addItem(diagnostics)
    }
    return menu
  }

  @objc private func selectModeFromInputMenu(_ item: NSMenuItem) {
    guard let rawValue = item.representedObject as? String,
          let mode = LekhNativeTypingMode(rawValue: rawValue) else {
      return
    }
    selectNativeMode(mode)
    modeMenuOpen = false
    if let client = self.client() {
      cancelLocalComposition(client: client)
    } else {
      engineClient.resetSession(sessionId)
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      hideCandidates()
    }
  }

  @objc private func forgetCurrentCandidateFromInputMenu(_ item: NSMenuItem) {
    guard !IsSecureEventInputEnabled() else {
      cancelLocalComposition(client: self.client())
      return
    }
    guard let candidate = item.representedObject as? String else { return }
    engineClient.forgetCandidate(sessionId: sessionId, chosenOutput: candidate)
    candidateState.updateCandidates(
      candidateState.currentState().candidates.filter { $0 != candidate },
      rawBuffer: engineClient.rawBuffer(sessionId: sessionId),
      modeLabel: nativeMode.menuLabel
    )
    hideCandidates()
    lekhNativeLog("candidate.forget length=\(candidate.utf16.count)")
  }

  @objc private func showDiagnosticsFromInputMenu(_ item: NSMenuItem) {
    let alert = NSAlert()
    alert.messageText = LekhL10n.text("diagnostics.title")
    alert.informativeText = [
      engineClient.diagnosticsSummary(),
      latencyTelemetry.summary(),
      "privacy=local-only; text and keystroke values are not recorded"
    ].joined(separator: "\n\n")
    alert.addButton(withTitle: LekhL10n.text("common.ok"))
    alert.runModal()
  }

  @objc private func showPreferencesFromInputMenu(_ item: NSMenuItem) {
    LekhPreferencesWindowController.shared.show { [weak self] in
      guard let self else { return "diagnostics=unavailable" }
      return [
        self.engineClient.diagnosticsSummary(),
        self.latencyTelemetry.summary()
      ].joined(separator: "\n\n")
    }
  }

  @objc private func showTutorialFromInputMenu(_ item: NSMenuItem) {
    LekhPreferencesWindowController.shared.showTutorial()
  }

  @objc private func showDictionaryWarningFromInputMenu(_ item: NSMenuItem) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = LekhL10n.text("dictionary.rejected.title")
    alert.informativeText = (item.representedObject as? String) ?? LekhL10n.text("dictionary.rejected.body")
    alert.addButton(withTitle: LekhL10n.text("common.ok"))
    alert.runModal()
  }

  private func engineDecision(for key: String, route: String) -> LekhInputDecision {
    let startedAt = DispatchTime.now().uptimeNanoseconds
    let decision = engineClient.processKey(
      key,
      sessionId: sessionId,
      mode: nativeMode
    )
    let duration = DispatchTime.now().uptimeNanoseconds - startedAt
    latencyTelemetry.record(
      route: route,
      durationNanoseconds: duration,
      candidateCount: decision.candidates.count,
      handled: decision.handled
    )
    return decision
  }

  private func processKey(_ key: String, client sender: Any!, route: String) -> Bool {
    let decision = engineDecision(for: key, route: route)
    return apply(decision, client: sender, route: route)
  }

  private func handleCandidateCommand(
    _ key: String,
    keyCode: Int,
    modifiers: NSEvent.ModifierFlags,
    client sender: Any!,
    route: String
  ) -> Bool {
    guard usesInlineComposition,
          engineClient.hasComposition(sessionId: sessionId),
          let client = sender as? IMKTextInput else {
      return false
    }

    if modifiers.contains(.command) || modifiers.contains(.control) || modifiers.contains(.option) {
      return false
    }

    if key == lekhArrowDownKey {
      _ = candidateState.moveSelection(delta: 1)
      candidateSelectionExplicit = true
      refreshCandidatePanel()
      lekhNativeLog("candidate.navigate route=\(route) direction=down")
      return true
    }

    if key == lekhArrowUpKey {
      _ = candidateState.moveSelection(delta: -1)
      candidateSelectionExplicit = true
      refreshCandidatePanel()
      lekhNativeLog("candidate.navigate route=\(route) direction=up")
      return true
    }

    if let shortcutIndex = candidateShortcutIndex(key: key, keyCode: keyCode),
       let candidate = candidateState.candidateForShortcut(shortcutIndex) {
      candidateState.select(index: shortcutIndex - 1)
      candidateSelectionExplicit = true
      lekhNativeLog("candidate.shortcut route=\(route) index=\(shortcutIndex)")
      return commitCandidateText(candidate, client: client, suffix: "")
    }

    if key == " " {
      if candidateSelectionExplicit {
        return commitSelectedCandidate(client: client, suffix: " ")
      }
      return commitRawComposition(client: client, suffix: " ")
    }

    if key == "\n" {
      if candidateSelectionExplicit {
        return commitSelectedCandidate(client: client, suffix: "\n")
      }
      return commitRawComposition(client: client, suffix: "\n")
    }

    if key == "\t", !modifiers.contains(.shift) {
      if candidateSelectionExplicit {
        return commitSelectedCandidate(client: client, suffix: "")
      }
      // Preserve the composition as raw text and let the host receive Tab.
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }

    if key == "\u{1b}" {
      return commitRawComposition(client: client, suffix: "")
    }

    return false
  }

  private func candidateShortcutIndex(key: String, keyCode: Int) -> Int? {
    let topRowDigitsByKeyCode: [Int: Int] = [
      18: 1,
      19: 2,
      20: 3,
      21: 4,
      23: 5,
      22: 6,
      26: 7,
      28: 8
    ]
    if let digit = topRowDigitsByKeyCode[keyCode] {
      return digit
    }
    guard key.count == 1, let digit = Int(key), (1...8).contains(digit) else {
      return nil
    }
    return digit
  }

  private func commitSelectedCandidate(client: IMKTextInput, suffix: String) -> Bool {
    guard let selected = candidateState.selectedCandidate() else {
      return false
    }
    return commitCandidateText(selected, client: client, suffix: suffix)
  }

  private func commitRawComposition(client: IMKTextInput, suffix: String) -> Bool {
    guard !IsSecureEventInputEnabled() else {
      cancelLocalComposition(client: client)
      return false
    }
    let raw = engineClient.rawBuffer(sessionId: sessionId)
    guard !raw.isEmpty else { return false }
    engineClient.observeCommit(
      sessionId: sessionId,
      rawInput: raw,
      chosenOutput: raw,
      allowPersonalization: false
    )
    client.insertText(raw + suffix, replacementRange: replacementRange(for: client))
    engineClient.resetSession(sessionId)
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
    lekhNativeLog("composition.commitRaw length=\((raw + suffix).utf16.count)")
    return true
  }

  private func processFailOpenKey(_ key: String, keyCode: Int, client sender: Any!, route: String) -> Bool {
    if key == "\u{1b}" {
      engineClient.resetSession(sessionId)
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      hideCandidates()
      lekhNativeLog("failOpen route=\(route) action=escape")
      return false
    }

    if key == "\u{7f}" {
      _ = engineDecision(for: key, route: route)
      lekhNativeLog("failOpen route=\(route) action=backspace")
      return false
    }

    if shouldAppendToFailOpenBuffer(key) {
      let decision = engineDecision(for: key, route: route)
      candidateState.updateCandidates(decision.candidates, rawBuffer: engineClient.rawBuffer(sessionId: sessionId), modeLabel: nativeMode.menuLabel)
      guard let client = sender as? IMKTextInput else {
        lekhNativeLog("failOpen route=\(route) action=bufferNoClient")
        return false
      }
      client.insertText(key, replacementRange: notFoundRange())
      lekhNativeLog("failOpen route=\(route) action=insertRaw")
      return true
    }

    let raw = engineClient.rawBuffer(sessionId: sessionId)
    guard !raw.isEmpty else {
      return false
    }

    let decision = engineDecision(for: key, route: route)

    guard let committed = decision.committedText, !committed.isEmpty else {
      lekhNativeLog("failOpen route=\(route) action=commitMiss")
      return false
    }

    guard let client = sender as? IMKTextInput else {
      lekhNativeLog("failOpen route=\(route) action=noClient")
      return false
    }

    if replacePreviouslyPassedThroughRawText(raw, with: committed, client: client) {
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      hideCandidates()
      lekhNativeLog("failOpen route=\(route) action=replace rawLength=\(raw.utf16.count) committedLength=\(committed.utf16.count)")
      return true
    }

    lekhNativeLog("failOpen route=\(route) action=replaceFailed rawLength=\(raw.utf16.count)")
    return false
  }

  private func replacePreviouslyPassedThroughRawText(_ raw: String, with committed: String, client: IMKTextInput) -> Bool {
    let selection = client.selectedRange()
    let rawLength = raw.utf16.count
    guard selection.location != NSNotFound, selection.location >= rawLength else {
      return false
    }
    let range = NSRange(location: selection.location - rawLength, length: rawLength + selection.length)
    client.insertText(committed, replacementRange: range)
    return true
  }

  private func keyString(from event: NSEvent) -> String {
    keyString(from: event.characters, keyCode: Int(event.keyCode), modifiers: event.modifierFlags.intersection(.deviceIndependentFlagsMask))
  }

  private func keyString(from string: String?, keyCode: Int, modifiers: NSEvent.ModifierFlags = []) -> String {
    switch keyCode {
    case 36, 76:
      return "\n"
    case 48:
      return "\t"
    case 49:
      return " "
    case 51:
      return "\u{7f}"
    case 53:
      return "\u{1b}"
    case 125:
      return lekhArrowDownKey
    case 126:
      return lekhArrowUpKey
    default:
      break
    }

    if nativeMode.usesTraditionalKeyboardLayout {
      let raw = string == "\r" ? "\n" : string ?? ""
      if !raw.isEmpty,
         raw.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil || raw == "\n" {
        return raw
      }
      if let translated = layoutTranslator.translateTraditionalKey(keyCode: keyCode, modifiers: modifiers),
         translated.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil {
        return translated
      }
      if !raw.isEmpty { return raw }
    }

    if let raw = string, !raw.isEmpty {
      return raw == "\r" ? "\n" : raw
    }

    switch keyCode {
    case 0:
      return "a"
    case 1:
      return "s"
    case 2:
      return "d"
    case 3:
      return "f"
    case 4:
      return "h"
    case 5:
      return "g"
    case 6:
      return "z"
    case 7:
      return "x"
    case 8:
      return "c"
    case 9:
      return "v"
    case 11:
      return "b"
    case 12:
      return "q"
    case 13:
      return "w"
    case 14:
      return "e"
    case 15:
      return "r"
    case 16:
      return "y"
    case 17:
      return "t"
    case 18:
      return "1"
    case 19:
      return "2"
    case 20:
      return "3"
    case 21:
      return "4"
    case 22:
      return "6"
    case 23:
      return "5"
    case 24:
      return "="
    case 25:
      return "9"
    case 26:
      return "7"
    case 27:
      return "-"
    case 28:
      return "8"
    case 29:
      return "0"
    case 30:
      return "]"
    case 31:
      return "o"
    case 32:
      return "u"
    case 33:
      return "["
    case 34:
      return "i"
    case 35:
      return "p"
    case 37:
      return "l"
    case 38:
      return "j"
    case 39:
      return "'"
    case 40:
      return "k"
    case 41:
      return ";"
    case 42:
      return "\\"
    case 43:
      return ","
    case 44:
      return "/"
    case 45:
      return "n"
    case 46:
      return "m"
    case 47:
      return "."
    case 50:
      return "`"
    default:
      if string == "\r" { return "\n" }
      return string ?? ""
    }
  }

  private func setKeyboardLayoutOverride() {
    if nativeMode.usesTraditionalKeyboardLayout {
      for inputSourceId in ["com.apple.keylayout.Nepali", "com.apple.keylayout.Nepali-IS16350", "com.apple.keylayout.Devanagari-QWERTY"] {
        if let source = inputSource(id: inputSourceId) {
          let status = TISSetInputMethodKeyboardLayoutOverride(source)
          lekhNativeLog("keyboardLayout.override id=\(inputSourceId) status=\(status) mode=\(nativeMode.rawValue)")
          return
        }
      }
      lekhNativeLog("keyboardLayout.override status=missingTraditional mode=\(nativeMode.rawValue)")
    }

    if let abc = inputSource(id: "com.apple.keylayout.ABC") {
      let status = TISSetInputMethodKeyboardLayoutOverride(abc)
      lekhNativeLog("keyboardLayout.override id=com.apple.keylayout.ABC status=\(status) mode=\(nativeMode.rawValue)")
      return
    }

    if let asciiCapable = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue() {
      let status = TISSetInputMethodKeyboardLayoutOverride(asciiCapable)
      lekhNativeLog("keyboardLayout.override id=currentASCII status=\(status) mode=\(nativeMode.rawValue)")
      return
    }

    lekhNativeLog("keyboardLayout.override status=missing")
  }

  private func inputSource(id inputSourceId: String) -> TISInputSource? {
    let query = [kTISPropertyInputSourceID as String: inputSourceId] as CFDictionary
    guard let unmanagedList = TISCreateInputSourceList(query, false) else {
      return nil
    }
    let list = unmanagedList.takeRetainedValue() as NSArray
    return list.firstObject as! TISInputSource?
  }

  private func shouldPassThrough(modifiers: NSEvent.ModifierFlags) -> Bool {
    if nativeMode.usesTraditionalKeyboardLayout,
       LekhNativePreferences.traditionalOptionLayerEnabled,
       modifiers.contains(.option),
       !modifiers.contains(.command),
       !modifiers.contains(.control) {
      return false
    }
    return modifiers.contains(.command) || modifiers.contains(.control) || modifiers.contains(.option)
  }

  private func traditionalOptionText(key: String, keyCode: Int, modifiers: NSEvent.ModifierFlags) -> String? {
    guard nativeMode.usesTraditionalKeyboardLayout,
          LekhNativePreferences.traditionalOptionLayerEnabled,
          modifiers.contains(.option),
          !modifiers.contains(.command),
          !modifiers.contains(.control) else {
      return nil
    }
    switch keyCode {
    case 15: return "\u{094D}र" // Option-R: repha/rakar helper
    case 16: return "\u{094D}य" // Option-Y: yaphala helper
    case 4: return "\u{094D}"   // Option-H: explicit halanta
    case 45: return "\u{0901}"  // Option-N: chandrabindu
    case 46: return "\u{0902}"  // Option-M: anusvara
    case 47: return "\u{0964}"  // Option-.: danda
    default:
      return nil
    }
  }

  private func shouldPassThroughWithoutComposition(key: String) -> Bool {
    guard !engineClient.hasComposition(sessionId: sessionId) else { return false }
    if key == " " || key == "\n" || key == "\t" || key == "\u{7f}" || key == "\u{1b}" { return true }
    if key.count == 1, let scalar = key.unicodeScalars.first {
      return !CharacterSet.alphanumerics.contains(scalar) && !(scalar.value >= 0x0900 && scalar.value <= 0x097F)
    }
    return false
  }

  private func shouldCommitBeforePassingThrough(key: String) -> Bool {
    guard engineClient.hasComposition(sessionId: sessionId) else { return false }
    guard key.count == 1, let scalar = key.unicodeScalars.first else { return false }
    if CharacterSet.alphanumerics.contains(scalar) { return false }
    if scalar.value >= 0x0900 && scalar.value <= 0x097F { return false }
    if CharacterSet.punctuationCharacters.contains(scalar) { return false }
    if CharacterSet.whitespacesAndNewlines.contains(scalar) { return false }
    return true
  }

  private func shouldAppendToFailOpenBuffer(_ key: String) -> Bool {
    guard key.count == 1, let scalar = key.unicodeScalars.first else { return false }
    return CharacterSet.alphanumerics.contains(scalar) || (scalar.value >= 0x0900 && scalar.value <= 0x097F)
  }

  public func resetSession() {
    engineClient.endSession(sessionId)
    sessionId = UUID().uuidString
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    hideCandidates()
  }

  private func modeFromMenuKey(_ key: String, keyCode: Int = -1) -> LekhNativeTypingMode? {
    let topRowDigitsByKeyCode: [Int: Int] = [
      18: 1,
      19: 2,
      20: 3,
      21: 4
    ]
    let digit = topRowDigitsByKeyCode[keyCode] ?? (key.count == 1 ? Int(key) : nil)
    guard let digit, (1...LekhNativeTypingMode.visibleModes.count).contains(digit) else {
      return nil
    }
    return LekhNativeTypingMode.visibleModes[digit - 1]
  }

  private func modeFromMenuLabel(_ label: String) -> LekhNativeTypingMode? {
    LekhNativeTypingMode.visibleModes.first { $0.menuLabel == label }
  }

  private func configureModeFromDefaults() {
    if let rawValue = UserDefaults.standard.string(forKey: lekhNativeModeDefaultsKey),
       let mode = LekhNativeTypingMode(rawValue: rawValue) {
      nativeMode = mode
    }
    modePromptPending = false
  }

  private func selectNativeMode(_ mode: LekhNativeTypingMode) {
    nativeMode = mode
    modePromptPending = false
    UserDefaults.standard.set(mode.rawValue, forKey: lekhNativeModeDefaultsKey)
    UserDefaults.standard.set(true, forKey: lekhNativeModeChosenDefaultsKey)
    UserDefaults.standard.synchronize()
    engineClient.endSession(sessionId)
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: mode.menuLabel)
    hideCandidates()
    setKeyboardLayoutOverride()
    lekhNativeLog("mode.selected \(mode.rawValue)")
  }

  private func observeNativeModeChanges() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(nativeModePreferenceDidChange(_:)),
      name: lekhNativeModeDidChangeNotification,
      object: nil
    )
  }

  @objc private func nativeModePreferenceDidChange(_ notification: Notification) {
    guard let rawValue = notification.userInfo?["mode"] as? String,
          let mode = LekhNativeTypingMode(rawValue: rawValue),
          mode != nativeMode else { return }
    selectNativeMode(mode)
  }

  private func shouldShowFirstModePicker() -> Bool {
    !UserDefaults.standard.bool(forKey: lekhNativeModeChosenDefaultsKey)
  }

  private func markModePromptConsumed() {
    guard modePromptPending else { return }
    modePromptPending = false
    UserDefaults.standard.set(nativeMode.rawValue, forKey: lekhNativeModeDefaultsKey)
    UserDefaults.standard.set(true, forKey: lekhNativeModeChosenDefaultsKey)
    UserDefaults.standard.synchronize()
  }

  private func showModePicker() {
    modeMenuOpen = false
    markModePromptConsumed()
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      LekhModePickerWindowController.shared.show(current: self.nativeMode) { [weak self] mode in
        self?.selectNativeMode(mode)
      }
    }
  }

  private func modeSelectedDecision(_ mode: LekhNativeTypingMode) -> LekhInputDecision {
    LekhInputDecision(
      handled: true,
      markedText: nil,
      committedText: nil,
      candidates: [mode.menuLabel],
      shouldCancel: true,
      shouldPassThrough: false
    )
  }

  private func cancelDecision() -> LekhInputDecision {
    LekhInputDecision(
      handled: true,
      markedText: nil,
      committedText: nil,
      candidates: [],
      shouldCancel: true,
      shouldPassThrough: false
    )
  }

  private func commitCurrentComposition(client: IMKTextInput, suffix: String) -> Bool {
    let raw = engineClient.rawBuffer(sessionId: sessionId)
    guard !raw.isEmpty else { return false }
    if candidateSelectionExplicit, let selected = candidateState.selectedCandidate() {
      return commitCandidateText(selected, client: client, suffix: suffix)
    }
    return commitRawComposition(client: client, suffix: suffix)
  }

  private func cancelLocalComposition(client: IMKTextInput?) {
    engineClient.endSession(sessionId)
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
    client?.setMarkedText("", selectionRange: NSRange(location: 0, length: 0), replacementRange: notFoundRange())
  }

  private func apply(_ decision: LekhInputDecision, client sender: Any!, route: String) -> Bool {
    lekhNativeLog(
      "apply route=\(route) handled=\(decision.handled) passThrough=\(decision.shouldPassThrough) marked=\(decision.markedText == nil ? 0 : 1) committedLength=\(decision.committedText?.utf16.count ?? 0) candidates=\(decision.candidates.count)"
    )
    if decision.shouldPassThrough || !decision.handled { return false }
    guard let client = sender as? IMKTextInput else {
      engineClient.resetSession(sessionId)
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      hideCandidates()
      lekhNativeLog("apply route=\(route) failOpen=noClient")
      return false
    }

    if decision.shouldCancel {
      cancelLocalComposition(client: client)
      return true
    }

    if let committedText = decision.committedText {
      client.insertText(committedText, replacementRange: replacementRange(for: client))
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      candidateSelectionExplicit = false
      hideCandidates()
      return true
    }

    if let markedText = decision.markedText {
      let display = markedTextObject(markedText)
      client.setMarkedText(
        display.text,
        selectionRange: NSRange(location: display.cursorLocation, length: 0),
        replacementRange: replacementRange(for: client)
      )
      if let ghost = inlineGhostText(rawText: markedText, candidates: decision.candidates) {
        inlinePreviewPanel.show(suffix: ghost, anchorRect: candidateAnchorRect(for: client))
      } else {
        inlinePreviewPanel.hide()
      }
      updateCandidates(decision.candidates)
      return true
    }

    return false
  }

  private func markedTextObject(_ rawText: String) -> LekhMarkedCompositionDisplay {
    let rawRange = NSRange(location: 0, length: rawText.utf16.count)
    let attributed = NSMutableAttributedString(string: rawText)
    let rawHasDevanagari = rawText.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
    let attributes = mark(forStyle: Int(kTSMHiliteSelectedConvertedText), at: rawRange) ?? [:]
    for (key, value) in attributes {
      if let attributeKey = key as? NSAttributedString.Key {
        attributed.addAttribute(attributeKey, value: value, range: rawRange)
      } else if let keyString = key as? String {
        attributed.addAttribute(NSAttributedString.Key(keyString), value: value, range: rawRange)
      }
    }
    attributed.addAttribute(.foregroundColor, value: NSColor.labelColor, range: rawRange)
    attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: rawRange)
    let rawFont: NSFont
    if rawHasDevanagari {
      rawFont = LekhFont.devanagari(size: NSFont.systemFontSize + 2)
    } else {
      rawFont = NSFont.systemFont(ofSize: NSFont.systemFontSize)
    }
    attributed.addAttribute(.font, value: rawFont, range: rawRange)

    return LekhMarkedCompositionDisplay(text: attributed, cursorLocation: rawText.utf16.count)
  }

  private func inlineGhostText(rawText: String, candidates: [String]) -> String? {
    guard LekhNativePreferences.inlinePreviewEnabled else { return nil }
    let raw = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return nil }
    guard let candidate = candidates.first(where: { candidate in
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, trimmed != raw, trimmed.hasPrefix(raw) else { return false }
      let rawHasDevanagari = raw.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
      let candidateHasDevanagari = trimmed.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
      return rawHasDevanagari == candidateHasDevanagari
    }) else {
      return nil
    }
    return String(candidate.dropFirst(raw.count))
  }

  private func updateCandidates(_ candidates: [String]) {
    let rawBuffer = engineClient.rawBuffer(sessionId: sessionId)
    candidateSelectionExplicit = false
    candidateState.updateCandidates(candidates, rawBuffer: rawBuffer, modeLabel: nativeMode.menuLabel)
    refreshCandidatePanel()
    requestAsyncNeuralCandidates(rawBuffer: rawBuffer, deterministicCandidates: candidates)
  }

  private func requestAsyncNeuralCandidates(rawBuffer: String, deterministicCandidates: [String]) {
    guard nativeMode == .romanizedTraditional,
          !IsSecureEventInputEnabled(),
          !rawBuffer.isEmpty,
          rawBuffer.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return }
    let sessionSnapshot = sessionId
    neuralCandidateService.candidates(for: rawBuffer, secureInputActive: IsSecureEventInputEnabled()) { [weak self] neuralCandidates in
      guard let self,
            !IsSecureEventInputEnabled(),
            self.sessionId == sessionSnapshot,
            self.engineClient.rawBuffer(sessionId: sessionSnapshot) == rawBuffer,
            !neuralCandidates.isEmpty else { return }
      let merged = Self.uniqueCandidates(deterministicCandidates + neuralCandidates, limit: 8)
      self.candidateState.updateCandidates(merged, rawBuffer: rawBuffer, modeLabel: self.nativeMode.menuLabel)
      self.refreshCandidatePanel()
    }
  }

  private static func uniqueCandidates(_ candidates: [String], limit: Int) -> [String] {
    var seen = Set<String>()
    var output: [String] = []
    for candidate in candidates {
      guard !seen.contains(candidate) else { continue }
      seen.insert(candidate)
      output.append(candidate)
      if output.count >= limit { break }
    }
    return output
  }

  private func refreshCandidatePanel() {
    let state = candidateState.currentState()
    let candidates = state.candidates
    if candidates.isEmpty {
      hideCandidates()
      return
    }
    if LekhNativePreferences.customCandidatePanelEnabled {
      candidatePanel?.hide()
      customCandidatePanel.show(
        items: state.displayItems,
        title: nativeMode.menuLabel,
        selectedIndex: state.selectedIndex,
        anchorRect: candidateAnchorRect(for: self.client())
      ) { [weak self] selectedText in
        guard let self, let client = self.client() else { return }
        self.candidateSelectionExplicit = true
        self.commitCandidateText(selectedText, client: client, suffix: "")
      }
      return
    }
    customCandidatePanel.hide()
    candidatePanel?.update()
    candidatePanel?.show(kIMKLocateCandidatesBelowHint)
  }

  private func hideCandidates() {
    inlinePreviewPanel.hide()
    customCandidatePanel.hide()
    candidatePanel?.hide()
  }

  private func candidateAnchorRect(for client: IMKTextInput?) -> NSRect? {
    guard let client else { return nil }
    let markedRange = client.markedRange()
    let selectedRange = client.selectedRange()
    let characterIndex: Int
    if markedRange.location != NSNotFound {
      characterIndex = max(0, markedRange.location + markedRange.length)
    } else {
      characterIndex = selectedRange.location == NSNotFound ? 0 : max(0, selectedRange.location)
    }
    var lineHeightRect = NSRect.zero
    _ = client.attributes(forCharacterIndex: characterIndex, lineHeightRectangle: &lineHeightRect)
    guard !lineHeightRect.isEmpty, lineHeightRect != .zero else { return nil }
    return lineHeightRect
  }

  @discardableResult
  private func commitCandidateText(_ text: String, client: IMKTextInput, suffix: String) -> Bool {
    guard !IsSecureEventInputEnabled() else {
      cancelLocalComposition(client: client)
      return false
    }
    lekhNativeLog("candidate.selected length=\(text.utf16.count)")
    let raw = engineClient.rawBuffer(sessionId: sessionId)
    engineClient.observeCommit(
      sessionId: sessionId,
      rawInput: raw,
      chosenOutput: text,
      allowPersonalization: shouldPersonalize(client: client)
    )
    client.insertText(text + suffix, replacementRange: replacementRange(for: client))
    engineClient.resetSession(sessionId)
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
    return true
  }

  private func shouldPersonalize(client: IMKTextInput) -> Bool {
    guard !IsSecureEventInputEnabled() else { return false }
    return LekhNativePreferences.mayPersonalize(bundleIdentifier: client.bundleIdentifier())
  }

  private func replacementRange(for client: IMKTextInput) -> NSRange {
    let markedRange = client.markedRange()
    if markedRange.location != NSNotFound {
      return markedRange
    }
    return notFoundRange()
  }

  private func notFoundRange() -> NSRange {
    NSRange(location: NSNotFound, length: NSNotFound)
  }
}

private extension LekhNativeTypingMode {
  var usesTraditionalKeyboardLayout: Bool {
    self == .traditionalTraditional || self == .traditionalRomanized
  }
}
