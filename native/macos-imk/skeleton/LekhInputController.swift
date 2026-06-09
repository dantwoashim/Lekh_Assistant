import Foundation
import InputMethodKit

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

open class LekhInputController: IMKInputController {
  private let engineClient: LekhEngineClient
  private let candidates = LekhCandidateController()
  private var sessionId = UUID().uuidString

  public init(engineClient: LekhEngineClient = LekhXpcEngineClient()) {
    self.engineClient = engineClient
    super.init()
  }

  public required override init!(server: IMKServer!, delegate: Any!, client inputClient: Any!) {
    self.engineClient = LekhXpcEngineClient()
    super.init(server: server, delegate: delegate, client: inputClient)
  }

  open override func inputText(_ string: String!, client sender: Any!) -> Bool {
    guard let string, !string.isEmpty else { return false }
    let decision = engineClient.processKey(
      string,
      sessionId: sessionId,
      timeoutMilliseconds: lekhHotPathTimeoutMilliseconds
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

  public func resetSession() {
    sessionId = UUID().uuidString
    candidates.updateCandidates([])
  }

  private func apply(_ decision: LekhInputDecision, client sender: Any!) -> Bool {
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
