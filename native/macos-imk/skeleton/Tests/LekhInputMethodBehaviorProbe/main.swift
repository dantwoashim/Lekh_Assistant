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

/// Intentionally ignores cancellation when a completion is delivered. This
/// models Core ML's best-effort cancellation semantics and proves that the
/// controller's own secure/session/client guards reject a result that escapes
/// after the corresponding lifecycle boundary.
private final class DelayedNeuralCandidateService: LekhNeuralCandidateServing {
  private struct Request {
    let rawInput: String
    let secureInputActive: Bool
    let completion: ([String]) -> Void
  }

  private let lock = NSLock()
  private var requests: [Request] = []
  private var cancellations = 0

  var requestCount: Int {
    lock.lock()
    let count = requests.count
    lock.unlock()
    return count
  }

  var cancelCount: Int {
    lock.lock()
    let count = cancellations
    lock.unlock()
    return count
  }

  func rawInput(at index: Int) -> String? {
    lock.lock()
    let input = requests.indices.contains(index) ? requests[index].rawInput : nil
    lock.unlock()
    return input
  }

  func secureInputWasActive(at index: Int) -> Bool? {
    lock.lock()
    let active = requests.indices.contains(index) ? requests[index].secureInputActive : nil
    lock.unlock()
    return active
  }

  func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    completion: @escaping ([String]) -> Void
  ) {
    lock.lock()
    requests.append(Request(
      rawInput: rawInput,
      secureInputActive: secureInputActive,
      completion: completion
    ))
    lock.unlock()
  }

  func cancelPending() {
    lock.lock()
    cancellations += 1
    lock.unlock()
  }

  func completeRequest(at index: Int, with candidates: [String]) {
    lock.lock()
    let completion = requests.indices.contains(index) ? requests[index].completion : nil
    lock.unlock()
    completion?(candidates)
  }
}

/// Keeps controller-boundary tests focused on IMK ownership and pass-through
/// semantics without scheduling hundreds of AppKit surface renders from a
/// manually constructed controller that has no backing IMKServer client.
private final class CompositionBoundProbeEngineClient: LekhEngineClient {
  private var buffer = ""

  func prime(_ rawBuffer: String) {
    buffer = rawBuffer
  }

  func processKey(_ key: String, sessionId: String, mode: LekhNativeTypingMode) -> LekhInputDecision {
    guard !LekhActiveCompositionWorkBound.wouldOverflow(
      current: buffer,
      appending: key
    ) else {
      return .passThrough
    }
    buffer += key
    return LekhInputDecision(
      handled: true,
      markedText: buffer,
      committedText: nil,
      candidates: [],
      shouldCancel: false,
      shouldPassThrough: false
    )
  }

  func normalizedPunctuation(_ key: String, mode: LekhNativeTypingMode) -> String { key }
  func hasComposition(sessionId: String) -> Bool { !buffer.isEmpty }
  func rawBuffer(sessionId: String) -> String { buffer }

  func observeCommit(
    sessionId: String,
    rawInput: String,
    chosenOutput: String,
    allowPersonalization: Bool
  ) {}

  func mayPersonalizeExplicitChoice(
    rawInput: String,
    chosenOutput: String,
    mode: LekhNativeTypingMode
  ) -> Bool { false }

  func forgetCandidate(sessionId: String, chosenOutput: String) {}
  func resetSession(_ sessionId: String) { buffer = "" }
  func endSession(_ sessionId: String) { buffer = "" }
  func diagnosticsSummary() -> String { "composition-bound-probe" }
  func securityWarning() -> String? { nil }
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
  let production = ProcessInfo.processInfo.environment["LEKH_NEURAL_BENCH_PRODUCTION"] == "1"
  guard let runNonce = ProcessInfo.processInfo.environment["LEKH_NEURAL_BENCH_NONCE"],
        !runNonce.isEmpty else {
    require(false, "Packaged neural benchmark requires a fresh run nonce")
    return
  }
  let placementCapture =
    ProcessInfo.processInfo.environment["LEKH_NEURAL_PLACEMENT_CAPTURE"] == "1"
  if placementCapture {
    print(
      "neural-placement-capture-ready pid=\(ProcessInfo.processInfo.processIdentifier) " +
        "attach Instruments now; inference starts in 20 seconds"
    )
    fflush(stdout)
    Thread.sleep(forTimeInterval: 20)
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
    service.status == (
      production
        ? "production-async-coreml-tail-attested-ready"
        : "experimental-async-coreml-tail-artifact-verified-ready"
    ),
    "Packaged neural service mode does not match the requested benchmark mode; status=\(service.status)"
  )
  var deterministicBypass: [String]?
  service.candidates(for: "dhanyabad", secureInputActive: false) { deterministicBypass = $0 }
  require(
    deterministicBypass == [],
    "Shared deterministic exact tokens must bypass the experimental neural tail"
  )
  var protectedBypass: [String: [String]] = [:]
  for token in ["PostgreSQL", "GitHub", "npm", "SwiftUI", "macOS", "README", "hello"] {
    var candidates: [String]?
    service.candidates(for: token, secureInputActive: false) { candidates = $0 }
    require(candidates == [], "Protected Latin token \(token) must synchronously bypass Core ML")
    protectedBypass[token] = candidates ?? []
  }

  let tokens = ["prashasan", "nagarikta", "mantralaya", "sambidhan", "paryatan"]
  let benchmarkIterations = placementCapture ? 9 : 3
  var samples: [UInt64] = []
  var steadyStateByToken: [String: [Double]] = [:]
  var observed: [String: [String]] = [:]
  for iteration in 0..<benchmarkIterations {
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
  require(p99 < 50, "End-to-end packaged neural service p99 must stay below 50 ms; observed=\(p99) ms")
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
    let operatingSystem = ProcessInfo.processInfo.operatingSystemVersion
    #if arch(arm64)
    let architecture = "arm64"
    #elseif arch(x86_64)
    let architecture = "x86_64"
    #else
    let architecture = "unknown"
    #endif
    let device: [String: Any] = [
      "name": "Mac-\(architecture)-\(operatingSystem.majorVersion)",
      "macOS": "\(operatingSystem.majorVersion).\(operatingSystem.minorVersion).\(operatingSystem.patchVersion)",
      "architecture": architecture,
      "packagedApp": true,
      "secureFieldInferenceCount": 0,
      "p50Ms": p50,
      "p95Ms": p95,
      "p99Ms": p99,
      "artifact": bundlePath,
      "measurementKind": "full-candidate-generation"
    ]
    let report: [String: Any] = [
      "generatedAt": ISO8601DateFormatter().string(from: Date()),
      "suite": "native-neural-service-e2e",
      "status": production ? "passed-production" : "passed-experimental",
      "runNonce": runNonce,
      "bundle": bundlePath,
      "serviceStatus": service.status,
      "serviceInitializationMs": initializationMilliseconds,
      "singleForwardBenchmarkIsConsumerLatency": false,
      "placementCapture": placementCapture,
      "workloadTokens": tokens,
      "benchmarkPasses": benchmarkIterations,
      "warmupPasses": 1,
      "measuredPasses": benchmarkIterations - 1,
      "warmupRequests": tokens.count,
      "steadyStateSamples": steadyState.count,
      "targetP95Ms": 50,
      "performance": ["p50Ms": p50, "p95Ms": p95, "p99Ms": p99],
      "devices": [device],
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
        production
          ? "Production mode proves packaged full-candidate latency and runtime safety; accuracy remains separately evidence-bound."
          : "Experimental mode provides latency evidence only and does not claim production eligibility."
      ]
    ]
    do {
      let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      try FileManager.default.createDirectory(
        at: URL(fileURLWithPath: reportPath).deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: URL(fileURLWithPath: reportPath), options: .atomic)
    } catch {
      require(false, "Packaged neural benchmark could not publish fresh report evidence: \(error)")
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
  let protectedTokens = ["PostgreSQL", "GitHub", "npm", "SwiftUI", "macOS", "README", "hello"]
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
    ["postgresql", "github", "nira", "prab", "mero", "pani", "nepal", "janma miti", "a@b.com", "9800000000"]
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

private func assertPassiveDelimitersRemainRawWithoutExplicitSelection() {
  let forwardSession = "probe-forward-raw-space-\(UUID().uuidString)"
  _ = type(
    "namaste",
    engine: behaviorEngine,
    sessionId: forwardSession,
    mode: .romanizedTraditional
  )
  require(
    behaviorEngine.processKey(" ", sessionId: forwardSession, mode: .romanizedTraditional).committedText == "namaste ",
    "Repository candidate confidence must not authorize Romanized to Nepali Space conversion"
  )

  let reversibleSession = "probe-reversible-raw-space-\(UUID().uuidString)"
  let reversible = type(
    "हजुर",
    engine: behaviorEngine,
    sessionId: reversibleSession,
    mode: .traditionalRomanized
  )
  require(reversible.candidates.contains("hajur"), "Unique reversible word हजुर must remain an explicit candidate")
  let reversibleSpace = behaviorEngine.processKey(
    " ",
    sessionId: reversibleSession,
    mode: .traditionalRomanized
  )
  require(reversibleSpace.committedText == "हजुर ", "Space must keep reverse-mode source text raw without explicit acceptance")

  _ = type(
    "नेपाल",
    engine: behaviorEngine,
    sessionId: "probe-ambiguous-reverse-candidate-\(UUID().uuidString)",
    mode: .traditionalRomanized
  )

  _ = type(
    "तामाङ",
    engine: behaviorEngine,
    sessionId: "probe-name-reverse-candidate-\(UUID().uuidString)",
    mode: .traditionalRomanized
  )

  let romanizedSession = "probe-romanized-raw-space-\(UUID().uuidString)"
  _ = type(
    "lekh",
    engine: behaviorEngine,
    sessionId: romanizedSession,
    mode: .romanizedRomanized
  )
  let traditionalSession = "probe-traditional-raw-space-\(UUID().uuidString)"
  _ = type(
    "लेख",
    engine: behaviorEngine,
    sessionId: traditionalSession,
    mode: .traditionalTraditional
  )
  require(
    behaviorEngine.processKey(" ", sessionId: romanizedSession, mode: .romanizedRomanized).committedText == "lekh ",
    "Romanized to Romanized Space must remain raw"
  )
  require(
    behaviorEngine.processKey(" ", sessionId: traditionalSession, mode: .traditionalTraditional).committedText == "लेख ",
    "Traditional to Traditional Space must remain raw"
  )
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

private func controllerCandidateStrings(
  _ controller: LekhInputController,
  client: ProbeTextInputClient
) -> [String] {
  (controller.candidates(client) ?? []).compactMap { $0 as? String }
}

private func assertDelayedNeuralTailLifecycleSafety() {
  let modeKey = LekhNativePreferences.Keys.nativeTypingMode
  let previousMode = UserDefaults.standard.object(forKey: modeKey)
  let previousInlineComposition = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]
  defer {
    if let previousMode {
      UserDefaults.standard.set(previousMode, forKey: modeKey)
    } else {
      UserDefaults.standard.removeObject(forKey: modeKey)
    }
    if let previousInlineComposition {
      setenv("LEKH_IMK_INLINE_COMPOSITION", previousInlineComposition, 1)
    } else {
      unsetenv("LEKH_IMK_INLINE_COMPOSITION")
    }
    UserDefaults.standard.synchronize()
  }

  UserDefaults.standard.set(LekhNativeTypingMode.romanizedTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  setenv("LEKH_IMK_INLINE_COMPOSITION", "1", 1)

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzx", client: client), "The injectable neural seam must receive an OOV composition")
    require(
      service.requestCount == 1 &&
        service.rawInput(at: 0) == "qzx" &&
        service.secureInputWasActive(at: 0) == false,
      "A normal OOV composition must issue exactly one nonsecure neural-tail request"
    )
    service.completeRequest(at: 0, with: ["न्यूरल"])
    require(
      controllerCandidateStrings(controller, client: client).contains("न्यूरल"),
      "A current delayed neural response must merge only as an explicit candidate tail"
    )
    require(client.committedTextMutations.isEmpty, "Displaying a neural tail must never commit host text")
  }

  do {
    var secure = false
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      secureInputActive: { secure },
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzv", client: client), "The secure-transition probe must establish pending neural work")
    require(service.requestCount == 1, "The secure-transition probe must capture one delayed request")
    let cancellationsBeforeTransition = service.cancelCount
    secure = true
    require(!controller.inputText("x", client: client), "The first secure callback must fail open to the host")
    require(
      service.cancelCount > cancellationsBeforeTransition && service.requestCount == 1,
      "Entering secure input must cancel pending work without issuing secure inference"
    )
    service.completeRequest(at: 0, with: ["सुरक्षित-ढिलो"])
    secure = false
    require(
      !controllerCandidateStrings(controller, client: client).contains("सुरक्षित-ढिलो") &&
        client.committedTextMutations.isEmpty,
      "A completion escaping cancellation during secure input must not survive or commit after secure input ends"
    )
  }

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let originalClient = ProbeTextInputClient()
    let newlyFocusedClient = ProbeTextInputClient()
    require(controller.inputText("qzj", client: originalClient), "The focus-switch probe must establish pending neural work")
    require(controller.inputText("x", client: newlyFocusedClient), "The new client must establish its own raw composition")
    service.completeRequest(at: 0, with: ["गलत-एप"])
    require(
      !controllerCandidateStrings(controller, client: newlyFocusedClient).contains("गलत-एप") &&
        (controller.composedString(newlyFocusedClient) as? String) == "x" &&
        originalClient.committedTextMutations.isEmpty && newlyFocusedClient.committedTextMutations.isEmpty,
      "A delayed response from the old client must not enter or mutate the newly focused client"
    )
  }

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzk", client: client), "The deactivation probe must establish pending neural work")
    let cancellationsBeforeDeactivation = service.cancelCount
    controller.deactivateServer(client)
    service.completeRequest(at: 0, with: ["निष्क्रिय-ढिलो"])
    require(
      service.cancelCount > cancellationsBeforeDeactivation &&
        controllerCandidateStrings(controller, client: client).isEmpty &&
        client.committedTextMutations.last == "qzk",
      "Controller deactivation must cancel the tail, preserve raw source, and reject a late completion"
    )
  }

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzm", client: client), "The cancellation probe must establish pending neural work")
    let cancellationsBeforeReset = service.cancelCount
    controller.resetSession()
    service.completeRequest(at: 0, with: ["रद्द-ढिलो"])
    require(
      service.cancelCount > cancellationsBeforeReset &&
        controllerCandidateStrings(controller, client: client).isEmpty &&
        client.committedTextMutations.isEmpty,
      "Explicit session cancellation must reject an uncooperative late completion without host mutation"
    )
  }

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzn", client: client), "The stale-request probe must establish its first request")
    require(controller.inputText("v", client: client), "Continued typing must establish a newer request")
    require(
      service.requestCount == 2 && service.rawInput(at: 1) == "qznv",
      "Continued typing must snapshot the complete newer raw token"
    )
    service.completeRequest(at: 0, with: ["पुरानो-अनुरोध"])
    require(
      !controllerCandidateStrings(controller, client: client).contains("पुरानो-अनुरोध"),
      "An older raw-input request must not merge into the newer composition"
    )
    service.completeRequest(at: 1, with: ["नयाँ-अनुरोध"])
    require(
      controllerCandidateStrings(controller, client: client).contains("नयाँ-अनुरोध"),
      "The current request must remain eligible after an older request is rejected"
    )
  }

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzp", client: client), "The stale-session probe must establish its first request")
    controller.resetSession()
    require(controller.inputText("qzp", client: client), "The stale-session probe must recreate the same raw token")
    require(service.requestCount == 2, "The same raw token in a new session must create a distinct request")
    service.completeRequest(at: 0, with: ["पुरानो-सत्र"])
    require(
      !controllerCandidateStrings(controller, client: client).contains("पुरानो-सत्र"),
      "Matching raw text must not make a response from an ended session current"
    )
    service.completeRequest(at: 1, with: ["नयाँ-सत्र"])
    require(
      controllerCandidateStrings(controller, client: client).contains("नयाँ-सत्र"),
      "The matching response from the current session must still merge"
    )
  }

  do {
    let firstService = DelayedNeuralCandidateService()
    let secondService = DelayedNeuralCandidateService()
    let firstController = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: firstService
    )
    let secondController = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: secondService
    )
    let firstClient = ProbeTextInputClient()
    let secondClient = ProbeTextInputClient()
    require(firstController.inputText("qzq", client: firstClient), "The first controller must start independent neural work")
    require(secondController.inputText("qzr", client: secondClient), "The second controller must start independent neural work")
    let secondCancellationCount = secondService.cancelCount
    firstController.resetSession()
    require(
      secondService.cancelCount == secondCancellationCount,
      "Cancelling one controller must not cancel another controller's scoped neural service"
    )
    secondService.completeRequest(at: 0, with: ["दोस्रो-नियन्त्रक"])
    firstService.completeRequest(at: 0, with: ["पहिलो-रद्द"])
    require(
      controllerCandidateStrings(secondController, client: secondClient).contains("दोस्रो-नियन्त्रक") &&
        !controllerCandidateStrings(firstController, client: firstClient).contains("पहिलो-रद्द"),
      "Cross-controller cancellation must preserve the other controller's current neural response"
    )
  }

  do {
    let service = DelayedNeuralCandidateService()
    let controller = LekhInputController(
      engineClient: LekhNativeEngineClient(),
      neuralCandidateService: service
    )
    let client = ProbeTextInputClient()
    require(controller.inputText("qzs", client: client), "The mode-switch probe must establish pending neural work")
    let cancellationsBeforeModeSwitch = service.cancelCount
    let modeSwitchModifiers = Int(NSEvent.ModifierFlags([.control, .option]).rawValue)
    require(
      controller.inputText("1", key: 18, modifiers: modeSwitchModifiers, client: client),
      "The direct mode shortcut must switch away from the active Romanized-to-Traditional mode"
    )
    service.completeRequest(at: 0, with: ["पुरानो-मोड"])
    require(
      service.cancelCount > cancellationsBeforeModeSwitch &&
        !controllerCandidateStrings(controller, client: client).contains("पुरानो-मोड") &&
        (controller.composedString(client) as? String) == "" &&
        client.committedTextMutations.last == "qzs",
      "A mode switch must preserve raw source and reject the previous mode's late neural response"
    )
  }

  print("native-neural-controller-lifecycle=secure,focus,deactivate,mode,cancel,stale-request,stale-session,cross-controller passed")
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

  let keycapController = LekhInputController(engineClient: LekhNativeEngineClient())
  let keycapClient = ProbeTextInputClient()
  let keycap = "1️⃣"
  require(
    !keycapController.inputText(keycap, client: keycapClient),
    "A keycap emoji must pass through even though its first scalar is a digit"
  )
  require(
    keycapClient.markedTextMutations.isEmpty && keycapClient.committedTextMutations.isEmpty &&
      (keycapController.composedString(keycapClient) as? String) == "",
    "A host-owned keycap must not start or mutate Lekh composition"
  )
  require(
    keycapController.inputText("ab", client: keycapClient),
    "The keycap boundary probe must establish a prior raw composition"
  )
  let markedBeforeKeycap = keycapClient.markedTextMutations.count
  require(
    !keycapController.inputText(keycap, client: keycapClient),
    "A keycap following composition must remain wholly owned by the host"
  )
  require(
    keycapClient.markedTextMutations.count == markedBeforeKeycap &&
      keycapClient.committedTextMutations.last == "ab" &&
      keycapClient.text == "ab" &&
      (keycapController.composedString(keycapClient) as? String) == "",
    "A keycap must finalize only the exact prior raw token and consume none of itself"
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
  keycapController.resetSession()
  optionController.resetSession()
}

private func assertControllerCloseRestoresRawSource() {
  let modeKey = LekhNativePreferences.Keys.nativeTypingMode
  let previousMode = UserDefaults.standard.object(forKey: modeKey)
  let previousInlineComposition = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]
  defer {
    if let previousMode {
      UserDefaults.standard.set(previousMode, forKey: modeKey)
    } else {
      UserDefaults.standard.removeObject(forKey: modeKey)
    }
    if let previousInlineComposition {
      setenv("LEKH_IMK_INLINE_COMPOSITION", previousInlineComposition, 1)
    } else {
      unsetenv("LEKH_IMK_INLINE_COMPOSITION")
    }
    UserDefaults.standard.synchronize()
  }

  UserDefaults.standard.set(LekhNativeTypingMode.romanizedTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  setenv("LEKH_IMK_INLINE_COMPOSITION", "1", 1)
  let inlineController = LekhInputController(engineClient: LekhNativeEngineClient())
  let inlineClient = ProbeTextInputClient()
  let raw = "swasthya"
  require(
    inlineController.inputText(raw, client: inlineClient),
    "The controller-close probe must establish marked composition"
  )
  require(
    inlineClient.markedRange().location != NSNotFound,
    "The controller-close probe must own a live marked range"
  )
  inlineController.inputControllerWillClose()
  require(
    inlineClient.committedTextMutations.last == raw &&
      inlineClient.text == raw &&
      inlineClient.markedRange().location == NSNotFound &&
      (inlineController.composedString(inlineClient) as? String) == "" &&
      inlineController.candidates(inlineClient).isEmpty,
    "Closing an inline controller must restore exact raw source and clear every local surface"
  )

  setenv("LEKH_IMK_INLINE_COMPOSITION", "0", 1)
  let unmarkedController = LekhInputController(engineClient: LekhNativeEngineClient())
  let unmarkedClient = ProbeTextInputClient()
  require(
    unmarkedController.inputText(raw, client: unmarkedClient),
    "The unmarked controller-close probe must insert raw host text"
  )
  let commitCountBeforeClose = unmarkedClient.committedTextMutations.count
  unmarkedController.inputControllerWillClose()
  require(
    unmarkedClient.text == raw &&
      unmarkedClient.committedTextMutations.count == commitCountBeforeClose &&
      (unmarkedController.composedString(unmarkedClient) as? String) == "" &&
      unmarkedController.candidates(unmarkedClient).isEmpty,
    "Closing an unmarked controller must clear only local state without duplicating raw text"
  )
}

private func assertMultipleNativeControllersRemainIndependent() {
  let modeKey = LekhNativePreferences.Keys.nativeTypingMode
  let previousMode = UserDefaults.standard.object(forKey: modeKey)
  let previousInlineComposition = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]
  defer {
    if let previousMode {
      UserDefaults.standard.set(previousMode, forKey: modeKey)
    } else {
      UserDefaults.standard.removeObject(forKey: modeKey)
    }
    if let previousInlineComposition {
      setenv("LEKH_IMK_INLINE_COMPOSITION", previousInlineComposition, 1)
    } else {
      unsetenv("LEKH_IMK_INLINE_COMPOSITION")
    }
    UserDefaults.standard.synchronize()
  }

  UserDefaults.standard.set(LekhNativeTypingMode.romanizedTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  setenv("LEKH_IMK_INLINE_COMPOSITION", "1", 1)

  let controllers = (0..<3).map { _ in
    LekhInputController(engineClient: LekhNativeEngineClient())
  }
  let clients = (0..<3).map { _ in ProbeTextInputClient() }
  let rawInputs = ["lekh", "swasthya", "karyalaya"]
  for index in controllers.indices {
    require(
      controllers[index].inputText(rawInputs[index], client: clients[index]),
      "Every ordinary native controller must accept its own composition"
    )
  }
  for index in controllers.indices {
    require(
      (controllers[index].composedString(clients[index]) as? String) == rawInputs[index],
      "Native controller sessions must not share or overwrite raw composition"
    )
  }

  controllers[0].inputControllerWillClose()
  require(
    clients[0].text == rawInputs[0] &&
      (controllers[0].composedString(clients[0]) as? String) == "",
    "Closing one native controller must restore only its own raw source"
  )
  for index in 1..<controllers.count {
    require(
      (controllers[index].composedString(clients[index]) as? String) == rawInputs[index],
      "Closing one controller must not end another controller's composition"
    )
    controllers[index].inputControllerWillClose()
    require(
      clients[index].text == rawInputs[index],
      "Every independently closed controller must restore its exact raw source"
    )
  }
}

private func assertActiveCompositionWorkBoundIsLossless() {
  let maximum = LekhIPCProtocolContract.maximumCompositionLength
  let rawAtLimit = String(repeating: "a", count: maximum)

  let engine = LekhNativeEngineClient()
  let exactSession = "probe-composition-bound-exact-\(UUID().uuidString)"
  let exact = type(
    rawAtLimit,
    engine: engine,
    sessionId: exactSession,
    mode: .romanizedTraditional
  )
  require(exact.handled && !exact.shouldPassThrough, "Exactly 128 UTF-16 units must remain an active composition")
  require(
    engine.rawBuffer(sessionId: exactSession) == rawAtLimit &&
      engine.rawBuffer(sessionId: exactSession).utf16.count == maximum,
    "The exact-bound engine composition must preserve every raw input unit"
  )

  let overflow = engine.processKey(
    "b",
    sessionId: exactSession,
    mode: .romanizedTraditional
  )
  require(!overflow.handled && overflow.shouldPassThrough, "The 129th UTF-16 unit must fail open")
  require(
    overflow.markedText == nil && overflow.committedText == nil &&
      overflow.candidates.isEmpty && overflow.inlineSuggestion == nil &&
      !overflow.neuralTailEligible,
    "Overflow must return before candidate, proofread, inline, or neural work"
  )
  require(
    engine.rawBuffer(sessionId: exactSession) == rawAtLimit,
    "Overflow must not mutate the exact-bound raw engine composition"
  )

  let devanagariGrapheme = "कि"
  let graphemeExactSession = "probe-composition-grapheme-exact-\(UUID().uuidString)"
  _ = type(
    String(repeating: "a", count: maximum - devanagariGrapheme.utf16.count),
    engine: engine,
    sessionId: graphemeExactSession,
    mode: .traditionalTraditional
  )
  let exactGrapheme = engine.processKey(
    devanagariGrapheme,
    sessionId: graphemeExactSession,
    mode: .traditionalTraditional
  )
  require(exactGrapheme.handled, "A complete grapheme ending at the exact UTF-16 bound must be handled")
  require(
    engine.rawBuffer(sessionId: graphemeExactSession).hasSuffix(devanagariGrapheme) &&
      engine.rawBuffer(sessionId: graphemeExactSession).utf16.count == maximum,
    "The exact-bound path must append the complete multi-unit grapheme"
  )
  _ = engine.processKey(
    "\u{7f}",
    sessionId: graphemeExactSession,
    mode: .traditionalTraditional
  )
  require(
    engine.rawBuffer(sessionId: graphemeExactSession).utf16.count == maximum - devanagariGrapheme.utf16.count,
    "Backspace after an exact-bound append must remove the complete grapheme"
  )

  let graphemeOverflowSession = "probe-composition-grapheme-overflow-\(UUID().uuidString)"
  let beforeOverflowGrapheme = String(repeating: "a", count: maximum - 1)
  _ = type(
    beforeOverflowGrapheme,
    engine: engine,
    sessionId: graphemeOverflowSession,
    mode: .traditionalTraditional
  )
  let graphemeOverflow = engine.processKey(
    devanagariGrapheme,
    sessionId: graphemeOverflowSession,
    mode: .traditionalTraditional
  )
  require(
    !graphemeOverflow.handled && graphemeOverflow.shouldPassThrough &&
      engine.rawBuffer(sessionId: graphemeOverflowSession) == beforeOverflowGrapheme,
    "A grapheme crossing the bound must fail open as one indivisible host input"
  )

  let modeKey = LekhNativePreferences.Keys.nativeTypingMode
  let previousMode = UserDefaults.standard.object(forKey: modeKey)
  let previousInlineComposition = ProcessInfo.processInfo.environment["LEKH_IMK_INLINE_COMPOSITION"]
  defer {
    if let previousMode {
      UserDefaults.standard.set(previousMode, forKey: modeKey)
    } else {
      UserDefaults.standard.removeObject(forKey: modeKey)
    }
    if let previousInlineComposition {
      setenv("LEKH_IMK_INLINE_COMPOSITION", previousInlineComposition, 1)
    } else {
      unsetenv("LEKH_IMK_INLINE_COMPOSITION")
    }
    UserDefaults.standard.synchronize()
  }

  UserDefaults.standard.set(LekhNativeTypingMode.romanizedTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  setenv("LEKH_IMK_INLINE_COMPOSITION", "1", 1)

  let inlineEngine = CompositionBoundProbeEngineClient()
  let inlineController = LekhInputController(engineClient: inlineEngine)
  let inlineClient = ProbeTextInputClient()
  require(
    inlineController.inputText("a", client: inlineClient),
    "The inline bound probe must establish client ownership"
  )
  inlineEngine.prime(String(repeating: "a", count: maximum - 1))
  require(
    inlineController.inputText("a", client: inlineClient),
    "The IMK controller must accept input ending exactly at 128 UTF-16 units"
  )
  let inlineMarkedMutationCount = inlineClient.markedTextMutations.count
  require(
    (inlineController.composedString(inlineClient) as? String) == rawAtLimit,
    "The inline controller must retain the exact-bound raw composition"
  )
  require(
    !inlineController.inputText("b", client: inlineClient),
    "The inline controller must return the 129th unit to the host"
  )
  require(
    inlineClient.markedTextMutations.count == inlineMarkedMutationCount &&
      inlineClient.committedTextMutations.last == rawAtLimit &&
      inlineClient.text == rawAtLimit &&
      (inlineController.composedString(inlineClient) as? String) == "",
    "Inline overflow must commit only the prior raw composition and consume none of the new callback"
  )

  let batchEngine = CompositionBoundProbeEngineClient()
  let batchController = LekhInputController(engineClient: batchEngine)
  let batchClient = ProbeTextInputClient()
  let prefix = String(repeating: "a", count: maximum - 1)
  require(batchController.inputText("a", client: batchClient), "The overflow batch probe must establish client ownership")
  batchEngine.prime(prefix)
  let batchMarkedMutationCount = batchClient.markedTextMutations.count
  require(
    !batchController.inputText("bc", client: batchClient),
    "A safe-looking batch crossing the bound must be returned to the host atomically"
  )
  require(
    batchClient.markedTextMutations.count == batchMarkedMutationCount &&
      batchClient.committedTextMutations.last == prefix &&
      batchClient.text == prefix &&
      (batchController.composedString(batchClient) as? String) == "",
    "A crossing batch must consume neither its admissible prefix nor its overflowing suffix"
  )

  setenv("LEKH_IMK_INLINE_COMPOSITION", "0", 1)
  let failOpenController = LekhInputController(engineClient: LekhNativeEngineClient())
  let failOpenClient = ProbeTextInputClient()
  require(
    failOpenController.inputText(rawAtLimit, client: failOpenClient),
    "The unmarked fail-open route must admit exactly 128 raw UTF-16 units"
  )
  let failOpenMutationCount = failOpenClient.committedTextMutations.count
  require(
    failOpenClient.text == rawAtLimit &&
      (failOpenController.composedString(failOpenClient) as? String) == rawAtLimit,
    "The unmarked route must preserve its exact-bound raw host text and engine snapshot"
  )
  require(
    !failOpenController.inputText("b", client: failOpenClient),
    "The unmarked route must return the 129th unit to the host"
  )
  require(
    failOpenClient.committedTextMutations.count == failOpenMutationCount &&
      failOpenClient.text == rawAtLimit &&
      (failOpenController.composedString(failOpenClient) as? String) == "" &&
      failOpenController.candidates(failOpenClient).isEmpty,
    "Unmarked overflow must reset only local composition state and leave all host text untouched"
  )

  UserDefaults.standard.set(LekhNativeTypingMode.traditionalTraditional.rawValue, forKey: modeKey)
  UserDefaults.standard.synchronize()
  let optionFlags = Int(NSEvent.ModifierFlags.option.rawValue)
  let mappedOptionText = "\u{094D}र"

  setenv("LEKH_IMK_INLINE_COMPOSITION", "1", 1)
  let inlineOptionEngine = CompositionBoundProbeEngineClient()
  let inlineOptionController = LekhInputController(engineClient: inlineOptionEngine)
  let inlineOptionClient = ProbeTextInputClient()
  require(
    inlineOptionController.inputText("a", client: inlineOptionClient),
    "The inline Option-bound probe must establish client ownership"
  )
  inlineOptionEngine.prime(String(repeating: "a", count: maximum - 1))
  require(
    inlineOptionController.inputText("a", client: inlineOptionClient),
    "The inline Option-bound probe must reach the exact bound"
  )
  require(
    inlineOptionController.inputText("®", key: 15, modifiers: optionFlags, client: inlineOptionClient),
    "An overflowing mapped Option event must be consumed after restarting composition"
  )
  require(
    inlineOptionClient.committedTextMutations.last == rawAtLimit &&
      inlineOptionClient.markedTextMutations.last == mappedOptionText &&
      inlineOptionClient.text == rawAtLimit + mappedOptionText &&
      (inlineOptionController.composedString(inlineOptionClient) as? String) == mappedOptionText,
    "Inline Option overflow must commit the exact prior raw token and start the synthesized mapping once"
  )

  setenv("LEKH_IMK_INLINE_COMPOSITION", "0", 1)
  let unmarkedOptionController = LekhInputController(engineClient: LekhNativeEngineClient())
  let unmarkedOptionClient = ProbeTextInputClient()
  require(
    unmarkedOptionController.inputText(rawAtLimit, client: unmarkedOptionClient),
    "The unmarked Option-bound probe must retain the exact-bound host text"
  )
  let unmarkedCommitCount = unmarkedOptionClient.committedTextMutations.count
  require(
    unmarkedOptionController.inputText("®", key: 15, modifiers: optionFlags, client: unmarkedOptionClient),
    "An unmarked overflowing Option mapping must be consumed by Lekh"
  )
  require(
    unmarkedOptionClient.committedTextMutations.count == unmarkedCommitCount &&
      unmarkedOptionClient.text == rawAtLimit + mappedOptionText &&
      unmarkedOptionClient.markedTextMutations.last == mappedOptionText &&
      (unmarkedOptionController.composedString(unmarkedOptionClient) as? String) == mappedOptionText,
    "Unmarked Option overflow must preserve old host text and synthesize the mapped grapheme exactly once"
  )

  inlineController.resetSession()
  batchController.resetSession()
  failOpenController.resetSession()
  inlineOptionController.resetSession()
  unmarkedOptionController.resetSession()
  engine.endSession(exactSession)
  engine.endSession(graphemeExactSession)
  engine.endSession(graphemeOverflowSession)
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
assertPassiveDelimitersRemainRawWithoutExplicitSelection()
assertEscapeCancelsAndBackspaceEditsComposition()
assertCompositionOwnershipAndHostPassThroughSafety()
assertPersonalizationResetClearsLiveRankingState()
assertRepositoryCuratedTokenQualityContract()
assertSharedTokenPackNativeConformance()
assertCandidateInteractionStartsPassiveAndPagesSafely()
assertDelayedNeuralTailLifecycleSafety()
assertEveryControllerCallbackFailsOpenUnderSecureInput()
assertInputTextBatchesAndOptionLayerAreLossless()
assertControllerCloseRestoresRawSource()
assertMultipleNativeControllersRemainIndependent()
assertActiveCompositionWorkBoundIsLossless()
assertDeterministicHotPathP99()
dumpCandidateDiagnosticsIfRequested()
benchmarkNeuralServiceIfRequested()
print("native-typing-behavior=passed")

for suffix in ["", "-wal", "-shm"] {
  try? FileManager.default.removeItem(atPath: testPersonalizationDatabase.path + suffix)
}
