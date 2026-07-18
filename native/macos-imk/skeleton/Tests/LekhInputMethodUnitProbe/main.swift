import AppKit
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
  require(passThrough.inlineSuggestion == nil, "Pass-through must not carry acceptance authority")
}

private func verifyActiveCompositionWorkBound() {
  let maximum = LekhIPCProtocolContract.maximumCompositionLength
  require(maximum == 128, "The generated active-composition work bound must remain 128 UTF-16 code units")
  require(
    !LekhActiveCompositionWorkBound.wouldOverflow(
      current: String(repeating: "a", count: maximum - 1),
      appending: "a"
    ),
    "The exact generated composition bound must remain admissible"
  )
  require(
    LekhActiveCompositionWorkBound.wouldOverflow(
      current: String(repeating: "a", count: maximum),
      appending: "b"
    ),
    "One UTF-16 unit beyond the generated composition bound must fail open"
  )

  let devanagariGrapheme = "कि"
  require(devanagariGrapheme.count == 1 && devanagariGrapheme.utf16.count == 2, "The grapheme-boundary fixture must span two UTF-16 units")
  require(
    !LekhActiveCompositionWorkBound.wouldOverflow(
      current: String(repeating: "a", count: maximum - devanagariGrapheme.utf16.count),
      appending: devanagariGrapheme
    ),
    "A complete multi-unit grapheme ending exactly at the bound must be admitted"
  )
  require(
    LekhActiveCompositionWorkBound.wouldOverflow(
      current: String(repeating: "a", count: maximum - 1),
      appending: devanagariGrapheme
    ),
    "A multi-unit grapheme crossing the bound must be rejected whole"
  )

  let optionSequence = "\u{094D}र"
  let optionEngine = LekhNativeEngineClient()
  let optionSession = "unit-option-sequence-\(UUID().uuidString)"
  let optionDecision = optionEngine.processKey(
    optionSequence,
    sessionId: optionSession,
    mode: .traditionalTraditional
  )
  require(
    optionDecision.handled && !optionDecision.shouldPassThrough &&
      optionEngine.rawBuffer(sessionId: optionSession) == optionSequence,
    "A synthesized multi-character Option mapping must be admitted atomically"
  )
  optionEngine.endSession(optionSession)
}

private func verifyWholeGraphemeCompositionPolicy() {
  require(
    LekhCompositionInputPolicy.isCompositionSafe("कि"),
    "A multi-scalar Devanagari grapheme must remain composition-safe"
  )
  require(
    LekhCompositionInputPolicy.isCompositionSafe("\u{094D}र"),
    "A synthesized virama-plus-ra sequence must remain composition-safe"
  )
  require(
    !LekhCompositionInputPolicy.isCompositionSafe("1️⃣"),
    "A keycap emoji must not be admitted merely because its first scalar is a digit"
  )
  require(
    !LekhCompositionInputPolicy.isCompositionSafe("क\u{200D}"),
    "A Devanagari scalar followed by an unsupported joiner must fail open whole"
  )
  require(
    !LekhCompositionInputPolicy.isCompositionSafe("a🙂"),
    "A mixed callback must not consume its composition-safe prefix"
  )
}

private func verifyClosedEngineContract() {
  let valid: [String: Any] = [
    "schemaVersion": 1,
    "modes": LekhNativeTypingMode.visibleModes.map(\.rawValue),
    "candidatePolicy": [
      "maximumVisible": 8,
      "singleTokenMayExpandToPhrase": false,
      "commitAuthority": [
        "explicitUserSelection": true,
        "untrustedProgrammaticSelection": false,
        "experimentalExactSpaceAuthorization": [
          "policyId": "lekh-experimental-passive-commit-v1",
          "productionEligible": false,
          "activation": "opaque-test-build-capability-only"
        ]
      ]
    ],
    "commitPolicy": [
      "Space": "raw-with-space-unless-explicit-selection-or-test-only-experiment",
      "Enter": "raw-with-newline-unless-explicit-selection",
      "Tab": "pass-through-unless-explicit-selection",
      "Escape": "preserve-raw"
    ],
    "hotPathPolicy": [
      "networkAllowed": false,
      "synchronousXpcAllowed": false,
      "synchronousDatabaseAllowed": false,
      "deterministicP99Milliseconds": 5,
      "maximumCompositionUtf16CodeUnits": 128
    ],
    "neuralPolicy": [
      "requiresOpenVocabulary": true,
      "requiresProductionEligibility": true,
      "requiresAsynchronousInvocation": true
    ]
  ]
  func encoded(_ value: [String: Any]) -> Data {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else {
      fputs("FAIL: Engine-contract fixture could not be encoded\n", stderr)
      exit(1)
    }
    return data
  }
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(valid)) == 8,
    "The exact closed engine contract must validate"
  )

  var booleanSchemaVersion = valid
  booleanSchemaVersion["schemaVersion"] = true
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(booleanSchemaVersion)) == nil,
    "A JSON Boolean must not coerce into the integer schema version"
  )

  var booleanMaximum = valid
  var candidate = booleanMaximum["candidatePolicy"] as! [String: Any]
  candidate["maximumVisible"] = true
  booleanMaximum["candidatePolicy"] = candidate
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(booleanMaximum)) == nil,
    "A JSON Boolean must not coerce into the numeric candidate limit"
  )

  var nonCanonicalMaximum = valid
  candidate = nonCanonicalMaximum["candidatePolicy"] as! [String: Any]
  candidate["maximumVisible"] = 7
  nonCanonicalMaximum["candidatePolicy"] = candidate
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(nonCanonicalMaximum)) == nil,
    "The native contract must require exactly eight visible candidates"
  )

  var numericBoolean = valid
  candidate = numericBoolean["candidatePolicy"] as! [String: Any]
  candidate["singleTokenMayExpandToPhrase"] = 0
  numericBoolean["candidatePolicy"] = candidate
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(numericBoolean)) == nil,
    "A JSON number must not coerce into a Boolean candidate policy"
  )

  var numericExperimentBoolean = valid
  candidate = numericExperimentBoolean["candidatePolicy"] as! [String: Any]
  var authority = candidate["commitAuthority"] as! [String: Any]
  var experiment = authority["experimentalExactSpaceAuthorization"] as! [String: Any]
  experiment["productionEligible"] = 0
  authority["experimentalExactSpaceAuthorization"] = experiment
  candidate["commitAuthority"] = authority
  numericExperimentBoolean["candidatePolicy"] = candidate
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(numericExperimentBoolean)) == nil,
    "A numeric zero must not impersonate a false production-eligibility Boolean"
  )

  var unexpectedTop = valid
  unexpectedTop["unexpected"] = true
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(unexpectedTop)) == nil,
    "An additional engine-contract field must fail closed"
  )

  var unexpectedNested = valid
  candidate = unexpectedNested["candidatePolicy"] as! [String: Any]
  candidate["implicitSelection"] = true
  unexpectedNested["candidatePolicy"] = candidate
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(unexpectedNested)) == nil,
    "An additional authority field must fail closed"
  )

  var promotedExperiment = valid
  candidate = promotedExperiment["candidatePolicy"] as! [String: Any]
  authority = candidate["commitAuthority"] as! [String: Any]
  experiment = authority["experimentalExactSpaceAuthorization"] as! [String: Any]
  experiment["productionEligible"] = true
  authority["experimentalExactSpaceAuthorization"] = experiment
  candidate["commitAuthority"] = authority
  promotedExperiment["candidatePolicy"] = candidate
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(promotedExperiment)) == nil,
    "A promoted experimental passive authority must fail closed"
  )

  var weakenedBound = valid
  var hotPath = weakenedBound["hotPathPolicy"] as! [String: Any]
  hotPath["maximumCompositionUtf16CodeUnits"] = 129
  weakenedBound["hotPathPolicy"] = hotPath
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(weakenedBound)) == nil,
    "A contract that diverges from the generated composition bound must fail closed"
  )

  var missingPolicy = valid
  missingPolicy.removeValue(forKey: "neuralPolicy")
  require(
    LekhEngineContractValidator.maximumVisibleIfValid(data: encoded(missingPolicy)) == nil,
    "A missing engine-contract policy must fail closed"
  )
}

private func verifyCandidateAcceptanceAuthority() {
  let firstClient = NSObject()
  let secondClient = NSObject()
  let receipt = LekhCandidateAcceptanceReceipt(
    candidate: "लेख",
    candidateGeneration: 7,
    surfaceGeneration: 11,
    sessionId: "session-a",
    rawBuffer: "lekh",
    clientIdentifier: ObjectIdentifier(firstClient)
  )
  require(
    receipt.matches(
      candidate: "लेख",
      candidateGeneration: 7,
      surfaceGeneration: 11,
      sessionId: "session-a",
      rawBuffer: "lekh",
      clientIdentifier: ObjectIdentifier(firstClient)
    ),
    "An acceptance receipt must match only its exact visible snapshot"
  )
  require(
    !receipt.matches(
      candidate: "लेख",
      candidateGeneration: 8,
      surfaceGeneration: 11,
      sessionId: "session-a",
      rawBuffer: "lekh",
      clientIdentifier: ObjectIdentifier(firstClient)
    ),
    "An asynchronous candidate refresh must invalidate the prior receipt"
  )
  require(
    !receipt.matches(
      candidate: "लेख",
      candidateGeneration: 7,
      surfaceGeneration: 12,
      sessionId: "session-a",
      rawBuffer: "lekh",
      clientIdentifier: ObjectIdentifier(firstClient)
    ),
    "A repainted or dismissed surface must invalidate the prior receipt"
  )
  require(
    !receipt.matches(
      candidate: "लेख",
      candidateGeneration: 7,
      surfaceGeneration: 11,
      sessionId: "session-b",
      rawBuffer: "lekh",
      clientIdentifier: ObjectIdentifier(firstClient)
    ),
    "A session transition must invalidate the prior receipt"
  )
  require(
    !receipt.matches(
      candidate: "लेख",
      candidateGeneration: 7,
      surfaceGeneration: 11,
      sessionId: "session-a",
      rawBuffer: "lekha",
      clientIdentifier: ObjectIdentifier(firstClient)
    ),
    "A changed raw composition must invalidate the prior receipt"
  )
  require(
    !receipt.matches(
      candidate: "लेख",
      candidateGeneration: 7,
      surfaceGeneration: 11,
      sessionId: "session-a",
      rawBuffer: "lekh",
      clientIdentifier: ObjectIdentifier(secondClient)
    ),
    "A focus transition must invalidate the prior client's receipt"
  )
  require(
    LekhPhysicalCandidateEventPolicy.acceptsMouseSelection(eventType: .leftMouseUp, age: 0) &&
      LekhPhysicalCandidateEventPolicy.acceptsMouseSelection(
        eventType: .leftMouseUp,
        age: LekhPhysicalCandidateEventPolicy.maximumMouseUpAge
      ),
    "A current physical mouse-up must be admitted at both freshness boundaries"
  )
  require(
    !LekhPhysicalCandidateEventPolicy.acceptsMouseSelection(eventType: .keyDown, age: 0) &&
      !LekhPhysicalCandidateEventPolicy.acceptsMouseSelection(eventType: .leftMouseUp, age: -0.001) &&
      !LekhPhysicalCandidateEventPolicy.acceptsMouseSelection(
        eventType: .leftMouseUp,
        age: LekhPhysicalCandidateEventPolicy.maximumMouseUpAge + 0.001
      ),
    "Programmatic, future-dated, and stale candidate callbacks must fail closed"
  )
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

private func verifyNeuralInputAdmissionPolicy() {
  let policy = LekhNeuralInputAdmissionPolicy(
    maxLength: 6,
    representableTokens: Set("abcdefghijklmnopqrstuvwxyz".map(String.init)),
    deterministicTokenInputs: ["bato", "chha"]
  )

  require(policy.accepts("cafe"), "A representable neural-tail token with an EOS slot must be admitted")
  require(!policy.accepts("bato"), "An exact shared deterministic token must bypass the neural tail")
  require(!policy.accepts("chha"), "Every exact shared deterministic token must bypass the neural tail")
  require(
    !policy.accepts("abcdef"),
    "An input that fills the tensor must be rejected so the final slot remains available for EOS"
  )
  require(
    !policy.accepts("a🙂🙂"),
    "An unknown-token-heavy input must be rejected instead of producing a lossy encoding"
  )
  require(
    !policy.accepts("caf1"),
    "Even one unknown input character must fail closed before Core ML inference"
  )
  require(!policy.accepts(""), "An empty token must not enter neural inference")
}

private struct NeuralDecoderFixture: Decodable {
  let schemaVersion: Int
  let score: String
  let lengthNormalization: String
  let maxSteps: String
  let cases: [DecoderCase]

  struct DecoderCase: Decodable {
    let id: String
    let vocabularySize: Int
    let sosTokenId: Int
    let eosTokenId: Int
    let invalidTokenIds: [Int]
    let beamWidth: Int
    let inputGraphemeCount: Int
    let maxOutputLength: Int
    let logitsByPrefix: [String: [Double]]
    let expectedTokenIds: [[Int]]
  }
}

private func verifyNeuralDecoderContract() {
  let fixtureURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("contracts/neural-decoder/v1/lekh-neural-decoder.v1.json")
  guard let data = try? Data(contentsOf: fixtureURL),
        let fixture = try? JSONDecoder().decode(NeuralDecoderFixture.self, from: data) else {
    require(false, "Shared neural decoder fixture must be readable from \(fixtureURL.path)")
    return
  }
  require(fixture.schemaVersion == 1, "Shared neural decoder fixture schema must remain v1")
  require(fixture.score == "accumulated-log-softmax", "Decoder fixture must freeze log-softmax scoring")
  require(
    fixture.lengthNormalization == "score-divided-by-token-count-including-sos",
    "Decoder fixture must freeze length normalization"
  )
  require(
    fixture.maxSteps == "min(maxOutputLength-minus-1,inputGraphemeCount-plus-8)",
    "Decoder fixture must freeze the native latency bound"
  )

  for item in fixture.cases {
    let maxSteps = max(0, min(item.maxOutputLength - 1, item.inputGraphemeCount + 8))
    do {
      let hypotheses = try LekhNeuralBeamSearch.rank(
        vocabularySize: item.vocabularySize,
        sosTokenId: item.sosTokenId,
        eosTokenId: item.eosTokenId,
        invalidTokenIds: Set(item.invalidTokenIds),
        beamWidth: item.beamWidth,
        maxSteps: maxSteps
      ) { prefix, _ in
        let key = prefix.map(String.init).joined(separator: ",")
        guard let logits = item.logitsByPrefix[key] else {
          throw LekhNeuralBeamSearchFailure.invalidConfiguration
        }
        return logits
      }
      require(
        hypotheses.map(\.tokenIds) == item.expectedTokenIds,
        "Swift decoder diverged from shared fixture \(item.id): \(hypotheses.map(\.tokenIds))"
      )
    } catch {
      require(false, "Swift decoder fixture \(item.id) failed: \(error)")
    }
  }

  do {
    _ = try LekhNeuralBeamSearch.rank(
      vocabularySize: 5,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      beamWidth: 1,
      maxSteps: 1
    ) { _, _ in [0, 0, 0, 0, .nan] }
    require(false, "Non-finite neural logits must fail closed")
  } catch LekhNeuralBeamSearchFailure.nonFiniteLogit {
    // Expected fail-closed behavior.
  } catch {
    require(false, "Non-finite neural logits raised the wrong error: \(error)")
  }
}

private func verifyNeuralManifestIdentityPolicy() {
  let trainingRunId = "0123456789abcdef0123456789abcdef"
  let exportRunId = "fedcba9876543210fedcba9876543210"

  require(
    LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 1,
      trainingRunId: nil,
      exportRunId: nil,
      productionEligible: false
    ),
    "The existing schema-v1 candidate may remain available only for development"
  )
  require(
    !LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 1,
      trainingRunId: nil,
      exportRunId: nil,
      productionEligible: true
    ),
    "A schema-v1 manifest must never claim production eligibility"
  )
  require(
    LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 2,
      trainingRunId: trainingRunId,
      exportRunId: exportRunId,
      productionEligible: true
    ),
    "Schema v2 must accept two valid run identities"
  )
  require(
    !LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 2,
      trainingRunId: trainingRunId.uppercased(),
      exportRunId: exportRunId,
      productionEligible: false
    ),
    "Schema-v2 run identities must use lowercase hexadecimal"
  )
  require(
    !LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 2,
      trainingRunId: trainingRunId,
      exportRunId: nil,
      productionEligible: false
    ),
    "Schema v2 must fail closed when either run identity is absent"
  )
  require(
    !LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 2,
      trainingRunId: trainingRunId,
      exportRunId: trainingRunId,
      productionEligible: false
    ),
    "Schema v2 must not reuse one identity for training and export"
  )
  require(
    !LekhNeuralManifestIdentityPolicy.permits(
      schemaVersion: 3,
      trainingRunId: trainingRunId,
      exportRunId: exportRunId,
      productionEligible: false
    ),
    "Unknown future manifest schemas must fail closed"
  )
}

verifyCandidateStateMachine()
verifyFourModeContract()
verifyActiveCompositionWorkBound()
verifyWholeGraphemeCompositionPolicy()
verifyClosedEngineContract()
verifyCandidateAcceptanceAuthority()
verifyRuntimeActivationGate()
verifyCandidatePointerGate()
verifyNeuralInputAdmissionPolicy()
verifyNeuralDecoderContract()
verifyNeuralManifestIdentityPolicy()
print("PASS: native candidate, delimiter, four-mode, neural admission, decoder, and manifest identity contracts")
