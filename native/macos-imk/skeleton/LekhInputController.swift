import Foundation
import InputMethodKit

func lekhNativeLog(_ message: String) {
  guard ProcessInfo.processInfo.environment["LEKH_IMK_DEBUG_LOG"] == "1" else { return }
  let line = "\(Date()) \(message)\n"
  if let data = line.data(using: .utf8) {
    let url = URL(fileURLWithPath: "/tmp/lekh-imk-host.log")
    if FileManager.default.fileExists(atPath: url.path),
       let handle = try? FileHandle(forWritingTo: url) {
      defer { try? handle.close() }
      try? handle.seekToEnd()
      try? handle.write(contentsOf: data)
    } else {
      try? data.write(to: url, options: .atomic)
    }
  }
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

@objc(LekhInputController)
open class LekhInputController: IMKInputController {
  private let engineClient: LekhEngineClient
  private let candidates = LekhCandidateController()
  private var sessionId = UUID().uuidString
  private var nativeMode = LekhNativeTypingMode.romanizedTraditional
  private var modeMenuOpen = false

  public init(engineClient: LekhEngineClient = LekhXpcEngineClient()) {
    self.engineClient = engineClient
    super.init()
  }

  public required override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
    self.engineClient = Self.defaultEngineClient()
    super.init(server: server, delegate: delegate, client: inputClient)
  }

  private static func defaultEngineClient() -> LekhEngineClient {
    let forceXpc = ProcessInfo.processInfo.environment["LEKH_IMK_USE_XPC"]?.lowercased()
    if forceXpc == "1" || forceXpc == "true" || forceXpc == "yes" {
      return LekhXpcEngineClient()
    }
    return LekhStaticProofEngineClient()
  }

  open override func inputText(_ string: String!, client sender: Any!) -> Bool {
    guard let string, !string.isEmpty else { return false }
    lekhNativeLog("inputText string=\(string)")
    let decision = engineClient.processKey(
      string,
      sessionId: sessionId,
      timeoutMilliseconds: lekhHotPathTimeoutMilliseconds,
      mode: nativeMode
    )
    return apply(decision, client: sender)
  }

  open override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
    guard let event, event.type == .keyDown else { return false }

    let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    // Control+Option+Space opens the four-mode Lekh selector without stealing Command shortcuts.
    if modifiers.contains(.control), modifiers.contains(.option), event.keyCode == 49 {
      modeMenuOpen = true
      return apply(modeMenuDecision(), client: sender)
    }

    if modeMenuOpen {
      if let selectedMode = modeFromMenuKey(event) {
        nativeMode = selectedMode
        modeMenuOpen = false
        return apply(modeSelectedDecision(selectedMode), client: sender)
      }
      if event.keyCode == 53 {
        modeMenuOpen = false
        return apply(cancelDecision(), client: sender)
      }
      return true
    }

    if modifiers.contains(.command) || modifiers.contains(.control) {
      return false
    }

    let key = keyString(from: event)
    guard !key.isEmpty else { return false }
    lekhNativeLog("handle key=\(key) keyCode=\(event.keyCode) chars=\(event.characters ?? "") ignoring=\(event.charactersIgnoringModifiers ?? "")")

    let decision = engineClient.processKey(
      key,
      sessionId: sessionId,
      timeoutMilliseconds: lekhHotPathTimeoutMilliseconds,
      mode: nativeMode
    )
    return apply(decision, client: sender)
  }

  open override func didCommand(by selector: Selector!, client sender: Any!) -> Bool {
    if selector == #selector(NSResponder.cancelOperation(_:)) {
      let decision = LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: nil,
        candidates: [],
        shouldCancel: true,
        shouldPassThrough: false
      )
      return apply(decision, client: sender)
    }
    return false
  }

  private func keyString(from event: NSEvent) -> String {
    switch event.keyCode {
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
    default:
      return event.charactersIgnoringModifiers ?? event.characters ?? ""
    }
  }

  public func resetSession() {
    sessionId = UUID().uuidString
    candidates.updateCandidates([])
  }

  private func modeFromMenuKey(_ event: NSEvent) -> LekhNativeTypingMode? {
    guard let characters = event.charactersIgnoringModifiers ?? event.characters,
          let digit = Int(characters),
          (1...LekhNativeTypingMode.allCases.count).contains(digit) else {
      return nil
    }
    return LekhNativeTypingMode.allCases[digit - 1]
  }

  private func modeMenuDecision() -> LekhInputDecision {
    let menu = LekhNativeTypingMode.allCases.enumerated()
      .map { index, mode in "\(index + 1) \(mode.menuLabel)" }
      .joined(separator: "   ")
    return LekhInputDecision(
      handled: true,
      markedText: "Lekh mode: \(menu)",
      committedText: nil,
      candidates: LekhNativeTypingMode.allCases.map(\.menuLabel),
      shouldCancel: false,
      shouldPassThrough: false
    )
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

  private func apply(_ decision: LekhInputDecision, client sender: Any!) -> Bool {
    lekhNativeLog("apply handled=\(decision.handled) passThrough=\(decision.shouldPassThrough) marked=\(decision.markedText ?? "nil") committed=\(decision.committedText ?? "nil") client=\(String(describing: sender))")
    if decision.shouldPassThrough || !decision.handled { return false }
    guard let client = sender as? IMKTextInput else { return false }

    if decision.shouldCancel {
      client.setMarkedText("", selectionRange: NSRange(location: 0, length: 0), replacementRange: notFoundRange())
      candidates.updateCandidates([])
      return true
    }

    if let committedText = decision.committedText {
      client.insertText(committedText, replacementRange: notFoundRange())
      candidates.updateCandidates([])
      return true
    }

    if let markedText = decision.markedText {
      client.setMarkedText(
        markedText,
        selectionRange: NSRange(location: markedText.utf16.count, length: 0),
        replacementRange: notFoundRange()
      )
      candidates.updateCandidates(decision.candidates)
      return true
    }

    return false
  }

  private func notFoundRange() -> NSRange {
    NSRange(location: NSNotFound, length: NSNotFound)
  }
}
