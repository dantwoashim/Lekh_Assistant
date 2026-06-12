import Foundation

#if canImport(CoreML)
import CoreML
#endif

public struct LekhNeuralCandidate: Equatable {
  public let text: String
  public let confidence: Double
}

public final class LekhNeuralTransliterator {
  public static let modelsDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library", isDirectory: true)
    .appendingPathComponent("Application Support", isDirectory: true)
    .appendingPathComponent("Lekh Keyboard", isDirectory: true)
    .appendingPathComponent("Models", isDirectory: true)

  public static let activeModelURL = modelsDirectory.appendingPathComponent("LekhNeuralTransliterator.mlmodelc")

  #if canImport(CoreML)
  private let model: MLModel

  private init(model: MLModel) {
    self.model = model
  }

  public static func loadPreferred() -> LekhNeuralTransliterator? {
    if FileManager.default.fileExists(atPath: activeModelURL.path),
       let loaded = load(from: activeModelURL) {
      return loaded
    }
    if let bundleURL = Bundle.main.url(forResource: "LekhNeuralTransliterator", withExtension: "mlmodelc"),
       let loaded = load(from: bundleURL) {
      return loaded
    }
    return nil
  }

  private static func load(from url: URL) -> LekhNeuralTransliterator? {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all
    guard let model = try? MLModel(contentsOf: url, configuration: configuration) else {
      return nil
    }
    return LekhNeuralTransliterator(model: model)
  }

  public func candidates(for romanized: String, limit: Int = 4) -> [LekhNeuralCandidate] {
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

    guard let provider = try? MLDictionaryFeatureProvider(dictionary: [
      "romanized": MLFeatureValue(string: normalized),
      "max_candidates": MLFeatureValue(int64: Int64(limit))
    ]),
      let prediction = try? model.prediction(from: provider) else {
      return []
    }

    if let json = prediction.featureValue(for: "candidates_json")?.stringValue {
      return Self.parseCandidatesJSON(json, limit: limit)
    }
    if let candidate = prediction.featureValue(for: "candidate")?.stringValue,
       !candidate.isEmpty {
      let confidence = prediction.featureValue(for: "confidence")?.doubleValue ?? 0.55
      return [LekhNeuralCandidate(text: candidate, confidence: confidence)]
    }
    return []
  }

  private static func parseCandidatesJSON(_ json: String, limit: Int) -> [LekhNeuralCandidate] {
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
      return LekhNeuralCandidate(text: text, confidence: max(0, min(1, confidence)))
    }
    .sorted { $0.confidence > $1.confidence }
    .prefix(limit)
    .map { $0 }
  }
  #else
  public static func loadPreferred() -> LekhNeuralTransliterator? { nil }
  public func candidates(for romanized: String, limit: Int = 4) -> [LekhNeuralCandidate] { [] }
  #endif
}
