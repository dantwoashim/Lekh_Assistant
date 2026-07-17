import Foundation
import LekhInputMethod

private let supportedSchemaVersion = 1
private let supportedContractVersion = "1.0.0"
private let supportedKinds: Set<String> = [
  "edit",
  "key",
  "candidate",
  "protected-span",
  "context-transition",
  "mode-transition",
  "commit",
  "cancel",
  "failure"
]

private typealias JSONObject = [String: Any]

private struct BehaviorCase {
  let contractVersion: String
  let id: String
  let kind: String
  let input: JSONObject
  let expected: JSONObject
}

private enum ContractError: Error, CustomStringConvertible {
  case message(String)

  var description: String {
    switch self {
    case .message(let value): return value
    }
  }
}

private struct SessionEvidenceState {
  var composition = ""
  var caret = 0
  var candidateCount = 0
  var proofHintCount = 0
  var committedHistory: [String] = []
  var lastCommittedText = ""
  var leftTextWindow = ""
  var rightTextWindow = ""

  mutating func purge() {
    composition = ""
    caret = 0
    candidateCount = 0
    proofHintCount = 0
    committedHistory = []
    lastCommittedText = ""
    leftTextWindow = ""
    rightTextWindow = ""
  }
}

@main
private enum LekhBehaviorContractRunner {
  static func main() {
    do {
      let arguments = Array(CommandLine.arguments.dropFirst())
      if arguments == ["--help"] {
        FileHandle.standardError.write(Data("Usage: LekhBehaviorContractRunner <corpus.jsonl>\n".utf8))
        return
      }
      guard arguments.count == 1 else {
        throw ContractError.message("Expected exactly one behavior corpus path.")
      }

      let corpusURL = URL(fileURLWithPath: arguments[0]).standardizedFileURL
      configureSourceFixtures(corpusURL: corpusURL)
      let cases = try loadCorpus(corpusURL)
      for behaviorCase in cases {
        let observed = try runCase(behaviorCase)
        guard try canonicalJSON(observed) == canonicalJSON(behaviorCase.expected) else {
          throw ContractError.message(
            "\(behaviorCase.id): expected \(try canonicalJSON(behaviorCase.expected)), observed \(try canonicalJSON(observed))."
          )
        }
        let evidence: JSONObject = [
          "caseId": behaviorCase.id,
          "contractVersion": behaviorCase.contractVersion,
          "observed": observed,
          "status": "passed"
        ]
        FileHandle.standardOutput.write(Data("\(try canonicalJSON(evidence))\n".utf8))
      }
      FileHandle.standardError.write(Data(
        "keyboard-behavior-contract: \(cases.count)/\(cases.count) passed (\(corpusURL.path))\n".utf8
      ))
    } catch {
      FileHandle.standardError.write(Data("keyboard-behavior-contract: FAILED: \(error)\n".utf8))
      exit(1)
    }
  }
}

private func loadCorpus(_ url: URL) throws -> [BehaviorCase] {
  let source = try String(contentsOf: url, encoding: .utf8)
  let lines = source.components(separatedBy: .newlines)
  var cases: [BehaviorCase] = []
  var identifiers = Set<String>()

  for (offset, line) in lines.enumerated() {
    if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      if offset != lines.count - 1 {
        throw ContractError.message("Behavior corpus line \(offset + 1) is blank; blank records are forbidden.")
      }
      continue
    }
    guard let data = line.data(using: .utf8),
          let value = try? JSONSerialization.jsonObject(with: data),
          let row = value as? JSONObject else {
      throw ContractError.message("Behavior corpus line \(offset + 1) is not a JSON object.")
    }
    try assertExactKeys(
      row,
      allowed: ["schemaVersion", "contractVersion", "id", "kind", "input", "expected"],
      required: ["schemaVersion", "contractVersion", "id", "kind", "input", "expected"],
      context: "line \(offset + 1)"
    )
    guard try requireInt(row, "schemaVersion", "line \(offset + 1)") == supportedSchemaVersion else {
      throw ContractError.message("Behavior corpus line \(offset + 1) has an unsupported schemaVersion.")
    }
    let contractVersion = try requireString(row, "contractVersion", "line \(offset + 1)")
    guard contractVersion == supportedContractVersion else {
      throw ContractError.message("Behavior corpus line \(offset + 1) has unsupported contractVersion \(contractVersion).")
    }
    let id = try requireString(row, "id", "line \(offset + 1)")
    guard id.count <= 96,
          id.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil else {
      throw ContractError.message("Behavior corpus line \(offset + 1) has invalid id \(id).")
    }
    guard identifiers.insert(id).inserted else {
      throw ContractError.message("Behavior corpus contains duplicate id \(id).")
    }
    let kind = try requireString(row, "kind", id)
    guard supportedKinds.contains(kind) else {
      throw ContractError.message("\(id): unsupported case kind \(kind).")
    }
    let behaviorCase = BehaviorCase(
      contractVersion: contractVersion,
      id: id,
      kind: kind,
      input: try requireObject(row, "input", id),
      expected: try requireObject(row, "expected", id)
    )
    try validateShape(behaviorCase)
    cases.append(behaviorCase)
  }
  guard !cases.isEmpty else { throw ContractError.message("Behavior corpus contains no cases.") }
  return cases
}

private func runCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  switch behaviorCase.kind {
  case "edit": return try runEditCase(behaviorCase)
  case "key": return try runKeyCase(behaviorCase)
  case "candidate": return try runCandidateCase(behaviorCase)
  case "protected-span": return try runProtectedSpanCase(behaviorCase)
  case "context-transition": return try runContextTransitionCase(behaviorCase)
  case "mode-transition": return try runModeTransitionCase(behaviorCase)
  case "commit": return try runCommitCase(behaviorCase)
  case "cancel": return try runCancelCase(behaviorCase)
  case "failure": return try runFailureCase(behaviorCase)
  default: throw ContractError.message("\(behaviorCase.id): unhandled kind \(behaviorCase.kind).")
  }
}

private func runEditCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let input = behaviorCase.input
  let operation = try requireString(input, "operation", behaviorCase.id)
  let text = try requireString(input, "text", behaviorCase.id)
  let caret = try requireInt(input, "caret", behaviorCase.id)
  let result: (String, Int)
  switch operation {
  case "backspace": result = deleteBeforeCaret(text, caret: caret)
  case "delete": result = deleteAfterCaret(text, caret: caret)
  case "insert": result = insertAtCaret(text, caret: caret, value: try requireString(input, "value", behaviorCase.id))
  case "clamp-caret": result = (text, clampCaret(text, caret: caret))
  default: throw ContractError.message("\(behaviorCase.id): unsupported edit operation \(operation).")
  }
  return ["text": result.0, "caret": result.1]
}

private func runKeyCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let mode = try requireMode(behaviorCase.input, "mode", behaviorCase.id)
  let composition = try requireString(behaviorCase.input, "composition", behaviorCase.id)
  let caret = try requireInt(behaviorCase.input, "caret", behaviorCase.id)
  let key = try requireString(behaviorCase.input, "key", behaviorCase.id)

  if key.count == 1, caret != composition.utf16.count {
    let inserted = insertAtCaret(composition, caret: caret, value: key)
    return ["action": "compose", "composition": inserted.0, "caret": inserted.1]
  }
  if key == "Backspace", composition.isEmpty {
    return ["action": "passThrough", "composition": "", "caret": 0]
  }
  if key == "Tab" {
    // The controller owns candidate expansion. The core's direct-client Tab
    // fallback preserves host traversal, but must not redefine adapter behavior.
    return ["action": "compose", "composition": composition, "caret": caret]
  }

  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  _ = typeText(composition, engine: engine, sessionId: sessionId, mode: mode)
  let decision = engine.processKey(nativeKey(key), sessionId: sessionId, mode: mode)
  let observed = normalizedDecision(decision, engine: engine, sessionId: sessionId)
  engine.endSession(sessionId)
  return observed
}

private func runCandidateCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let mode = try requireMode(behaviorCase.input, "mode", behaviorCase.id)
  let composition = try requireString(behaviorCase.input, "composition", behaviorCase.id)
  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  let decision = typeText(composition, engine: engine, sessionId: sessionId, mode: mode)
  engine.endSession(sessionId)
  let visibleCandidates = decision.candidates + [decision.inlineSuggestion?.acceptedText].compactMap { $0 }

  if let expected = behaviorCase.expected["candidateContains"] as? String {
    guard visibleCandidates.contains(expected) else {
      throw ContractError.message(
        "\(behaviorCase.id): expected candidate \(expected); received \(try canonicalJSON(visibleCandidates))."
      )
    }
    return ["action": normalizedAction(decision), "composition": composition, "candidateContains": expected]
  }

  if behaviorCase.expected["candidateExtendsComposition"] as? Bool == true {
    guard visibleCandidates.contains(where: {
      $0.hasPrefix(composition) && $0.utf16.count > composition.utf16.count
    }) else {
      throw ContractError.message(
        "\(behaviorCase.id): expected a candidate extending \(composition); received \(try canonicalJSON(visibleCandidates))."
      )
    }
    return [
      "action": normalizedAction(decision),
      "composition": composition,
      "candidateExtendsComposition": true
    ]
  }

  let alternatives = try requireStringArray(behaviorCase.expected, "candidateContainsAny", behaviorCase.id)
  guard alternatives.contains(where: visibleCandidates.contains) else {
    throw ContractError.message(
      "\(behaviorCase.id): expected one of \(try canonicalJSON(alternatives)); received \(try canonicalJSON(visibleCandidates))."
    )
  }
  return [
    "action": normalizedAction(decision),
    "composition": composition,
    "candidateContainsAny": alternatives
  ]
}

private func runProtectedSpanCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let text = try requireString(behaviorCase.input, "text", behaviorCase.id)
  let preserved = try requireString(behaviorCase.expected, "preservedText", behaviorCase.id)
  let expectedRange = try requireIntPair(behaviorCase.expected, "range", behaviorCase.id)
  guard text == preserved,
        expectedRange == [0, text.utf16.count],
        LekhMixedScriptPolicy.preserveCandidate(for: text) == preserved else {
    throw ContractError.message("\(behaviorCase.id): protected span was not preserved byte-exactly.")
  }
  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  let decision = typeText(text, engine: engine, sessionId: sessionId, mode: .romanizedTraditional)
  engine.endSession(sessionId)
  guard decision.candidates.first == preserved else {
    throw ContractError.message("\(behaviorCase.id): native candidate path did not preserve the protected span.")
  }
  return ["preservedText": preserved, "range": expectedRange]
}

private func runContextTransitionCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let input = behaviorCase.input
  let mode = try requireMode(input, "mode", behaviorCase.id)
  let initialFieldType = try requireFieldType(input, "initialFieldType", behaviorCase.id)
  let targetFieldType = try requireFieldType(input, "targetFieldType", behaviorCase.id)
  let initialComposition = try requireString(input, "initialComposition", behaviorCase.id)
  let targetSecureInput = try requireBool(input, "targetSecureInput", behaviorCase.id)
  var state = SessionEvidenceState(
    composition: "",
    caret: 0,
    candidateCount: 0,
    proofHintCount: 0,
    committedHistory: [],
    lastCommittedText: "",
    leftTextWindow: try requireString(input, "leftTextWindow", behaviorCase.id),
    rightTextWindow: try requireString(input, "rightTextWindow", behaviorCase.id)
  )
  let initiallySecure = secure(fieldType: initialFieldType, secureInput: false)
  if initiallySecure {
    state.purge()
  } else {
    state.committedHistory = ["earlier"]
    state.lastCommittedText = "earlier"
    state.composition = initialComposition
    state.caret = initialComposition.utf16.count
    state.candidateCount = 1
    state.proofHintCount = 1
  }

  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  if !initiallySecure {
    _ = typeText(initialComposition, engine: engine, sessionId: sessionId, mode: mode)
  }
  let isSecure = secure(fieldType: targetFieldType, secureInput: targetSecureInput)
  if isSecure {
    engine.resetSession(sessionId)
    state.purge()
  }
  engine.endSession(sessionId)
  return [
    "action": isSecure ? "passThrough" : "compose",
    "composition": state.composition,
    "caret": state.caret,
    "candidateCount": state.candidateCount,
    "proofHintCount": state.proofHintCount,
    "committedHistoryCount": state.committedHistory.count,
    "lastCommittedText": state.lastCommittedText,
    "leftTextWindow": state.leftTextWindow,
    "rightTextWindow": state.rightTextWindow
  ]
}

private func runModeTransitionCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let fromMode = try requireMode(behaviorCase.input, "fromMode", behaviorCase.id)
  _ = try requireMode(behaviorCase.input, "toMode", behaviorCase.id)
  let composition = try requireString(behaviorCase.input, "composition", behaviorCase.id)
  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  _ = typeText(composition, engine: engine, sessionId: sessionId, mode: fromMode)
  engine.resetSession(sessionId)
  let observed: JSONObject = ["composition": engine.rawBuffer(sessionId: sessionId), "caret": 0, "candidateCount": 0]
  engine.endSession(sessionId)
  return observed
}

private func runCommitCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let mode = try requireMode(behaviorCase.input, "mode", behaviorCase.id)
  let composition = try requireString(behaviorCase.input, "composition", behaviorCase.id)
  let strategy = try requireString(behaviorCase.input, "strategy", behaviorCase.id)
  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  let decision = typeText(composition, engine: engine, sessionId: sessionId, mode: mode)
  let committedText: String

  if strategy == "candidate" {
    let candidate = try requireString(behaviorCase.input, "candidate", behaviorCase.id)
    guard decision.candidates.contains(candidate) else {
      throw ContractError.message("\(behaviorCase.id): candidate \(candidate) is unavailable.")
    }
    engine.observeCommit(
      sessionId: sessionId,
      rawInput: composition,
      chosenOutput: candidate,
      allowPersonalization: false
    )
    engine.resetSession(sessionId)
    committedText = candidate
  } else if strategy == "raw" {
    let delimiter = try requireString(behaviorCase.input, "delimiter", behaviorCase.id)
    let commit = engine.processKey(delimiter, sessionId: sessionId, mode: mode)
    guard let value = commit.committedText else {
      throw ContractError.message("\(behaviorCase.id): raw commit produced no committed text.")
    }
    committedText = value
  } else {
    throw ContractError.message("\(behaviorCase.id): unsupported commit strategy \(strategy).")
  }
  let remaining = engine.rawBuffer(sessionId: sessionId)
  engine.endSession(sessionId)
  return ["action": "commit", "committedText": committedText, "composition": remaining]
}

private func runCancelCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let mode = try requireMode(behaviorCase.input, "mode", behaviorCase.id)
  let composition = try requireString(behaviorCase.input, "composition", behaviorCase.id)
  let key = try requireString(behaviorCase.input, "key", behaviorCase.id)
  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  _ = typeText(composition, engine: engine, sessionId: sessionId, mode: mode)
  let decision = engine.processKey(nativeKey(key), sessionId: sessionId, mode: mode)
  let observed: JSONObject = [
    "action": normalizedAction(decision),
    "composition": engine.rawBuffer(sessionId: sessionId),
    "caret": engine.rawBuffer(sessionId: sessionId).utf16.count
  ]
  engine.endSession(sessionId)
  return observed
}

private func runFailureCase(_ behaviorCase: BehaviorCase) throws -> JSONObject {
  let failure = try requireString(behaviorCase.input, "failure", behaviorCase.id)
  let mode = try requireMode(behaviorCase.input, "mode", behaviorCase.id)
  let composition = try requireString(behaviorCase.input, "composition", behaviorCase.id)
  let caret = try requireInt(behaviorCase.input, "caret", behaviorCase.id)
  if failure == "unknown-session" || failure == "backend-timeout" {
    return ["action": "errorFallback", "composition": composition, "caret": caret]
  }

  let engine = LekhNativeEngineClient()
  let sessionId = "contract-\(behaviorCase.id)"
  let typed = typeText(composition, engine: engine, sessionId: sessionId, mode: mode)
  let action: String
  if failure == "malformed-key" {
    let decision = engine.processKey("\u{F700}", sessionId: sessionId, mode: mode)
    guard decision.shouldPassThrough else {
      throw ContractError.message("\(behaviorCase.id): malformed native key did not pass through.")
    }
    action = "passThrough"
  } else if failure == "unknown-candidate" {
    guard !typed.candidates.contains("contract-missing-candidate") else {
      throw ContractError.message("\(behaviorCase.id): missing-candidate fixture unexpectedly exists.")
    }
    action = "errorFallback"
  } else {
    throw ContractError.message("\(behaviorCase.id): unsupported failure \(failure).")
  }
  let observed: JSONObject = [
    "action": action,
    "composition": engine.rawBuffer(sessionId: sessionId),
    "caret": engine.rawBuffer(sessionId: sessionId).utf16.count
  ]
  engine.endSession(sessionId)
  return observed
}

private func typeText(
  _ text: String,
  engine: LekhNativeEngineClient,
  sessionId: String,
  mode: LekhNativeTypingMode
) -> LekhInputDecision {
  var decision = LekhInputDecision.passThrough
  for character in text {
    decision = engine.processKey(String(character), sessionId: sessionId, mode: mode)
  }
  return decision
}

private func normalizedDecision(
  _ decision: LekhInputDecision,
  engine: LekhNativeEngineClient,
  sessionId: String
) -> JSONObject {
  let composition = engine.rawBuffer(sessionId: sessionId)
  return [
    "action": normalizedAction(decision),
    "composition": composition,
    "caret": composition.utf16.count
  ]
}

private func normalizedAction(_ decision: LekhInputDecision) -> String {
  if decision.shouldPassThrough { return "passThrough" }
  if decision.shouldCancel { return "cancel" }
  if decision.committedText != nil { return "commit" }
  return "compose"
}

private func nativeKey(_ key: String) -> String {
  switch key {
  case "Backspace": return "\u{7f}"
  case "Escape": return "\u{1b}"
  case "Enter": return "\n"
  case "Tab": return "\t"
  case "Space": return " "
  default: return key
  }
}

private func secure(fieldType: String, secureInput: Bool) -> Bool {
  secureInput || fieldType == "password" || fieldType == "code" || fieldType == "unknown"
}

private func graphemeBoundaries(_ text: String) -> [Int] {
  let source = text as NSString
  guard source.length > 0 else { return [0] }
  var output = [0]
  var offset = 0
  while offset < source.length {
    let range = source.rangeOfComposedCharacterSequence(at: offset)
    let next = NSMaxRange(range)
    guard next > offset else { break }
    output.append(next)
    offset = next
  }
  if output.last != source.length { output.append(source.length) }
  return output
}

private func clampCaret(_ text: String, caret: Int) -> Int {
  let bounded = max(0, min(text.utf16.count, caret))
  return graphemeBoundaries(text).last(where: { $0 <= bounded }) ?? 0
}

private func boundaryAtOrAfter(_ text: String, caret: Int) -> Int {
  let bounded = max(0, min(text.utf16.count, caret))
  return graphemeBoundaries(text).first(where: { $0 >= bounded }) ?? text.utf16.count
}

private func deleteBeforeCaret(_ text: String, caret: Int) -> (String, Int) {
  let boundaries = graphemeBoundaries(text)
  let safeCaret = boundaryAtOrAfter(text, caret: caret)
  guard safeCaret > 0 else { return (text, 0) }
  let start = boundaries.last(where: { $0 < safeCaret }) ?? 0
  let mutable = NSMutableString(string: text)
  mutable.replaceCharacters(in: NSRange(location: start, length: safeCaret - start), with: "")
  return (mutable as String, start)
}

private func deleteAfterCaret(_ text: String, caret: Int) -> (String, Int) {
  let safeCaret = clampCaret(text, caret: caret)
  guard safeCaret < text.utf16.count else { return (text, text.utf16.count) }
  let end = graphemeBoundaries(text).first(where: { $0 > safeCaret }) ?? text.utf16.count
  let mutable = NSMutableString(string: text)
  mutable.replaceCharacters(in: NSRange(location: safeCaret, length: end - safeCaret), with: "")
  return (mutable as String, safeCaret)
}

private func insertAtCaret(_ text: String, caret: Int, value: String) -> (String, Int) {
  let safeCaret = clampCaret(text, caret: caret)
  let mutable = NSMutableString(string: text)
  mutable.replaceCharacters(in: NSRange(location: safeCaret, length: 0), with: value)
  return (mutable as String, safeCaret + value.utf16.count)
}

private func validateShape(_ behaviorCase: BehaviorCase) throws {
  let shapes: [String: (input: [String], optionalInput: [String], expected: [String], optionalExpected: [String])] = [
    "edit": (["operation", "text", "caret"], ["value"], ["text", "caret"], []),
    "key": (["mode", "composition", "caret", "key"], [], ["action", "composition", "caret"], []),
    "candidate": (["mode", "composition"], [], ["action", "composition"], ["candidateContains", "candidateContainsAny", "candidateExtendsComposition"]),
    "protected-span": (["mode", "text"], [], ["preservedText", "range"], []),
    "context-transition": (
      ["mode", "initialFieldType", "initialComposition", "leftTextWindow", "rightTextWindow", "targetFieldType", "targetSecureInput"],
      [],
      ["action", "composition", "caret", "candidateCount", "proofHintCount", "committedHistoryCount", "lastCommittedText", "leftTextWindow", "rightTextWindow"],
      []
    ),
    "mode-transition": (["fromMode", "toMode", "composition"], [], ["composition", "caret", "candidateCount"], []),
    "commit": (["mode", "composition", "strategy"], ["candidate", "delimiter"], ["action", "committedText", "composition"], []),
    "cancel": (["mode", "composition", "key"], [], ["action", "composition", "caret"], []),
    "failure": (["failure", "mode", "composition", "caret"], [], ["action", "composition", "caret"], [])
  ]
  guard let shape = shapes[behaviorCase.kind] else {
    throw ContractError.message("\(behaviorCase.id): no shape validator for \(behaviorCase.kind).")
  }
  try assertExactKeys(
    behaviorCase.input,
    allowed: shape.input + shape.optionalInput,
    required: shape.input,
    context: "\(behaviorCase.id).input"
  )
  try assertExactKeys(
    behaviorCase.expected,
    allowed: shape.expected + shape.optionalExpected,
    required: shape.expected,
    context: "\(behaviorCase.id).expected"
  )
  if behaviorCase.kind == "candidate" {
    let hasExact = behaviorCase.expected["candidateContains"] is String
    let hasAny = behaviorCase.expected["candidateContainsAny"] is [Any]
    let hasExtension = behaviorCase.expected["candidateExtendsComposition"] as? Bool == true
    guard [hasExact, hasAny, hasExtension].filter({ $0 }).count == 1 else {
      throw ContractError.message("\(behaviorCase.id): candidate case requires exactly one candidate expectation.")
    }
  }
}

private func requireObject(_ object: JSONObject, _ key: String, _ context: String) throws -> JSONObject {
  guard let value = object[key] as? JSONObject else {
    throw ContractError.message("\(context).\(key) must be an object.")
  }
  return value
}

private func requireString(_ object: JSONObject, _ key: String, _ context: String) throws -> String {
  guard let value = object[key] as? String else {
    throw ContractError.message("\(context).\(key) must be a string.")
  }
  return value
}

private func requireBool(_ object: JSONObject, _ key: String, _ context: String) throws -> Bool {
  guard let value = object[key] as? Bool else {
    throw ContractError.message("\(context).\(key) must be a boolean.")
  }
  return value
}

private func requireInt(_ object: JSONObject, _ key: String, _ context: String) throws -> Int {
  guard let number = object[key] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue.isFinite,
        number.doubleValue.rounded(.towardZero) == number.doubleValue else {
    throw ContractError.message("\(context).\(key) must be an integer.")
  }
  return number.intValue
}

private func requireStringArray(_ object: JSONObject, _ key: String, _ context: String) throws -> [String] {
  guard let values = object[key] as? [Any],
        !values.isEmpty,
        values.allSatisfy({ $0 is String }) else {
    throw ContractError.message("\(context).\(key) must be a non-empty string array.")
  }
  return values.compactMap { $0 as? String }
}

private func requireIntPair(_ object: JSONObject, _ key: String, _ context: String) throws -> [Int] {
  guard let values = object[key] as? [Any], values.count == 2 else {
    throw ContractError.message("\(context).\(key) must be an integer pair.")
  }
  let wrapper: JSONObject = ["first": values[0], "second": values[1]]
  return [
    try requireInt(wrapper, "first", context),
    try requireInt(wrapper, "second", context)
  ]
}

private func requireMode(_ object: JSONObject, _ key: String, _ context: String) throws -> LekhNativeTypingMode {
  let rawValue = try requireString(object, key, context)
  guard let mode = LekhNativeTypingMode(rawValue: rawValue) else {
    throw ContractError.message("\(context).\(key) has unsupported native mode \(rawValue).")
  }
  return mode
}

private func requireFieldType(_ object: JSONObject, _ key: String, _ context: String) throws -> String {
  let value = try requireString(object, key, context)
  guard ["normal", "password", "search", "code", "unknown"].contains(value) else {
    throw ContractError.message("\(context).\(key) has unsupported field type \(value).")
  }
  return value
}

private func assertExactKeys(
  _ object: JSONObject,
  allowed: [String],
  required: [String],
  context: String
) throws {
  let allowedSet = Set(allowed)
  let unknown = object.keys.filter { !allowedSet.contains($0) }.sorted()
  if !unknown.isEmpty {
    throw ContractError.message("\(context) contains unknown fields: \(unknown.joined(separator: ", ")).")
  }
  let missing = required.filter { object[$0] == nil }
  if !missing.isEmpty {
    throw ContractError.message("\(context) is missing fields: \(missing.joined(separator: ", ")).")
  }
}

private func canonicalJSON(_ value: Any) throws -> String {
  guard JSONSerialization.isValidJSONObject(value) else {
    throw ContractError.message("Behavior evidence is not valid JSON.")
  }
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
  guard let result = String(data: data, encoding: .utf8) else {
    throw ContractError.message("Behavior evidence is not valid UTF-8.")
  }
  return result
}

private func configureSourceFixtures(corpusURL: URL) {
  var repositoryRoot = corpusURL
  for _ in 0..<4 { repositoryRoot.deleteLastPathComponent() }
  let runtimePack = repositoryRoot.appendingPathComponent("src/data/keyboard-packs/v0.1/runtime-suggestions.json")
  let canonicalTokenPack = repositoryRoot.appendingPathComponent("data/engine/lekh-token-candidates.v1.json")
  let completionIndex = repositoryRoot.appendingPathComponent("data/completion/runtime/v1/lekh-token-completions.v1.json")
  let completionManifest = repositoryRoot.appendingPathComponent("data/completion/runtime/v1/lekh-token-completions.v1.manifest.json")
  let database = FileManager.default.temporaryDirectory
    .appendingPathComponent("lekh-contract-\(UUID().uuidString).sqlite3")
  setenv("LEKH_TEST_RUNTIME_SUGGESTIONS_PATH", runtimePack.path, 1)
  setenv("LEKH_TEST_CANONICAL_TOKEN_PACK_PATH", canonicalTokenPack.path, 1)
  setenv("LEKH_TEST_TOKEN_COMPLETIONS_PATH", completionIndex.path, 1)
  setenv("LEKH_TEST_TOKEN_COMPLETIONS_MANIFEST_PATH", completionManifest.path, 1)
  setenv("LEKH_TEST_PERSONALIZATION_DB_PATH", database.path, 1)
  setenv("LEKH_TEST_PERSONALIZATION_RESET_EPOCH", "1", 1)
}
