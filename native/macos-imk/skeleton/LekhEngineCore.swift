import Foundation
import SQLite3

private func lekhUsesNativeFixtureEnvironment() -> Bool {
  switch ProcessInfo.processInfo.processName {
  case "LekhInputMethodBehaviorProbe", "LekhBehaviorContractRunner": return true
  default: return false
  }
}

public enum LekhNativeTypingMode: String, CaseIterable {
  case romanizedRomanized = "romanized-romanized"
  case romanizedTraditional = "romanized-traditional"
  case traditionalTraditional = "traditional-traditional"
  case traditionalRomanized = "traditional-romanized"

  public static let visibleModes: [LekhNativeTypingMode] = [
    .romanizedRomanized,
    .romanizedTraditional,
    .traditionalTraditional,
    .traditionalRomanized
  ]

  public var menuLabel: String {
    switch self {
    case .romanizedRomanized:
      return LekhL10n.text("mode.romanizedRomanized")
    case .romanizedTraditional:
      return LekhL10n.text("mode.romanizedTraditional")
    case .traditionalTraditional:
      return LekhL10n.text("mode.traditionalTraditional")
    case .traditionalRomanized:
      return LekhL10n.text("mode.traditionalRomanized")
    }
  }
}

public protocol LekhEngineClient {
  func processKey(_ key: String, sessionId: String, mode: LekhNativeTypingMode) -> LekhInputDecision
  func normalizedPunctuation(_ key: String, mode: LekhNativeTypingMode) -> String
  func hasComposition(sessionId: String) -> Bool
  func rawBuffer(sessionId: String) -> String
  func observeCommit(
    sessionId: String,
    rawInput: String,
    chosenOutput: String,
    allowPersonalization: Bool
  )
  func mayPersonalizeExplicitChoice(
    rawInput: String,
    chosenOutput: String,
    mode: LekhNativeTypingMode
  ) -> Bool
  func forgetCandidate(sessionId: String, chosenOutput: String)
  func resetSession(_ sessionId: String)
  func endSession(_ sessionId: String)
  func diagnosticsSummary() -> String
  func securityWarning() -> String?
}

/// The synchronous native typing path must remain bounded independently of
/// candidate, proofread, or neural implementation details. Length is measured
/// in UTF-16 code units because that is the coordinate system shared by IMK,
/// NSString, and the generated native protocol contract.
public enum LekhActiveCompositionWorkBound {
  public static let maximumUTF16Length = LekhIPCProtocolContract.maximumCompositionLength

  public static func wouldOverflow(current: String, appending input: String) -> Bool {
    let currentLength = current.utf16.count
    let inputLength = input.utf16.count
    guard currentLength <= maximumUTF16Length else { return true }
    return inputLength > maximumUTF16Length - currentLength
  }
}

/// A callback is composition-safe only when every scalar belongs to the
/// supported typed alphabets. Inspecting only the first scalar of an extended
/// grapheme misclassifies keycap emoji such as `1️⃣` as a digit and lets an
/// otherwise host-owned callback enter marked-text state.
public enum LekhCompositionInputPolicy {
  public static func isCompositionSafe(_ input: String) -> Bool {
    !input.isEmpty && input.unicodeScalars.allSatisfy { scalar in
      if scalar.value >= 0x0900 && scalar.value <= 0x097F {
        return true
      }
      switch scalar.properties.generalCategory {
      case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter,
           .modifierLetter, .otherLetter,
           .decimalNumber, .letterNumber, .otherNumber:
        return true
      default:
        return false
      }
    }
  }
}

/// Closed-world validator for the engine policy bundled into the native
/// process. Swift's default Codable behavior ignores unknown JSON keys, which
/// is unsafe for a release authority contract; this validator rejects every
/// missing, additional, mistyped, or semantically incompatible field.
public enum LekhEngineContractValidator {
  public static func maximumVisibleIfValid(data: Data) -> Int? {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactKeys(root, ["schemaVersion", "modes", "candidatePolicy", "commitPolicy", "hotPathPolicy", "neuralPolicy"]),
          strictInteger(root["schemaVersion"]) == 1,
          let modes = root["modes"] as? [String],
          modes.count == LekhNativeTypingMode.visibleModes.count,
          Set(modes) == Set(LekhNativeTypingMode.visibleModes.map(\.rawValue)),
          let candidate = root["candidatePolicy"] as? [String: Any],
          exactKeys(candidate, ["maximumVisible", "singleTokenMayExpandToPhrase", "commitAuthority"]),
          let maximumVisible = strictInteger(candidate["maximumVisible"]),
          maximumVisible == 8,
          strictBoolean(candidate["singleTokenMayExpandToPhrase"]) == false,
          let authority = candidate["commitAuthority"] as? [String: Any],
          exactKeys(authority, ["explicitUserSelection", "untrustedProgrammaticSelection", "experimentalExactSpaceAuthorization"]),
          strictBoolean(authority["explicitUserSelection"]) == true,
          strictBoolean(authority["untrustedProgrammaticSelection"]) == false,
          let experiment = authority["experimentalExactSpaceAuthorization"] as? [String: Any],
          exactKeys(experiment, ["policyId", "productionEligible", "activation"]),
          experiment["policyId"] as? String == "lekh-experimental-passive-commit-v1",
          strictBoolean(experiment["productionEligible"]) == false,
          experiment["activation"] as? String == "opaque-test-build-capability-only",
          let commit = root["commitPolicy"] as? [String: Any],
          exactKeys(commit, ["Space", "Enter", "Tab", "Escape"]),
          commit["Space"] as? String == "raw-with-space-unless-explicit-selection-or-test-only-experiment",
          commit["Enter"] as? String == "raw-with-newline-unless-explicit-selection",
          commit["Tab"] as? String == "pass-through-unless-explicit-selection",
          commit["Escape"] as? String == "preserve-raw",
          let hotPath = root["hotPathPolicy"] as? [String: Any],
          exactKeys(hotPath, [
            "networkAllowed", "synchronousXpcAllowed", "synchronousDatabaseAllowed",
            "deterministicP99Milliseconds", "maximumCompositionUtf16CodeUnits"
          ]),
          strictBoolean(hotPath["networkAllowed"]) == false,
          strictBoolean(hotPath["synchronousXpcAllowed"]) == false,
          strictBoolean(hotPath["synchronousDatabaseAllowed"]) == false,
          strictInteger(hotPath["deterministicP99Milliseconds"]) == 5,
          strictInteger(hotPath["maximumCompositionUtf16CodeUnits"]) == LekhIPCProtocolContract.maximumCompositionLength,
          let neural = root["neuralPolicy"] as? [String: Any],
          exactKeys(neural, ["requiresOpenVocabulary", "requiresProductionEligibility", "requiresAsynchronousInvocation"]),
          strictBoolean(neural["requiresOpenVocabulary"]) == true,
          strictBoolean(neural["requiresProductionEligibility"]) == true,
          strictBoolean(neural["requiresAsynchronousInvocation"]) == true else {
      return nil
    }
    return maximumVisible
  }

  private static func exactKeys(_ value: [String: Any], _ expected: Set<String>) -> Bool {
    Set(value.keys) == expected
  }

  /// JSONSerialization represents both JSON booleans and numbers as NSNumber.
  /// Swift conditional casts intentionally coerce between those types, so a
  /// security contract must inspect the Core Foundation identity first.
  private static func strictBoolean(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID() else {
      return nil
    }
    return number.boolValue
  }

  private static func strictInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID() else {
      return nil
    }
    let integerObjectiveCTypes: Set<String> = ["c", "s", "i", "l", "q", "C", "S", "I", "L", "Q"]
    guard integerObjectiveCTypes.contains(String(cString: number.objCType)) else {
      return nil
    }
    return number.intValue
  }
}

private enum NativeCandidateKind: UInt8 {
  case unknown = 0
  case phrase = 1
  case word = 2
  case name = 3
}

private struct NativeCandidateRow {
  let romanized: String
  let unicode: String
  let confidence: Double
  let priority: Int
  let kind: NativeCandidateKind
}

private final class LekhBinaryLexicon {
  private static let magic = Array("LEKHBLX1".utf8)
  private let data: Data
  private let entryCount: Int
  private let entryOffset: Int
  private let entryStride: Int
  private let prefixCount: Int
  private let prefixOffset: Int
  private let prefixStride: Int
  private let refCount: Int
  private let refOffset: Int
  private let stringOffset: Int
  private let stringBytes: Int
  private let maxPrefixLength: Int

  static func loadPreferred() -> (lexicon: LekhBinaryLexicon?, warning: String?, source: String) {
    let status = LekhDictionaryPackVerifier.installedPackStatus()
    if let verifiedURL = status.url,
       let installed = load(from: verifiedURL) {
      return (installed, nil, status.source)
    }
    return (loadFromBundle(), status.warning, "bundle")
  }

  static func loadFromBundle() -> LekhBinaryLexicon? {
    guard let url = Bundle.main.url(forResource: "runtime-suggestions", withExtension: "lkb"),
          let lexicon = load(from: url) else { return nil }
    return lexicon
  }

  private static func load(from url: URL) -> LekhBinaryLexicon? {
    guard let mapped = try? Data(contentsOf: url, options: [.mappedIfSafe]) else { return nil }
    return LekhBinaryLexicon(data: mapped)
  }

  init?(data: Data) {
    guard data.count >= 64 else { return nil }
    guard Array(data.prefix(8)) == Self.magic else { return nil }
    let version = Self.u32(data, 8)
    let headerSize = Self.u32(data, 12)
    guard version == 1, headerSize == 64 else { return nil }

    self.data = data
    self.entryCount = Int(Self.u32(data, 16))
    self.entryOffset = Int(Self.u32(data, 20))
    self.entryStride = Int(Self.u32(data, 24))
    self.prefixCount = Int(Self.u32(data, 28))
    self.prefixOffset = Int(Self.u32(data, 32))
    self.prefixStride = Int(Self.u32(data, 36))
    self.refCount = Int(Self.u32(data, 40))
    self.refOffset = Int(Self.u32(data, 44))
    self.stringOffset = Int(Self.u32(data, 48))
    self.stringBytes = Int(Self.u32(data, 52))
    self.maxPrefixLength = Int(Self.u32(data, 56))

    guard entryStride >= 24,
          prefixStride >= 16,
          maxPrefixLength >= 1,
          maxPrefixLength <= 12,
          entryOffset >= 64,
          entryOffset <= prefixOffset,
          prefixOffset <= refOffset,
          refOffset <= stringOffset,
          Self.sectionFits(offset: entryOffset, count: entryCount, stride: entryStride, fileBytes: data.count),
          Self.sectionFits(offset: prefixOffset, count: prefixCount, stride: prefixStride, fileBytes: data.count),
          Self.sectionFits(offset: refOffset, count: refCount, stride: 4, fileBytes: data.count),
          Self.sectionFits(offset: stringOffset, count: stringBytes, stride: 1, fileBytes: data.count) else {
      return nil
    }
  }

  func rows(for normalizedInput: String, exactOnly: Bool, limit: Int) -> [NativeCandidateRow] {
    let normalized = LekhNativeEngineClient.normalize(normalizedInput)
    guard !normalized.isEmpty, limit > 0 else { return [] }
    let exactRows = lookup(key: normalized, exactOnly: true, limit: limit)
    if exactOnly {
      return exactRows
    }

    let prefixKey = normalized.count > maxPrefixLength
      ? String(normalized.prefix(maxPrefixLength))
      : normalized
    let prefixRows = lookup(key: prefixKey, exactOnly: false, limit: max(limit * 2, 16))
      .filter { $0.romanized.hasPrefix(normalized) }
    if !prefixRows.isEmpty {
      return Self.ranked(prefixRows, limit: limit)
    }

    var tolerantRows: [NativeCandidateRow] = []
    var seen = Set<String>()
    for key in LekhRomanizationTolerance.keys(for: normalized) {
      let tolerantPrefix = key.count > maxPrefixLength ? String(key.prefix(maxPrefixLength)) : key
      for row in lookup(key: tolerantPrefix, exactOnly: false, limit: max(limit * 4, 16)) {
        let identity = "\(row.romanized)\u{0}\(row.unicode)"
        guard !seen.contains(identity) else { continue }
        guard LekhRomanizationTolerance.matches(input: normalized, candidate: row.romanized) else { continue }
        seen.insert(identity)
        tolerantRows.append(row)
      }
    }
    return Self.ranked(tolerantRows, limit: limit)
  }

  func allRows() -> [NativeCandidateRow] {
    guard entryCount > 0 else { return [] }
    var rows: [NativeCandidateRow] = []
    rows.reserveCapacity(entryCount)
    for index in 0..<entryCount {
      if let row = entry(at: index) {
        rows.append(row)
      }
    }
    return rows
  }

  private func lookup(key: String, exactOnly: Bool, limit: Int) -> [NativeCandidateRow] {
    guard let prefixIndex = findPrefix(key) else { return [] }
    let rowOffset = prefixOffset + prefixIndex * prefixStride
    let startRef = Int(Self.u32(data, rowOffset + 8))
    let count = Int(Self.u32(data, rowOffset + 12))
    var output: [NativeCandidateRow] = []
    output.reserveCapacity(min(limit, count))
    for offset in 0..<count {
      guard output.count < limit else { break }
      let entryIndexOffset = refOffset + (startRef + offset) * 4
      guard entryIndexOffset + 4 <= data.count else { break }
      let entryIndex = Int(Self.u32(data, entryIndexOffset))
      guard let row = entry(at: entryIndex) else { continue }
      if exactOnly, row.romanized != key { continue }
      output.append(row)
    }
    return output
  }

  private func findPrefix(_ key: String) -> Int? {
    var low = 0
    var high = prefixCount - 1
    while low <= high {
      let mid = (low + high) / 2
      guard let current = prefix(at: mid) else { return nil }
      if current == key {
        return mid
      }
      if current < key {
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return nil
  }

  private func prefix(at index: Int) -> String? {
    let offset = prefixOffset + index * prefixStride
    guard offset + prefixStride <= data.count else { return nil }
    return string(offset: Int(Self.u32(data, offset)), length: Int(Self.u16(data, offset + 4)))
  }

  private func entry(at index: Int) -> NativeCandidateRow? {
    guard index >= 0, index < entryCount else { return nil }
    let offset = entryOffset + index * entryStride
    guard offset + entryStride <= data.count else { return nil }
    guard let romanized = string(offset: Int(Self.u32(data, offset)), length: Int(Self.u16(data, offset + 4))),
          let unicode = string(offset: Int(Self.u32(data, offset + 8)), length: Int(Self.u16(data, offset + 6))) else {
      return nil
    }
    let confidence = Double(Self.u16(data, offset + 12)) / 1000
    let kind = NativeCandidateKind(rawValue: data[offset + 14]) ?? .unknown
    let priority = Int(Self.u32(data, offset + 16))
    return NativeCandidateRow(
      romanized: romanized,
      unicode: unicode,
      confidence: confidence,
      priority: priority,
      kind: kind
    )
  }

  private func string(offset relativeOffset: Int, length: Int) -> String? {
    guard relativeOffset >= 0,
          length >= 0,
          relativeOffset + length <= stringBytes else {
      return nil
    }
    let start = stringOffset + relativeOffset
    let end = start + length
    guard end <= data.count else { return nil }
    return String(data: data.subdata(in: start..<end), encoding: .utf8)
  }

  private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
    data.withUnsafeBytes { rawBuffer in
      UInt16(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt16.self))
    }
  }

  private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
    data.withUnsafeBytes { rawBuffer in
      UInt32(littleEndian: rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self))
    }
  }

  private static func sectionFits(offset: Int, count: Int, stride: Int, fileBytes: Int) -> Bool {
    guard offset >= 64, count >= 0, stride > 0 else { return false }
    let byteCount = UInt64(count) * UInt64(stride)
    let end = UInt64(offset) + byteCount
    return end <= UInt64(fileBytes)
  }

  private static func rangeFits(offset: Int, length: Int, limit: Int) -> Bool {
    guard offset >= 0, length >= 0 else { return false }
    return UInt64(offset) + UInt64(length) <= UInt64(limit)
  }

  private static func validateEntries(
    _ data: Data,
    entryCount: Int,
    entryOffset: Int,
    entryStride: Int,
    stringBytes: Int
  ) -> Bool {
    for index in 0..<entryCount {
      let offset = entryOffset + index * entryStride
      let romanOffset = Int(u32(data, offset))
      let romanLength = Int(u16(data, offset + 4))
      let unicodeLength = Int(u16(data, offset + 6))
      let unicodeOffset = Int(u32(data, offset + 8))
      guard rangeFits(offset: romanOffset, length: romanLength, limit: stringBytes),
            rangeFits(offset: unicodeOffset, length: unicodeLength, limit: stringBytes) else {
        return false
      }
    }
    return true
  }

  private static func validatePrefixes(
    _ data: Data,
    prefixCount: Int,
    prefixOffset: Int,
    prefixStride: Int,
    refCount: Int,
    stringBytes: Int
  ) -> Bool {
    for index in 0..<prefixCount {
      let offset = prefixOffset + index * prefixStride
      let prefixStringOffset = Int(u32(data, offset))
      let prefixStringLength = Int(u16(data, offset + 4))
      let startRef = Int(u32(data, offset + 8))
      let count = Int(u32(data, offset + 12))
      guard rangeFits(offset: prefixStringOffset, length: prefixStringLength, limit: stringBytes),
            rangeFits(offset: startRef, length: count, limit: refCount) else {
        return false
      }
    }
    return true
  }

  private static func validateRefs(
    _ data: Data,
    refCount: Int,
    refOffset: Int,
    entryCount: Int
  ) -> Bool {
    for index in 0..<refCount {
      let offset = refOffset + index * 4
      guard offset + 4 <= data.count else { return false }
      guard Int(u32(data, offset)) < entryCount else { return false }
    }
    return true
  }

  private static func ranked(_ rows: [NativeCandidateRow], limit: Int) -> [NativeCandidateRow] {
    rows.sorted {
      if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
      if $0.priority != $1.priority { return $0.priority < $1.priority }
      if $0.romanized != $1.romanized { return $0.romanized < $1.romanized }
      return $0.unicode < $1.unicode
    }
    .prefix(limit)
    .map { $0 }
  }
}

private enum LekhRomanizationTolerance {
  static func keys(for value: String) -> [String] {
    let loose = loose(value)
    let canonicalValue = canonical(loose)
    var output = OrderedSet()
    output.append(loose)
    output.append(loose.replacingOccurrences(of: " ", with: ""))
    output.append(canonicalValue)
    for (left, right) in [
      ("aa", "a"), ("ee", "i"), ("ii", "i"), ("oo", "u"), ("uu", "u"),
      ("chh", "ch"), ("chh", "x"), ("ch", "x"), ("sh", "s"),
      ("w", "v"), ("b", "v")
    ] {
      output.append(canonicalValue.replacingOccurrences(of: left, with: right))
      output.append(canonicalValue.replacingOccurrences(of: right, with: left))
    }
    return output.values.filter { !$0.isEmpty }
  }

  static func matches(input: String, candidate: String) -> Bool {
    let left = canonical(input)
    let right = canonical(candidate)
    if right == left || right.hasPrefix(left) { return true }
    guard left.count >= 4 else { return false }
    let distance = weightedDistance(left, right)
    let denominator = Double(max(left.count, right.count, 1))
    let similarity = 1 - distance / denominator
    return similarity >= (left.count <= 4 ? 0.84 : 0.78)
  }

  static func canonical(_ value: String) -> String {
    let normalized = loose(value)
    let direct: [String: String] = [
      "gharmaa": "gharma",
      "ghar maa": "gharma",
      "chha": "cha",
      "xa": "cha",
      "chhaina": "chaina",
      "xaina": "chaina",
      "chhan": "chan",
      "xan": "chan",
      "chhu": "chu",
      "xu": "chu",
      "chhau": "chau",
      "xau": "chau",
      "hunxa": "huncha",
      "parxa": "parcha",
      "garxa": "garcha",
      "garxu": "garchu",
      "vato": "bato",
      "baato": "bato",
      "bato": "bato"
    ]
    if let mapped = direct[normalized] { return mapped }
    return normalized
      .replacingOccurrences(of: #"\s+(maa|ma)$"#, with: "ma", options: .regularExpression)
      .replacingOccurrences(of: "aa", with: "a")
      .replacingOccurrences(of: "ee", with: "i")
      .replacingOccurrences(of: "ii", with: "i")
      .replacingOccurrences(of: "oo", with: "u")
      .replacingOccurrences(of: "uu", with: "u")
      .replacingOccurrences(of: "chh", with: "ch")
      .replacingOccurrences(of: "x", with: "ch")
      .replacingOccurrences(of: "sh", with: "s")
      .replacingOccurrences(of: "w", with: "v")
      .replacingOccurrences(of: " ", with: "")
  }

  private static func loose(_ value: String) -> String {
    value
      .precomposedStringWithCanonicalMapping
      .lowercased()
      .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
  }

  private static func weightedDistance(_ left: String, _ right: String) -> Double {
    let a = Array(left)
    let b = Array(right)
    var previous = Array(stride(from: 0.0, through: Double(b.count), by: 1.0))
    for i in 1...a.count {
      var current = Array(repeating: 0.0, count: b.count + 1)
      current[0] = Double(i)
      for j in 1...b.count {
        let substitution = previous[j - 1] + substitutionCost(a[i - 1], b[j - 1])
        let deletion = previous[j] + deletionCost(a[i - 1])
        let insertion = current[j - 1] + deletionCost(b[j - 1])
        current[j] = min(substitution, deletion, insertion)
      }
      previous = current
    }
    return previous[b.count]
  }

  private static func substitutionCost(_ left: Character, _ right: Character) -> Double {
    if left == right { return 0 }
    let pair = Set([left, right])
    if pair.contains("b") && pair.contains("v") { return 0.25 }
    if pair.contains("w") && pair.contains("v") { return 0.25 }
    if pair.contains("s") && pair.contains("h") { return 0.55 }
    if pair.contains("t") && pair.contains("d") { return 0.6 }
    if pair.contains("a") && pair.contains("e") { return 0.7 }
    if pair.contains("i") && pair.contains("e") { return 0.55 }
    if pair.contains("u") && pair.contains("o") { return 0.55 }
    return 1
  }

  private static func deletionCost(_ character: Character) -> Double {
    Set("aeiou").contains(character) ? 0.45 : 1
  }

  private struct OrderedSet {
    private(set) var values: [String] = []
    private var seen = Set<String>()

    mutating func append(_ value: String) {
      guard !seen.contains(value) else { return }
      seen.insert(value)
      values.append(value)
    }
  }
}

public final class LekhNativeEngineClient: LekhEngineClient {
  private struct RuntimeSuggestionPack: Decodable {
    let words: [RuntimeSuggestionRow]
    let phrases: [RuntimeSuggestionRow]
    let proofread: [RuntimeProofreadRow]?
    let names: [RuntimeSuggestionRow]
    let nextContexts: [RuntimeNextContextRow]?
  }

  private struct RuntimeSuggestionRow: Decodable {
    let romanized: String
    let unicode: String
    let confidence: Double?
    let quality: String?
  }

  private struct RuntimeProofreadRow: Decodable {
    let error: String
    let correction: String
    let type: String?
    let confidence: Double?
    let quality: String?
  }

  private struct RuntimeNextContextRow: Decodable {
    let context: String
    let next: String
    let confidence: Double?
    let quality: String?
  }

  private struct NativeNextContextRow {
    let next: String
    let confidence: Double
  }

  private struct NativeProofreadRow {
    let error: String
    let correction: String
    let type: String
    let confidence: Double
    let priority: Int
  }

  private var buffers: [String: String] = [:]
  private var lastCommittedWordsBySession: [String: String] = [:]
  private var lastCommittedInputsBySession: [String: String] = [:]
  private var binaryLexicon: LekhBinaryLexicon?
  private let lexiconLock = NSLock()
  private var reverseCandidatesCache: [String: [String]]?
  private var reversePrefixCache: [String: [String]]?
  private var packWatcher: LekhDictionaryPackWatcher?
  private var packSecurityWarning: String?
  private let fallbackRows: [NativeCandidateRow]
  private let proofreadRowsByError: [String: [NativeProofreadRow]]
  private let nextContextsByPreviousInput: [String: [NativeNextContextRow]]
  private let exactCandidates: [String: [NativeCandidateRow]]
  private let prefixBuckets: [String: [NativeCandidateRow]]
  private let candidateLimit: Int
  private let contractWarning: String?
  private let tokenCompletionIndex: LekhTokenCompletionIndex
  private let userLexicon = LekhUserLexiconStore()

  public init() {
    let contract = Self.loadEngineContract()
    let loadResult = LekhBinaryLexicon.loadPreferred()
    let binaryLexicon = loadResult.lexicon
    let runtimePack = Self.loadRuntimePack()
    let rows = binaryLexicon == nil ? Self.loadJsonRows(pack: runtimePack) : []
    let proofreadRows = Self.loadProofreadRows(pack: runtimePack)
    var exact: [String: [NativeCandidateRow]] = [:]
    var buckets: [String: [NativeCandidateRow]] = [:]
    var proofread: [String: [NativeProofreadRow]] = [:]

    for row in rows {
      exact[row.romanized, default: []].append(row)
      let key = Self.bucketKey(row.romanized)
      buckets[key, default: []].append(row)
    }
    for row in proofreadRows {
      proofread[row.error, default: []].append(row)
    }

    self.binaryLexicon = binaryLexicon
    self.packSecurityWarning = loadResult.warning
    self.fallbackRows = rows
    self.proofreadRowsByError = proofread.mapValues { rows in
      rows.sorted {
        if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
        return $0.priority < $1.priority
      }
    }
    self.nextContextsByPreviousInput = Self.buildNextContextIndex(runtimePack?.nextContexts ?? [])
    self.exactCandidates = exact.mapValues { Self.ranked($0, limit: 8) }
    self.prefixBuckets = buckets.mapValues { Self.ranked($0, limit: 64) }
    self.candidateLimit = contract.maximumVisible
    self.contractWarning = contract.warning
    self.tokenCompletionIndex = LekhTokenCompletionIndex.loadDefault()
    let reverse = Self.buildReverseCandidates(rows: binaryLexicon?.allRows() ?? rows)
    self.reverseCandidatesCache = reverse
    self.reversePrefixCache = Self.buildReversePrefixes(reverse)
    if LekhDictionaryPackVerifier.hasUsableEmbeddedPublicKey() {
      let watcher = LekhDictionaryPackWatcher { [weak self] in
        self?.reloadBinaryLexicon()
      }
      self.packWatcher = watcher
      watcher.start()
    } else {
      self.packWatcher = nil
    }
  }

  private func currentBinaryLexicon() -> LekhBinaryLexicon? {
    lexiconLock.lock()
    defer { lexiconLock.unlock() }
    return binaryLexicon
  }

  private func reloadBinaryLexicon() {
    let refreshed = LekhBinaryLexicon.loadPreferred()
    let reverse = refreshed.lexicon.map { Self.buildReverseCandidates(rows: $0.allRows()) }
    let prefixes = reverse.map(Self.buildReversePrefixes)
    lexiconLock.lock()
    if let lexicon = refreshed.lexicon {
      binaryLexicon = lexicon
      reverseCandidatesCache = reverse
      reversePrefixCache = prefixes
    }
    packSecurityWarning = refreshed.warning
    lexiconLock.unlock()
  }

  private func reverseCandidatesSnapshot() -> (
    exact: [String: [String]],
    prefixes: [String: [String]]
  ) {
    lexiconLock.lock()
    if let exact = reverseCandidatesCache,
       let prefixes = reversePrefixCache {
      lexiconLock.unlock()
      return (exact, prefixes)
    }
    let lexicon = binaryLexicon
    lexiconLock.unlock()

    let built = Self.buildReverseCandidates(rows: lexicon?.allRows() ?? fallbackRows)
    let prefixes = Self.buildReversePrefixes(built)
    lexiconLock.lock()
    reverseCandidatesCache = built
    reversePrefixCache = prefixes
    lexiconLock.unlock()
    return (built, prefixes)
  }

  public func processKey(_ key: String, sessionId: String, mode: LekhNativeTypingMode) -> LekhInputDecision {
    if key == " " {
      let rawBuffer = buffers[sessionId] ?? ""
      if !rawBuffer.isEmpty {
        observeCommit(
          sessionId: sessionId,
          rawBuffer: rawBuffer,
          chosenOutput: rawBuffer,
          allowPersonalization: false
        )
      }
      buffers[sessionId] = ""
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: rawBuffer.isEmpty ? " " : "\(rawBuffer) ",
        candidates: [],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }

    if key == "\r" || key == "\n" || key == "\t" {
      let rawBuffer = buffers[sessionId] ?? ""
      guard !rawBuffer.isEmpty else { return .passThrough }
      observeCommit(
        sessionId: sessionId,
        rawBuffer: rawBuffer,
        chosenOutput: rawBuffer,
        allowPersonalization: false
      )
      buffers[sessionId] = ""
      // Direct engine clients must preserve the delimiter exactly once. The
      // IMK controller normally owns Return/Tab host propagation, but this
      // fallback path must remain lossless if a host reaches the engine.
      let suffix = key == "\t" ? "\t" : "\n"
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: "\(rawBuffer)\(suffix)",
        candidates: [],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }

    if key == "\u{1b}" {
      buffers[sessionId] = ""
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: nil,
        candidates: [],
        shouldCancel: true,
        shouldPassThrough: false
      )
    }

    if key == "\u{7f}" {
      let current = buffers[sessionId] ?? ""
      buffers[sessionId] = String(current.dropLast())
      return decision(for: buffers[sessionId] ?? "", sessionId: sessionId, mode: mode)
    }

    // Some documented Option-layer mappings are synthesized as a short
    // Devanagari sequence (for example virama + ra). Admit the complete safe
    // sequence atomically so the physical Option event is never partially
    // consumed or returned to the host as an unrelated symbol.
    if shouldAppendToComposition(key) {
      let current = buffers[sessionId] ?? ""
      // Reject before mutating the buffer or starting candidate, proofread, or
      // neural work. The controller will finalize the prior raw composition
      // and return this complete grapheme to the host; direct engine clients
      // receive the same lossless pass-through signal.
      guard !LekhActiveCompositionWorkBound.wouldOverflow(
        current: current,
        appending: key
      ) else {
        return .passThrough
      }
      let updated = current + key
      buffers[sessionId] = updated
      return decision(for: updated, sessionId: sessionId, mode: mode)
    }

    if key.unicodeScalars.count == 1,
       let scalar = key.unicodeScalars.first,
       CharacterSet.punctuationCharacters.contains(scalar) {
      let rawBuffer = buffers[sessionId] ?? ""
      if !rawBuffer.isEmpty {
        observeCommit(
          sessionId: sessionId,
          rawBuffer: rawBuffer,
          chosenOutput: rawBuffer,
          allowPersonalization: false
        )
      }
      buffers[sessionId] = ""
      let punctuation = smartPunctuation(for: key, mode: mode)
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: "\(rawBuffer)\(punctuation)",
        candidates: [],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }

    return .passThrough
  }

  public func hasComposition(sessionId: String) -> Bool {
    !(buffers[sessionId] ?? "").isEmpty
  }

  public func rawBuffer(sessionId: String) -> String {
    buffers[sessionId] ?? ""
  }

  public func normalizedPunctuation(_ key: String, mode: LekhNativeTypingMode) -> String {
    smartPunctuation(for: key, mode: mode)
  }

  public func observeCommit(
    sessionId: String,
    rawInput: String,
    chosenOutput: String,
    allowPersonalization: Bool
  ) {
    observeCommit(
      sessionId: sessionId,
      rawBuffer: rawInput,
      chosenOutput: chosenOutput,
      allowPersonalization: allowPersonalization
    )
  }

  /// Completion acceptance is useful interaction evidence, but it is not an
  /// exact transliteration mapping. Storing `lekh -> लेखहरू` in the user
  /// lexicon turns a future optional suffix into solid marked text and makes
  /// the ghost disappear. Until a separate completion-preference model exists,
  /// keep those events out of exact-token personalization.
  public func mayPersonalizeExplicitChoice(
    rawInput: String,
    chosenOutput: String,
    mode: LekhNativeTypingMode
  ) -> Bool {
    if mode == .romanizedRomanized,
       Self.normalize(rawInput) == Self.normalize(chosenOutput) {
      // Case-only acceptance is presentation, not a learned spelling mapping.
      // Persisting LEKH→LEKH under the normalized key `lekh` can later place an
      // uppercase candidate ahead of lowercase input.
      return false
    }
    return !isVerifiedTokenCompletionCandidate(
      sourceInput: rawInput,
      chosenOutput: chosenOutput,
      mode: mode
    )
  }

  public func forgetCandidate(sessionId: String, chosenOutput: String) {
    let normalized = Self.normalize(buffers[sessionId] ?? "")
    guard !normalized.isEmpty else { return }
    userLexicon.forget(normalizedInput: normalized, chosenOutput: chosenOutput)
  }

  private func decision(for rawBuffer: String, sessionId: String, mode: LekhNativeTypingMode) -> LekhInputDecision {
    let buffer = rawBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !buffer.isEmpty else {
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: nil,
        candidates: [],
        shouldCancel: true,
        shouldPassThrough: false
      )
    }
    let candidates = candidatesFor(buffer, sessionId: sessionId, mode: mode)
    let markedText = previewText(rawBuffer: rawBuffer, candidates: candidates, mode: mode)
    let inlineSuggestion = inlineSuggestion(
      rawBuffer: buffer,
      markedText: markedText,
      candidates: candidates,
      mode: mode
    )
    let neuralTailEligible = isNeuralTailEligible(
      rawBuffer: rawBuffer,
      sessionId: sessionId,
      mode: mode
    )
    return LekhInputDecision(
      handled: true,
      markedText: markedText,
      committedText: nil,
      candidates: candidates,
      inlineSuggestion: inlineSuggestion,
      neuralTailEligible: neuralTailEligible,
      shouldCancel: false,
      shouldPassThrough: false
    )
  }

  private func isNeuralTailEligible(
    rawBuffer: String,
    sessionId: String,
    mode: LekhNativeTypingMode
  ) -> Bool {
    let normalized = Self.normalize(rawBuffer)
    guard mode == .romanizedTraditional,
          normalized.count >= 3,
          normalized.count <= 64,
          normalized.range(of: #"^[a-z][a-z'-]*$"#, options: .regularExpression) != nil,
          LekhMixedScriptPolicy.preserveCandidate(for: rawBuffer) == nil,
          LekhRomanizedComposer.canonicalCandidates(for: normalized).isEmpty,
          runtimeRows(for: normalized, exactOnly: true, limit: 1).isEmpty,
          personalizedCandidates(for: normalized, mode: mode).isEmpty else {
      return false
    }
    return true
  }

  private func previewText(
    rawBuffer: String,
    candidates: [String],
    mode: LekhNativeTypingMode
  ) -> String {
    switch mode {
    case .romanizedTraditional:
      let normalized = Self.normalize(rawBuffer)
      return candidates.first ?? ruleCandidates(for: normalized, mode: mode).first ?? rawBuffer
    case .traditionalRomanized:
      return LekhDevanagariRomanizer.romanize(rawBuffer)
    case .romanizedRomanized, .traditionalTraditional:
      return rawBuffer
    }
  }

  private func inlineSuggestion(
    rawBuffer: String,
    markedText: String,
    candidates: [String],
    mode: LekhNativeTypingMode
  ) -> LekhInlineSuggestion? {
    let normalized = Self.normalize(rawBuffer)
    guard normalized.count >= 4, !markedText.isEmpty else { return nil }

    let markedHasDevanagari = markedText.range(
      of: #"\p{Devanagari}"#,
      options: .regularExpression
    ) != nil
    var completionCandidates: [String] = []

    if mode == .romanizedTraditional || mode == .romanizedRomanized {
      completionCandidates.append(contentsOf: tokenCompletionIndex.candidates(for: normalized).compactMap {
        if mode == .romanizedTraditional { return $0.target }
        return Self.casePreservingRomanizedCompletion(
          source: $0.source,
          rawPrefix: rawBuffer
        )
      })
    } else {
      // Traditional modes have no trusted source-side prefix score. They may
      // expose a suffix only when an already-ranked, same-script candidate is
      // a literal extension of the visible composition.
      completionCandidates.append(contentsOf: candidates)
    }

    for candidate in Self.unique(completionCandidates, limit: 64) {
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        .precomposedStringWithCanonicalMapping
      let candidateHasDevanagari = trimmed.range(
        of: #"\p{Devanagari}"#,
        options: .regularExpression
      ) != nil
      guard trimmed != markedText,
            !Self.containsWhitespace(trimmed),
            candidateHasDevanagari == markedHasDevanagari,
            trimmed.hasPrefix(markedText) else { continue }
      let suffix = String(trimmed.dropFirst(markedText.count))
      guard !suffix.isEmpty, suffix.count <= 16 else { continue }
      return LekhInlineSuggestion(suffix: suffix, acceptedText: trimmed)
    }
    return nil
  }

  private func candidatesFor(_ buffer: String, sessionId: String, mode: LekhNativeTypingMode) -> [String] {
    let normalized = Self.normalize(buffer)
    if mode == .traditionalTraditional {
      return traditionalCandidates(for: buffer, romanizedOutput: false)
    }
    if mode == .traditionalRomanized {
      return traditionalCandidates(for: buffer, romanizedOutput: true)
    }

    var currentTokenCandidates: [String] = []
    let preserved = LekhMixedScriptPolicy.preserveCandidate(for: buffer)
    if let preserved {
      currentTokenCandidates.append(preserved)
    }
    let personalized = personalizedCandidates(for: normalized, mode: mode)
    currentTokenCandidates.append(contentsOf: personalized)
    let canonical = mode == .romanizedTraditional
      ? LekhRomanizedComposer.canonicalCandidates(for: normalized)
      : []
    currentTokenCandidates.append(contentsOf: canonical)
    let exactRuntime = runtimeRows(for: normalized, exactOnly: true, limit: 8)
    if !exactRuntime.isEmpty {
      currentTokenCandidates.append(contentsOf: exactRuntime.map {
        mode == .romanizedRomanized ? $0.romanized : $0.unicode
      })
    }

    let deterministicRuleCandidates = ruleCandidates(for: normalized, mode: mode)
    if preserved == nil,
       personalized.isEmpty,
       canonical.isEmpty,
       exactRuntime.isEmpty {
      currentTokenCandidates.append(contentsOf: deterministicRuleCandidates)
    }
    // Completion is a separate, provenance-checked, explicit-accept tier.
    // Runtime transliteration/context rows are intentionally ineligible: their
    // corpus confidence is not a calibrated completion-quality probability.
    let completionCandidates = tokenCompletionIndex.candidates(for: normalized).compactMap {
      if mode == .romanizedTraditional { return $0.target }
      return Self.casePreservingRomanizedCompletion(source: $0.source, rawPrefix: buffer)
    }

    // Every Romanized→Romanized source tier (personal, runtime, rule, context,
    // and completion) is stored in a normalized artifact form. Apply the
    // user's unambiguous casing pattern once at the boundary before anything
    // becomes visible or explicitly acceptable. This prevents an exact row
    // such as `lekh` from silently surviving beside a safe `LEKHHARU`
    // completion and rewriting raw `LEKH` when clicked.
    let visibleCurrentTokenCandidates = mode == .romanizedRomanized
      ? currentTokenCandidates.compactMap {
          Self.casePreservingRomanizedCandidate(source: $0, rawInput: buffer)
        }
      : currentTokenCandidates
    let visibleCompletionCandidates = mode == .romanizedRomanized
      ? completionCandidates.compactMap {
          Self.casePreservingRomanizedCandidate(source: $0, rawInput: buffer)
        }
      : completionCandidates

    let primary = Self.unique(
      visibleCurrentTokenCandidates.filter {
        Self.isAllowedActiveTokenCandidate(input: normalized, candidate: $0, mode: mode)
      },
      limit: 16
    )
    let primarySet = Set(primary.map { $0.precomposedStringWithCanonicalMapping })
    let secondary = Self.unique(
      visibleCompletionCandidates.filter {
        Self.isAllowedActiveTokenCandidate(input: normalized, candidate: $0, mode: mode) &&
          !primarySet.contains($0.precomposedStringWithCanonicalMapping)
      },
      limit: 16
    )
    let rankedPrimary = userLexicon.rankCandidates(
      primary,
      previousOutput: lastCommittedWordsBySession[sessionId],
      limit: primary.count
    )
    let rankedSecondary = userLexicon.rankCandidates(
      secondary,
      previousOutput: lastCommittedWordsBySession[sessionId],
      limit: secondary.count
    )
    return Array(Self.unique(rankedPrimary + rankedSecondary, limit: candidateLimit).prefix(candidateLimit))
  }

  private func personalizedCandidates(
    for normalized: String,
    mode: LekhNativeTypingMode
  ) -> [String] {
    userLexicon.candidates(
      for: normalized,
      romanizedOutput: mode == .romanizedRomanized
    ).filter {
      // Filter legacy rows learned before completion provenance was separated.
      // This is intentionally read-only on the typing path; no SQLite cleanup
      // or write is permitted per keystroke.
      !isVerifiedTokenCompletionCandidate(
        sourceInput: normalized,
        chosenOutput: $0,
        mode: mode
      )
    }
  }

  private func isVerifiedTokenCompletionCandidate(
    sourceInput: String,
    chosenOutput: String,
    mode: LekhNativeTypingMode
  ) -> Bool {
    guard mode == .romanizedTraditional || mode == .romanizedRomanized else {
      return false
    }
    let normalizedInput = Self.normalize(sourceInput)
    let normalizedOutput = chosenOutput.trimmingCharacters(in: .whitespacesAndNewlines)
      .precomposedStringWithCanonicalMapping
    guard !normalizedInput.isEmpty, !normalizedOutput.isEmpty else { return false }
    return tokenCompletionIndex.candidates(for: normalizedInput).contains { row in
      let output: String?
      if mode == .romanizedTraditional {
        output = row.target
      } else {
        // Completion provenance is case-insensitive in Roman helper mode.
        // A legacy `Lekhharu` row is the same completion artifact as
        // `lekhharu` and must not become an exact-token learned mapping.
        output = Self.normalize(row.source) == Self.normalize(normalizedOutput)
          ? normalizedOutput
          : nil
      }
      return output?.precomposedStringWithCanonicalMapping == normalizedOutput
    }
  }

  /// Romanized helper completions may extend the user's casing, but may never
  /// rewrite it. Lowercase, ALL CAPS, and leading-capital prefixes have an
  /// unambiguous deterministic continuation; irregular mixed case fails closed
  /// instead of exposing a case-changing candidate or teaching it as an exact
  /// personalization mapping.
  private static func casePreservingRomanizedCompletion(
    source: String,
    rawPrefix: String
  ) -> String? {
    let prefix = rawPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
      .precomposedStringWithCanonicalMapping
    let normalizedPrefix = normalize(prefix)
    guard !prefix.isEmpty,
          source.hasPrefix(normalizedPrefix),
          source != normalizedPrefix,
          let completion = casePreservingRomanizedCandidate(
            source: source,
            rawInput: prefix
          ) else {
      return nil
    }

    guard completion.hasPrefix(prefix), completion != prefix else { return nil }
    return completion
  }

  private static func casePreservingRomanizedCandidate(
    source: String,
    rawInput: String
  ) -> String? {
    let input = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
      .precomposedStringWithCanonicalMapping
    guard !input.isEmpty,
          input.unicodeScalars.contains(where: {
            (65...90).contains(Int($0.value)) || (97...122).contains(Int($0.value))
          }) else {
      return nil
    }

    let normalizedSource = normalize(source)
    guard !normalizedSource.isEmpty else { return nil }
    if input == input.lowercased() {
      return normalizedSource
    }
    if input == input.uppercased() {
      return normalizedSource.uppercased()
    }
    if let first = input.first,
              String(first) == String(first).uppercased(),
              String(input.dropFirst()) == String(input.dropFirst()).lowercased() {
      return String(normalizedSource.prefix(1)).uppercased() + normalizedSource.dropFirst()
    }
    return nil
  }

  private static func isAllowedActiveTokenCandidate(
    input: String,
    candidate: String,
    mode: LekhNativeTypingMode
  ) -> Bool {
    let trimmedInput = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedCandidate = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      .precomposedStringWithCanonicalMapping
    guard !trimmedCandidate.isEmpty,
          trimmedCandidate.count <= 64,
          trimmedCandidate.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
      return false
    }
    if !containsWhitespace(trimmedInput), containsWhitespace(trimmedCandidate) {
      return false
    }

    let hasDevanagari = trimmedCandidate.range(
      of: #"\p{Devanagari}"#,
      options: .regularExpression
    ) != nil
    let hasLatin = trimmedCandidate.range(of: #"[A-Za-z]"#, options: .regularExpression) != nil
    switch mode {
    case .romanizedTraditional:
      if Self.normalize(trimmedCandidate) == Self.normalize(trimmedInput),
         LekhMixedScriptPolicy.preserveCandidate(for: trimmedCandidate) != nil {
        return true
      }
      return hasDevanagari && !hasLatin
    case .romanizedRomanized:
      return !hasDevanagari
    case .traditionalTraditional:
      return hasDevanagari || trimmedCandidate == trimmedInput
    case .traditionalRomanized:
      return !hasDevanagari
    }
  }

  private func runtimeRows(for normalized: String, exactOnly: Bool, limit: Int) -> [NativeCandidateRow] {
    let minimumConfidence = exactOnly
      ? 0
      : 0.35 + (LekhNativePreferences.transliterationStrictness * 0.50)
    if let binaryLexicon = currentBinaryLexicon() {
      return binaryLexicon.rows(for: normalized, exactOnly: exactOnly, limit: limit * 2)
        .filter { $0.confidence >= minimumConfidence }
        .prefix(limit)
        .map { $0 }
    }
    if exactOnly {
      return exactCandidates[normalized] ?? []
    }
    let bucketRows = prefixBuckets[Self.bucketKey(normalized)] ?? []
    return bucketRows
      .filter { $0.romanized.hasPrefix(normalized) }
      .filter { $0.confidence >= minimumConfidence }
      .prefix(limit)
      .map { $0 }
  }

  private func contextualTokenCandidates(
    for normalized: String,
    sessionId: String,
    mode: LekhNativeTypingMode
  ) -> [String] {
    guard LekhNativePreferences.nextWordPredictionEnabled,
          !normalized.contains(" "),
          let previous = lastCommittedInputsBySession[sessionId],
          let rows = nextContextsByPreviousInput[previous] else {
      return []
    }
    let matching = rows
      .filter { $0.next.hasPrefix(normalized) }
      .sorted {
        if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
        return $0.next < $1.next
      }
      .prefix(4)
    var output: [String] = []
    for row in matching {
      if mode == .romanizedRomanized {
        output.append(row.next)
      } else {
        output.append(contentsOf: runtimeRows(for: row.next, exactOnly: true, limit: 2).map(\.unicode))
      }
    }
    return Self.unique(output, limit: 4)
  }

  private func ruleCandidates(for normalized: String, mode: LekhNativeTypingMode) -> [String] {
    guard mode == .romanizedTraditional || mode == .romanizedRomanized else { return [] }
    guard normalized.range(of: #"[a-z]"#, options: .regularExpression) != nil else { return [] }
    if mode == .romanizedRomanized {
      return [normalized]
    }

    let candidates = LekhRomanizedComposer.composePhraseCandidates(normalized)
    return Self.unique(candidates.filter { $0 != normalized }, limit: 8)
  }

  private func traditionalCandidates(for buffer: String, romanizedOutput: Bool) -> [String] {
    let normalized = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
      .precomposedStringWithCanonicalMapping
    guard !normalized.isEmpty else { return [] }
    var output: [String] = []
    let reverseIndex = reverseCandidatesSnapshot()
    let reverseCandidates = reverseIndex.exact
    if romanizedOutput {
      let deterministic = LekhDevanagariRomanizer.romanize(normalized)
      if !deterministic.isEmpty {
        output.append(deterministic)
      }
    } else {
      output.append(normalized)
    }
    output.append(contentsOf: LekhRomanizedComposer.canonicalTraditionalCandidates(
      for: normalized,
      romanizedOutput: romanizedOutput
    ))
    if LekhNativePreferences.proofreadAsYouTypeEnabled {
      output.append(contentsOf: proofreadCandidates(for: normalized, romanizedOutput: romanizedOutput, reverseCandidates: reverseCandidates))
    }
    let reverseBucket = reverseIndex.prefixes[Self.reverseBucketKey(normalized)] ?? []
    for unicode in reverseBucket where unicode.hasPrefix(normalized) {
      let romanizedValues = reverseCandidates[unicode] ?? []
      output.append(contentsOf: romanizedOutput ? romanizedValues : [unicode])
    }
    if romanizedOutput, let direct = reverseCandidates[normalized] {
      output.insert(contentsOf: direct, at: 0)
    }
    return Self.unique(
      output.filter {
        Self.isAllowedActiveTokenCandidate(
          input: normalized,
          candidate: $0,
          mode: romanizedOutput ? .traditionalRomanized : .traditionalTraditional
        )
      },
      limit: candidateLimit
    )
  }

  private func proofreadCandidates(
    for normalized: String,
    romanizedOutput: Bool,
    reverseCandidates: [String: [String]]
  ) -> [String] {
    // A correction is safe only when the complete error token matches. Prefix
    // proofread rows used to suggest full corrections after one or two
    // Devanagari characters, which felt like accidental phrase expansion.
    let rows = (proofreadRowsByError[normalized] ?? [])
      .sorted {
        if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
        return $0.priority < $1.priority
      }
    return Self.unique(rows.flatMap { row in
      if romanizedOutput {
        return reverseCandidates[row.correction] ?? [row.correction]
      }
      return [row.correction]
    }, limit: candidateLimit)
  }

  private func romanizedLabels(for unicodeCandidates: [String], fallback: String) -> [String] {
    let reverseCandidates = reverseCandidatesSnapshot().exact
    let labels = unicodeCandidates.flatMap { reverseCandidates[$0] ?? [] }
    return labels.isEmpty ? [fallback] : labels
  }

  private func smartPunctuation(for key: String, mode: LekhNativeTypingMode) -> String {
    if key == "\n" || key == "\r" || key == "\t" {
      return ""
    }
    guard LekhNativePreferences.smartPunctuationEnabled else {
      return key
    }
    guard mode == .romanizedTraditional || mode == .traditionalTraditional else {
      return key
    }
    if key == "." || key == "|" {
      return "।"
    }
    if key == "?" {
      return "?"
    }
    return key
  }

  public func resetSession(_ sessionId: String) {
    buffers[sessionId] = ""
  }

  public func endSession(_ sessionId: String) {
    buffers[sessionId] = nil
    lastCommittedWordsBySession[sessionId] = nil
    lastCommittedInputsBySession[sessionId] = nil
  }

  public func diagnosticsSummary() -> String {
    let packSource = currentBinaryLexicon() == nil ? "json-fallback" : "mmap-binary"
    let fallbackCount = fallbackRows.count
    let warnings = [
      securityWarning() == nil ? nil : "dictionary-update-rejected",
      contractWarning
    ].compactMap { $0 }
    return "engine=local contract=v1 pack=\(packSource) completion=\(tokenCompletionIndex.status) neural=\(LekhNeuralCandidateService.shared.status) fallbackRows=\(fallbackCount) userLexicon=sqlite warning=\(warnings.isEmpty ? "none" : warnings.joined(separator: ","))"
  }

  public func securityWarning() -> String? {
    lexiconLock.lock()
    defer { lexiconLock.unlock() }
    return packSecurityWarning
  }

  private func observeCommit(
    sessionId: String,
    rawBuffer: String,
    chosenOutput: String,
    allowPersonalization: Bool
  ) {
    let normalized = Self.normalize(rawBuffer)
    let committedWord = Self.lastWord(from: chosenOutput)
    if allowPersonalization,
       !normalized.isEmpty,
       normalized.count <= 64,
       !Self.containsWhitespace(normalized),
       !Self.containsWhitespace(chosenOutput),
       Self.normalize(chosenOutput) != normalized {
      userLexicon.record(normalizedInput: normalized, chosenOutput: chosenOutput)
    }
    if allowPersonalization,
       let previous = lastCommittedWordsBySession[sessionId],
       let committedWord,
       previous != committedWord {
      userLexicon.recordBigram(previousOutput: previous, currentOutput: committedWord)
    }
    if let lastInput = normalized.split(separator: " ").last {
      lastCommittedInputsBySession[sessionId] = String(lastInput)
    }
    if let committedWord {
      lastCommittedWordsBySession[sessionId] = committedWord
    }
  }

  private func commitRaw(_ text: String) -> LekhInputDecision {
    LekhInputDecision(
      handled: true,
      markedText: nil,
      committedText: text,
      candidates: [],
      shouldCancel: false,
      shouldPassThrough: false
    )
  }

  private func shouldAppendToComposition(_ key: String) -> Bool {
    LekhCompositionInputPolicy.isCompositionSafe(key)
  }

  private static func buildReverseCandidates(rows: [NativeCandidateRow]) -> [String: [String]] {
    var reverse: [String: [String]] = [:]
    for row in rows {
      reverse[row.unicode, default: []].append(row.romanized)
    }
    return reverse.mapValues { unique($0, limit: 8) }
  }

  private static func buildReversePrefixes(
    _ reverse: [String: [String]]
  ) -> [String: [String]] {
    var prefixes: [String: [String]] = [:]
    for unicode in reverse.keys.sorted() {
      let bucket = reverseBucketKey(unicode)
      prefixes[bucket, default: []].append(unicode)
    }
    return prefixes
  }

  private static func reverseBucketKey(_ value: String) -> String {
    String(value.prefix(max(1, min(2, value.count))))
  }

  private static func lastWord(from text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let separators = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
    return trimmed
      .components(separatedBy: separators)
      .last(where: { !$0.isEmpty })
  }

  private static func loadJsonRows(pack: RuntimeSuggestionPack?) -> [NativeCandidateRow] {
    guard let pack else { return [] }
    var rows: [NativeCandidateRow] = []
    rows.append(contentsOf: pack.words.enumerated().map { index, row in
      NativeCandidateRow(
        romanized: normalize(row.romanized),
        unicode: row.unicode,
        confidence: row.confidence ?? 0.70,
        priority: 10_000 + index,
        kind: .word
      )
    })
    rows.append(contentsOf: pack.names.enumerated().map { index, row in
      NativeCandidateRow(
        romanized: normalize(row.romanized),
        unicode: row.unicode,
        confidence: row.confidence ?? 0.64,
        priority: 30_000 + index,
        kind: .name
      )
    })
    // Match the compiled native lexicon contract. Multi-token synthetic names
    // cannot be entered in one IMK composition and used to consume the prefix
    // bucket before output filtering, hiding legitimate word completions.
    let tokenRows = rows.filter {
      !containsWhitespace($0.romanized) && !containsWhitespace($0.unicode)
    }
    return ranked(tokenRows, limit: tokenRows.count)
  }

  private static func loadProofreadRows(pack: RuntimeSuggestionPack?) -> [NativeProofreadRow] {
    guard let pack else { return [] }
    return (pack.proofread ?? []).enumerated().compactMap { index, row in
      let error = row.error.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
      let correction = row.correction.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
      guard !error.isEmpty, !correction.isEmpty, error != correction else { return nil }
      return NativeProofreadRow(
        error: error,
        correction: correction,
        type: row.type ?? "proofread",
        confidence: row.confidence ?? 0.64,
        priority: index
      )
    }
  }

  private static func loadRuntimePack() -> RuntimeSuggestionPack? {
    guard let url = runtimePackURL(),
          let data = try? Data(contentsOf: url) else {
      return nil
    }
    return try? JSONDecoder().decode(RuntimeSuggestionPack.self, from: data)
  }

  private static func buildNextContextIndex(
    _ rows: [RuntimeNextContextRow]
  ) -> [String: [NativeNextContextRow]] {
    let eligibleReviewTiers: Set<String> = [
      "gold",
      "native-speaker-reviewed",
      "linguist-reviewed",
      "dual-reviewed",
      "adjudicated-gold"
    ]
    var index: [String: [NativeNextContextRow]] = [:]
    for row in rows {
      let context = normalize(row.context)
      let next = normalize(row.next)
      let confidence = row.confidence ?? 0
      let quality = row.quality?.lowercased() ?? ""
      guard eligibleReviewTiers.contains(quality),
            confidence >= 0.80,
            next.range(of: #"^[a-z][a-z'-]*$"#, options: .regularExpression) != nil,
            let previous = context.split(separator: " ").last.map(String.init),
            previous.range(of: #"^[a-z][a-z'-]*$"#, options: .regularExpression) != nil else {
        continue
      }
      index[previous, default: []].append(
        NativeNextContextRow(next: next, confidence: confidence)
      )
    }
    return index.mapValues { values in
      var best: [String: NativeNextContextRow] = [:]
      for row in values where row.confidence > (best[row.next]?.confidence ?? -1) {
        best[row.next] = row
      }
      return best.values.sorted {
        if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
        return $0.next < $1.next
      }
    }
  }

  fileprivate static func normalize(_ value: String) -> String {
    value
      .precomposedStringWithCanonicalMapping
      .lowercased()
      .replacingOccurrences(of: "’", with: "'")
      .replacingOccurrences(of: "‘", with: "'")
      .replacingOccurrences(of: "ʼ", with: "'")
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
  }

  fileprivate static func containsWhitespace(_ value: String) -> Bool {
    value.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.contains($0) }
  }

  private static func runtimePackURL() -> URL? {
    if let bundled = Bundle.main.url(forResource: "runtime-suggestions", withExtension: "json") {
      return bundled
    }
    if lekhUsesNativeFixtureEnvironment(),
       let testPath = ProcessInfo.processInfo.environment["LEKH_TEST_RUNTIME_SUGGESTIONS_PATH"],
       FileManager.default.isReadableFile(atPath: testPath) {
      return URL(fileURLWithPath: testPath)
    }
    return nil
  }

  private static func loadEngineContract() -> (maximumVisible: Int, warning: String?) {
    guard let url = Bundle.main.url(forResource: "lekh-engine-contract.v1", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let maximumVisible = LekhEngineContractValidator.maximumVisibleIfValid(data: data) else {
      return (8, "engine-contract-fallback")
    }
    return (maximumVisible, nil)
  }

  private static func bucketKey(_ value: String) -> String {
    String(value.prefix(max(1, min(3, value.count))))
  }

  fileprivate static func unique(_ values: [String], limit: Int) -> [String] {
    var seen = Set<String>()
    var output: [String] = []
    for value in values {
      let normalized = value.precomposedStringWithCanonicalMapping
      if seen.contains(normalized) { continue }
      seen.insert(normalized)
      output.append(normalized)
      if output.count >= limit { break }
    }
    return output
  }

  private static func ranked(_ rows: [NativeCandidateRow], limit: Int) -> [NativeCandidateRow] {
    let sorted = rows
      .sorted {
        if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
        if $0.priority != $1.priority { return $0.priority < $1.priority }
        if $0.romanized != $1.romanized { return $0.romanized < $1.romanized }
        return $0.unicode < $1.unicode
      }
    var seen = Set<String>()
    var output: [NativeCandidateRow] = []
    output.reserveCapacity(min(limit, sorted.count))
    for row in sorted {
      let identity = "\(row.romanized)\u{0}\(row.unicode)"
      guard seen.insert(identity).inserted else { continue }
      output.append(row)
      if output.count >= limit {
        break
      }
    }
    return output
  }
}

private enum LekhDevanagariRomanizer {
  private static let consonants: [UnicodeScalar: String] = [
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "w", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h"
  ]

  private static let independentVowels: [UnicodeScalar: String] = [
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu",
    "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au"
  ]

  private static let vowelSigns: [UnicodeScalar: String] = [
    "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au"
  ]

  private static let digits: [UnicodeScalar: String] = [
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9"
  ]

  static func romanize(_ text: String) -> String {
    var output = ""
    var pendingInherentVowel = false
    for scalar in text.precomposedStringWithCanonicalMapping.unicodeScalars {
      if let consonant = consonants[scalar] {
        output.append(consonant)
        output.append("a")
        pendingInherentVowel = true
      } else if let vowel = independentVowels[scalar] {
        output.append(vowel)
        pendingInherentVowel = false
      } else if let vowelSign = vowelSigns[scalar] {
        if pendingInherentVowel, output.last == "a" {
          output.removeLast()
        }
        output.append(vowelSign)
        pendingInherentVowel = false
      } else if scalar.value == 0x094D {
        if pendingInherentVowel, output.last == "a" {
          output.removeLast()
        }
        pendingInherentVowel = false
      } else if scalar.value == 0x0902 {
        output.append("m")
        pendingInherentVowel = false
      } else if scalar.value == 0x0901 {
        output.append("n")
        pendingInherentVowel = false
      } else if scalar.value == 0x0903 {
        output.append("h")
        pendingInherentVowel = false
      } else if let digit = digits[scalar] {
        output.append(digit)
        pendingInherentVowel = false
      } else {
        output.unicodeScalars.append(scalar)
        pendingInherentVowel = false
      }
    }
    return output
  }
}

private final class LekhUserLexiconStore {
  private static let preferenceDomain = "com.lekh.inputmethod.LekhKeyboard"
  private static let preferenceChangedNotification = "com.lekh.inputmethod.preferences.changed"
  private static let resetEpochKey = "LekhPersonalizationResetEpoch"

  private struct Entry {
    let normalizedInput: String
    let chosenOutput: String
    let frequency: Int
    let lastUsed: String
  }

  private var database: OpaquePointer?
  private var entriesByInput: [String: [Entry]] = [:]
  private var bigramCounts: [String: [String: Int]] = [:]
  private let databasePath: String
  private let stateLock = NSLock()
  private let preferenceDefaults = UserDefaults(suiteName: preferenceDomain) ?? .standard
  private var observedResetEpoch: Double = 0
  private let writeQueue = DispatchQueue(
    label: "com.lekh.inputmethod.personalization-writer",
    qos: .utility
  )

  init(fileManager: FileManager = .default) {
    if lekhUsesNativeFixtureEnvironment(),
       let testPath = ProcessInfo.processInfo.environment["LEKH_TEST_PERSONALIZATION_DB_PATH"],
       !testPath.isEmpty {
      self.databasePath = testPath
    } else {
      let supportDirectory = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent("Library", isDirectory: true)
        .appendingPathComponent("Application Support", isDirectory: true)
        .appendingPathComponent("Lekh Keyboard", isDirectory: true)
      try? fileManager.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
      self.databasePath = supportDirectory.appendingPathComponent("lekh-keyboard.sqlite3").path
    }
    self.observedResetEpoch = currentResetEpoch()
    open()
    migrate()
    load()
    loadBigrams()
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      Self.preferenceChangeCallback,
      Self.preferenceChangedNotification as CFString,
      nil,
      .deliverImmediately
    )
  }

  deinit {
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      Unmanaged.passUnretained(self).toOpaque(),
      CFNotificationName(Self.preferenceChangedNotification as CFString),
      nil
    )
    checkpointWal(passive: true)
    sqlite3_close(database)
  }

  func candidates(for normalizedInput: String, romanizedOutput: Bool) -> [String] {
    let normalized = Self.normalize(normalizedInput)
    guard !normalized.isEmpty else { return [] }
    stateLock.lock()
    let entries = entriesByInput[normalized] ?? []
    stateLock.unlock()
    return entries
      .filter { $0.frequency >= 2 }
      .sorted {
        if $0.frequency != $1.frequency { return $0.frequency > $1.frequency }
        return $0.lastUsed > $1.lastUsed
      }
      .prefix(4)
      .map { entry in
        if romanizedOutput, entry.chosenOutput.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil {
          return entry.normalizedInput
        }
        return entry.chosenOutput
      }
  }

  func record(normalizedInput: String, chosenOutput: String) {
    let input = Self.normalize(normalizedInput)
    let output = chosenOutput.trimmingCharacters(in: .whitespacesAndNewlines)
      .precomposedStringWithCanonicalMapping
    guard !input.isEmpty,
          !output.isEmpty,
          input.count <= 64,
          output.count <= 64,
          !LekhNativeEngineClient.containsWhitespace(input),
          !LekhNativeEngineClient.containsWhitespace(output),
          output.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
      return
    }
    guard database != nil else { return }
    let now = ISO8601DateFormatter().string(from: Date())
    stateLock.lock()
    var rows = entriesByInput[input] ?? []
    let previousFrequency = rows.first(where: { $0.chosenOutput == output })?.frequency ?? 0
    rows.removeAll { $0.chosenOutput == output }
    rows.append(Entry(
      normalizedInput: input,
      chosenOutput: output,
      frequency: previousFrequency + 1,
      lastUsed: now
    ))
    entriesByInput[input] = rows
    stateLock.unlock()
    writeQueue.async { [self] in
      execute(
        """
        INSERT INTO user_lexicon (normalized_input, chosen_output, frequency, last_used, blocked)
        VALUES (?, ?, 1, ?, 0)
        ON CONFLICT(normalized_input, chosen_output) DO UPDATE SET
          frequency = frequency + 1,
          last_used = excluded.last_used,
          blocked = 0
        """,
        [input, output, now]
      )
    }
  }

  func recordBigram(previousOutput: String, currentOutput: String) {
    let previous = Self.normalizeOutput(previousOutput)
    let current = Self.normalizeOutput(currentOutput)
    guard !previous.isEmpty, !current.isEmpty else { return }
    guard database != nil else { return }
    let now = ISO8601DateFormatter().string(from: Date())
    stateLock.lock()
    bigramCounts[previous, default: [:]][current, default: 0] += 1
    stateLock.unlock()
    writeQueue.async { [self] in
      execute(
        """
        INSERT INTO user_bigrams (previous_output, current_output, frequency, last_used)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(previous_output, current_output) DO UPDATE SET
          frequency = frequency + 1,
          last_used = excluded.last_used
        """,
        [previous, current, now]
      )
    }
  }

  func rankCandidates(_ candidates: [String], previousOutput: String?, limit: Int) -> [String] {
    guard !candidates.isEmpty else { return [] }
    guard let previous = previousOutput.map(Self.normalizeOutput), !previous.isEmpty else {
      return Array(candidates.prefix(limit))
    }
    stateLock.lock()
    let boosts = bigramCounts[previous] ?? [:]
    stateLock.unlock()
    return candidates.enumerated()
      .sorted { left, right in
        let leftCount = boosts[Self.normalizeOutput(left.element)] ?? 0
        let rightCount = boosts[Self.normalizeOutput(right.element)] ?? 0
        let leftBoost = leftCount >= 2 ? min(leftCount, 8) : 0
        let rightBoost = rightCount >= 2 ? min(rightCount, 8) : 0
        if leftBoost != rightBoost { return leftBoost > rightBoost }
        return left.offset < right.offset
      }
      .prefix(limit)
      .map(\.element)
  }

  func forget(normalizedInput: String, chosenOutput: String) {
    let input = Self.normalize(normalizedInput)
    let output = chosenOutput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !input.isEmpty, !output.isEmpty else { return }
    stateLock.lock()
    entriesByInput[input]?.removeAll { $0.chosenOutput == output }
    stateLock.unlock()
    let now = ISO8601DateFormatter().string(from: Date())
    writeQueue.async { [self] in
      execute(
        """
        UPDATE user_lexicon
        SET blocked = 1, last_used = ?
        WHERE normalized_input = ? AND chosen_output = ?
        """,
        [now, input, output]
      )
    }
  }

  private func open() {
    let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(databasePath, &database, flags, nil) == SQLITE_OK else {
      sqlite3_close(database)
      database = nil
      return
    }
    execute("PRAGMA journal_mode = WAL", [])
    execute("PRAGMA synchronous = NORMAL", [])
    execute("PRAGMA wal_autocheckpoint = 100", [])
  }

  private func migrate() {
    execute(
      """
      CREATE TABLE IF NOT EXISTS user_lexicon (
        id INTEGER PRIMARY KEY,
        normalized_input TEXT NOT NULL,
        chosen_output TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        last_used TEXT NOT NULL,
        blocked INTEGER NOT NULL DEFAULT 0,
        UNIQUE(normalized_input, chosen_output)
      )
      """,
      []
    )
    execute("CREATE INDEX IF NOT EXISTS user_lexicon_input_idx ON user_lexicon(normalized_input)", [])
    execute(
      """
      CREATE TABLE IF NOT EXISTS user_bigrams (
        id INTEGER PRIMARY KEY,
        previous_output TEXT NOT NULL,
        current_output TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        last_used TEXT NOT NULL,
        UNIQUE(previous_output, current_output)
      )
      """,
      []
    )
    execute("CREATE INDEX IF NOT EXISTS user_bigrams_previous_idx ON user_bigrams(previous_output)", [])
  }

  private func load() {
    entriesByInput = [:]
    guard let statement = prepare(
      """
      SELECT normalized_input, chosen_output, frequency, last_used
      FROM user_lexicon
      WHERE blocked = 0
      ORDER BY frequency DESC, last_used DESC
      LIMIT 1000
      """,
      []
    ) else { return }
    defer { sqlite3_finalize(statement) }
    while sqlite3_step(statement) == SQLITE_ROW {
      if let entry = entry(from: statement) {
        entriesByInput[entry.normalizedInput, default: []].append(entry)
      }
    }
  }

  private func loadBigrams() {
    bigramCounts = [:]
    guard let statement = prepare(
      """
      SELECT previous_output, current_output, frequency
      FROM user_bigrams
      ORDER BY frequency DESC, last_used DESC
      LIMIT 5000
      """,
      []
    ) else { return }
    defer { sqlite3_finalize(statement) }
    while sqlite3_step(statement) == SQLITE_ROW {
      guard let previousPointer = sqlite3_column_text(statement, 0),
            let currentPointer = sqlite3_column_text(statement, 1) else { continue }
      let previous = String(cString: previousPointer)
      let current = String(cString: currentPointer)
      bigramCounts[previous, default: [:]][current] = Int(sqlite3_column_int(statement, 2))
    }
  }

  private static let preferenceChangeCallback: CFNotificationCallback = {
    _, observer, _, _, _ in
    guard let observer else { return }
    let store = Unmanaged<LekhUserLexiconStore>.fromOpaque(observer).takeUnretainedValue()
    store.handlePreferenceChange()
  }

  private func handlePreferenceChange() {
    preferenceDefaults.synchronize()
    let resetEpoch = currentResetEpoch()
    stateLock.lock()
    guard resetEpoch > observedResetEpoch else {
      stateLock.unlock()
      return
    }
    observedResetEpoch = resetEpoch
    entriesByInput.removeAll(keepingCapacity: true)
    bigramCounts.removeAll(keepingCapacity: true)
    stateLock.unlock()

    // This clear is intentionally ordered on the same serial queue as all
    // inserts. Writes accepted before the reset run first and are then erased;
    // learning explicitly accepted after the reset may start fresh afterward.
    writeQueue.async { [self] in
      execute("BEGIN IMMEDIATE", [])
      execute("DELETE FROM user_lexicon", [])
      execute("DELETE FROM user_bigrams", [])
      execute("COMMIT", [])
      checkpointWal(passive: false)
    }
  }

  private func currentResetEpoch() -> Double {
    if lekhUsesNativeFixtureEnvironment(),
       let value = ProcessInfo.processInfo.environment["LEKH_TEST_PERSONALIZATION_RESET_EPOCH"],
       let epoch = Double(value) {
      return epoch
    }
    return preferenceDefaults.double(forKey: Self.resetEpochKey)
  }

  private func entry(from statement: OpaquePointer?) -> Entry? {
    guard let inputPointer = sqlite3_column_text(statement, 0),
          let outputPointer = sqlite3_column_text(statement, 1),
          let lastUsedPointer = sqlite3_column_text(statement, 3) else {
      return nil
    }
    return Entry(
      normalizedInput: String(cString: inputPointer),
      chosenOutput: String(cString: outputPointer),
      frequency: Int(sqlite3_column_int(statement, 2)),
      lastUsed: String(cString: lastUsedPointer)
    )
  }

  private func execute(_ sql: String, _ values: [String]) {
    guard let statement = prepare(sql, values) else { return }
    defer { sqlite3_finalize(statement) }
    _ = sqlite3_step(statement)
  }

  private func checkpointWal(passive: Bool) {
    guard let database else { return }
    let mode = passive ? SQLITE_CHECKPOINT_PASSIVE : SQLITE_CHECKPOINT_TRUNCATE
    sqlite3_wal_checkpoint_v2(database, nil, mode, nil, nil)
  }

  private func prepare(_ sql: String, _ values: [String]) -> OpaquePointer? {
    guard let database else { return nil }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
      sqlite3_finalize(statement)
      return nil
    }
    for (index, value) in values.enumerated() {
      sqlite3_bind_text(statement, Int32(index + 1), value, -1, Self.sqliteTransient)
    }
    return statement
  }

  private static let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  private static func normalize(_ value: String) -> String {
    value.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
  }

  private static func normalizeOutput(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .precomposedStringWithCanonicalMapping
  }
}

private enum LekhRomanizedComposer {
  private struct CanonicalTokenPack: Decodable {
    struct Row: Decodable {
      struct Output: Decodable {
        let text: String
        let confidence: Double
      }

      let input: String
      let outputs: [Output]
    }

    let schemaVersion: Int
    let scope: String
    let rows: [Row]
  }

  private static let virama = "\u{094D}"
  private static let canonicalTokenOverrides = loadCanonicalTokenOverrides()

  static func canonicalCandidates(for token: String) -> [String] {
    canonicalTokenOverrides[token.lowercased()] ?? []
  }

  static func canonicalTraditionalCandidates(
    for unicodePrefix: String,
    romanizedOutput: Bool
  ) -> [String] {
    var candidates: [String] = []
    for input in canonicalTokenOverrides.keys.sorted() {
      for output in canonicalTokenOverrides[input] ?? [] where output.hasPrefix(unicodePrefix) {
        candidates.append(romanizedOutput ? input : output)
      }
    }
    return LekhNativeEngineClient.unique(candidates, limit: 8)
  }

  private static func loadCanonicalTokenOverrides() -> [String: [String]] {
    let url: URL?
    if let bundled = Bundle.main.url(forResource: "lekh-token-candidates.v1", withExtension: "json") {
      url = bundled
    } else if lekhUsesNativeFixtureEnvironment(),
              let testPath = ProcessInfo.processInfo.environment["LEKH_TEST_CANONICAL_TOKEN_PACK_PATH"],
              FileManager.default.isReadableFile(atPath: testPath) {
      url = URL(fileURLWithPath: testPath)
    } else {
      url = nil
    }
    guard let url,
          let data = try? Data(contentsOf: url),
          let pack = try? JSONDecoder().decode(CanonicalTokenPack.self, from: data),
          pack.schemaVersion == 1,
          pack.scope == "single-active-token" else {
      return [:]
    }

    var result: [String: [String]] = [:]
    for row in pack.rows {
      let input = LekhNativeEngineClient.normalize(row.input)
      guard input.range(of: #"^[a-z][a-z'-]*$"#, options: .regularExpression) != nil,
            result[input] == nil else { continue }
      let outputs = row.outputs
        .filter { (0...1).contains($0.confidence) }
        .sorted { $0.confidence > $1.confidence }
        .map { $0.text.precomposedStringWithCanonicalMapping }
        .filter {
          !LekhNativeEngineClient.containsWhitespace($0) &&
            $0.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil &&
            $0.range(of: #"[A-Za-z]"#, options: .regularExpression) == nil
        }
      let uniqueOutputs = LekhNativeEngineClient.unique(outputs, limit: 8)
      if !uniqueOutputs.isEmpty {
        result[input] = uniqueOutputs
      }
    }
    return result
  }
  private static let vowelRules: [(input: String, independent: String, matra: String)] = [
    ("aa", "आ", "ा"),
    ("ee", "ई", "ी"),
    ("ii", "ई", "ी"),
    ("oo", "ऊ", "ू"),
    ("uu", "ऊ", "ू"),
    ("ai", "ऐ", "ै"),
    ("au", "औ", "ौ"),
    ("a", "अ", ""),
    ("i", "इ", "ि"),
    ("u", "उ", "ु"),
    ("e", "ए", "े"),
    ("o", "ओ", "ो")
  ]
  private static let clusterRules: [(input: String, output: String)] = [
    ("ksh", "क\(virama)ष"),
    ("jny", "ज\(virama)ञ"),
    ("gy", "ज\(virama)ञ"),
    ("shr", "श\(virama)र"),
    ("str", "स\(virama)त\(virama)र"),
    ("ddh", "द\(virama)ध"),
    ("bhr", "भ\(virama)र"),
    ("pr", "प\(virama)र"),
    ("kr", "क\(virama)र"),
    ("gr", "ग\(virama)र"),
    ("tr", "त\(virama)र"),
    ("tt", "त\(virama)त"),
    ("dy", "द\(virama)य"),
    ("ty", "त\(virama)य"),
    ("ky", "क\(virama)य"),
    ("ny", "न\(virama)य")
  ]
  private static let consonantRules: [(input: String, output: String)] = [
    ("chh", "छ"),
    ("kh", "ख"),
    ("gh", "घ"),
    ("jh", "झ"),
    ("th", "थ"),
    ("dh", "ध"),
    ("ph", "फ"),
    ("bh", "भ"),
    ("sh", "श"),
    ("ng", "ङ"),
    ("ch", "च"),
    ("k", "क"),
    ("g", "ग"),
    ("c", "च"),
    ("j", "ज"),
    ("t", "त"),
    ("d", "द"),
    ("n", "न"),
    ("p", "प"),
    ("f", "फ"),
    ("b", "ब"),
    ("m", "म"),
    ("y", "य"),
    ("r", "र"),
    ("l", "ल"),
    ("w", "व"),
    ("v", "व"),
    ("s", "स"),
    ("h", "ह")
  ]
  private static let genericConjunctPairs: Set<String> = [
    "rk", "rs", "rv", "rm", "rn", "ry", "sw", "kt", "lt", "nd", "mb", "mp",
    "nm", "nt", "st", "sk", "sp", "rt", "rd", "lp"
  ]

  static func composeToken(_ token: String) -> String {
    var index = token.startIndex
    var output = ""
    let lower = token.lowercased()

    while index < lower.endIndex {
      if lower[index...].hasPrefix("||") {
        output += "।"
        index = lower.index(index, offsetBy: 2)
        continue
      }

      if let consonant = matchRule(clusterRules, in: lower, at: index) ?? matchRule(consonantRules, in: lower, at: index) {
        let afterConsonant = lower.index(index, offsetBy: consonant.input.count)
        if lower[afterConsonant...].hasPrefix("ri") {
          output += consonant.output + "\u{0943}"
          index = lower.index(afterConsonant, offsetBy: 2)
          continue
        }
        if let vowel = matchVowel(in: lower, at: afterConsonant) {
          output += consonant.output + vowel.matra
          index = lower.index(afterConsonant, offsetBy: vowel.input.count)
          continue
        }
        let smartJoin = hasConsonantOnset(in: lower, at: afterConsonant, currentInput: consonant.input)
        let behavior = LekhNativePreferences.halantaBehavior
        let shouldJoinNext = behavior == "soft" ? false : smartJoin
        let explicitFinalHalanta = behavior == "explicit" && afterConsonant == lower.endIndex
        output += consonant.output + (shouldJoinNext || explicitFinalHalanta ? virama : "")
        index = afterConsonant
        continue
      }

      if let vowel = matchVowel(in: lower, at: index) {
        output += vowel.independent
        index = lower.index(index, offsetBy: vowel.input.count)
        continue
      }

      output += String(lower[index])
      index = lower.index(after: index)
    }

    return output
  }

  static func composePhraseCandidates(_ phrase: String) -> [String] {
    let tokens = phrase.split(separator: " ").map(String.init)
    guard !tokens.isEmpty else { return [] }
    let tokenCandidates = tokens.map { composeTokenCandidates($0) }
    var beams: [([String], Int)] = [([], 0)]
    for candidates in tokenCandidates {
      var next: [([String], Int)] = []
      for beam in beams {
        for (index, candidate) in candidates.enumerated() {
          next.append((beam.0 + [candidate], beam.1 + index))
        }
      }
      beams = next
        .sorted {
          if $0.1 != $1.1 { return $0.1 < $1.1 }
          return $0.0.joined(separator: " ") < $1.0.joined(separator: " ")
        }
        .prefix(12)
        .map { $0 }
    }
    return LekhNativeEngineClient.unique(beams.map { $0.0.joined(separator: " ") }, limit: 8)
  }

  private static func composeTokenCandidates(_ token: String) -> [String] {
    let lower = token.lowercased()
    var candidates: [String] = []
    candidates.append(contentsOf: canonicalCandidates(for: lower))

    candidates.append(composeToken(lower))

    if lower.contains("x") {
      let xAsChh = lower.replacingOccurrences(of: "x", with: "chh")
      let xAsKsh = lower.replacingOccurrences(of: "x", with: "ksh")
      if prefersXAsChh(lower) {
        candidates.append(composeToken(xAsChh))
        candidates.append(composeToken(xAsKsh))
      } else {
        candidates.append(composeToken(xAsKsh))
        candidates.append(composeToken(xAsChh))
      }
    }

    if lower.range(of: #"^[bv]a[a-z]+$"#, options: .regularExpression) != nil {
      let longA = lower.replacingOccurrences(of: #"^[bv]a"#, with: "baa", options: .regularExpression)
      candidates.append(composeToken(longA))
    }

    if lower.contains("ch") && !lower.contains("chh") {
      candidates.append(composeToken(lower.replacingOccurrences(of: "ch", with: "chh")))
    }

    return LekhNativeEngineClient.unique(candidates, limit: 8)
  }

  private static func prefersXAsChh(_ token: String) -> Bool {
    token == "xa" ||
      token.hasPrefix("xai") ||
      token.hasPrefix("xau") ||
      token.hasPrefix("xan") ||
      token.hasPrefix("xu") ||
      token.hasPrefix("xas")
  }

  private static func matchRule(_ rules: [(input: String, output: String)], in token: String, at index: String.Index) -> (input: String, output: String)? {
    let suffix = token[index...]
    return rules.first { suffix.hasPrefix($0.input) }
  }

  private static func matchVowel(in token: String, at index: String.Index) -> (input: String, independent: String, matra: String)? {
    guard index < token.endIndex else { return nil }
    let suffix = token[index...]
    return vowelRules.first { suffix.hasPrefix($0.input) }
  }

  private static func hasConsonantOnset(in token: String, at index: String.Index, currentInput: String) -> Bool {
    guard index < token.endIndex else { return false }
    if matchVowel(in: token, at: index) != nil { return false }
    guard let next = matchRule(clusterRules, in: token, at: index) ?? matchRule(consonantRules, in: token, at: index) else {
      return false
    }
    if currentInput.count > 1 { return true }
    return genericConjunctPairs.contains("\(currentInput)\(next.input.prefix(1))")
  }
}
