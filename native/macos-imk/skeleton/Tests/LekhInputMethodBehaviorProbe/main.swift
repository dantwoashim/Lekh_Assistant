import AppKit
import Foundation
import InputMethodKit
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

private final class ProbeTextInputClient: NSObject, IMKTextInput {
  private(set) var text = ""
  private(set) var markedTextMutations: [String] = []
  private(set) var committedTextMutations: [String] = []
  private var selection = NSRange(location: 0, length: 0)
  private var activeMarkedRange = NSRange(location: NSNotFound, length: NSNotFound)

  func insertText(_ value: Any!, replacementRange: NSRange) {
    let inserted = Self.string(from: value)
    committedTextMutations.append(inserted)
    let target = resolvedRange(replacementRange)
    replace(target, with: inserted)
    activeMarkedRange = NSRange(location: NSNotFound, length: NSNotFound)
  }

  func setMarkedText(_ value: Any!, selectionRange: NSRange, replacementRange: NSRange) {
    let inserted = Self.string(from: value)
    markedTextMutations.append(inserted)
    let target = resolvedRange(replacementRange)
    let start = target.location
    replace(target, with: inserted)
    activeMarkedRange = inserted.isEmpty
      ? NSRange(location: NSNotFound, length: NSNotFound)
      : NSRange(location: start, length: inserted.utf16.count)
    selection = NSRange(
      location: start + min(selectionRange.location, inserted.utf16.count),
      length: min(selectionRange.length, max(0, inserted.utf16.count - selectionRange.location))
    )
  }

  func selectedRange() -> NSRange { selection }
  func markedRange() -> NSRange { activeMarkedRange }

  func setHostSelection(_ range: NSRange) {
    selection = range
  }

  func attributedSubstring(from range: NSRange) -> NSAttributedString! {
    guard let swiftRange = Range(range, in: text) else { return nil }
    return NSAttributedString(string: String(text[swiftRange]))
  }

  func length() -> Int { text.utf16.count }

  func characterIndex(
    for point: NSPoint,
    tracking mappingMode: IMKLocationToOffsetMappingMode,
    inMarkedRange: UnsafeMutablePointer<ObjCBool>!
  ) -> Int {
    inMarkedRange?.pointee = false
    return NSNotFound
  }

  func attributes(
    forCharacterIndex index: Int,
    lineHeightRectangle lineRect: UnsafeMutablePointer<NSRect>!
  ) -> [AnyHashable: Any]! {
    lineRect?.pointee = NSRect(x: 20, y: 20, width: 1, height: 18)
    return [:]
  }

  func validAttributesForMarkedText() -> [Any]! { [] }
  func overrideKeyboard(withKeyboardNamed keyboardUniqueName: String!) {}
  func selectMode(_ modeIdentifier: String!) {}
  func supportsUnicode() -> Bool { true }
  func bundleIdentifier() -> String! { "com.lekh.behavior-probe" }
  func windowLevel() -> CGWindowLevel { 0 }
  func supportsProperty(_ property: TSMDocumentPropertyTag) -> Bool { true }
  func uniqueClientIdentifierString() -> String! { "probe-\(ObjectIdentifier(self).hashValue)" }

  func string(from range: NSRange, actualRange: NSRangePointer!) -> String! {
    guard let swiftRange = Range(range, in: text) else { return nil }
    actualRange?.pointee = range
    return String(text[swiftRange])
  }

  func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer!) -> NSRect {
    actualRange?.pointee = range
    return NSRect(x: 20, y: 20, width: 1, height: 18)
  }

  private static func string(from value: Any?) -> String {
    if let attributed = value as? NSAttributedString { return attributed.string }
    return value as? String ?? ""
  }

  private func resolvedRange(_ requested: NSRange) -> NSRange {
    if requested.location != NSNotFound,
       requested.location <= text.utf16.count,
       requested.length <= text.utf16.count - requested.location {
      return requested
    }
    if activeMarkedRange.location != NSNotFound {
      return activeMarkedRange
    }
    return selection
  }

  private func replace(_ range: NSRange, with inserted: String) {
    guard let swiftRange = Range(range, in: text) else { return }
    text.replaceSubrange(swiftRange, with: inserted)
    selection = NSRange(location: range.location + inserted.utf16.count, length: 0)
  }
}

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
  let initializationStarted = DispatchTime.now().uptimeNanoseconds
  let service = LekhNeuralCandidateService(bundle: bundle)
  let initializationMilliseconds = Double(
    DispatchTime.now().uptimeNanoseconds - initializationStarted
  ) / 1_000_000
  require(
    initializationMilliseconds < 10,
    "Neural service construction must not verify or load Core ML synchronously; observed=\(initializationMilliseconds) ms"
  )
  let loadingDeadline = Date().addingTimeInterval(15)
  while service.status == "async-coreml-tail-loading", Date() < loadingDeadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.005))
  }
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
      "serviceInitializationMs": initializationMilliseconds,
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

  let allCaps = type(
    "LEKH",
    engine: behaviorEngine,
    sessionId: "probe-completion-r2r-all-caps-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  require(allCaps.markedText == "LEKH", "R→R marked text must preserve ALL CAPS input")
  require(
    allCaps.candidates.contains("LEKHHARU") &&
      !allCaps.candidates.contains("lekh") &&
      !allCaps.candidates.contains("lekhharu"),
    "ALL CAPS completion candidates must extend, not rewrite, user casing; observed=\(allCaps.candidates)"
  )
  require(
    allCaps.inlineSuggestion == LekhInlineSuggestion(suffix: "HARU", acceptedText: "LEKHHARU"),
    "ALL CAPS R→R input must receive a case-preserving suffix-only ghost"
  )
  require(allCaps.autoCommitCandidate == nil, "A case-preserving completion must remain explicit-only")

  let leadingCapital = type(
    "Lekh",
    engine: behaviorEngine,
    sessionId: "probe-completion-r2r-leading-capital-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  require(
    leadingCapital.inlineSuggestion == LekhInlineSuggestion(suffix: "haru", acceptedText: "Lekhharu"),
    "Leading-capital R→R input must receive a matching case-preserving ghost"
  )
  require(
    !behaviorEngine.mayPersonalizeExplicitChoice(
      rawInput: "Lekh",
      chosenOutput: "Lekhharu",
      mode: .romanizedRomanized
    ),
    "Accepting a cased completion must not teach it as an exact-token mapping"
  )

  let irregularCase = type(
    "LeKh",
    engine: behaviorEngine,
    sessionId: "probe-completion-r2r-irregular-case-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  require(
    irregularCase.inlineSuggestion == nil && !irregularCase.candidates.contains("lekhharu"),
    "Irregular mixed case must fail closed instead of offering a case-changing completion"
  )
  require(
    !irregularCase.candidates.contains("lekh"),
    "Irregular mixed case must also reject a normalized exact-runtime candidate"
  )

  let allCapsOOV = type(
    "XYZQ",
    engine: behaviorEngine,
    sessionId: "probe-completion-r2r-all-caps-oov-\(UUID().uuidString)",
    mode: .romanizedRomanized
  )
  require(
    allCapsOOV.markedText == "XYZQ" && !allCapsOOV.candidates.contains("xyzq"),
    "R→R deterministic fallback must not expose a lowercased OOV candidate; observed=\(allCapsOOV.candidates)"
  )

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

private func assertCompletionAcceptanceCannotPoisonExactPersonalization() {
  let engine = LekhNativeEngineClient()
  let completion = "लेखहरू"
  require(
    !engine.mayPersonalizeExplicitChoice(
      rawInput: "lekh",
      chosenOutput: completion,
      mode: .romanizedTraditional
    ),
    "A verified suffix completion must not become an exact-token personalization mapping"
  )
  require(
    engine.mayPersonalizeExplicitChoice(
      rawInput: "pani",
      chosenOutput: "पानी",
      mode: .romanizedTraditional
    ),
    "A legitimate alternate reading must remain eligible for explicit-choice personalization"
  )

  // Simulate a legacy database row created before completion provenance was
  // separated. Two observations make it eligible under the user-lexicon
  // frequency threshold; the live engine must still filter it without I/O.
  for index in 0..<2 {
    engine.observeCommit(
      sessionId: "legacy-completion-\(index)",
      rawInput: "lekh",
      chosenOutput: completion,
      allowPersonalization: true
    )
  }
  let decision = type(
    "lekh",
    engine: engine,
    sessionId: "completion-personalization-regression",
    mode: .romanizedTraditional
  )
  require(decision.markedText == "लेख", "Solid marked text must remain the exact typed-token interpretation")
  require(decision.candidates.first == "लेख", "A legacy learned completion must not displace the typed token")
  require(
    decision.inlineSuggestion?.suffix == "हरू" && decision.inlineSuggestion?.acceptedText == completion,
    "The completion must remain an optional suffix-only ghost after legacy personalization"
  )

  let romanizedEngine = LekhNativeEngineClient()
  require(
    !romanizedEngine.mayPersonalizeExplicitChoice(
      rawInput: "LEKH",
      chosenOutput: "LEKH",
      mode: .romanizedRomanized
    ),
    "A case-only R→R choice must never become a normalized spelling mapping"
  )
  // Exercise the public observation API directly as defense in depth. Even a
  // caller that mistakenly requests learning must not persist casing-only data.
  for index in 0..<2 {
    romanizedEngine.observeCommit(
      sessionId: "case-only-r2r-\(index)",
      rawInput: "LEKH",
      chosenOutput: "LEKH",
      allowPersonalization: true
    )
  }
  let lowercaseAfterCaseOnly = type(
    "lekh",
    engine: romanizedEngine,
    sessionId: "case-only-r2r-lowercase",
    mode: .romanizedRomanized
  )
  require(
    !lowercaseAfterCaseOnly.candidates.contains("LEKH"),
    "A casing-only observation must not later rewrite lowercase input; observed=\(lowercaseAfterCaseOnly.candidates)"
  )

  // Simulate the legacy cased completion variant independently of the normal
  // acceptance guard. Provenance matching must ignore presentation casing.
  for index in 0..<2 {
    romanizedEngine.observeCommit(
      sessionId: "legacy-cased-r2r-completion-\(index)",
      rawInput: "lekh",
      chosenOutput: "Lekhharu",
      allowPersonalization: true
    )
  }
  let afterLegacyCasedCompletion = type(
    "lekh",
    engine: romanizedEngine,
    sessionId: "legacy-cased-r2r-completion-check",
    mode: .romanizedRomanized
  )
  require(
    !afterLegacyCasedCompletion.candidates.contains("Lekhharu") &&
      afterLegacyCasedCompletion.inlineSuggestion?.acceptedText == "lekhharu",
    "A cased legacy completion must remain suffix-only and never displace the typed token; observed=\(afterLegacyCasedCompletion.candidates)"
  )
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

private func assertCompositionOwnershipAndHostPassThroughSafety() {
  let previousInlineComposition = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]
  setenv("LEKH_IMK_INLINE_COMPOSITION", "1", 1)
  defer {
    if let previousInlineComposition {
      setenv("LEKH_IMK_INLINE_COMPOSITION", previousInlineComposition, 1)
    } else {
      unsetenv("LEKH_IMK_INLINE_COMPOSITION")
    }
  }

  let ownerEngine = LekhNativeEngineClient()
  let ownerController = LekhInputController(engineClient: ownerEngine)
  let originalClient = ProbeTextInputClient()
  let newlyFocusedClient = ProbeTextInputClient()

  require(
    ownerController.inputText("ab", client: originalClient),
    "The controller probe must establish an inline composition"
  )
  let originalMutationCount = originalClient.markedTextMutations.count
  let delayedBackspaceHandled = ownerController.didCommand(
    by: #selector(NSResponder.deleteBackward(_:)),
    client: newlyFocusedClient
  )
  require(!delayedBackspaceHandled, "A command from a different client must pass through")
  require(
    newlyFocusedClient.markedTextMutations.isEmpty && newlyFocusedClient.committedTextMutations.isEmpty,
    "A delayed Backspace must never rebind an old composition into the newly focused client"
  )
  require(
    originalClient.markedTextMutations.count == originalMutationCount,
    "A client transition must not mutate the old document through a delayed command"
  )
  require(
    (ownerController.composedString(newlyFocusedClient) as? String) == "",
    "A client transition must clear the abandoned in-memory composition"
  )

  let shortcutEngine = LekhNativeEngineClient()
  let shortcutController = LekhInputController(engineClient: shortcutEngine)
  let shortcutClient = ProbeTextInputClient()
  require(
    shortcutController.inputText("ab", client: shortcutClient),
    "The shortcut probe must establish an inline composition"
  )
  let shortcutHandled = shortcutController.inputText(
    "c",
    key: 8,
    modifiers: Int(NSEvent.ModifierFlags.command.rawValue),
    client: shortcutClient
  )
  require(!shortcutHandled, "A Command shortcut must remain owned by the host")
  require(
    shortcutClient.committedTextMutations.last == "ab",
    "A Command shortcut must first finalize exactly the user's raw composition"
  )
  require(
    (shortcutController.composedString(shortcutClient) as? String) == "",
    "A host shortcut must not leave a stale engine buffer behind"
  )

  let safeRange = LekhFailOpenReplacementPolicy.replacementRange(
    rawUTF16Length: 3,
    selection: NSRange(location: 7, length: 0)
  )
  require(
    safeRange == NSRange(location: 4, length: 3),
    "Fail-open replacement may target only the raw token immediately before a collapsed caret"
  )
  require(
    LekhFailOpenReplacementPolicy.replacementRange(
      rawUTF16Length: 3,
      selection: NSRange(location: 7, length: 2)
    ) == nil,
    "Fail-open replacement must not erase a live host selection"
  )
  require(
    LekhFailOpenReplacementPolicy.replacementRange(
      rawUTF16Length: 3,
      selection: NSRange(location: NSNotFound, length: NSNotFound)
    ) == nil,
    "A host without document-range access must fail open without replacement"
  )

  setenv("LEKH_IMK_INLINE_COMPOSITION", "0", 1)
  let failOpenController = LekhInputController(engineClient: LekhNativeEngineClient())
  let failOpenClient = ProbeTextInputClient()
  require(
    failOpenController.inputText("ab", client: failOpenClient),
    "The unmarked fallback must insert raw typing immediately"
  )
  failOpenClient.setHostSelection(NSRange(location: 0, length: 1))
  let unsafeDelimiterHandled = failOpenController.inputText(
    " ",
    key: 49,
    modifiers: 0,
    client: failOpenClient
  )
  require(
    !unsafeDelimiterHandled,
    "A fail-open delimiter must return to the host when selection-safe replacement is impossible"
  )
  require(
    failOpenClient.text == "ab",
    "Fail-open conversion must not erase or replace a host-owned selection"
  )
  require(
    failOpenController.candidates(failOpenClient).isEmpty,
    "An ended fail-open composition must not leave stale candidates actionable"
  )
  ownerController.resetSession()
  shortcutController.resetSession()
  failOpenController.resetSession()
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

private func assertEveryControllerCallbackFailsOpenUnderSecureInput() {
  typealias Callback = (LekhInputController, ProbeTextInputClient) -> Bool
  let keyEvent: () -> NSEvent = {
    NSEvent.keyEvent(
      with: .keyDown,
      location: .zero,
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      characters: "x",
      charactersIgnoringModifiers: "x",
      isARepeat: false,
      keyCode: 7
    )!
  }
  let callbacks: [(name: String, invoke: Callback)] = [
    ("inputText", { controller, client in
      controller.inputText("x", client: client)
    }),
    ("inputTextKey", { controller, client in
      controller.inputText("x", key: 7, modifiers: 0, client: client)
    }),
    ("handle", { controller, client in
      controller.handle(keyEvent(), client: client)
    }),
    ("didCommand", { controller, client in
      controller.didCommand(by: #selector(NSResponder.deleteBackward(_:)), client: client)
    })
  ]

  for callback in callbacks {
    let directClient = ProbeTextInputClient()
    let directController = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      secureInputActive: { true }
    )
    require(
      !callback.invoke(directController, directClient),
      "\(callback.name) must pass through when secure input is already active"
    )
    require(
      directClient.markedTextMutations.isEmpty && directClient.committedTextMutations.isEmpty,
      "\(callback.name) must not mutate a secure client without prior composition"
    )
    require(
      directController.candidates(directClient).isEmpty &&
        (directController.composedString(directClient) as? String) == "" &&
        directController.originalString(directClient).string.isEmpty,
      "\(callback.name) must expose no secure composition or candidates"
    )

    var secure = false
    let transitionClient = ProbeTextInputClient()
    let transitionController = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      secureInputActive: { secure }
    )
    require(
      transitionController.inputText("ab", client: transitionClient),
      "\(callback.name) transition probe must establish nonsecure composition"
    )
    let markedMutationCount = transitionClient.markedTextMutations.count
    secure = true
    require(
      !callback.invoke(transitionController, transitionClient),
      "\(callback.name) must pass the first secure callback through"
    )
    require(
      transitionClient.markedTextMutations.count == markedMutationCount + 1 &&
        transitionClient.markedTextMutations.last == "",
      "\(callback.name) must clear exactly one pre-existing marked range"
    )
    require(
      transitionClient.committedTextMutations.isEmpty &&
        transitionController.candidates(transitionClient).isEmpty &&
        (transitionController.composedString(transitionClient) as? String) == "" &&
        transitionController.originalString(transitionClient).string.isEmpty,
      "\(callback.name) secure transition must clear local state without committing or ranking"
    )
    let afterClearMutationCount = transitionClient.markedTextMutations.count
    require(
      !callback.invoke(transitionController, transitionClient) &&
        transitionClient.markedTextMutations.count == afterClearMutationCount,
      "\(callback.name) repeated secure callbacks must remain mutation-free"
    )
  }

  RunLoop.current.run(until: Date().addingTimeInterval(0.25))
  print("native-secure-controller-callbacks=4/4 fail-open")
}

private func assertInputTextBatchesAndOptionLayerAreLossless() {
  let modeKey = LekhNativePreferences.Keys.nativeTypingMode
  let previousMode = UserDefaults.standard.object(forKey: modeKey)
  defer {
    if let previousMode {
      UserDefaults.standard.set(previousMode, forKey: modeKey)
    } else {
      UserDefaults.standard.removeObject(forKey: modeKey)
    }
    UserDefaults.standard.synchronize()
  }

  UserDefaults.standard.set(LekhNativeTypingMode.romanizedTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  let batchController = LekhInputController(engineClient: LekhNativeEngineClient())
  let batchClient = ProbeTextInputClient()
  require(
    !batchController.inputText("ab🙂", client: batchClient),
    "A mixed multi-grapheme callback must pass through atomically"
  )
  require(
    batchClient.markedTextMutations.isEmpty && batchClient.committedTextMutations.isEmpty &&
      (batchController.composedString(batchClient) as? String) == "",
    "An unhandled batch must not consume a prefix or mutate composition before pass-through"
  )
  require(
    batchController.inputText("ab", client: batchClient),
    "A composition-safe multi-grapheme callback must remain supported"
  )
  let markedBeforeMixedBatch = batchClient.markedTextMutations.count
  require(
    !batchController.inputText("c🙂", client: batchClient),
    "A mixed batch following composition must return the entire new callback to the host"
  )
  require(
    batchClient.markedTextMutations.count == markedBeforeMixedBatch &&
      batchClient.committedTextMutations.last == "ab" &&
      (batchController.composedString(batchClient) as? String) == "",
    "A mixed batch must finalize only the prior raw composition and consume none of the new callback"
  )

  UserDefaults.standard.set(LekhNativeTypingMode.traditionalTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  let optionController = LekhInputController(engineClient: LekhNativeEngineClient())
  let optionClient = ProbeTextInputClient()
  let optionFlags = Int(NSEvent.ModifierFlags.option.rawValue)
  require(
    !optionController.inputText("å", key: 0, modifiers: optionFlags, client: optionClient),
    "An unmapped Option shortcut must remain owned by the host"
  )
  require(
    optionClient.markedTextMutations.isEmpty && optionClient.committedTextMutations.isEmpty &&
      (optionController.composedString(optionClient) as? String) == "",
    "An unmapped Option shortcut must not mutate Lekh composition"
  )
  require(
    optionController.inputText("˙", key: 4, modifiers: optionFlags, client: optionClient),
    "A documented traditional Option-H mapping must remain available"
  )
  require(
    (optionController.composedString(optionClient) as? String) == "्",
    "Option-H must produce exactly the explicit halanta mapping"
  )
  batchController.resetSession()
  optionController.resetSession()
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
assertCompletionAcceptanceCannotPoisonExactPersonalization()
assertTraditionalRomanizedModeShowsRomanizedTargetPreview()
assertPassiveSpaceAutoCommitPolicyIsEvidenceBounded()
assertEscapeCancelsAndBackspaceEditsComposition()
assertCompositionOwnershipAndHostPassThroughSafety()
assertPersonalizationResetClearsLiveRankingState()
assertRepositoryCuratedTokenQualityContract()
assertSharedTokenPackNativeConformance()
assertCandidateInteractionStartsPassiveAndPagesSafely()
assertEveryControllerCallbackFailsOpenUnderSecureInput()
assertInputTextBatchesAndOptionLayerAreLossless()
assertDeterministicHotPathP99()
dumpCandidateDiagnosticsIfRequested()
benchmarkNeuralServiceIfRequested()
print("native-typing-behavior=passed")

for suffix in ["", "-wal", "-shm"] {
  try? FileManager.default.removeItem(atPath: testPersonalizationDatabase.path + suffix)
}
