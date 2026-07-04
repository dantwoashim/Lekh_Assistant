import Foundation
import LekhInputMethod

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
  engine: LekhStaticProofEngineClient,
  sessionId: String,
  mode: LekhNativeTypingMode
) -> LekhInputDecision {
  var decision = LekhInputDecision.passThrough
  for character in text {
    decision = engine.processKey(
      String(character),
      sessionId: sessionId,
      timeoutMilliseconds: lekhHotPathBudgetMilliseconds,
      mode: mode
    )
  }
  return decision
}

private func assertRomanizedCompositionKeepsRawMarkedTextUntilExplicitAccept() {
  let engine = LekhStaticProofEngineClient()
  let sessionId = "probe-romanized-\(UUID().uuidString)"

  let partial = type("swasthya", engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  require(partial.handled, "swasthya keystrokes must be handled")
  require(partial.markedText == "swasthya", "Romanized composition must keep raw marked text")
  require(partial.committedText == nil, "Romanized composition must not commit before Space")
  require(partial.candidates.contains("स्वास्थ्य"), "Romanized composition must offer स्वास्थ्य")

  let rawSpaced = engine.processKey(
    " ",
    sessionId: sessionId,
    timeoutMilliseconds: lekhHotPathBudgetMilliseconds,
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
    timeoutMilliseconds: lekhHotPathBudgetMilliseconds,
    mode: .romanizedTraditional
  )
  require(accepted.handled, "Tab must accept the selected candidate")
  require(accepted.committedText == "स्वास्थ्य", "Tab must commit स्वास्थ्य without forcing a trailing space")
}

private func assertRomanizedRomanizedModeDoesNotConvertMarkedTextToDevanagari() {
  let engine = LekhStaticProofEngineClient()
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

private func assertTraditionalRomanizedModeKeepsTraditionalMarkedTextWithRomanizedHelpers() {
  let engine = LekhStaticProofEngineClient()
  let sessionId = "probe-traditional-helper-\(UUID().uuidString)"

  let decision = type("मेरो", engine: engine, sessionId: sessionId, mode: .traditionalRomanized)
  require(decision.handled, "Traditional helper keystrokes must be handled")
  require(decision.markedText == "मेरो", "Traditional helper marked text must stay Devanagari")
  require(decision.committedText == nil, "Traditional helper mode must not commit before accept")
  require(
    decision.candidates.contains("mero") || decision.candidates.contains("meroo"),
    "Traditional helper mode must offer Romanized helper candidates"
  )
}

private func assertEscapeCancelsAndBackspaceEditsComposition() {
  let engine = LekhStaticProofEngineClient()
  let sessionId = "probe-editing-\(UUID().uuidString)"

  _ = type("mero", engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  let edited = engine.processKey(
    "\u{7f}",
    sessionId: sessionId,
    timeoutMilliseconds: lekhHotPathBudgetMilliseconds,
    mode: .romanizedTraditional
  )
  require(edited.markedText == "mer", "Backspace must edit raw composition")
  require(engine.hasComposition(sessionId: sessionId), "Backspace must keep remaining composition")

  let cancelled = engine.processKey(
    "\u{1b}",
    sessionId: sessionId,
    timeoutMilliseconds: lekhHotPathBudgetMilliseconds,
    mode: .romanizedTraditional
  )
  require(cancelled.shouldCancel, "Escape must cancel composition")
  require(!engine.hasComposition(sessionId: sessionId), "Escape must reset composition")
}

assertRomanizedCompositionKeepsRawMarkedTextUntilExplicitAccept()
assertRomanizedRomanizedModeDoesNotConvertMarkedTextToDevanagari()
assertTraditionalRomanizedModeKeepsTraditionalMarkedTextWithRomanizedHelpers()
assertEscapeCancelsAndBackspaceEditsComposition()
print("native-typing-behavior=passed")
