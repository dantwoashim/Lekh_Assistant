import Foundation
import LekhInputMethod

private let skeletonDirectory = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
private let sourceRuntimePack = skeletonDirectory
  .appendingPathComponent("../../../src/data/keyboard-packs/v0.1/runtime-suggestions.json")
  .standardizedFileURL
setenv("LEKH_TEST_RUNTIME_SUGGESTIONS_PATH", sourceRuntimePack.path, 1)
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

private func assertRomanizedCompositionShowsSafeTargetPreviewUntilCommit() {
  let engine = behaviorEngine
  let sessionId = "probe-romanized-\(UUID().uuidString)"

  let partial = type("swasthya", engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  require(partial.handled, "swasthya keystrokes must be handled")
  require(partial.markedText == "स्वास्थ्य", "Romanized to Nepali composition must show the deterministic target preview")
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

  let acceptSessionId = "probe-romanized-accept-\(UUID().uuidString)"
  _ = type("swasthya", engine: engine, sessionId: acceptSessionId, mode: .romanizedTraditional)
  let accepted = engine.processKey(
    "\t",
    sessionId: acceptSessionId,
    mode: .romanizedTraditional
  )
  require(accepted.handled, "Tab must accept the selected candidate")
  require(accepted.committedText == "स्वास्थ्य", "Tab must commit स्वास्थ्य without forcing a trailing space")
}

private func assertRomanizedRomanizedModeDoesNotConvertMarkedTextToDevanagari() {
  let engine = behaviorEngine
  let sessionId = "probe-romanized-helper-\(UUID().uuidString)"

  let decision = type("swas", engine: engine, sessionId: sessionId, mode: .romanizedRomanized)
  require(decision.handled, "Romanized helper keystrokes must be handled")
  require(decision.markedText == "swas", "Romanized helper marked text must stay raw")
  require(decision.committedText == nil, "Romanized helper mode must not commit before accept")
  require(
    decision.candidates.allSatisfy { candidate in
      candidate.range(of: #"\p{Devanagari}"#, options: .regularExpression) == nil
    },
    "Romanized helper mode must not show Devanagari candidates"
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
assertTraditionalRomanizedModeShowsRomanizedTargetPreview()
assertEscapeCancelsAndBackspaceEditsComposition()
assertDeterministicHotPathP99()
print("native-typing-behavior=passed")
