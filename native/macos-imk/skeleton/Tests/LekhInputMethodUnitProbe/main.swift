import AppKit
import CoreML
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
  require(!policy.accepts("ab"), "Tokens shorter than the evaluated neural-tail minimum must fail closed")
  require(!policy.accepts("git"), "Protected Latin tokens must fail closed inside the admission policy")
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
  let tokenization: String
  let outputSequenceValidation: String
  let maxSteps: String
  let sequenceCases: [SequenceCase]
  let ctcCases: [CTCDecoderCase]
  let cases: [DecoderCase]

  struct SequenceCase: Decodable {
    let value: String
    let validPrefix: Bool
    let terminable: Bool
    let issueCodes: [String]
  }

  struct DecoderCase: Decodable {
    let id: String
    let vocabularySize: Int
    let sosTokenId: Int
    let eosTokenId: Int
    let invalidTokenIds: [Int]
    let tokensById: [String]
    let beamWidth: Int
    let maxOutputLength: Int
    let logitsByPrefix: [String: [Double]]
    let expectedTokenIds: [[Int]]
  }

  struct CTCDecoderCase: Decodable {
    let id: String
    let blankTokenId: Int
    let beamWidth: Int
    let maximumCandidates: Int
    let logits: [[Double]]
    let expectedTokenIds: [[Int]]
  }
}

private func verifyNeuralDecoderContract() {
  let fixtureURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("contracts/neural-decoder/v2/lekh-neural-decoder.v2.json")
  guard let data = try? Data(contentsOf: fixtureURL),
        let fixture = try? JSONDecoder().decode(NeuralDecoderFixture.self, from: data) else {
    require(false, "Shared neural decoder fixture must be readable from \(fixtureURL.path)")
    return
  }
  require(fixture.schemaVersion == 2, "Shared neural decoder fixture schema must remain v2")
  require(fixture.score == "accumulated-log-softmax", "Decoder fixture must freeze log-softmax scoring")
  require(
    fixture.lengthNormalization == "score-divided-by-token-count-including-sos",
    "Decoder fixture must freeze length normalization"
  )
  require(
    fixture.tokenization == "unicode-scalar-character" &&
      fixture.outputSequenceValidation == "devanagari-word-sequence-v1",
    "Decoder fixture must freeze scalar tokenization and sequence validation"
  )
  require(
    fixture.maxSteps == "maxOutputLength-minus-1",
    "Decoder fixture must expose every output tensor step"
  )
  for item in fixture.sequenceCases {
    let analysis = LekhDevanagariOutputSequence.analyze(item.value)
    require(
      analysis.validPrefix == item.validPrefix &&
        analysis.terminable == item.terminable &&
        analysis.issueCodes == item.issueCodes,
      "Swift sequence grammar diverged from shared fixture \(item.value): \(analysis)"
    )
  }

  for item in fixture.cases {
    let maxSteps = max(0, item.maxOutputLength - 1)
    do {
      let hypotheses = try LekhNeuralBeamSearch.rank(
        vocabularySize: item.vocabularySize,
        sosTokenId: item.sosTokenId,
        eosTokenId: item.eosTokenId,
        invalidTokenIds: Set(item.invalidTokenIds),
        beamWidth: item.beamWidth,
        maxSteps: maxSteps,
        permitsToken: { prefix, tokenId in
          let prefixText = prefix.compactMap { id -> String? in
            guard item.tokensById.indices.contains(id) else { return nil }
            let token = item.tokensById[id]
            return ["<pad>", "<s>", "</s>", "<unk>"].contains(token) ? nil : token
          }.joined()
          if tokenId == item.eosTokenId {
            return LekhDevanagariOutputSequence.analyze(prefixText).terminable
          }
          guard item.tokensById.indices.contains(tokenId) else { return false }
          let token = item.tokensById[tokenId]
          return LekhDevanagariOutputSequence.isSupportedScalarToken(token) &&
            LekhDevanagariOutputSequence.analyze(prefixText + token).validPrefix
        }
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

  for item in fixture.ctcCases {
    do {
      let tokenIds = try LekhNeuralCTCPrefixBeamSearch.rank(
        logits: item.logits,
        blankTokenId: item.blankTokenId,
        beamWidth: item.beamWidth,
        maximumCandidates: item.maximumCandidates
      )
      require(
        tokenIds == item.expectedTokenIds,
        "Swift CTC decoder diverged from shared fixture \(item.id): \(tokenIds)"
      )
    } catch {
      require(false, "Swift CTC decoder fixture \(item.id) failed: \(error)")
    }
  }

  for value in [
    "नेपाल", "क्षेत्र", "क़लम", "किं", "गाउँ", "दुःख",
    "पश्चात्", "क्‍ष", "पुनर्अभिमुखीकरण"
  ] {
    let analysis = LekhDevanagariOutputSequence.analyze(value)
    require(
      analysis.validPrefix && analysis.terminable,
      "Valid scalar output sequence was rejected: \(value), \(analysis.issueCodes)"
    )
  }
  for (value, issue) in [
    ("ेनेपाल", "dependent-vowel-sign-without-consonant"),
    ("ंचुनाव", "mark-without-base"),
    ("किी", "multiple-dependent-vowel-signs"),
    ("कुँँ", "duplicate-mark"),
    ("छन्ः", "mark-after-virama"),
    ("कि्", "virama-after-dependent-vowel-sign"),
    ("क्‍ा", "joiner-not-before-consonant"),
    ("राम।", "punctuation")
  ] {
    let analysis = LekhDevanagariOutputSequence.analyze(value)
    require(
      !analysis.validPrefix && analysis.issueCodes.contains(issue),
      "Malformed scalar output sequence escaped validation: \(value), \(analysis.issueCodes)"
    )
  }
  let pendingJoiner = LekhDevanagariOutputSequence.analyze("क्‍")
  require(
    pendingJoiner.validPrefix && !pendingJoiner.terminable,
    "A trailing joiner must remain a legal but non-terminable prefix"
  )

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

private func verifyCTCPrefixBeamSearch() {
  do {
    let separatedRepeat = try LekhNeuralCTCPrefixBeamSearch.rank(
      logits: [
        [0, 6, 1],
        [6, 0, 0],
        [0, 6, 1]
      ],
      blankTokenId: 0,
      beamWidth: 4,
      maximumCandidates: 3
    )
    require(
      separatedRepeat.first == [1, 1],
      "A blank-separated repeated CTC label must decode twice"
    )

    let collapsedRepeat = try LekhNeuralCTCPrefixBeamSearch.rank(
      logits: [
        [0, 6, 1],
        [0, 6, 1],
        [6, 0, 0]
      ],
      blankTokenId: 0,
      beamWidth: 4,
      maximumCandidates: 3
    )
    require(
      collapsedRepeat.first == [1],
      "Adjacent repeated CTC labels without a blank must collapse"
    )

    let tied = try LekhNeuralCTCPrefixBeamSearch.rank(
      logits: [[0, 4, 4]],
      blankTokenId: 0,
      beamWidth: 3,
      maximumCandidates: 2
    )
    require(
      tied == [[1], [2]],
      "Equal-probability CTC prefixes must use lexical token-id ordering"
    )

    let finiteOnly = try LekhNeuralCTCPrefixBeamSearch.rank(
      logits: [
        [0, 6],
        [0, 6]
      ],
      blankTokenId: 0,
      beamWidth: 2,
      maximumCandidates: 2
    )
    require(
      finiteOnly == [[1]],
      "A zero-probability CTC prefix must never become a candidate"
    )
  } catch {
    require(false, "CTC prefix-beam fixtures failed: \(error)")
  }

  do {
    _ = try LekhNeuralCTCPrefixBeamSearch.rank(
      logits: [[0, .nan]],
      blankTokenId: 0,
      beamWidth: 2,
      maximumCandidates: 1
    )
    require(false, "Non-finite CTC logits must fail closed")
  } catch LekhNeuralCTCPrefixBeamSearchFailure.nonFiniteLogit {
    // Expected.
  } catch {
    require(false, "Non-finite CTC logits raised the wrong failure: \(error)")
  }

  do {
    _ = try LekhNeuralCTCPrefixBeamSearch.rank(
      logits: [[0, 1]],
      blankTokenId: 0,
      beamWidth: 2,
      maximumCandidates: 1,
      shouldCancel: { true }
    )
    require(false, "A cancelled CTC decode must not emit candidates")
  } catch LekhNeuralCTCPrefixBeamSearchFailure.cancelled {
    // Expected.
  } catch {
    require(false, "Cancelled CTC decode raised the wrong failure: \(error)")
  }

  verifyCTCExactOracle()
}

private func verifyCTCExactOracle() {
  var matrixCount = 0
  for seed in 0..<96 {
    let vocabularySize = 2 + seed % 3
    let timeSteps = 1 + (seed / 3) % 4
    let logits = deterministicCTCLogits(
      seed: seed,
      timeSteps: timeSteps,
      vocabularySize: vocabularySize
    )
    let expected = exactCTCRanking(
      logits: logits,
      blankTokenId: 0
    )
    require(
      expected.count <= 64,
      "Exact CTC oracle exceeded the unpruned native beam capacity"
    )
    do {
      let observed = try LekhNeuralCTCPrefixBeamSearch.rank(
        logits: logits,
        blankTokenId: 0,
        beamWidth: 64,
        maximumCandidates: 64
      )
      require(
        observed == expected,
        "Swift CTC decoder diverged from exhaustive oracle seed \(seed): " +
          "expected \(expected), observed \(observed)"
      )
    } catch {
      require(
        false,
        "Swift CTC exhaustive-oracle seed \(seed) failed: \(error)"
      )
    }
    matrixCount += 1
  }
  require(
    matrixCount == 96,
    "Swift CTC exhaustive oracle must cover exactly 96 matrices"
  )
}

private func deterministicCTCLogits(
  seed: Int,
  timeSteps: Int,
  vocabularySize: Int
) -> [[Double]] {
  var state = UInt64(seed + 1)
  return (0..<timeSteps).map { timeStep in
    (0..<vocabularySize).map { tokenId in
      state = state &* 6_364_136_223_846_793_005
        &+ 1_442_695_040_888_963_407
      let centered = Int((state >> 32) % 2_001) - 1_000
      return Double(centered) / 211.0
        + Double(timeStep * vocabularySize + tokenId) / 1_000_000
    }
  }
}

private func exactCTCRanking(
  logits: [[Double]],
  blankTokenId: Int
) -> [[Int]] {
  guard let vocabularySize = logits.first?.count,
        vocabularySize > 1,
        logits.allSatisfy({ $0.count == vocabularySize }) else {
    require(false, "Exact CTC oracle received malformed logits")
    return []
  }
  var pathScores: [[Int]: [Double]] = [:]

  func enumeratePaths(
    timeStep: Int,
    path: [Int],
    accumulatedLogit: Double
  ) {
    if timeStep == logits.count {
      let sequence = collapseCTCPath(
        path,
        blankTokenId: blankTokenId
      )
      if !sequence.isEmpty {
        pathScores[sequence, default: []].append(accumulatedLogit)
      }
      return
    }
    for tokenId in 0..<vocabularySize {
      enumeratePaths(
        timeStep: timeStep + 1,
        path: path + [tokenId],
        accumulatedLogit: accumulatedLogit
          + logits[timeStep][tokenId]
      )
    }
  }

  enumeratePaths(timeStep: 0, path: [], accumulatedLogit: 0)
  // Every complete path contains one value from every time step, so the
  // log-softmax normalizer is a sequence-independent constant. Raw-logit path
  // sums therefore preserve the exact CTC sequence ranking.
  return pathScores
    .map { sequence, scores in
      (
        sequence: sequence,
        score: oracleLogSumExp(scores)
      )
    }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.sequence.lexicographicallyPrecedes(right.sequence)
    }
    .map(\.sequence)
}

private func collapseCTCPath(
  _ path: [Int],
  blankTokenId: Int
) -> [Int] {
  var output: [Int] = []
  var previous: Int?
  for tokenId in path {
    if tokenId != previous, tokenId != blankTokenId {
      output.append(tokenId)
    }
    previous = tokenId
  }
  return output
}

private func oracleLogSumExp(_ values: [Double]) -> Double {
  guard let maximum = values.max() else { return -.infinity }
  let exponentialSum = values.reduce(0) {
    $0 + Foundation.exp($1 - maximum)
  }
  return maximum + Foundation.log(exponentialSum)
}

private final class FakeNeuralModel: LekhNeuralModelPredicting {
  typealias Handler = (MLFeatureProvider) throws -> MLFeatureProvider

  private let handler: Handler
  private(set) var callCount = 0

  init(_ handler: @escaping Handler) {
    self.handler = handler
  }

  func prediction(from input: MLFeatureProvider) throws -> MLFeatureProvider {
    callCount += 1
    return try handler(input)
  }
}

private func neuralArray(
  shape: [Int],
  dataType: MLMultiArrayDataType,
  values: [Double] = []
) -> MLMultiArray {
  guard let array = try? MLMultiArray(
    shape: shape.map(NSNumber.init(value:)),
    dataType: dataType
  ) else {
    require(false, "Neural MLMultiArray fixture must allocate")
    fatalError()
  }
  for index in 0..<array.count {
    array[index] = NSNumber(value: index < values.count ? values[index] : 0)
  }
  return array
}

private func neuralStridedFloat16Array(
  shape: [Int],
  strides: [Int],
  values: [Double]
) -> MLMultiArray {
  guard shape.count == strides.count,
        !shape.isEmpty,
        shape.allSatisfy({ $0 > 0 }),
        strides.allSatisfy({ $0 > 0 }) else {
    require(false, "Strided neural fixture shape and strides must be valid")
    fatalError()
  }
  let logicalCount = shape.reduce(1, *)
  let storageCount = 1 + zip(shape, strides).reduce(0) {
    $0 + ($1.0 - 1) * $1.1
  }
  let pointer = UnsafeMutableRawPointer.allocate(
    byteCount: storageCount * MemoryLayout<UInt16>.stride,
    alignment: MemoryLayout<UInt16>.alignment
  )
  pointer.initializeMemory(
    as: UInt16.self,
    repeating: 0,
    count: storageCount
  )
  let array: MLMultiArray
  do {
    array = try MLMultiArray(
      dataPointer: pointer,
      shape: shape.map(NSNumber.init(value:)),
      dataType: .float16,
      strides: strides.map(NSNumber.init(value:)),
      deallocator: { $0.deallocate() }
    )
  } catch {
    pointer.deallocate()
    require(false, "Strided neural MLMultiArray fixture must allocate: \(error)")
    fatalError()
  }
  for flatIndex in 0..<logicalCount {
    var remainder = flatIndex
    var indices = Array(repeating: 0, count: shape.count)
    for axis in shape.indices.reversed() {
      indices[axis] = remainder % shape[axis]
      remainder /= shape[axis]
    }
    array[indices.map { NSNumber(value: $0) }] = NSNumber(
      value: flatIndex < values.count ? values[flatIndex] : 0
    )
  }
  return array
}

private func neuralProvider(_ arrays: [String: MLMultiArray]) -> MLFeatureProvider {
  let dictionary = arrays.mapValues { MLFeatureValue(multiArray: $0) }
  guard let provider = try? MLDictionaryFeatureProvider(dictionary: dictionary) else {
    require(false, "Neural feature-provider fixture must allocate")
    fatalError()
  }
  return provider
}

private func verifyCTCRuntime() {
  let runtimeContract = LekhNeuralCTCContract(
    maxInputLength: 4,
    outputTimeSteps: 8,
    vocabularySize: 3,
    blankTokenId: 0,
    beamWidth: 4,
    maximumCandidates: 3
  )
  let inputIds = neuralArray(
    shape: [1, runtimeContract.maxInputLength],
    dataType: .int32,
    values: [3, 1, 0, 0]
  )
  let rows = [
    [0.0, 6.0, 1.0],
    [6.0, 0.0, 0.0],
    [0.0, 6.0, 1.0]
  ] + Array(
    repeating: [6.0, 0.0, 0.0],
    count: runtimeContract.outputTimeSteps - 3
  )
  let model = FakeNeuralModel { provider in
    require(
      Set(provider.featureNames) == Set(["inputIds"]),
      "CTC Core ML inference must receive only inputIds"
    )
    return neuralProvider([
      "logits": neuralStridedFloat16Array(
        shape: [
          1,
          runtimeContract.outputTimeSteps,
          runtimeContract.vocabularySize
        ],
        strides: [
          runtimeContract.outputTimeSteps * 7,
          7,
          2
        ],
        values: rows.flatMap { $0 }
      )
    ])
  }
  do {
    let candidates = try LekhNeuralCTCRuntime.rank(
      model: model,
      contract: runtimeContract,
      inputIds: inputIds
    )
    require(
      candidates.first == [1, 1],
      "One-shot Core ML CTC inference must preserve blank-separated repeats"
    )
    require(
      model.callCount == 1,
      "Fixed-shape CTC inference must invoke Core ML exactly once"
    )
    require(
      candidates.first == [1, 1],
      "CTC inference must respect non-contiguous MLMultiArray strides"
    )
  } catch {
    require(false, "CTC runtime fixture failed: \(error)")
  }

  let malformed = FakeNeuralModel { _ in
    neuralProvider([
      "logits": neuralArray(
        shape: [1, runtimeContract.outputTimeSteps, 2],
        dataType: .float16
      )
    ])
  }
  do {
    _ = try LekhNeuralCTCRuntime.rank(
      model: malformed,
      contract: runtimeContract,
      inputIds: inputIds
    )
    require(false, "A malformed CTC output tensor must fail closed")
  } catch LekhNeuralCTCRuntimeFailure.modelOutputInvalid {
    // Expected.
  } catch {
    require(false, "Malformed CTC output raised the wrong failure: \(error)")
  }

  let cancelled = FakeNeuralModel { _ in neuralProvider([:]) }
  do {
    _ = try LekhNeuralCTCRuntime.rank(
      model: cancelled,
      contract: runtimeContract,
      inputIds: inputIds,
      shouldCancel: { true }
    )
    require(false, "Pre-cancelled CTC inference must not invoke Core ML")
  } catch LekhNeuralCTCRuntimeFailure.cancelled {
    require(
      cancelled.callCount == 0,
      "Pre-cancelled CTC inference must make zero model calls"
    )
  } catch {
    require(false, "Cancelled CTC runtime raised the wrong failure: \(error)")
  }
}

private func splitEncoderOutput(
  contract: LekhNeuralSplitAttentionContract,
  initialHiddenShape: [Int]? = nil
) -> MLFeatureProvider {
  neuralProvider([
    "encoderOutputs": neuralArray(
      shape: [1, contract.maxInputLength, contract.encoderWidth],
      dataType: .float16
    ),
    "encoderEnergy": neuralArray(
      shape: [1, contract.maxInputLength, contract.attentionWidth],
      dataType: .float16
    ),
    "validMask": neuralArray(
      shape: [1, contract.maxInputLength],
      dataType: .float16,
      values: [1, 1, 1]
    ),
    "initialDecoderHidden": neuralArray(
      shape: initialHiddenShape ?? [contract.decoderLayers, 1, contract.hiddenWidth],
      dataType: .float16,
      values: [10, 11, 20, 21]
    )
  ])
}

private func verifySplitAttentionRuntime() {
  let contract = LekhNeuralSplitAttentionContract(
    maxInputLength: 4,
    encoderWidth: 4,
    attentionWidth: 3,
    decoderLayers: 2,
    beamWidth: 4,
    hiddenWidth: 2,
    vocabularySize: 6
  )
  let inputIds = neuralArray(
    shape: [1, contract.maxInputLength],
    dataType: .int32,
    values: [4, 5, 2, 0]
  )
  let firstStepLogits = [-20.0, -20.0, 3.0, -20.0, 2.0, 2.0]
  let laterStepLogits = [-20.0, -20.0, 4.0, -20.0, 1.0, 1.0]
  let encoder = FakeNeuralModel { provider in
    require(Set(provider.featureNames) == Set(["inputIds"]), "Split encoder must receive only inputIds")
    return splitEncoderOutput(contract: contract)
  }
  var packedTokens: [[Int]] = []
  var packedHidden: [[Double]] = []
  let decoder = FakeNeuralModel { provider in
    guard let tokens = provider.featureValue(for: "decoderTokenIds")?.multiArrayValue,
          let hidden = provider.featureValue(for: "decoderHidden")?.multiArrayValue else {
      require(false, "Split decoder must receive token and hidden tensors")
      return neuralProvider([:])
    }
    packedTokens.append((0..<tokens.count).map { tokens[$0].intValue })
    packedHidden.append((0..<hidden.count).map { hidden[$0].doubleValue })
    let logitsRow = packedTokens.count == 1 ? firstStepLogits : laterStepLogits
    let logits = (0..<contract.beamWidth).flatMap { _ in logitsRow }
    var nextHidden = Array(
      repeating: 0.0,
      count: contract.decoderLayers * contract.beamWidth * contract.hiddenWidth
    )
    for layer in 0..<contract.decoderLayers {
      for lane in 0..<contract.beamWidth {
        for unit in 0..<contract.hiddenWidth {
          let offset = (layer * contract.beamWidth + lane) * contract.hiddenWidth + unit
          nextHidden[offset] = Double((layer + 1) * 100 + lane * 10 + unit)
        }
      }
    }
    return neuralProvider([
      "stepLogits": neuralArray(
        shape: [contract.beamWidth, contract.vocabularySize],
        dataType: .float16,
        values: logits
      ),
      "nextDecoderHidden": neuralArray(
        shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
        dataType: .float16,
        values: nextHidden
      )
    ])
  }

  do {
    let observed = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: encoder, decoderStep: decoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 2
    )
    let expected = try LekhNeuralBeamSearch.rank(
      vocabularySize: contract.vocabularySize,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      beamWidth: contract.beamWidth,
      maxSteps: 2
    ) { prefix, _ in
      prefix == [1] ? firstStepLogits : laterStepLogits
    }
    require(
      observed.map(\.tokenIds) == expected.map(\.tokenIds),
      "Split recurrent ranking must preserve legacy/Python EOS and tie semantics"
    )
    require(encoder.callCount == 1, "Split inference must encode exactly once")
    require(decoder.callCount == 2, "Split inference must call the decoder at most once per live step")
    require(packedTokens == [[1, 0, 0, 0], [4, 5, 0, 0]], "Split lanes must pad fewer than four live beams")
    require(
      packedHidden[0] == [10, 11, 0, 0, 0, 0, 0, 0, 20, 21, 0, 0, 0, 0, 0, 0],
      "Initial recurrent state must occupy only the first live lane"
    )
    require(
      packedHidden[1] == [100, 101, 100, 101, 0, 0, 0, 0, 200, 201, 200, 201, 0, 0, 0, 0],
      "Sibling beams must inherit the exact parent next-state while unused lanes remain zero"
    )
  } catch {
    require(false, "Split attention recurrent fixture failed: \(error)")
  }

  var constrainedStep = 0
  let constrainedEncoder = FakeNeuralModel { _ in splitEncoderOutput(contract: contract) }
  let constrainedDecoder = FakeNeuralModel { _ in
    constrainedStep += 1
    let row = constrainedStep == 1
      ? [-20.0, -20.0, -20.0, -20.0, 10.0, 100.0]
      : [-20.0, -20.0, 10.0, -20.0, -20.0, -20.0]
    return neuralProvider([
      "stepLogits": neuralArray(
        shape: [contract.beamWidth, contract.vocabularySize],
        dataType: .float16,
        values: (0..<contract.beamWidth).flatMap { _ in row }
      ),
      "nextDecoderHidden": neuralArray(
        shape: [contract.decoderLayers, contract.beamWidth, contract.hiddenWidth],
        dataType: .float16
      )
    ])
  }
  do {
    let constrained = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: constrainedEncoder, decoderStep: constrainedDecoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 2,
      permitsToken: { prefix, tokenId in
        prefix == [1] ? tokenId == 4 : tokenId == 2
      }
    )
    require(
      constrained.map(\.tokenIds) == [[1, 4, 2]],
      "Split decoding must mask a higher-logit illegal scalar and require EOS"
    )
  } catch {
    require(false, "Split constrained-decoder fixture failed: \(error)")
  }

  let malformedEncoder = FakeNeuralModel { _ in
    splitEncoderOutput(contract: contract, initialHiddenShape: [2, 1, 3])
  }
  let unreachableDecoder = FakeNeuralModel { _ in neuralProvider([:]) }
  do {
    _ = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: malformedEncoder, decoderStep: unreachableDecoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 1
    )
    require(false, "Malformed split encoder output must fail closed")
  } catch LekhNeuralSplitAttentionFailure.encoderOutputInvalid {
    require(unreachableDecoder.callCount == 0, "Malformed encoder output must prevent decoder inference")
  } catch {
    require(false, "Malformed split encoder raised the wrong failure: \(error)")
  }

  let validEncoder = FakeNeuralModel { _ in splitEncoderOutput(contract: contract) }
  let malformedDecoder = FakeNeuralModel { _ in
    neuralProvider([
      "stepLogits": neuralArray(shape: [4, 5], dataType: .float16),
      "nextDecoderHidden": neuralArray(shape: [2, 4, 2], dataType: .float16)
    ])
  }
  do {
    _ = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: validEncoder, decoderStep: malformedDecoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 1
    )
    require(false, "Malformed split decoder output must fail closed")
  } catch LekhNeuralSplitAttentionFailure.decoderOutputInvalid {
    // Expected.
  } catch {
    require(false, "Malformed split decoder raised the wrong failure: \(error)")
  }

  let cancelledEncoder = FakeNeuralModel { _ in splitEncoderOutput(contract: contract) }
  do {
    _ = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: cancelledEncoder, decoderStep: unreachableDecoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 1,
      shouldCancel: { true }
    )
    require(false, "A stale request must cancel before encoder inference")
  } catch LekhNeuralSplitAttentionFailure.cancelled {
    require(cancelledEncoder.callCount == 0, "Pre-cancelled inference must make zero model calls")
  } catch {
    require(false, "Pre-cancelled split inference raised the wrong failure: \(error)")
  }

  var cancelAfterEncoder = false
  let cancellingEncoder = FakeNeuralModel { _ in
    cancelAfterEncoder = true
    return splitEncoderOutput(contract: contract)
  }
  do {
    _ = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: cancellingEncoder, decoderStep: unreachableDecoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 1,
      shouldCancel: { cancelAfterEncoder }
    )
    require(false, "Cancellation after encoder inference must suppress decoding")
  } catch LekhNeuralSplitAttentionFailure.cancelled {
    require(unreachableDecoder.callCount == 0, "Post-encoder cancellation must make zero decoder calls")
  } catch {
    require(false, "Post-encoder cancellation raised the wrong failure: \(error)")
  }

  var cancelAfterDecoder = false
  let finalEncoder = FakeNeuralModel { _ in splitEncoderOutput(contract: contract) }
  let cancellingDecoder = FakeNeuralModel { _ in
    cancelAfterDecoder = true
    return neuralProvider([
      "stepLogits": neuralArray(shape: [4, 6], dataType: .float16),
      "nextDecoderHidden": neuralArray(shape: [2, 4, 2], dataType: .float16)
    ])
  }
  do {
    _ = try LekhNeuralSplitAttentionRuntime.rank(
      models: .init(encoder: finalEncoder, decoderStep: cancellingDecoder),
      contract: contract,
      inputIds: inputIds,
      padTokenId: 0,
      sosTokenId: 1,
      eosTokenId: 2,
      invalidTokenIds: [0, 1, 3],
      maxSteps: 1,
      shouldCancel: { cancelAfterDecoder }
    )
    require(false, "Cancellation after decoder inference must suppress stale output")
  } catch LekhNeuralSplitAttentionFailure.cancelled {
    require(cancellingDecoder.callCount == 1, "Post-decoder cancellation must stop after that call")
  } catch {
    require(false, "Post-decoder cancellation raised the wrong failure: \(error)")
  }
}

private func verifySplitAttentionManifestContract() {
  let hashA = String(repeating: "a", count: 64)
  let hashB = String(repeating: "b", count: 64)
  let hashC = String(repeating: "c", count: 64)
  let hashD = String(repeating: "d", count: 64)
  let inputTokens = ["<pad>", "<s>", "</s>", "<unk>", "a"]
  let outputTokens = ["<pad>", "<s>", "</s>", "<unk>", "क"]
  let vocabulary: [String: Any] = [
    "maxLength": 4,
    "tokensById": inputTokens,
    "idsByToken": Dictionary(uniqueKeysWithValues: inputTokens.enumerated().map { ($0.element, $0.offset) }),
    "padId": 0,
    "sosId": 1,
    "eosId": 2,
    "unkId": 3
  ]
  var outputVocabulary = vocabulary
  outputVocabulary["maxLength"] = 8
  outputVocabulary["tokensById"] = outputTokens
  outputVocabulary["idsByToken"] = Dictionary(
    uniqueKeysWithValues: outputTokens.enumerated().map { ($0.element, $0.offset) }
  )
  let vocab: [String: Any] = [
    "schemaVersion": 1,
    "modelId": "lekh-open-vocab-bigru-attention-v1",
    "generatedAt": "2026-07-23T00:00:00Z",
    "tokenization": "unicode-scalar-character",
    "input": vocabulary,
    "output": outputVocabulary,
    "decoder": [
      "type": "beam-search",
      "beamWidth": 4,
      "maxSteps": 7,
      "outputSequenceValidation": "devanagari-word-sequence-v1",
      "rejectWhitespaceCandidates": true,
      "rejectLatinCandidates": true
    ],
    "dataset": [
      "manifest": "data/neural/dataset.json",
      "manifestSha256": hashA,
      "splitSha256": ["train": hashA, "dev": hashB, "test": hashC]
    ],
    "nativeRuntimePolicy": [
      "asyncOnly": true,
      "neverInvokeInSecureFields": true,
      "failOpenRawTypingOnError": true,
      "neuralTailOnly": true
    ]
  ]
  let encoderArtifact: [String: Any] = [
    "role": "encoder",
    "mlpackage": "models/macos/challengers/Encoder.mlpackage",
    "mlpackageBytes": 90,
    "mlpackageSha256": hashB,
    "compiledModel": "models/macos/challengers/Encoder.mlmodelc",
    "compiledBytes": 100,
    "compiledSha256": hashA
  ]
  let decoderArtifact: [String: Any] = [
    "role": "decoderStep",
    "mlpackage": "models/macos/challengers/DecoderStep.mlpackage",
    "mlpackageBytes": 110,
    "mlpackageSha256": hashD,
    "compiledModel": "models/macos/challengers/DecoderStep.mlmodelc",
    "compiledBytes": 120,
    "compiledSha256": hashC
  ]
  let tensorContract: [String: Any] = [
    "encoder": [
      "inputs": ["inputIds": ["shape": [1, 4], "dataType": "INT32"]],
      "outputs": [
        "encoderOutputs": ["shape": [1, 4, 4], "dataType": "FLOAT16"],
        "encoderEnergy": ["shape": [1, 4, 3], "dataType": "FLOAT16"],
        "validMask": ["shape": [1, 4], "dataType": "FLOAT16"],
        "initialDecoderHidden": ["shape": [2, 1, 2], "dataType": "FLOAT16"]
      ]
    ],
    "decoderStep": [
      "inputs": [
        "decoderTokenIds": ["shape": [4, 1], "dataType": "INT32"],
        "decoderHidden": ["shape": [2, 4, 2], "dataType": "FLOAT16"],
        "encoderOutputs": ["shape": [1, 4, 4], "dataType": "FLOAT16"],
        "encoderEnergy": ["shape": [1, 4, 3], "dataType": "FLOAT16"],
        "validMask": ["shape": [1, 4], "dataType": "FLOAT16"]
      ],
      "outputs": [
        "stepLogits": ["shape": [4, 5], "dataType": "FLOAT16"],
        "nextDecoderHidden": ["shape": [2, 4, 2], "dataType": "FLOAT16"]
      ]
    ]
  ]
  let manifest: [String: Any] = [
    "schemaVersion": 2,
    "trainingRunId": String(repeating: "1", count: 32),
    "exportRunId": String(repeating: "2", count: 32),
    "selectedArtifact": "lekh-open-vocab-bigru-attention-v1",
    "runtime": "CoreML",
    "runtimeModelContract": "split-attention-incremental-v1",
    "tensorContract": tensorContract,
    "compiledModels": ["encoder": encoderArtifact, "decoderStep": decoderArtifact],
    "localOnly": true,
    "neuralTailOnly": true,
    "productionEligible": false,
    "architecture": "bidirectional-gru-additive-attention-seq2seq",
    "openVocabulary": true,
    "tokenization": "unicode-scalar-character",
    "outputSequenceValidation": "devanagari-word-sequence-v1",
    "decoder": "beam-search",
    "beamSearch": [
      "enabled": true,
      "beamWidth": 4,
      "maxOutputGraphemes": 8,
      "maxSteps": 7
    ],
    "languageModelRescorer": ["enabled": false, "source": "none", "weight": 0],
    "contextWindowWords": 0,
    "parameterCount": 1_000_000,
    "modelBytes": 220,
    "trainingSources": [],
    "datasetReports": ["reports/dataset.json"],
    "evaluationReports": ["reports/evaluation.json"],
    "benchmarkReports": ["reports/benchmark.json"],
    "metrics": [
      "tailTop1Accuracy": -1,
      "tailTop3Accuracy": -1,
      "chatConventionTop1Accuracy": -1,
      "chatConventionTop3Accuracy": -1,
      "namesTop3Accuracy": -1,
      "protectedFalseConversionRate": -1,
      "singleTokenPhraseExpansionRate": -1,
      "secureFieldInferenceCount": -1
    ],
    "performance": [
      "p50Ms": 999,
      "p95Ms": 999,
      "p99Ms": 999,
      "targetP99Ms": 50,
      "measuredOnDevice": false,
      "devices": [[
        "name": "fixture",
        "macOS": "13",
        "architecture": "arm64",
        "packagedApp": false,
        "secureFieldInferenceCount": -1,
        "p50Ms": 999,
        "p95Ms": 999,
        "p99Ms": 999,
        "artifact": "Encoder.mlmodelc+DecoderStep.mlmodelc",
        "measurementKind": "full-candidate-generation"
      ]]
    ],
    "requiredCases": [
      "vato": "बाटो", "bato": "बाटो", "baato": "बाटो", "chha": "छ",
      "cha": "छ", "xa": "छ", "xaina": "छैन"
    ],
    "sha256": [
      "compiledModels": ["encoder": hashA, "decoderStep": hashC],
      "mlpackages": ["encoder": hashB, "decoderStep": hashD],
      "sourceCheckpoint": hashA,
      "trainingDatasetManifest": hashA,
      "vocabMetadata": hashD
    ],
    "limitations": ["experimental"]
  ]

  func validates(_ candidate: [String: Any]) -> Bool {
    guard let manifestData = try? JSONSerialization.data(withJSONObject: candidate),
          let vocabData = try? JSONSerialization.data(withJSONObject: vocab) else { return false }
    return LekhNeuralCandidateService.validatesSplitManifestContract(
      manifestData: manifestData,
      vocabData: vocabData
    )
  }

  require(validates(manifest), "The exact two-artifact split manifest contract must parse")

  var overflowingTensor = manifest
  var overflowingTensorContract = overflowingTensor["tensorContract"] as! [String: Any]
  var overflowingEncoder = overflowingTensorContract["encoder"] as! [String: Any]
  var overflowingOutputs = overflowingEncoder["outputs"] as! [String: Any]
  overflowingOutputs["initialDecoderHidden"] = [
    "shape": [2, 1, Int.max],
    "dataType": "FLOAT16"
  ]
  overflowingEncoder["outputs"] = overflowingOutputs
  overflowingTensorContract["encoder"] = overflowingEncoder
  overflowingTensor["tensorContract"] = overflowingTensorContract
  require(
    !validates(overflowingTensor),
    "Adversarial tensor dimensions must fail closed without integer overflow"
  )

  var underflow = manifest
  underflow["beamSearch"] = [
    "enabled": true,
    "beamWidth": 4,
    "maxOutputGraphemes": Int.min,
    "maxSteps": 7
  ]
  require(
    !validates(underflow),
    "An adversarial decoder length must fail closed without integer underflow"
  )

  var partial = manifest
  var partialModels = partial["compiledModels"] as! [String: Any]
  partialModels.removeValue(forKey: "decoderStep")
  partial["compiledModels"] = partialModels
  require(!validates(partial), "A partial split artifact pair must fail closed")

  var stale = manifest
  var staleModels = stale["compiledModels"] as! [String: Any]
  var staleEncoder = staleModels["encoder"] as! [String: Any]
  staleEncoder["compiledSha256"] = hashD
  staleModels["encoder"] = staleEncoder
  stale["compiledModels"] = staleModels
  require(!validates(stale), "A split artifact hash detached from sha256 bindings must fail closed")

  var malformed = manifest
  var malformedContract = malformed["tensorContract"] as! [String: Any]
  var malformedDecoder = malformedContract["decoderStep"] as! [String: Any]
  var malformedOutputs = malformedDecoder["outputs"] as! [String: Any]
  malformedOutputs["stepLogits"] = ["shape": [3, 5], "dataType": "FLOAT16"]
  malformedDecoder["outputs"] = malformedOutputs
  malformedContract["decoderStep"] = malformedDecoder
  malformed["tensorContract"] = malformedContract
  require(!validates(malformed), "A decoder tensor shape detached from fixed beam width must fail closed")

  var openWorld = manifest
  openWorld["unexpected"] = true
  require(!validates(openWorld), "An unknown split manifest field must fail closed")
}

private func verifyCTCManifestContract() {
  let hashA = String(repeating: "a", count: 64)
  let hashB = String(repeating: "b", count: 64)
  let inputTokens = ["<pad>", "</s>", "<unk>", "a"]
  let outputTokens = ["<ctc-blank>", "क"]
  let inputVocabulary: [String: Any] = [
    "maxLength": 4,
    "tokensById": inputTokens,
    "idsByToken": Dictionary(
      uniqueKeysWithValues: inputTokens.enumerated().map {
        ($0.element, $0.offset)
      }
    ),
    "padId": 0,
    "eosId": 1,
    "unkId": 2
  ]
  let outputVocabulary: [String: Any] = [
    "timeSteps": 8,
    "tokensById": outputTokens,
    "idsByToken": Dictionary(
      uniqueKeysWithValues: outputTokens.enumerated().map {
        ($0.element, $0.offset)
      }
    ),
    "blankId": 0
  ]
  let vocab: [String: Any] = [
    "schemaVersion": 2,
    "modelId": "lekh-open-vocab-ctc-transformer-v2",
    "generatedAt": "2026-07-29T00:00:00Z",
    "tokenization": "unicode-scalar-character",
    "runtimeModelContract": "single-transformer-ctc-v1",
    "input": inputVocabulary,
    "output": outputVocabulary,
    "decoder": [
      "type": "ctc-prefix-beam-search",
      "beamWidth": 4,
      "maximumCandidates": 2,
      "outputSequenceValidation": "devanagari-word-sequence-v1",
      "rejectWhitespaceCandidates": true,
      "rejectLatinCandidates": true
    ],
    "dataset": [
      "manifest": "data/neural/dataset.json",
      "manifestSha256": hashA,
      "splitSha256": [
        "train": hashA,
        "dev": hashB,
        "test": hashA
      ]
    ],
    "nativeRuntimePolicy": [
      "asyncOnly": true,
      "neverInvokeInSecureFields": true,
      "failOpenRawTypingOnError": true,
      "neuralTailOnly": true
    ]
  ]
  let manifest: [String: Any] = [
    "schemaVersion": 2,
    "trainingRunId": String(repeating: "1", count: 32),
    "exportRunId": String(repeating: "2", count: 32),
    "selectedArtifact": "lekh-open-vocab-ctc-transformer-v2",
    "runtime": "CoreML",
    "runtimeModelContract": "single-transformer-ctc-v1",
    "tensorContract": [
      "inputIds": [
        "shape": [1, 4],
        "dataType": "INT32"
      ],
      "logits": [
        "shape": [1, 8, 2],
        "dataType": "FLOAT16"
      ]
    ],
    "localOnly": true,
    "neuralTailOnly": true,
    "productionEligible": false,
    "architecture": "fixed-shape-transformer-ctc",
    "openVocabulary": true,
    "tokenization": "unicode-scalar-character",
    "outputSequenceValidation": "devanagari-word-sequence-v1",
    "decoder": "ctc-prefix-beam-search",
    "beamSearch": [
      "enabled": true,
      "beamWidth": 4,
      "maxOutputGraphemes": 8,
      "maxSteps": 8
    ],
    "languageModelRescorer": [
      "enabled": false,
      "source": "none",
      "weight": 0
    ],
    "contextWindowWords": 0,
    "parameterCount": 1_000_000,
    "modelBytes": 200,
    "trainingSources": [],
    "datasetReports": ["reports/dataset.json"],
    "evaluationReports": ["reports/evaluation.json"],
    "benchmarkReports": ["reports/benchmark.json"],
    "metrics": [
      "tailTop1Accuracy": -1,
      "tailTop3Accuracy": -1,
      "chatConventionTop1Accuracy": -1,
      "chatConventionTop3Accuracy": -1,
      "namesTop3Accuracy": -1,
      "protectedFalseConversionRate": -1,
      "singleTokenPhraseExpansionRate": -1,
      "secureFieldInferenceCount": -1
    ],
    "performance": [
      "p50Ms": 999,
      "p95Ms": 999,
      "p99Ms": 999,
      "targetP99Ms": 50,
      "measuredOnDevice": false,
      "devices": [[
        "name": "fixture",
        "macOS": "13",
        "architecture": "arm64",
        "packagedApp": false,
        "secureFieldInferenceCount": -1,
        "p50Ms": 999,
        "p95Ms": 999,
        "p99Ms": 999,
        "artifact": "LekhNeuralTransliterator.mlmodelc",
        "measurementKind": "full-candidate-generation"
      ]]
    ],
    "requiredCases": [
      "vato": "बाटो",
      "bato": "बाटो",
      "baato": "बाटो",
      "chha": "छ",
      "cha": "छ",
      "xa": "छ",
      "xaina": "छैन"
    ],
    "sha256": [
      "compiledModel": hashA,
      "sourceCheckpoint": hashB,
      "trainingDatasetManifest": hashA,
      "vocabMetadata": hashB
    ],
    "limitations": ["experimental"]
  ]

  func validates(
    _ manifestCandidate: [String: Any],
    _ vocabCandidate: [String: Any] = vocab
  ) -> Bool {
    guard let manifestData = try? JSONSerialization.data(
      withJSONObject: manifestCandidate
    ), let vocabData = try? JSONSerialization.data(
      withJSONObject: vocabCandidate
    ) else {
      return false
    }
    return LekhNeuralCandidateService.validatesCTCManifestContract(
      manifestData: manifestData,
      vocabData: vocabData
    )
  }

  require(
    validates(manifest),
    "The exact single-model Transformer CTC manifest must parse"
  )

  var malformedTensor = manifest
  var tensorContract = malformedTensor["tensorContract"] as! [String: Any]
  tensorContract["logits"] = [
    "shape": [1, 8, 3],
    "dataType": "FLOAT16"
  ]
  malformedTensor["tensorContract"] = tensorContract
  require(
    !validates(malformedTensor),
    "A CTC class dimension detached from the vocabulary must fail closed"
  )

  var malformedVocab = vocab
  var malformedOutput = malformedVocab["output"] as! [String: Any]
  malformedOutput["blankId"] = 1
  malformedVocab["output"] = malformedOutput
  require(
    !validates(manifest, malformedVocab),
    "A nonzero or mislabeled CTC blank class must fail closed"
  )

  var partialTensor = manifest
  var partialContract = partialTensor["tensorContract"] as! [String: Any]
  partialContract.removeValue(forKey: "logits")
  partialTensor["tensorContract"] = partialContract
  require(
    !validates(partialTensor),
    "A partial CTC tensor contract must fail closed"
  )

  var openWorld = manifest
  openWorld["unexpected"] = true
  require(
    !validates(openWorld),
    "An unknown CTC manifest field must fail closed"
  )
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
verifyCTCPrefixBeamSearch()
verifyCTCRuntime()
verifySplitAttentionRuntime()
verifySplitAttentionManifestContract()
verifyCTCManifestContract()
verifyNeuralManifestIdentityPolicy()
print(
  "PASS: native candidate, delimiter, four-mode, neural admission, " +
    "exhaustive CTC decoder oracle, and manifest identity contracts"
)
