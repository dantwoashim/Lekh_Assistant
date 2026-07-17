import AppKit
import Carbon
import Foundation
import InputMethodKit
import OSLog

private let lekhLogger = Logger(subsystem: "com.lekh.inputmethod.keyboard", category: "imk")
private let lekhNativeModeDefaultsKey = LekhNativePreferences.Keys.nativeTypingMode
private let lekhNativeModeChosenDefaultsKey = LekhNativePreferences.Keys.nativeTypingModeChosen
private let lekhNativeModeDidChangeNotification = LekhNativePreferences.modeDidChangeNotification
private let lekhSharedPreferencesDomain = "com.lekh.inputmethod.LekhKeyboard"
private let lekhSharedPreferencesDidChangeName = CFNotificationName("com.lekh.inputmethod.preferences.changed" as CFString)
private let lekhCompanionBundleIdentifier = "com.lekh.keyboard.companion"
private let lekhHostProbeDiagnosticsKey = "LekhHostProbeDiagnosticsEnabled"
private let lekhArrowUpKey = "\u{F700}"
private let lekhArrowDownKey = "\u{F701}"
private let lekhArrowLeftKey = "\u{F702}"
private let lekhArrowRightKey = "\u{F703}"
private let lekhHomeKey = "\u{F729}"
private let lekhEndKey = "\u{F72B}"
private let lekhPageUpKey = "\u{F72C}"
private let lekhPageDownKey = "\u{F72D}"

private func lekhSharedPreferencesDidChange(
  _ center: CFNotificationCenter?,
  observer: UnsafeMutableRawPointer?,
  name: CFNotificationName?,
  object: UnsafeRawPointer?,
  userInfo: CFDictionary?
) {
  guard let observer else { return }
  let controller = Unmanaged<LekhInputController>.fromOpaque(observer).takeUnretainedValue()
  DispatchQueue.main.async { [weak controller] in
    controller?.sharedPreferencesDidChange()
  }
}

func lekhNativeLog(_ message: String) {
  guard LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: IsSecureEventInputEnabled()) else { return }
  lekhLogger.debug("\(message, privacy: .private)")
}

/// Emits only content-free surface state for an explicitly enabled local host
/// probe. It never runs during secure input and never includes keys, words,
/// ranges, coordinates, surrounding text, or candidate text.
private func lekhHostProbeLog(_ message: String) {
  guard !IsSecureEventInputEnabled(),
        UserDefaults.standard.bool(forKey: lekhHostProbeDiagnosticsKey) else { return }
  lekhLogger.notice("\(message, privacy: .public)")
}

public struct LekhInlineSuggestion: Equatable {
  public let suffix: String
  public let acceptedText: String

  public init(suffix: String, acceptedText: String) {
    self.suffix = suffix
    self.acceptedText = acceptedText
  }
}

public struct LekhInputDecision: Equatable {
  public let handled: Bool
  public let markedText: String?
  public let committedText: String?
  public let candidates: [String]
  public let inlineSuggestion: LekhInlineSuggestion?
  public let autoCommitCandidate: LekhAutoCommitCandidate?
  public let neuralTailEligible: Bool
  public let shouldCancel: Bool
  public let shouldPassThrough: Bool

  public init(
    handled: Bool,
    markedText: String?,
    committedText: String?,
    candidates: [String],
    inlineSuggestion: LekhInlineSuggestion? = nil,
    autoCommitCandidate: LekhAutoCommitCandidate? = nil,
    neuralTailEligible: Bool = false,
    shouldCancel: Bool,
    shouldPassThrough: Bool
  ) {
    self.handled = handled
    self.markedText = markedText
    self.committedText = committedText
    self.candidates = candidates
    self.inlineSuggestion = inlineSuggestion
    self.autoCommitCandidate = autoCommitCandidate
    self.neuralTailEligible = neuralTailEligible
    self.shouldCancel = shouldCancel
    self.shouldPassThrough = shouldPassThrough
  }

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

private struct LekhCompositionAnchor {
  let rect: NSRect
  let hostFont: NSFont?
}

/// Computes the only document range that the unmarked fail-open path may
/// replace. The raw token was already inserted immediately before the caret;
/// replacing while the host owns a non-empty selection could erase unrelated
/// user text after a mouse/selection change.
public enum LekhFailOpenReplacementPolicy {
  public static func replacementRange(
    rawUTF16Length: Int,
    selection: NSRange
  ) -> NSRange? {
    guard rawUTF16Length > 0,
          selection.location != NSNotFound,
          selection.length == 0,
          selection.location >= rawUTF16Length else {
      return nil
    }
    return NSRange(
      location: selection.location - rawUTF16Length,
      length: rawUTF16Length
    )
  }
}

/// Binds an actionable suggestion surface to the exact host client and engine
/// snapshot that presented it. A window merely remaining on screen is not
/// sufficient authority to insert text after a focus/session transition.
private struct LekhSurfaceToken: Equatable {
  let generation: Int
  let sessionId: String
  let rawBuffer: String
  let clientIdentifier: ObjectIdentifier
}

private enum LekhCandidatePresentation {
  case visibleCustom
  case visibleSystem
  case unavailable

  var isVisible: Bool {
    switch self {
    case .visibleCustom, .visibleSystem:
      return true
    case .unavailable:
      return false
    }
  }
}

@objc(LekhInputController)
open class LekhInputController: IMKInputController {
  // Host text systems often publish a usable marked-range caret rectangle one
  // or two display cycles after setMarkedText. Retry asynchronously for a
  // bounded 216 ms; every retry is generation/session/raw guarded, so typing a
  // new key cancels stale work and never adds latency to the keystroke path.
  private static let compositionSurfaceRetryDelays: [TimeInterval] = [
    0, 0.008, 0.016, 0.032, 0.064, 0.096
  ]
  private let engineClient: LekhEngineClient
  /// Injectable for deterministic controller safety probes. Production IMK
  /// construction always reads the OS Secure Event Input state directly.
  private let secureInputActive: () -> Bool
  private let latencyTelemetry = LekhLatencyRingBuffer()
  private let candidateState = LekhCandidateController()
  private let neuralCandidateService = LekhNeuralCandidateService.shared
  private var candidateSelectionExplicit = false
  /// Engine-issued, word-snapshot-bound authorization for a passive delimiter
  /// commit. This is deliberately separate from candidate highlighting: a
  /// visible or top-ranked row is not sufficient evidence to change text.
  private var activeAutoCommitCandidate: LekhAutoCommitCandidate?
  private var pendingInlineSuggestion: LekhInlineSuggestion?
  private var activeInlineSuggestion: LekhInlineSuggestion?
  private var activeInlineSuggestionToken: LekhSurfaceToken?
  private var candidatePresentationToken: LekhSurfaceToken?
  private var candidatePanel: IMKCandidates?
  private let customCandidatePanel = LekhCandidatePanel()
  private let inlinePreviewPanel = LekhInlinePreviewPanel()
  private let layoutTranslator = LekhKeyboardLayoutTranslator.shared
  private let runtimeControllerIdentifier = UUID().uuidString
  private var runtimeControllerInitializedAt = Date()
  private var runtimeActivationIdentifier: String?
  private var sessionId = UUID().uuidString
  private var nativeMode = LekhNativeTypingMode.romanizedTraditional
  private var modeMenuOpen = false
  private var surfaceRenderGeneration = 0
  private var compositionSurfacesDismissed = false
  private var inlineAnnouncementGeneration = 0
  private var lastAnnouncedInlineAcceptedText: String?
  private var lastCompositionAnchorRect: NSRect?
  private var lastCompositionAnchorFont: NSFont?
  private var lastCompositionAnchorToken: LekhSurfaceToken?
  private var presentedMarkedText: String?
  /// The host text client that owns the active marked range. InputMethodKit
  /// normally creates one controller per client session, but WebKit/Electron
  /// responders can transition while callbacks are still queued. Never mutate
  /// a newly focused client with text or cleanup that belongs to the old one.
  private weak var compositionOwnerObject: AnyObject?
  private var compositionOwnerIdentifier: ObjectIdentifier?
  private var sharedPreferencesReloadPending = false
  private var pendingNativeMode: LekhNativeTypingMode?
  private var pendingNativeModeRequiresPersistence = false
  private var usesInlineComposition: Bool {
    let value = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]?.lowercased()
    if value == "0" || value == "false" || value == "no" {
      return false
    }
    return true
  }

  public init(
    engineClient: LekhEngineClient = LekhNativeEngineClient(),
    secureInputActive: @escaping () -> Bool = { IsSecureEventInputEnabled() }
  ) {
    LekhNativePreferences.registerDefaults()
    self.engineClient = engineClient
    self.secureInputActive = secureInputActive
    super.init()
    observeSharedPreferencesChanges()
    configureModeFromDefaults()
    observeNativeModeChanges()
  }

  public required override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
    LekhNativePreferences.registerDefaults()
    self.engineClient = Self.defaultEngineClient()
    self.secureInputActive = { IsSecureEventInputEnabled() }
    super.init(server: server, delegate: delegate, client: inputClient)
    self.candidatePanel = IMKCandidates(server: server, panelType: kIMKSingleRowSteppingCandidatePanel)
    self.candidatePanel?.setDismissesAutomatically(true)
    observeSharedPreferencesChanges()
    configureModeFromDefaults()
    observeNativeModeChanges()
    runtimeControllerInitializedAt = Date()
    LekhRuntimeHealth.markControllerInitialized(
      controllerIdentifier: runtimeControllerIdentifier,
      initializedAt: runtimeControllerInitializedAt
    )
    lekhNativeLog("controller.init")
    logSelectorAvailability()
  }

  deinit {
    deactivateRuntimeEvidence()
    NotificationCenter.default.removeObserver(self)
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      lekhSharedPreferencesDidChangeName,
      nil
    )
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
    let activationIdentifier = UUID().uuidString
    runtimeActivationIdentifier = activationIdentifier
    LekhRuntimeHealth.markControllerActivated(
      controllerIdentifier: runtimeControllerIdentifier,
      initializedAt: runtimeControllerInitializedAt,
      activationIdentifier: activationIdentifier
    )
    lekhHostProbeLog("surface.lifecycle activate")
    if engineClient.hasComposition(sessionId: sessionId) {
      sharedPreferencesReloadPending = true
    } else {
      applyPendingPreferencesAtBoundary(force: true)
    }
    setKeyboardLayoutOverride()
    lekhNativeLog("lifecycle.activate")
    modeMenuOpen = false
    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
      return
    }
    // Activation must never open or focus Lekh UI. First-run guidance belongs
    // in the companion; an input method becoming active must leave the host's
    // insertion point and current Space untouched.
  }

  open override func deactivateServer(_ sender: Any!) {
    lekhHostProbeLog("surface.lifecycle deactivate")
    lekhNativeLog("lifecycle.deactivate")
    deactivateRuntimeEvidence()
    hideCandidates()
    defer { engineClient.endSession(sessionId) }
    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
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
    if engineClient.hasComposition(sessionId: sessionId),
       let client = compositionOwnerObject as? IMKTextInput,
       isCompositionOwner(client) {
      // Losing focus is not candidate acceptance. Preserve exactly what the
      // user typed even if they had only browsed a candidate with Arrow keys.
      _ = commitRawComposition(client: client, suffix: "")
    } else {
      engineClient.resetSession(sessionId)
      clearCompositionOwner()
    }
  }

  open override func inputControllerWillClose() {
    lekhNativeLog("lifecycle.close")
    deactivateRuntimeEvidence()
    hideCandidates()
    engineClient.endSession(sessionId)
    clearCompositionOwner()
  }

  open override func hidePalettes() {
    // IMK can request palette dismissal independently of composition. Hidden
    // suggestions must also become un-acceptable: Tab must never commit UI the
    // user cannot see.
    lekhHostProbeLog("surface.hide palettes")
    surfaceRenderGeneration += 1
    neuralCandidateService.cancelPending()
    compositionSurfacesDismissed = true
    revokeCandidateAcceptance()
    activeAutoCommitCandidate = nil
    pendingInlineSuggestion = nil
    activeInlineSuggestion = nil
    activeInlineSuggestionToken = nil
    inlinePreviewPanel.hide()
    hideCandidateWindow()
  }

  open override func cancelComposition() {
    if secureInputActive() {
      clearStateForSecureInput(client: self.client())
      return
    }
    // The framework implementation replaces marked text with originalString,
    // which is Lekh's raw buffer. Mirror its document mutation and then clear
    // every local surface/session state.
    super.cancelComposition()
    engineClient.resetSession(sessionId)
    clearCompositionOwner()
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
  }

  open override func commitComposition(_ sender: Any!) {
    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
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
    // A host-driven commit (focus move, document close, responder change) is
    // not explicit acceptance of a merely highlighted candidate.
    _ = commitRawComposition(client: client, suffix: "")
  }

  open override func composedString(_ sender: Any!) -> Any! {
    guard !secureInputActive() else { return "" }
    return engineClient.rawBuffer(sessionId: sessionId)
  }

  open override func originalString(_ sender: Any!) -> NSAttributedString! {
    guard !secureInputActive() else { return NSAttributedString(string: "") }
    return NSAttributedString(string: engineClient.rawBuffer(sessionId: sessionId))
  }

  open override func inputText(_ string: String!, client sender: Any!) -> Bool {
    guard let string, !string.isEmpty else { return false }
    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
      return false
    }
    lekhNativeLog("event.inputText units=\(string.count)")

    // IMK may deliver more than one grapheme in a single callback. Returning
    // true after consuming only a prefix makes the host suppress the complete
    // callback and loses every unhandled suffix. Preflight multi-unit input so
    // the callback is all-or-nothing: composition-safe letters/digits may be
    // processed together; mixed paste, punctuation, whitespace, emoji, and
    // other host-owned text are passed through byte-for-byte without first
    // mutating the engine.
    if string.count > 1, !canConsumeInputTextBatch(string) {
      finishCompositionBeforeModifierPassThrough(client: sender as? IMKTextInput)
      lekhNativeLog("event.passThrough route=inputText reason=nonAtomicBatch")
      return false
    }

    var handledAll = true
    for character in string {
      let handled = processKeyInput(
        String(character),
        keyCode: -1,
        modifiers: [],
        client: sender,
        route: "inputText"
      )
      handledAll = handledAll && handled
    }
    return handledAll
  }

  open override func inputText(_ string: String!, key keyCode: Int, modifiers flags: Int, client sender: Any!) -> Bool {
    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
      return false
    }
    let modifiers = NSEvent.ModifierFlags(rawValue: UInt(flags)).intersection(.deviceIndependentFlagsMask)
    let key = keyString(from: string, keyCode: keyCode, modifiers: modifiers)
    lekhNativeLog("event.inputTextKey flags=\(flags) units=\(string?.count ?? 0)")
    guard !key.isEmpty else { return false }
    return processKeyInput(key, keyCode: keyCode, modifiers: modifiers, client: sender, route: "inputTextKey")
  }

  open override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
    guard let event, event.type == .keyDown else { return false }

    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
      return false
    }

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
    // The Darwin callback only flips an in-memory flag. Disk/defaults sync is
    // performed once, at the next empty-composition boundary, never on the
    // per-keystroke hot path and never in the middle of a word.
    applyPendingPreferencesAtBoundary()

    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
      return false
    }

    if let client = sender as? IMKTextInput {
      prepareForClientTransition(client)
    }

    // Control+Option+1..4 switches Lekh modes directly.
    if modifiers.contains(.control),
       modifiers.contains(.option),
       let selectedMode = modeFromMenuKey(key, keyCode: keyCode) {
      guard finishCompositionBeforeModeSwitch(client: sender as? IMKTextInput) else { return false }
      selectNativeMode(selectedMode)
      modeMenuOpen = false
      return true
    }

    // Control+Option+Space or Control+Option+M opens the Lekh mode selector.
    if modifiers.contains(.control), modifiers.contains(.option), keyCode == 49 || keyCode == 46 {
      showModePicker()
      return true
    }

    if modeMenuOpen {
      if let selectedMode = modeFromMenuKey(key, keyCode: keyCode) {
        guard finishCompositionBeforeModeSwitch(client: sender as? IMKTextInput) else { return false }
        selectNativeMode(selectedMode)
        modeMenuOpen = false
        return true
      }
      if key == "\u{1b}" {
        modeMenuOpen = false
        return apply(cancelDecision(), client: sender, route: "modeCancel")
      }
      modeMenuOpen = false
      cancelLocalComposition(client: sender as? IMKTextInput)
    }

    if handleCandidateCommand(key, keyCode: keyCode, modifiers: modifiers, client: sender, route: route) {
      return true
    }

    if let optionText = traditionalOptionText(key: key, keyCode: keyCode, modifiers: modifiers) {
      return processKey(optionText, client: sender, route: "traditional.optionLayer")
    }

    if shouldPassThrough(modifiers: modifiers) {
      finishCompositionBeforeModifierPassThrough(client: sender as? IMKTextInput)
      lekhNativeLog("event.passThrough route=\(route) reason=modifier")
      return false
    }

    if shouldPassThroughWithoutComposition(key: key) {
      lekhNativeLog("event.passThrough route=\(route) reason=noComposition")
      return false
    }

    if shouldCommitBeforePassingThrough(key: key), let client = sender as? IMKTextInput {
      if usesInlineComposition {
        _ = commitRawComposition(client: client, suffix: "")
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
    // Some hosts route editing keys only through `didCommand`, bypassing
    // processKeyInput's secure-input guard. Clear every in-memory composition
    // surface and let the secure host receive the command untouched.
    if secureInputActive() {
      clearStateForSecureInput(client: sender as? IMKTextInput)
      return false
    }
    // Command callbacks can be delivered after a responder transition even
    // when the key-event route has not run for the new client. Apply the same
    // ownership barrier before Backspace is allowed to mutate engine state;
    // otherwise a delayed delete could rebind old marked text to a new field.
    if let client = sender as? IMKTextInput {
      prepareForClientTransition(client)
    }
    applyPendingPreferencesAtBoundary()
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\u{1b}", keyCode: 53, client: sender, route: "command.cancel")
      }
      guard let client = sender as? IMKTextInput else { return false }
      return handleEscape(client: client, route: "command.cancel")
    }
    if selector == #selector(NSResponder.deleteBackward(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\u{7f}", keyCode: 51, client: sender, route: "command.backspace")
      }
      return processKey("\u{7f}", client: sender, route: "command.backspace")
    }
    if selector == #selector(NSResponder.insertNewline(_:)) ||
       selector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\n", keyCode: 36, client: sender, route: "command.enter")
      }
      guard let client = sender as? IMKTextInput else { return false }
      return commitCurrentComposition(client: client, suffix: "\n")
    }
    if selector == #selector(NSResponder.insertTab(_:)) ||
       selector == #selector(NSResponder.insertTabIgnoringFieldEditor(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if !usesInlineComposition {
        return processFailOpenKey("\t", keyCode: 48, client: sender, route: "command.tab")
      }
      guard let client = sender as? IMKTextInput else { return false }
      if let suggestion = visibleInlineSuggestion(for: client) {
        candidateSelectionExplicit = true
        lekhNativeLog("inlineSuggestion.accept route=command.tab key=tab")
        return commitInlineSuggestion(suggestion, client: client)
      }
      if candidateSelectionExplicit, isCurrentCandidateSurface(for: client) {
        return commitSelectedCandidate(client: client, suffix: "")
      }
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }
    if selector == #selector(NSResponder.insertBacktab(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId),
            usesInlineComposition,
            let client = sender as? IMKTextInput else { return false }
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }
    if selector == #selector(NSResponder.moveDown(_:)) {
      if handleCandidateCommand(lekhArrowDownKey, keyCode: 125, modifiers: [], client: sender, route: "command.down") {
        return true
      }
      return commitRawBeforeHostCommand(sender)
    }
    if selector == #selector(NSResponder.moveUp(_:)) {
      if handleCandidateCommand(lekhArrowUpKey, keyCode: 126, modifiers: [], client: sender, route: "command.up") {
        return true
      }
      return commitRawBeforeHostCommand(sender)
    }
    if selector == #selector(NSResponder.moveRight(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if handleCandidateCommand(lekhArrowRightKey, keyCode: 124, modifiers: [], client: sender, route: "command.right") {
        return true
      }
      guard let client = sender as? IMKTextInput else { return false }
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }
    if selector == #selector(NSResponder.pageDown(_:)) {
      if handleCandidateCommand(lekhPageDownKey, keyCode: 121, modifiers: [], client: sender, route: "command.pageDown") {
        return true
      }
      return commitRawBeforeHostCommand(sender)
    }
    if selector == #selector(NSResponder.pageUp(_:)) {
      if handleCandidateCommand(lekhPageUpKey, keyCode: 116, modifiers: [], client: sender, route: "command.pageUp") {
        return true
      }
      return commitRawBeforeHostCommand(sender)
    }
    if selector == #selector(NSResponder.moveLeft(_:)) {
      return commitRawBeforeHostCommand(sender)
    }
    if selector == #selector(NSResponder.moveToBeginningOfLine(_:)) ||
       selector == #selector(NSResponder.moveToEndOfLine(_:)) {
      guard engineClient.hasComposition(sessionId: sessionId) else { return false }
      if candidateSelectionExplicit {
        let first = selector == #selector(NSResponder.moveToBeginningOfLine(_:))
        guard candidateState.selectBoundary(first: first) != nil else { return false }
        guard refreshCandidatePanel(announceSelection: true).isVisible else {
          revokeCandidateAcceptance()
          return commitRawBeforeHostCommand(sender)
        }
        return true
      }
      return commitRawBeforeHostCommand(sender)
    }
    let rawPassThroughSelectors: Set<Selector> = [
      #selector(NSResponder.deleteForward(_:)),
      #selector(NSResponder.moveBackward(_:)),
      #selector(NSResponder.moveForward(_:)),
      #selector(NSResponder.moveWordBackward(_:)),
      #selector(NSResponder.moveWordForward(_:)),
      #selector(NSResponder.moveLeftAndModifySelection(_:)),
      #selector(NSResponder.moveRightAndModifySelection(_:)),
      #selector(NSResponder.moveUpAndModifySelection(_:)),
      #selector(NSResponder.moveDownAndModifySelection(_:)),
      #selector(NSResponder.moveWordLeftAndModifySelection(_:)),
      #selector(NSResponder.moveWordRightAndModifySelection(_:))
    ]
    if rawPassThroughSelectors.contains(selector) {
      return commitRawBeforeHostCommand(sender)
    }
    return false
  }

  /// Commits raw composition but deliberately returns `false`, allowing the
  /// host to perform the original navigation command exactly once.
  private func commitRawBeforeHostCommand(_ sender: Any!) -> Bool {
    guard engineClient.hasComposition(sessionId: sessionId),
          let client = sender as? IMKTextInput else { return false }
    _ = commitRawComposition(client: client, suffix: "")
    return false
  }

  /// Finalizes the current raw token, then returns control to the host so its
  /// Command/Control/Option shortcut is delivered exactly once. In the
  /// unmarked fail-open route the raw text is already in the document, so only
  /// local engine/UI state is reset—reinserting it would duplicate text.
  private func finishCompositionBeforeModifierPassThrough(client: IMKTextInput?) {
    guard engineClient.hasComposition(sessionId: sessionId) else { return }
    if usesInlineComposition, let client {
      _ = commitRawComposition(client: client, suffix: "")
      return
    }
    engineClient.resetSession(sessionId)
    clearCompositionOwner()
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
  }

  open override func candidates(_ sender: Any!) -> [Any]! {
    guard !secureInputActive() else { return [] }
    return candidateState.currentState().candidates
  }

  open override func candidateSelected(_ candidateString: NSAttributedString!) {
    guard let text = candidateString?.string, !text.isEmpty, let client = self.client() else {
      return
    }
    guard !secureInputActive() else {
      clearStateForSecureInput(client: client)
      return
    }
    if modeMenuOpen, let mode = modeFromMenuLabel(text) {
      guard finishCompositionBeforeModeSwitch(client: client) else { return }
      selectNativeMode(mode)
      modeMenuOpen = false
      return
    }
    // IMKCandidates may emit callbacks while refreshing its internal row
    // model. A callback is acceptance only after a physical navigation command
    // made selection explicit and the value still belongs to this snapshot.
    guard candidateSelectionExplicit,
          isCurrentCandidateSurface(for: client),
          candidateState.currentState().candidates.contains(text) else { return }
    candidateSelectionExplicit = true
    commitCandidateText(text, client: client, suffix: "")
  }

  open override func candidateSelectionChanged(_ candidateString: NSAttributedString!) {
    guard !secureInputActive() else {
      clearStateForSecureInput(client: self.client())
      return
    }
    guard let text = candidateString?.string, !text.isEmpty else {
      return
    }
    // IMK may emit this callback just by refreshing its own panel. It cannot
    // promote a passive row into an accepted selection; only a physical
    // navigation command may do that.
    if candidateSelectionExplicit,
       let client = self.client(),
       isCurrentCandidateSurface(for: client),
       let index = candidateState.currentState().candidates.firstIndex(of: text) {
      candidateState.select(index: index)
      if !refreshCandidatePanel().isVisible {
        revokeCandidateAcceptance()
      }
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
    menu.addItem(.separator())
    let privateMode = NSMenuItem(
      title: LekhL10n.text("menu.privateMode"),
      action: #selector(togglePrivateModeFromInputMenu(_:)),
      keyEquivalent: ""
    )
    privateMode.target = self
    privateMode.state = LekhNativePreferences.personalizationEnabled ? .off : .on
    privateMode.toolTip = LekhL10n.text("menu.privateMode.help")
    menu.addItem(privateMode)
    if !secureInputActive(), let currentCandidate = candidateState.selectedCandidate() {
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

    if LekhDiagnosticsPolicy.diagnosticsEnabled(secureInputActive: secureInputActive()) {
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
    guard finishCompositionBeforeModeSwitch(client: self.client()) else { return }
    selectNativeMode(mode)
    modeMenuOpen = false
  }

  @objc private func forgetCurrentCandidateFromInputMenu(_ item: NSMenuItem) {
    guard !secureInputActive() else {
      clearStateForSecureInput(client: self.client())
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

  @objc private func togglePrivateModeFromInputMenu(_ item: NSMenuItem) {
    let enablePrivateMode = LekhNativePreferences.personalizationEnabled
    UserDefaults.standard.set(!enablePrivateMode, forKey: LekhNativePreferences.Keys.personalizationEnabled)
    UserDefaults.standard.synchronize()
    postSharedPreferencesChanged()
    item.state = enablePrivateMode ? .on : .off
    lekhNativeLog("privacy.privateMode enabled=\(enablePrivateMode ? 1 : 0)")
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
    if openCompanionApplication(onFailure: { [weak self] in
      self?.showLegacyPreferences()
    }) {
      return
    }
    showLegacyPreferences()
  }

  private func showLegacyPreferences() {
    LekhPreferencesWindowController.shared.show { [weak self] in
      guard let self else { return "diagnostics=unavailable" }
      return [
        self.engineClient.diagnosticsSummary(),
        self.latencyTelemetry.summary()
      ].joined(separator: "\n\n")
    }
  }

  @objc private func showTutorialFromInputMenu(_ item: NSMenuItem) {
    if openCompanionApplication(onFailure: {
      LekhPreferencesWindowController.shared.showTutorial()
    }) {
      return
    }
    LekhPreferencesWindowController.shared.showTutorial()
  }

  @discardableResult
  private func openCompanionApplication(onFailure: @escaping () -> Void) -> Bool {
    let workspace = NSWorkspace.shared
    let companionURL = workspace.urlForApplication(withBundleIdentifier: lekhCompanionBundleIdentifier)
      ?? [
        "/Applications/Lekh Keyboard Companion.app",
        ("~/Applications/Lekh Keyboard Companion.app" as NSString).expandingTildeInPath
      ]
      .map(URL.init(fileURLWithPath:))
      .first(where: { FileManager.default.fileExists(atPath: $0.path) })
    guard let companionURL else { return false }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.addsToRecentItems = false
    workspace.openApplication(at: companionURL, configuration: configuration) { _, error in
      guard error != nil else { return }
      DispatchQueue.main.async(execute: onFailure)
    }
    return true
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
    if key == lekhArrowDownKey || key == lekhArrowUpKey || modifiers.contains(.option) {
      let state = candidateState.currentState()
      lekhHostProbeLog(
        "surface.command route=\(route) composition=\(engineClient.hasComposition(sessionId: sessionId) ? 1 : 0) candidates=\(state.candidates.count) explicit=\(candidateSelectionExplicit ? 1 : 0)"
      )
    }
    guard usesInlineComposition,
          engineClient.hasComposition(sessionId: sessionId),
          let client = sender as? IMKTextInput else {
      return false
    }

    if key == "\t", modifiers.contains(.shift) {
      // Preserve native reverse-focus traversal. Commit raw, then return false
      // so the host receives Shift-Tab exactly once.
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }

    if modifiers.contains(.command) || modifiers.contains(.control) || modifiers.contains(.shift) {
      return false
    }

    if key == lekhArrowDownKey {
      dismissInlineSuggestion()
      guard candidateState.moveSelection(delta: 1) != nil else { return false }
      candidateSelectionExplicit = true
      compositionSurfacesDismissed = false
      guard refreshCandidatePanel(announceSelection: true).isVisible else {
        revokeCandidateAcceptance()
        lekhHostProbeLog("surface.command down handled=0 reason=unavailable")
        return false
      }
      lekhHostProbeLog("surface.command down handled=1")
      lekhNativeLog("candidate.navigate route=\(route) direction=down")
      return true
    }

    if key == lekhArrowUpKey {
      dismissInlineSuggestion()
      guard candidateState.moveSelection(delta: -1) != nil else { return false }
      candidateSelectionExplicit = true
      compositionSurfacesDismissed = false
      guard refreshCandidatePanel(announceSelection: true).isVisible else {
        revokeCandidateAcceptance()
        lekhHostProbeLog("surface.command up handled=0 reason=unavailable")
        return false
      }
      lekhNativeLog("candidate.navigate route=\(route) direction=up")
      return true
    }

    if key == lekhPageDownKey || key == lekhPageUpKey {
      dismissInlineSuggestion()
      let delta = key == lekhPageDownKey ? 1 : -1
      guard candidateState.movePage(delta: delta, pageSize: LekhCandidatePanel.pageSize) != nil else { return false }
      candidateSelectionExplicit = true
      compositionSurfacesDismissed = false
      guard refreshCandidatePanel(announceSelection: true).isVisible else {
        revokeCandidateAcceptance()
        return false
      }
      lekhNativeLog("candidate.navigate route=\(route) direction=page delta=\(delta)")
      return true
    }

    if candidateSelectionExplicit, (key == lekhHomeKey || key == lekhEndKey) {
      guard candidateState.selectBoundary(first: key == lekhHomeKey) != nil else { return false }
      guard refreshCandidatePanel(announceSelection: true).isVisible else {
        revokeCandidateAcceptance()
        return false
      }
      return true
    }

    let candidateSurfaceIsVisible = isCurrentCandidateSurface(for: client)
    // Once the user has entered candidate browsing with an Arrow key, the
    // synchronous selection state is authoritative even if AppKit has not yet
    // painted the panel. Before browsing, Option-number is accepted only for a
    // row that is actually visible; this prevents invisible candidate commits.
    let explicitShortcut = candidateSurfaceIsVisible &&
      (candidateSelectionExplicit || modifiers.contains(.option))
    if explicitShortcut,
       let shortcutNumber = candidateShortcutIndex(key: key, keyCode: keyCode),
       shortcutNumber <= (candidateSelectionExplicit ? LekhCandidatePanel.pageSize : LekhCandidatePanel.passiveVisibleRows),
       let candidateIndex = candidateState.indexForShortcut(shortcutNumber, pageSize: LekhCandidatePanel.pageSize),
       let candidate = candidateState.select(index: candidateIndex) {
      candidateSelectionExplicit = true
      lekhNativeLog("candidate.shortcut route=\(route) index=\(candidateIndex)")
      return commitCandidateText(candidate, client: client, suffix: "")
    }

    // Option is reserved for the explicit candidate shortcut above (and the
    // traditional Option layer handled by the caller). Never consume another
    // Option-modified keystroke here.
    if modifiers.contains(.option) {
      return false
    }

    if candidateSelectionExplicit,
       isPunctuationKey(key),
       isCurrentCandidateSurface(for: client) {
      let punctuation = engineClient.normalizedPunctuation(key, mode: nativeMode)
      lekhNativeLog("candidate.accept route=\(route) key=punctuation")
      return commitSelectedCandidate(client: client, suffix: punctuation)
    }

    if key == lekhArrowRightKey, let suggestion = visibleInlineSuggestion(for: client) {
      candidateSelectionExplicit = true
      lekhNativeLog("inlineSuggestion.accept route=\(route) key=right")
      return commitInlineSuggestion(suggestion, client: client)
    }

    if key == " " {
      return commitCurrentComposition(client: client, suffix: " ")
    }

    if key == "\n" {
      return commitCurrentComposition(client: client, suffix: "\n")
    }

    if key == "\t", !modifiers.contains(.shift) {
      if let suggestion = visibleInlineSuggestion(for: client) {
        candidateSelectionExplicit = true
        lekhNativeLog("inlineSuggestion.accept route=\(route) key=tab")
        return commitInlineSuggestion(suggestion, client: client)
      }
      if candidateSelectionExplicit {
        return commitSelectedCandidate(client: client, suffix: "")
      }
      // Preserve the composition as raw text and let the host receive Tab.
      _ = commitRawComposition(client: client, suffix: "")
      return false
    }

    if key == "\u{1b}" {
      return handleEscape(client: client, route: route)
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

  private func isPunctuationKey(_ key: String) -> Bool {
    guard key.count == 1, let scalar = key.unicodeScalars.first else { return false }
    return CharacterSet.punctuationCharacters.contains(scalar)
  }

  private func commitSelectedCandidate(client: IMKTextInput, suffix: String) -> Bool {
    guard candidateSelectionExplicit,
          isCurrentCandidateSurface(for: client),
          let selected = candidateState.selectedCandidate() else {
      return false
    }
    return commitCandidateText(selected, client: client, suffix: suffix)
  }

  private func commitRawComposition(client: IMKTextInput, suffix: String) -> Bool {
    guard !secureInputActive() else {
      clearStateForSecureInput(client: client)
      return false
    }
    guard mayMutateComposition(client) else { return false }
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
    clearCompositionOwner()
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
    lekhNativeLog("composition.commitRaw length=\((raw + suffix).utf16.count)")
    return true
  }

  /// Performs a passive delimiter commit only from evidence produced for the
  /// exact current raw token. The controller repeats the release-critical
  /// invariants as defense in depth; malformed or stale metadata fails open to
  /// `commitRawComposition` rather than changing what the user typed.
  private func commitAutoCommitCandidate(
    _ candidate: LekhAutoCommitCandidate,
    client: IMKTextInput,
    suffix: String
  ) -> Bool {
    guard !secureInputActive() else {
      clearStateForSecureInput(client: client)
      return false
    }
    guard mayMutateComposition(client) else { return false }
    let raw = engineClient.rawBuffer(sessionId: sessionId)
    guard isValidAutoCommitCandidate(candidate, rawBuffer: raw) else {
      activeAutoCommitCandidate = nil
      return commitRawComposition(client: client, suffix: suffix)
    }

    // Passive auto-commit must never train personalization. Only an explicit
    // Tab/arrow/mouse/shortcut acceptance reaches commitCandidateText.
    engineClient.observeCommit(
      sessionId: sessionId,
      rawInput: raw,
      chosenOutput: candidate.text,
      allowPersonalization: false
    )
    client.insertText(candidate.text + suffix, replacementRange: replacementRange(for: client))
    engineClient.resetSession(sessionId)
    clearCompositionOwner()
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
    lekhNativeLog(
      "composition.autoCommit policy=\(candidate.policy.rawValue) length=\((candidate.text + suffix).utf16.count)"
    )
    return true
  }

  private func isValidAutoCommitCandidate(
    _ candidate: LekhAutoCommitCandidate,
    rawBuffer: String
  ) -> Bool {
    guard !rawBuffer.isEmpty,
          candidate.sourceInput == rawBuffer,
          !candidate.text.isEmpty,
          !candidate.sourceInput.unicodeScalars.contains(where: {
            CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
          }),
          !candidate.text.unicodeScalars.contains(where: {
            CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0)
          }) else {
      return false
    }

    let targetHasDevanagari = candidate.text.range(
      of: #"\p{Devanagari}"#,
      options: .regularExpression
    ) != nil
    let targetHasLatin = candidate.text.range(of: #"[A-Za-z]"#, options: .regularExpression) != nil

    switch candidate.policy {
    case .calibratedExactDeterministicToken:
      guard nativeMode == .romanizedTraditional,
            let probability = candidate.calibratedProbability,
            let margin = candidate.margin else { return false }
      return probability >= 0.92 && margin >= 0.12 && targetHasDevanagari && !targetHasLatin
    case .uniqueReversibleReverse:
      return nativeMode == .traditionalRomanized && !targetHasDevanagari
    }
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
      let decision = engineDecision(for: key, route: route)
      candidateState.updateCandidates(
        decision.candidates,
        rawBuffer: engineClient.rawBuffer(sessionId: sessionId),
        modeLabel: nativeMode.menuLabel
      )
      if decision.shouldCancel {
        hideCandidates()
      }
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

    // A delimiter decision ends the engine composition even when the host
    // cannot safely expose a document range. Revoke all stale candidate UI
    // before returning the delimiter to the host.
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()

    guard let client = sender as? IMKTextInput else {
      lekhNativeLog("failOpen route=\(route) action=noClient")
      return false
    }

    if replacePreviouslyPassedThroughRawText(raw, with: committed, client: client) {
      lekhNativeLog("failOpen route=\(route) action=replace rawLength=\(raw.utf16.count) committedLength=\(committed.utf16.count)")
      return true
    }

    lekhNativeLog("failOpen route=\(route) action=replaceFailed rawLength=\(raw.utf16.count)")
    return false
  }

  private func replacePreviouslyPassedThroughRawText(_ raw: String, with committed: String, client: IMKTextInput) -> Bool {
    let selection = client.selectedRange()
    let rawLength = raw.utf16.count
    guard let range = LekhFailOpenReplacementPolicy.replacementRange(
      rawUTF16Length: rawLength,
      selection: selection
    ) else { return false }
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
    case 115:
      return lekhHomeKey
    case 116:
      return lekhPageUpKey
    case 119:
      return lekhEndKey
    case 121:
      return lekhPageDownKey
    case 123:
      return lekhArrowLeftKey
    case 124:
      return lekhArrowRightKey
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
    return modifiers.contains(.command) || modifiers.contains(.control) || modifiers.contains(.option)
  }

  private func canConsumeInputTextBatch(_ string: String) -> Bool {
    string.allSatisfy { character in
      let key = String(character)
      guard key.count == 1, let scalar = key.unicodeScalars.first else { return false }
      return CharacterSet.alphanumerics.contains(scalar) ||
        (scalar.value >= 0x0900 && scalar.value <= 0x097F)
    }
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
    clearCompositionOwner()
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
    CFPreferencesAppSynchronize(lekhSharedPreferencesDomain as CFString)
    UserDefaults.standard.synchronize()
    if let rawValue = UserDefaults.standard.string(forKey: lekhNativeModeDefaultsKey),
       let mode = LekhNativeTypingMode(rawValue: rawValue) {
      nativeMode = mode
    }
  }

  private func selectNativeMode(_ mode: LekhNativeTypingMode, persist: Bool = true) {
    nativeMode = mode
    pendingNativeMode = nil
    pendingNativeModeRequiresPersistence = false
    sharedPreferencesReloadPending = false
    if persist {
      UserDefaults.standard.set(mode.rawValue, forKey: lekhNativeModeDefaultsKey)
      UserDefaults.standard.set(true, forKey: lekhNativeModeChosenDefaultsKey)
      UserDefaults.standard.synchronize()
      postSharedPreferencesChanged()
    }
    engineClient.endSession(sessionId)
    clearCompositionOwner()
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: mode.menuLabel)
    hideCandidates()
    setKeyboardLayoutOverride()
    lekhNativeLog("mode.selected \(mode.rawValue)")
  }

  @discardableResult
  private func finishCompositionBeforeModeSwitch(client: IMKTextInput?) -> Bool {
    guard engineClient.hasComposition(sessionId: sessionId) else { return true }
    guard let client else { return false }
    if secureInputActive() {
      clearStateForSecureInput(client: client)
      return true
    }
    return commitRawComposition(client: client, suffix: "")
  }

  private func observeNativeModeChanges() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(nativeModePreferenceDidChange(_:)),
      name: lekhNativeModeDidChangeNotification,
      object: nil
    )
  }

  private func observeSharedPreferencesChanges() {
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      lekhSharedPreferencesDidChange,
      lekhSharedPreferencesDidChangeName.rawValue,
      nil,
      .deliverImmediately
    )
  }

  fileprivate func sharedPreferencesDidChange() {
    guard Thread.isMainThread else {
      DispatchQueue.main.async { [weak self] in
        self?.sharedPreferencesDidChange()
      }
      return
    }
    // Synchronize once per explicit settings change, including while a word is
    // active, so privacy switches such as Personal Learning Off affect that
    // word's eventual commit. Mode mutation itself remains boundary-gated.
    CFPreferencesAppSynchronize(lekhSharedPreferencesDomain as CFString)
    UserDefaults.standard.synchronize()
    if let rawMode = UserDefaults.standard.string(forKey: lekhNativeModeDefaultsKey),
       let mode = LekhNativeTypingMode(rawValue: rawMode),
       mode != nativeMode {
      pendingNativeMode = mode
      pendingNativeModeRequiresPersistence = false
    }
    if !LekhNativePreferences.inlinePreviewEnabled {
      if pendingInlineSuggestion != nil || activeInlineSuggestion != nil || inlinePreviewPanel.isVisible {
        recordGhostSuppression(.preferenceDisabled)
      }
      pendingInlineSuggestion = nil
      activeInlineSuggestion = nil
      activeInlineSuggestionToken = nil
      inlinePreviewPanel.hide()
    }
    sharedPreferencesReloadPending = true
  }

  private func postSharedPreferencesChanged() {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      lekhSharedPreferencesDidChangeName,
      nil,
      nil,
      true
    )
  }

  private func applyPendingPreferencesAtBoundary(force: Bool = false) {
    guard force || sharedPreferencesReloadPending || pendingNativeMode != nil else { return }
    guard !engineClient.hasComposition(sessionId: sessionId) else { return }

    let locallyRequestedMode = pendingNativeMode
    let shouldPersistMode = pendingNativeModeRequiresPersistence
    pendingNativeMode = nil
    pendingNativeModeRequiresPersistence = false
    sharedPreferencesReloadPending = false
    CFPreferencesAppSynchronize(lekhSharedPreferencesDomain as CFString)
    UserDefaults.standard.synchronize()

    let storedMode = UserDefaults.standard.string(forKey: lekhNativeModeDefaultsKey)
      .flatMap(LekhNativeTypingMode.init(rawValue:))
    guard let mode = locallyRequestedMode ?? storedMode, mode != nativeMode else { return }
    selectNativeMode(mode, persist: shouldPersistMode)
    lekhNativeLog("preferences.appliedAtBoundary mode=\(mode.rawValue)")
  }

  @objc private func nativeModePreferenceDidChange(_ notification: Notification) {
    guard let rawValue = notification.userInfo?["mode"] as? String,
          let mode = LekhNativeTypingMode(rawValue: rawValue),
          mode != nativeMode else { return }
    if engineClient.hasComposition(sessionId: sessionId) {
      pendingNativeMode = mode
      pendingNativeModeRequiresPersistence = true
      return
    }
    selectNativeMode(mode)
  }

  private func showModePicker() {
    guard finishCompositionBeforeModeSwitch(client: self.client()) else { return }
    modeMenuOpen = false
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      LekhModePickerWindowController.shared.show(current: self.nativeMode) { [weak self] mode in
        guard let self,
              self.finishCompositionBeforeModeSwitch(client: self.client()) else { return }
        self.selectNativeMode(mode)
      }
    }
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
    if candidateSelectionExplicit,
       isCurrentCandidateSurface(for: client),
       let selected = candidateState.selectedCandidate() {
      return commitCandidateText(selected, client: client, suffix: suffix)
    }
    // A palette may disappear between key-down and commit. Once visibility or
    // client binding is lost, the selected row is no longer authority; Space
    // and Return fail open to the engine-authorized candidate or exact raw text.
    revokeCandidateAcceptance()
    if let autoCommitCandidate = activeAutoCommitCandidate {
      return commitAutoCommitCandidate(autoCommitCandidate, client: client, suffix: suffix)
    }
    return commitRawComposition(client: client, suffix: suffix)
  }

  private func handleEscape(client: IMKTextInput, route: String) -> Bool {
    if dismissCompositionAlternatives(client: client) {
      lekhNativeLog("composition.escape route=\(route) action=revertAndCommitRaw")
      return true
    }
    // Defensive fallback for any active composition whose surfaces were
    // already dismissed through another route. Consume the Escape that commits
    // raw; the next Escape reaches the host with no marked text left to cancel.
    return commitRawComposition(client: client, suffix: "")
  }

  private func dismissCompositionAlternatives(client: IMKTextInput) -> Bool {
    guard !compositionSurfacesDismissed else { return false }
    let raw = engineClient.rawBuffer(sessionId: sessionId)
    guard !raw.isEmpty, mayMutateComposition(client) else { return false }

    compositionSurfacesDismissed = true
    if presentedMarkedText != raw {
      let display = markedTextObject(raw)
      client.setMarkedText(
        display.text,
        selectionRange: NSRange(location: display.cursorLocation, length: 0),
        replacementRange: replacementRange(for: client)
      )
      presentedMarkedText = raw
    }
    // Never pass Escape through while raw text is still marked: TextEdit and
    // several WebKit/Electron hosts interpret that as "cancel marked text" and
    // delete it. Commit raw now; a following Escape safely belongs to the host.
    return commitRawComposition(client: client, suffix: "")
  }

  private func clearStateForSecureInput(client: IMKTextInput?) {
    let hadComposition = engineClient.hasComposition(sessionId: sessionId)
    let clientOwnsComposition = isCompositionOwner(client)
    engineClient.endSession(sessionId)
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    activeAutoCommitCandidate = nil
    pendingInlineSuggestion = nil
    activeInlineSuggestion = nil
    hideCandidates()
    // Avoid sending an empty marked-text mutation for every secure-field key.
    // It is needed only for a nonsecure composition that was already active
    // when macOS enabled Secure Event Input.
    if hadComposition, clientOwnsComposition {
      client?.setMarkedText(
        "",
        selectionRange: NSRange(location: 0, length: 0),
        replacementRange: notFoundRange()
      )
    }
    clearCompositionOwner()
  }

  private func cancelLocalComposition(client: IMKTextInput?) {
    let clientOwnsComposition = isCompositionOwner(client)
    engineClient.endSession(sessionId)
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    activeAutoCommitCandidate = nil
    pendingInlineSuggestion = nil
    activeInlineSuggestion = nil
    hideCandidates()
    if clientOwnsComposition {
      client?.setMarkedText("", selectionRange: NSRange(location: 0, length: 0), replacementRange: notFoundRange())
    }
    clearCompositionOwner()
  }

  private func apply(_ decision: LekhInputDecision, client sender: Any!, route: String) -> Bool {
    lekhNativeLog(
      "apply route=\(route) handled=\(decision.handled) passThrough=\(decision.shouldPassThrough) marked=\(decision.markedText == nil ? 0 : 1) committedLength=\(decision.committedText?.utf16.count ?? 0) candidates=\(decision.candidates.count)"
    )
    if decision.shouldPassThrough || !decision.handled { return false }
    guard let client = sender as? IMKTextInput else {
      engineClient.resetSession(sessionId)
      clearCompositionOwner()
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
      guard mayMutateComposition(client) else { return false }
      client.insertText(committedText, replacementRange: replacementRange(for: client))
      candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
      candidateSelectionExplicit = false
      activeAutoCommitCandidate = nil
      presentedMarkedText = nil
      clearCompositionOwner()
      hideCandidates()
      return true
    }

    if let markedText = decision.markedText {
      let display = markedTextObject(markedText)
      bindCompositionOwner(to: client)
      client.setMarkedText(
        display.text,
        selectionRange: NSRange(location: display.cursorLocation, length: 0),
        replacementRange: replacementRange(for: client)
      )
      presentedMarkedText = markedText
      compositionSurfacesDismissed = false
      let rawBuffer = engineClient.rawBuffer(sessionId: sessionId)
      activeAutoCommitCandidate = decision.autoCommitCandidate.flatMap {
        isValidAutoCommitCandidate($0, rawBuffer: rawBuffer) ? $0 : nil
      }
      let inlinePreviewEnabled = LekhNativePreferences.inlinePreviewEnabled
      let hadPresentedGhost = inlinePreviewPanel.isVisible && activeInlineSuggestion != nil
      if inlinePreviewEnabled {
        pendingInlineSuggestion = decision.inlineSuggestion
        if decision.inlineSuggestion == nil {
          recordGhostSuppression(.noEligibleCompletion)
        } else if hadPresentedGhost {
          recordGhostSuppression(.compositionChanged)
        }
      } else {
        pendingInlineSuggestion = nil
        if decision.inlineSuggestion != nil || hadPresentedGhost {
          recordGhostSuppression(.preferenceDisabled)
        }
      }
      lekhHostProbeLog(
        "surface.decision mode=\(nativeMode.rawValue) candidates=\(decision.candidates.count) suggestion=\(pendingInlineSuggestion == nil ? 0 : 1) markedRaw=\(decision.markedText == rawBuffer ? 1 : 0)"
      )
      // Acceptance is authorized only after the ghost panel reports that it is
      // truly on screen at a valid host caret rectangle.
      activeInlineSuggestion = nil
      updateCandidates(
        decision.candidates,
        neuralTailEligible: decision.neuralTailEligible
      )
      scheduleCompositionSurfaces(rawBuffer: rawBuffer)
      return true
    }

    return false
  }

  private func markedTextObject(_ rawText: String) -> LekhMarkedCompositionDisplay {
    let rawRange = NSRange(location: 0, length: rawText.utf16.count)
    let attributed = NSMutableAttributedString(string: rawText)
    let attributes = mark(forStyle: Int(kTSMHiliteSelectedConvertedText), at: rawRange) ?? [:]
    for (key, value) in attributes {
      if let attributeKey = key as? NSAttributedString.Key {
        attributed.addAttribute(attributeKey, value: value, range: rawRange)
      } else if let keyString = key as? String {
        attributed.addAttribute(NSAttributedString.Key(keyString), value: value, range: rawRange)
      }
    }
    // Let the host retain its own font, size, foreground color, writing
    // direction, and accessibility appearance. AppKit's marked-text style is
    // the native composition signal; add only an underline when the style does
    // not already provide one.
    if attributed.attribute(.underlineStyle, at: 0, effectiveRange: nil) == nil {
      attributed.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: rawRange)
    }

    return LekhMarkedCompositionDisplay(text: attributed, cursorLocation: rawText.utf16.count)
  }

  private func updateCandidates(_ candidates: [String], neuralTailEligible: Bool) {
    let rawBuffer = engineClient.rawBuffer(sessionId: sessionId)
    revokeCandidateAcceptance()
    candidateState.updateCandidates(candidates, rawBuffer: rawBuffer, modeLabel: nativeMode.menuLabel)
    candidateState.clearSelection()
    if neuralTailEligible {
      requestAsyncNeuralCandidates(rawBuffer: rawBuffer, deterministicCandidates: candidates)
    } else {
      // A new deterministic/canonical/personal hit supersedes any earlier OOV
      // request. Cancellation prevents needless Core ML work and stale tail
      // rows while leaving the keystroke path fully local and synchronous.
      neuralCandidateService.cancelPending()
    }
  }

  private func scheduleCompositionSurfaces(rawBuffer: String) {
    surfaceRenderGeneration += 1
    let generation = surfaceRenderGeneration
    let sessionSnapshot = sessionId
    scheduleCompositionSurfaceRender(
      rawBuffer: rawBuffer,
      sessionSnapshot: sessionSnapshot,
      generation: generation,
      attempt: 0
    )
  }

  private func scheduleCompositionSurfaceRender(
    rawBuffer: String,
    sessionSnapshot: String,
    generation: Int,
    attempt: Int
  ) {
    guard Self.compositionSurfaceRetryDelays.indices.contains(attempt) else { return }
    let delay = Self.compositionSurfaceRetryDelays[attempt]
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      // Secure Event Input can turn on after a nonsecure key scheduled this
      // render but before AppKit supplies caret geometry. Re-check here so no
      // stale completion surface or evidence crosses that boundary.
      guard !self.secureInputActive() else {
        self.clearStateForSecureInput(client: self.client())
        return
      }
      guard self.surfaceRenderGeneration == generation,
            self.sessionId == sessionSnapshot,
            self.engineClient.rawBuffer(sessionId: sessionSnapshot) == rawBuffer,
            !self.compositionSurfacesDismissed else { return }

      guard let surfaceClient = self.client(), self.isCompositionOwner(surfaceClient) else {
        // A delayed render must never follow focus to a different responder.
        // Keep the old marked range untouched; only its auxiliary UI is stale.
        if self.pendingInlineSuggestion != nil {
          self.recordGhostSuppression(.compositionOwnerChanged)
        }
        self.hideCandidates()
        lekhNativeLog("surface.suppressed reason=compositionOwnerMismatch")
        return
      }
      let freshAnchor = self.compositionAnchor(for: surfaceClient)
      if let freshAnchor {
        self.lastCompositionAnchorRect = freshAnchor.rect
        self.lastCompositionAnchorFont = freshAnchor.hostFont
        self.lastCompositionAnchorToken = self.makeSurfaceToken(for: surfaceClient)
      }
      let cachedAnchor = self.isCurrentSurfaceToken(self.lastCompositionAnchorToken, client: surfaceClient)
        ? self.lastCompositionAnchorRect
        : nil
      let anchorRect = freshAnchor?.rect ?? cachedAnchor
      let hostFont = freshAnchor?.hostFont ?? (
        self.isCurrentSurfaceToken(self.lastCompositionAnchorToken, client: surfaceClient)
          ? self.lastCompositionAnchorFont
          : nil
      )
      lekhHostProbeLog(
        "surface.attempt index=\(attempt) suggestion=\(self.pendingInlineSuggestion == nil ? 0 : 1) anchor=\(anchorRect == nil ? 0 : 1)"
      )

      if freshAnchor == nil,
         Self.compositionSurfaceRetryDelays.indices.contains(attempt + 1) {
        self.scheduleCompositionSurfaceRender(
          rawBuffer: rawBuffer,
          sessionSnapshot: sessionSnapshot,
          generation: generation,
          attempt: attempt + 1
        )
        return
      }

      var ghostIsVisible = false
      if let suggestion = self.pendingInlineSuggestion {
        if anchorRect != nil {
          ghostIsVisible = self.inlinePreviewPanel.show(
            suffix: suggestion.suffix,
            anchorRect: anchorRect,
            hostFont: hostFont,
            acceptanceHint: LekhL10n.text("inline.preview.acceptHint"),
            announce: false
          )
          if ghostIsVisible {
            self.recordGhostOffered()
          } else {
            self.recordGhostSuppression(.presentationUnavailable)
          }
        } else {
          self.recordGhostSuppression(.hostGeometryUnavailable)
          self.inlinePreviewPanel.hide()
        }
        self.activeInlineSuggestion = ghostIsVisible ? suggestion : nil
        self.activeInlineSuggestionToken = ghostIsVisible
          ? self.makeSurfaceToken(for: surfaceClient)
          : nil
        if ghostIsVisible, let token = self.activeInlineSuggestionToken {
          self.scheduleInlineSuggestionAnnouncement(suggestion: suggestion, token: token)
        }
      } else {
        self.activeInlineSuggestion = nil
        self.activeInlineSuggestionToken = nil
        self.inlinePreviewPanel.hide()
      }
      lekhHostProbeLog(
        "surface.result ghost=\(ghostIsVisible ? 1 : 0) visible=\(self.inlinePreviewPanel.isVisible ? 1 : 0) appHidden=\(NSApp.isHidden ? 1 : 0)"
      )
      if UserDefaults.standard.bool(forKey: lekhHostProbeDiagnosticsKey) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
          guard let self else { return }
          lekhHostProbeLog("surface.persistence delay=100 visible=\(self.inlinePreviewPanel.isVisible ? 1 : 0)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
          guard let self else { return }
          lekhHostProbeLog("surface.persistence delay=500 visible=\(self.inlinePreviewPanel.isVisible ? 1 : 0)")
        }
      }

      // Progressive disclosure: a concise completion and a full candidate
      // list never compete for attention. Down/Up dismisses the ghost and opens
      // the expanded list on demand.
      if ghostIsVisible {
        self.hideCandidateWindow()
      } else {
        self.refreshCandidatePanel(anchorRect: anchorRect)
      }
    }
  }

  private func requestAsyncNeuralCandidates(rawBuffer: String, deterministicCandidates: [String]) {
    if secureInputActive() {
      neuralCandidateService.cancelPending()
      return
    }
    guard nativeMode == .romanizedTraditional,
          !rawBuffer.isEmpty,
          rawBuffer.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return }
    let sessionSnapshot = sessionId
    neuralCandidateService.candidates(for: rawBuffer, secureInputActive: secureInputActive()) { [weak self] neuralCandidates in
      guard let self,
            !self.secureInputActive(),
            self.sessionId == sessionSnapshot,
            self.engineClient.rawBuffer(sessionId: sessionSnapshot) == rawBuffer,
            let client = self.client(),
            self.isCompositionOwner(client),
            !neuralCandidates.isEmpty else { return }
      let merged = Self.uniqueCandidates(deterministicCandidates + neuralCandidates, limit: 8)
      self.candidateState.updateCandidates(merged, rawBuffer: rawBuffer, modeLabel: self.nativeMode.menuLabel)
      if !self.compositionSurfacesDismissed,
         self.visibleInlineSuggestion(for: self.client()) == nil {
        self.refreshCandidatePanel()
      }
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

  @discardableResult
  private func refreshCandidatePanel(
    anchorRect: NSRect? = nil,
    announceSelection: Bool = false
  ) -> LekhCandidatePresentation {
    guard let presentationClient = self.client(),
          isCompositionOwner(presentationClient) else {
      hideCandidateWindow()
      return .unavailable
    }
    guard !compositionSurfacesDismissed,
          visibleInlineSuggestion(for: presentationClient) == nil else {
      hideCandidateWindow()
      return .unavailable
    }
    let state = candidateState.currentState()
    let candidates = state.candidates
    if candidates.isEmpty {
      hideCandidateWindow()
      return .unavailable
    }
    // A passive one-row panel repeats the marked-text preview without giving
    // the user a decision. Suppress that visual churn while typing prefixes;
    // an explicit Arrow command sets `candidateSelectionExplicit` first and
    // still opens the single available row when the user asks for choices.
    if !candidateSelectionExplicit, candidates.count < 2 {
      hideCandidateWindow()
      lekhHostProbeLog("surface.candidates suppressed=singlePassive count=\(candidates.count)")
      return .unavailable
    }
    if LekhNativePreferences.customCandidatePanelEnabled {
      candidatePanel?.hide()
      candidatePresentationToken = nil
      let freshContext = anchorRect == nil ? compositionAnchor(for: presentationClient) : nil
      let freshAnchor = anchorRect ?? freshContext?.rect
      if let freshAnchor {
        lastCompositionAnchorRect = freshAnchor
        if let freshContext {
          lastCompositionAnchorFont = freshContext.hostFont
        }
        lastCompositionAnchorToken = makeSurfaceToken(for: presentationClient)
      }
      let cachedAnchor = isCurrentSurfaceToken(lastCompositionAnchorToken, client: presentationClient)
        ? lastCompositionAnchorRect
        : nil
      let presentationToken = makeSurfaceToken(for: presentationClient)
      let presentationActivationIdentifier = runtimeActivationIdentifier
      let panelShown = customCandidatePanel.show(
        items: state.displayItems,
        title: nativeMode.menuLabel,
        sourceText: presentationToken?.rawBuffer,
        selectedIndex: state.selectedIndex,
        anchorRect: freshAnchor ?? cachedAnchor,
        expanded: candidateSelectionExplicit,
        passiveCommitText: activeAutoCommitCandidate?.text,
        announceSelection: announceSelection,
        onDragCancellation: { [weak self] in
          guard let self,
                let client = self.client(),
                let presentationActivationIdentifier,
                !self.secureInputActive(),
                self.runtimeActivationIdentifier == presentationActivationIdentifier,
                self.isCurrentSurfaceToken(presentationToken, client: client),
                self.candidatePresentationToken == presentationToken,
                self.customCandidatePanel.isVisible else {
            return
          }
          LekhRuntimeHealth.markCandidateDragCancellation(
            activationIdentifier: presentationActivationIdentifier
          )
        },
        onSelect: { [weak self] selectedIndex, selectedText in
          guard let self, let client = self.client() else { return }
          guard !self.secureInputActive(),
                self.isCurrentSurfaceToken(presentationToken, client: client),
                self.candidatePresentationToken == presentationToken,
                self.customCandidatePanel.isVisible else {
            return
          }
          let currentCandidates = self.candidateState.currentState().candidates
          guard currentCandidates.indices.contains(selectedIndex),
                currentCandidates[selectedIndex] == selectedText else { return }
          self.candidateState.select(index: selectedIndex)
          self.candidateSelectionExplicit = true
          self.commitCandidateText(selectedText, client: client, suffix: "")
        }
      )
      lekhHostProbeLog(
        "surface.candidates custom=1 count=\(state.displayItems.count) shown=\(panelShown ? 1 : 0) visible=\(customCandidatePanel.isVisible ? 1 : 0)"
      )
      if panelShown, let presentationToken {
        candidatePresentationToken = presentationToken
        return .visibleCustom
      }
      customCandidatePanel.hide()
      candidatePresentationToken = nil
      // A passive list is optional. An explicit Arrow command is not: when
      // custom geometry is unavailable, request the system candidate surface
      // and authorize the navigation only if that surface is truly visible.
      if !candidateSelectionExplicit {
        return .unavailable
      }
    }
    customCandidatePanel.hide()
    // IMKCandidates visually selects its first row automatically. Do not show
    // it during the passive state because passive delimiter authorization is
    // independent of list selection; show it only after Arrow navigation.
    guard candidateSelectionExplicit else {
      candidatePanel?.hide()
      candidatePresentationToken = nil
      lekhHostProbeLog("surface.candidates custom=0 explicit=0 shown=0")
      return .unavailable
    }
    candidatePanel?.update()
    candidatePanel?.show(kIMKLocateCandidatesBelowHint)
    let systemVisible = candidatePanel?.isVisible() == true
    lekhHostProbeLog("surface.candidates custom=0 explicit=1 shown=\(systemVisible ? 1 : 0)")
    guard systemVisible, let token = makeSurfaceToken(for: presentationClient) else {
      candidatePanel?.hide()
      candidatePresentationToken = nil
      return .unavailable
    }
    candidatePresentationToken = token
    return .visibleSystem
  }

  private func hideCandidates() {
    lekhHostProbeLog("surface.hide all")
    surfaceRenderGeneration += 1
    neuralCandidateService.cancelPending()
    activeAutoCommitCandidate = nil
    pendingInlineSuggestion = nil
    activeInlineSuggestion = nil
    activeInlineSuggestionToken = nil
    compositionSurfacesDismissed = false
    inlineAnnouncementGeneration += 1
    lastAnnouncedInlineAcceptedText = nil
    lastCompositionAnchorRect = nil
    lastCompositionAnchorFont = nil
    lastCompositionAnchorToken = nil
    presentedMarkedText = nil
    inlinePreviewPanel.hide()
    hideCandidateWindow()
  }

  private func hideCandidateWindow() {
    customCandidatePanel.hide()
    candidatePanel?.hide()
    revokeCandidateAcceptance()
  }

  private func dismissInlineSuggestion() {
    if pendingInlineSuggestion != nil || activeInlineSuggestion != nil || inlinePreviewPanel.isVisible {
      recordGhostSuppression(.candidateListRequested)
    }
    surfaceRenderGeneration += 1
    inlineAnnouncementGeneration += 1
    pendingInlineSuggestion = nil
    activeInlineSuggestion = nil
    activeInlineSuggestionToken = nil
    inlinePreviewPanel.hide()
  }

  /// VoiceOver hears only a suggestion that remains stable after the user's
  /// typing pause. Each new key invalidates the pending announcement, avoiding
  /// one spoken interruption per character while still announcing a materially
  /// changed completion later in the same composition.
  private func scheduleInlineSuggestionAnnouncement(
    suggestion: LekhInlineSuggestion,
    token: LekhSurfaceToken
  ) {
    guard NSWorkspace.shared.isVoiceOverEnabled,
          lastAnnouncedInlineAcceptedText != suggestion.acceptedText else { return }
    inlineAnnouncementGeneration += 1
    let announcementGeneration = inlineAnnouncementGeneration
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
      guard let self,
            self.inlineAnnouncementGeneration == announcementGeneration,
            self.inlinePreviewPanel.isVisible,
            self.isCurrentSurfaceToken(token, client: self.client()),
            self.activeInlineSuggestion?.acceptedText == suggestion.acceptedText,
            self.lastAnnouncedInlineAcceptedText != suggestion.acceptedText else { return }
      self.lastAnnouncedInlineAcceptedText = suggestion.acceptedText
      self.inlinePreviewPanel.announce(
        suffix: suggestion.suffix,
        acceptanceHint: LekhL10n.text("inline.preview.acceptHint")
      )
    }
  }

  /// A cached completion is actionable only while its nonactivating preview is
  /// still on a visible screen. Display removal, Space changes, and monitor
  /// detachment therefore cannot leave an invisible Tab/Right acceptance.
  private func visibleInlineSuggestion(for client: IMKTextInput?) -> LekhInlineSuggestion? {
    guard inlinePreviewPanel.isVisible,
          isCurrentSurfaceToken(activeInlineSuggestionToken, client: client) else {
      activeInlineSuggestion = nil
      activeInlineSuggestionToken = nil
      return nil
    }
    return activeInlineSuggestion
  }

  private func makeSurfaceToken(for client: IMKTextInput?) -> LekhSurfaceToken? {
    guard let client, isCompositionOwner(client) else { return nil }
    return LekhSurfaceToken(
      generation: surfaceRenderGeneration,
      sessionId: sessionId,
      rawBuffer: engineClient.rawBuffer(sessionId: sessionId),
      clientIdentifier: ObjectIdentifier(client as AnyObject)
    )
  }

  private func isCurrentSurfaceToken(
    _ token: LekhSurfaceToken?,
    client: IMKTextInput?
  ) -> Bool {
    guard let token, let client else { return false }
    return token.generation == surfaceRenderGeneration &&
      token.sessionId == sessionId &&
      token.rawBuffer == engineClient.rawBuffer(sessionId: sessionId) &&
      token.clientIdentifier == ObjectIdentifier(client as AnyObject)
  }

  private func isCurrentCandidateSurface(for client: IMKTextInput) -> Bool {
    let isVisible = customCandidatePanel.isVisible || candidatePanel?.isVisible() == true
    guard isVisible,
          isCurrentSurfaceToken(candidatePresentationToken, client: client) else {
      revokeCandidateAcceptance()
      return false
    }
    return true
  }

  private func revokeCandidateAcceptance() {
    candidateSelectionExplicit = false
    candidateState.clearSelection()
    candidatePresentationToken = nil
  }

  private func bindCompositionOwner(to client: IMKTextInput) {
    let object = client as AnyObject
    compositionOwnerObject = object
    compositionOwnerIdentifier = ObjectIdentifier(object)
  }

  private func clearCompositionOwner() {
    compositionOwnerObject = nil
    compositionOwnerIdentifier = nil
  }

  private func isCompositionOwner(_ client: IMKTextInput?) -> Bool {
    guard let client, let compositionOwnerIdentifier else { return false }
    return ObjectIdentifier(client as AnyObject) == compositionOwnerIdentifier
  }

  /// Drops only Lekh's in-memory state when a delayed callback arrives from a
  /// different host client. Mutating either document would be unsafe: the old
  /// client owns the marked range, while the new client owns the key event.
  private func prepareForClientTransition(_ client: IMKTextInput) {
    guard engineClient.hasComposition(sessionId: sessionId) else {
      if compositionOwnerIdentifier != nil, !isCompositionOwner(client) {
        clearCompositionOwner()
      }
      return
    }
    guard !isCompositionOwner(client) else { return }

    engineClient.endSession(sessionId)
    sessionId = UUID().uuidString
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    clearCompositionOwner()
    hideCandidates()
    lekhNativeLog("composition.abandon reason=clientTransition")
  }

  /// Document insertion is permitted only for the client whose marked range
  /// was established by this controller. A mismatch fails open without moving
  /// the caret or inserting into the newly focused app.
  private func mayMutateComposition(_ client: IMKTextInput) -> Bool {
    guard isCompositionOwner(client) else {
      prepareForClientTransition(client)
      return false
    }
    return true
  }

  private func compositionAnchor(for client: IMKTextInput?) -> LekhCompositionAnchor? {
    guard let client else { return nil }
    let markedRange = client.markedRange()
    let selectedRange = client.selectedRange()
    var candidateIndices: [Int] = []
    if markedRange.location != NSNotFound {
      // IMKTextInput explicitly requires this index to be relative to the
      // active inline session—not document-relative like selectedRange and
      // markedRange. Passing absolute offsets made panels work near document
      // position zero and drift or disappear later in a document.
      let compositionLength = max(presentedMarkedText?.utf16.count ?? markedRange.length, 0)
      if selectedRange.location != NSNotFound,
         selectedRange.location >= markedRange.location,
         selectedRange.location <= markedRange.location + markedRange.length {
        candidateIndices.append(selectedRange.location - markedRange.location)
      }
      candidateIndices.append(compositionLength)
      if compositionLength > 0 {
        candidateIndices.append(compositionLength - 1)
      }
      candidateIndices.append(0)
    } else {
      // The protocol specifies index zero when no inline-session range is
      // available, including clients without TSMDocumentAccess support.
      candidateIndices.append(0)
    }

    var attemptedIndices = Set<Int>()
    for characterIndex in candidateIndices where attemptedIndices.insert(characterIndex).inserted {
      var lineHeightRect = NSRect.zero
      let attributes = client.attributes(
        forCharacterIndex: characterIndex,
        lineHeightRectangle: &lineHeightRect
      )
      if Self.isUsableAnchorRect(lineHeightRect) {
        if lineHeightRect.width <= 0 {
          lineHeightRect.size.width = 1
        }
        let hostFont = attributes?.values.lazy.compactMap { $0 as? NSFont }.first
        return LekhCompositionAnchor(rect: lineHeightRect, hostFont: hostFont)
      }
    }
    return nil
  }

  private static func isUsableAnchorRect(_ rect: NSRect) -> Bool {
    guard rect.origin.x.isFinite,
          rect.origin.y.isFinite,
          rect.size.width.isFinite,
          rect.size.height.isFinite,
          rect.height > 0 else { return false }
    return NSScreen.screens.contains { $0.frame.intersects(rect) || $0.frame.contains(rect.origin) }
  }

  private func recordGhostOffered() {
    guard let runtimeActivationIdentifier else { return }
    LekhRuntimeHealth.markGhostOffered(
      activationIdentifier: runtimeActivationIdentifier
    )
  }

  private func deactivateRuntimeEvidence() {
    guard let runtimeActivationIdentifier else { return }
    LekhRuntimeHealth.markControllerDeactivated(
      activationIdentifier: runtimeActivationIdentifier
    )
    self.runtimeActivationIdentifier = nil
  }

  private func recordGhostAcceptanceHandled() {
    guard let runtimeActivationIdentifier else { return }
    LekhRuntimeHealth.markGhostAccepted(
      activationIdentifier: runtimeActivationIdentifier
    )
  }

  private func recordGhostSuppression(_ reason: LekhRuntimeHealth.GhostSuppressionReason) {
    guard let runtimeActivationIdentifier else { return }
    LekhRuntimeHealth.markGhostSuppressed(
      reason,
      activationIdentifier: runtimeActivationIdentifier
    )
  }

  @discardableResult
  private func commitInlineSuggestion(
    _ suggestion: LekhInlineSuggestion,
    client: IMKTextInput
  ) -> Bool {
    let dispatched = commitCandidateText(suggestion.acceptedText, client: client, suffix: "")
    if dispatched {
      recordGhostAcceptanceHandled()
    }
    return dispatched
  }

  @discardableResult
  private func commitCandidateText(_ text: String, client: IMKTextInput, suffix: String) -> Bool {
    guard !secureInputActive() else {
      clearStateForSecureInput(client: client)
      return false
    }
    guard mayMutateComposition(client) else { return false }
    lekhNativeLog("candidate.selected length=\(text.utf16.count)")
    let raw = engineClient.rawBuffer(sessionId: sessionId)
    engineClient.observeCommit(
      sessionId: sessionId,
      rawInput: raw,
      chosenOutput: text,
      allowPersonalization: shouldPersonalize(client: client) &&
        engineClient.mayPersonalizeExplicitChoice(
          rawInput: raw,
          chosenOutput: text,
          mode: nativeMode
        )
    )
    client.insertText(text + suffix, replacementRange: replacementRange(for: client))
    engineClient.resetSession(sessionId)
    clearCompositionOwner()
    candidateState.updateCandidates([], rawBuffer: "", modeLabel: nativeMode.menuLabel)
    candidateSelectionExplicit = false
    hideCandidates()
    return true
  }

  private func shouldPersonalize(client: IMKTextInput) -> Bool {
    guard !secureInputActive() else { return false }
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
