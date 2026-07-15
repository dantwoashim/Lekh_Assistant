import Foundation
import LekhInputMethod

private let skeletonDirectory = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
private let sourceRuntimePack = skeletonDirectory
  .appendingPathComponent("../../../src/data/keyboard-packs/v0.1/runtime-suggestions.json")
  .standardizedFileURL
private let sourceCanonicalTokenPack = skeletonDirectory
  .appendingPathComponent("../../../data/engine/lekh-token-candidates.v1.json")
  .standardizedFileURL
private let sourceTokenCompletionIndex = skeletonDirectory
  .appendingPathComponent("../../../data/completion/runtime/v1/lekh-token-completions.v1.json")
  .standardizedFileURL
private let sourceTokenCompletionManifest = skeletonDirectory
  .appendingPathComponent("../../../data/completion/runtime/v1/lekh-token-completions.v1.manifest.json")
  .standardizedFileURL
private let testPersonalizationDatabase = FileManager.default.temporaryDirectory
  .appendingPathComponent("lekh-behavior-\(UUID().uuidString).sqlite3")
setenv("LEKH_TEST_RUNTIME_SUGGESTIONS_PATH", sourceRuntimePack.path, 1)
setenv("LEKH_TEST_CANONICAL_TOKEN_PACK_PATH", sourceCanonicalTokenPack.path, 1)
setenv("LEKH_TEST_TOKEN_COMPLETIONS_PATH", sourceTokenCompletionIndex.path, 1)
setenv("LEKH_TEST_TOKEN_COMPLETIONS_MANIFEST_PATH", sourceTokenCompletionManifest.path, 1)
setenv("LEKH_TEST_PERSONALIZATION_DB_PATH", testPersonalizationDatabase.path, 1)
setenv("LEKH_TEST_PERSONALIZATION_RESET_EPOCH", "1", 1)
private let behaviorEngine = LekhNativeEngineClient()

@discardableResult
private func require(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
  if !condition() {
    fputs("FAIL: \(message)\n", stderr)
    exit(1)
  }
  return true
}

private func type(
  _ text: String,
  engine: LekhNativeEngineClient,
  sessionId: String,
  mode: LekhNativeTypingMode
) -> LekhInputDecision {
  var decision = LekhInputDecision.passThrough
  for character in text {
    decision = engine.processKey(
      String(character),
      sessionId: sessionId,
      mode: mode
    )
  }
  return decision
}

private func dumpCandidateDiagnosticsIfRequested() {
  guard ProcessInfo.processInfo.environment["LEKH_DUMP_NATIVE_CANDIDATES"] == "1" else {
    return
  }
  let tokens = [
    "k", "kaha", "mero", "timi", "tapai", "hami", "ramro", "pani",
    "dhanyabad", "namaste", "sanchai", "lekh", "swasthya", "nepal",
    "kathmandu", "garnu", "garne", "manchhe", "dherai"
  ]
  for token in tokens {
    let decision = type(
      token,
      engine: behaviorEngine,
      sessionId: "dump-\(token)-\(UUID().uuidString)",
      mode: .romanizedTraditional
    )
    print(
      "native-candidates input=\(token) marked=\(decision.markedText ?? "nil") " +
        "candidates=\(decision.candidates) ghost=\(decision.inlineSuggestion?.acceptedText ?? "nil")"
    )
  }
}

private func benchmarkNeuralServiceIfRequested() {
  guard let bundlePath = ProcessInfo.processInfo.environment["LEKH_NEURAL_BENCH_BUNDLE"],
        let bundle = Bundle(path: bundlePath) else {
    return
  }
  let service = LekhNeuralCandidateService(bundle: bundle)
  require(
    service.status.contains("ready"),
    "Packaged neural service must be enabled for end-to-end measurement; status=\(service.status)"
  )
  var deterministicBypass: [String]?
  service.candidates(for: "dhanyabad", secureInputActive: false) { deterministicBypass = $0 }
  require(
    deterministicBypass == [],
    "Shared deterministic exact tokens must bypass the experimental neural tail"
  )
  var protectedBypass: [String: [String]] = [:]
  for token in ["OpenAI", "GitHub", "npm", "SwiftUI", "macOS", "README", "hello"] {
    var candidates: [String]?
    service.candidates(for: token, secureInputActive: false) { candidates = $0 }
    require(candidates == [], "Protected Latin token \(token) must synchronously bypass Core ML")
    protectedBypass[token] = candidates ?? []
  }

  let tokens = ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"]
  var samples: [UInt64] = []
  var steadyStateByToken: [String: [Double]] = [:]
  var observed: [String: [String]] = [:]
  for iteration in 0..<3 {
    for token in tokens {
      let started = DispatchTime.now().uptimeNanoseconds
      var completed = false
      service.candidates(for: token, secureInputActive: false) { candidates in
        let elapsed = DispatchTime.now().uptimeNanoseconds - started
        samples.append(elapsed)
        if iteration > 0 {
          steadyStateByToken[token, default: []].append(Double(elapsed) / 1_000_000)
        }
        observed[token] = candidates
        completed = true
      }
      let deadline = Date().addingTimeInterval(10)
      while !completed, Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.005))
      }
      require(completed, "Packaged neural candidate service timed out for \(token)")
      if iteration == 0 {
        // The first request includes model/runtime warm-up and remains in the
        // report, but percentile gates use steady-state requests below.
        continue
      }
    }
  }
  let steadyState = Array(samples.dropFirst(tokens.count)).sorted()
  func percentile(_ value: Double) -> Double {
    let index = min(steadyState.count - 1, max(0, Int(ceil(value * Double(steadyState.count))) - 1))
    return Double(steadyState[index]) / 1_000_000
  }
  let p50 = percentile(0.50)
  let p95 = percentile(0.95)
  let p99 = percentile(0.99)
  require(p95 < 50, "End-to-end packaged neural service p95 must stay below 50 ms; observed=\(p95) ms")
  require(
    observed.values.flatMap { $0 }.allSatisfy { candidate in
      candidate.unicodeScalars.allSatisfy { !CharacterSet.whitespacesAndNewlines.contains($0) } &&
        candidate.range(of: #"[A-Za-z]"#, options: .regularExpression) == nil
    },
    "Neural tail candidates must remain single-token and target-script-only"
  )

  var secureCandidates: [String]?
  service.candidates(for: "password", secureInputActive: true) { secureCandidates = $0 }
  require(secureCandidates == [], "Secure fields must synchronously return no neural candidates")

  var latestWinsCompletions: [String] = []
  let burst = ["prashasan", "nagarikta", "mantralaya", "paryatan"]
  for token in burst {
    service.candidates(for: token, secureInputActive: false) { _ in
      latestWinsCompletions.append(token)
    }
  }
  let latestWinsDeadline = Date().addingTimeInterval(2)
  while latestWinsCompletions.isEmpty, Date() < latestWinsDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.005))
  }
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  require(
    latestWinsCompletions == [burst.last!],
    "Rapid neural requests must complete only the latest token; observed=\(latestWinsCompletions)"
  )

  var cancelledCompletionCalled = false
  service.candidates(for: "prashasan", secureInputActive: false) { _ in
    cancelledCompletionCalled = true
  }
  service.cancelPending()
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))
  require(!cancelledCompletionCalled, "cancelPending must suppress stale neural completions")

  print(
    "native-neural-service-e2e p50-ms=\(p50) " +
      "p95-ms=\(p95) p99-ms=\(p99) " +
      "samples=\(steadyState.count) predictions=\(observed)"
  )

  if let reportPath = ProcessInfo.processInfo.environment["LEKH_NEURAL_BENCH_REPORT"] {
    let report: [String: Any] = [
      "generatedAt": ISO8601DateFormatter().string(from: Date()),
      "suite": "native-neural-service-e2e",
      "status": "passed-experimental",
      "bundle": bundlePath,
      "serviceStatus": service.status,
      "singleForwardBenchmarkIsConsumerLatency": false,
      "warmupRequests": tokens.count,
      "steadyStateSamples": steadyState.count,
      "targetP95Ms": 50,
      "performance": ["p50Ms": p50, "p95Ms": p95, "p99Ms": p99],
      "byTokenMs": steadyStateByToken,
      "predictions": observed,
      "singleTokenPhraseExpansionRate": 0,
      "secureFieldCandidates": secureCandidates ?? [],
      "deterministicExactBypassCandidates": deterministicBypass ?? [],
      "protectedLatinBypassCandidates": protectedBypass,
      "latestRequestWins": latestWinsCompletions == [burst.last!],
      "cancelPendingSuppressesCompletion": !cancelledCompletionCalled,
      "notes": [
        "Measures the public async candidate service, including iterative beam decoding and main-queue completion.",
        "The model remains experimental and production-ineligible; this is latency evidence, not production accuracy evidence."
      ]
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
      try? FileManager.default.createDirectory(
        at: URL(fileURLWithPath: reportPath).deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try? data.write(to: URL(fileURLWithPath: reportPath), options: .atomic)
    }
  }
}

private func assertRomanizedCompositionShowsSafeTargetPreviewUntilCommit() {
  let engine = behaviorEngine
  let sessionId = "probe-romanized-\(UUID().uuidString)"

  let partial = type("swasthya", engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  require(partial.handled, "swasthya keystrokes must be handled")
  require(
    partial.markedText == "स्वास्थ्य",
    "Romanized to Nepali composition must show the deterministic target preview; observed=\(partial.markedText ?? "nil")"
  )
  require(partial.committedText == nil, "Romanized composition must not commit before Space")
  require(partial.candidates.contains("स्वास्थ्य"), "Romanized composition must offer स्वास्थ्य")

  let rawSpaced = engine.processKey(
    " ",
    sessionId: sessionId,
    mode: .romanizedTraditional
  )
  require(rawSpaced.handled, "Space must be handled while composing")
  require(rawSpaced.committedText == "swasthya ", "Space must keep raw text unless the user explicitly accepts a candidate")
  require(rawSpaced.markedText == nil, "Space commit must clear marked text")
  require(!engine.hasComposition(sessionId: sessionId), "Space commit must reset composition")

  let tabSessionId = "probe-romanized-tab-\(UUID().uuidString)"
  _ = type("swasthya", engine: engine, sessionId: tabSessionId, mode: .romanizedTraditional)
  let tabbed = engine.processKey(
    "\t",
    sessionId: tabSessionId,
    mode: .romanizedTraditional
  )
  require(tabbed.handled, "A direct-engine Tab fallback must preserve the composition")
  require(
    tabbed.committedText == "swasthya\t",
    "A passive direct-engine Tab must commit raw and preserve host traversal exactly once"
  )

  let returnSessionId = "probe-romanized-return-\(UUID().uuidString)"
  _ = type("swasthya", engine: engine, sessionId: returnSessionId, mode: .romanizedTraditional)
  let returned = engine.processKey(
    "\n",
    sessionId: returnSessionId,
    mode: .romanizedTraditional
  )
  require(
    returned.committedText == "swasthya\n",
    "A passive direct-engine Return must keep raw text and preserve one newline"
  )

  let punctuationSessionId = "probe-romanized-punctuation-\(UUID().uuidString)"
  _ = type("pani", engine: engine, sessionId: punctuationSessionId, mode: .romanizedTraditional)
  let punctuated = engine.processKey(
    ".",
    sessionId: punctuationSessionId,
    mode: .romanizedTraditional
  )
  require(
    punctuated.committedText == "pani।",
    "Punctuation must not silently accept an uncalibrated or ambiguous candidate"
  )
}

private func assertRomanizedRomanizedModeDoesNotConvertMarkedTextToDevanagari() {
  let engine = behaviorEngine
  let sessionId = "probe-romanized-helper-\(UUID().uuidString)"

  let decision = type("lekh", engine: engine, sessionId: sessionId, mode: .romanizedRomanized)
  require(decision.handled, "Romanized helper keystrokes must be handled")
  require(decision.markedText == "lekh", "Romanized helper marked text must stay raw")
  require(decision.committedText == nil, "Romanized helper mode must not commit before accept")
  require(
    decision.candidates.allSatisfy { candidate in
      candidate.range(of: #"\p{Devanagari}"#, options: .regularExpression) == nil
    },
    "Romanized helper mode must not show Devanagari candidates"
  )
  require(
    decision.inlineSuggestion != nil,
    "Romanized helper prefixes must emit a ghost completion; marked=\(decision.markedText ?? "nil") candidates=\(decision.candidates)"
  )
  require(
    decision.inlineSuggestion?.acceptedText.hasPrefix(decision.markedText ?? "") == true,
    "Ghost completion acceptance must extend the visible marked text"
  )
}

private func assertProtectedLatinTokensStayByteExactAndBypassNeuralTail() {
  let protectedTokens = ["OpenAI", "GitHub", "npm", "SwiftUI", "macOS", "README", "hello"]
  for token in protectedTokens {
    let decision = type(
      token,
      engine: behaviorEngine,
      sessionId: "probe-protected-\(token)-\(UUID().uuidString)",
      mode: .romanizedTraditional
    )
    require(decision.markedText == token, "Protected Latin token \(token) must keep byte-exact marked text")
    require(decision.candidates.first == token, "Protected Latin token \(token) must keep raw as its primary candidate")
    require(decision.neuralTailEligible == false, "Protected Latin token \(token) must bypass the neural tail")
    require(decision.inlineSuggestion == nil, "Protected Latin token \(token) must not show a transliteration ghost")
    require(decision.autoCommitCandidate == nil, "Protected Latin token \(token) must never auto-convert")
  }

  let exact = type(
    "thapera",
    engine: behaviorEngine,
    sessionId: "probe-exact-neural-bypass-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(!exact.neuralTailEligible, "An exact deterministic runtime token must bypass Core ML")

  let openVocabularyTail = type(
    "prashasan",
    engine: behaviorEngine,
    sessionId: "probe-oov-neural-tail-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(openVocabularyTail.neuralTailEligible, "A safe Latin OOV must remain eligible for the async neural tail")
}

private func assertPrimaryModeEmitsSafeTargetScriptGhostCompletion() {
  let engine = behaviorEngine
  let sessionId = "probe-primary-ghost-\(UUID().uuidString)"
  let decision = type("lekh", engine: engine, sessionId: sessionId, mode: .romanizedTraditional)

  require(decision.markedText != nil, "Primary mode must retain a marked target-script composition")
  require(
    decision.inlineSuggestion != nil,
    "Romanized to Nepali prefixes must emit a target-script ghost completion"
  )
  require(
    decision.inlineSuggestion?.acceptedText.hasPrefix(decision.markedText ?? "") == true,
    "Primary ghost acceptance must extend the visible target-script composition"
  )
}

private func assertTokenCompletionArtifactIsVerifiedAndExplicitOnly() {
  let index = LekhTokenCompletionIndex.load(
    artifactURL: sourceTokenCompletionIndex,
    manifestURL: sourceTokenCompletionManifest
  )
  require(index.isReady, "Verified token completion index must load; status=\(index.status)")
  require(index.entryCount == 36, "Completion index entry count must match its reviewed manifest")
  let lekh = index.candidates(for: "lekh")
  require(lekh.first?.source == "lekhharu", "Reviewed lekh source completion must be available")
  require(lekh.first?.target == "लेखहरू", "Reviewed lekh target completion must be available")
  require(
    ["openai", "github", "nira", "prab", "mero", "pani", "nepal", "janma miti", "a@b.com", "9800000000"]
      .allSatisfy { index.candidates(for: $0).isEmpty },
    "Protected, name-like, complete, ambiguous, phrase, and sensitive inputs must remain suppressed"
  )
  require(
    index.candidates(for: "LEKH").first == lekh.first,
    "Completion lookup normalization must be deterministic"
  )

  let romanized = type(
    "dhany",
    engine: behaviorEngine,
    sessionId: "probe-completion-r2r-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  require(romanized.candidates.contains("dhanyabad"), "R→R must expose the reviewed source completion")
  require(
    romanized.inlineSuggestion?.acceptedText == "dhanyabad",
    "R→R ghost acceptance must be an exact single-token extension"
  )
  require(romanized.autoCommitCandidate == nil, "A completion score must never authorize auto-commit")

  let nepali = type(
    "dhany",
    engine: behaviorEngine,
    sessionId: "probe-completion-r2n-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(nepali.candidates.contains("धन्यवाद"), "R→N must expose the reviewed target completion")
  require(
    nepali.inlineSuggestion?.acceptedText == "धन्यवाद",
    "R→N ghost acceptance must extend the deterministic marked target"
  )

  let quarantinedName = type(
    "nira",
    engine: behaviorEngine,
    sessionId: "probe-completion-name-quarantine-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  require(quarantinedName.inlineSuggestion == nil, "Quarantined name prefixes must not produce ghosts")

  let temporaryDirectory = FileManager.default.temporaryDirectory
    .appendingPathComponent("lekh-completion-tamper-\(UUID().uuidString)", isDirectory: true)
  do {
    try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    let artifactCopy = temporaryDirectory.appendingPathComponent(sourceTokenCompletionIndex.lastPathComponent)
    let manifestCopy = temporaryDirectory.appendingPathComponent(sourceTokenCompletionManifest.lastPathComponent)
    try FileManager.default.copyItem(at: sourceTokenCompletionIndex, to: artifactCopy)
    try FileManager.default.copyItem(at: sourceTokenCompletionManifest, to: manifestCopy)
    var tamperedData = try Data(contentsOf: artifactCopy)
    tamperedData.append(0x0A)
    try tamperedData.write(to: artifactCopy, options: .atomic)
    let tampered = LekhTokenCompletionIndex.load(artifactURL: artifactCopy, manifestURL: manifestCopy)
    require(!tampered.isReady, "A byte-modified completion artifact must fail closed")
    require(tampered.candidates(for: "lekh").isEmpty, "Rejected artifacts must expose no candidates")
  } catch {
    require(false, "Completion tamper probe could not create fixtures: \(error)")
  }
  try? FileManager.default.removeItem(at: temporaryDirectory)
  print("native-token-completion-index=passed entries=\(index.entryCount) status=\(index.status)")
}

private func assertTraditionalRomanizedModeShowsRomanizedTargetPreview() {
  let engine = behaviorEngine
  let sessionId = "probe-traditional-helper-\(UUID().uuidString)"

  let decision = type("मेरो", engine: engine, sessionId: sessionId, mode: .traditionalRomanized)
  require(decision.handled, "Traditional helper keystrokes must be handled")
  require(
    decision.markedText == "mero" || decision.markedText == "meroo",
    "Traditional to Romanized marked text must show the Romanized target preview"
  )
  require(decision.committedText == nil, "Traditional helper mode must not commit before accept")
  require(
    decision.candidates.contains("mero") || decision.candidates.contains("meroo"),
    "Traditional helper mode must offer Romanized helper candidates"
  )
}

private func assertPassiveSpaceAutoCommitPolicyIsEvidenceBounded() {
  let boundary = LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
    text: "स्वास्थ्य",
    sourceInput: "swasthya",
    calibratedProbability: 0.92,
    runnerUpProbability: 0.80,
    isExactDeterministicToken: true
  )
  require(boundary != nil, "A calibrated exact token at both policy boundaries must be eligible")
  require(boundary?.calibratedProbability == 0.92, "Eligibility metadata must retain calibrated probability")
  require(abs((boundary?.margin ?? 0) - 0.12) < 0.000_001, "Eligibility metadata must retain the margin")

  require(
    LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
      text: "स्वास्थ्य",
      sourceInput: "swasthya",
      calibratedProbability: 0.919,
      runnerUpProbability: 0.70,
      isExactDeterministicToken: true
    ) == nil,
    "Forward auto-commit must reject probability below .92"
  )
  require(
    LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
      text: "स्वास्थ्य",
      sourceInput: "swasthya",
      calibratedProbability: 0.95,
      runnerUpProbability: 0.831,
      isExactDeterministicToken: true
    ) == nil,
    "Forward auto-commit must reject margin below .12"
  )

  let excludedFlags: [(String, (Bool, Bool, Bool, Bool, Bool))] = [
    ("name", (true, false, false, false, false)),
    ("phrase", (false, true, false, false, false)),
    ("protected", (false, false, true, false, false)),
    ("personal", (false, false, false, true, false)),
    ("neural", (false, false, false, false, true))
  ]
  for (label, flags) in excludedFlags {
    require(
      LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
        text: "स्वास्थ्य",
        sourceInput: "swasthya",
        calibratedProbability: 0.99,
        runnerUpProbability: 0.10,
        isExactDeterministicToken: true,
        isName: flags.0,
        isPhrase: flags.1,
        isProtected: flags.2,
        isPersonal: flags.3,
        isNeural: flags.4
      ) == nil,
      "Forward auto-commit must reject a \(label) candidate"
    )
  }
  require(
    LekhNativeAutoCommitPolicy.calibratedForwardCandidate(
      text: "स्वास्थ्य सेवा",
      sourceInput: "swasthya",
      calibratedProbability: 0.99,
      runnerUpProbability: 0.10,
      isExactDeterministicToken: true
    ) == nil,
    "Forward auto-commit must never expand one token into a phrase"
  )

  let forward = type(
    "namaste",
    engine: behaviorEngine,
    sessionId: "probe-forward-autocommit-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(
    forward.autoCommitCandidate == nil,
    "Uncalibrated repository confidence must not authorize Romanized to Nepali Space conversion"
  )

  let reversibleSession = "probe-reversible-autocommit-\(UUID().uuidString)"
  let reversible = type(
    "हजुर",
    engine: behaviorEngine,
    sessionId: reversibleSession,
    mode: .traditionalRomanized
  )
  require(reversible.autoCommitCandidate?.text == "hajur", "Unique reversible word हजुर must authorize hajur")
  require(
    reversible.autoCommitCandidate?.policy == .uniqueReversibleReverse,
    "Reverse authorization must carry the unique reversible policy"
  )
  let reversibleSpace = behaviorEngine.processKey(
    " ",
    sessionId: reversibleSession,
    mode: .traditionalRomanized
  )
  require(reversibleSpace.committedText == "hajur ", "Passive Space must commit a proven unique reverse mapping")

  let ambiguous = type(
    "नेपाल",
    engine: behaviorEngine,
    sessionId: "probe-ambiguous-autocommit-\(UUID().uuidString)",
    mode: .traditionalRomanized
  )
  require(ambiguous.autoCommitCandidate == nil, "Ambiguous reverse aliases nepal/nepaal must require explicit acceptance")

  let nameOnly = type(
    "तामाङ",
    engine: behaviorEngine,
    sessionId: "probe-name-autocommit-\(UUID().uuidString)",
    mode: .traditionalRomanized
  )
  require(nameOnly.autoCommitCandidate == nil, "A name-only reverse mapping must require explicit acceptance")

  let romanizedRaw = type(
    "lekh",
    engine: behaviorEngine,
    sessionId: "probe-romanized-raw-autocommit-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  let traditionalRaw = type(
    "लेख",
    engine: behaviorEngine,
    sessionId: "probe-traditional-raw-autocommit-\(UUID().uuidString)",
    mode: .traditionalTraditional
  )
  require(romanizedRaw.autoCommitCandidate == nil, "Romanized to Romanized Space must remain raw")
  require(traditionalRaw.autoCommitCandidate == nil, "Traditional to Traditional Space must remain raw")
}

private func assertEscapeCancelsAndBackspaceEditsComposition() {
  let engine = behaviorEngine
  let sessionId = "probe-editing-\(UUID().uuidString)"

  _ = type("mero", engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  let edited = engine.processKey(
    "\u{7f}",
    sessionId: sessionId,
    mode: .romanizedTraditional
  )
  require(engine.rawBuffer(sessionId: sessionId) == "mer", "Backspace must edit the raw source composition")
  require(edited.markedText != nil, "Backspace must refresh the marked target preview")
  require(engine.hasComposition(sessionId: sessionId), "Backspace must keep remaining composition")

  let cancelled = engine.processKey(
    "\u{1b}",
    sessionId: sessionId,
    mode: .romanizedTraditional
  )
  require(cancelled.shouldCancel, "Escape must cancel composition")
  require(!engine.hasComposition(sessionId: sessionId), "Escape must reset composition")
}

private func assertPersonalizationResetClearsLiveRankingState() {
  let engine = behaviorEngine
  let raw = "lekhresettoken"
  let learned = "परीक्षण"
  let sessionId = "probe-personalization-reset-\(UUID().uuidString)"

  engine.observeCommit(
    sessionId: sessionId,
    rawInput: raw,
    chosenOutput: learned,
    allowPersonalization: true
  )
  engine.observeCommit(
    sessionId: sessionId,
    rawInput: raw,
    chosenOutput: learned,
    allowPersonalization: true
  )
  let learnedDecision = type(raw, engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  require(
    learnedDecision.candidates.first == learned,
    "Repeated explicit choices must become a current-token personalization candidate"
  )
  engine.resetSession(sessionId)

  setenv("LEKH_TEST_PERSONALIZATION_RESET_EPOCH", "2", 1)
  CFNotificationCenterPostNotification(
    CFNotificationCenterGetDarwinNotifyCenter(),
    CFNotificationName("com.lekh.inputmethod.preferences.changed" as CFString),
    nil,
    nil,
    true
  )
  RunLoop.current.run(until: Date().addingTimeInterval(0.05))

  let resetDecision = type(
    raw,
    engine: engine,
    sessionId: "probe-personalization-after-reset-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(
    !resetDecision.candidates.contains(learned),
    "A companion reset epoch must immediately evict learned candidates from live IMK memory"
  )
}

private func assertRepositoryCuratedTokenQualityContract() {
  // These are repository-curated regression expectations shared with the
  // primary engine. They are a deterministic compatibility contract, not a
  // substitute for the still-missing native-speaker production holdout.
  let cases: [(input: String, expectedTop1: String)] = [
    ("k", "के"), ("kaha", "कहाँ"), ("kahaa", "कहाँ"), ("kahile", "कहिले"),
    ("kina", "किन"), ("kasari", "कसरी"), ("mero", "मेरो"), ("malai", "मलाई"),
    ("timi", "तिमी"), ("timro", "तिम्रो"), ("tapai", "तपाईं"), ("hami", "हामी"),
    ("hamro", "हाम्रो"), ("naam", "नाम"), ("cha", "छ"), ("chha", "छ"),
    ("xa", "छ"), ("xaina", "छैन"), ("huncha", "हुन्छ"), ("parxa", "पर्छ"),
    ("garne", "गर्ने"), ("garnu", "गर्नु"), ("gardai", "गर्दै"), ("garchu", "गर्छु"),
    ("bhayo", "भयो"), ("aaja", "आज"), ("bholi", "भोलि"), ("hijo", "हिजो"),
    ("pachi", "पछि"), ("ghar", "घर"), ("aaune", "आउने"), ("aaudai", "आउँदै"),
    ("khana", "खाना"), ("lai", "लाई"), ("le", "ले"), ("ko", "को"),
    ("ramro", "राम्रो"), ("sanchai", "सञ्चै"), ("dhanyabad", "धन्यवाद"),
    ("namaste", "नमस्ते"), ("bhetumla", "भेटौँला"), ("pathaideu", "पठाइदेऊ"),
    ("dinu", "दिनु"), ("nepali", "नेपाली"), ("nepal", "नेपाल"),
    ("kathmandu", "काठमाडौं"), ("maya", "माया"), ("thik", "ठीक"),
    ("kaam", "काम"), ("kura", "कुरा"), ("ani", "अनि"), ("tara", "तर"),
    ("aba", "अब"), ("ahile", "अहिले"), ("manchhe", "मान्छे"),
    ("dherai", "धेरै"), ("swasthya", "स्वास्थ्य")
  ]

  var top1Hits = 0
  for row in cases {
    let decision = type(
      row.input,
      engine: behaviorEngine,
      sessionId: "probe-quality-\(row.input)-\(UUID().uuidString)",
      mode: .romanizedTraditional
    )
    if decision.candidates.first == row.expectedTop1 {
      top1Hits += 1
    }
    require(
      decision.candidates.first == row.expectedTop1,
      "Curated token top-1 mismatch for \(row.input): expected=\(row.expectedTop1) observed=\(decision.candidates)"
    )
    require(
      decision.markedText == row.expectedTop1,
      "Marked preview must match the safe current-token top-1 for \(row.input)"
    )
    require(
      decision.candidates.count <= 8,
      "Visible candidates must honor the eight-row engine contract for \(row.input)"
    )
    require(
      decision.candidates.allSatisfy { candidate in
        candidate.unicodeScalars.allSatisfy { !CharacterSet.whitespacesAndNewlines.contains($0) }
      },
      "A single Romanized token must never produce a whitespace-expanding candidate for \(row.input)"
    )
  }

  let ambiguous = type(
    "pani",
    engine: behaviorEngine,
    sessionId: "probe-quality-ambiguous-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(ambiguous.candidates.prefix(2) == ["पनि", "पानी"], "pani must retain both legitimate token readings")

  let prefix = type(
    "lekh",
    engine: behaviorEngine,
    sessionId: "probe-quality-prefix-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(prefix.candidates.first == "लेख", "A completion must not displace the typed current-token interpretation")
  require(prefix.inlineSuggestion?.acceptedText == "लेखहरू", "The trusted suffix ghost must remain available explicitly")
  require(
    prefix.candidates.allSatisfy { !$0.contains(" ") },
    "Prefix completions must remain token-only"
  )

  print(
    "native-repository-curated-token-top1=\(top1Hits)/\(cases.count) " +
      "phrase-expansion-rate=0 ambiguous-pani-top2=passed"
  )
}

private func assertSharedTokenPackNativeConformance() {
  struct Pack: Decodable {
    struct Row: Decodable {
      struct Output: Decodable { let text: String }
      let input: String
      let outputs: [Output]
    }
    let rows: [Row]
  }

  guard let data = try? Data(contentsOf: sourceCanonicalTokenPack),
        let pack = try? JSONDecoder().decode(Pack.self, from: data) else {
    require(false, "Shared canonical token pack must decode in the native conformance probe")
    return
  }
  var conforming = 0
  for row in pack.rows {
    guard let expected = row.outputs.first?.text else { continue }
    let first = type(
      row.input,
      engine: behaviorEngine,
      sessionId: "probe-shared-pack-a-\(row.input)-\(UUID().uuidString)",
      mode: .romanizedTraditional
    )
    let second = type(
      row.input,
      engine: behaviorEngine,
      sessionId: "probe-shared-pack-b-\(row.input)-\(UUID().uuidString)",
      mode: .romanizedTraditional
    )
    require(
      first.candidates.first == expected,
      "Native engine diverged from shared pack for \(row.input): \(first.candidates)"
    )
    require(
      first.candidates == second.candidates,
      "Candidate ordering must be stable across sessions for \(row.input)"
    )
    require(
      first.candidates.allSatisfy { candidate in
        candidate.unicodeScalars.allSatisfy { !CharacterSet.whitespacesAndNewlines.contains($0) }
      },
      "Shared single-token input expanded to a phrase for \(row.input)"
    )
    conforming += 1
  }

  let uppercase = type(
    "NAMASTE",
    engine: behaviorEngine,
    sessionId: "probe-normalization-uppercase-\(UUID().uuidString)",
    mode: .romanizedTraditional
  )
  require(uppercase.candidates.first == "नमस्ते", "Romanized normalization must be case-stable")
  print("native-shared-token-pack-conformance=\(conforming)/\(pack.rows.count) stable-order=passed")
}

private func assertCandidateInteractionStartsPassiveAndPagesSafely() {
  let candidates = (1...18).map { "candidate-\($0)" }
  let controller = LekhCandidateController()
  controller.updateCandidates(candidates, rawBuffer: "candidate", modeLabel: "Romanized → Romanized")

  require(controller.currentState().selectedIndex == nil, "Fresh candidates must not invent a selected row")
  require(controller.selectedCandidate() == nil, "Passive candidate state must not expose an accepted candidate")
  require(controller.moveSelection(delta: 1) == "candidate-1", "Down must explicitly enter browsing at the first row")
  require(controller.currentState().selectedIndex == 0, "Down must select the first row")
  require(controller.moveSelection(delta: -1) == "candidate-18", "Up must wrap without trapping navigation")
  require(controller.movePage(delta: -1, pageSize: 8) == "candidate-10", "Page Up must preserve the row offset when possible")
  require(controller.indexForShortcut(3, pageSize: 8) == 10, "Shortcut indices must resolve inside the visible page")
  controller.clearSelection()
  require(controller.currentState().selectedIndex == nil, "Dismissal must restore the passive state")
}

private func assertDeterministicHotPathP99() {
  var samples: [UInt64] = []
  samples.reserveCapacity(2_000)
  let tokens = ["swasthya", "mero", "karyalaya", "prashasan", "nagarikta"]
  for iteration in 0..<50 {
    let sessionId = "probe-latency-\(iteration)"
    for token in tokens {
      for character in token {
        let started = DispatchTime.now().uptimeNanoseconds
        _ = behaviorEngine.processKey(
          String(character),
          sessionId: sessionId,
          mode: .romanizedTraditional
        )
        samples.append(DispatchTime.now().uptimeNanoseconds - started)
      }
      behaviorEngine.resetSession(sessionId)
    }
  }
  let sorted = samples.sorted()
  let p99 = sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * 0.99))]
  require(p99 < 5_000_000, "Deterministic per-key p99 must stay below 5 ms; observed \(p99) ns")
  print("native-deterministic-p99-ns=\(p99)")
}

assertRomanizedCompositionShowsSafeTargetPreviewUntilCommit()
assertRomanizedRomanizedModeDoesNotConvertMarkedTextToDevanagari()
assertProtectedLatinTokensStayByteExactAndBypassNeuralTail()
assertPrimaryModeEmitsSafeTargetScriptGhostCompletion()
assertTokenCompletionArtifactIsVerifiedAndExplicitOnly()
assertTraditionalRomanizedModeShowsRomanizedTargetPreview()
assertPassiveSpaceAutoCommitPolicyIsEvidenceBounded()
assertEscapeCancelsAndBackspaceEditsComposition()
assertPersonalizationResetClearsLiveRankingState()
assertRepositoryCuratedTokenQualityContract()
assertSharedTokenPackNativeConformance()
assertCandidateInteractionStartsPassiveAndPagesSafely()
assertDeterministicHotPathP99()
dumpCandidateDiagnosticsIfRequested()
benchmarkNeuralServiceIfRequested()
print("native-typing-behavior=passed")

for suffix in ["", "-wal", "-shm"] {
  try? FileManager.default.removeItem(atPath: testPersonalizationDatabase.path + suffix)
}
