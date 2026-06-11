import Foundation

public let lekhXpcServiceName = "com.lekh.keyboard.EngineXPC"
public let lekhHotPathTimeoutMilliseconds = 50

public enum LekhXpcStatus: Equatable {
  case available
  case unavailable
  case timedOut
}

public struct LekhXpcRequestEnvelope: Equatable {
  public let type: String
  public let sessionId: String
  public let payload: [String: String]
  public let timeoutMilliseconds: Int
}

public enum LekhNativeTypingMode: String, CaseIterable {
  case romanizedRomanized = "romanized-romanized"
  case romanizedTraditional = "romanized-traditional"
  case traditionalTraditional = "traditional-traditional"
  case traditionalRomanized = "traditional-romanized"

  public var menuLabel: String {
    switch self {
    case .romanizedRomanized:
      return "Romanized-Romanized"
    case .romanizedTraditional:
      return "Romanized-Traditional"
    case .traditionalTraditional:
      return "Traditional-Traditional"
    case .traditionalRomanized:
      return "Traditional-Romanized"
    }
  }
}

public protocol LekhEngineClient {
  func processKey(_ key: String, sessionId: String, timeoutMilliseconds: Int, mode: LekhNativeTypingMode) -> LekhInputDecision
}

public final class LekhXpcEngineClient: LekhEngineClient {
  public init() {}

  public func processKey(_ key: String, sessionId: String, timeoutMilliseconds: Int, mode: LekhNativeTypingMode) -> LekhInputDecision {
    let _ = makeProcessKeyStrokeRequest(key: key, sessionId: sessionId, timeoutMilliseconds: timeoutMilliseconds, mode: mode)
    return safeFallback(for: key)
  }

  public func makeProcessKeyStrokeRequest(
    key: String,
    sessionId: String,
    timeoutMilliseconds: Int = lekhHotPathTimeoutMilliseconds,
    mode: LekhNativeTypingMode = .romanizedTraditional
  ) -> LekhXpcRequestEnvelope {
    LekhXpcRequestEnvelope(
      type: "session.processKeyStroke",
      sessionId: sessionId,
      payload: ["key": key, "mode": mode.rawValue],
      timeoutMilliseconds: timeoutMilliseconds
    )
  }

  private func safeFallback(for key: String) -> LekhInputDecision {
    if key.count == 1, let scalar = key.unicodeScalars.first,
       CharacterSet.alphanumerics.contains(scalar) || CharacterSet.whitespacesAndNewlines.contains(scalar) {
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: key,
        candidates: [],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }
    return LekhInputDecision.passThrough
  }
}

public final class LekhStaticProofEngineClient: LekhEngineClient {
  private struct RuntimeSuggestionPack: Decodable {
    let words: [RuntimeSuggestionRow]
    let phrases: [RuntimeSuggestionRow]
    let names: [RuntimeSuggestionRow]
  }

  private struct RuntimeSuggestionRow: Decodable {
    let romanized: String
    let unicode: String
    let confidence: Double?
    let quality: String?
  }

  private struct NativeCandidateRow {
    let romanized: String
    let unicode: String
    let priority: Int
  }

  private var buffers: [String: String] = [:]
  private let exactCandidates: [String: [String]]
  private let prefixBuckets: [String: [NativeCandidateRow]]
  private let reverseCandidates: [String: [String]]

  public init() {
    let rows = Self.loadNativeRows()
    var exact: [String: [String]] = [:]
    var buckets: [String: [NativeCandidateRow]] = [:]
    var reverse: [String: [String]] = [
      "स्वा": ["स्वास्थ्य", "स्वागत", "स्वाद"],
      "स्वास्थ्य": ["swasthya"],
      "कार्या": ["कार्यालय", "कार्यक्रम"],
      "कार्यालय": ["karyalaya"],
      "जिल्ला प्रशा": ["जिल्ला प्रशासन", "जिल्ला प्रशासन कार्यालय"],
      "जिल्ला प्रशासन": ["jilla prashasan"],
      "प्रशासन": ["prashasan"],
      "प्रमाणपत्र": ["pramanpatra"],
      "सवस्थ्य": ["स्वास्थ्य"],
      "प्रनलि": ["प्रणाली"],
      "राजनितिज्ञ": ["राजनीतिज्ञ"],
      "विद्यालय को": ["विद्यालयको"],
      "मन्त्रालय ले": ["मन्त्रालयले"]
    ]

    for row in rows {
      exact[row.romanized, default: []].append(row.unicode)
      let key = Self.bucketKey(row.romanized)
      buckets[key, default: []].append(row)
      reverse[row.unicode, default: []].append(row.romanized)
    }

    self.exactCandidates = exact.mapValues { Self.unique($0, limit: 8) }
    self.prefixBuckets = buckets
    self.reverseCandidates = reverse.mapValues { Self.unique($0, limit: 8) }
  }

  public func processKey(_ key: String, sessionId: String, timeoutMilliseconds: Int, mode: LekhNativeTypingMode) -> LekhInputDecision {
    if key == "\r" || key == "\n" || key == "\t" || key == " " {
      let committed = bestCandidate(for: buffers[sessionId] ?? "", mode: mode)
      buffers[sessionId] = ""
      guard let committed else {
        if key == " " {
          return commitRaw(key)
        }
        return .passThrough
      }
      let suffix = key == " " ? " " : ""
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: "\(committed)\(suffix)",
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
      return decision(for: buffers[sessionId] ?? "", mode: mode)
    }

    if key.count == 1, shouldAppendToComposition(key) {
      buffers[sessionId, default: ""].append(key.lowercased())
      return decision(for: buffers[sessionId] ?? "", mode: mode)
    }

    if key.count == 1, let scalar = key.unicodeScalars.first, CharacterSet.punctuationCharacters.contains(scalar) {
      let committed = bestCandidate(for: buffers[sessionId] ?? "", mode: mode) ?? buffers[sessionId] ?? ""
      buffers[sessionId] = ""
      return LekhInputDecision(
        handled: true,
        markedText: nil,
        committedText: "\(committed)\(key)",
        candidates: [],
        shouldCancel: false,
        shouldPassThrough: false
      )
    }

    return .passThrough
  }

  private func decision(for rawBuffer: String, mode: LekhNativeTypingMode) -> LekhInputDecision {
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
    let candidates = candidatesFor(buffer, mode: mode)
    let markedText = candidates.first ?? rawBuffer
    return LekhInputDecision(
      handled: true,
      markedText: markedText,
      committedText: nil,
      candidates: candidates,
      shouldCancel: false,
      shouldPassThrough: false
    )
  }

  private func bestCandidate(for rawBuffer: String, mode: LekhNativeTypingMode) -> String? {
    let trimmed = rawBuffer.trimmingCharacters(in: .whitespacesAndNewlines)
    return candidatesFor(trimmed, mode: mode).first ?? (trimmed.isEmpty ? nil : rawBuffer)
  }

  private func candidatesFor(_ buffer: String, mode: LekhNativeTypingMode) -> [String] {
    let normalized = buffer.lowercased().replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    if mode == .traditionalTraditional {
      return traditionalCandidates(for: buffer, romanizedOutput: false)
    }
    if mode == .traditionalRomanized {
      return traditionalCandidates(for: buffer, romanizedOutput: true)
    }

    var output: [String] = []
    let rows: [(input: String, candidates: [String])] = [
      ("swas", ["स्वास्थ्य", "स्वस्थ", "स्वास"]),
      ("swasthya", ["स्वास्थ्य"]),
      ("swasthya karyalaya", ["स्वास्थ्य कार्यालय"]),
      ("jilla pra", ["जिल्ला प्रशासन", "जिल्ला प्रशासन कार्यालय"]),
      ("jilla prashasan karyalaya", ["जिल्ला प्रशासन कार्यालय"]),
      ("nagarikta pr", ["नागरिकता प्रमाणपत्र", "नागरिकता प्रमाण पत्र"]),
      ("ramro x", ["राम्रो छ"]),
      ("ramro xa", ["राम्रो छ"]),
      ("mero", ["मेरो"]),
      ("mero swas", ["मेरो स्वास्थ्य"]),
      ("mero swasthya", ["मेरो स्वास्थ्य"]),
      ("mero swasthya ramro x", ["मेरो स्वास्थ्य राम्रो छ"]),
      ("mero swasthya ramro xa", ["मेरो स्वास्थ्य राम्रो छ"])
    ]

    if let exact = rows.first(where: { $0.input == normalized }) {
      output.append(contentsOf: mode == .romanizedRomanized ? romanizedLabels(for: exact.candidates, fallback: exact.input) : exact.candidates)
    }

    if let prefix = rows.first(where: { $0.input.hasPrefix(normalized) }) {
      output.append(contentsOf: mode == .romanizedRomanized ? romanizedLabels(for: prefix.candidates, fallback: prefix.input) : prefix.candidates)
    }

    if let exactRuntime = exactCandidates[normalized] {
      output.append(contentsOf: mode == .romanizedRomanized ? romanizedLabels(for: exactRuntime, fallback: normalized) : exactRuntime)
    }

    if normalized.count >= 2 {
      let bucketRows = prefixBuckets[Self.bucketKey(normalized)] ?? []
      let matches = bucketRows
        .filter { $0.romanized.hasPrefix(normalized) }
        .prefix(10)
      output.append(contentsOf: matches.map { mode == .romanizedRomanized ? $0.romanized : $0.unicode })
    }

    return Self.unique(output, limit: 8)
  }

  private func traditionalCandidates(for buffer: String, romanizedOutput: Bool) -> [String] {
    let normalized = buffer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return [] }
    var output: [String] = []
    for (unicode, romanizedValues) in reverseCandidates {
      let unicodeMatches = unicode == normalized || unicode.hasPrefix(normalized)
      let typoMatches = reverseCandidates[normalized] != nil
      if unicodeMatches || typoMatches {
        output.append(contentsOf: romanizedOutput ? romanizedValues : [unicode])
      }
    }
    if let direct = reverseCandidates[normalized] {
      output.insert(contentsOf: romanizedOutput ? direct : direct.compactMap { romanized in
        reverseCandidates.first(where: { $0.value.contains(romanized) })?.key
      }, at: 0)
    }
    return Self.unique(output, limit: 8)
  }

  private func romanizedLabels(for unicodeCandidates: [String], fallback: String) -> [String] {
    let labels = unicodeCandidates.flatMap { reverseCandidates[$0] ?? [] }
    return labels.isEmpty ? [fallback] : labels
  }

  public func resetSession(_ sessionId: String) {
    buffers[sessionId] = ""
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
    guard key.count == 1, let scalar = key.unicodeScalars.first else { return false }
    if CharacterSet.alphanumerics.contains(scalar) { return true }
    if scalar.value >= 0x0900 && scalar.value <= 0x097F { return true }
    return false
  }

  private static func loadNativeRows() -> [NativeCandidateRow] {
    guard let url = Bundle.main.url(forResource: "runtime-suggestions", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let pack = try? JSONDecoder().decode(RuntimeSuggestionPack.self, from: data) else {
      return []
    }

    var rows: [NativeCandidateRow] = []
    rows.append(contentsOf: pack.phrases.enumerated().map { index, row in
      NativeCandidateRow(romanized: normalize(row.romanized), unicode: row.unicode, priority: index)
    })
    rows.append(contentsOf: pack.words.enumerated().map { index, row in
      NativeCandidateRow(romanized: normalize(row.romanized), unicode: row.unicode, priority: 10_000 + index)
    })
    rows.append(contentsOf: pack.names.enumerated().map { index, row in
      NativeCandidateRow(romanized: normalize(row.romanized), unicode: row.unicode, priority: 30_000 + index)
    })
    return rows.sorted { lhs, rhs in lhs.priority < rhs.priority }
  }

  private static func normalize(_ value: String) -> String {
    value.lowercased().replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
  }

  private static func bucketKey(_ value: String) -> String {
    String(value.prefix(max(1, min(3, value.count))))
  }

  private static func unique(_ values: [String], limit: Int) -> [String] {
    var seen = Set<String>()
    var output: [String] = []
    for value in values {
      if seen.contains(value) { continue }
      seen.insert(value)
      output.append(value)
      if output.count >= limit { break }
    }
    return output
  }
}
