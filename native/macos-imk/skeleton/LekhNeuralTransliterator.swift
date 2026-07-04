import Foundation

#if canImport(CoreML)
import CoreML
#endif

public struct LekhCoreMLTailCandidate: Equatable {
  public let text: String
  public let confidence: Double
}

public final class LekhCoreMLTailTransliterator {
  public static let modelsDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library", isDirectory: true)
    .appendingPathComponent("Application Support", isDirectory: true)
    .appendingPathComponent("Lekh Keyboard", isDirectory: true)
    .appendingPathComponent("Models", isDirectory: true)

  public static let activeModelURL = modelsDirectory.appendingPathComponent("LekhNeuralTransliterator.mlmodelc")

  #if canImport(CoreML)
  private static let featureDimension = 384
  private let model: MLModel

  private init(model: MLModel) {
    self.model = model
  }

  public static func loadPreferred() -> LekhCoreMLTailTransliterator? {
    // User-writable model hot-swap stays disabled until model packs have a
    // signature verifier equivalent to dictionary packs.
    if let bundleURL = Bundle.main.url(forResource: "LekhNeuralTransliterator", withExtension: "mlmodelc"),
       Self.bundleManifestAllowsRuntimeTailModel(),
       let loaded = load(from: bundleURL) {
      return loaded
    }
    return nil
  }

  private static func load(from url: URL) -> LekhCoreMLTailTransliterator? {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    guard let model = try? MLModel(contentsOf: url, configuration: configuration) else {
      return nil
    }
    return LekhCoreMLTailTransliterator(model: model)
  }

  public func candidates(for romanized: String, limit: Int = 4) -> [LekhCoreMLTailCandidate] {
    let normalized = romanized
      .lowercased()
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    guard limit > 0,
          normalized.count >= 2,
          normalized.count <= 64,
          normalized.range(of: #"^[a-z0-9 .,'/-]+$"#, options: .regularExpression) != nil else {
      return []
    }

    if let provider = try? MLDictionaryFeatureProvider(dictionary: [
      "romanized": MLFeatureValue(string: normalized),
      "max_candidates": MLFeatureValue(int64: Int64(limit))
    ]),
       let prediction = try? model.prediction(from: provider) {
      let candidates = Self.parsePrediction(prediction, limit: limit)
      if !candidates.isEmpty {
        return candidates
      }
    }

    return featureVectorCandidates(for: normalized, limit: limit)
  }

  private func featureVectorCandidates(for normalized: String, limit: Int) -> [LekhCoreMLTailCandidate] {
    guard let vector = Self.featureVector(for: normalized),
          let provider = try? MLDictionaryFeatureProvider(dictionary: [
            "features": MLFeatureValue(multiArray: vector)
          ]),
          let prediction = try? model.prediction(from: provider) else {
      return []
    }
    return Self.parsePrediction(prediction, limit: limit)
  }

  private static func parsePrediction(_ prediction: MLFeatureProvider, limit: Int) -> [LekhCoreMLTailCandidate] {
    if let json = prediction.featureValue(for: "candidates_json")?.stringValue {
      return Self.parseCandidatesJSON(json, limit: limit)
    }
    if let probabilities = prediction.featureValue(for: "classProbability")?.dictionaryValue {
      var candidates: [LekhCoreMLTailCandidate] = []
      for (key, value) in probabilities {
        let text = String(describing: key)
        guard text.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil else { continue }
        let candidate = LekhCoreMLTailCandidate(text: text, confidence: max(0, min(1, value.doubleValue)))
        Self.insertTopCandidate(candidate, into: &candidates, limit: limit)
      }
      if !candidates.isEmpty {
        return candidates
      }
    }
    if let candidate = prediction.featureValue(for: "candidate")?.stringValue,
       !candidate.isEmpty {
      let confidence = prediction.featureValue(for: "confidence")?.doubleValue ?? 0.55
      return [LekhCoreMLTailCandidate(text: candidate, confidence: confidence)]
    }
    return []
  }

  private static func insertTopCandidate(
    _ candidate: LekhCoreMLTailCandidate,
    into candidates: inout [LekhCoreMLTailCandidate],
    limit: Int
  ) {
    guard limit > 0 else { return }
    if let existingIndex = candidates.firstIndex(where: { $0.text == candidate.text }) {
      if candidate.confidence > candidates[existingIndex].confidence {
        candidates[existingIndex] = candidate
      }
    } else if candidates.count < limit {
      candidates.append(candidate)
    } else if let weakest = candidates.last, candidate.confidence <= weakest.confidence {
      return
    } else {
      candidates[candidates.count - 1] = candidate
    }
    candidates.sort { $0.confidence > $1.confidence }
  }

  private static func parseCandidatesJSON(_ json: String, limit: Int) -> [LekhCoreMLTailCandidate] {
    guard let data = json.data(using: .utf8),
          let objects = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return []
    }
    return objects.compactMap { object in
      guard let text = object["text"] as? String,
            text.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil else {
        return nil
      }
      let confidence = object["confidence"] as? Double ?? 0.55
      return LekhCoreMLTailCandidate(text: text, confidence: max(0, min(1, confidence)))
    }
    .sorted { $0.confidence > $1.confidence }
    .prefix(limit)
    .map { $0 }
  }

  private static func featureVector(for romanized: String) -> MLMultiArray? {
    guard let array = try? MLMultiArray(
      shape: [NSNumber(value: Self.featureDimension)],
      dataType: .float32
    ) else {
      return nil
    }

    var values = Array(repeating: Double(0), count: Self.featureDimension)
    let text = "^\(romanized)$"
    let characters = Array(text)
    for ngramLength in 1...4 {
      guard characters.count >= ngramLength else { continue }
      let scale = 1.0 / sqrt(Double(ngramLength))
      for index in 0...(characters.count - ngramLength) {
        let gram = String(characters[index..<(index + ngramLength)])
        let hashed = Self.fnv1a32("\(ngramLength):\(gram)")
        let featureIndex = Int(hashed % UInt32(Self.featureDimension))
        let sign = (hashed & 0x80000000) == 0 ? 1.0 : -1.0
        values[featureIndex] += sign * scale
      }
    }
    if text.rangeOfCharacter(from: .decimalDigits) != nil {
      values[Self.featureDimension - 1] += 1.0
    }

    let norm = sqrt(values.reduce(0) { $0 + ($1 * $1) })
    if norm > 0 {
      for index in values.indices {
        values[index] /= norm
      }
    }
    for index in values.indices {
      array[index] = NSNumber(value: Float(values[index]))
    }
    return array
  }

  private static func fnv1a32(_ value: String) -> UInt32 {
    var hash: UInt32 = 2166136261
    for scalar in value.unicodeScalars {
      hash ^= UInt32(scalar.value)
      hash = hash &* 16777619
    }
    return hash
  }

  private static func bundleManifestAllowsRuntimeTailModel() -> Bool {
    guard let manifestURL = Bundle.main.url(forResource: "LekhNeuralTransliterator", withExtension: "manifest.json"),
          let data = try? Data(contentsOf: manifestURL),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return false
    }

    guard object["runtime"] as? String == "CoreML",
          object["localOnly"] as? Bool == true,
          object["neuralTailOnly"] as? Bool == true else {
      return false
    }

    if object["productionEligible"] as? Bool == true {
      let openVocabulary = object["openVocabulary"] as? Bool == true
      let decoder = object["decoder"] as? String
      let beamSearch = (object["beamSearch"] as? [String: Any])?["enabled"] as? Bool == true
      return openVocabulary && (decoder == "beam-search" || beamSearch)
    }

    // The current packaged artifact is a deliberately confidence-gated
    // closed-vocabulary tail model. Accept it only when the manifest says so.
    return object["productionEligible"] as? Bool == false
      && object["openVocabulary"] as? Bool == false
      && object["modelFamily"] as? String == "hashed-char-ngram-centroid-classifier"
      && object["instantFirstPaintOnly"] as? Bool == true
      && object["confidenceGatedFallback"] as? Bool == true
  }
  #else
  public static func loadPreferred() -> LekhCoreMLTailTransliterator? { nil }
  public func candidates(for romanized: String, limit: Int = 4) -> [LekhCoreMLTailCandidate] { [] }
  #endif
}
