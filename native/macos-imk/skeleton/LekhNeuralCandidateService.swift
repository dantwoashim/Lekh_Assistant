import CoreML
import Foundation

public final class LekhNeuralCandidateService {
  public static let shared = LekhNeuralCandidateService()

  private let queue = DispatchQueue(label: "com.lekh.inputmethod.neural-candidate-tail", qos: .userInitiated)
  private let model: MLModel?
  private let vocab: LekhNeuralVocabMetadata?
  private let enabled: Bool

  public var status: String {
    if enabled { return "async-coreml-tail-ready" }
    return "async-coreml-tail-gated"
  }

  public init(bundle: Bundle = .main) {
    let manifest = Self.loadManifest(bundle: bundle)
    let vocab = Self.loadVocab(bundle: bundle)
    self.vocab = vocab

    guard manifest?.productionEligible == true,
          let vocab,
          let modelURL = bundle.url(forResource: "LekhNeuralTransliterator", withExtension: "mlmodelc"),
          let model = try? MLModel(contentsOf: modelURL) else {
      self.model = nil
      self.enabled = false
      return
    }

    self.model = model
    self.enabled = vocab.nativeRuntimePolicy.asyncOnly &&
      vocab.nativeRuntimePolicy.neverInvokeInSecureFields &&
      vocab.nativeRuntimePolicy.failOpenRawTypingOnError &&
      vocab.nativeRuntimePolicy.neuralTailOnly
  }

  public func candidates(
    for rawInput: String,
    secureInputActive: Bool,
    completion: @escaping ([String]) -> Void
  ) {
    // neverInvokeInSecureFields: secure fields never run model inference, log, learn, or retain typed content.
    guard !secureInputActive else {
      completion([])
      return
    }
    let normalized = Self.normalize(rawInput)
    guard enabled,
          let model,
          let vocab,
          Self.isSafeToken(normalized),
          normalized.count >= 3 else {
      completion([])
      return
    }

    queue.async { [model, vocab] in
      let result = (try? Self.predictCandidates(model: model, vocab: vocab, input: normalized)) ?? []
      DispatchQueue.main.async {
        completion(result)
      }
    }
  }

  private static func predictCandidates(model: MLModel, vocab: LekhNeuralVocabMetadata, input: String) throws -> [String] {
    let inputIds = try encodedInput(input, vocab: vocab)
    var beams: [(ids: [Int], score: Double)] = [([vocab.output.sosId], 0)]
    var completed: [(ids: [Int], score: Double)] = []
    let maxSteps = max(1, vocab.output.maxLength - 1)
    let beamWidth = max(2, min(8, vocab.decoder.beamWidth))

    for step in 0..<maxSteps {
      var next: [(ids: [Int], score: Double)] = []
      for beam in beams {
        if beam.ids.last == vocab.output.eosId {
          completed.append(beam)
          continue
        }
        let decoderIds = try encodedDecoder(beam.ids, vocab: vocab)
        let provider = try MLDictionaryFeatureProvider(dictionary: [
          "inputIds": MLFeatureValue(multiArray: inputIds),
          "decoderInputIds": MLFeatureValue(multiArray: decoderIds)
        ])
        let prediction = try model.prediction(from: provider)
        guard let logits = prediction.featureValue(for: "logits")?.multiArrayValue else { continue }
        let topIds = topTokenIds(logits: logits, step: step, vocabSize: vocab.output.tokensById.count, limit: beamWidth)
        for tokenId in topIds where tokenId != vocab.output.padId && tokenId != vocab.output.unkId && tokenId != vocab.output.sosId {
          let score = beam.score + logitValue(logits: logits, step: step, vocabSize: vocab.output.tokensById.count, tokenId: tokenId)
          next.append((beam.ids + [tokenId], score))
        }
      }
      if next.isEmpty { break }
      beams = next.sorted { normalizedScore($0) > normalizedScore($1) }.prefix(beamWidth).map { $0 }
    }

    completed.append(contentsOf: beams)
    var output: [String] = []
    for beam in completed.sorted(by: { normalizedScore($0) > normalizedScore($1) }) {
      let candidate = decode(ids: beam.ids, vocab: vocab)
      guard isSafeCandidate(candidate),
            !output.contains(candidate) else { continue }
      output.append(candidate)
      if output.count >= 3 { break }
    }
    return output
  }

  private static func encodedInput(_ input: String, vocab: LekhNeuralVocabMetadata) throws -> MLMultiArray {
    let array = try MLMultiArray(shape: [1, NSNumber(value: vocab.input.maxLength)], dataType: .int32)
    let chars = Array(input).map(String.init)
    for index in 0..<vocab.input.maxLength {
      let value: Int
      if index < chars.count {
        value = vocab.input.idsByToken[chars[index]] ?? vocab.input.unkId
      } else if index == chars.count {
        value = vocab.input.eosId
      } else {
        value = vocab.input.padId
      }
      array[index] = NSNumber(value: value)
    }
    return array
  }

  private static func encodedDecoder(_ ids: [Int], vocab: LekhNeuralVocabMetadata) throws -> MLMultiArray {
    let decoderLength = max(1, vocab.output.maxLength - 1)
    let array = try MLMultiArray(shape: [1, NSNumber(value: decoderLength)], dataType: .int32)
    for index in 0..<decoderLength {
      array[index] = NSNumber(value: index < ids.count ? ids[index] : vocab.output.padId)
    }
    return array
  }

  private static func topTokenIds(logits: MLMultiArray, step: Int, vocabSize: Int, limit: Int) -> [Int] {
    guard vocabSize > 0 else { return [] }
    return (0..<vocabSize)
      .map { ($0, logitValue(logits: logits, step: step, vocabSize: vocabSize, tokenId: $0)) }
      .sorted { $0.1 > $1.1 }
      .prefix(limit)
      .map(\.0)
  }

  private static func logitValue(logits: MLMultiArray, step: Int, vocabSize: Int, tokenId: Int) -> Double {
    let index = min(max(step, 0), max(0, (logits.count / max(vocabSize, 1)) - 1)) * vocabSize + tokenId
    guard index >= 0, index < logits.count else { return -.infinity }
    return logits[index].doubleValue
  }

  private static func decode(ids: [Int], vocab: LekhNeuralVocabMetadata) -> String {
    var output = ""
    for tokenId in ids {
      if tokenId == vocab.output.padId || tokenId == vocab.output.sosId || tokenId == vocab.output.unkId {
        continue
      }
      if tokenId == vocab.output.eosId { break }
      guard tokenId >= 0, tokenId < vocab.output.tokensById.count else { continue }
      output += vocab.output.tokensById[tokenId]
    }
    return output
  }

  private static func normalizedScore(_ beam: (ids: [Int], score: Double)) -> Double {
    beam.score / Double(max(beam.ids.count, 1))
  }

  private static func normalize(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
      .precomposedStringWithCanonicalMapping
  }

  private static func isSafeToken(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          value.count <= 64 else { return false }
    return value.range(of: #"^[a-z0-9.'/-]+$"#, options: .regularExpression) != nil &&
      value.range(of: #"[a-z]"#, options: .regularExpression) != nil
  }

  private static func isSafeCandidate(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          value.range(of: #"[A-Za-z]"#, options: .regularExpression) == nil else { return false }
    return value.range(of: #"\p{Devanagari}"#, options: .regularExpression) != nil
  }

  private static func loadManifest(bundle: Bundle) -> LekhNeuralManifest? {
    guard let url = bundle.url(forResource: "LekhNeuralTransliterator.manifest", withExtension: "json"),
          let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(LekhNeuralManifest.self, from: data)
  }

  private static func loadVocab(bundle: Bundle) -> LekhNeuralVocabMetadata? {
    guard let url = bundle.url(forResource: "LekhNeuralTransliterator.vocab", withExtension: "json"),
          let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(LekhNeuralVocabMetadata.self, from: data)
  }
}

private struct LekhNeuralManifest: Decodable {
  let productionEligible: Bool
}

private struct LekhNeuralVocabMetadata: Decodable {
  let input: Vocabulary
  let output: Vocabulary
  let decoder: DecoderPolicy
  let nativeRuntimePolicy: NativeRuntimePolicy

  struct Vocabulary: Decodable {
    let maxLength: Int
    let tokensById: [String]
    let idsByToken: [String: Int]
    let padId: Int
    let sosId: Int
    let eosId: Int
    let unkId: Int
  }

  struct DecoderPolicy: Decodable {
    let beamWidth: Int
  }

  struct NativeRuntimePolicy: Decodable {
    let asyncOnly: Bool
    let neverInvokeInSecureFields: Bool
    let failOpenRawTypingOnError: Bool
    let neuralTailOnly: Bool
  }
}
