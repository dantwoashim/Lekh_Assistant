import Foundation
import LekhInputMethod

@discardableResult
private func require(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
  guard condition() else {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
  }
  return true
}

private func verifyCandidateStateMachine() {
  let passive = LekhCandidateController()
  passive.updateCandidates(["पहिलो", "दोस्रो"], rawBuffer: "pahilo")
  require(passive.currentState().selectedIndex == nil, "Fresh candidates must remain passive")
  require(passive.selectedCandidate() == nil, "Passive candidates must not expose an accepted row")

  passive.updateCandidates(["पहिलो", "दोस्रो"], selectedIndex: 99)
  require(passive.currentState().selectedIndex == nil, "An invalid programmatic index must not invent selection")

  let navigation = LekhCandidateController()
  navigation.updateCandidates(["एक", "दुई", "तीन"])
  require(navigation.moveSelection(delta: 1) == "एक", "Down must enter browsing at the first row")
  require(navigation.moveSelection(delta: -1) == "तीन", "Up must wrap to the final row")
  require(navigation.moveSelection(delta: 1) == "एक", "Down must wrap back to the first row")

  let retention = LekhCandidateController()
  retention.updateCandidates(["एक", "दुई", "तीन"])
  require(retention.select(index: 1) == "दुई", "Explicit selection must select the requested row")
  retention.updateCandidates(["शून्य", "दुई"])
  require(retention.currentState().selectedIndex == 1, "A surviving candidate may retain its selection")
  require(retention.selectedCandidate() == "दुई", "Selection must be retained by text, not stale index")
  retention.updateCandidates(["चार", "पाँच"])
  require(retention.currentState().selectedIndex == nil, "A replaced list must return to passive state")

  let shortcuts = LekhCandidateController()
  shortcuts.updateCandidates((1...10).map(String.init))
  require(shortcuts.candidateForShortcut(1) == "1", "Shortcut 1 must select row 1")
  require(shortcuts.candidateForShortcut(8) == "8", "Shortcut 8 must select row 8")
  require(shortcuts.candidateForShortcut(9) == nil, "Shortcut 9 must be rejected")
  require(shortcuts.select(index: 8) == "9", "Page-two seed selection must succeed")
  require(shortcuts.candidateForShortcut(1) == "9", "Page shortcut 1 must select page row 1")
  require(shortcuts.candidateForShortcut(2) == "10", "Page shortcut 2 must select page row 2")
  require(shortcuts.candidateForShortcut(3) == nil, "A shortcut beyond the final page must be rejected")
  shortcuts.clearSelection()
  require(shortcuts.selectedCandidate() == nil, "Clearing selection must restore passive state")

  let noOp = LekhCandidateController()
  noOp.updateCandidates(["एक", "दुई", "तीन"])
  require(noOp.moveSelection(delta: 0) == nil, "A zero row delta must not invent a selection")
  require(noOp.movePage(delta: 0, pageSize: 8) == nil, "A zero page delta must remain passive")
  require(noOp.currentState().selectedIndex == nil, "No-op navigation must preserve passive state")

  let hardened = LekhCandidateController()
  hardened.updateCandidates((1...18).map(String.init))
  require(hardened.movePage(delta: Int.max, pageSize: 8) == "17", "A huge Page Down delta must clamp to the final page")
  require(hardened.movePage(delta: Int.min, pageSize: 8) == "1", "A huge Page Up delta must clamp without integer overflow")
  require(hardened.moveSelection(delta: Int.max) != nil, "A huge row delta must wrap without integer overflow")
  require(hardened.moveSelection(delta: Int.min) != nil, "A minimum row delta must wrap without integer overflow")
}

private func verifyAutoCommitPolicy() {
  let allowed = LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
    text: "स्वास्थ्य",
    sourceInput: "swasthya",
    calibratedProbability: 0.92,
    runnerUpProbability: 0.80,
    isExactDeterministicToken: true
  )
  require(allowed?.policy == .calibratedExactDeterministicToken, "Exact calibrated thresholds must authorize the forward token")

  require(
    LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
      text: "स्वास्थ्य",
      sourceInput: "swasthya",
      calibratedProbability: 0.919,
      runnerUpProbability: 0.70,
      isExactDeterministicToken: true
    ) == nil,
    "Forward probability below 0.92 must fail closed"
  )
  require(
    LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
      text: "स्वास्थ्य",
      sourceInput: "swasthya",
      calibratedProbability: 0.95,
      runnerUpProbability: 0.84,
      isExactDeterministicToken: true
    ) == nil,
    "Forward margin below 0.12 must fail closed"
  )

  let blockedFlags: [(Bool, Bool, Bool, Bool, Bool)] = [
    (true, false, false, false, false),
    (false, true, false, false, false),
    (false, false, true, false, false),
    (false, false, false, true, false),
    (false, false, false, false, true)
  ]
  for (isName, isPhrase, isProtected, isPersonal, isNeural) in blockedFlags {
    require(
      LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
        text: "स्वास्थ्य",
        sourceInput: "swasthya",
        calibratedProbability: 0.99,
        runnerUpProbability: 0.10,
        isExactDeterministicToken: true,
        isName: isName,
        isPhrase: isPhrase,
        isProtected: isProtected,
        isPersonal: isPersonal,
        isNeural: isNeural
      ) == nil,
      "Names, phrases, protected, personal, and neural rows must never passively commit"
    )
  }
  require(
    LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
      text: "नेपाल राम्रो",
      sourceInput: "nepal",
      calibratedProbability: 0.99,
      runnerUpProbability: 0.01,
      isExactDeterministicToken: true
    ) == nil,
    "A single active token must never expand into a phrase"
  )

  let reverse = LekhNativeAutoCommitPolicy.uniqueReversibleReverseCandidate(
    text: "swasthya",
    sourceInput: "स्वास्थ्य",
    isUnique: true,
    isReversible: true
  )
  require(reverse?.policy == .uniqueReversibleReverse, "A unique reversible Roman output may commit")
  require(
    LekhNativeAutoCommitPolicy.uniqueReversibleReverseCandidate(
      text: "swasthya",
      sourceInput: "स्वास्थ्य",
      isUnique: false,
      isReversible: true
    ) == nil,
    "An ambiguous reverse candidate must fail closed"
  )
  require(
    LekhNativeAutoCommitPolicy.uniqueReversibleReverseCandidate(
      text: "स्वास्थ्य",
      sourceInput: "स्वास्थ्य",
      isUnique: true,
      isReversible: true
    ) == nil,
    "Reverse auto-commit output must be Roman"
  )
}

private func verifyFourModeContract() {
  let visible = LekhNativeTypingMode.visibleModes.map(\.rawValue)
  require(visible.count == 4, "Exactly four native modes must be visible")
  require(Set(visible).count == 4, "All four native modes must remain distinct")
  require(Set(visible) == Set(LekhNativeTypingMode.allCases.map(\.rawValue)), "Visible modes must cover every engine mode")

  let passThrough = LekhInputDecision.passThrough
  require(!passThrough.handled, "Pass-through must not claim handling")
  require(passThrough.shouldPassThrough, "Pass-through must preserve the host event")
  require(passThrough.markedText == nil && passThrough.committedText == nil, "Pass-through must not mutate text")
  require(passThrough.candidates.isEmpty, "Pass-through must not publish candidates")
  require(passThrough.inlineSuggestion == nil && passThrough.autoCommitCandidate == nil, "Pass-through must not carry acceptance authority")
}

private func verifyRuntimeActivationGate() {
  var gate = LekhRuntimeActivationGate()
  let first = UUID().uuidString
  let second = UUID().uuidString

  require(!gate.activate("not-a-uuid"), "Runtime evidence must reject an invalid activation identity")
  require(gate.activate(first), "A valid controller activation must open its evidence generation")
  require(
    gate.accepts(first, recordActivationIdentifier: first),
    "The live activation must accept evidence bound to its own persisted generation"
  )
  require(
    !gate.accepts(first, recordActivationIdentifier: second),
    "Evidence must fail closed when the persisted generation does not match"
  )
  require(gate.activate(second), "A later controller activation must replace the live generation")
  require(
    !gate.accepts(first, recordActivationIdentifier: first),
    "A delayed callback from an older controller activation must be rejected"
  )
  gate.deactivate(first)
  require(
    gate.accepts(second, recordActivationIdentifier: second),
    "Deactivating an older controller must not invalidate the newer controller"
  )
  gate.deactivate(second)
  require(
    !gate.accepts(second, recordActivationIdentifier: second),
    "A deactivated generation must reject later surface evidence"
  )
}

private func verifyCandidatePointerGate() {
  var gate = LekhCandidatePointerGate()
  require(!gate.beginPress(inside: false), "A mouse-down outside a candidate row must not open acceptance custody")
  require(
    gate.endPress(inside: false) == .ignored,
    "An outside mouse-down followed by outside mouse-up must not report cancellation"
  )
  require(
    gate.endPress(inside: true) == .ignored,
    "A mouse-up inside without a custodied inside mouse-down must not select"
  )

  require(gate.beginPress(inside: true), "An inside mouse-down must open row-local pointer custody")
  require(
    gate.endPress(inside: false) == .cancelled,
    "Only an inside mouse-down followed by outside mouse-up may report cancellation"
  )
  require(
    gate.endPress(inside: false) == .ignored,
    "A cancellation receipt must be one-shot for its custodied mouse-down"
  )

  require(gate.beginPress(inside: true), "A later inside mouse-down must open a new custody generation")
  require(
    gate.endPress(inside: true) == .selected,
    "Inside mouse-down followed by inside mouse-up must select, not cancel"
  )
}

verifyCandidateStateMachine()
verifyAutoCommitPolicy()
verifyFourModeContract()
verifyRuntimeActivationGate()
verifyCandidatePointerGate()
print("PASS: native candidate, delimiter, and four-mode unit contracts")
